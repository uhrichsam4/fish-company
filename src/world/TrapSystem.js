import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, rrange, makeRNG } from '../util/math.js';
import { speciesInRegion, spawnWeightIn, rollFishInstance, RARITY_ORDER } from '../data/fishData.js';
import { regionAt } from '../data/regions.js';
import { worldHeight } from './Terrain.js';
import { waterHeightAt } from './waves.js';
import * as Props from './props/index.js';

/**
 * Fish traps: placed in the world, fill over real time, must be collected.
 *
 * Catches are resolved lazily from timestamps rather than ticked. A trap that
 * has been in the water for two hours does not need 7200 seconds of
 * simulation -- it needs one calculation when the player next looks at it.
 * That is also what makes traps survive a reload correctly: the maths is the
 * same whether the game was running or not.
 */

export const TRAPS = [
  {
    id: 'trap_basket', name: 'Basket Trap', icon: '🧺', price: 260,
    capacity: 3, ratePerMin: 0.55, maxDepth: 6, sizeBias: 0.1, luck: 0.7, rareBias: 0.7,
    desc: 'Woven reed. Catches what wanders in, which is not much.',
  },
  {
    id: 'trap_wire', name: 'Wire Trap', icon: '🪤', price: 900,
    capacity: 6, ratePerMin: 0.95, maxDepth: 12, sizeBias: 0.28, luck: 1.0, rareBias: 1.0,
    desc: 'Galvanised mesh with a proper funnel. Holds what it takes.',
  },
  {
    id: 'trap_large', name: 'Large Trap', icon: '🗃️', price: 3200,
    capacity: 12, ratePerMin: 1.4, maxDepth: 20, sizeBias: 0.45, luck: 1.5, rareBias: 1.3,
    desc: 'Big enough to be a nuisance to carry and worth it anyway.',
  },
  {
    id: 'trap_pro', name: 'Professional Trap', icon: '⚙️', price: 11000,
    capacity: 20, ratePerMin: 2.0, maxDepth: 34, sizeBias: 0.62, luck: 2.2, rareBias: 1.7,
    desc: 'Commercial gear. Baited, weighted, and quietly ruthless.',
  },
  {
    id: 'trap_deep', name: 'Deep Water Trap', icon: '🛢️', price: 34000,
    capacity: 28, ratePerMin: 2.4, maxDepth: 90, sizeBias: 0.8, luck: 3.2, rareBias: 2.4,
    desc: 'Rated for pressure. Brings up things with no eyes.',
  },
];
export const TRAP_BY_ID = Object.fromEntries(TRAPS.map((t) => [t.id, t]));

/** Traps keep fishing while you are away, but not forever. */
const MAX_SOAK_MIN = 90;
/** Condition lost per hour soaking; a neglected trap catches less. */
const WEAR_PER_HOUR = 0.12;

let _nextId = 1;

export class TrapSystem {
  constructor(game) {
    this.game = game;
    this.name = 'traps';
    this.order = 46;
    /** @type {Map<string, object>} */
    this.traps = new Map();
    /** Trap ids the player owns but has not placed. */
    this.inventory = [];
    this.root = null;
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'fish-traps';
    game.scene.add(this.root);

    bus.on('game:newgame', () => { this.clearAll(); this.inventory.length = 0; });
    bus.on('traps:buy', ({ id }) => this.buy(id));
    bus.on('traps:place', () => this.placeHeld());
    bus.on('debug:giveTrap', ({ id }) => { this.inventory.push(id || 'trap_basket'); bus.emit('traps:changed'); });
    return this;
  }

  clearAll() {
    for (const t of this.traps.values()) this._removeMesh(t);
    this.traps.clear();
  }

  buy(defId) {
    const def = TRAP_BY_ID[defId];
    if (!def) return false;
    const eco = this.game.get('economy');
    if (!eco?.spend(def.price, 'trap')) return false;
    this.inventory.push(defId);
    this.game.audio?.play('purchase', { volume: 0.7 });
    bus.emit('toast', { text: `${def.icon} ${def.name} — press [G] at the water to place`, kind: 'gold', duration: 4200 });
    bus.emit('traps:changed');
    return true;
  }

  // ------------------------------------------------------------------ place

  /**
   * @returns {{ok:boolean, why?:string, depth?:number}} whether this spot works.
   */
  canPlaceAt(x, z, def) {
    const bed = worldHeight(x, z);
    const surf = waterHeightAt(x, z);
    const depth = surf - bed;
    if (depth < 0.8) return { ok: false, why: 'Needs deeper water.' };
    if (depth > def.maxDepth) {
      return { ok: false, why: `Too deep for a ${def.name} (${depth.toFixed(0)} m > ${def.maxDepth} m).` };
    }
    for (const t of this.traps.values()) {
      if (Math.hypot(t.x - x, t.z - z) < 4) return { ok: false, why: 'Another trap is already here.' };
    }
    return { ok: true, depth };
  }

  /** Place the first trap in inventory at the spot the player is aiming at. */
  placeHeld() {
    if (!this.inventory.length) {
      bus.emit('toast', { text: 'No traps to place. Buy one from the shop.', kind: 'error' });
      return null;
    }
    const player = this.game.get('player');
    if (!player) return null;
    const fwd = new THREE.Vector3();
    player.forward(fwd);

    // Walk out along the aim until the water is deep enough, so the player
    // can stand on the shore and lob one into the shallows in front of them.
    let spot = null;
    for (let d = 2; d <= 14; d += 0.75) {
      const x = player.position.x + fwd.x * d;
      const z = player.position.z + fwd.z * d;
      const def = TRAP_BY_ID[this.inventory[0]];
      const check = this.canPlaceAt(x, z, def);
      if (check.ok) { spot = { x, z, depth: check.depth }; break; }
    }
    if (!spot) {
      bus.emit('toast', { text: 'Aim at open water to place a trap.', kind: 'error', duration: 3000 });
      return null;
    }
    const defId = this.inventory.shift();
    return this.place(defId, spot.x, spot.z);
  }

  place(defId, x, z) {
    const def = TRAP_BY_ID[defId];
    if (!def) return null;
    const bed = worldHeight(x, z);
    const surf = waterHeightAt(x, z);

    const trap = {
      id: `k${_nextId++}`, defId, def,
      x, z, y: bed + 0.3, depth: surf - bed,
      region: regionAt(x, z)?.id || 'crash',
      placedAt: this.game.time,
      lastCollected: this.game.time,
      condition: 1,
      seed: (Math.random() * 1e9) | 0,
      /** @type {Array<object>} resolved lazily; see catchesFor(). */
      caught: [],
      mesh: null, buoy: null,
    };
    this._makeMesh(trap);
    this.traps.set(trap.id, trap);

    this.game.audio?.play('splash_medium', { volume: 0.6, position: new THREE.Vector3(x, surf, z) });
    bus.emit('ocean:ripple', { x, z, strength: 0.7 });
    bus.emit('toast', { text: `${def.icon} ${def.name} set in ${trap.depth.toFixed(1)} m`, kind: 'success', duration: 3200 });
    // Distinct from traps:place, which is only the keypress and fires even
    // when there is nothing to place or nowhere to put it.
    bus.emit('traps:placed', { trap });
    bus.emit('traps:changed');
    return trap;
  }

  _makeMesh(trap) {
    const rng = makeRNG(trap.seed);
    const g = new THREE.Group();
    const body = Props.buildFishCrate?.(rng, {}) || new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.6, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x8b6239, roughness: 0.9 }),
    );
    body.position.y = 0;
    g.add(body);
    g.position.set(trap.x, trap.y, trap.z);
    g.userData.noBatch = true;
    g.traverse?.((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.root.add(g);
    trap.mesh = g;

    // A marker buoy on the surface, because a trap on the seabed is invisible
    // and an uncollectable trap is worse than no trap.
    const buoy = Props.buildBuoy?.(rng, {}) || new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xffc22e, roughness: 0.5 }),
    );
    buoy.userData.noBatch = true;
    buoy.traverse?.((o) => { if (o.isMesh) o.castShadow = true; });
    this.root.add(buoy);
    trap.buoy = buoy;
  }

  _removeMesh(t) {
    if (t.mesh) { this.root.remove(t.mesh); t.mesh = null; }
    if (t.buoy) { this.root.remove(t.buoy); t.buoy = null; }
  }

  // ----------------------------------------------------------------- catches

  /**
   * How many fish a trap holds right now, derived from soak time. Deterministic
   * from (seed, elapsed) so it reads the same before and after a reload.
   */
  soakMinutes(trap) {
    return clamp((this.game.time - trap.lastCollected) / 60, 0, MAX_SOAK_MIN);
  }

  expectedCount(trap) {
    const soak = this.soakMinutes(trap);
    const rate = trap.def.ratePerMin * trap.condition;
    return Math.min(trap.def.capacity, Math.floor(soak * rate));
  }

  /** Materialise the catch list for a trap, sized to its soak. */
  catchesFor(trap) {
    const want = this.expectedCount(trap);
    if (trap.caught.length >= want) return trap.caught;
    const rng = makeRNG(trap.seed ^ (trap.caught.length * 7919));
    const pool = speciesInRegion(trap.region).filter((s) => !s.boss);
    if (!pool.length) return trap.caught;

    while (trap.caught.length < want) {
      // Weight by regional spawn weight, then bias by the trap's quality: a
      // better trap is more likely to hold something big and unusual.
      let total = 0;
      const weights = pool.map((s) => {
        // RARITY_ORDER index is the rarity ladder; a better trap tilts the
        // draw up it. RARITY entries carry no tier field of their own.
        const step = Math.max(0, RARITY_ORDER.indexOf(s.rarity));
        const rare = 1 + step * 0.35 * (trap.def.rareBias - 1);
        const w = Math.max(0.01, spawnWeightIn(s, trap.region) * rare);
        total += w;
        return w;
      });
      let r = rng() * total, pick = pool[0];
      for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { pick = pool[i]; break; } }
      // sizeBias is clamped to 0..1 upstream; luck is what drives variants.
      const inst = rollFishInstance(pick, rng, { sizeBias: trap.def.sizeBias, luck: trap.def.luck ?? 1 });
      trap.caught.push(inst);
    }
    return trap.caught;
  }

  /** Nearest trap within reach of the player, for the [E] prompt. */
  nearest(position, radius = 3.5) {
    let best = null, bd = radius;
    for (const t of this.traps.values()) {
      const d = Math.hypot(t.x - position.x, t.z - position.z);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** Empty a trap into the inventory. Leaves the trap fishing. */
  collect(trap) {
    const caught = this.catchesFor(trap);
    if (!caught.length) {
      bus.emit('toast', { text: `${trap.def.icon} Empty so far.`, kind: '', duration: 2200 });
      return { count: 0 };
    }
    const inv = this.game.get('inventory');
    let taken = 0, left = 0;
    for (const inst of [...caught]) {
      if (inv?.storeFish(inst, { fromTrap: true })) { taken++; caught.shift(); } else { left++; break; }
    }
    // Soak restarts from what was actually taken, so a full inventory does not
    // silently bin the rest of the catch.
    if (taken) {
      trap.lastCollected = this.game.time;
      trap.condition = Math.max(0.35, trap.condition - WEAR_PER_HOUR * (this.soakMinutes(trap) / 60));
      this.game.audio?.play('fish_into_bucket', { volume: 0.75 });
      this.game.audio?.play('splash_small', { volume: 0.4 });
      bus.emit('traps:collected', { trap, count: taken });
      bus.emit('toast', {
        text: `${trap.def.icon} +${taken} fish${left ? ' — no room for the rest, left in the trap' : ''}`,
        kind: 'success', duration: 3400,
      });
    } else {
      bus.emit('toast', { text: 'No room for more fish.', kind: 'error', duration: 2600 });
    }
    bus.emit('traps:changed');
    return { count: taken, remaining: caught.length };
  }

  /** Pull a trap out of the water and put it back in the player's kit. */
  retrieve(trap) {
    if (this.catchesFor(trap).length) this.collect(trap);
    this._removeMesh(trap);
    this.traps.delete(trap.id);
    this.inventory.push(trap.defId);
    this.game.audio?.play('bucket_pick_up', { volume: 0.6 });
    bus.emit('toast', { text: `${trap.def.icon} ${trap.def.name} retrieved`, kind: '', duration: 2400 });
    bus.emit('traps:changed');
    return true;
  }

  update(dt, game) {
    // Only the buoys move: bob them on the real wave surface so a trap reads
    // as floating gear rather than a decal.
    for (const t of this.traps.values()) {
      if (!t.buoy) continue;
      const surf = waterHeightAt(t.x, t.z);
      t.buoy.position.set(t.x, surf + 0.1, t.z);
      t.buoy.rotation.z = Math.sin(game.time * 1.3 + t.x) * 0.14;
      t.buoy.rotation.x = Math.cos(game.time * 1.1 + t.z) * 0.14;
    }
  }

  save() {
    return {
      inventory: [...this.inventory],
      nextId: _nextId,
      traps: [...this.traps.values()].map((t) => ({
        id: t.id, defId: t.defId, x: +t.x.toFixed(2), z: +t.z.toFixed(2),
        region: t.region, placedAt: t.placedAt, lastCollected: t.lastCollected,
        condition: +t.condition.toFixed(3), seed: t.seed,
        // Store only the count; the instances regenerate from the same seed.
        held: t.caught.length,
      })),
    };
  }

  load(d) {
    this.clearAll();
    if (!d) return;
    this.inventory = [...(d.inventory || [])];
    _nextId = d.nextId || 1;
    for (const s of d.traps || []) {
      const def = TRAP_BY_ID[s.defId];
      if (!def) continue;
      const bed = worldHeight(s.x, s.z);
      const trap = {
        id: s.id, defId: s.defId, def,
        x: s.x, z: s.z, y: bed + 0.3, depth: waterHeightAt(s.x, s.z) - bed,
        region: s.region, placedAt: s.placedAt, lastCollected: s.lastCollected,
        condition: s.condition ?? 1, seed: s.seed, caught: [], mesh: null, buoy: null,
      };
      this._makeMesh(trap);
      this.traps.set(trap.id, trap);
    }
    bus.emit('traps:changed');
  }
}
