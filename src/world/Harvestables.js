import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { rrange } from '../util/math.js';

/**
 * Everything in the world you can hit with a tool that is not a tree.
 *
 * Rocks, boulders, crates, barrels and driftwood were scenery: solid, hittable
 * in the sense that you bounced off them, and completely inert. Swinging an axe
 * at a crate did nothing and said nothing, which reads as a broken game rather
 * than as "that is not choppable".
 *
 * One registry rather than a system per prop type. The things that differ
 * between a boulder and a crate are the numbers -- health, what falls out,
 * which tool helps -- not the behaviour, and a rock that needs its own class
 * to be breakable is a rock that never gets made breakable.
 *
 * Entries hold their mesh and physics body so breaking one can remove both.
 * Broken entries are kept, not deleted, so they can come back: an island
 * stripped bare on day two and never recovering is worse than one that regrows.
 */

/** Respawn window, seconds. Long enough to matter, short enough to forgive. */
const RESPAWN = [240, 460];

/**
 * Kinds. `tool` is the stat that makes it efficient -- hitting a rock with an
 * axe still works, it is just slow, because "nothing happens" is the failure
 * mode this whole system exists to remove.
 */
export const KINDS = {
  rock: { name: 'Rock', icon: '🪨', health: 80, tool: 'mine', drops: { stone: 3 }, debris: '#9a978e' },
  boulder: { name: 'Boulder', icon: '🪨', health: 220, tool: 'mine', drops: { stone: 9 }, debris: '#8e8b83' },
  crate: { name: 'Crate', icon: '📦', health: 45, tool: 'chop', drops: { wood: 4 }, debris: '#c09257' },
  barrel: { name: 'Barrel', icon: '🛢️', health: 55, tool: 'chop', drops: { wood: 3, rope: 1 }, debris: '#b5793f' },
  driftwood: { name: 'Driftwood', icon: '🪵', health: 30, tool: 'chop', drops: { wood: 3 }, debris: '#b8a58c' },
  bush: { name: 'Bush', icon: '🌿', health: 18, tool: 'chop', drops: { rope: 1 }, debris: '#6f9a4e' },
};

export class HarvestSystem {
  constructor(game) {
    this.game = game;
    this.name = 'harvest';
    this.order = 45;
    /** @type {Map<string, object>} */
    this.nodes = new Map();
    this._next = 1;
    /** Currently aimed-at node, for the HUD prompt. */
    this.target = null;
    this._respawnT = 0;
  }

  async init() {
    bus.on('game:newgame', () => this.clearAll());
    // A deactivated region's meshes are disposed; holding references to them
    // would keep dead geometry alive and aim the prompt at nothing.
    bus.on('region:deactivated', ({ id }) => this.clearRegion(id));
    return this;
  }

  clearAll() { this.nodes.clear(); this._next = 1; }

  /** Drop every node belonging to a region being unloaded. */
  clearRegion(regionId) {
    for (const [id, n] of [...this.nodes]) if (n.region === regionId) this.nodes.delete(id);
  }

  /**
   * @param {{object:THREE.Object3D, kind:string, x:number, z:number, y?:number,
   *          radius?:number, region?:string, body?:any, scale?:number}} spec
   */
  register(spec) {
    const k = KINDS[spec.kind];
    if (!k || !spec.object) return null;
    const scale = spec.scale ?? 1;
    const id = `h${this._next++}`;
    const health = Math.max(8, Math.round(k.health * scale));
    const node = {
      id, kind: spec.kind, def: k, object: spec.object, body: spec.body || null,
      x: spec.x, y: spec.y ?? 0, z: spec.z,
      radius: spec.radius ?? 0.9, region: spec.region || null, scale,
      health, maxHealth: health, broken: false, respawnAt: 0,
    };
    this.nodes.set(id, node);
    spec.object.userData.harvestId = id;
    return node;
  }

  /**
   * Nearest node the player is aiming at.
   *
   * Distance is measured to the node's surface rather than its centre, so a
   * two-metre boulder is not harder to hit than a pebble. The old tree version
   * of this measured centre-to-centre, which is why big things felt
   * unreachable: you were already touching it and still out of range.
   */
  targetAt(position, forward, maxDist = 3.6) {
    let best = null, bestScore = -Infinity;
    for (const n of this.nodes.values()) {
      if (n.broken) continue;
      const dx = n.x - position.x, dz = n.z - position.z;
      const d = Math.hypot(dx, dz);
      const surface = Math.max(0, d - n.radius);
      if (surface > maxDist) continue;
      const dot = d < 0.001 ? 1 : (dx / d) * forward.x + (dz / d) * forward.z;
      // Close in, aim barely matters -- you are standing on top of it.
      if (dot < (surface < 1.2 ? -0.2 : 0.3)) continue;
      const score = dot * 2 - surface * 0.25;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  /**
   * Land one blow. `stats` is the tool's stat block; the matching tool does
   * full damage and anything else does a fraction, so every swing does
   * something and the right tool is an obvious upgrade rather than a gate.
   */
  hit(node, stats, game) {
    if (!node || node.broken) return null;
    const want = node.def.tool;
    const matched = (stats?.[want] ?? 0) > 0;
    const power = matched
      ? stats[want]
      : Math.max(3, Math.round((stats?.chop ?? stats?.mine ?? stats?.damage ?? 10) * 0.28));

    node.health -= power;
    const pos = new THREE.Vector3(node.x, node.y + 0.6, node.z);
    game.audio?.play('crate_break', {
      volume: 0.32, rate: node.kind === 'rock' || node.kind === 'boulder' ? 0.8 : 1.3,
      position: pos.clone(), throttle: 80,
    });
    bus.emit('fx:sparkle', { position: pos.clone(), count: 6, color: node.def.debris });
    bus.emit('harvest:hit', { node, power, matched });

    if (node.health > 0) return null;
    return this.break(node, game);
  }

  /** Break it, drop what is in it, and schedule it to come back. */
  break(node, game) {
    if (node.broken) return null;
    node.broken = true;
    node.health = 0;
    node.respawnAt = game.time + rrange(RESPAWN[0], RESPAWN[1]);

    const pos = new THREE.Vector3(node.x, node.y + 0.5, node.z);
    game.audio?.play('crate_break', { volume: 0.6, rate: 0.95, position: pos.clone() });
    bus.emit('fx:impact', { position: pos.clone(), normal: new THREE.Vector3(0, 1, 0), kind: 'wood', scale: 1.2 });
    bus.emit('player:shake', 0.12);

    const res = game.get('resources');
    const got = [];
    for (const [id, n] of Object.entries(node.def.drops)) {
      // Bigger things hold more, but never nothing.
      const amount = Math.max(1, Math.round(n * node.scale));
      res?.add(id, amount);
      got.push(`${amount} ${id}`);
    }
    bus.emit('toast', {
      text: `${node.def.icon} +${got.join(' · ')}`, kind: 'success', duration: 2200,
    });

    if (node.object) node.object.visible = false;
    if (node.body) { try { game.physics.remove(node.body); } catch { /* already gone */ } node.body = null; }
    if (this.target === node) this.target = null;
    bus.emit('harvest:broken', { node });
    return node;
  }

  /**
   * Aim scan and respawns.
   *
   * The scan is what makes any of this discoverable: it drives the on-screen
   * prompt, so looking at a crate tells you it can be broken and what with,
   * instead of leaving you to guess by swinging at scenery.
   */
  update(dt, game) {
    const player = game.get('player');
    if (!player) return;

    this._respawnT += dt;
    if (this._respawnT >= 2) {
      this._respawnT = 0;
      for (const n of this.nodes.values()) {
        if (!n.broken || game.time < n.respawnAt) continue;
        n.broken = false;
        n.health = n.maxHealth;
        if (n.object) n.object.visible = true;
      }
    }

    const fwd = _fwd;
    player.forward(fwd);
    this.target = this.targetAt(player.position, fwd, 3.6);
  }

  save() {
    const broken = [];
    for (const n of this.nodes.values()) {
      if (n.broken) broken.push([n.id, +n.respawnAt.toFixed(1)]);
      else if (n.health < n.maxHealth) broken.push([n.id, 0, Math.round(n.health)]);
    }
    return { broken };
  }

  load(d) {
    if (!d?.broken) return;
    for (const [id, respawnAt, health] of d.broken) {
      const n = this.nodes.get(id);
      if (!n) continue;
      if (health != null) { n.health = health; continue; }
      n.broken = true;
      n.respawnAt = respawnAt;
      if (n.object) n.object.visible = false;
      if (n.body) { try { this.game.physics.remove(n.body); } catch { /* gone */ } n.body = null; }
    }
  }
}

const _fwd = new THREE.Vector3();
