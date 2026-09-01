/**
 * BossSystem — the six named bosses.
 *
 * A boss is a real entry in `FishSystem.active` (same duck-type as a `Fish`)
 * so every system that already knows how to hurt, hook or fight a fish keeps
 * working unmodified:
 *
 *   · WeaponSystem writes `fish.hp`  -> intercepted by an accessor here, so
 *     boss HP, weak points and armour are applied without touching that file.
 *   · FishingSystem can hook it      -> the existing fight solver runs, and a
 *     6400 kg fish snaps a weak line all by itself.
 *   · FishSystem leaves it alone     -> this system owns the transform, and
 *     runs at order 48 (after fish AI, before fishing/weapons).
 *
 * Everything else — phases, telegraphs, attacks, the health bar, death — is
 * driven from `species.bossData`.
 */

import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { getSpecies, BOSS_IDS, rollFishInstance, RARITY, VARIANT_BY_ID } from '../data/fishData.js';
import { REGION_BY_ID, regionAt } from '../data/regions.js';
import { FISH_STATE } from './FishSystem.js';
import { buildBossMesh, disposeBossMesh, BOSS_LENGTH, darkenWeakPoint, relightWeakPoint } from './BossMesh.js';
import { waterHeightAt } from '../world/waves.js';
import { worldHeight } from '../world/Terrain.js';
import {
  clamp, clamp01, lerp, damp, rrange, rint, rpick, rchance, TAU, dist2D,
} from '../util/math.js';

/** Sentinel HP handed to WeaponSystem so it never reaches its own kill path. */
const HP_SENTINEL = 1e9;

/**
 * Incoming damage multiplier per boss, chosen so the tier-appropriate weapon
 * needs ~95-100 s of pure body damage. Weak-point crits and armour phases move
 * a real fight into the 60-120 s window.
 *
 *   dock-eater      spear            45 x 0.6/s  =   27 dps
 *   king-crab-boss  harpoon         120 x 0.45/s =   54 dps
 *   the-hammer      harpoon gun     3x320 / 3.4s =  281 dps
 *   stormfin        heavy harpoon   2x1400/ 4.4s =  636 dps
 *   frostjaw        heavy harpoon                =  636 dps
 *   abyss-mouth     experimental    4x9000/ 3.9s = 9300 dps
 */
const DAMAGE_SCALE = {
  'dock-eater': 0.34,
  'king-crab-boss': 0.30,
  'the-hammer': 0.115,
  'stormfin': 0.100,
  'frostjaw': 0.170,
  'abyss-mouth': 0.048,
};

/** Weak point crit multiplier. */
const WEAK_POINT_MULT = 4;
/** Fraction of max HP a single weak point absorbs before it breaks. */
const WEAK_POINT_HP = 0.055;
/** Armour damage reduction while unbroken weak points remain. */
const ARMOR_REDUCTION = 0.2;

/** Ambient spawn conditions. `null` weather/time = anything goes. */
const SPAWN_CONDITIONS = {
  'dock-eater': { time: 'night', weather: null, chance: 0.16 },
  'king-crab-boss': { time: null, weather: 'fog', chance: 0.16 },
  'the-hammer': { time: null, weather: null, chance: 0.10 },
  'stormfin': { time: null, weather: 'storm', chance: 0.22 },
  'frostjaw': { time: null, weather: 'fog', chance: 0.18 },
  'abyss-mouth': { time: null, weather: null, chance: 0.12 },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const _qFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

let _entryId = 90000;

export class BossSystem {
  constructor(game) {
    this.game = game;
    this.name = 'boss';
    this.order = 48;

    /** @type {object|null} the one live boss */
    this.boss = null;
    /** @type {Set<string>} */
    this.defeated = new Set();
    /** Per-boss cooldown before it may ambient-spawn again. */
    this.cooldown = new Map();

    this._ambientTimer = 20;
    this._pendingDamage = [];
    this._offs = [];
    this.enabled = true;
    this.debugLog = false;
  }

  // =========================================================== lifecycle
  async init(game) {
    this._buildBar();

    this._offs.push(bus.on('boss:spawn', (o) => {
      // MusicDirector counts `boss:spawn` as well as `boss:spawned`; remember
      // that so the ref-count balances when the fight ends.
      this.spawn(o?.id, { fromEvent: true, ...(o || {}) });
    }));
    // WeaponSystem emits exactly one hit marker per fish hit, immediately
    // after writing `fish.hp` — that is how a damage event gets a location.
    this._offs.push(bus.on('fx:hitMarker', (p) => {
      const q = this._pendingDamage[this._pendingDamage.length - 1];
      if (q && !q.point && p) {
        const pos = p.position || p;
        if (pos && pos.x !== undefined) q.point = new THREE.Vector3(pos.x, pos.y, pos.z);
      }
    }));
    this._offs.push(bus.on('player:down', () => { if (this.boss) this.boss.playerDownT = 0; }));
    this._offs.push(bus.on('fishing:hooked', ({ fish }) => {
      if (this.boss && fish === this.boss.fish) this._onHooked();
    }));
    this._offs.push(bus.on('game:newgame', () => { this.defeated.clear(); this.despawn('reset'); }));
    return this;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this.despawn('dispose');
    this.barEl?.remove();
  }

  // =========================================================== public API
  /** Ids of every boss the player has beaten. */
  get defeatedIds() { return [...this.defeated]; }
  isDefeated(id) { return this.defeated.has(id); }
  get active() { return this.boss; }

  /**
   * Summon a boss. Only one may be alive at a time.
   * @param {string} id one of BOSS_IDS
   */
  spawn(id, opts = {}) {
    if (!id || !BOSS_IDS.includes(id)) {
      console.warn('[Boss] unknown boss id', id);
      return null;
    }
    if (this.boss) {
      bus.emit('toast', { text: `${this.boss.species.name} is already here.`, kind: 'warn' });
      return null;
    }
    const game = this.game;
    const species = getSpecies(id);
    const bd = species?.bossData;
    if (!bd) { console.warn('[Boss] species has no bossData', id); return null; }

    const fishSys = game.get('fish');
    const player = game.get('player');
    if (!fishSys || !player) { console.warn('[Boss] fish/player system missing'); return null; }

    // ---- instance: real species roll, then forced to boss dimensions ----
    const instance = rollFishInstance(species, Math.random, { sizeBias: 1 }) || {
      speciesId: id, variantId: 'normal', weight: species.weight[1],
      length: species.length[1], value: species.value, rarity: species.rarity,
      name: species.name, colors: { ...species.colors },
    };
    instance.name = species.name;
    instance.length = BOSS_LENGTH[id] ?? species.length[1];
    instance.weight = species.weight[1];

    // ---- mesh -----------------------------------------------------------
    let mesh = null;
    try { mesh = buildBossMesh(species); }
    catch (e) { console.error('[Boss] mesh build failed', id, e); return null; }

    // ---- where does it come up? ----------------------------------------
    const pos = this._spawnPoint(player, instance.length);

    // ---- fish-compatible entry -----------------------------------------
    const fish = this._makeFishEntry(species, instance, mesh, pos, fishSys);

    const phases = (bd.phases || []).slice().sort((a, b) => b.hpPct - a.hpPct);
    const wps = mesh.userData.weakPoints || [];
    for (const w of wps) { w.maxHp = bd.hp * WEAK_POINT_HP; w.hp = w.maxHp; w.broken = false; }

    this.boss = {
      id, species, bd, instance, fish, mesh,
      hp: bd.hp, maxHp: bd.hp,
      phases, phaseIndex: -1, phase: null,
      weakPoints: wps,
      armor: false,
      mechanics: [],
      state: 'intro', stateT: 0,
      mode: 'idle',
      attackTimer: rrange(bd.attackInterval[0], bd.attackInterval[1]) + 2.5,
      attack: null, attackT: 0, windup: 0,
      target: new THREE.Vector3(),
      ramFrom: new THREE.Vector3(),
      mouth: 0, aggro: 0, hurt: 0,
      fightTime: 0, damageDealt: 0,
      graceT: 0, playerDownT: 99,
      submergedT: 0,
      hooked: false, rodDamage: 0,
      musicRefs: 1 + (opts.fromEvent ? 1 : 0),
      adds: 0,
      dead: false,
      region: regionAt(pos.x, pos.z)?.id || null,
      _t: Math.random() * 100,
      _shakeAccum: 0,
    };

    this._enterPhase(0, true);

    // ---- announce -------------------------------------------------------
    game.audio?.play('boss_roar', { volume: 1.0, position: pos.clone() });
    bus.emit('fx:screenFlash', { color: 'rgba(255,80,60,0.32)', duration: 0.5 });
    bus.emit('fx:bigSplash', { position: new THREE.Vector3(pos.x, waterHeightAt(pos.x, pos.z), pos.z), scale: 3 });
    bus.emit('player:shake', 0.8);
    bus.emit('fx:hitStop', 0.09);
    bus.emit('toast', { text: `${species.name.toUpperCase()} SURFACES`, kind: 'error', duration: 4200 });
    bus.emit('boss:spawned', { id, species: species.id, hp: bd.hp, instance });
    this._showBar(true);
    if (this.debugLog) console.info('[Boss] spawned', id, 'at', pos.toArray().map((n) => n.toFixed(1)));
    return this.boss;
  }

  /** Remove the live boss without paying anything out. */
  despawn(reason = 'despawn') {
    const b = this.boss;
    if (!b) return;
    this.boss = null;
    this._pendingDamage.length = 0;
    this._detachFish(b, true);
    this._showBar(false);
    // Balance MusicDirector's ref-count (it counts both spawn events).
    bus.emit(reason === 'escaped' ? 'boss:escaped' : 'boss:despawned', { id: b.id, reason });
    for (let i = 1; i < b.musicRefs; i++) bus.emit('boss:despawned', { id: b.id, reason });
    if (reason !== 'dispose' && reason !== 'reset') {
      this.cooldown.set(b.id, 45);
      bus.emit('toast', { text: `${b.species.name} slips away.`, kind: 'muted' });
    }
  }

  // ====================================================== fish integration
  _spawnPoint(player, length) {
    const a = Math.random() * TAU;
    const want = clamp(10 + length * 1.3, 14, 46);
    for (let k = 0; k < 26; k++) {
      const ang = a + k * 0.6;
      const r = want + (k % 5) * 4;
      const x = player.position.x + Math.cos(ang) * r;
      const z = player.position.z + Math.sin(ang) * r;
      const surf = waterHeightAt(x, z);
      const bed = worldHeight(x, z);
      if (surf - bed > Math.max(3.5, length * 0.45 + 2)) {
        return new THREE.Vector3(x, surf - Math.min((surf - bed) * 0.45, length * 0.35 + 1.5), z);
      }
    }
    const x = player.position.x + Math.cos(a) * want;
    const z = player.position.z + Math.sin(a) * want;
    return new THREE.Vector3(x, waterHeightAt(x, z) - 2.5, z);
  }

  /** Build an object FishSystem/FishingSystem/WeaponSystem all accept. */
  _makeFishEntry(species, instance, mesh, pos, fishSys) {
    const self = this;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.add(mesh);
    group.position.copy(pos);
    group.scale.setScalar(instance.length);
    group.updateMatrix();
    fishSys.root.add(group);

    const f = {
      id: _entryId++,
      active: true,
      group,
      mesh,
      meshKey: '',
      position: pos.clone(),
      velocity: new THREE.Vector3(),
      heading: new THREE.Vector3(1, 0, 0),
      wander: new THREE.Vector3(),
      target: new THREE.Vector3(),
      state: FISH_STATE.ROAM,
      stateTime: 0,
      species,
      instance,
      lod: 0,
      school: null,
      homeDepth: Math.max(1, -pos.y),
      tailPhase: Math.random() * TAU,
      spooked: 0,
      interest: 0,
      baitRef: null,
      scale: instance.length,
      energy: 1,
      updateTier: 0,
      _accum: 0,
      knockV: new THREE.Vector3(),
      // Flags so other systems can special-case a boss if they ever want to.
      isBoss: true,
      bossId: species.id,
    };

    // ---- HP interception -------------------------------------------------
    // WeaponSystem does `fish.hp -= damage`. We keep the visible value pinned
    // at a sentinel so its own kill path never triggers, and route the delta
    // into the real boss pool (with weak points + armour) instead.
    let _hp = HP_SENTINEL;
    Object.defineProperty(f, 'hp', {
      configurable: true,
      get() { return _hp; },
      set(v) {
        if (v === null || v === undefined || !Number.isFinite(v)) return;
        const dmg = _hp - v;
        _hp = HP_SENTINEL;
        if (dmg > 0) self._pendingDamage.push({ amount: dmg, point: null });
      },
    });
    // `fishHP()` bails out early when hpFor already matches the instance.
    Object.defineProperty(f, 'hpFor', {
      configurable: true,
      get() { return f.instance; },
      set() { /* ignored — the boss owns its own HP */ },
    });

    // FishSystem swaps in a cheap LOD mesh past ~26 m. A boss must never lose
    // its mesh, so report whatever LOD the system is about to ask for.
    Object.defineProperty(f, 'lod', {
      configurable: true,
      get() {
        const cam = self.game.camera;
        if (!cam) return 0;
        return group.position.distanceTo(cam.position) > 26 ? 1 : 0;
      },
      set() { /* boss meshes never LOD-swap */ },
    });

    fishSys.active.push(f);
    return f;
  }

  _detachFish(b, disposeMesh) {
    const fishSys = this.game.get('fish');
    const f = b.fish;
    if (!f) return;
    if (this.game.get('fishing')?.hookedFish === f) {
      try { this.game.get('fishing').cancel(); } catch { /* fishing may be mid-teardown */ }
    }
    f.active = false;
    if (fishSys) {
      const i = fishSys.active.indexOf(f);
      if (i >= 0) fishSys.active.splice(i, 1);
      fishSys.root.remove(f.group);
    } else if (f.group.parent) f.group.parent.remove(f.group);
    if (disposeMesh && b.mesh) disposeBossMesh(b.mesh);
    b.fish = null;
  }

  /** Re-insert if something despawned the boss out from under us. */
  _ensureRegistered(b) {
    const fishSys = this.game.get('fish');
    if (!fishSys || !b.fish) return true;
    if (b.targetable === false) return true;      // submerged on purpose
    if (fishSys.active.includes(b.fish)) return true;
    if (b.dead) return false;
    // Something else killed it (the net path calls killFish unconditionally).
    if (!b.fish.species || !b.fish.instance) { this._die(true); return false; }
    b.fish.active = true;
    fishSys.active.push(b.fish);
    if (!b.fish.group.parent) fishSys.root.add(b.fish.group);
    return true;
  }

  // ============================================================== update
  update(dt, game) {
    if (dt <= 0 || !this.enabled) return;
    this._tickAmbient(dt, game);

    const b = this.boss;
    if (!b) return;
    if (!this._ensureRegistered(b)) return;

    b._t += dt;
    b.fightTime += dt;
    b.stateT += dt;
    b.hurt = Math.max(0, b.hurt - dt * 3.2);

    this._applyPendingDamage(b, game);
    if (!this.boss) return;                    // died inside damage handling

    this._checkPhase(b);
    this._tickFailure(dt, b, game);
    if (!this.boss) return;

    this._tickHook(dt, b, game);
    this._tickAttacks(dt, b, game);
    this._move(dt, b, game);
    this._applyTransform(dt, b, game);
    this._updateBar(b);
  }

  // ------------------------------------------------------------- ambient
  _tickAmbient(dt, game) {
    for (const [k, v] of this.cooldown) {
      const n = v - dt;
      if (n <= 0) this.cooldown.delete(k); else this.cooldown.set(k, n);
    }
    if (this.boss) return;
    this._ambientTimer -= dt;
    if (this._ambientTimer > 0) return;
    this._ambientTimer = 14;

    const player = game.get('player');
    if (!player) return;
    const region = regionAt(player.position.x, player.position.z);
    const id = region?.boss;
    if (!id || this.cooldown.has(id)) return;
    const cond = SPAWN_CONDITIONS[id] || { chance: 0.1 };

    const sky = game.get('sky');
    const weather = game.get('weather');
    if (cond.time === 'night' && sky && !sky.isNight) return;
    if (cond.weather) {
      const wx = weather?.current?.id || 'clear';
      const stormy = cond.weather === 'storm' && (wx === 'storm' || wx === 'heavy_storm');
      if (wx !== cond.weather && !stormy) return;
    }
    // Only in deep-enough water, and never right on top of the player.
    const surf = waterHeightAt(player.position.x, player.position.z);
    const bed = worldHeight(player.position.x, player.position.z);
    if (surf - bed < 3.0) return;
    let chance = cond.chance;
    if (this.defeated.has(id)) chance *= 0.35;      // rematches are rarer
    if (!rchance(chance)) return;
    this.spawn(id, { ambient: true });
  }

  // -------------------------------------------------------------- damage
  _applyPendingDamage(b, game) {
    if (!this._pendingDamage.length) return;
    const queue = this._pendingDamage.splice(0, this._pendingDamage.length);
    const scale = DAMAGE_SCALE[b.id] ?? 0.2;
    const player = game.get('player');

    for (const q of queue) {
      let dmg = q.amount * scale;
      const wp = this._weakPointHitBy(b, q.point, player);
      let crit = false;
      if (wp) {
        crit = true;
        dmg *= WEAK_POINT_MULT;
        wp.hp -= q.amount * scale * WEAK_POINT_MULT;
        if (wp.hp <= 0) this._breakWeakPoint(b, wp, game);
      }
      if (b.armor && !crit) dmg *= ARMOR_REDUCTION;
      this._damage(b, dmg, game, { crit, point: q.point });
      if (b.dead) return;
    }
  }

  /**
   * @returns {object|null} the weak point this hit landed on, if any.
   *
   * WeaponSystem's projectile sweep triggers on a sphere the size of the whole
   * animal, so its reported impact point is far too coarse to decide a crit on
   * its own. The player's aim ray is the authority — a weak point only counts
   * when they actually pointed at it — and the impact point is used as a
   * sanity check so a shot that landed on the far side cannot crit.
   */
  _weakPointHitBy(b, point, player) {
    const wps = b.weakPoints;
    if (!wps || !wps.length || !player) return null;
    const scale = b.fish?.scale || 1;
    this._refreshWeakPointWorld(b);

    const o = player.eyePosition.clone();
    const dir = player.forward(_v2).clone().normalize();
    let best = null, bestD = Infinity;
    for (const w of wps) {
      if (w.broken || !w.world) continue;
      _v3.copy(w.world).sub(o);
      const along = _v3.dot(dir);
      if (along < 0.5 || along > 320) continue;
      const perp = Math.sqrt(Math.max(0, _v3.lengthSq() - along * along));
      // Tight: roughly the visible radius of the glowing point, plus a little.
      const tol = w.radius * scale * 2.0 + 0.3;
      if (perp < tol && perp < bestD) { bestD = perp; best = w; }
    }
    if (!best) return null;
    // The shot has to have landed somewhere near it too.
    if (point && best.world.distanceTo(point) > best.radius * scale * 4 + b.instance.length * 0.25) return null;
    return best;
  }

  _refreshWeakPointWorld(b) {
    const f = b.fish;
    if (!f) return;
    f.group.updateMatrix();
    f.group.updateMatrixWorld(true);
    for (const w of b.weakPoints) {
      w.world = w.world || new THREE.Vector3();
      w.world.copy(w.localPos).applyMatrix4(f.group.matrixWorld);
    }
  }

  _breakWeakPoint(b, wp, game) {
    darkenWeakPoint(wp);
    const p = wp.world ? wp.world.clone() : b.fish.position.clone();
    bus.emit('fx:sparkle', { position: p, count: 28, color: 0xffd27a, radius: 1.8 });
    bus.emit('fx:impact', { position: p, normal: UP.clone(), kind: 'metal', scale: 2.2 });
    bus.emit('fx:hitStop', 0.05);
    bus.emit('player:shake', 0.28);
    game.audio?.play('boss_slam', { volume: 0.55, rate: 1.25, position: p });
    const left = b.weakPoints.filter((w) => !w.broken).length;
    bus.emit('fx:floatText', { position: p, text: 'WEAK POINT BROKEN', color: '#ffd27a', size: 20 });
    if (b.armor && left === 0) {
      b.armor = false;
      bus.emit('toast', { text: `${b.species.name}'s armour gives way!`, kind: 'gold', duration: 2600 });
      bus.emit('fx:screenFlash', { color: 'rgba(255,210,120,0.22)', duration: 0.3 });
      game.audio?.play('boss_roar', { volume: 0.7, rate: 1.15 });
    }
    bus.emit('boss:weakPoint', { id: b.id, remaining: left });
  }

  _damage(b, amount, game, opts = {}) {
    if (b.dead || amount <= 0) return;
    b.hp = Math.max(0, b.hp - amount);
    b.hurt = 1;
    b.aggro = clamp01(b.aggro + 0.12);
    b.damageDealt += amount;
    if (opts.point) {
      bus.emit('fx:floatText', {
        position: opts.point.clone(),
        text: opts.crit ? `${Math.round(amount)}!` : `${Math.round(amount)}`,
        color: opts.crit ? '#ffd27a' : '#ff8f6b',
        size: opts.crit ? 24 : 17,
      });
    }
    this._flashBar(opts.crit ? '#ffd27a' : '#ff6b6b');
    if (b.hp <= 0) this._die(false);
  }

  // -------------------------------------------------------------- phases
  _checkPhase(b) {
    const frac = b.hp / b.maxHp;
    let idx = 0;
    for (let i = 0; i < b.phases.length; i++) if (frac <= b.phases[i].hpPct) idx = i;
    if (idx !== b.phaseIndex) this._enterPhase.call(this, idx, false, b);
  }

  _enterPhase(idx, silent, boss = this.boss) {
    const b = boss;
    if (!b) return;
    const p = b.phases[idx];
    if (!p) return;
    b.phaseIndex = idx;
    b.phase = p;
    b.mechanics = (p.mechanics || []).slice();
    b.armor = b.mechanics.includes('armor');
    if (b.armor) {
      // A new armour phase re-arms every weak point: there is work to do again.
      for (const w of b.weakPoints) relightWeakPoint(w);
    }
    b.aggro = clamp01(0.15 + idx * 0.22);
    // Give the player a beat before the new phase's first attack.
    b.attackTimer = Math.max(b.attackTimer, 1.6);

    if (!silent) {
      const game = this.game;
      game.audio?.play('boss_roar', { volume: 0.9, rate: 0.92 + idx * 0.06 });
      bus.emit('fx:screenFlash', { color: 'rgba(255,120,80,0.24)', duration: 0.32 });
      bus.emit('player:shake', 0.45);
      bus.emit('fx:hitStop', 0.07);
      bus.emit('toast', { text: `${b.species.name}: ${p.name}`, kind: 'error', duration: 2800 });
      this._flashBar('#ffffff', 0.5);
      bus.emit('boss:phase', { id: b.id, phase: idx, name: p.name, mechanics: b.mechanics });
    }
  }

  // ------------------------------------------------------------- failure
  _tickFailure(dt, b, game) {
    const player = game.get('player');
    if (!player) return;
    b.playerDownT += dt;
    const d = dist2D(player.position.x, player.position.z, b.fish.position.x, b.fish.position.z);
    const region = regionAt(player.position.x, player.position.z);
    const leftRegion = b.region && region?.id !== b.region && d > 120;
    const playerDied = b.playerDownT < 1.5;

    if (leftRegion || playerDied || d > 190) {
      b.graceT += dt;
      if (b.graceT > (playerDied ? 4 : 8)) {
        this.despawn('escaped');
      }
    } else b.graceT = Math.max(0, b.graceT - dt * 0.5);
  }

  // ---------------------------------------------------------------- hook
  _onHooked() {
    const b = this.boss;
    if (!b) return;
    b.hooked = true;
    bus.emit('toast', { text: `You have hooked ${b.species.name}. Good luck.`, kind: 'error', duration: 3200 });
    this.game.audio?.play('boss_roar', { volume: 0.85, rate: 0.85 });
    bus.emit('player:shake', 0.7);
  }

  _tickHook(dt, b, game) {
    const fishing = game.get('fishing');
    const hooked = !!fishing && fishing.hookedFish === b.fish;
    if (hooked !== b.hooked) {
      b.hooked = hooked;
      if (!hooked) b.fish.state = FISH_STATE.ROAM;
    }
    if (!hooked) return;

    const player = game.get('player');
    // Rod damage is real but glacial: ~10 minutes to land a boss on line alone.
    this._damage(b, (b.maxHp / 620) * dt, game);
    if (b.dead) return;

    // It drags you. Hard.
    if (player) {
      _v.copy(b.fish.position).sub(player.position);
      const d = _v.length();
      if (d > 0.001) {
        _v.multiplyScalar(1 / d);
        const k = lerp(2.5, 9, clamp01(fishing.tension)) * clamp01(b.instance.weight / 900 + 0.35);
        player.velocity.addScaledVector(_v, k * dt);
        player.shake = Math.max(player.shake || 0, clamp01(fishing.tension) * 0.3);
      }
      // Never let the fight solver reel a boss into landing range.
      const minLen = Math.max(8, b.instance.length * 0.8);
      _v2.copy(b.fish.position).sub(fishing.rodTip);
      if (_v2.length() < minLen) {
        _v2.normalize().multiplyScalar(minLen);
        b.fish.position.copy(fishing.rodTip).add(_v2);
      }
    }
    // Extra strain: a boss loads the line far beyond a normal fish.
    fishing.tension = clamp01(fishing.tension + dt * 0.55);
  }

  // ------------------------------------------------------------- attacks
  _tickAttacks(dt, b, game) {
    if (b.mode === 'idle') {
      b.attackTimer -= dt;
      if (b.attackTimer <= 0) {
        const kind = this._pickAttack(b);
        if (kind) this._beginWindup(b, kind, game);
        else b.attackTimer = 2;
      }
      return;
    }

    if (b.mode === 'windup') {
      b.attackT += dt;
      if (b.attackT >= b.windup) this._strike(b, game);
      return;
    }

    if (b.mode === 'strike') {
      b.attackT += dt;
      this._updateStrike(dt, b, game);
      return;
    }

    if (b.mode === 'recover') {
      b.attackT += dt;
      if (b.attackT > 1.1) {
        b.mode = 'idle';
        b.attack = null;
        b.attackT = 0;
        const [lo, hi] = b.bd.attackInterval;
        b.attackTimer = rrange(lo, hi) * lerp(1.15, 0.75, b.aggro);
      }
    }
  }

  _pickAttack(b) {
    let pool = b.mechanics.filter((m) => m !== 'armor');
    if (b.hooked) pool = pool.filter((m) => m === 'shockwave' || m === 'summon');
    if (!pool.length) pool = b.hooked ? ['shockwave'] : ['ram'];
    // Don't repeat the same attack three times running.
    if (b.lastAttack && pool.length > 1 && b._repeat >= 2) pool = pool.filter((m) => m !== b.lastAttack);
    const pick = rpick(pool);
    b._repeat = pick === b.lastAttack ? (b._repeat || 0) + 1 : 0;
    b.lastAttack = pick;
    return pick;
  }

  /** Every attack is announced before it lands. That is the whole game. */
  _beginWindup(b, kind, game) {
    const player = game.get('player');
    b.attack = kind;
    b.mode = 'windup';
    b.attackT = 0;
    b.aggro = clamp01(b.aggro + 0.1);

    const WIND = { ram: 1.15, dive: 0.9, summon: 1.25, shockwave: 1.35 };
    b.windup = (WIND[kind] ?? 1.1) * lerp(1.15, 0.8, b.aggro);
    b.ramFrom.copy(b.fish.position);
    if (player) b.target.copy(player.position);

    const p = b.fish.position.clone();
    const label = {
      ram: 'CHARGING', dive: 'DIVING', summon: 'CALLING', shockwave: 'WINDING UP',
    }[kind] || 'ATTACKING';

    game.audio?.play(kind === 'shockwave' ? 'boss_slam' : 'boss_roar', {
      volume: 0.85, rate: kind === 'dive' ? 1.1 : 0.95, position: p,
    });
    bus.emit('fx:floatText', { position: p.clone().add(_v.set(0, b.instance.length * 0.5, 0)), text: label, color: '#ff8a5c', size: 22 });
    bus.emit('player:shake', 0.16);

    if (kind === 'shockwave') {
      bus.emit('fx:ripple', { position: new THREE.Vector3(p.x, waterHeightAt(p.x, p.z), p.z), radius: 3 });
    }
    if (kind === 'ram') {
      // Line up: back off along the approach so the charge reads as a run-up.
      if (player) {
        _v.copy(b.fish.position).sub(player.position).setY(0);
        if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
        b.ramFrom.copy(b.fish.position).addScaledVector(_v.normalize(), 4);
      }
    }
    bus.emit('boss:telegraph', { id: b.id, attack: kind, windup: b.windup });
  }

  _strike(b, game) {
    b.mode = 'strike';
    b.attackT = 0;
    const player = game.get('player');
    if (player) b.target.copy(player.position);

    switch (b.attack) {
      case 'ram': {
        game.audio?.play('boss_slam', { volume: 0.9, position: b.fish.position.clone() });
        b.ramHit = false;
        b.ramSpeed = lerp(11, 26, clamp01(b.species.speed));
        break;
      }
      case 'dive': {
        game.audio?.play('splash_big', { volume: 0.9, position: b.fish.position.clone() });
        bus.emit('fx:bigSplash', { position: this._surfaceAt(b.fish.position), scale: 2.6 });
        b.submergedT = 0;
        b.divePhase = 'down';
        this._setTargetable(b, false);
        break;
      }
      case 'summon': this._doSummon(b, game); break;
      case 'shockwave': this._doShockwave(b, game); break;
      default: break;
    }
  }

  _updateStrike(dt, b, game) {
    const player = game.get('player');
    switch (b.attack) {
      case 'ram': {
        if (b.ramHit || b.attackT > 3.2) { this._endStrike(b); return; }
        if (player) {
          const d = b.fish.position.distanceTo(player.position);
          const hitR = Math.max(3.5, b.instance.length * 0.42);
          if (d < hitR) this._ramImpact(b, game, player);
        }
        // Ramming into shallow water or a dock ends the charge just as hard.
        const bed = worldHeight(b.fish.position.x, b.fish.position.z);
        if (b.fish.position.y - bed < b.instance.length * 0.10 + 0.6) {
          this._ramImpact(b, game, player, true);
        }
        break;
      }
      case 'dive': {
        b.submergedT += dt;
        if (b.divePhase === 'down' && b.submergedT > 1.0) b.divePhase = 'under';
        if (b.divePhase === 'under' && b.submergedT > rrange(3.2, 4.4)) {
          b.divePhase = 'erupt';
          b.submergedT = 0;
          this._setTargetable(b, true);
          if (player) {
            const px = player.position.x, pz = player.position.z;
            const bed = worldHeight(px, pz);
            const surf = waterHeightAt(px, pz);
            b.fish.position.set(px, Math.max(bed + 1.2, surf - b.instance.length * 0.7), pz);
          }
          game.audio?.play('boss_roar', { volume: 1.0, position: b.fish.position.clone() });
        }
        if (b.divePhase === 'erupt') {
          const surf = waterHeightAt(b.fish.position.x, b.fish.position.z);
          if (b.fish.position.y > surf + b.instance.length * 0.12 || b.submergedT > 2.2) {
            this._eruptImpact(b, game, player);
            this._endStrike(b);
          }
        }
        if (b.attackT > 12) { this._setTargetable(b, true); this._endStrike(b); }
        break;
      }
      default:
        if (b.attackT > 0.7) this._endStrike(b);
    }
  }

  _endStrike(b) {
    b.mode = 'recover';
    b.attackT = 0;
  }

  /** Untargetable while submerged: pulled clean out of the fish list. */
  _setTargetable(b, on) {
    const fishSys = this.game.get('fish');
    if (!fishSys || !b.fish) return;
    const i = fishSys.active.indexOf(b.fish);
    if (on && i < 0) { fishSys.active.push(b.fish); b.fish.active = true; }
    else if (!on && i >= 0) fishSys.active.splice(i, 1);
    b.targetable = on;
  }

  // ------------------------------------------------------------ mechanics
  _ramImpact(b, game, player, terrain = false) {
    if (b.ramHit) return;
    b.ramHit = true;
    const p = b.fish.position.clone();
    const tier = b.species.tier || 2;
    const dmg = 8 + tier * 2.2;
    const radius = Math.max(6, b.instance.length * 0.85);

    game.audio?.play('boss_slam', { volume: 1.0, position: p });
    game.audio?.play('splash_big', { volume: 0.85, position: p });
    bus.emit('fx:bigSplash', { position: this._surfaceAt(p), scale: 3.4 });
    bus.emit('fx:explosion', { position: p.clone(), scale: 1.5 });
    bus.emit('fx:screenFlash', { color: 'rgba(255,120,90,0.2)', duration: 0.22 });
    bus.emit('fx:hitStop', 0.08);
    bus.emit('player:shake', 0.95);

    // Environment: crates, barrels, caught fish, anything dynamic goes flying.
    try { game.physics?.explode(p.x, p.y, p.z, radius * 1.5, 130 + tier * 40); }
    catch (e) { console.warn('[Boss] explode failed', e); }
    game.get('fish')?.scare(p, radius * 2.4, 2.4);

    if (player) {
      const d = player.position.distanceTo(p);
      if (d < radius) {
        const k = 1 - d / radius;
        _v.copy(player.position).sub(p).setY(0);
        if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
        _v.normalize().multiplyScalar(11 * k + 5);
        bus.emit('player:knockback', { x: _v.x, y: 7 * k + 2.5, z: _v.z });
        player.damage(dmg * k, `${b.species.name}`);
        bus.emit('toast', { text: `${b.species.name} rams you!`, kind: 'error', duration: 1800 });
      }
    }
    this._damageBoats(b, game, p, radius * 1.4, 14 + tier * 3);
    if (terrain) bus.emit('fx:impact', { position: p, normal: UP.clone(), kind: 'wood', scale: 3 });
    bus.emit('boss:attack', { id: b.id, kind: 'ram', position: p });
    this._endStrike(b);
  }

  _eruptImpact(b, game, player) {
    const p = b.fish.position.clone();
    const surf = this._surfaceAt(p);
    const tier = b.species.tier || 2;
    const dmg = (8 + tier * 2.2) * 0.85;
    const radius = Math.max(7, b.instance.length * 0.75);

    game.audio?.play('splash_big', { volume: 1.0, position: p });
    game.audio?.play('boss_slam', { volume: 0.85, position: p });
    bus.emit('fx:bigSplash', { position: surf, scale: 4.2 });
    bus.emit('fx:explosion', { position: surf.clone(), scale: 1.8 });
    bus.emit('fx:screenFlash', { color: 'rgba(180,230,255,0.28)', duration: 0.3 });
    bus.emit('fx:hitStop', 0.09);
    bus.emit('player:shake', 1.0);
    bus.emit('ocean:ripple', { x: p.x, z: p.z, strength: 2.2 });
    try { game.physics?.explode(p.x, surf.y, p.z, radius * 1.6, 150 + tier * 45); } catch { /* physics optional */ }

    if (player) {
      const d = player.position.distanceTo(p);
      if (d < radius) {
        const k = 1 - d / radius;
        _v.copy(player.position).sub(p).setY(0);
        if (_v.lengthSq() < 1e-4) _v.set(rrange(-1, 1), 0, rrange(-1, 1));
        _v.normalize().multiplyScalar(7 * k);
        bus.emit('player:knockback', { x: _v.x, y: 12 * k + 4, z: _v.z });
        player.damage(dmg * k, `${b.species.name}`);
      }
    }
    this._damageBoats(b, game, p, radius * 1.5, 12 + tier * 3);
    bus.emit('boss:attack', { id: b.id, kind: 'dive', position: p });
  }

  _doShockwave(b, game) {
    const p = b.fish.position.clone();
    const player = game.get('player');
    const tier = b.species.tier || 2;
    const radius = clamp(10 + tier * 2.4, 12, 34);
    const dmg = (8 + tier * 2.2) * 0.7;
    const surf = this._surfaceAt(p);

    game.audio?.play('boss_slam', { volume: 1.0, rate: 0.85, position: p });
    bus.emit('fx:explosion', { position: p.clone(), scale: 2.2 });
    bus.emit('fx:bigSplash', { position: surf, scale: 3.6 });
    for (let i = 1; i <= 3; i++) {
      bus.emit('fx:ripple', { position: surf.clone(), radius: radius * (i / 3) });
    }
    bus.emit('ocean:ripple', { x: p.x, z: p.z, strength: 2.6 });
    bus.emit('fx:screenFlash', { color: 'rgba(255,255,255,0.18)', duration: 0.26 });
    bus.emit('player:shake', 0.9);
    bus.emit('fx:hitStop', 0.06);
    if (b.id === 'stormfin') {
      bus.emit('fx:lightning', {
        from: new THREE.Vector3(p.x, p.y + 90, p.z), to: surf.clone(), color: 0x9fd8ff,
      });
    }
    try { game.physics?.explode(p.x, p.y, p.z, radius, 90 + tier * 30); } catch { /* physics optional */ }
    game.get('fish')?.scare(p, radius * 2, 2.2);

    if (player) {
      const d = player.position.distanceTo(p);
      if (d < radius) {
        const k = 1 - d / radius;
        _v.copy(player.position).sub(p).setY(0);
        if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
        _v.normalize().multiplyScalar(13 * k);
        bus.emit('player:knockback', { x: _v.x, y: 5 * k + 2, z: _v.z });
        player.damage(dmg * k, `${b.species.name}`);
      }
    }
    this._damageBoats(b, game, p, radius, 9 + tier * 2);
    bus.emit('boss:attack', { id: b.id, kind: 'shockwave', position: p, radius });
  }

  _doSummon(b, game) {
    const fishSys = game.get('fish');
    if (!fishSys) return;
    const p = b.fish.position;
    const count = rint(4, 8);
    const region = regionAt(p.x, p.z) || REGION_BY_ID[b.region] || REGION_BY_ID.crash;

    game.audio?.play('boss_roar', { volume: 0.9, rate: 1.12, position: p.clone() });
    bus.emit('fx:sparkle', { position: p.clone(), count: 40, color: 0x9fe8ff, radius: 4 });
    bus.emit('fx:screenFlash', { color: 'rgba(120,220,255,0.16)', duration: 0.28 });
    bus.emit('player:shake', 0.35);

    let made = 0;
    for (let i = 0; i < count * 3 && made < count; i++) {
      const a = Math.random() * TAU;
      const r = rrange(4, 12) + b.instance.length * 0.4;
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      const surf = waterHeightAt(x, z);
      const bed = worldHeight(x, z);
      if (surf - bed < 2) continue;
      const depth = clamp(surf - p.y, 1, Math.max(1.5, surf - bed - 1));
      const sp = fishSys.pickSpecies(region, depth) || fishSys.pickSpecies(region, 3);
      if (!sp) continue;
      const f = fishSys.spawn(sp, x, clamp(p.y + rrange(-3, 3), bed + 0.8, surf - 0.6), z);
      if (f) {
        f.state = FISH_STATE.HUNT;
        f.spooked = 0;
        f.energy = 1;
        made++;
        bus.emit('fx:splash', { position: new THREE.Vector3(x, surf, z), scale: 0.7 });
      }
    }
    b.adds += made;
    if (made) bus.emit('toast', { text: `${b.species.name} calls the school — ${made} incoming.`, kind: 'warn', duration: 2400 });
    bus.emit('boss:attack', { id: b.id, kind: 'summon', count: made });
  }

  _damageBoats(b, game, point, radius, amount) {
    const boats = game.get('boats');
    if (!boats?.owned) return;
    for (const boat of boats.owned) {
      if (!boat.position) continue;
      const d = dist2D(boat.position.x, boat.position.z, point.x, point.z);
      if (d > radius) continue;
      const k = 1 - d / radius;
      const dmg = amount * k;
      boat.health = Math.max(0, (boat.health ?? 100) - dmg);
      game.audio?.play('boat_impact', { volume: 0.8, position: boat.position.clone(), throttle: 120 });
      bus.emit('fx:impact', { position: boat.position.clone(), normal: UP.clone(), kind: 'wood', scale: 2 });
      if (boat.entry) {
        try {
          _v.copy(boat.position).sub(point).setY(0.4).normalize().multiplyScalar((boat.def?.mass || 800) * 2.2 * k);
          game.physics.addImpulse(boat.entry, _v.x, Math.abs(_v.y), _v.z);
        } catch { /* boat may not be physical yet */ }
      }
      if (boat.health <= 0) {
        boat.engineOn = false;
        bus.emit('toast', { text: `${boat.name} has been wrecked by ${b.species.name}!`, kind: 'error' });
      } else if (dmg > 3) {
        bus.emit('toast', { text: `${boat.name} takes ${Math.round(dmg)} damage!`, kind: 'warn', duration: 1800 });
      }
      bus.emit('boats:changed', { count: boats.owned.length, boat });
    }
  }

  // ------------------------------------------------------------- movement
  _move(dt, b, game) {
    const f = b.fish;
    const player = game.get('player');
    if (!f || !player) return;

    // While hooked, FishingSystem owns the position; we only steer the look.
    if (b.hooked) {
      f.knockV.set(0, 0, 0);
      f.heading.copy(_v.copy(player.position).sub(f.position).setY(f.heading.y * 0.2).normalize());
      f.state = FISH_STATE.HOOKED;
      return;
    }
    // Let the bait-attraction states run: that is how a rod gets a bite.
    if (f.state === FISH_STATE.INTERESTED || f.state === FISH_STATE.NIBBLE) return;
    f.knockV.set(0, 0, 0);

    const len = b.instance.length;
    const surf = waterHeightAt(f.position.x, f.position.z);
    const bed = worldHeight(f.position.x, f.position.z);
    const minY = bed + len * 0.16 + 0.5;
    const maxY = surf - len * 0.10;

    let speed = lerp(1.6, 5.5, b.species.speed) * lerp(0.85, 1.35, b.aggro);
    const want = _v3.set(0, 0, 0);

    // ---- deep water seeking ------------------------------------------
    // Something 19 m long beaches itself very easily. Whenever the water is
    // too thin to hold the boss, steer hard toward the deepest nearby bed.
    const need = len * 0.42 + 2;
    const depth = surf - bed;
    if (depth < need) {
      const probe = Math.max(6, len * 0.9);
      let bx = 0, bz = 0, best = bed;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const sx = f.position.x + Math.cos(a) * probe;
        const sz = f.position.z + Math.sin(a) * probe;
        const h = worldHeight(sx, sz);
        if (h < best) { best = h; bx = Math.cos(a); bz = Math.sin(a); }
      }
      if (bx || bz) {
        const urgency = clamp((need - depth) / need, 0, 1) * 3.4;
        want.x += bx * urgency;
        want.z += bz * urgency;
        want.y -= urgency * 0.4;
      }
    }

    if (b.state === 'intro') {
      // Rise into view and hold, so the player gets a good look at it.
      want.copy(player.position).sub(f.position).setY(0).normalize().multiplyScalar(0.4);
      want.y += (clamp(surf - len * 0.22, minY, maxY) - f.position.y) * 0.5;
      speed *= 0.55;
      if (b.stateT > 3.4) { b.state = 'fight'; b.stateT = 0; }
    } else if (b.attack === 'ram' && b.mode === 'windup') {
      // Back up along the approach line — a visible run-up.
      want.copy(b.ramFrom).sub(f.position);
      speed *= 0.9;
      want.normalize().multiplyScalar(1.2);
    } else if (b.attack === 'ram' && b.mode === 'strike') {
      want.copy(b.target).sub(f.position);
      const d = want.length();
      if (d > 0.001) want.multiplyScalar(1 / d);
      want.multiplyScalar(2.4);
      speed = b.ramSpeed || 16;
    } else if (b.attack === 'dive' && b.mode === 'strike') {
      if (b.divePhase === 'erupt') {
        want.set(0, 3, 0);
        want.x += (b.target.x - f.position.x) * 0.06;
        want.z += (b.target.z - f.position.z) * 0.06;
        speed = lerp(12, 22, clamp01(b.species.speed));
      } else {
        want.copy(player.position).sub(f.position).setY(0).normalize().multiplyScalar(1.0);
        want.y = -2.2;
        speed = lerp(6, 12, clamp01(b.species.speed));
      }
    } else if (b.mode === 'windup') {
      // Rear up: rise, slow, face the player. Unmistakable.
      want.copy(player.position).sub(f.position).setY(0).normalize().multiplyScalar(0.25);
      want.y += 1.1;
      speed *= 0.5;
    } else {
      // Circling: orbit the player at a stand-off distance, drifting in depth.
      const orbitR = clamp(len * 1.5 + 8, 12, 40);
      _v.copy(f.position).sub(player.position).setY(0);
      const d = _v.length() || 1;
      _v.multiplyScalar(1 / d);
      _v2.set(-_v.z, 0, _v.x);                                // tangent
      want.addScaledVector(_v2, 1.5 * (b._orbitDir || 1));
      want.addScaledVector(_v, clamp((d - orbitR) * -0.09, -1.4, 1.4));
      const wantY = clamp(surf - len * (0.24 + 0.16 * Math.sin(b._t * 0.35)), minY, maxY);
      want.y += clamp((wantY - f.position.y) * 0.35, -1.5, 1.5);
      if (!b._orbitDir || rchance(dt * 0.06)) b._orbitDir = rchance(0.5) ? 1 : -1;
    }

    if (want.lengthSq() < 1e-6) want.copy(f.heading);
    want.normalize().multiplyScalar(speed);
    f.velocity.lerp(want, 1 - Math.pow(0.0025, dt));
    f.position.addScaledVector(f.velocity, dt);

    // Keep it in the water — except mid-eruption, where it must breach.
    const erupting = b.attack === 'dive' && b.divePhase === 'erupt';
    const submerged = b.attack === 'dive' && b.mode === 'strike' && b.divePhase !== 'erupt';
    const hi = erupting ? surf + len * 0.55 : (submerged ? surf - len * 0.35 : maxY);
    // In water too thin for the boss the floor would sit above the ceiling —
    // staying wet always wins over standing on the beach.
    const lo = Math.min(submerged ? bed + len * 0.14 + 0.4 : minY, hi);
    if (f.position.y > hi) { f.position.y = hi; if (f.velocity.y > 0) f.velocity.y *= -0.2; }
    if (f.position.y < lo) { f.position.y = lo; if (f.velocity.y < 0) f.velocity.y *= -0.2; }

    // Stand-off: never let anything (a harpoon tether, a bad steer) drag the
    // boss into the player's lap — that is also how a tether cheeses the kill.
    _v.copy(f.position).sub(player.position);
    const away = _v.length() || 1;
    const minStand = b.attack === 'ram' && b.mode === 'strike' ? 0
      : Math.max(4.5, len * 0.34);
    if (away < minStand) {
      // Horizontal push only: a player up on a dock must not lift the boss.
      _v.y = 0;
      const flat = _v.length() || 1;
      _v.multiplyScalar(minStand / flat);
      const keepY = f.position.y;
      f.position.copy(player.position).add(_v);
      f.position.y = keepY;
    } else if (away > 88) {
      // Never wander so far the fish system despawns it.
      _v.multiplyScalar(88 / away);
      f.position.copy(player.position).add(_v);
    }

    if (f.velocity.lengthSq() > 0.02) {
      f.heading.lerp(_v.copy(f.velocity).normalize(), 1 - Math.pow(0.0006, dt)).normalize();
    }
    f.state = FISH_STATE.ROAM;
    f.stateTime = 0;
    f.spooked = 0;
  }

  _applyTransform(dt, b, game) {
    const f = b.fish;
    if (!f) return;
    const g = f.group;
    // Belt and braces: if anything swapped the mesh out, put the boss back.
    if (f.mesh !== b.mesh) {
      if (f.mesh?.parent === g) g.remove(f.mesh);
      if (b.mesh.parent !== g) g.add(b.mesh);
      f.mesh = b.mesh;
    }
    g.position.copy(f.position);
    _v.copy(f.heading);
    if (_v.lengthSq() > 1e-6) {
      _m.lookAt(_v3.set(0, 0, 0), _v2.copy(_v).negate(), UP);
      _q.setFromRotationMatrix(_m);
      _q.multiply(_qFix);
      g.quaternion.slerp(_q, 1 - Math.pow(0.0009, dt));
    }
    g.scale.setScalar(f.scale);
    // Always rendered while the fight is live — you should see it coming, and
    // FishSystem's 78 m cull is far too tight for something 38 m long.
    const camD = game.camera ? g.position.distanceTo(game.camera.position) : 0;
    g.visible = camD < 420;
    g.updateMatrix();
    g.updateMatrixWorld(true);

    const speedN = clamp01(f.velocity.length() / lerp(5, 16, clamp01(b.species.speed)));
    b.mouthTarget = b.mode === 'strike' && (b.attack === 'ram' || b.attack === 'dive') ? 1
      : b.mode === 'windup' ? 0.55 : 0.1 + Math.sin(b._t * 0.7) * 0.08;
    b.mouth = damp(b.mouth, b.mouthTarget, 0.0015, dt);

    try {
      b.mesh.userData.animateBoss?.(b._t, {
        mode: b.mode, mouth: b.mouth, aggro: b.aggro, speed: speedN,
        hpPct: b.hp / b.maxHp, hurt: b.hurt, phase: b.phaseIndex,
      });
    } catch (e) { console.error('[Boss] animateBoss threw', e); }

    this._refreshWeakPointWorld(b);
  }

  _surfaceAt(p) { return new THREE.Vector3(p.x, waterHeightAt(p.x, p.z), p.z); }

  // ---------------------------------------------------------------- death
  _die(alreadyRemoved) {
    const b = this.boss;
    if (!b || b.dead) return;
    b.dead = true;
    const game = this.game;
    const p = b.fish ? b.fish.position.clone() : new THREE.Vector3();
    const surf = this._surfaceAt(p);
    const bd = b.bd;

    // ---- the light show -------------------------------------------------
    game.audio?.play('boss_slam', { volume: 1.0, position: p });
    game.audio?.play('explosion', { volume: 0.95, position: p });
    game.audio?.play('legendary', { volume: 0.8 });
    bus.emit('fx:hitStop', 0.16);
    bus.emit('fx:screenFlash', { color: 'rgba(255,235,200,0.42)', duration: 0.65 });
    bus.emit('player:shake', 1.2);
    bus.emit('fx:bigSplash', { position: surf.clone(), scale: 5 });
    bus.emit('fx:explosion', { position: p.clone(), scale: 3 });
    for (let i = 0; i < 6; i++) {
      const o = new THREE.Vector3(
        p.x + rrange(-1, 1) * b.instance.length * 0.4,
        p.y + rrange(-0.3, 0.6) * b.instance.length * 0.3,
        p.z + rrange(-1, 1) * b.instance.length * 0.4,
      );
      bus.emit('fx:explosion', { position: o, scale: 1.4 });
      bus.emit('fx:sparkle', { position: o.clone(), count: 24, color: 0xffd27a, radius: 2.6 });
    }
    bus.emit('ocean:ripple', { x: p.x, z: p.z, strength: 3 });
    try { game.physics?.explode(p.x, p.y, p.z, b.instance.length * 2.2, 220); } catch { /* optional */ }
    game.get('fish')?.scare(p, 60, 3);

    // ---- hand the corpse to the physics world ---------------------------
    const mesh = b.mesh;
    let pf = null;
    if (!alreadyRemoved) {
      this._detachFish(b, false);
      const mgr = game.get('physfish');
      if (mgr && mesh) {
        try {
          pf = mgr.spawn({
            instance: b.instance,
            position: { x: p.x, y: Math.max(p.y, surf.y) + b.instance.length * 0.12, z: p.z },
            velocity: { x: rrange(-1, 1), y: 2.2, z: rrange(-1, 1) },
            mesh,
            angularVelocity: { x: rrange(-0.3, 0.3), y: rrange(-0.4, 0.4), z: rrange(-0.6, 0.6) },
          });
          if (pf) { pf.maxLife = 900; pf.styleMult = 1; pf.isBoss = true; }
        } catch (e) { console.error('[Boss] physfish spawn failed', e); }
      }
      if (!pf && mesh) disposeBossMesh(mesh);
    } else {
      this._detachFish(b, false);
    }

    // ---- payout ---------------------------------------------------------
    const eco = game.get('economy');
    const money = bd.reward?.money ?? 0;
    if (eco && money > 0) eco.add(money, `boss:${b.id}`);
    if (eco?.stats && Array.isArray(eco.stats.bossesKilled) && !eco.stats.bossesKilled.includes(b.id)) {
      eco.stats.bossesKilled.push(b.id);
    }
    this.defeated.add(b.id);
    this.cooldown.set(b.id, 180);

    const rarity = RARITY[b.species.rarity] || RARITY.legendary;
    bus.emit('catch:popup', {
      name: b.species.name,
      rarity: `${rarity.name} Boss`,
      rarityColor: rarity.color,
      weight: b.instance.weight,
      length: b.instance.length,
      value: money,
      badges: ['BOSS DEFEATED', `${Math.round(b.fightTime)}s`, ...(bd.reward?.unlocks || [])],
    });
    bus.emit('fx:moneyBurst', { position: surf.clone(), amount: money });
    bus.emit('toast', { text: `${b.species.name} defeated — $${money.toLocaleString()}`, kind: 'gold', duration: 5200 });
    for (const u of bd.reward?.unlocks || []) bus.emit('feature:unlocked', { id: u, source: `boss:${b.id}` });

    // QuestSystem listens for exactly this.
    bus.emit('boss:defeated', {
      id: b.id, species: b.species.id, money,
      unlocks: bd.reward?.unlocks || [], fightTime: b.fightTime, pf,
    });
    // Balance MusicDirector's ref-count (spawn may have counted twice).
    for (let i = 1; i < b.musicRefs; i++) bus.emit('boss:despawned', { id: b.id, reason: 'defeated' });

    if (this.debugLog) console.info('[Boss] defeated', b.id, 'in', b.fightTime.toFixed(1), 's');
    this.boss = null;
    this._pendingDamage.length = 0;
    this._showBar(false);
  }

  // ============================================================= health bar
  _buildBar() {
    const root = document.getElementById('ui-root');
    if (!root) return;
    if (!document.getElementById('boss-bar-style')) {
      const st = document.createElement('style');
      st.id = 'boss-bar-style';
      st.textContent = `
#boss-bar{position:absolute;top:14px;left:50%;transform:translateX(-50%) translateY(-14px);
  width:min(660px,60vw);pointer-events:none;opacity:0;transition:opacity .35s ease,transform .35s ease;
  font-family:var(--font,system-ui);z-index:12;text-align:center}
#boss-bar.on{opacity:1;transform:translateX(-50%) translateY(0)}
#boss-bar .bb-name{font-size:20px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;
  color:#ffe9d2;text-shadow:0 2px 12px rgba(0,0,0,.85),0 0 22px rgba(255,90,60,.5);line-height:1.1}
#boss-bar .bb-sub{margin-top:2px;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;
  color:#ffb08a;text-shadow:0 1px 6px rgba(0,0,0,.9)}
#boss-bar .bb-track{position:relative;height:15px;margin-top:6px;border-radius:3px;overflow:hidden;
  background:rgba(6,10,16,.82);border:1px solid rgba(255,120,90,.45);
  box-shadow:0 4px 22px rgba(0,0,0,.6),inset 0 0 14px rgba(0,0,0,.7)}
#boss-bar .bb-fill{position:absolute;inset:0;transform-origin:left center;
  background:linear-gradient(90deg,#ff3d5e,#ff8a4a 60%,#ffc22e);transition:transform .13s linear}
#boss-bar .bb-ghost{position:absolute;inset:0;transform-origin:left center;
  background:rgba(255,255,255,.32);transition:transform .6s ease .12s}
#boss-bar .bb-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
#boss-bar .bb-seg{position:absolute;top:0;bottom:0;width:2px;background:rgba(4,8,12,.9);
  box-shadow:0 0 0 1px rgba(255,255,255,.14)}
#boss-bar .bb-armor{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:99px;
  background:#7c8ea3;color:#0b131b;font-size:10px;font-weight:900;letter-spacing:.1em}
#boss-bar .bb-wp{display:inline-flex;gap:4px;margin-left:8px;vertical-align:middle}
#boss-bar .bb-wp i{width:9px;height:9px;border-radius:50%;background:#ffd27a;
  box-shadow:0 0 8px rgba(255,210,122,.9);display:inline-block}
#boss-bar .bb-wp i.dead{background:#2b3542;box-shadow:none}
`;
      document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.id = 'boss-bar';
    el.innerHTML = `<div class="bb-name">—</div><div class="bb-sub">—</div>
<div class="bb-track"><div class="bb-ghost"></div><div class="bb-fill"></div><div class="bb-flash"></div></div>`;
    root.appendChild(el);
    this.barEl = el;
    this.barName = el.querySelector('.bb-name');
    this.barSub = el.querySelector('.bb-sub');
    this.barTrack = el.querySelector('.bb-track');
    this.barFill = el.querySelector('.bb-fill');
    this.barGhost = el.querySelector('.bb-ghost');
    this.barFlash = el.querySelector('.bb-flash');
  }

  _showBar(on) {
    if (!this.barEl) return;
    this.barEl.classList.toggle('on', !!on);
    if (!on) return;
    const b = this.boss;
    if (!b) return;
    this.barName.textContent = b.species.name;
    // Phase dividers: one segment per bossData phase.
    for (const old of this.barTrack.querySelectorAll('.bb-seg')) old.remove();
    for (let i = 1; i < b.phases.length; i++) {
      const s = document.createElement('div');
      s.className = 'bb-seg';
      s.style.left = `${(b.phases[i].hpPct * 100).toFixed(2)}%`;
      this.barTrack.appendChild(s);
    }
    this._barPct = 1;
    this.barFill.style.transform = 'scaleX(1)';
    this.barGhost.style.transform = 'scaleX(1)';
    this._barKey = null;
    this._updateBar(b);
  }

  _updateBar(b) {
    if (!this.barEl || !this.barEl.classList.contains('on')) return;
    const pct = clamp01(b.hp / b.maxHp);
    if (Math.abs(pct - (this._barPct ?? 1)) > 0.0005) {
      this._barPct = pct;
      this.barFill.style.transform = `scaleX(${pct})`;
      this.barGhost.style.transform = `scaleX(${pct})`;
    }
    const left = b.weakPoints.filter((w) => !w.broken).length;
    const key = `${b.phaseIndex}|${left}|${b.armor}`;
    if (key !== this._barKey) {
      this._barKey = key;
      const pips = b.weakPoints.map((w) => `<i class="${w.broken ? 'dead' : ''}"></i>`).join('');
      this.barSub.innerHTML = `${b.phase?.name || ''} · Phase ${b.phaseIndex + 1}/${b.phases.length}`
        + `<span class="bb-wp">${pips}</span>`
        + (b.armor ? `<span class="bb-armor">Armoured</span>` : '');
    }
  }

  _flashBar(color = '#fff', strength = 0.32) {
    if (!this.barFlash) return;
    const f = this.barFlash;
    f.style.background = color;
    f.style.transition = 'none';
    f.style.opacity = String(strength);
    // Force a reflow so the fade actually animates.
    void f.offsetWidth;
    f.style.transition = 'opacity .28s ease';
    f.style.opacity = '0';
  }

  // ============================================================ save/load
  save() {
    return { defeated: [...this.defeated] };
  }

  load(d) {
    // An in-progress fight is never persisted — the boss is simply gone.
    this.despawn('reset');
    this.defeated = new Set(Array.isArray(d?.defeated) ? d.defeated : []);
    this.cooldown.clear();
    this._ambientTimer = 30;
  }
}

export default BossSystem;
