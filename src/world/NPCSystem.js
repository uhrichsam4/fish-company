import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { buildWorkerMesh, buildWorkerTool } from '../workers/WorkerMesh.js';
import { NPCS, NPC_BY_ID, npcAmbient } from '../data/npcs.js';
import { REGION_BY_ID } from '../data/regions.js';
import { worldHeight } from './Terrain.js';
import { DialoguePanel } from '../ui/panels/DialoguePanel.js';
import { clamp, clamp01, lerp, damp, rrange, TAU } from '../util/math.js';

const SPAWN_RADIUS = 68;          // build the mesh
const DESPAWN_RADIUS = 92;        // drop it again (hysteresis)
const LABEL_RADIUS = 12;          // label starts fading in here
const LABEL_FULL = 8;             // …and is solid here
const HEAD_TRACK_RADIUS = 7;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _rayOrigin = new THREE.Vector3();
const _ray = new THREE.Raycaster();

/** Collider tags an NPC must not be standing inside. */
const BLOCK_TAGS = new Set(['building', 'rock', 'wreck', 'iceberg', 'structure', 'prop', 'boat', 'crate']);

/**
 * The people. Twelve of them, world-wide.
 *
 * Each is a `buildWorkerMesh` rig with a fixed seed (so they always look like
 * themselves), parked on a World anchor, with a name label, an idle animation
 * that head-tracks you up close, an occasional muttered line, and an [E]
 * interactable that opens a real conversation.
 *
 * Meshes live in this system's own scene group, never in the region group —
 * region teardown disposes geometry, and WorkerMesh geometry is shared and
 * cached, so handing it to `disposeGroup` would take the whole cast with it.
 */
export class NPCSystem {
  constructor(game) {
    this.game = game;
    this.name = 'npcs';
    this.order = 75;

    /** @type {Array<object>} live NPC records */
    this.npcs = [];
    this.byId = new Map();
    this.met = new Set();
    this.talks = {};
    this.root = null;
    this.dialogue = null;
    this.current = null;           // NPC being talked to

    this._checkTimer = 0;
    this._labelBox = null;
    this._bubble = null;
    this._bubbleFor = null;
    this._bubbleTimer = 0;
    this._offs = [];
  }

  async init(game) {
    if (this._inited) return this;   // adding a system late must not double-register
    this._inited = true;
    this.root = new THREE.Group();
    this.root.name = 'npcs';
    game.scene.add(this.root);

    for (const def of NPCS) {
      const n = {
        def, id: def.id, name: def.name, region: def.region,
        position: new THREE.Vector3(), facing: 0, lookAt: new THREE.Vector3(),
        placed: false, physical: false, object: null, rig: null, tool: null,
        labelEl: null, labelOpacity: 0,
        phase: Math.random() * TAU,
        glanceTimer: rrange(3, 9), glanceYaw: 0,
        talkTimer: rrange(8, 30),
        registered: false, settled: false, interactable: null,
      };
      this.npcs.push(n);
      this.byId.set(def.id, n);
    }

    this._labelBox = document.createElement('div');
    this._labelBox.id = 'npc-labels';
    this._labelBox.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    document.getElementById('ui-root')?.appendChild(this._labelBox);

    // Dialogue lives in the UIManager's panel map so Esc, pointer-lock
    // hand-off and the "only one panel open" rule all work for free.
    this.dialogue = new DialoguePanel(game);
    const ui = game.get('ui');
    if (ui) ui.register('dialogue', this.dialogue);

    this._offs.push(bus.on('interact:talk', (d) => this.talk(d?.npcId)));
    this._offs.push(bus.on('region:activated', (def) => this._register(def.id)));
    this._offs.push(bus.on('region:deactivated', (def) => this._unregister(def.id)));
    this._offs.push(bus.on('game:newgame', () => { this.met.clear(); this.talks = {}; }));
    this._offs.push(bus.on('npc:talk', (d) => this.talk(d?.id)));

    // Anything already streamed in before we booted.
    const world = game.get('world');
    if (world) for (const [id, s] of world.regions) if (s.active) this._register(id);

    return this;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    for (const n of this.npcs) this._despawn(n);
    this._labelBox?.remove();
    this._bubble?.remove();
  }

  // ------------------------------------------------------------- placement

  /** Resolve a world position from the region's anchors. Idempotent. */
  place(n, force = false) {
    if (n.placed && !force) return true;
    const world = this.game.get('world');
    const def = REGION_BY_ID[n.region];
    if (!world || !def || def.trench) return false;
    let a;
    try { a = world.getAnchors(n.region); } catch (e) { return false; }
    if (!a) return false;

    const at = n.def.at;
    const base = a[at.anchor] || a.spawn || a.shore;
    if (!base) return false;
    const out = a.outward || { x: 1, z: 0 };
    const side = a.side || { x: 0, z: 1 };

    const wantX = base.x + out.x * (at.fwd || 0) + side.x * (at.side || 0);
    const wantZ = base.z + out.z * (at.fwd || 0) + side.z * (at.side || 0);
    const onDock = at.anchor === 'dock' || at.anchor === 'dockEnd' || at.anchor === 'dockStart';
    // `dock.y` is the anchor height, not necessarily the height of the planks
    // that got built there, so probe for the surface actually on screen.
    const wantY = onDock
      ? this._deckY(wantX, wantZ, (a.dock?.y ?? 1.8)) + 0.04
      : worldHeight(wantX, wantZ);
    // Region dressing moves around; an anchor that was open sand last week can
    // be the inside of a warehouse now. Shuffle out of anything solid.
    const spot = this._findClear(wantX, wantZ, wantY, onDock);
    const x = spot.x, z = spot.z, y = spot.y;
    n.position.set(x, y, z);

    // Face something meaningful rather than due north.
    let target = a.dock || a.shore;
    if (at.face === 'sea' && a.dockEnd) {
      target = { x: a.dockEnd.x + out.x * 30, z: a.dockEnd.z + out.z * 30 };
    } else if (at.face === 'shore' && a.shore) target = a.shore;
    else if (at.face === 'campfire' && a.campfire) target = a.campfire;
    else if (at.face === 'shop' && a.shop) target = a.shop;
    if (target) n.facing = Math.atan2(target.x - x, target.z - z);
    n.lookAt.set(target?.x ?? x, y + 1.5, target?.z ?? z + 1);

    n.placed = true;
    // Only trustworthy once the region's colliders actually exist.
    n.settled = !!world.regions.get(n.region)?.active;
    if (n.interactable) {
      n.interactable.position.set(x, y + 1.2, z);
    }
    return true;
  }

  /**
   * Height of the dock surface at (x,z). Dock props are built by the region
   * decorator and their deck does not always sit exactly on the anchor, so an
   * NPC placed at the anchor height can end up shin-deep in the planks.
   */
  _deckY(x, z, baseY) {
    const world = this.game.get('world');
    if (!world?.root) return baseY;
    _rayOrigin.set(x, baseY + 8, z);
    _ray.set(_rayOrigin, _down);
    _ray.far = 14;
    let hits;
    try { hits = _ray.intersectObject(world.root, true); }
    catch (e) { return baseY; }
    for (const h of hits) {
      const y = h.point.y;
      if (y > baseY + 5) continue;         // a roof or a gantry, not the deck
      if (y < baseY - 0.4) break;          // past the deck, into the water
      return y;
    }
    return baseY;
  }

  /**
   * Nearest spot within a few metres that is not inside a static collider.
   * Colliders only exist for an activated region, so this is a no-op until
   * the region streams in — `_register` re-runs it at that point.
   */
  _findClear(x, z, y, onDock) {
    const phys = this.game.physics;
    if (!phys?.querySphere) return { x, z, y };
    const blocked = (cx, cz, cy) => {
      let bad = false;
      _probe.set(cx, cy + 0.95, cz);
      try {
        phys.querySphere(_probe, 0.6, (e) => {
          if (BLOCK_TAGS.has(e.tag)) { bad = true; return false; }
          return true;
        });
      } catch (err) { return false; }
      return bad;
    };
    if (!blocked(x, z, y)) return { x, z, y };
    for (const r of [1.7, 2.9, 4.3, 6.2]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + r;
        const nx = x + Math.cos(a) * r;
        const nz = z + Math.sin(a) * r;
        const ny = onDock ? y : worldHeight(nx, nz);
        if (!onDock && ny < 0.35) continue;          // nobody stands in the sea
        if (!blocked(nx, nz, ny)) return { x: nx, z: nz, y: ny };
      }
    }
    return { x, z, y };
  }

  _register(regionId) {
    const world = this.game.get('world');
    if (!world) return;
    for (const n of this.npcs) {
      if (n.region !== regionId) continue;
      // Placement done before the region streamed in had no colliders to test
      // against; redo it now that the buildings exist.
      if (!this.place(n, n.placed && !n.settled)) continue;
      if (n.registered) continue;
      const it = {
        region: regionId,
        kind: 'talk',
        label: `Talk to ${n.def.name}`,
        key: 'E',
        // Chest height, and a little more reach than the shop shack behind them
        // so walking up to the person wins over walking up to the building.
        position: new THREE.Vector3(n.position.x, n.position.y + 1.2, n.position.z),
        radius: 4.4,
        data: { npcId: n.id },
      };
      world.interactables.push(it);
      n.interactable = it;
      n.registered = true;
      if (n.physical) n.object.position.copy(n.position);
    }
  }

  _unregister(regionId) {
    for (const n of this.npcs) if (n.region === regionId) { n.registered = false; n.interactable = null; }
    // World already dropped the interactables for this region.
  }

  // ---------------------------------------------------------------- meshes

  _spawn(n) {
    if (n.physical) return;
    n.object = buildWorkerMesh(n.def.seed, { role: n.def.role });
    n.rig = n.object.userData.rig;
    n.object.position.copy(n.position);
    n.object.rotation.y = n.facing;
    n.object.name = `npc:${n.id}`;
    this.root.add(n.object);
    if (n.def.prop) {
      n.tool = buildWorkerTool(n.def.prop);
      // Worker props are sized for a rig that is swinging them about; on a
      // character standing still and being talked to, a full-size crate hides
      // the whole torso.
      n.tool.scale.setScalar(n.def.propScale ?? 0.62);
      n.rig.itemSocket.add(n.tool);
    }
    n.physical = true;
  }

  _despawn(n) {
    if (!n.physical) return;
    this.root.remove(n.object);
    n.object = null; n.rig = null; n.tool = null;
    n.physical = false;
    if (n.labelEl) { n.labelEl.remove(); n.labelEl = null; }
    n.labelOpacity = 0;
  }

  // ------------------------------------------------------------- dialogue

  ctx() {
    const g = this.game;
    return {
      game: g,
      eco: g.get('economy'),
      inv: g.get('inventory'),
      quests: g.get('quests'),
      world: g.get('world'),
      boats: g.get('boats'),
      fleets: g.get('fleets'),
      workers: g.get('workers'),
      weather: g.get('weather'),
      events: g.get('events'),
      gambling: g.get('gambling'),
      subs: g.get('subs'),
      player: g.get('player'),
      regionId: g.get('world')?.activeRegion?.id,
      met: this.met,
    };
  }

  talk(npcId) {
    const n = this.byId.get(npcId);
    if (!n) { console.warn('[NPC] unknown npc', npcId); return; }
    this.current = n;
    const first = !this.met.has(n.id);
    this.talks[n.id] = (this.talks[n.id] || 0) + 1;

    const ui = this.game.get('ui');
    const data = { npcId: n.id, first };
    if (ui?.panels?.has('dialogue')) ui.show('dialogue', data);
    else { this.dialogue.data = data; this.dialogue.show(); }

    // "First meeting" only counts once the conversation actually opened.
    this.met.add(n.id);
    bus.emit('npc:talked', { id: n.id, name: n.def.name, first });
    if (first) bus.emit('quest:flag', { flag: `met_${n.id}` });
  }

  /** Floating bubble over an NPC's head. One at a time, world-wide. */
  say(n, line) {
    if (!line) return;
    if (!this._bubble) {
      const el = document.createElement('div');
      el.className = 'npc-bubble';
      el.style.cssText = 'position:absolute;pointer-events:none;background:rgba(8,16,24,.86);'
        + 'border:1px solid rgba(90,140,175,.4);padding:5px 11px;border-radius:13px;font-size:13px;'
        + 'max-width:340px;transform:translate(-50%,-100%);transition:opacity .3s;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.45);line-height:1.35;';
      this._labelBox.appendChild(el);
      this._bubble = el;
    }
    this._bubble.innerHTML = `<b style="color:#2fd4c4">${n.def.name}:</b> ${line}`;
    this._bubble.style.opacity = '1';
    this._bubbleFor = n;
    this._bubbleTimer = 3.8;
  }

  // ---------------------------------------------------------------- update

  update(dt, game) {
    if (dt <= 0) return;
    const player = game.get('player');
    if (!player) return;
    const px = player.position.x, pz = player.position.z;

    // Streaming + placement, at 2 Hz.
    this._checkTimer += dt;
    if (this._checkTimer > 0.5) {
      this._checkTimer = 0;
      for (const n of this.npcs) {
        const rdef = REGION_BY_ID[n.region];
        if (!rdef) continue;
        const regionDist = Math.hypot(px - rdef.x, pz - rdef.z);
        if (!n.placed) {
          if (regionDist > rdef.reach + 320) continue;
          this.place(n);
          if (n.placed && !n.registered) this._register(n.region);
        }
        if (!n.placed) continue;
        // A region teardown drops our interactable with it; put it back as soon
        // as the player is near enough for the NPC to matter again.
        if (!n.registered && regionDist < rdef.reach + 320) this._register(n.region);
        const d = Math.hypot(px - n.position.x, pz - n.position.z);
        if (!n.physical && d < SPAWN_RADIUS) this._spawn(n);
        else if (n.physical && d > DESPAWN_RADIUS) this._despawn(n);
      }
    }

    const t = game.time;
    const cam = game.camera;
    const talking = this.dialogue?.open ? this.current : null;

    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      if (!n.physical) continue;
      _v.set(n.position.x - px, 0, n.position.z - pz);
      const d = _v.length();

      this._animate(n, dt, t, player, d, talking === n);
      this._label(n, d, cam, dt);

      // Occasional muttering, only when someone is around to hear it.
      n.talkTimer -= dt;
      if (n.talkTimer <= 0) {
        n.talkTimer = rrange(22, 55);
        if (d < 17 && !this.dialogue?.open && this._bubbleTimer <= 0) {
          this.say(n, npcAmbient(n.def, Math.random()));
        }
      }
    }

    this._updateBubble(dt, cam);

    // Number keys pick a dialogue response while the panel is up. `justPressed`
    // is suppressed by uiCapture, so this has to read the raw edge.
    if (this.dialogue?.open) {
      for (let k = 1; k <= 9; k++) {
        if (game.input.rawPressed(`Digit${k}`)) { this.dialogue.handleKey(`Digit${k}`); break; }
      }
    }
  }

  /** Idle: weight shift, breathing, glancing about, head-track up close. */
  _animate(n, dt, t, player, dist, isTalking) {
    const rig = n.rig;
    if (!rig) return;
    // Keep the mesh on the record's position every frame: `place()` can move an
    // NPC after they have spawned (region dressing streams in and shoves them
    // out of a wall), and the mesh must follow.
    n.object.position.copy(n.position);
    n.object.rotation.y = n.facing;
    const p = n.phase;
    const breathe = Math.sin(t * 1.15 + p);
    const shift = Math.sin(t * 0.42 + p * 1.7);          // slow weight transfer

    rig.hips.position.y = rig.legLen + 0.06 + breathe * 0.008;
    rig.hips.rotation.z = shift * 0.045;
    rig.torso.rotation.z = -shift * 0.06;
    rig.torso.rotation.x = 0.02 + breathe * 0.014;
    rig.legs.L.hip.rotation.x = 0.03 + shift * 0.05;
    rig.legs.R.hip.rotation.x = 0.03 - shift * 0.05;
    rig.legs.L.knee.rotation.x = Math.max(0, shift) * 0.06;
    rig.legs.R.knee.rotation.x = Math.max(0, -shift) * 0.06;

    const k = 1 - Math.pow(0.02, dt);
    const armL = rig.arms.L, armR = rig.arms.R;
    const holding = !!n.tool;
    const targetL = holding ? -0.45 : 0.04 + breathe * 0.03;
    const targetR = holding ? -0.55 : 0.04 - breathe * 0.03;
    armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, targetL + shift * 0.05, k);
    armR.shoulder.rotation.x = lerp(armR.shoulder.rotation.x, targetR - shift * 0.05, k);
    armL.shoulder.rotation.z = lerp(armL.shoulder.rotation.z, 0.11, k);
    armR.shoulder.rotation.z = lerp(armR.shoulder.rotation.z, -0.11, k);
    armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, holding ? -0.9 : -0.16, k);
    armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, holding ? -1.05 : -0.16, k);

    // Head: track the player inside conversation range, otherwise glance
    // around at whatever they were nominally facing.
    let wantYaw, wantPitch = 0;
    if (dist < HEAD_TRACK_RADIUS || isTalking) {
      const dx = player.position.x - n.position.x;
      const dz = player.position.z - n.position.z;
      wantYaw = clamp(wrap(Math.atan2(dx, dz) - n.facing), -1.05, 1.05);
      const dy = (player.position.y + 1.5) - (n.position.y + 1.55);
      wantPitch = clamp(-Math.atan2(dy, Math.max(0.6, dist)) * 0.7, -0.45, 0.45);
      // Turn the whole body when the player walks well behind them.
      const want = Math.atan2(dx, dz);
      if (Math.abs(wrap(want - n.facing)) > 1.0) {
        n.facing += wrap(want - n.facing) * (1 - Math.pow(0.25, dt));
      }
    } else {
      n.glanceTimer -= dt;
      if (n.glanceTimer <= 0) {
        n.glanceTimer = rrange(3.5, 11);
        n.glanceYaw = rrange(-0.75, 0.75);
      }
      wantYaw = n.glanceYaw;
      wantPitch = Math.sin(t * 0.31 + p) * 0.06;
    }
    rig.head.rotation.y = damp(rig.head.rotation.y, wantYaw, 0.02, dt);
    rig.head.rotation.x = damp(rig.head.rotation.x, wantPitch, 0.02, dt);
  }

  /** Name label: created on demand, fades in inside LABEL_RADIUS. */
  _label(n, dist, cam, dt) {
    const want = clamp01((LABEL_RADIUS - dist) / (LABEL_RADIUS - LABEL_FULL));
    if (want <= 0.001 && !n.labelEl) return;

    if (!n.labelEl) {
      const el = document.createElement('div');
      el.className = 'npc-label';
      const hex = `#${(n.def.accent >>> 0).toString(16).padStart(6, '0')}`;
      el.style.cssText = 'position:absolute;pointer-events:none;transform:translate(-50%,-100%);'
        + 'text-align:center;white-space:nowrap;text-shadow:0 2px 8px rgba(0,0,0,.9);opacity:0;';
      el.innerHTML = `<div style="font-size:14px;font-weight:800;color:${hex}">${n.def.name}</div>`
        + `<div style="font-size:11px;color:#a5bccd;letter-spacing:.06em">${n.def.title}</div>`
        + `<div style="font-size:10px;color:#6f8ba1;margin-top:1px">[E] Talk</div>`;
      this._labelBox.appendChild(el);
      n.labelEl = el;
    }
    n.labelOpacity = damp(n.labelOpacity, want, 0.001, dt);

    _v2.set(n.position.x, n.position.y + 2.15, n.position.z).project(cam);
    if (_v2.z > 1 || n.labelOpacity < 0.01) { n.labelEl.style.opacity = '0'; return; }
    n.labelEl.style.opacity = n.labelOpacity.toFixed(2);
    n.labelEl.style.left = `${(_v2.x * 0.5 + 0.5) * window.innerWidth}px`;
    n.labelEl.style.top = `${(-_v2.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  _updateBubble(dt, cam) {
    if (!this._bubble || this._bubbleTimer <= 0) return;
    this._bubbleTimer -= dt;
    const n = this._bubbleFor;
    if (this._bubbleTimer <= 0 || !n?.physical) { this._bubble.style.opacity = '0'; return; }
    _v2.set(n.position.x, n.position.y + 2.6, n.position.z).project(cam);
    if (_v2.z > 1) { this._bubble.style.opacity = '0'; return; }
    this._bubble.style.opacity = '1';
    this._bubble.style.left = `${(_v2.x * 0.5 + 0.5) * window.innerWidth}px`;
    this._bubble.style.top = `${(-_v2.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  // ----------------------------------------------------------- persistence

  save() {
    return { met: [...this.met], talks: this.talks };
  }

  load(d) {
    if (!d) return;
    this.met = new Set(d.met || []);
    this.talks = d.talks || {};
  }
}

function wrap(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
