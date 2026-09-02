import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { getItem } from '../data/equipment.js';
import { clamp, clamp01, lerp, damp, smoothstep, rrange } from '../util/math.js';

/**
 * Viewmodel space is camera-local. Items are authored around the origin, then
 * the whole rig is lifted so the hands sit just inside the bottom of the frame
 * (at z=-0.3 with a ~61 deg FOV the visible half-height is only ~0.18).
 */
const VM_OFFSET = new THREE.Vector3(0, 0.125, 0);

/**
 * Viewmodel depth scale.
 *
 * Everything is authored close to the camera because that's easy to reason
 * about, then the whole rig is pushed away by POS_K while each mesh is
 * counter-scaled by 1/POS_K. Positions scale, sizes don't — so the on-screen
 * composition is unchanged but the apparent size drops by 1/POS_K. Raising
 * this is the single knob for "the gun/arms are too big".
 */
const POS_K = 1.18;
/** Seconds for the bucket stow animation, start to finish. */
const STOW_TIME = 1.05;
/** Seconds for the reach-down-and-rip when a fish is grabbed, and for the throw. */
const REACH_TIME = 0.9;
const THROW_TIME = 0.5;
const PLACE_TIME = 1.0;
const CHOP_TIME = 0.72;
const _chopDelta = new THREE.Vector3();
const _chopTo = new THREE.Vector3();
const _gripTmp = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _bloodTint = new THREE.Color(0x5a0c0f);
/** Left-hand positions: holding a fish, reaching out for one, lowering one into the bucket. */
const _holdL = new THREE.Vector3(-0.22, -0.30, -0.44);
const _reachL = new THREE.Vector3(-0.10, -0.40, -0.82);
const _placeL = new THREE.Vector3(-0.06, -0.44, -0.84);
const _lpos = new THREE.Vector3();
const INV_K = 1 / POS_K;
const _restR = new THREE.Vector3(0.30, -0.30, -0.32);
const _restL = new THREE.Vector3(-0.30, -0.30, -0.32);
const SKIN = 0xd9a273;
const SLEEVE = 0x3f5a6b;

/**
 * First-person hands + the currently-held item, rendered on a separate
 * near-plane camera layer so it never clips into geometry.
 */
export class HeldItems {
  constructor(game) {
    this.game = game;
    this.name = 'held';
    this.order = 60;
    this.current = null;
    this.currentId = null;
    this.sway = new THREE.Vector2();
    this.bobOffset = new THREE.Vector3();
    this.swapT = 1;
    this.recoilT = 0;
    this.castAnim = 0;
    this.visible = true;
  }

  async init(game) {
    // Dedicated overlay scene so the viewmodel is never clipped by the world.
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 12);
    this.root = new THREE.Group();
    this.vmScene.add(this.root);
    // Everything visible lives under `rig`; see POS_K.
    this.rig = new THREE.Group();
    this.rig.scale.setScalar(POS_K);
    this.root.add(this.rig);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(0.6, 1.2, 0.9);
    this.vmScene.add(key);
    const fill = new THREE.HemisphereLight(0xbfe2f2, 0x53483c, 1.0);
    this.vmScene.add(fill);
    this.vmKey = key; this.vmFill = fill;

    this.hands = buildHands();
    this.rig.add(this.hands);

    // Bucket viewmodel, built once and hidden until a catch is stowed.
    this.bucketRig = new THREE.Group();
    const pail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.115, 0.088, 0.165, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }),
    );
    const base = new THREE.Mesh(
      new THREE.CircleGeometry(0.088, 14).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x767f87, roughness: 0.7, metalness: 0.3 }),
    );
    base.position.y = -0.0825;
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(0.115, 0.008, 6, 18).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xb6c0c8, roughness: 0.4, metalness: 0.5 }),
    );
    rim.position.y = 0.0825;
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(0.112, 0.006, 5, 16, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x8d949a, roughness: 0.45, metalness: 0.5 }),
    );
    handle.position.y = 0.085;
    this.bucketRig.add(pail, base, rim, handle);
    // Stand-in for the catch going in: a small fish-shaped blob is all that
    // reads at this size and for this long.
    this.stowFish = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x6fa8d6, roughness: 0.45 }),
    );
    this.stowFish.scale.set(1.5, 0.72, 0.6);
    this.stowFish.visible = false;
    this.bucketRig.add(this.stowFish);
    this.bucketRig.visible = false;
    this.rig.add(this.bucketRig);

    this.stowT = 0;
    this.reachT = 0;
    this.throwT = 0;
    // The in-hand stow plays only when the bucket is actually in hand. With
    // it set down, the fish was thrown -- the throw gesture already played.
    bus.on('bucket:stowed', () => { if (!game.get('bucket')?.placed) this.stowT = 1; });
    bus.on('held:grab', ({ pf }) => { this.reachT = 1; this._attachFish(pf); });
    bus.on('held:throw', () => { this.throwT = 1; });
    bus.on('held:place', () => { this.placeT = 1; });
    bus.on('held:chop', () => { this.chopT = 1; });
    bus.on('held:bloody', () => this._bloodyFish());
    bus.on('held:release', () => this._detachFish());
    this.placeT = 0; this.chopT = 0;
    /** A copy of the carried fish, living in the hand. See _attachFish. */
    this.fishVm = null;
    this._fishPf = null;
    /** Where the left hand is in the world, for effects that happen at it. */
    this.leftHandWorld = new THREE.Vector3();

    // The modelled bucket in place of the procedural pail, sized to what the
    // pail was so the stow animation's framing still holds. Same asset as
    // the one on the ground, so it is recognisably the same object.
    const bm = await game.assets.model('assets/models/bucket.glb');
    if (bm?.scene) {
      for (const part of [pail, base, rim, handle]) this.bucketRig.remove(part);
      const m = bm.scene.clone(true);
      // Smaller than the pail it replaces: the model is wider, and at the
      // stow distance the pail already filled a third of the view.
      m.scale.setScalar(0.36);
      m.position.y = -0.0825;                    // GLB origin is its base
      m.traverse((o) => { if (o.isMesh && o.material) { o.material = o.material.clone(); o.material.metalness = 0.4; o.material.roughness = 0.55; } });
      this.bucketRig.add(m);
    }

    bus.on('resize', () => {
      this.vmCamera.aspect = window.innerWidth / window.innerHeight;
      this.vmCamera.updateProjectionMatrix();
    });
    bus.on('hotbar:changed', () => { this.swapT = 0; });
    bus.on('equipment:changed', () => { this.swapT = 0; this.currentId = null; });
    bus.on('weapon:recoil', (a) => { this.recoilT = Math.max(this.recoilT, a ?? 1); });
    bus.on('hud:visible', (v) => { this.visible = v; });
    return this;
  }

  setItem(id) {
    if (this.currentId === id) return;
    this.currentId = id;
    if (this.current) { this.rig.remove(this.current); disposeDeep(this.current); }
    this.current = null;
    if (!id) return;
    const item = getItem(id);
    const builder = BUILDERS[id] || BUILDERS[item?.slot] || null;
    this.current = builder ? builder(item) : buildGenericTool(item);
    if (this.current) {
      // Counter-scale so POS_K only affects distance, not apparent size.
      this.current.scale.multiplyScalar(INV_K);
      this.current.userData.baseScale = this.current.scale.x;
      // Per-item extra depth for bulky props (same trick, item-local).
      const dk = this.current.userData.depthK || 1;
      if (dk !== 1) {
        this.current.position.multiplyScalar(dk);
        const gr = this.current.userData.grips;
        if (gr) { gr.R?.multiplyScalar(dk); gr.L?.multiplyScalar(dk); }
      }
      this.current.userData.basePos = this.current.position.clone();
      this.current.userData.baseRot = this.current.rotation.clone();
      this.rig.add(this.current);
    }
  }

  /**
   * The carried fish is not the physics body. The body sits inside the
   * player's own collider at hand distance and gets shoved back out every
   * frame, which is why it never arrived. Interaction parks the body and
   * hides the world mesh; this shows a copy in the viewmodel, which is what
   * the player sees, and reports the hand's world position for the blood.
   */
  _attachFish(pf) {
    this._detachFish();
    if (!pf?.group) return;
    const c = pf.group.clone(true);
    c.scale.multiplyScalar(INV_K);
    c.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; } });
    c.visible = true;
    this.fishVm = c;
    this._fishPf = pf;
    this.rig.add(c);
  }

  _detachFish() {
    if (this.fishVm) { this.rig.remove(this.fishVm); this.fishVm = null; }
    this._fishPf = null;
  }

  /** Darken the copy in the hand; the world mesh is tinted by the weapon code. */
  _bloodyFish() {
    this.fishVm?.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m.color) m.color.lerp(_bloodTint, 0.55);
    });
  }

  update(dt, game) {
    const inv = game.get('inventory');
    const player = game.get('player');
    if (!inv || !player) return;

    const kind = inv.activeKind;
    let id = null;
    if (kind === 'rod') id = inv.equipped.rod;
    else if (kind === 'tool') id = inv.equipped.tool;
    else if (kind === 'weapon') id = inv.equipped.weapon;
    else if (kind === 'bait') id = inv.equipped.bait;
    else if (kind) id = kind;
    this.setItem(id);

    this.swapT = Math.min(1, this.swapT + dt * 5.5);
    this.recoilT = damp(this.recoilT, 0, 0.0002, dt);

    // ---- sway from mouse motion ----
    const look = game.input;
    const targetSwayX = clamp(-look.mouse.dx * 0.0016, -0.06, 0.06);
    const targetSwayY = clamp(-look.mouse.dy * 0.0016, -0.06, 0.06);
    this.sway.x = damp(this.sway.x, targetSwayX, 0.0008, dt);
    this.sway.y = damp(this.sway.y, targetSwayY, 0.0008, dt);

    // ---- walk bob ----
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    const bobA = clamp01(speed / player.sprintSpeed) * (game.settings.bobbing ?? 1);
    const ph = player.bobPhase;
    this.bobOffset.set(
      Math.cos(ph) * 0.022 * bobA,
      Math.sin(ph * 2) * 0.016 * bobA - clamp01(-player.velocity.y / 12) * 0.05,
      Math.sin(ph) * 0.008 * bobA,
    );

    // ---- bucket stow ----
    // Plays when a catch is collected: the bucket swings up into frame, the
    // fish goes in, and it drops back out. Driven off one 0..1 timeline so it
    // cannot desync from the viewmodel's own sway and bob.
    if (this.stowT > 0) {
      this.stowT = Math.max(0, this.stowT - dt / STOW_TIME);
      const k = 1 - this.stowT;                       // 0 -> 1 over the anim
      // Up fast, hold, down slower: the hold is what reads as "putting it in".
      const rise = k < 0.28 ? smoothstep(k / 0.28)
        : k < 0.62 ? 1
        : 1 - smoothstep((k - 0.62) / 0.38);
      this.bucketRig.visible = rise > 0.01;
      this.bucketRig.position.set(0.055, -0.20 + rise * 0.155, -0.20 - rise * 0.045);
      this.bucketRig.rotation.set(rise * -0.32, 0.5 - rise * 0.22, rise * 0.16);
      // The fish arcs down into it during the hold.
      const drop = clamp01((k - 0.3) / 0.3);
      if (this.stowFish) {
        this.stowFish.visible = drop > 0.02 && drop < 0.98;
        this.stowFish.position.set(0, 0.10 - drop * 0.115, 0.012);
        this.stowFish.rotation.z = drop * 2.1;
      }
    } else if (this.bucketRig?.visible) {
      this.bucketRig.visible = false;
      if (this.stowFish) this.stowFish.visible = false;
    }

    // ---- body english: a small lean when reaching, and the axe coming down ----
    let gy = 0, gz = 0, grx = 0;
    if (this.reachT > 0) {
      const k = 1 - this.reachT;
      const t = k < 0.5 ? smoothstep(k / 0.5) : 1 - smoothstep((k - 0.5) / 0.5);
      gy = -0.06 * t; grx = 0.16 * t;
    }
    if (this.chopT > 0) {
      const k = 1 - this.chopT;                        // ticked with the axe motion below
      if (k < 0.34) { const t = smoothstep(k / 0.34); grx += -0.08 * t; }
      else if (k < 0.5) { const t = (k - 0.34) / 0.16; gy += -0.05 * t; grx += -0.08 + 0.2 * t; }
      else { const t = smoothstep((k - 0.5) / 0.5); gy += -0.05 * (1 - t); grx += 0.12 * (1 - t); }
    }
    if (this.throwT > 0) {
      this.throwT = Math.max(0, this.throwT - dt / THROW_TIME);
      const k = 1 - this.throwT;
      if (k < 0.3) {                                   // wind back
        const t = smoothstep(k / 0.3); grx += -0.32 * t; gz += 0.06 * t; gy += 0.04 * t;
      } else if (k < 0.55) {                           // whip forward
        const t = (k - 0.3) / 0.25; grx += -0.32 + 0.9 * t; gz += 0.06 - 0.22 * t; gy += 0.04 - 0.1 * t;
      } else {
        const t = smoothstep((k - 0.55) / 0.45); grx += 0.58 * (1 - t); gz += -0.16 * (1 - t); gy += -0.06 * (1 - t);
      }
    }

    const swapDrop = (1 - smoothstep(this.swapT)) * 0.42;
    this.root.position.set(
      VM_OFFSET.x + this.sway.x + this.bobOffset.x,
      VM_OFFSET.y + this.sway.y + this.bobOffset.y - swapDrop + gy,
      VM_OFFSET.z + this.bobOffset.z - this.recoilT * 0.12 + gz,
    );
    this.root.rotation.set(
      -this.sway.y * 1.8 + this.recoilT * 0.35 + grx,
      this.sway.x * 1.8,
      -this.sway.x * 1.2 - swapDrop * 0.4,
    );

    // ---- the chop: the tool itself comes down on the fish in the other hand ----
    _chopDelta.set(0, 0, 0); let chopRx = 0;
    if (this.chopT > 0) {
      this.chopT = Math.max(0, this.chopT - dt / CHOP_TIME);
      const k = 1 - this.chopT;
      // Where the head has to land: on the fish, which sits at the left hand.
      _chopTo.copy(_holdL).add(_v3.set(0.26, 0.10, 0.02)).sub(this.current?.userData?.basePos || _v3.set(0, 0, 0));
      if (k < 0.34) {                                  // raise
        const t = smoothstep(k / 0.34); _chopDelta.set(0.02 * t, 0.16 * t, 0.06 * t); chopRx = -0.95 * t;
      } else if (k < 0.5) {                            // drive down onto it
        const t = smoothstep((k - 0.34) / 0.16);
        _chopDelta.set(0.02, 0.16, 0.06).lerp(_chopTo, t); chopRx = -0.95 + 1.55 * t;
      } else if (k < 0.7) {                            // hold on it
        _chopDelta.copy(_chopTo); chopRx = 0.6;
      } else {                                         // recover
        const t = smoothstep((k - 0.7) / 0.3); _chopDelta.copy(_chopTo).multiplyScalar(1 - t); chopRx = 0.6 * (1 - t);
      }
    }
    if (this.current?.userData?.basePos) {
      this.current.position.copy(this.current.userData.basePos).add(_chopDelta);
      this.current.rotation.x = this.current.userData.baseRot.x + chopRx;
    }

    // ---- arm posing: hands follow the held item's grip points ----
    const grips = this.current?.userData?.grips;
    if (grips && this.hands.userData.pose) {
      this.hands.visible = true;
      this.hands.userData.setVisible('R', !!grips.R);
      this.hands.userData.setVisible('L', !!grips.L);
      if (grips.R) this.hands.userData.pose('R', _gripTmp.copy(grips.R).add(_chopDelta), { roll: grips.rollR || 0 });
      if (grips.L) this.hands.userData.pose('L', _gripTmp.copy(grips.L).add(_chopDelta), { roll: grips.rollL || 0 });
    } else {
      // No grips declared: rest pose at the lower corners.
      this.hands.visible = !!this.current;
      if (this.hands.userData.pose) {
        this.hands.userData.setVisible('R', true);
        this.hands.userData.setVisible('L', true);
        this.hands.userData.pose('R', _restR);
        this.hands.userData.pose('L', _restL);
      }
    }

    // ---- the left hand, when there is a fish in it ----
    // Reaching for a fish, holding it, and putting it in the bucket are all
    // the left hand going somewhere the item grip did not ask for. Done as an
    // override after the grip pose so it works whatever is in the right hand:
    // rod, axe, or nothing.
    const carrying = !!game.get('interaction')?.held?.pf;
    if (this.hands.userData.pose && (carrying || this.reachT > 0 || this.placeT > 0)) {
      const hold = _holdL;                            // where a held fish sits
      _lpos.copy(hold);
      if (this.reachT > 0) {
        this.reachT = Math.max(0, this.reachT - dt / REACH_TIME);
        const k = 1 - this.reachT;
        // Out and down to it, then back up with the catch.
        const out = k < 0.5 ? smoothstep(k / 0.5) : 1 - smoothstep((k - 0.5) / 0.5);
        _lpos.lerpVectors(hold, _reachL, out);
      }
      if (this.placeT > 0) {
        this.placeT = Math.max(0, this.placeT - dt / PLACE_TIME);
        const k = 1 - this.placeT;
        const out = k < 0.55 ? smoothstep(k / 0.55) : 1 - smoothstep((k - 0.55) / 0.45);
        _lpos.lerpVectors(hold, _placeL, out);
      }
      this.hands.visible = true;
      this.hands.userData.setVisible('L', true);
      this.hands.userData.pose('L', _lpos, { roll: -0.35 });

      // The fish, in the hand. Laid across the palm; a live one thrashes.
      if (this.fishVm) {
        const pf = this._fishPf;
        const t = game.time;
        const alive = !!pf?.alive;
        this.fishVm.position.copy(_lpos).add(_v3.set(0.05, -0.02, -0.08));
        this.fishVm.rotation.set(
          alive ? Math.sin(t * 17) * 0.22 : 0.1,
          Math.PI / 2 + 0.35,
          (alive ? Math.sin(t * 23) * 0.4 : -0.45),
        );
        if (alive) this.fishVm.position.x += Math.sin(t * 29) * 0.012;
        this.fishVm.visible = this.reachT < 0.55;     // appears once the hand has reached it
      }
      // Hand position in the world, for blood and drops at the hand.
      this.leftHandWorld.copy(_lpos).multiplyScalar(POS_K).add(this.root.position)
        .applyQuaternion(game.camera.quaternion).add(game.camera.position);
    }

    // ---- rod-specific animation ----
    const fishing = game.get('fishing');
    if (this.current?.userData?.animate) {
      try { this.current.userData.animate(dt, { fishing, player, game, t: game.time }); }
      catch (e) { console.error('[Held] animate failed', e); }
    }

    // Match the viewmodel light to the world sun so the item isn't lit wrong.
    const sky = game.get('sky');
    if (sky) {
      this.vmKey.intensity = lerp(0.5, 2.2, sky.dayFactor);
      this.vmKey.color.copy(sky.sun.color);
      this.vmFill.intensity = lerp(0.35, 1.0, sky.dayFactor);
      this.vmFill.color.copy(sky.hemi.color);
    }
  }

  /**
   * World-space position of the rod tip.
   * The viewmodel lives in camera space, so we transform through the main
   * camera's matrix and nudge forward to compensate for the narrower vm FOV.
   */
  getRodTipWorld(out) {
    const tipObj = this.current?.userData?.tip;
    if (!tipObj) return null;
    this.vmScene.updateMatrixWorld();
    tipObj.getWorldPosition(out);
    out.applyMatrix4(this.game.camera.matrixWorld);
    return out;
  }

  /** Rendered after the main scene via Game's postRender hook. */
  postRender(game) {
    if (!this.visible || !this.current) return;
    const r = game.renderer;
    r.autoClear = false;
    r.clearDepth();
    this.vmCamera.fov = clamp(game.settings.fov * 0.66, 34, 62);
    this.vmCamera.updateProjectionMatrix();
    r.render(this.vmScene, this.vmCamera);
    r.autoClear = true;
  }

  dispose() {
    if (this.current) disposeDeep(this.current);
  }
}

// --------------------------------------------------------------- builders

function mat(color, rough = 0.7, metal = 0.05, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

/**
 * First-person arms.
 *
 * Every limb piece is a DIRECT child of the arms group — no nesting — so an
 * arm can be stretched to reach a grip point without the scale cascading into
 * the hand mesh (which is what made the first version look like floating
 * boxes). Each frame the upper arm and forearm are fitted as capsules between
 * shoulder → elbow → hand.
 */
// Short upper arm: in first person the shoulder sits just off the bottom
// corner of the frame, so most of what's visible is forearm + hand. A shoulder
// placed BEHIND the near plane makes the limb pass through the camera and fill
// the screen — keep z negative.
const UPPER_LEN = 0.17;
const FORE_LEN = 0.22;

function buildHands() {
  const g = new THREE.Group();
  g.name = 'arms';
  const skin = mat(SKIN, 0.9, 0);
  const sleeve = mat(SLEEVE, 0.96, 0);
  const cuff = mat(0x24313f, 0.96, 0);

  const arms = {};
  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? -1 : 1;

    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, Math.max(0.02, UPPER_LEN - 0.072), 3, 8), sleeve);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.031, Math.max(0.02, FORE_LEN - 0.062), 3, 8), sleeve);
    const cuffRing = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.033, 0.034, 8), cuff);

    const hand = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.026, 0.058), skin);
    palm.geometry.translate(0, 0, 0.004);
    hand.add(palm);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.0088, 0.024, 2, 5), skin);
      f.position.set((i - 1.5) * 0.0138, -0.017, 0.031);
      f.rotation.x = 1.25;
      hand.add(f);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.0105, 0.021, 2, 5), skin);
    thumb.position.set(sgn * 0.026, -0.004, 0.014);
    thumb.rotation.set(1.0, 0, sgn * -0.75);
    hand.add(thumb);
    hand.scale.setScalar(INV_K);

    g.add(upper, fore, cuffRing, hand);
    arms[side] = {
      upper, fore, cuff: cuffRing, hand,
      shoulder: new THREE.Vector3(side === 'R' ? 0.32 : -0.045, -0.45, -0.235),
      bendOut: sgn,
      visible: true,
    };
  }
  g.userData.arms = arms;
  g.userData.pose = (side, target, opts) => poseArm(arms[side], target, opts);
  g.userData.setVisible = (side, v) => {
    const a = arms[side];
    a.upper.visible = a.fore.visible = a.cuff.visible = a.hand.visible = v;
  };
  return g;
}

const _elbow = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _perp = new THREE.Vector3();

/** Place a capsule mesh so its ends sit at a and b. */
function fitLimb(mesh, a, b, baseLen) {
  _seg.subVectors(b, a);
  const len = _seg.length();
  if (len < 1e-5) return;
  _mid.copy(a).addScaledVector(_seg, 0.5);
  mesh.position.copy(_mid);
  mesh.quaternion.setFromUnitVectors(_yAxis, _seg.divideScalar(len));
  mesh.scale.set(INV_K, len / baseLen, INV_K);
}

/**
 * Two-bone arm with a fixed total length; the elbow is pushed outward and
 * down so the pose reads as an arm rather than a straight stick.
 */
function poseArm(arm, target, opts = {}) {
  if (!arm || !target) return;
  const s = arm.shoulder;
  _seg.subVectors(target, s);
  const dist = Math.min(_seg.length(), (UPPER_LEN + FORE_LEN) * 0.985);
  if (dist < 1e-4) return;
  _seg.normalize();

  // Planar two-bone IK: elbow offset perpendicular to the shoulder→hand line.
  const a = UPPER_LEN, b = FORE_LEN;
  const cos = clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1);
  const along = a * cos;
  const off = a * Math.sqrt(Math.max(0, 1 - cos * cos));
  // Bend direction: outward from the body and slightly down.
  _perp.set(arm.bendOut * 0.82, -0.52, 0.22).normalize();
  _perp.addScaledVector(_seg, -_perp.dot(_seg));
  if (_perp.lengthSq() < 1e-6) _perp.set(arm.bendOut, 0, 0);
  _perp.normalize();

  _elbow.copy(s).addScaledVector(_seg, along).addScaledVector(_perp, off);

  fitLimb(arm.upper, s, _elbow, UPPER_LEN);
  fitLimb(arm.fore, _elbow, target, FORE_LEN);
  arm.cuff.position.copy(target).addScaledVector(_seg, -0.045);
  arm.cuff.quaternion.copy(arm.fore.quaternion);
  arm.cuff.scale.setScalar(INV_K);
  arm.hand.position.copy(target);
  arm.hand.quaternion.copy(arm.fore.quaternion);
  if (opts.roll) arm.hand.rotateY(opts.roll);
}

function buildRod(item) {
  const g = new THREE.Group();
  const tier = item?.tier ?? 0;
  const rodColors = [0x8a6b45, 0x7a5a3a, 0x3d4348, 0x1e2226, 0x2a3038, 0x1b3a4a, 0x2c1f3d, 0x123c3a];
  const rodMat = mat(rodColors[Math.min(tier, rodColors.length - 1)], tier < 2 ? 0.9 : 0.35, tier < 2 ? 0 : 0.5);
  const gripMat = mat(0x2b2118, 0.95, 0);
  const metalMat = mat(0xb8bfc6, 0.3, 0.85);

  // Segmented blank so it can bend.
  const SEG = 8;
  const len = lerp(1.05, 1.7, clamp01(tier / 7));
  const segs = [];
  let parent = g;
  for (let i = 0; i < SEG; i++) {
    const t = i / SEG;
    const r0 = lerp(0.014, 0.004, t), r1 = lerp(0.014, 0.004, (i + 1) / SEG);
    const segLen = len / SEG;
    const pivot = new THREE.Object3D();
    pivot.position.z = i === 0 ? 0 : -segLen;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, segLen, 6), rodMat);
    m.rotation.x = Math.PI / 2;
    m.position.z = -segLen / 2;
    pivot.add(m);
    // Line guides.
    if (i > 1 && i % 2 === 0) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0025, 4, 8), metalMat);
      ring.position.set(0, -0.014, -segLen * 0.6);
      ring.rotation.y = Math.PI / 2;
      pivot.add(ring);
    }
    parent.add(pivot);
    segs.push(pivot);
    parent = pivot;
  }
  const tip = new THREE.Object3D();
  tip.position.z = -len / SEG;
  parent.add(tip);

  // Grip + reel.
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.024, 0.19, 8), gripMat);
  grip.rotation.x = Math.PI / 2;
  grip.position.z = 0.09;
  g.add(grip);
  const reelBody = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.026, 12), metalMat);
  reelBody.rotation.z = Math.PI / 2;
  reelBody.position.set(0, -0.045, 0.03);
  g.add(reelBody);
  const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.03, 10), mat(0xe8e2d4, 0.6, 0.1));
  spool.rotation.z = Math.PI / 2;
  spool.position.set(0, -0.045, 0.03);
  g.add(spool);
  const handle = new THREE.Group();
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.032, 0.008), metalMat);
  arm.position.y = 0.016;
  handle.add(arm);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 6, 5), gripMat);
  knob.position.y = 0.034;
  handle.add(knob);
  handle.position.set(0.042, -0.045, 0.03);
  handle.rotation.y = Math.PI / 2;
  g.add(handle);

  g.position.set(0.235, -0.215, -0.36);
  g.rotation.set(0.16, -0.22, 0.06);

  g.userData.grips = {
    R: new THREE.Vector3(0.239, -0.225, -0.29),   // rear hand on the grip
    L: new THREE.Vector3(0.205, -0.265, -0.45),   // front hand near the reel
  };
  g.userData.segs = segs;
  g.userData.tip = tip;
  g.userData.spool = spool;
  g.userData.handle = handle;
  g.userData.animate = (dt, ctx) => {
    const fishing = ctx.fishing;
    const bend = fishing ? fishing.rodBend : 0;
    // Distribute the bend along the blank, stronger toward the tip.
    for (let i = 0; i < segs.length; i++) {
      const t = (i + 1) / segs.length;
      const target = bend * 0.28 * Math.pow(t, 1.5);
      segs[i].rotation.x = damp(segs[i].rotation.x, target, 0.0006, dt);
      // Vibration when the line is under strain.
      if (fishing && fishing.tension > 0.55) {
        segs[i].rotation.y = Math.sin(ctx.t * 42 + i) * 0.012 * (fishing.tension - 0.55) * t;
      } else segs[i].rotation.y = damp(segs[i].rotation.y, 0, 0.001, dt);
    }
    // Cast wind-up and follow-through.
    if (fishing) {
      let targetPitch = 0.16, targetYaw = -0.22, targetPos = 0;
      if (fishing.state === 'charging') { targetPitch = 0.16 + fishing.castCharge * 0.9; targetPos = fishing.castCharge * 0.1; }
      else if (fishing.state === 'flying' && fishing.stateTime < 0.3) { targetPitch = -0.5; }
      g.rotation.x = damp(g.rotation.x, targetPitch, 0.0002, dt);
      g.position.z = damp(g.position.z, -0.36 + targetPos, 0.0004, dt);
      g.rotation.y = damp(g.rotation.y, targetYaw, 0.0004, dt);
      if (fishing.reeling) {
        handle.rotation.x += dt * 15 * (fishing.tension > 0.7 ? 0.5 : 1);
        spool.rotation.x += dt * 12;
      }
    }
  };
  return g;
}

function buildNet(item) {
  const g = new THREE.Group();
  const poleMat = mat(0x6b5334, 0.9);
  const rimMat = mat(0xbfc6cc, 0.35, 0.8);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, 0.8, 6), poleMat);
  pole.rotation.x = Math.PI / 2;
  pole.position.z = -0.32;
  g.add(pole);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.008, 5, 16), rimMat);
  rim.position.z = -0.76;
  rim.rotation.x = 0.25;
  g.add(rim);
  const bag = new THREE.Mesh(
    new THREE.ConeGeometry(0.155, 0.28, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x3d5a48, roughness: 1, transparent: true, opacity: 0.55, side: THREE.DoubleSide, wireframe: true }),
  );
  bag.rotation.x = -Math.PI / 2 + 0.25;
  bag.position.z = -0.88;
  g.add(bag);
  g.scale.setScalar(0.9);
  g.position.set(0.215, -0.20, -0.27);
  g.rotation.set(0.1, -0.26, 0.1);
  g.userData.depthK = 1.35;
  g.userData.grips = {
    R: new THREE.Vector3(0.222, -0.215, -0.25),
    L: new THREE.Vector3(0.205, -0.235, -0.52),
  };
  return g;
}

function buildClub(item) {
  const g = new THREE.Group();
  const m = mat(0x6b4f30, 0.92);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.02, 0.2, 7), mat(0x2b2118, 0.95));
  handle.rotation.x = Math.PI / 2 - 0.5;
  handle.position.set(0, 0, 0);
  g.add(handle);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.032, 0.2, 8), m);
  head.rotation.x = Math.PI / 2 - 0.5;
  head.position.set(0, 0.09, -0.17);
  g.add(head);
  g.position.set(0.255, -0.245, -0.36);
  g.rotation.set(0.2, -0.3, 0.15);
  g.userData.grips = { R: new THREE.Vector3(0.256, -0.255, -0.335) };
  return g;
}

function buildHarpoonGun(item) {
  const g = new THREE.Group();
  const bodyMat = mat(0x33393f, 0.4, 0.7);
  const accentMat = mat(0xd9822b, 0.5, 0.3);
  const steelMat = mat(0xc3cad1, 0.25, 0.9);

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.1, 0.38), bodyMat);
  body.position.z = -0.16;
  g.add(body);
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.26, 10), accentMat);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0, 0.075, -0.14);
  g.add(tank);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.44, 8), steelMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -0.48;
  g.add(barrel);
  const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.66, 6), steelMat);
  spear.rotation.x = Math.PI / 2;
  spear.position.z = -0.6;
  g.add(spear);
  const tipCone = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.06, 6), steelMat);
  tipCone.rotation.x = -Math.PI / 2;
  tipCone.position.z = -0.95;
  g.add(tipCone);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.13, 0.05), bodyMat);
  grip.position.set(0, -0.1, -0.02);
  grip.rotation.x = -0.24;
  g.add(grip);

  g.scale.setScalar(0.78);
  g.position.set(0.17, -0.235, -0.46);
  g.rotation.set(0.02, -0.05, 0);
  g.userData.depthK = 1.85;   // bulky: push it away rather than shrink it
  g.userData.grips = {
    R: new THREE.Vector3(0.172, -0.30, -0.42),   // pistol grip
    L: new THREE.Vector3(0.168, -0.245, -0.66),  // support hand on the barrel
  };
  g.userData.spear = spear;
  g.userData.tipCone = tipCone;
  g.userData.animate = (dt, ctx) => {
    const w = ctx.game.get('weapons');
    const loaded = w ? w.loaded !== false : true;
    spear.visible = loaded;
    tipCone.visible = loaded;
  };
  return g;
}

function buildSpear(item) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 1.5, 7), mat(0x7a5a38, 0.9));
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.45;
  g.add(shaft);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.16, 5), mat(0xb9c1c8, 0.3, 0.85));
  head.rotation.x = -Math.PI / 2;
  head.position.z = -1.26;
  g.add(head);
  for (const s of [-1, 1]) {
    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.07, 4), mat(0xb9c1c8, 0.3, 0.85));
    barb.rotation.set(-Math.PI / 2 + 0.7, 0, 0);
    barb.position.set(s * 0.022, 0, -1.15);
    g.add(barb);
  }
  g.scale.setScalar(0.85);
  g.position.set(0.245, -0.185, -0.24);
  g.rotation.set(0.08, -0.12, 0.05);
  g.userData.depthK = 1.5;
  g.userData.grips = {
    R: new THREE.Vector3(0.248, -0.205, -0.22),
    L: new THREE.Vector3(0.243, -0.215, -0.52),
  };
  return g;
}

function buildGaff(item) {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 0.9, 7), mat(0x4a4f55, 0.6, 0.4));
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.34;
  g.add(shaft);
  const hookCurve = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.008, 5, 10, Math.PI * 1.2), mat(0xc3cad1, 0.28, 0.9));
  hookCurve.position.set(0, -0.06, -0.78);
  hookCurve.rotation.set(0, Math.PI / 2, 1.4);
  g.add(hookCurve);
  g.scale.setScalar(0.92);
  g.position.set(0.238, -0.21, -0.32);
  g.rotation.set(0.14, -0.22, 0.1);
  g.userData.grips = {
    R: new THREE.Vector3(0.242, -0.225, -0.29),
    L: new THREE.Vector3(0.234, -0.245, -0.54),
  };
  return g;
}

function buildKnife(item) {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.03, 0.11), mat(0x2b2118, 0.9));
  g.add(handle);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.03, 0.18), mat(0xdde3e8, 0.16, 0.95));
  blade.position.z = -0.14;
  g.add(blade);
  g.position.set(0.24, -0.28, -0.3);
  g.rotation.set(0.15, -0.35, 0.2);
  g.userData.grips = { R: new THREE.Vector3(0.245, -0.30, -0.27) };
  return g;
}

function buildBaitBox(item) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.12), mat(0x5a7a4a, 0.9));
  g.add(box);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.014, 0.125), mat(0x3f5a35, 0.9));
  lid.position.y = 0.056;
  g.add(lid);
  g.position.set(0.235, -0.24, -0.36);
  g.rotation.set(0.2, -0.4, 0.1);
  g.userData.grips = { L: new THREE.Vector3(0.16, -0.27, -0.33) };
  return g;
}

function buildGenericTool(item) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.25), mat(0x60686f, 0.55, 0.4));
  g.add(m);
  g.position.set(0.22, -0.215, -0.34);
  g.rotation.set(0.12, -0.2, 0.08);
  g.userData.grips = { R: new THREE.Vector3(0.224, -0.23, -0.31) };
  return g;
}

const BUILDERS = {
  rod_stick: buildRod, rod_old: buildRod, rod_cheap: buildRod, rod_carbon: buildRod,
  rod_heavy: buildRod, rod_ocean: buildRod, rod_monster: buildRod, rod_experimental: buildRod,
  tool_net: buildNet, tool_club: buildClub, tool_gaff: buildGaff, tool_knife: buildKnife,
  tool_spear: buildSpear, tool_harpoon: buildSpear, tool_harpoon_gun: buildHarpoonGun,
  tool_heavy_harpoon: buildHarpoonGun, tool_deck_launcher: buildHarpoonGun,
  tool_pneumatic: buildHarpoonGun, tool_experimental: buildHarpoonGun,
  tool_hands: () => null,
  bait_worm: buildBaitBox, bait_shrimp: buildBaitBox, bait_squid: buildBaitBox,
  bait_lure: buildBaitBox, bait_glow: buildBaitBox, bait_chum: buildBaitBox, bait_legendary: buildBaitBox,
  bait_none: () => null,
};

function disposeDeep(o) {
  o?.traverse?.((c) => { if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose?.(); } });
}
