import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { getItem } from '../data/equipment.js';
import { clamp, clamp01, lerp, damp, smoothstep, rrange } from '../util/math.js';

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
    this.vmCamera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.01, 12);
    this.root = new THREE.Group();
    this.vmScene.add(this.root);

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(0.6, 1.2, 0.9);
    this.vmScene.add(key);
    const fill = new THREE.HemisphereLight(0xbfe2f2, 0x53483c, 1.0);
    this.vmScene.add(fill);
    this.vmKey = key; this.vmFill = fill;

    this.hands = buildHands();
    this.root.add(this.hands);

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
    if (this.current) { this.root.remove(this.current); disposeDeep(this.current); }
    this.current = null;
    if (!id) return;
    const item = getItem(id);
    const builder = BUILDERS[id] || BUILDERS[item?.slot] || null;
    this.current = builder ? builder(item) : buildGenericTool(item);
    if (this.current) this.root.add(this.current);
  }

  update(dt, game) {
    const inv = game.get('inventory');
    const player = game.get('player');
    if (!inv || !player) return;

    const kind = inv.activeKind;
    let id = null;
    if (kind === 'rod') id = inv.equipped.rod;
    else if (kind === 'tool') id = inv.equipped.tool;
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

    const swapDrop = (1 - smoothstep(this.swapT)) * 0.42;
    this.root.position.set(
      this.sway.x + this.bobOffset.x,
      this.sway.y + this.bobOffset.y - swapDrop,
      this.bobOffset.z - this.recoilT * 0.12,
    );
    this.root.rotation.set(
      -this.sway.y * 1.8 + this.recoilT * 0.35,
      this.sway.x * 1.8,
      -this.sway.x * 1.2 - swapDrop * 0.4,
    );

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
    // Scale camera-space offsets outward so the tip sits where it looks.
    out.multiplyScalar(1.9);
    out.applyMatrix4(this.game.camera.matrixWorld);
    return out;
  }

  /** Rendered after the main scene via Game's postRender hook. */
  postRender(game) {
    if (!this.visible || !this.current) return;
    const r = game.renderer;
    r.autoClear = false;
    r.clearDepth();
    this.vmCamera.fov = clamp(game.settings.fov * 0.82, 40, 78);
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

function buildHands() {
  const g = new THREE.Group();
  const skin = mat(SKIN, 0.85, 0);
  const sleeve = mat(SLEEVE, 0.92, 0);
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.2, 4, 8), sleeve);
    fore.rotation.z = side * 0.35;
    fore.rotation.x = -1.15;
    fore.position.set(side * 0.16, -0.18, -0.16);
    arm.add(fore);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.055, 0.1), skin);
    hand.position.set(side * 0.115, -0.085, -0.27);
    hand.rotation.z = side * 0.3;
    arm.add(hand);
    arm.name = side < 0 ? 'armL' : 'armR';
    g.add(arm);
  }
  g.position.set(0.02, -0.06, -0.12);
  return g;
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

  g.position.set(0.24, -0.24, -0.36);
  g.rotation.set(0.16, -0.22, 0.06);

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
  g.position.set(0.2, -0.22, -0.25);
  g.rotation.set(0.1, -0.28, 0.1);
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
  g.position.set(0.26, -0.3, -0.34);
  g.rotation.set(0.2, -0.3, 0.15);
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

  g.position.set(0.2, -0.22, -0.3);
  g.rotation.set(0.03, -0.06, 0);
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
  g.position.set(0.22, -0.16, -0.1);
  g.rotation.set(0.1, -0.1, 0.05);
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
  g.position.set(0.24, -0.24, -0.3);
  g.rotation.set(0.14, -0.24, 0.1);
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
  return g;
}

function buildBaitBox(item) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.12), mat(0x5a7a4a, 0.9));
  g.add(box);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.014, 0.125), mat(0x3f5a35, 0.9));
  lid.position.y = 0.056;
  g.add(lid);
  g.position.set(0.24, -0.3, -0.34);
  g.rotation.set(0.2, -0.4, 0.1);
  return g;
}

function buildGenericTool(item) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.25), mat(0x60686f, 0.55, 0.4));
  g.add(m);
  g.position.set(0.22, -0.26, -0.32);
  g.rotation.set(0.12, -0.2, 0.08);
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
