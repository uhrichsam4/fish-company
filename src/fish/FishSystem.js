import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import {
  FISH_SPECIES, getSpecies, speciesInRegion, rollFishInstance, rollVariant,
  rollSpecies, RARITY, VARIANT_BY_ID, spawnWeightIn,
} from '../data/fishData.js';
import { REGION_BY_ID, regionAt } from '../data/regions.js';
import {
  clamp, clamp01, lerp, damp, rrange, rint, rpick, rchance, makeRNG, TAU,
  dist2DSq, weightedPick,
} from '../util/math.js';
import { worldHeight } from '../world/Terrain.js';
import * as FishMeshMod from './FishMesh.js';

export const FISH_STATE = {
  ROAM: 'roam', SCHOOL: 'school', INTERESTED: 'interested', NIBBLE: 'nibble',
  HOOKED: 'hooked', FLEE: 'flee', HUNT: 'hunt', REST: 'rest', DEAD: 'dead',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** Metres: a species whose depth band sits below this counts as deep water. */
const DEEP_BAND = 25;

/** One live fish. Pooled — `reset()` re-arms an instance for a new species. */
class Fish {
  constructor(id) {
    this.id = id;
    this.active = false;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.matrixAutoUpdate = false;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = new THREE.Vector3(1, 0, 0);
    this.wander = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.state = FISH_STATE.ROAM;
    this.stateTime = 0;
    this.species = null;
    this.instance = null;
    this.meshKey = '';
    this.lod = 0;
    this.school = null;
    this.homeDepth = 4;
    this.tailPhase = Math.random() * TAU;
    this.spooked = 0;
    this.interest = 0;
    this.baitRef = null;
    this.scale = 1;
    this.energy = 1;
    this.updateTier = 0;
    this._accum = 0;
  }
}

export class FishSystem {
  constructor(game) {
    this.game = game;
    this.name = 'fish';
    this.order = 40;
    /** @type {Fish[]} */
    this.pool = [];
    /** @type {Fish[]} */
    this.active = [];
    this.maxFish = 120;
    this.spawnRadius = 62;
    this.despawnRadius = 105;
    this.schools = [];
    this.meshCache = new Map();
    this.rng = makeRNG(20260901);
    this._spawnTimer = 0;
    this._tierTimer = 0;
    this.FishMesh = FishMeshMod.buildFishMesh ? FishMeshMod : null;
    this.densityMult = 1;
    this.luckMult = 1;
    this.rareMult = 1;
    /** Sampled from the event system once per update — see update(). */
    this._danger = 1;
    this._deepBonus = 1;
    this.totalSpawned = 0;
    this.enabled = true;
    this.debugDraw = false;
  }

  async init(game) {

    this.root = new THREE.Group();
    this.root.name = 'fish';
    game.scene.add(this.root);

    this.maxFish = game.settings.maxFish ?? 120;
    for (let i = 0; i < this.maxFish; i++) {
      const f = new Fish(i);
      this.root.add(f.group);
      this.pool.push(f);
    }

    bus.on('quality:changed', (q) => {
      this.densityMult = q === 'high' ? 1 : q === 'medium' ? 0.7 : 0.45;
    });
    bus.on('fish:spawnAt', (o) => this.spawnSpecific(o));
    bus.on('fish:scare', (o) => this.scare(o.position, o.radius ?? 8, o.strength ?? 1));
    return this;
  }

  // ------------------------------------------------------------- spawning
  freeFish() { return this.pool.find((f) => !f.active) || null; }

  /** Pick a species appropriate for the region + depth + time + weather. */
  pickSpecies(region, depth, rng = this.rng) {
    const sky = this.game.get('sky');
    const weather = this.game.get('weather');
    const isNight = sky ? sky.isNight : false;
    const tod = sky ? sky.timeOfDay : 0.5;
    const dawn = tod > 0.2 && tod < 0.32;
    const dusk = tod > 0.68 && tod < 0.82;
    const wx = weather?.current?.id || 'clear';

    const pool = speciesInRegion(region.id);
    const candidates = [];
    for (const s of pool) {
      if (s.boss) continue;
      if (depth < s.depth[0] * 0.7 || depth > s.depth[1] * 1.5) continue;
      let w = spawnWeightIn(s, region.id);
      if (s.time !== 'any') {
        if (s.time === 'night' && !isNight) w *= 0.12;
        if (s.time === 'day' && isNight) w *= 0.12;
        if (s.time === 'dawn') w *= dawn ? 2.4 : 0.3;
        if (s.time === 'dusk') w *= dusk ? 2.4 : 0.3;
      }
      if (s.weather !== 'any') w *= (s.weather === wx) ? 2.2 : 0.25;
      // Sharpen the depth preference so species stay in their band.
      const mid = (s.depth[0] + s.depth[1]) / 2;
      const span = Math.max(1.5, (s.depth[1] - s.depth[0]) / 2);
      w *= Math.exp(-Math.pow((depth - mid) / (span * 1.35), 2));
      // A deep-water event favours the residents of the deep over whatever
      // else happens to overlap the sampled depth — the whole point of the
      // abyssal anomaly is *what* comes up, not how much of it.
      if (mid > DEEP_BAND) w *= this._deepBonus;
      if (w > 0.01) candidates.push({ s, weight: w });
    }
    if (!candidates.length) return null;
    return weightedPick(candidates, rng)?.s || null;
  }

  spawnAround(cx, cz, count) {
    const world = this.game.get('world');
    const ocean = this.game.get('ocean');
    let spawned = 0;
    for (let i = 0; i < count * 4 && spawned < count; i++) {
      const a = this.rng() * TAU;
      const r = lerp(14, this.spawnRadius, Math.sqrt(this.rng()));
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const bed = worldHeight(x, z);
      const surf = ocean ? ocean.heightAt(x, z) : 0;
      const waterDepth = surf - bed;
      if (waterDepth < 1.1) continue;
      const region = regionAt(x, z) || REGION_BY_ID.crash;
      // Bias toward mid-water; keep clear of surface and seabed.
      // `events.deepBonus` flattens the exponent instead of weighting species:
      // the depth is drawn *before* the species is picked, so weighting deep
      // species alone can never fire when the draw never reaches their band.
      const d = lerp(0.9, Math.min(waterDepth - 0.5, 140), Math.pow(this.rng(), 1.5 / this._deepBonus));
      const species = this.pickSpecies(region, d, this.rng);
      if (!species) continue;
      const f = this.spawn(species, x, surf - d, z);
      if (f) spawned++;
      // Schooling species arrive as a group.
      if (f && species.spawnWeight > 90 && species.weight[1] < 8 && rchance(0.5)) {
        const schoolSize = rint(3, 9);
        const school = { center: new THREE.Vector3(x, surf - d, z), members: [f], species };
        f.school = school;
        for (let k = 0; k < schoolSize; k++) {
          const nf = this.spawn(species,
            x + rrange(-4, 4), clamp(surf - d + rrange(-1.4, 1.4), bed + 0.6, surf - 0.5), z + rrange(-4, 4));
          if (nf) { nf.school = school; school.members.push(nf); spawned++; }
        }
        this.schools.push(school);
      }
    }
    return spawned;
  }

  spawn(species, x, y, z, opts = {}) {
    const f = this.freeFish();
    if (!f) return null;
    const inst = opts.instance || rollFishInstance(species, this.rng, {
      luck: this.luckMult, rareMult: this.rareMult,
    });
    f.active = true;
    f.species = species;
    f.instance = inst;
    f.position.set(x, y, z);
    f.velocity.set(rrange(-0.5, 0.5), 0, rrange(-0.5, 0.5));
    f.heading.copy(f.velocity).normalize();
    if (f.heading.lengthSq() < 0.01) f.heading.set(1, 0, 0);
    f.state = FISH_STATE.ROAM;
    f.stateTime = 0;
    f.homeDepth = -y;
    f.spooked = 0;
    f.interest = 0;
    f.baitRef = null;
    f.school = null;
    f.energy = 1;
    f.scale = inst.length;
    f.tailPhase = Math.random() * TAU;
    f.lod = 0;
    this.attachMesh(f, 0);
    f.group.visible = true;
    f.group.position.copy(f.position);
    f.group.scale.setScalar(f.scale);
    f.group.updateMatrix();
    this.active.push(f);
    this.totalSpawned++;
    return f;
  }

  spawnSpecific({ speciesId, variantId, x, y, z, count = 1 }) {
    const sp = getSpecies(speciesId);
    if (!sp) { console.warn('[Fish] unknown species', speciesId); return []; }
    const out = [];
    const p = this.game.get('player');
    const ocean = this.game.get('ocean');
    for (let i = 0; i < count; i++) {
      let px = x, py = y, pz = z;
      if (px == null) {
        const a = this.rng() * TAU, r = rrange(9, 22);
        px = p.position.x + Math.cos(a) * r;
        pz = p.position.z + Math.sin(a) * r;
        const bed = worldHeight(px, pz);
        const surf = ocean ? ocean.heightAt(px, pz) : 0;
        py = clamp(surf - Math.min(4, (surf - bed) * 0.5), bed + 0.6, surf - 0.6);
      }
      const inst = rollFishInstance(sp, this.rng, { forceVariant: variantId, luck: this.luckMult });
      if (variantId && VARIANT_BY_ID[variantId] && inst.variantId !== variantId) {
        // Force the variant even if the roller ignored the hint.
        const vv = VARIANT_BY_ID[variantId];
        inst.variantId = variantId;
        inst.name = `${vv.name} ${sp.name}`.trim();
      }
      const f = this.spawn(sp, px, py, pz, { instance: inst });
      if (f) out.push(f);
    }
    return out;
  }

  despawn(f) {
    if (!f.active) return;
    f.active = false;
    f.group.visible = false;
    f.species = null;
    f.instance = null;
    f.baitRef = null;
    if (f.school) {
      const i = f.school.members.indexOf(f);
      if (i >= 0) f.school.members.splice(i, 1);
      f.school = null;
    }
    const i = this.active.indexOf(f);
    if (i >= 0) this.active.splice(i, 1);
  }

  despawnAll() { for (const f of [...this.active]) this.despawn(f); this.schools.length = 0; }

  // ------------------------------------------------------------- meshes
  meshKeyFor(species, variantId, lod = 0) { return `${species.body}:${species.id}:${variantId}:${lod}`; }

  attachMesh(f, lod = 0) {
    const key = this.meshKeyFor(f.species, f.instance.variantId, lod);
    if (f.meshKey === key && f.group.children.length) return;
    // Detach the previous mesh back to the cache.
    if (f.mesh) { f.group.remove(f.mesh); this._release(f.meshKey, f.mesh); f.mesh = null; }
    f.meshKey = key;
    f.lod = lod;
    f.mesh = this._acquire(key, f.species, f.instance, lod);
    f.group.add(f.mesh);
  }

  _acquire(key, species, instance, lod = 0) {
    let bucket = this.meshCache.get(key);
    if (!bucket) { bucket = []; this.meshCache.set(key, bucket); }
    if (bucket.length) return bucket.pop();
    return this.buildMesh(species, instance, lod);
  }
  _release(key, mesh) {
    if (!key || !mesh) return;
    let bucket = this.meshCache.get(key);
    if (!bucket) { bucket = []; this.meshCache.set(key, bucket); }
    if (bucket.length < 8) bucket.push(mesh);
    else disposeDeep(mesh);
  }

  buildMesh(species, instance, lod = 0) {
    const variant = VARIANT_BY_ID[instance.variantId] || VARIANT_BY_ID.normal;
    if (this.FishMesh?.buildFishMesh) {
      try {
        if (lod > 0 && this.FishMesh.buildFishLOD) {
          const pair = this.FishMesh.buildFishLOD(species, variant, { rarity: instance.rarity });
          if (pair?.low) return pair.low;
        }
        const g = this.FishMesh.buildFishMesh(species, variant, { rarity: instance.rarity });
        if (g) return g;
      } catch (e) { console.error('[Fish] buildFishMesh failed for', species.id, e); }
    }
    return buildFallbackFish(species, variant);
  }

  // ------------------------------------------------------------- update
  update(dt, game) {
    if (!this.enabled || dt <= 0) return;
    const player = game.get('player');
    if (!player) return;
    const px = player.position.x, pz = player.position.z;
    const ocean = game.get('ocean');
    const region = regionAt(px, pz);

    // World events reach this system two ways: `densityMult`/`luckMult`/
    // `rareMult` are written directly by `ev.mult('fish', …)`, while these two
    // live on the event system and have to be read. Sampled once per frame so
    // the per-fish AI below never touches the system registry, and clamped
    // because several events stack multiplicatively.
    const events = game.get('events');
    this._danger = events ? clamp(events.dangerMult || 1, 0.25, 4) : 1;
    this._deepBonus = events ? clamp(events.deepBonus || 1, 0.25, 4) : 1;

    // ---- population control ----
    this._spawnTimer -= dt;
    if (this._spawnTimer <= 0) {
      this._spawnTimer = 0.5;
      const target = Math.round((region?.maxFish ?? 26) * this.densityMult * (game.settings.maxFish / 140));
      if (this.active.length < target) {
        this.spawnAround(px, pz, Math.min(6, target - this.active.length));
      }
    }

    // ---- despawn far fish ----
    const dr2 = this.despawnRadius * this.despawnRadius;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      if (f.state === FISH_STATE.HOOKED) continue;
      if (dist2DSq(f.position.x, f.position.z, px, pz) > dr2) this.despawn(f);
    }

    // ---- schools ----
    for (let i = this.schools.length - 1; i >= 0; i--) {
      const s = this.schools[i];
      if (s.members.length < 2) { this.schools.splice(i, 1); continue; }
      _v.set(0, 0, 0);
      for (const m of s.members) _v.add(m.position);
      s.center.copy(_v.divideScalar(s.members.length));
    }

    // ---- per-fish AI, tiered by distance ----
    this._tierTimer += dt;
    const fishing = game.get('fishing');
    const bait = fishing?.activeBait || null;

    for (let i = 0; i < this.active.length; i++) {
      const f = this.active[i];
      const d2 = dist2DSq(f.position.x, f.position.z, px, pz);
      // Tier 0: <22 m full rate. Tier 1: <55 m at ~15 Hz. Tier 2: beyond, ~5 Hz.
      const tier = d2 < 484 ? 0 : d2 < 3025 ? 1 : 2;
      f.updateTier = tier;
      let step = dt;
      if (tier > 0) {
        f._accum += dt;
        const period = tier === 1 ? 1 / 15 : 1 / 5;
        if (f._accum < period) { this.applyTransform(f, dt, tier); continue; }
        step = f._accum;
        f._accum = 0;
      }
      this.updateFish(f, step, game, bait, ocean);
      this.applyTransform(f, step, tier);
    }
  }

  updateFish(f, dt, game, bait, ocean) {
    f.stateTime += dt;
    const sp = f.species;
    const surf = ocean ? ocean.heightAt(f.position.x, f.position.z) : 0;
    const bed = worldHeight(f.position.x, f.position.z);
    const player = game.get('player');

    if (f.state === FISH_STATE.HOOKED) { this.keepInWater(f, surf, bed); return; }

    f.spooked = Math.max(0, f.spooked - dt * 0.45);

    // ---- bait attraction ----
    // `events.dangerMult` is the ocean's threat level (a storm front, a boss
    // circling). It rides the *aggression* terms rather than the spawn table
    // because both of those events describe an ocean where things are up and
    // feeding — a dangerous sea should feel different to fish in, not merely
    // have more fish in it.
    if (bait && bait.inWater && f.state !== FISH_STATE.NIBBLE) {
      const bd2 = f.position.distanceToSquared(bait.position);
      const senseRange = lerp(9, 26, sp.aggression) * (bait.attractMult ?? 1) * this._danger;
      if (bd2 < senseRange * senseRange && f.spooked < 0.5) {
        const eagerness = sp.aggression * this._danger * (bait.attractMult ?? 1) * (bait.speciesBias?.[sp.id] ?? 1);
        f.interest = clamp01(f.interest + dt * eagerness * 0.9);
        if (f.interest > 0.32 && f.state !== FISH_STATE.INTERESTED) {
          f.state = FISH_STATE.INTERESTED; f.stateTime = 0; f.baitRef = bait;
        }
      } else if (f.state === FISH_STATE.INTERESTED) {
        f.interest = Math.max(0, f.interest - dt * 0.5);
        if (f.interest <= 0.05) { f.state = FISH_STATE.ROAM; f.baitRef = null; }
      }
    } else if (f.state === FISH_STATE.INTERESTED && (!bait || !bait.inWater)) {
      f.state = FISH_STATE.ROAM; f.baitRef = null; f.interest = 0;
    }

    // ---- player proximity spook ----
    if (player && !player.underwater) {
      // Surface fish get nervous when you thrash about right on top of them.
      const pd2 = dist2DSq(f.position.x, f.position.z, player.position.x, player.position.z);
      if (pd2 < 9 && player.velocity.lengthSq() > 24) f.spooked = Math.max(f.spooked, 0.8);
    }

    const speed = lerp(0.9, 6.2, sp.speed) * (f.state === FISH_STATE.FLEE ? 2.1 : 1)
      * (f.state === FISH_STATE.INTERESTED ? 1.35 : 1) * f.energy;

    _v3.set(0, 0, 0);   // accumulated steering

    switch (f.state) {
      case FISH_STATE.INTERESTED: {
        const b = f.baitRef;
        if (!b || !b.inWater) { f.state = FISH_STATE.ROAM; break; }
        _v.copy(b.position).sub(f.position);
        const d = _v.length();
        if (d < 0.55 + f.scale * 0.4) {
          // Close enough to commit.
          const biteChance = clamp01(sp.aggression * 0.9 * this._danger + f.interest * 0.5 - f.spooked);
          if (this.rng() < biteChance) {
            f.state = FISH_STATE.NIBBLE; f.stateTime = 0;
            bus.emit('fish:nibble', { fish: f, bait: b });
          } else {
            f.state = FISH_STATE.ROAM; f.interest = 0; f.spooked = 0.6;
          }
        } else {
          _v3.addScaledVector(_v.normalize(), 1.9);
          // Cautious circling as it closes in.
          _v2.crossVectors(_v, UP).normalize();
          _v3.addScaledVector(_v2, Math.sin(f.stateTime * 2.1) * 0.55 * (1 - sp.aggression));
        }
        break;
      }
      case FISH_STATE.NIBBLE: {
        const b = f.baitRef;
        if (!b || !b.inWater) { f.state = FISH_STATE.ROAM; break; }
        _v.copy(b.position).sub(f.position);
        _v3.addScaledVector(_v, 2.4);
        // Tugging jitter so the bobber visibly twitches.
        _v3.x += Math.sin(f.stateTime * 22) * 0.9;
        _v3.z += Math.cos(f.stateTime * 19) * 0.9;
        if (f.stateTime > lerp(2.6, 0.7, sp.aggression)) {
          // Gave up: didn't get hooked in time.
          f.state = FISH_STATE.ROAM; f.interest = 0; f.spooked = 1.2; f.baitRef = null;
          bus.emit('fish:nibbleEnd', { fish: f });
        }
        break;
      }
      case FISH_STATE.FLEE: {
        _v3.copy(f.heading).multiplyScalar(2.2);
        if (f.stateTime > rrange(1.6, 3.4)) { f.state = FISH_STATE.ROAM; f.stateTime = 0; }
        break;
      }
      default: {
        // ---- roam + school ----
        f.wander.x += rrange(-1, 1) * dt * 2.6;
        f.wander.y += rrange(-1, 1) * dt * 1.1;
        f.wander.z += rrange(-1, 1) * dt * 2.6;
        f.wander.clampLength(0, 1);
        _v3.addScaledVector(f.wander, 1.0);
        _v3.addScaledVector(f.heading, 0.8);

        if (f.school && f.school.members.length > 1) {
          // Cohesion toward the school centre.
          _v.copy(f.school.center).sub(f.position);
          const cd = _v.length();
          if (cd > 2.5) _v3.addScaledVector(_v.normalize(), clamp(cd * 0.18, 0, 1.6));
          // Separation from the nearest few neighbours.
          let sepCount = 0;
          for (const m of f.school.members) {
            if (m === f || sepCount > 4) continue;
            _v2.copy(f.position).sub(m.position);
            const dd = _v2.lengthSq();
            if (dd < 2.4 && dd > 1e-5) { _v3.addScaledVector(_v2.normalize(), 1.5 / Math.max(0.4, Math.sqrt(dd))); sepCount++; }
          }
          // Alignment.
          if (f.school.members[0] !== f) _v3.addScaledVector(f.school.members[0].heading, 0.5);
        }
        break;
      }
    }

    // ---- depth preference ----
    const wantDepth = clamp(lerp(sp.depth[0], sp.depth[1], 0.35 + Math.sin(f.stateTime * 0.21 + f.id) * 0.28), 0.6, Math.max(1, surf - bed - 0.5));
    const curDepth = surf - f.position.y;
    _v3.y += clamp((curDepth - wantDepth) * 0.22, -1.1, 1.1);

    // ---- boundaries: never breach the surface or clip the seabed ----
    if (f.position.y > surf - 0.35) _v3.y -= 2.6;
    if (f.position.y < bed + 0.5) _v3.y += 3.2;
    // Steer away from rising terrain ahead.
    _v.copy(f.heading).multiplyScalar(2.5 + f.scale);
    const aheadBed = worldHeight(f.position.x + _v.x, f.position.z + _v.z);
    if (aheadBed > f.position.y - 0.6) {
      _v2.set(-f.heading.z, 0, f.heading.x).multiplyScalar(2.0);
      _v3.add(_v2);
      _v3.y += 1.4;
    }
    // Stay in water horizontally.
    if (worldHeight(f.position.x, f.position.z) > surf - 0.4) {
      _v.set(f.position.x, 0, f.position.z);
      const rgn = regionAt(f.position.x, f.position.z);
      if (rgn) {
        _v2.set(f.position.x - rgn.x, 0, f.position.z - rgn.z).normalize();
        _v3.addScaledVector(_v2, 4.0);
      }
    }

    if (_v3.lengthSq() < 1e-6) _v3.copy(f.heading);
    _v3.normalize().multiplyScalar(speed);
    f.velocity.lerp(_v3, 1 - Math.pow(0.0009, dt));
    f.position.addScaledVector(f.velocity, dt);
    this.keepInWater(f, surf, bed);

    if (f.velocity.lengthSq() > 0.02) {
      f.heading.lerp(_v.copy(f.velocity).normalize(), 1 - Math.pow(0.0001, dt)).normalize();
    }
    f.energy = clamp(f.energy + dt * 0.05, 0.55, 1);
  }

  keepInWater(f, surf, bed) {
    if (f.position.y > surf - 0.18) { f.position.y = surf - 0.18; if (f.velocity.y > 0) f.velocity.y *= -0.3; }
    if (f.position.y < bed + 0.28) { f.position.y = bed + 0.28; if (f.velocity.y < 0) f.velocity.y *= -0.3; }
  }

  applyTransform(f, dt, tier) {
    const g = f.group;
    g.position.copy(f.position);
    // Face heading; fish meshes are built with +X forward.
    _v.copy(f.heading);
    if (_v.lengthSq() > 1e-6) {
      _m.lookAt(_v3.set(0, 0, 0), _v.clone().negate(), UP);
      _q.setFromRotationMatrix(_m);
      // lookAt gives -Z forward; rotate so +X is forward.
      _q.multiply(_qFix);
      g.quaternion.slerp(_q, 1 - Math.pow(0.0005, dt));
    }
    // Body roll into turns.
    const turn = _v.copy(f.velocity).normalize().cross(f.heading).y;
    g.rotateX(clamp(turn * 1.6, -0.5, 0.5) * 0.6);

    // Tail wave.
    const speedN = clamp01(f.velocity.length() / 4);
    f.tailPhase += dt * (5 + speedN * 12);
    if (tier === 0 && f.mesh?.userData?.deform) {
      try { f.mesh.userData.deform(f.tailPhase, 0.5 + speedN * 0.9, 1.6); } catch { /* mesh may not support it */ }
    } else if (f.mesh?.userData?.parts?.tail) {
      f.mesh.userData.parts.tail.rotation.y = Math.sin(f.tailPhase) * (0.28 + speedN * 0.45);
    }
    g.updateMatrix();

    // LOD / culling. Detailed fish are ~12 draw calls each; swap to the cheap
    // silhouette past 26 m and hide entirely past 78 m.
    const cam = this.game.camera;
    const dist = g.position.distanceTo(cam.position);
    const vis = dist < 78;
    if (g.visible !== vis) g.visible = vis;
    if (vis) {
      const wantLod = dist > 26 ? 1 : 0;
      if (wantLod !== f.lod) {
        // Hysteresis: only swap when clearly past the boundary.
        if ((wantLod === 1 && dist > 30) || (wantLod === 0 && dist < 23)) this.attachMesh(f, wantLod);
      }
    }
  }

  scare(position, radius, strength) {
    const r2 = radius * radius;
    for (const f of this.active) {
      if (f.state === FISH_STATE.HOOKED) continue;
      const d2 = f.position.distanceToSquared(position);
      if (d2 > r2) continue;
      f.spooked = Math.max(f.spooked, strength * (1 - Math.sqrt(d2) / radius));
      if (f.spooked > 0.4) {
        f.state = FISH_STATE.FLEE; f.stateTime = 0; f.interest = 0; f.baitRef = null;
        _v.copy(f.position).sub(position).setY(rrange(-0.2, 0.4));
        if (_v.lengthSq() < 1e-4) _v.set(rrange(-1, 1), 0, rrange(-1, 1));
        f.heading.copy(_v.normalize());
      }
    }
  }

  /** Nearest fish currently nibbling this bait, if any. */
  nibblingFish(bait) {
    for (const f of this.active) if (f.state === FISH_STATE.NIBBLE && f.baitRef === bait) return f;
    return null;
  }

  countNear(position, radius) {
    let n = 0; const r2 = radius * radius;
    for (const f of this.active) if (f.position.distanceToSquared(position) < r2) n++;
    return n;
  }

  /** Sonar / scanner data for nearby fish. */
  sonarContacts(position, radius, detail = 1) {
    const out = []; const r2 = radius * radius;
    for (const f of this.active) {
      const d2 = f.position.distanceToSquared(position);
      if (d2 > r2) continue;
      const c = { x: f.position.x, y: f.position.y, z: f.position.z, dist: Math.sqrt(d2) };
      if (detail >= 2) c.depth = f.position.y;
      if (detail >= 3) c.size = f.instance.weight;
      if (detail >= 4) c.species = f.species.name;
      if (detail >= 5) c.variant = f.instance.variantId;
      c.rarity = detail >= 3 ? f.instance.rarity : null;
      out.push(c);
    }
    return out;
  }

  save() { return { totalSpawned: this.totalSpawned }; }
  load(d) { if (d) this.totalSpawned = d.totalSpawned || 0; }
}

const _qFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

// --------------------------------------------------------------------------
// Fallback mesh — used until the dedicated FishMesh module is available.
// --------------------------------------------------------------------------
const _fallbackGeoCache = new Map();
function fallbackGeo(body) {
  if (_fallbackGeoCache.has(body)) return _fallbackGeoCache.get(body);
  const g = new THREE.SphereGeometry(0.5, 10, 7);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Stretch along X (forward), squash laterally, taper toward the tail.
    const t = (x + 0.5);
    const taper = 0.35 + Math.sin(t * Math.PI) * 0.85;
    pos.setX(i, x * 2.1);
    pos.setY(i, y * taper * 1.15);
    pos.setZ(i, z * taper * 0.55);
  }
  g.computeVertexNormals();
  g.scale(0.42, 0.42, 0.42);
  _fallbackGeoCache.set(body, g);
  return g;
}

export function buildFallbackFish(species, variant) {
  const group = new THREE.Group();
  const main = new THREE.Color(variant?.tint || species.colors.main);
  const fin = new THREE.Color(variant?.tint || species.colors.fin);
  const glow = (species.glow || 0) + (variant?.glow || 0);
  const mat = new THREE.MeshStandardMaterial({
    color: main, roughness: 0.55, metalness: 0.1,
    emissive: glow > 0.01 ? main : 0x000000, emissiveIntensity: glow * 1.6,
  });
  const body = new THREE.Mesh(fallbackGeo(species.body), mat);
  group.add(body);

  const tailGeo = new THREE.ConeGeometry(0.22, 0.34, 4);
  tailGeo.rotateZ(Math.PI / 2);
  tailGeo.scale(1, 1.5, 0.35);
  tailGeo.translate(-0.17, 0, 0);
  const tail = new THREE.Mesh(tailGeo, new THREE.MeshStandardMaterial({
    color: fin, roughness: 0.6, side: THREE.DoubleSide,
    emissive: glow > 0.01 ? fin : 0x000000, emissiveIntensity: glow,
  }));
  tail.position.x = -0.44;
  group.add(tail);

  const eyeGeo = new THREE.SphereGeometry(0.045, 6, 5);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(0.33, 0.06, s * 0.1);
    group.add(e);
  }
  group.userData.parts = { body, tail };
  group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return group;
}

function disposeDeep(o) {
  o.traverse?.((c) => { if (c.isMesh) { c.geometry?.dispose(); c.material?.dispose?.(); } });
}
