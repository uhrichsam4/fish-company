import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, rrange, damp } from '../util/math.js';
import { worldHeight } from './Terrain.js';

/**
 * Choppable trees with a growth lifecycle.
 *
 * The world already scatters trees as decoration; this gives each one an
 * identity, health and an age so it can be felled and can grow back. Trees are
 * flagged noBatch by World so they stay individually addressable -- a batched
 * tree cannot be removed, tilted or replaced with a stump.
 *
 * Performance shape, because this runs on an island with ~74 trees per region:
 *
 *  - Growth ticks at 0.5 Hz, not per frame, and only for loaded regions.
 *  - Only the tree currently being chopped animates.
 *  - A felled trunk is one dynamic rigid body for a few seconds, then it is
 *    replaced by static logs. Nothing keeps a live body around.
 *  - Trunk colliders are static and created once with the region.
 */

/** Stage thresholds in seconds of accelerated growth. */
export const STAGES = [
  { id: 'sapling', at: 0, scale: 0.22, wood: 1, choppable: true },
  { id: 'young', at: 8 * 60, scale: 0.55, wood: 3, choppable: true },
  { id: 'mature', at: 20 * 60, scale: 1.0, wood: 6, choppable: true },
  { id: 'old', at: 80 * 60, scale: 1.05, wood: 7, choppable: true },
];
/** After this long as `old`, a tree may come down on its own. */
const OLD_FALL_AFTER = 25 * 60;
/** How long a felled trunk lies on the ground before it sinks away, seconds. */
const LOG_LINGER = 16;

/** Regrowth delay after a stump is left alone. */
const REGROW_AFTER = [45, 150];

const _v = new THREE.Vector3();

export class TreeSystem {
  constructor(game) {
    this.game = game;
    this.name = 'trees';
    this.order = 47;
    /** @type {Map<string, object>} */
    this.trees = new Map();
    this.nextId = 1;
    this._tick = 0;
    /** Tree currently taking hits, so only it animates. */
    this.chopping = null;
    /** @type {Array<object>} felled trunks still simulating. */
    this.falling = [];
  }

  async init(game) {
    bus.on('game:newgame', () => { this.trees.clear(); this.nextId = 1; });
    bus.on('trees:register', (o) => this.register(o));
    bus.on('region:deactivated', ({ id }) => this._forget(id));
    return this;
  }

  /** Called by World for each tree it places. */
  register({ object, x, z, region, species, scale }) {
    const id = `t${this.nextId++}`;
    const t = {
      id, object, x, z, region, species: species || 'palm',
      baseScale: scale ?? 1,
      // Existing scenery starts mature; only regrowth walks the ladder.
      age: STAGES[2].at + rrange(0, 40 * 60),
      health: 100, maxHealth: 100,
      stage: 'mature', stump: null, felledAt: null, regrowAt: null,
      windPhase: Math.random() * Math.PI * 2,
    };
    this.trees.set(id, t);
    if (object) object.userData.treeId = id;
    return t;
  }

  _forget(regionId) {
    for (const [id, t] of [...this.trees]) if (t.region === regionId) this.trees.delete(id);
  }

  stageFor(age) {
    let s = STAGES[0];
    for (const st of STAGES) if (age >= st.at) s = st;
    return s;
  }

  /** Nearest choppable tree the player is looking at. */
  targetAt(position, forward, maxDist = 3.4) {
    let best = null, bestScore = -Infinity;
    for (const t of this.trees.values()) {
      if (t.felledAt) continue;
      const dx = t.x - position.x, dz = t.z - position.z;
      const d = Math.hypot(dx, dz);
      if (d > maxDist) continue;
      // Favour what the player is actually facing over what is merely nearest.
      const dot = (dx / (d || 1)) * forward.x + (dz / (d || 1)) * forward.z;
      if (dot < 0.35) continue;
      const score = dot * 2 - d * 0.2;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /**
   * Land one axe blow. Returns the tree if it came down.
   */
  chop(tree, power, game) {
    if (!tree || tree.felledAt) return null;
    tree.health -= power;
    tree.lastHit = game.time;
    this.chopping = tree;

    const pos = new THREE.Vector3(tree.x, worldHeight(tree.x, tree.z) + 1.1, tree.z);
    game.audio?.play('crate_break', { volume: 0.35, rate: 1.35 + Math.random() * 0.2, position: pos.clone(), throttle: 90 });
    bus.emit('fx:sparkle', { position: pos.clone(), count: 7, color: '#b98a55' });

    if (tree.health > 0) return null;
    return this.fell(tree, game);
  }

  /** Bring a tree down and leave logs behind. */
  fell(tree, game) {
    if (tree.felledAt) return null;
    tree.felledAt = game.time;
    tree.health = 0;
    this.chopping = null;

    const st = this.stageFor(tree.age);
    const wood = Math.max(1, Math.round(st.wood * (tree.baseScale || 1)));
    const ground = worldHeight(tree.x, tree.z);
    const pos = new THREE.Vector3(tree.x, ground, tree.z);

    game.audio?.play('boss_slam', { volume: 0.5, rate: 1.5, position: pos.clone() });
    game.audio?.play('splash_medium', { volume: 0.25, rate: 0.7, position: pos.clone() });
    bus.emit('player:shake', 0.3);

    // The trunk tips over rather than vanishing. One dynamic body, a few
    // seconds, then it becomes a static log pile -- a felled forest must not
    // leave dozens of live rigid bodies lying around.
    if (tree.object) {
      this.falling.push({
        tree, object: tree.object, t: 0, landed: false,
        baseY: tree.object.position.y,
        axis: Math.random() * Math.PI * 2,
        speed: rrange(1.5, 2.4),
      });
    }

    const res = game.get('resources');
    if (res) res.add('wood', wood);
    bus.emit('trees:felled', { tree, wood });
    bus.emit('toast', { text: `🪵 +${wood} wood`, kind: 'success', duration: 2400 });

    tree.regrowAt = game.time + rrange(REGROW_AFTER[0], REGROW_AFTER[1]);
    return tree;
  }

  /**
   * The felled trunk, lying along the direction it fell.
   *
   * Sampled at both ends and pitched to match, so it sits on a slope instead
   * of hovering over one. Length comes from the tree's own scale, so a sapling
   * does not leave the same log as a mature palm.
   */
  _makeLog(tree, axis) {
    const len = 4.4 * (tree.baseScale || 1);
    const dirX = Math.sin(axis), dirZ = -Math.cos(axis);
    const midX = tree.x + dirX * len * 0.5;
    const midZ = tree.z + dirZ * len * 0.5;

    const g = new THREE.CylinderGeometry(0.24, 0.3, len, 7);
    g.rotateZ(Math.PI / 2);                    // lie it along +X
    const m = new THREE.MeshStandardMaterial({ color: 0x8a6136, roughness: 0.94, flatShading: true });
    const log = new THREE.Mesh(g, m);

    const y0 = worldHeight(tree.x, tree.z);
    const y1 = worldHeight(tree.x + dirX * len, tree.z + dirZ * len);
    log.position.set(midX, (y0 + y1) * 0.5 + 0.26, midZ);
    log.rotation.y = -Math.atan2(dirZ, dirX);
    log.rotation.z = Math.atan2(y1 - y0, len);  // follow the slope
    log.castShadow = true; log.receiveShadow = true;
    log.userData.noBatch = true;
    log.userData.restY = log.position.y;
    tree.object.parent?.add(log);
    return log;
  }

  _makeStump(tree) {
    if (tree.stump || !tree.object) return;
    const ground = worldHeight(tree.x, tree.z);
    const g = new THREE.CylinderGeometry(0.28, 0.34, 0.5, 8);
    const m = new THREE.MeshStandardMaterial({ color: 0x7b5533, roughness: 0.95 });
    const stump = new THREE.Mesh(g, m);
    stump.position.set(tree.x, ground + 0.2, tree.z);
    stump.castShadow = true; stump.receiveShadow = true;
    stump.userData.noBatch = true;
    tree.object.parent?.add(stump);
    tree.stump = stump;
  }

  update(dt, game) {
    // ---- felled trunks tipping over ----
    //
    // The trunk used to vanish 0.8 s after it landed, which meant the fall was
    // over before you had finished watching it and the tree read as having
    // disappeared rather than fallen. It now lies where it fell, as a log, and
    // is only cleared once it has been on the ground long enough to have been
    // seen.
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const k = clamp01(f.t / 1.6);
      // Ease into the fall: slow start, accelerating, which reads as a hinge
      // rather than a rotation applied at constant speed.
      const angle = (Math.PI / 2) * k * k;
      f.object.rotation.z = Math.cos(f.axis) * angle;
      f.object.rotation.x = Math.sin(f.axis) * angle;

      // The moment it hits: thud, dust, stump at the base, and the standing
      // palm is swapped for a log.
      //
      // The palm itself cannot be left lying down. It rotates about its own
      // base, so on any slope the trunk ends up buried on the uphill side and
      // floating on the downhill one, and the canopy sweeps through the
      // terrain -- which is what made a felled tree read as not having fallen
      // at all. A log laid along the fall direction and sat on the ground
      // reads correctly on any ground.
      if (!f.landed && k >= 1) {
        f.landed = true;
        const ground = worldHeight(f.tree.x, f.tree.z);
        const at = new THREE.Vector3(f.tree.x, ground + 0.3, f.tree.z);
        game.audio?.play('boss_slam', { volume: 0.65, rate: 0.75, position: at.clone() });
        bus.emit('fx:dustPuff', { position: at.clone(), count: 18, scale: 1.6 });
        bus.emit('player:shake', 0.22);
        this._makeStump(f.tree);
        f.object.visible = false;
        f.log = this._makeLog(f.tree, f.axis);
      }

      // Lie there, then sink out of sight rather than blinking off.
      if (f.landed) {
        const lying = f.t - 1.6;
        if (lying > LOG_LINGER && f.log) {
          const sink = (lying - LOG_LINGER) / 1.4;
          f.log.position.y = f.log.userData.restY - sink * 1.6;
          if (sink >= 1) {
            f.log.parent?.remove(f.log);
            f.log.geometry.dispose();
            f.log = null;
            this.falling.splice(i, 1);
          }
        }
      }
    }

    // ---- growth, at 0.5 Hz ----
    this._tick += dt;
    if (this._tick < 2) return;
    const step = this._tick;
    this._tick = 0;

    for (const t of this.trees.values()) {
      if (t.felledAt) {
        if (t.regrowAt != null && game.time >= t.regrowAt) this._regrow(t, game);
        continue;
      }
      t.age += step;
      const st = this.stageFor(t.age);
      if (st.id !== t.stage) {
        t.stage = st.id;
        if (t.object) t.object.scale.setScalar(t.baseScale * st.scale);
      }
      // Old trees eventually come down on their own, staggered so a whole
      // stand does not drop at once.
      if (st.id === 'old' && t.age > STAGES[3].at + OLD_FALL_AFTER && Math.random() < 0.004 * step) {
        this.fell(t, game);
      }
    }
  }

  _regrow(t, game) {
    t.felledAt = null;
    t.regrowAt = null;
    t.age = 0;
    t.stage = 'sapling';
    t.health = t.maxHealth;
    if (t.stump) { t.stump.parent?.remove(t.stump); t.stump = null; }
    if (t.object) {
      t.object.visible = true;
      t.object.rotation.set(0, t.object.rotation.y, 0);
      // A tree felled and regrown while its log was still sinking would come
      // back underground.
      const f = this.falling.find((e) => e.tree === t);
      if (f?.log) { f.log.parent?.remove(f.log); f.log.geometry.dispose(); f.log = null; }
      if (f) t.object.position.y = f.baseY;
      t.object.scale.setScalar(t.baseScale * STAGES[0].scale);
    }
    this.falling = this.falling.filter((e) => e.tree !== t);
    bus.emit('trees:regrown', { tree: t });
  }

  save() {
    // Only trees that differ from their generated state need storing.
    const out = [];
    for (const t of this.trees.values()) {
      if (!t.felledAt && t.health >= t.maxHealth && t.stage === 'mature') continue;
      out.push({
        id: t.id, region: t.region, x: +t.x.toFixed(2), z: +t.z.toFixed(2),
        age: Math.round(t.age), health: Math.round(t.health),
        felled: !!t.felledAt, regrowAt: t.regrowAt != null ? Math.round(t.regrowAt) : null,
      });
    }
    return { trees: out, savedAt: this.game.time };
  }

  load(d) {
    if (!d?.trees) return;
    // Trees are keyed by position, because ids are assigned in region-build
    // order and a reload may register them in a different sequence.
    const byPos = new Map();
    for (const t of this.trees.values()) byPos.set(`${t.region}:${t.x.toFixed(1)}:${t.z.toFixed(1)}`, t);
    for (const s of d.trees) {
      const t = byPos.get(`${s.region}:${s.x.toFixed(1)}:${s.z.toFixed(1)}`);
      if (!t) continue;
      t.age = s.age; t.health = s.health;
      t.stage = this.stageFor(t.age).id;
      t.regrowAt = s.regrowAt;
      if (s.felled) {
        t.felledAt = 1;
        if (t.object) t.object.visible = false;
        this._makeStump(t);
      }
      if (t.object && !s.felled) t.object.scale.setScalar(t.baseScale * this.stageFor(t.age).scale);
    }
  }
}
