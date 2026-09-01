import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { WORLD_EVENTS, EVENT_BY_ID, rollEvent, playerTier, candidateRegions } from '../data/events.js';
import { REGION_BY_ID } from '../data/regions.js';
import { worldHeight } from './Terrain.js';
import { clamp, makeRNG, rrange, TAU } from '../util/math.js';

const _v = new THREE.Vector3();
const _spot = { x: 0, y: 0, z: 0 };

/** Shared beacon geometry — one set for every marker in the world. */
let _beaconGeo = null;
function beaconGeo() {
  if (_beaconGeo) return _beaconGeo;
  const beam = new THREE.CylinderGeometry(0.45, 1.25, 70, 10, 1, true);
  beam.translate(0, 35, 0);
  const ring = new THREE.RingGeometry(2.3, 3.1, 34);
  ring.rotateX(-Math.PI / 2);
  const core = new THREE.OctahedronGeometry(0.62, 0);
  const halo = new THREE.RingGeometry(0.85, 1.35, 20);
  _beaconGeo = { beam, ring, core, halo };
  return _beaconGeo;
}

const _beaconMats = new Map();
function beaconMats(color) {
  let m = _beaconMats.get(color);
  if (m) return m;
  m = {
    beam: new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.13, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: true,
    }),
    ring: new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
    }),
    core: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false }),
    halo: new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.35, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }),
  };
  _beaconMats.set(color, m);
  return m;
}

/**
 * Random world events.
 *
 * Rolls one event every 3–8 minutes (weighted by how far the player has got),
 * runs at most two at a time, and gives each one a real, revertible effect on
 * the simulation. Location-bearing events get a floating beacon so the player
 * can find them without opening a menu.
 *
 * Multipliers on other systems (fish luck/rarity/density, danger) go through
 * `ev.mult()` so several events can stack and unwind independently — and so an
 * external write (e.g. the auto-quality system lowering fish density) is
 * detected and preserved on the next recompute rather than trampled.
 */
export class EventSystem {
  constructor(game) {
    this.game = game;
    this.name = 'events';
    this.order = 36;

    /** @type {Array<object>} live event instances */
    this.activeEvents = [];
    this.maxActive = 2;
    this.history = [];
    this.enabled = true;

    this.rng = makeRNG((Math.random() * 4294967296) >>> 0);
    this.rollTimer = rrange(150, 300);       // first event comes a little sooner
    this.minGap = 180;
    this.maxGap = 480;

    /** Read by other systems: how spicy the ocean currently is. */
    this.dangerMult = 1;
    this.deepBonus = 1;

    this.root = null;
    this._markerPool = [];
    this._applied = new Map();               // "target.key" -> factor we last wrote
    this._modKeys = new Map();               // target -> Set(keys)
    this._seq = 1;
    this._offs = [];
  }

  async init(game) {
    if (this._inited) return this;   // adding a system late must not double-register
    this._inited = true;
    this.root = new THREE.Group();
    this.root.name = 'world-events';
    this.root.renderOrder = 2;
    game.scene.add(this.root);

    this._offs.push(bus.on('game:newgame', () => this.reset()));
    this._offs.push(bus.on('debug:triggerEvent', (d) => this.trigger(d?.id)));
    this._offs.push(bus.on('event:trigger', (d) => this.trigger(d?.id, d)));
    this._offs.push(bus.on('event:cancel', (d) => this.stop(d?.id, 'cancelled')));
    return this;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.reset();
  }

  // ------------------------------------------------------------- public API

  /** All definitions, for UI listings. */
  get catalogue() { return WORLD_EVENTS; }

  isActive(id) { return this.activeEvents.some((e) => e.id === id); }

  /** Force-start an event. Returns the instance or null. */
  trigger(id, opts = {}) {
    const def = EVENT_BY_ID[id];
    if (!def) { console.warn('[Events] unknown event', id); return null; }
    if (this.isActive(id)) return this.activeEvents.find((e) => e.id === id);
    let regionId = opts.regionId ?? null;
    if (!regionId && !def.anywhere) {
      const list = candidateRegions(def, this.game).filter(Boolean);
      regionId = list.length ? list[(this.rng() * list.length) | 0] : this._pickRegion(def);
    }
    return this._start(def, regionId, opts);
  }

  /** End an active event early. */
  stop(id, reason = 'stopped') {
    const ev = this.activeEvents.find((e) => e.id === id);
    if (!ev) return false;
    this._end(ev, reason);
    return true;
  }

  reset() {
    for (const ev of [...this.activeEvents]) this._end(ev, 'reset');
    this.activeEvents.length = 0;
    this.history.length = 0;
    this.rollTimer = rrange(150, 300);
    this._recomputeMults();
  }

  /** Seconds until the next roll — the HUD/debug menu likes to show this. */
  get nextEventIn() { return Math.max(0, this.rollTimer); }

  // ------------------------------------------------------------- lifecycle

  _pickRegion(def) {
    if (def.anywhere) return null;
    const quests = this.game.get('quests');
    const live = Object.values(REGION_BY_ID).filter((r) => !r.trench
      && (!quests || quests.isRegionUnlocked(r.id)));
    const list = live.length ? live : [REGION_BY_ID.crash];
    return list[(this.rng() * list.length) | 0].id;
  }

  _start(def, regionId, opts = {}) {
    const seed = opts.seed ?? ((this.rng() * 4294967296) >>> 0);
    const ev = this._instantiate(def, regionId, seed);
    ev.remaining = opts.duration ?? def.duration ?? 240;
    ev.duration = ev.remaining;

    try { def.apply?.(this.game, ev); }
    catch (e) { console.error(`[Events] "${def.id}" apply threw:`, e); ev.abort = true; }

    if (ev.abort) return null;

    if (opts.data) Object.assign(ev.data, opts.data);
    if (opts.remaining != null) ev.remaining = opts.remaining;

    this.activeEvents.push(ev);
    this._recomputeMults();
    if (ev.marker) this._makeMarker(ev);

    if (!opts.silent) {
      const region = regionId ? (REGION_BY_ID[regionId]?.name || regionId) : 'everywhere';
      bus.emit('toast', {
        text: `${ev.icon} <b>${ev.title}</b><br><span style="opacity:.75;font-size:12px">${ev.summary || def.desc}${regionId ? ` · ${region}` : ''}</span>`,
        kind: 'gold', duration: 8000,
      });
      this.game.audio?.play(def.sound || 'notification', { volume: 0.6 });
    }
    bus.emit('event:started', {
      id: def.id, name: ev.title, icon: ev.icon, regionId,
      duration: ev.duration, summary: ev.summary, desc: def.desc,
    });
    return ev;
  }

  _end(ev, reason = 'expired') {
    const i = this.activeEvents.indexOf(ev);
    if (i >= 0) this.activeEvents.splice(i, 1);
    try { ev.def.end?.(this.game, ev); }
    catch (e) { console.error(`[Events] "${ev.id}" end threw:`, e); }
    this._releaseMarker(ev);
    this._recomputeMults();
    this.history.push({ id: ev.id, at: this.game.time, reason });
    if (this.history.length > 24) this.history.shift();
    if (reason !== 'reset' && reason !== 'load') {
      bus.emit('toast', { text: `${ev.icon} ${ev.title} — over.`, kind: 'muted', duration: 3200 });
    }
    bus.emit('event:ended', { id: ev.id, name: ev.title, reason });
  }

  /** Build the live instance and bind the helper surface events use. */
  _instantiate(def, regionId, seed) {
    const game = this.game;
    const rng = makeRNG(seed >>> 0 || 1);
    const sys = this;
    const ev = {
      uid: sys._seq++,
      id: def.id,
      def,
      seed,
      regionId,
      title: def.name,
      icon: def.icon || '❗',
      summary: '',
      data: {},
      mods: null,
      marker: null,
      markerObj: null,
      remaining: def.duration ?? 240,
      duration: def.duration ?? 240,
      elapsed: 0,
      abort: false,
      rng,

      // ---- helpers available to every event definition ----
      emit(name, payload) { bus.emit(name, payload); },
      toast(text, kind = '', duration = 5000) { bus.emit('toast', { text, kind, duration }); },
      sound(name, opts) { game.audio?.play(name, opts); },
      vec(x, y, z) { return new THREE.Vector3(x, y, z); },
      finish() { sys._end(ev, 'completed'); },

      /** Register a multiplicative modifier; reverted automatically on end. */
      mult(target, key, factor) {
        (ev.mods ||= {});
        (ev.mods[target] ||= {});
        ev.mods[target][key] = (ev.mods[target][key] ?? 1) * factor;
        let set = sys._modKeys.get(target);
        if (!set) { set = new Set(); sys._modKeys.set(target, set); }
        set.add(key);
      },

      spawnFish(opts) {
        const fish = game.get('fish');
        if (!fish?.spawnSpecific) return 0;
        return fish.spawnSpecific(opts).length;
      },

      playerPos() { return game.get('player')?.position || _v.set(0, 0, 0); },

      distToPlayer(x, z) {
        const p = game.get('player');
        if (!p) return Infinity;
        return Math.hypot(p.position.x - x, p.position.z - z);
      },

      playerIn(id) {
        if (!id) return true;
        return game.get('world')?.activeRegion?.id === id;
      },

      /** A point on open water near (x,z). Returns a shared object — copy it. */
      waterSpotNear(x, z, radius, minDepth = 2) {
        const s = sys.findWaterSpot(x, z, radius, minDepth, rng);
        return s ? { x: s.x, y: s.y, z: s.z } : null;
      },
    };
    return ev;
  }

  /** Search outward for a spot with at least `minDepth` metres of water. */
  findWaterSpot(cx, cz, radius, minDepth = 2, rng = this.rng) {
    const ocean = this.game.get('ocean');
    for (let i = 0; i < 90; i++) {
      const a = rng() * TAU;
      const r = radius * (0.25 + 0.75 * Math.sqrt(rng()));
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const bed = worldHeight(x, z);
      const surf = ocean ? ocean.heightAt(x, z) : 0;
      const depth = surf - bed;
      if (depth < minDepth) continue;
      _spot.x = x;
      _spot.z = z;
      _spot.y = clamp(surf - Math.min(5, depth * 0.5), bed + 0.8, surf - 0.6);
      return _spot;
    }
    return null;
  }

  // ------------------------------------------------------------- modifiers

  _target(name) {
    if (name === 'fish') return this.game.get('fish');
    if (name === 'events') return this;
    return this.game.get(name);
  }

  /**
   * Rewrite every modified field as `base * Π(active factors)`. The base is
   * recovered by dividing out the factor we wrote last time, so a value another
   * system changed in the meantime survives instead of being clobbered.
   */
  _recomputeMults() {
    for (const [targetName, keys] of this._modKeys) {
      const obj = this._target(targetName);
      if (!obj) continue;
      for (const key of keys) {
        const mapKey = `${targetName}.${key}`;
        const last = this._applied.get(mapKey) ?? 1;
        const cur = Number.isFinite(obj[key]) ? obj[key] : 1;
        const base = last !== 0 ? cur / last : cur;
        let factor = 1;
        for (const ev of this.activeEvents) {
          const f = ev.mods?.[targetName]?.[key];
          if (f) factor *= f;
        }
        obj[key] = base * factor;
        if (factor === 1) this._applied.delete(mapKey);
        else this._applied.set(mapKey, factor);
      }
    }
  }

  // --------------------------------------------------------------- markers

  _makeMarker(ev) {
    const m = ev.marker;
    if (!m) return;
    const color = m.color ?? 0x2fd4c4;
    let g = this._markerPool.pop();
    if (!g) {
      const geo = beaconGeo();
      g = new THREE.Group();
      const beam = new THREE.Mesh(geo.beam, null);
      beam.name = 'beam';
      const ring = new THREE.Mesh(geo.ring, null);
      ring.name = 'ring';
      ring.position.y = 0.12;
      const core = new THREE.Mesh(geo.core, null);
      core.name = 'core';
      core.position.y = 2.2;
      const halo = new THREE.Mesh(geo.halo, null);
      halo.name = 'halo';
      halo.position.y = 2.2;
      const light = new THREE.PointLight(color, 6, 26, 2);
      light.name = 'light';
      light.position.y = 2.4;
      g.add(beam, ring, core, halo, light);
      g.userData.parts = { beam, ring, core, halo, light };
    }
    const mats = beaconMats(color);
    const p = g.userData.parts;
    p.beam.material = mats.beam;
    p.ring.material = mats.ring;
    p.core.material = mats.core;
    p.halo.material = mats.halo;
    p.light.color.setHex(color);
    g.position.set(m.x, m.y ?? 0, m.z);
    g.visible = true;
    g.frustumCulled = false;
    this.root.add(g);
    ev.markerObj = g;
  }

  _releaseMarker(ev) {
    const g = ev.markerObj;
    if (!g) return;
    this.root.remove(g);
    g.visible = false;
    ev.markerObj = null;
    if (this._markerPool.length < 4) this._markerPool.push(g);
  }

  // ---------------------------------------------------------------- update

  update(dt, game) {
    if (dt <= 0 || !this.enabled) return;

    // ---- roll for a new event ----
    this.rollTimer -= dt;
    if (this.rollTimer <= 0) {
      this.rollTimer = rrange(this.minGap, this.maxGap);
      if (this.activeEvents.length < this.maxActive) {
        const exclude = this.activeEvents.map((e) => e.id);
        for (const h of this.history.slice(-2)) exclude.push(h.id);
        const roll = rollEvent(game, this.rng, exclude);
        if (roll) this._start(roll.def, roll.regionId);
      } else {
        this.rollTimer *= 0.4;             // try again sooner once a slot frees
      }
    }

    // ---- tick the live ones ----
    for (let i = this.activeEvents.length - 1; i >= 0; i--) {
      const ev = this.activeEvents[i];
      ev.elapsed += dt;
      ev.remaining -= dt;
      if (ev.remaining <= 0) { this._end(ev, 'expired'); continue; }
      if (!ev.def.tick) continue;
      try { ev.def.tick(dt, game, ev); }
      catch (e) {
        console.error(`[Events] "${ev.id}" tick threw:`, e);
        ev.tickErrors = (ev.tickErrors || 0) + 1;
        if (ev.tickErrors > 120) this._end(ev, 'errored');
      }
    }

    // ---- animate beacons (no allocation) ----
    const t = game.time;
    for (let i = 0; i < this.activeEvents.length; i++) {
      const g = this.activeEvents[i].markerObj;
      if (!g) continue;
      const p = g.userData.parts;
      p.core.rotation.y = t * 1.1;
      p.core.rotation.x = t * 0.55;
      p.core.position.y = 2.2 + Math.sin(t * 1.7 + i) * 0.35;
      p.halo.position.y = p.core.position.y;
      p.halo.lookAt(game.camera.position);
      const pulse = 1 + Math.sin(t * 1.9 + i) * 0.14;
      p.ring.scale.set(pulse, 1, pulse);
      p.ring.material.opacity = 0.34 + Math.sin(t * 1.9 + i) * 0.16;
      p.light.intensity = 5 + Math.sin(t * 3.1 + i) * 2.2;
    }
  }

  // ----------------------------------------------------------- persistence

  save() {
    return {
      rollTimer: this.rollTimer,
      active: this.activeEvents
        .filter((e) => !e.def.once)
        .map((e) => ({
          id: e.id, regionId: e.regionId, seed: e.seed,
          remaining: e.remaining, elapsed: e.elapsed, data: e.data,
        })),
      history: this.history.slice(-8),
    };
  }

  load(d) {
    for (const ev of [...this.activeEvents]) this._end(ev, 'load');
    if (!d) return;
    this.rollTimer = Number.isFinite(d.rollTimer) ? d.rollTimer : rrange(this.minGap, this.maxGap);
    this.history = d.history || [];
    for (const s of d.active || []) {
      const def = EVENT_BY_ID[s.id];
      if (!def || def.once) continue;          // one-shot effects already happened
      if (!(s.remaining > 1)) continue;
      this._start(def, s.regionId, {
        seed: s.seed, data: s.data, remaining: s.remaining, silent: true,
      });
    }
    this._recomputeMults();
  }
}

/** Convenience for HUD/debug listings. */
export function eventTierSummary(game) {
  return { tier: playerTier(game), total: WORLD_EVENTS.length };
}
