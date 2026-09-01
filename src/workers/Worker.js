import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { buildWorkerMesh, buildWorkerTool } from './WorkerMesh.js';
import { ROLES, TRAITS, SKILLS, xpForLevel, baseWage, WORKER_LINES } from '../data/workers.js';
import { getSpecies, rollFishInstance, speciesInRegion, RARITY, VARIANT_BY_ID } from '../data/fishData.js';
import { REGION_BY_ID, regionAt } from '../data/regions.js';
import { worldHeight, worldSlope } from '../world/Terrain.js';
import { waterHeightAt } from '../world/waves.js';
import {
  clamp, clamp01, lerp, damp, rrange, rint, rpick, rchance, makeRNG, weightedPick,
  formatMoneyExact, formatWeight, TAU,
} from '../util/math.js';

export const WS = {
  IDLE: 'IDLE', WALK_TO_JOB: 'WALK_TO_JOB', GET_ROD: 'GET_ROD', GO_TO_SPOT: 'GO_TO_SPOT',
  CAST: 'CAST', WAIT_BITE: 'WAIT_BITE', HOOK_FISH: 'HOOK_FISH', REEL: 'REEL',
  HANDLE_CATCH: 'HANDLE_CATCH', CARRY_FISH: 'CARRY_FISH', STORE_FISH: 'STORE_FISH',
  SELL_FISH: 'SELL_FISH', BOARD_BOAT: 'BOARD_BOAT', ON_BOAT: 'ON_BOAT', OPERATE_BOAT: 'OPERATE_BOAT',
  USE_HARPOON: 'USE_HARPOON', PROCESS: 'PROCESS', REPAIR: 'REPAIR', REST: 'REST', STUCK: 'STUCK',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/**
 * One employee. Owns both the persistent data (level/XP/skills/wage) and the
 * physical embodiment (mesh, navigation, finite-state AI).
 *
 * When far from the player, `physical` is false and the same FSM runs at a low
 * tick rate without a mesh — the outcomes are identical, only the presentation
 * is skipped.
 */
export class Worker {
  constructor(game, data) {
    this.game = game;
    Object.assign(this, {
      id: data.id,
      seed: data.seed ?? (Math.random() * 1e9) | 0,
      name: data.name,
      role: data.role || 'fisherman',
      level: data.level ?? 1,
      xp: data.xp ?? 0,
      skills: data.skills || defaultSkills(),
      traits: (data.traits || []).map((t) => (typeof t === 'string' ? TRAITS.find((x) => x.id === t) : t)).filter(Boolean),
      morale: data.morale ?? 0.82,
      wage: data.wage ?? 40,
      equipment: data.equipment || { rod: 'rod_old', tool: null, armor: null },
      assignment: data.assignment ?? null,
      assignmentData: data.assignmentData || null,
      stats: data.stats || { caught: 0, revenue: 0, daysWorked: 0, trips: 0, biggest: 0 },
      treePoints: data.treePoints || {},
      hiredDay: data.hiredDay ?? 1,
    });

    this.rng = makeRNG(this.seed);
    this.state = WS.IDLE;
    this.stateTime = 0;
    this.physical = false;
    this.object = null;
    this.rig = null;
    this.tool = null;
    this.position = new THREE.Vector3(data.x ?? 0, data.y ?? 0, data.z ?? 0);
    this.velocity = new THREE.Vector3();
    this.facing = 0;
    this.navTarget = null;
    this.navPath = [];
    this.stuckTimer = 0;
    this.walkPhase = 0;
    this.speed = 1;
    this.carrying = null;          // fish instance being carried
    this.carryMesh = null;
    this.fatigue = 0;
    this.talkCooldown = rrange(5, 25);
    this.bobber = null;
    this.line = null;
    this.castTarget = new THREE.Vector3();
    this.biteTimer = 0;
    this.fishOnLine = null;
    this.boat = null;
    this.fleet = null;
    this.lastCatchAt = 0;
    this.spotIndex = 0;
    this.homeAnchor = null;
    this.deliverTo = null;
    this._accum = 0;
    this._speech = null;
    this.recomputeDerived();
  }

  // ------------------------------------------------------------- derived
  get roleDef() { return ROLES[this.role] || ROLES.fisherman; }
  get roleName() { return this.roleDef.name; }
  get icon() { return this.roleDef.icon; }
  get xpToNext() { return xpForLevel(this.level); }
  get assignmentLabel() {
    if (!this.assignment) return 'Idle';
    if (this.assignment.startsWith('fish:')) {
      const r = REGION_BY_ID[this.assignment.slice(5)];
      return `Fishing · ${r?.short || '?'}`;
    }
    if (this.assignment.startsWith('fleet:')) return `Crew · ${this.fleet?.name || 'fleet'}`;
    if (this.assignment === 'process') return 'Processing';
    if (this.assignment === 'repair') return 'Repairs';
    if (this.assignment === 'rest') return 'Resting';
    return this.assignment;
  }
  get trainCost() { return Math.round(500 * Math.pow(1.5, this.level - 1)); }

  hasTrait(id) { return this.traits.some((t) => t.id === id); }
  traitSum(key) {
    let n = 0;
    for (const t of this.traits) n += t.effect?.[key] ?? 0;
    return n;
  }
  treeBonus(key) {
    let n = 0;
    for (const node of this.roleDef.tree) {
      const pts = this.treePoints[node.id] || 0;
      if (pts && node.effect[key] != null) n += node.effect[key] * pts;
    }
    return n;
  }

  /** Cached multipliers so the FSM doesn't recompute them every tick. */
  recomputeDerived() {
    const s = this.skills;
    const research = this.game.get('research');
    const globalXp = research?.xpMult ?? 1;
    this.d = {
      speedMult: clamp(1 + this.traitSum('speed') + this.treeBonus('haulSpeed') * 0.5, 0.4, 2.2),
      biteSpeed: clamp(1 + this.traitSum('biteSpeed') + (s.fishing - 3) * 0.08 + this.treeBonus('hookChance'), 0.35, 3.2),
      catchQuality: clamp(1 + (s.luck - 3) * 0.06 + this.traitSum('rareBonus') + this.treeBonus('rareBonus'), 0.3, 4),
      maxWeight: clamp(6 * Math.pow(1.42, this.level - 1) * (1 + this.traitSum('maxWeight') + this.treeBonus('maxWeight')) * (1 + (s.strength - 3) * 0.12), 1, 40000),
      xpMult: clamp(1 + this.traitSum('xpMult'), 0.3, 3) * globalXp,
      wageMult: clamp(1 + this.traitSum('wageMult'), 0.4, 2.5),
      reelSpeed: clamp(1 + this.treeBonus('reelSpeed') + (s.strength - 3) * 0.05, 0.4, 3),
      junkChance: clamp(0.06 + this.traitSum('junkChance'), 0, 0.5),
      dropChance: clamp(this.traitSum('dropChance'), 0, 0.4),
      freshness: clamp(1 + this.traitSum('freshness') + this.treeBonus('freshness'), 0.8, 1.6),
      talkRate: clamp(1 + this.traitSum('talkRate'), 0.05, 5),
      restBias: clamp(this.traitSum('restBias'), 0, 1),
      danger: clamp(1 + this.traitSum('danger'), 0.2, 2),
    };
    this.wage = Math.round(baseWage(this.role, this.level, this.skills) * this.d.wageMult
      * (research?.wageMult ?? 1));
  }

  // ------------------------------------------------------------- physical
  spawnPhysical(scene) {
    if (this.physical) return;
    this.object = buildWorkerMesh(this.seed, { role: this.role, level: this.level });
    this.rig = this.object.userData.rig;
    this.object.position.copy(this.position);
    scene.add(this.object);
    this.physical = true;
    this.setTool(this.currentToolKind());
  }

  despawnPhysical(scene) {
    if (!this.physical) return;
    this.clearFishingLine();
    if (this.carryMesh) { this.object.remove(this.carryMesh); this.carryMesh = null; }
    scene.remove(this.object);
    this.object = null; this.rig = null; this.tool = null;
    this.physical = false;
  }

  currentToolKind() {
    switch (this.state) {
      case WS.CAST: case WS.WAIT_BITE: case WS.HOOK_FISH: case WS.REEL: case WS.GO_TO_SPOT: return 'rod';
      case WS.USE_HARPOON: return 'harpoon';
      case WS.PROCESS: return 'knife';
      case WS.REPAIR: return 'wrench';
      case WS.CARRY_FISH: case WS.STORE_FISH: case WS.SELL_FISH: return null;
      default:
        if (this.role === 'manager') return 'clipboard';
        if (this.role === 'mechanic') return 'wrench';
        if (this.role === 'processor') return 'knife';
        if (this.role === 'hunter') return 'harpoon';
        if (this.role === 'fisherman') return 'rod';
        return null;
    }
  }

  setTool(kind) {
    if (!this.physical || this._toolKind === kind) return;
    this._toolKind = kind;
    if (this.tool) { this.rig.itemSocket.remove(this.tool); this.tool = null; }
    if (kind) {
      this.tool = buildWorkerTool(kind);
      this.rig.itemSocket.add(this.tool);
    }
  }

  say(category) {
    const lines = WORKER_LINES[category];
    if (!lines?.length) return;
    if (this.talkCooldown > 0) return;
    this.talkCooldown = rrange(14, 45) / this.d.talkRate;
    const line = rpick(lines);
    bus.emit('worker:speech', { worker: this, line, category });
    if (this.physical) {
      this.game.audio.play('ui_hover', { volume: 0.12, position: this.position.clone(), rate: rrange(0.7, 1.3), throttle: 300 });
    }
  }

  // ------------------------------------------------------------- navigation
  setNavTarget(x, y, z) {
    this.navTarget = new THREE.Vector3(x, y, z);
    this.stuckTimer = 0;
    this._lastNavDist = Infinity;
  }

  /** Steering + terrain following. Returns true once the target is reached. */
  navigate(dt, arriveDist = 1.2) {
    if (!this.navTarget) return true;
    _v.copy(this.navTarget).sub(this.position);
    _v.y = 0;
    const dist = _v.length();
    if (dist < arriveDist) { this.navTarget = null; this.velocity.set(0, 0, 0); return true; }
    _v.multiplyScalar(1 / dist);

    // Avoid walking into deep water (divers excepted).
    const probe = 1.8;
    const px = this.position.x + _v.x * probe, pz = this.position.z + _v.z * probe;
    const bed = worldHeight(px, pz);
    const surf = waterHeightAt(px, pz);
    if (this.role !== 'diver' && surf - bed > 1.6) {
      // Steer along the shoreline instead of straight in.
      _v2.set(-_v.z, 0, _v.x);
      const side = worldHeight(this.position.x + _v2.x * probe, this.position.z + _v2.z * probe);
      const other = worldHeight(this.position.x - _v2.x * probe, this.position.z - _v2.z * probe);
      _v.copy(side > other ? _v2 : _v2.negate());
    }
    // Avoid climbing sheer slopes.
    if (worldSlope(px, pz) > 0.75) {
      _v2.set(-_v.z, 0, _v.x).multiplyScalar(0.9);
      _v.add(_v2).normalize();
    }

    const base = (this.state === WS.CARRY_FISH ? 1.6 : 2.5) * this.d.speedMult * lerp(0.65, 1.12, this.morale);
    const spd = base * (1 - this.fatigue * 0.35);
    this.velocity.lerp(_v3.copy(_v).multiplyScalar(spd), 1 - Math.pow(0.0005, dt));
    this.position.addScaledVector(this.velocity, dt);

    // Stick to the ground (or float at the surface when swimming).
    const groundY = worldHeight(this.position.x, this.position.z);
    const waterY = waterHeightAt(this.position.x, this.position.z);
    const targetY = (this.boat) ? this.position.y : Math.max(groundY, waterY - 1.1);
    this.position.y = damp(this.position.y, targetY, 0.0001, dt);

    if (this.velocity.lengthSq() > 0.02) {
      const want = Math.atan2(this.velocity.x, this.velocity.z);
      this.facing = angleDamp(this.facing, want, 0.0008, dt);
    }
    this.walkPhase += this.velocity.length() * dt * 3.4;

    // Stuck detection: no meaningful progress toward the target.
    if (dist > this._lastNavDist - 0.02) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    this._lastNavDist = dist;
    if (this.stuckTimer > 3.2) {
      // Sidestep and try again.
      const a = this.rng() * TAU;
      this.setNavTarget(
        this.position.x + Math.cos(a) * 6,
        this.position.y,
        this.position.z + Math.sin(a) * 6,
      );
      this.stuckTimer = 0;
      this._stuckCount = (this._stuckCount || 0) + 1;
      if (this._stuckCount > 4) {
        // Give up and teleport to the anchor rather than jitter forever.
        const a2 = this.homeAnchor;
        if (a2) this.position.set(a2.x, worldHeight(a2.x, a2.z) + 0.1, a2.z);
        this._stuckCount = 0;
      }
    }
    return false;
  }

  // ------------------------------------------------------------- FSM
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateTime = 0;
    if (this.physical) this.setTool(this.currentToolKind());
    bus.emit('worker:state', { worker: this, state: s });
  }

  update(dt, game) {
    this.stateTime += dt;
    this.talkCooldown = Math.max(0, this.talkCooldown - dt);
    this.fatigue = clamp01(this.fatigue + (this.state === WS.REST ? -dt * 0.09 : dt * 0.0035));

    // Morale drifts toward a target set by conditions.
    const weather = game.get('weather');
    let moraleTarget = 0.85;
    if (this.fatigue > 0.7) moraleTarget -= 0.3;
    if (this.boat && this.hasTrait('seasick')) moraleTarget -= 0.35;
    if (this.boat && this.hasTrait('sea_legs')) moraleTarget += 0.12;
    if (weather && weather.intensity > 0.5) moraleTarget -= 0.18 * (1 + this.traitSum('boatMorale') * -1);
    if (!this.assignment) moraleTarget -= 0.1;
    const mgr = game.get('workers');
    if (mgr?.managerBonus) moraleTarget += mgr.managerBonus.morale || 0;
    this.morale = damp(this.morale, clamp01(moraleTarget), 0.6, dt);

    switch (this.state) {
      case WS.IDLE: this.tickIdle(dt, game); break;
      case WS.WALK_TO_JOB: this.tickWalkToJob(dt, game); break;
      case WS.GO_TO_SPOT: this.tickGoToSpot(dt, game); break;
      case WS.CAST: this.tickCast(dt, game); break;
      case WS.WAIT_BITE: this.tickWaitBite(dt, game); break;
      case WS.HOOK_FISH: this.tickHook(dt, game); break;
      case WS.REEL: this.tickReel(dt, game); break;
      case WS.HANDLE_CATCH: this.tickHandle(dt, game); break;
      case WS.CARRY_FISH: this.tickCarry(dt, game); break;
      case WS.STORE_FISH: this.tickStore(dt, game); break;
      case WS.REST: this.tickRest(dt, game); break;
      case WS.PROCESS: this.tickProcess(dt, game); break;
      case WS.REPAIR: this.tickRepair(dt, game); break;
      case WS.ON_BOAT: this.tickOnBoat(dt, game); break;
      default: this.setState(WS.IDLE);
    }

    if (this.physical) this.animate(dt, game);
  }

  tickIdle(dt, game) {
    if (this.assignment?.startsWith('fish:')) { this.setState(WS.WALK_TO_JOB); return; }
    if (this.assignment === 'process') { this.setState(WS.PROCESS); return; }
    if (this.assignment === 'repair') { this.setState(WS.REPAIR); return; }
    if (this.assignment === 'rest') { this.setState(WS.REST); return; }
    if (this.assignment?.startsWith('fleet:')) { this.setState(WS.ON_BOAT); return; }
    if (this.fatigue > 0.85) { this.setState(WS.REST); return; }

    // Idle wander near the home anchor so they don't stand like statues.
    if (!this.navTarget && this.stateTime > rrange(3, 9)) {
      const a = this.homeAnchor;
      if (a) {
        const ang = this.rng() * TAU, r = rrange(1.5, 7);
        const x = a.x + Math.cos(ang) * r, z = a.z + Math.sin(ang) * r;
        if (worldHeight(x, z) > 0.6) this.setNavTarget(x, 0, z);
      }
      this.stateTime = 0;
    }
    this.navigate(dt);
    if (this.stateTime > 12) this.say('idle');
  }

  tickWalkToJob(dt, game) {
    const regionId = this.assignment.slice(5);
    const region = REGION_BY_ID[regionId];
    if (!region) { this.assignment = null; this.setState(WS.IDLE); return; }
    if (!this.fishingSpot) this.fishingSpot = this.pickFishingSpot(game, region);
    if (!this.fishingSpot) { this.setState(WS.IDLE); return; }
    // Someone took the spot while we walked: pick another rather than stack up.
    if (this.stateTime > 1 && this.stateTime % 2 < dt) {
      const mgr = game.get('workers');
      const crowded = mgr?.workers.some((w) => w !== this && w.fishingSpot
        && Math.hypot(w.fishingSpot.stand.x - this.fishingSpot.stand.x, w.fishingSpot.stand.z - this.fishingSpot.stand.z) < 2.0
        && w.id < this.id);
      if (crowded) { this.fishingSpot = this.pickFishingSpot(game, region); this.navTarget = null; }
    }
    if (!this.navTarget) this.setNavTarget(this.fishingSpot.stand.x, 0, this.fishingSpot.stand.z);
    if (this.navigate(dt, 1.4)) {
      this.say('arrive');
      this.setState(WS.GO_TO_SPOT);
    }
  }

  /** Choose a place to stand with water in front of it. */
  pickFishingSpot(game, region) {
    const world = game.get('world');
    const anchors = world?.getAnchors(region.id);
    const spots = [];
    if (anchors?.dock) {
      // Prefer the dock: several positions along its length.
      const n = 8;
      for (let i = 0; i < n; i++) {
        const t = 0.22 + (i / n) * 0.74;
        const sx = lerp(anchors.dockStart.x, anchors.dockEnd.x, t);
        const sz = lerp(anchors.dockStart.z, anchors.dockEnd.z, t);
        const side = (i % 2) ? 1 : -1;
        const stand = {
          x: sx + anchors.side.x * side * (anchors.dock.width * 0.28),
          z: sz + anchors.side.z * side * (anchors.dock.width * 0.28),
          y: anchors.dock.y,
        };
        const water = {
          x: stand.x + anchors.side.x * side * 7,
          z: stand.z + anchors.side.z * side * 7,
        };
        if (waterHeightAt(water.x, water.z) - worldHeight(water.x, water.z) > 1.6) {
          spots.push({ stand, water, onDock: true });
        }
      }
    }
    // Shoreline fallbacks.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU + region.dockAngle;
      let r = region.radius * 0.9;
      for (let k = 0; k < 30; k++) {
        const x = region.x + Math.cos(a) * r, z = region.z + Math.sin(a) * r;
        if (worldHeight(x, z) < 0.7) { r -= 1.2; break; }
        r += 1.2;
        if (r > region.radius * 1.4) break;
      }
      const sx = region.x + Math.cos(a) * (r - 2.5), sz = region.z + Math.sin(a) * (r - 2.5);
      const wx = region.x + Math.cos(a) * (r + 9), wz = region.z + Math.sin(a) * (r + 9);
      if (worldHeight(sx, sz) > 0.7 && waterHeightAt(wx, wz) - worldHeight(wx, wz) > 1.4) {
        spots.push({ stand: { x: sx, y: worldHeight(sx, sz), z: sz }, water: { x: wx, z: wz }, onDock: false });
      }
    }
    if (!spots.length) return null;
    // Spread workers out: avoid spots another worker already claimed.
    const mgr = game.get('workers');
    const taken = mgr ? mgr.workers.filter((w) => w !== this && w.fishingSpot).map((w) => w.fishingSpot.stand) : [];
    const free = spots.filter((s) => !taken.some((t) => Math.hypot(t.x - s.stand.x, t.z - s.stand.z) < 6.5));
    const pool = free.length ? free : spots;
    return pool[(this.rng() * pool.length) | 0];
  }

  tickGoToSpot(dt, game) {
    const spot = this.fishingSpot;
    if (!spot) { this.setState(WS.WALK_TO_JOB); return; }
    // Face the water and settle.
    const want = Math.atan2(spot.water.x - this.position.x, spot.water.z - this.position.z);
    this.facing = angleDamp(this.facing, want, 0.0005, dt);
    this.velocity.multiplyScalar(Math.pow(0.001, dt));
    if (this.stateTime > 0.9) this.setState(WS.CAST);
  }

  tickCast(dt, game) {
    const spot = this.fishingSpot;
    if (!spot) { this.setState(WS.IDLE); return; }
    // Wind-up then release at t=0.55.
    if (this.stateTime > 0.55 && !this._castReleased) {
      this._castReleased = true;
      const range = lerp(6, 16, clamp01(this.skills.fishing / 10)) * (1 + this.treeBonus('castRange'));
      const a = Math.atan2(spot.water.x - this.position.x, spot.water.z - this.position.z) + rrange(-0.25, 0.25);
      const d = range * rrange(0.7, 1.15);
      let tx = this.position.x + Math.sin(a) * d;
      let tz = this.position.z + Math.cos(a) * d;
      // Pull the target back until it's actually over water.
      for (let i = 0; i < 12 && waterHeightAt(tx, tz) - worldHeight(tx, tz) < 1.0; i++) {
        tx = lerp(tx, spot.water.x, 0.3); tz = lerp(tz, spot.water.z, 0.3);
      }
      this.castTarget.set(tx, waterHeightAt(tx, tz), tz);
      if (this.physical) {
        this.makeFishingLine(game);
        game.audio.play('cast_whoosh', { volume: 0.3, position: this.position.clone(), rate: rrange(0.9, 1.1), throttle: 120 });
        setTimeout(() => {
          if (!this.physical) return;
          game.audio.play('splash_small', { volume: 0.35, position: this.castTarget.clone(), throttle: 90 });
          bus.emit('fx:splash', { position: this.castTarget.clone(), scale: 0.35 });
          bus.emit('ocean:ripple', { x: this.castTarget.x, z: this.castTarget.z, strength: 0.4 });
        }, 420);
      }
      // Pull real fish toward the bait so the world stays coherent.
      const fishSys = game.get('fish');
      if (fishSys) {
        for (const f of fishSys.active) {
          if (f.position.distanceToSquared(this.castTarget) < 225) {
            f.baitRef = { position: this.castTarget, inWater: true, attractMult: 1.1 };
            f.interest = Math.max(f.interest, 0.5);
          }
        }
      }
    }
    if (this.stateTime > 1.2) {
      this._castReleased = false;
      this.biteTimer = rrange(3.5, 12) / (this.d.biteSpeed * lerp(0.7, 1.25, this.morale));
      const sky = game.get('sky');
      if (sky?.isNight && this.hasTrait('night_owl')) this.biteTimer *= 0.55;
      if (sky && !sky.isNight && this.hasTrait('early_bird')) this.biteTimer *= 0.65;
      this.setState(WS.WAIT_BITE);
    }
  }

  tickWaitBite(dt, game) {
    this.biteTimer -= dt;
    if (this.bobber) {
      const y = waterHeightAt(this.castTarget.x, this.castTarget.z);
      this.bobber.position.set(this.castTarget.x, y + 0.05, this.castTarget.z);
      // Twitch as the bite approaches.
      if (this.biteTimer < 1.2) this.bobber.position.y -= 0.05 + Math.sin(this.stateTime * 24) * 0.04;
    }
    if (this.biteTimer <= 0) {
      if (this.physical) {
        game.audio.play('fish_bite', { volume: 0.4, position: this.castTarget.clone(), throttle: 120 });
        bus.emit('fx:ripple', { position: this.castTarget.clone(), radius: 0.5 });
      }
      this.setState(WS.HOOK_FISH);
    }
  }

  tickHook(dt, game) {
    if (this.stateTime > 0.35) {
      this.fishOnLine = this.rollCatch(game);
      if (!this.fishOnLine) { this.setState(WS.CAST); return; }
      this.reelProgress = 0;
      this.setState(WS.REEL);
    }
  }

  /** Roll what this worker catches, using the same tables the player uses. */
  rollCatch(game) {
    const regionId = this.assignment?.startsWith('fish:') ? this.assignment.slice(5)
      : (regionAt(this.position.x, this.position.z)?.id || 'crash');
    const region = REGION_BY_ID[regionId] || REGION_BY_ID.crash;
    const depth = Math.max(1, waterHeightAt(this.castTarget.x, this.castTarget.z) - worldHeight(this.castTarget.x, this.castTarget.z));

    if (rchance(this.d.junkChance)) {
      const junk = rpick(['boot', 'tin-can', 'seaweed-clump']);
      const sp = getSpecies(junk);
      if (sp) return rollFishInstance(sp, this.rng, {});
    }

    const pool = speciesInRegion(region.id).filter((s) => !s.boss && s.depth[0] <= depth * 1.6);
    if (!pool.length) return null;
    const sky = game.get('sky');
    const weather = game.get('weather');
    const cands = pool.map((s) => {
      let w = s.spawnWeight;
      if (s.time !== 'any' && sky) {
        const night = sky.isNight;
        if ((s.time === 'night') !== night) w *= 0.2;
      }
      if (s.weather !== 'any' && weather) w *= s.weather === weather.current.id ? 2 : 0.3;
      // A better worker reaches deeper into the rarer end of the table.
      const rarityIdx = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].indexOf(s.rarity);
      w *= Math.pow(this.d.catchQuality, rarityIdx * 0.8);
      // Cannot land what their gear can't lift.
      if (s.weight[0] > this.d.maxWeight) w *= 0.02;
      return { s, weight: Math.max(0.001, w) };
    });
    const pick = weightedPick(cands, this.rng)?.s;
    if (!pick) return null;
    const inst = rollFishInstance(pick, this.rng, { luck: this.d.catchQuality });
    // Oversized fish break the line — a real reason to upgrade their gear.
    if (inst.weight > this.d.maxWeight * 1.6) {
      if (this.physical) {
        this.game.audio.play('line_snap', { volume: 0.4, position: this.position.clone() });
        this.say('gear');
      }
      bus.emit('worker:lostFish', { worker: this, instance: inst });
      return null;
    }
    return inst;
  }

  tickReel(dt, game) {
    const inst = this.fishOnLine;
    if (!inst) { this.setState(WS.CAST); return; }
    const difficulty = clamp(inst.weight / Math.max(1, this.d.maxWeight), 0.05, 1.4);
    const rate = (0.5 * this.d.reelSpeed) / (0.4 + difficulty * 1.6);
    this.reelProgress = clamp01(this.reelProgress + dt * rate);
    if (this.bobber) {
      const t = this.reelProgress;
      const y = waterHeightAt(this.castTarget.x, this.castTarget.z);
      this.bobber.position.set(
        lerp(this.castTarget.x, this.position.x, t),
        lerp(y, this.position.y + 1.1, t * t),
        lerp(this.castTarget.z, this.position.z, t),
      );
      if (this.physical && rchance(dt * 3)) {
        game.audio.play('reel_click', { volume: 0.05, position: this.position.clone(), throttle: 90 });
      }
    }
    if (this.reelProgress >= 1) {
      this.landFish(game, inst);
    }
  }

  landFish(game, inst) {
    this.fishOnLine = null;
    this.clearFishingLine();
    const eco = game.get('economy');
    this.stats.caught++;
    this.stats.biggest = Math.max(this.stats.biggest, inst.weight);
    this.addXP(getSpecies(inst.speciesId)?.xp ?? 5, game);
    eco?.recordCatch(inst, this.name);
    bus.emit('worker:caught', { worker: this, instance: inst });

    const rarity = RARITY[inst.rarity] || RARITY.common;
    if (['legendary', 'mythic'].includes(inst.rarity) || inst.variantId !== 'normal') this.say('rare');
    else if (inst.weight > this.d.maxWeight * 0.6) this.say('bigCatch');
    else this.say('catch');

    if (this.physical) {
      game.audio.play('splash_medium', { volume: 0.45, position: this.castTarget.clone() });
      bus.emit('fx:splash', { position: this.castTarget.clone(), scale: clamp(0.4 + inst.weight * 0.02, 0.4, 1.6) });
      // Big or dropped fish become real physics objects on the ground.
      if (inst.weight > 3 || rchance(this.d.dropChance)) {
        const mgr = game.get('physfish');
        _v.copy(this.position).sub(this.castTarget).setY(0).normalize();
        mgr?.spawn({
          instance: inst,
          position: { x: this.position.x + _v.x * -1.2, y: this.position.y + 1.4, z: this.position.z + _v.z * -1.2 },
          velocity: { x: _v.x * 2.5, y: 3.4, z: _v.z * 2.5 },
          angularVelocity: { x: rrange(-4, 4), y: rrange(-5, 5), z: rrange(-4, 4) },
        });
        bus.emit('fx:floatText', {
          position: new THREE.Vector3(this.position.x, this.position.y + 2.1, this.position.z),
          text: inst.name, color: rarity.color, size: 15,
        });
        // The worker will pick it up again.
        this.carrying = null;
        this.setState(WS.CAST);
        return;
      }
    }
    this.carrying = inst;
    this.setState(WS.HANDLE_CATCH);
  }

  tickHandle(dt, game) {
    if (this.stateTime > 0.8) {
      this.deliverTo = this.pickDeliveryPoint(game);
      this.setState(WS.CARRY_FISH);
      if (this.physical && this.carrying) this.makeCarryMesh(game);
    }
  }

  pickDeliveryPoint(game) {
    const world = game.get('world');
    const regionId = regionAt(this.position.x, this.position.z)?.id || 'crash';
    const anchors = world?.getAnchors(regionId);
    // Prefer the company warehouse, then the sell station.
    const harbor = game.get('harbor');
    if (harbor?.storagePoint) return { ...harbor.storagePoint, kind: 'store' };
    if (anchors?.sell) return { x: anchors.sell.x, y: anchors.sell.y, z: anchors.sell.z, kind: 'sell' };
    return { x: this.position.x, y: this.position.y, z: this.position.z, kind: 'store' };
  }

  tickCarry(dt, game) {
    if (!this.carrying) { this.setState(WS.IDLE); return; }
    const d = this.deliverTo;
    if (!d) { this.setState(WS.STORE_FISH); return; }
    if (!this.navTarget) this.setNavTarget(d.x, d.y, d.z);
    if (this.navigate(dt, 1.8)) this.setState(WS.STORE_FISH);
    // Very heavy fish slow the worker down noticeably.
    if (this.carrying.weight > 20) this.velocity.multiplyScalar(0.7);
  }

  tickStore(dt, game) {
    if (this.stateTime < 0.5) return;
    const inst = this.carrying;
    this.carrying = null;
    if (this.carryMesh && this.physical) { this.object.remove(this.carryMesh); this.carryMesh = null; }
    if (!inst) { this.setState(WS.IDLE); return; }

    const eco = game.get('economy');
    const mgr = game.get('workers');
    const price = Math.round((eco?.priceFor(inst, { freshness: this.d.freshness }) ?? inst.value)
      * (mgr?.managerBonus?.price ? 1 + mgr.managerBonus.price : 1));
    eco?.add(price, 'worker_sales');
    eco?.recordSale(inst, price, this.name);
    this.stats.revenue += price;
    bus.emit('worker:sold', { worker: this, instance: inst, price });
    if (this.physical) {
      game.audio.play('coin', { volume: 0.4, position: this.position.clone(), rate: rrange(0.9, 1.15), throttle: 120 });
      bus.emit('fx:floatText', {
        position: new THREE.Vector3(this.position.x, this.position.y + 2.0, this.position.z),
        text: `+${formatMoneyExact(price)}`, color: '#ffc22e', size: 16,
      });
      bus.emit('fx:moneyBurst', { position: this.position.clone(), amount: price });
    }
    // Straight back to work.
    this.setState(this.fatigue > 0.9 ? WS.REST : WS.WALK_TO_JOB);
    this.navTarget = null;
  }

  tickRest(dt, game) {
    this.velocity.multiplyScalar(Math.pow(0.001, dt));
    if (this.stateTime > 3 && this.talkCooldown <= 0) this.say('tired');
    if (this.fatigue < 0.15 && this.assignment && this.assignment !== 'rest') {
      this.setState(WS.IDLE);
    }
  }

  tickProcess(dt, game) {
    const proc = game.get('processing');
    this.velocity.multiplyScalar(Math.pow(0.01, dt));
    if (this.stateTime > 2.2) {
      this.stateTime = 0;
      this.addXP(3, game);
      if (this.physical) {
        game.audio.play('club_hit', { volume: 0.16, position: this.position.clone(), rate: rrange(1.1, 1.4), throttle: 400 });
      }
    }
  }

  tickRepair(dt, game) {
    this.velocity.multiplyScalar(Math.pow(0.01, dt));
    const boats = game.get('boats');
    if (this.stateTime > 2.5) {
      this.stateTime = 0;
      const rate = 1.4 * (1 + this.treeBonus('repairSpeed') + this.traitSum('repairSpeed'));
      boats?.repairAny?.(rate);
      this.addXP(3, game);
      if (this.physical) game.audio.play('harpoon_impact', { volume: 0.13, position: this.position.clone(), rate: 1.4, throttle: 500 });
    }
  }

  tickOnBoat(dt, game) {
    // Position is driven by the fleet/boat systems; just idle-animate here.
    this.velocity.multiplyScalar(Math.pow(0.02, dt));
  }

  addXP(n, game) {
    this.xp += n * this.d.xpMult;
    let leveled = false;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      leveled = true;
      // Auto-spend a tree point on the least-invested node.
      const tree = this.roleDef.tree;
      let best = null, bestPts = Infinity;
      for (const node of tree) {
        const p = this.treePoints[node.id] || 0;
        if (p < node.max && p < bestPts) { bestPts = p; best = node; }
      }
      if (best) this.treePoints[best.id] = (this.treePoints[best.id] || 0) + 1;
      // Skills grow with level too.
      for (const k of this.roleDef.primary) this.skills[k] = Math.min(10, this.skills[k] + 1);
    }
    if (leveled) {
      this.recomputeDerived();
      bus.emit('worker:levelup', { worker: this, level: this.level });
      bus.emit('toast', { text: `⭐ <b>${this.name}</b> reached level ${this.level}`, kind: 'success' });
      game.audio.play('levelup', { volume: 0.35 });
    }
  }

  // ------------------------------------------------------------- visuals
  makeFishingLine(game) {
    if (!this.physical || this.bobber) return;
    const bob = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.5 }),
    );
    bob.position.copy(this.castTarget);
    game.scene.add(bob);
    this.bobber = bob;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xeaf4fb, transparent: true, opacity: 0.6 }));
    this.line.frustumCulled = false;
    game.scene.add(this.line);
  }

  clearFishingLine() {
    const scene = this.game.scene;
    if (this.bobber) { scene.remove(this.bobber); this.bobber.geometry.dispose(); this.bobber.material.dispose(); this.bobber = null; }
    if (this.line) { scene.remove(this.line); this.line.geometry.dispose(); this.line.material.dispose(); this.line = null; }
  }

  makeCarryMesh(game) {
    if (!this.physical || !this.carrying) return;
    const fishSys = game.get('fish');
    const sp = getSpecies(this.carrying.speciesId);
    if (!sp || !fishSys) return;
    const m = fishSys.buildMesh(sp, this.carrying);
    m.scale.setScalar(this.carrying.length);
    m.position.set(0, 1.05, 0.42);
    m.rotation.set(0, Math.PI / 2, 0.25);
    this.object.add(m);
    this.carryMesh = m;
  }

  animate(dt, game) {
    const o = this.object;
    const rig = this.rig;
    if (!o || !rig) return;
    o.position.copy(this.position);
    o.rotation.y = this.facing;

    const speed = this.velocity.length();
    const moving = speed > 0.15;
    const stride = moving ? clamp(speed / 2.6, 0.2, 1.3) : 0;

    // Walk cycle.
    const p = this.walkPhase;
    const swing = Math.sin(p) * 0.62 * stride;
    const swing2 = Math.sin(p + Math.PI) * 0.62 * stride;
    rig.legs.L.hip.rotation.x = swing;
    rig.legs.R.hip.rotation.x = swing2;
    rig.legs.L.knee.rotation.x = Math.max(0, -Math.sin(p) * 0.7) * stride;
    rig.legs.R.knee.rotation.x = Math.max(0, -Math.sin(p + Math.PI) * 0.7) * stride;
    rig.hips.position.y = rig.legLen + 0.06 + Math.abs(Math.sin(p)) * 0.035 * stride;
    rig.torso.rotation.z = Math.sin(p) * 0.045 * stride;
    rig.torso.rotation.x = stride * 0.09;

    // Arms: state-driven poses layered over the walk swing.
    const armL = rig.arms.L, armR = rig.arms.R;
    let targetRX_L = swing2 * 0.8, targetRX_R = swing * 0.8;
    let targetRZ_L = 0.09, targetRZ_R = -0.09;
    let elbowL = 0.18, elbowR = 0.18;

    switch (this.state) {
      case WS.CAST: {
        const t = clamp01(this.stateTime / 1.2);
        // Wind back, then whip forward.
        const windup = clamp01(t / 0.46);
        const release = clamp01((t - 0.46) / 0.3);
        targetRX_R = lerp(-0.4, -2.5, windup) + release * 2.9;
        targetRX_L = targetRX_R * 0.6;
        elbowR = lerp(0.4, 1.5, windup) * (1 - release);
        elbowL = elbowR * 0.7;
        targetRZ_R = -0.28; targetRZ_L = 0.22;
        break;
      }
      case WS.WAIT_BITE:
        targetRX_R = -0.95; targetRX_L = -0.85;
        elbowR = 0.85; elbowL = 0.95;
        targetRZ_R = -0.24; targetRZ_L = 0.26;
        break;
      case WS.HOOK_FISH:
        targetRX_R = -1.9; targetRX_L = -1.5;
        elbowR = 1.2; elbowL = 1.3;
        break;
      case WS.REEL: {
        targetRX_R = -1.0 - this.reelProgress * 0.35;
        targetRX_L = -0.9;
        elbowR = 1.0; elbowL = 1.05 + Math.sin(this.stateTime * 14) * 0.35;
        targetRZ_R = -0.26; targetRZ_L = 0.3;
        break;
      }
      case WS.HANDLE_CATCH:
      case WS.CARRY_FISH:
        targetRX_R = -1.35; targetRX_L = -1.35;
        elbowR = 0.95; elbowL = 0.95;
        targetRZ_R = -0.35; targetRZ_L = 0.35;
        break;
      case WS.PROCESS:
        targetRX_R = -1.15 + Math.sin(this.stateTime * 8) * 0.35;
        targetRX_L = -1.0;
        elbowR = 1.1; elbowL = 1.1;
        break;
      case WS.REPAIR:
        targetRX_R = -1.4 + Math.sin(this.stateTime * 6) * 0.5;
        targetRX_L = -1.2;
        elbowR = 1.3; elbowL = 1.2;
        break;
      case WS.REST:
        targetRX_R = 0.12; targetRX_L = 0.12;
        elbowR = 0.1; elbowL = 0.1;
        rig.torso.rotation.x = 0.14;
        break;
      case WS.USE_HARPOON:
        targetRX_R = -1.55; targetRX_L = -1.45;
        elbowR = 0.5; elbowL = 0.9;
        break;
    }
    const k = 1 - Math.pow(0.0008, dt);
    armL.shoulder.rotation.x = lerp(armL.shoulder.rotation.x, targetRX_L, k);
    armR.shoulder.rotation.x = lerp(armR.shoulder.rotation.x, targetRX_R, k);
    armL.shoulder.rotation.z = lerp(armL.shoulder.rotation.z, targetRZ_L, k);
    armR.shoulder.rotation.z = lerp(armR.shoulder.rotation.z, targetRZ_R, k);
    armL.elbow.rotation.x = lerp(armL.elbow.rotation.x, -elbowL, k);
    armR.elbow.rotation.x = lerp(armR.elbow.rotation.x, -elbowR, k);

    // Head looks at the thing that matters.
    let lookAt = null;
    if (this.state === WS.WAIT_BITE || this.state === WS.REEL || this.state === WS.CAST) lookAt = this.castTarget;
    else if (this.navTarget) lookAt = this.navTarget;
    if (lookAt) {
      const dx = lookAt.x - this.position.x, dz = lookAt.z - this.position.z;
      const want = Math.atan2(dx, dz) - this.facing;
      rig.head.rotation.y = lerp(rig.head.rotation.y, clamp(wrapAngle(want), -0.9, 0.9), k * 0.6);
      const dy = lookAt.y - (this.position.y + 1.5);
      rig.head.rotation.x = lerp(rig.head.rotation.x, clamp(-Math.atan2(dy, Math.hypot(dx, dz)) * 0.6, -0.5, 0.5), k * 0.6);
    } else {
      rig.head.rotation.y = damp(rig.head.rotation.y, Math.sin(game.time * 0.4 + this.seed) * 0.25, 0.3, dt);
      rig.head.rotation.x = damp(rig.head.rotation.x, 0, 0.3, dt);
    }

    // Fishing line follows the rod tip.
    if (this.line && this.bobber) {
      const tipObj = this.tool?.userData?.tip;
      if (tipObj) tipObj.getWorldPosition(_v);
      else _v.set(this.position.x, this.position.y + 1.5, this.position.z);
      const arr = this.line.geometry.attributes.position.array;
      arr[0] = _v.x; arr[1] = _v.y; arr[2] = _v.z;
      arr[3] = this.bobber.position.x; arr[4] = this.bobber.position.y; arr[5] = this.bobber.position.z;
      this.line.geometry.attributes.position.needsUpdate = true;
      this.line.geometry.computeBoundingSphere();
    }
  }

  // ------------------------------------------------------------- persistence
  serialize() {
    return {
      id: this.id, seed: this.seed, name: this.name, role: this.role,
      level: this.level, xp: this.xp, skills: this.skills,
      traits: this.traits.map((t) => t.id), morale: this.morale, wage: this.wage,
      equipment: this.equipment, assignment: this.assignment, assignmentData: this.assignmentData,
      stats: this.stats, treePoints: this.treePoints, hiredDay: this.hiredDay,
      x: this.position.x, y: this.position.y, z: this.position.z,
    };
  }
}

function defaultSkills() {
  const s = {};
  for (const k of SKILLS) s[k] = 3;
  return s;
}

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
function angleDamp(cur, target, rate, dt) {
  return cur + wrapAngle(target - cur) * (1 - Math.pow(rate, dt));
}
