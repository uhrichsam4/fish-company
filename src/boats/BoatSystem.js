import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { buildBoatMesh } from './BoatMesh.js';
import { BOATS, BOAT_BY_ID, BOAT_UPGRADES, UPGRADE_BY_ID, upgradeCost, effectiveStats } from '../data/boats.js';
import { CG, groups, applyBuoyancy, RAPIER } from '../physics/PhysicsWorld.js';
import { waterHeightAt, waterNormalAt, waterVelocityAt, waveState } from '../world/waves.js';
import { worldHeight } from '../world/Terrain.js';
import { REGION_BY_ID, regionAt } from '../data/regions.js';
import {
  clamp, clamp01, lerp, damp, rrange, rchance, formatMoneyExact, formatWeight, dist2DSq, TAU,
} from '../util/math.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

let _boatId = 1;

/**
 * Owns every boat the player owns: buying, upgrading, physics, driving and the
 * physical/simulated split. A boat within `NEAR` of the player is a real Rapier
 * body with buoyancy; beyond that it's a position + heading integrated cheaply.
 */
export class BoatSystem {
  constructor(game) {
    this.game = game;
    this.name = 'boats';
    this.order = 76;
    this.owned = [];
    this.catalogue = BOATS;
    this.upgrades = BOAT_UPGRADES;
    this.root = null;
    this.driving = null;        // boat instance the player is piloting
    this.nearRadius = 260;
    this.cameraMode = 0;        // 0 = first person at helm, 1 = chase
    this.chaseDist = 12;
    this._engineLoop = null;
    this._wakeLoop = null;
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'boats';
    game.scene.add(this.root);

    bus.on('company:buyBoat', ({ id }) => this.buy(id));
    bus.on('company:repairBoat', ({ id }) => this.repair(id));
    bus.on('company:refuelBoat', ({ id }) => this.refuel(id));
    bus.on('company:upgradeBoat', ({ id }) => bus.emit('ui:show', { id: 'boatUpgrade', data: { id } }));
    bus.on('company:upgradeApply', ({ id, upgrade }) => this.applyUpgrade(id, upgrade));
    bus.on('debug:giveBoat', ({ all }) => {
      if (all) for (const d of BOATS) this.grant(d.id);
      else {
        const next = BOATS.find((d) => !this.owned.some((b) => b.defId === d.id));
        if (next) this.grant(next.id);
      }
    });
    bus.on('interact:boardBoat', ({ boatId }) => this.board(boatId));
    return this;
  }

  // ------------------------------------------------------------- ownership
  isUnlocked(def) {
    const quests = this.game.get('quests');
    const research = this.game.get('research');
    if (def.unlockRegion && quests && !quests.isRegionUnlocked(def.unlockRegion)) return false;
    if (def.requiresResearch && research && !research.has(def.requiresResearch)) return false;
    return true;
  }

  buy(defId) {
    const def = BOAT_BY_ID[defId];
    if (!def) return null;
    if (!this.isUnlocked(def)) {
      bus.emit('toast', { text: `${def.name} is not available yet.`, kind: 'error' });
      return null;
    }
    const eco = this.game.get('economy');
    if (!eco.spend(def.price, 'boat')) return null;
    const b = this.grant(defId);
    this.game.audio.play('purchase', { volume: 0.8 });
    bus.emit('toast', { text: `🚤 Bought <b>${def.name}</b>`, kind: 'success', duration: 5000 });
    return b;
  }

  grant(defId, data = {}) {
    const def = BOAT_BY_ID[defId];
    if (!def) return null;
    const world = this.game.get('world');
    const region = data.region || world?.activeRegion?.id || 'crash';
    const anchors = world?.getAnchors(region);
    const dock = anchors?.dockEnd || { x: 0, z: 0 };
    const outward = anchors?.outward || { x: 1, z: 0 };
    const side = anchors?.side || { x: 0, z: 1 };
    const slot = this.owned.filter((b) => b.region === region).length;
    const px = data.x ?? (dock.x + outward.x * 3.5 + side.x * (2 + slot * (def.hull.width + 1.5)));
    const pz = data.z ?? (dock.z + outward.z * 3.5 + side.z * (2 + slot * (def.hull.width + 1.5)));

    const b = {
      id: data.id || `b${_boatId++}`,
      defId, def,
      name: data.name || generateBoatName(defId, this.owned.length),
      icon: def.icon,
      upgrades: data.upgrades || {},
      fuel: data.fuel ?? def.fuel,
      health: data.health ?? 100,
      region,
      position: new THREE.Vector3(px, 0, pz),
      heading: data.heading ?? Math.atan2(outward.x, outward.z),
      velocity: new THREE.Vector3(),
      angularVel: 0,
      throttle: 0,
      steer: 0,
      physical: false,
      entry: null,
      object: null,
      cargo: data.cargo || [],
      cargoWeight: data.cargoWeight || 0,
      fleet: null,
      docked: true,
      locationLabel: REGION_BY_ID[region]?.short || 'Docked',
      engineOn: false,
      trips: 0,
      lifetimeProfit: data.lifetimeProfit || 0,
      _wear: 0,
    };
    b.stats = effectiveStats(def, b.upgrades);
    this.owned.push(b);
    bus.emit('boats:changed', { count: this.owned.length, boat: b });
    return b;
  }

  sell(id) {
    const i = this.owned.findIndex((b) => b.id === id);
    if (i < 0) return;
    const b = this.owned[i];
    if (this.driving === b) this.disembark();
    this.despawnPhysical(b);
    const eco = this.game.get('economy');
    eco?.add(Math.round(b.def.price * 0.55), 'boat_sale');
    this.owned.splice(i, 1);
    bus.emit('boats:changed', { count: this.owned.length });
  }

  byId(id) { return this.owned.find((b) => b.id === id) || null; }
  totalValue() { return this.owned.reduce((a, b) => a + b.def.price * 0.6, 0); }

  applyUpgrade(id, upgradeId) {
    const b = this.byId(id);
    const u = UPGRADE_BY_ID[upgradeId];
    if (!b || !u) return;
    const lvl = b.upgrades[upgradeId] || 0;
    if (lvl >= u.max) { bus.emit('toast', { text: `${u.name} already maxed.`, kind: 'warn' }); return; }
    const research = this.game.get('research');
    if (u.requiresResearch && research && !research.has(u.requiresResearch)) {
      bus.emit('toast', { text: `Requires research: ${u.requiresResearch}`, kind: 'error' });
      return;
    }
    const cost = upgradeCost(upgradeId, lvl);
    const eco = this.game.get('economy');
    if (!eco.spend(cost, 'boat_upgrade')) return;
    b.upgrades[upgradeId] = lvl + 1;
    b.stats = effectiveStats(b.def, b.upgrades);
    b.fuel = Math.min(b.fuel, b.stats.fuel);
    this.game.audio.play('purchase', { volume: 0.6 });
    bus.emit('toast', { text: `${b.name}: ${u.name} → level ${lvl + 1}`, kind: 'success' });
    bus.emit('boats:changed', { count: this.owned.length, boat: b });
  }

  repair(id, freeAmount = 0) {
    const b = this.byId(id);
    if (!b) return;
    const missing = 100 - b.health;
    if (missing < 0.5) { bus.emit('toast', { text: `${b.name} is undamaged.`, kind: 'muted' }); return; }
    const research = this.game.get('research');
    const cost = Math.round(missing * b.def.price * 0.004 * (research?.repairMult ?? 1));
    const eco = this.game.get('economy');
    if (freeAmount <= 0 && !eco.spend(cost, 'repairs')) return;
    if (eco) eco.today.repairs += cost;
    b.health = 100;
    this.game.audio.play('purchase', { volume: 0.5 });
    bus.emit('toast', { text: `${b.name} repaired for ${formatMoneyExact(cost)}`, kind: 'success' });
  }

  /** Called by mechanic workers. */
  repairAny(amount) {
    const b = this.owned.filter((x) => x.health < 100).sort((a, c) => a.health - c.health)[0];
    if (!b) return false;
    b.health = Math.min(100, b.health + amount);
    return true;
  }

  refuel(id) {
    const b = this.byId(id);
    if (!b) return;
    const need = b.stats.fuel - b.fuel;
    if (need < 0.5) { bus.emit('toast', { text: `${b.name} is full.`, kind: 'muted' }); return; }
    const research = this.game.get('research');
    const cost = Math.round(need * 2.4 * (research?.fuelMult ?? 1));
    const eco = this.game.get('economy');
    if (!eco.spend(cost, 'fuel')) return;
    eco.today.fuel += cost;
    b.fuel = b.stats.fuel;
    this.game.audio.play('purchase', { volume: 0.45 });
    bus.emit('toast', { text: `${b.name} refuelled for ${formatMoneyExact(cost)}`, kind: 'success' });
  }

  // ------------------------------------------------------------- physical
  spawnPhysical(b) {
    if (b.physical) return;
    const def = b.def;
    b.object = buildBoatMesh(def, { seed: hashId(b.id) });
    this.root.add(b.object);

    const p = def.physics;
    b.entry = this.game.physics.addBody({
      type: 'dynamic',
      position: { x: b.position.x, y: waterHeightAt(b.position.x, b.position.z) + p.hy * 0.4, z: b.position.z },
      rotation: _q.setFromAxisAngle(UP, b.heading),
      shape: [
        { kind: 'box', hx: p.hx * 0.94, hy: p.hy, hz: p.hz * 0.94, friction: 0.9, restitution: 0.12,
          groups: groups(CG.BOAT, 0xffff) },
      ],
      object3d: b.object,
      tag: 'boat',
      linearDamping: 0.30,
      angularDamping: 1.5,
      additionalMass: def.mass,
      canSleep: false,
      userData: { boat: b, rideable: true, surface: 'wood' },
    });

    // Deck colliders so the player can stand on it while it moves.
    for (const d of def.deck) {
      const col = this.game.physics.world.createCollider(
        makeDeckCollider(d, def.hull.height * 0.26),
        b.entry.body,
      );
      col.setFriction(1.4);
      col.setCollisionGroups(groups(CG.BOAT, 0xffff));
      b.entry.colliders.push(col);
      this.game.physics.byCollider.set(col.handle, b.entry);
    }

    b.samples = buildBuoyancySamples(p);
    b.volume = def.mass / 1000 * 2.7;   // displaces ~2.7x its own mass in water
    b.physical = true;
    bus.emit('boat:spawned', { boat: b });
  }

  despawnPhysical(b) {
    if (!b.physical) return;
    if (b.wakeHandle) { b.wakeHandle.stop?.(); b.wakeHandle = null; }
    this.game.physics.remove(b.entry);
    this.root.remove(b.object);
    b.entry = null; b.object = null; b.physical = false;
  }

  // ------------------------------------------------------------- driving
  board(boatId) {
    const b = this.byId(boatId);
    if (!b) return;
    if (!b.physical) this.spawnPhysical(b);
    const player = this.game.get('player');
    this.driving = b;
    // Interaction (order 65) boards on the same E press this system (order 76)
    // reads a few systems later — swallow it until the key comes back up, or
    // boarding and leaving happen in a single frame.
    this._ignoreE = true;
    b.engineOn = b.def.fuel === 0 || b.fuel > 0;
    player.mode = 'boat';
    player.canMove = false;
    this.game.audio.play('boat_engine_start', { volume: 0.6 });
    bus.emit('toast', { text: `Piloting <b>${b.name}</b> — WASD to drive, Space brake, F lights, E to leave`, kind: '', duration: 6000 });
    bus.emit('boat:boarded', { boat: b });
  }

  disembark() {
    const b = this.driving;
    if (!b) return;
    const player = this.game.get('player');
    this.driving = null;
    this._ignoreE = false;
    player.mode = 'walk';
    player.canMove = true;
    // Step onto the deck rather than into the sea.
    if (b.object) {
      b.object.userData.helm.getWorldPosition(_v);
      player.teleport(_v.x, _v.y + 1.2, _v.z + 1.5);
    }
    if (this._engineLoop) { this._engineLoop.stop(0.4); this._engineLoop = null; }
    this.game.audio.play('boat_engine_stop', { volume: 0.5 });
    bus.emit('boat:left', { boat: b });
  }

  update(dt, game) {
    if (dt <= 0) return;
    const player = game.get('player');
    if (!player) return;

    for (const b of this.owned) {
      const near = dist2DSq(b.position.x, b.position.z, player.position.x, player.position.z)
        < this.nearRadius * this.nearRadius;
      if (near && !b.physical) this.spawnPhysical(b);
      else if (!near && b.physical && this.driving !== b) this.despawnPhysical(b);

      if (b.physical) this.updatePhysical(b, dt, game);
      else this.updateSimulated(b, dt, game);
    }

    if (this.driving) this.updateDriving(this.driving, dt, game);
    this.updateInteractables(game);
  }

  updatePhysical(b, dt, game) {
    const phys = game.physics;
    const e = b.entry;
    if (!e || e.removed) { b.physical = false; return; }

    // ---- buoyancy ----
    applyBuoyancy(phys, e, b.samples, {
      waterHeightAt, volume: b.volume, dragLinear: 0.55, dragAngular: 2.4,
      density: 1000, dt, sampleHeight: b.def.physics.hy * 1.05,
      waveVelAt: (x, z) => waterVelocityAt(x, z),
    });

    const t = e.body.translation();
    b.position.set(t.x, t.y, t.z);
    const r = e.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _e.setFromQuaternion(_q, 'YXZ');
    b.heading = _e.y;
    const lv = e.body.linvel();
    b.velocity.set(lv.x, lv.y, lv.z);
    const speed = Math.hypot(lv.x, lv.z);
    b.speed = speed;

    // ---- propulsion ----
    if (b.engineOn && (b.throttle !== 0 || b.steer !== 0)) {
      const s = b.stats;
      const fwd = _v.set(Math.sin(b.heading), 0, Math.cos(b.heading));
      // Thrust falls off as speed approaches the boat's top speed.
      const speedFrac = clamp01(speed / Math.max(1, s.speed));
      // Impulses, not forces: Rapier's addForce persists until resetForces(),
      // so calling it every frame compounds and the boat reaches Mach 3.
      const thrust = b.throttle * s.speed * b.def.mass * 4.2 * (1 - speedFrac * 0.7) * dt;
      e.body.applyImpulse({ x: fwd.x * thrust, y: 0, z: fwd.z * thrust }, true);
      // Steering authority scales with speed — you can't turn a stopped hull.
      const steerAuth = clamp01(speed / 2.0) * 0.35 + 0.12;
      const torque = -b.steer * s.handling * b.def.mass * 3.4 * steerAuth * dt;
      e.body.applyTorqueImpulse({ x: 0, y: torque, z: 0 }, true);
      // Fuel burn.
      if (b.def.fuel > 0) {
        const research = game.get('research');
        b.fuel = Math.max(0, b.fuel - Math.abs(b.throttle) * b.stats.fuelUse * dt * 0.35 * (research?.fuelMult ?? 1));
        if (b.fuel <= 0 && b.engineOn) {
          b.engineOn = false;
          bus.emit('toast', { text: `${b.name} is out of fuel.`, kind: 'error' });
          game.audio.play('boat_engine_stop', { volume: 0.5, position: b.position.clone() });
        }
      }
    }

    // Self-righting torque: hulls have a low centre of gravity in reality; a
    // box collider doesn't, so nudge the up-axis back toward vertical.
    {
      _v.set(0, 1, 0).applyQuaternion(_q);
      const tilt = 1 - _v.y;
      if (tilt > 0.002) {
        _v2.crossVectors(_v, UP);
        const k = b.def.mass * 0.9 * dt;
        e.body.applyTorqueImpulse({ x: _v2.x * k, y: 0, z: _v2.z * k }, true);
      }
    }

    // Anti-sink failsafe: a hull should never be dragged under by wave drag.
    {
      const wy = waterHeightAt(t.x, t.z);
      const sink = wy - t.y;
      if (sink > b.def.physics.hy * 0.9) {
        e.body.applyImpulse({ x: 0, y: (sink - b.def.physics.hy * 0.9) * b.def.mass * 9 * dt, z: 0 }, true);
      }
    }

    // Hard speed cap so the catalogue's `speed` stat is the real top speed.
    // Arcade boat handling wants a predictable ceiling, not an emergent one.
    {
      const maxSpeed = b.stats.speed * (b.throttle < -0.05 ? 0.42 : 1) * clamp(0.35 + b.health / 100 * 0.65, 0.35, 1);
      if (speed > maxSpeed && speed > 0.01) {
        const f = maxSpeed / speed;
        e.body.setLinvel({ x: lv.x * f, y: lv.y, z: lv.z * f }, true);
        b.velocity.set(lv.x * f, lv.y, lv.z * f);
        b.speed = maxSpeed;
      }
    }

    // Lateral resistance: hulls slide much less sideways than forward.
    const fwd2 = _v.set(Math.sin(b.heading), 0, Math.cos(b.heading));
    const right = _v2.set(fwd2.z, 0, -fwd2.x);
    const lateral = right.dot(_v3.set(lv.x, 0, lv.z));
    e.body.applyImpulse({ x: -right.x * lateral * b.def.mass * 0.9 * dt, y: 0, z: -right.z * lateral * b.def.mass * 0.9 * dt }, true);

    // ---- presentation ----
    const ud = b.object.userData;
    ud.prop.rotation.z += dt * (6 + Math.abs(b.throttle) * 34);
    const sky = game.get('sky');
    const night = sky ? 1 - sky.dayFactor : 0;
    const lightOn = night > 0.35 || b.lightsOn;
    for (const l of ud.lights) l.material.emissiveIntensity = lightOn ? 2.4 : 0;

    // Wake + spray.
    if (speed > 1.2) {
      if (!b.wakeHandle) {
        bus.emit('fx:wake', { object: b.object, opts: { width: b.def.hull.width * 0.9 },
          register: (h) => { b.wakeHandle = h; } });
      }
      if (speed > 3 && rchance(dt * clamp(speed * 0.8, 1, 14))) {
        ud.bowSpray.getWorldPosition(_v);
        bus.emit('fx:spray', { position: _v.clone(), direction: fwd2.clone(), amount: clamp01(speed / 12) });
      }
      bus.emit('ocean:ripple', { x: b.position.x, z: b.position.z, strength: clamp01(speed / 16) * 0.35 });
    } else if (b.wakeHandle) { b.wakeHandle.stop?.(); b.wakeHandle = null; }

    // Engine audio, pitched by throttle.
    if (b.engineOn && b.def.fuel > 0) {
      const key = `boat_engine_loop`;
      if (this.driving === b) {
        if (!this._engineLoop) this._engineLoop = game.audio.loop(key, { volume: 0.5 });
        this._engineLoop?.setRate(lerp(0.72, 1.5, clamp01(Math.abs(b.throttle) * 0.6 + speed / Math.max(1, b.stats.speed) * 0.5)), 0.18);
        this._engineLoop?.setVolume(lerp(0.35, 0.85, clamp01(Math.abs(b.throttle))), 0.2);
      }
    }

    // ---- collision damage ----
    if (!e.onContact) {
      e.onContact = (other, started) => {
        if (!started || !other) return;
        if (other.tag === 'fish' || other.tag === 'player') return;
        if (other.tag === 'terrain' && b.position.y - b.def.physics.draft > worldHeight(b.position.x, b.position.z) + 0.8) return;
        const v = phys.getVelocity(e, _v).length();
        if (v < 5.5) return;
        const dmg = clamp((v - 5.5) * 0.7, 0, 18);
        b.health = Math.max(0, b.health - dmg);
        game.audio.play('boat_impact', { volume: clamp01(v / 12), position: b.position.clone(), throttle: 200 });
        bus.emit('fx:impact', { position: b.position.clone(), normal: UP.clone(), kind: 'wood' });
        if (this.driving === b) bus.emit('player:shake', clamp01(v / 10) * 0.6);
        if (b.health <= 0) {
          bus.emit('toast', { text: `${b.name} is wrecked! Repair it before using it again.`, kind: 'error' });
          b.engineOn = false;
        }
      };
    }

    // Grounding: shove the hull back off the seabed.
    const bed = worldHeight(b.position.x, b.position.z);
    if (b.position.y - b.def.physics.draft < bed + 0.2) {
      _v.set(b.position.x - (regionAt(b.position.x, b.position.z)?.x ?? b.position.x),
        0, b.position.z - (regionAt(b.position.x, b.position.z)?.z ?? b.position.z));
      if (_v.lengthSq() > 1e-4) {
        _v.normalize().multiplyScalar(b.def.mass * 2.2 * dt);
        e.body.applyImpulse({ x: _v.x, y: b.def.mass * 1.2 * dt, z: _v.z }, true);
      }
      if (b.speed > 4) {
        b.health = Math.max(0, b.health - dt * 4);
        game.audio.play('boat_impact', { volume: 0.4, position: b.position.clone(), throttle: 700 });
      }
    }

    b.locationLabel = regionAt(b.position.x, b.position.z)?.short || 'At sea';
  }

  /** Cheap integration for boats the player can't see. */
  updateSimulated(b, dt, game) {
    if (b.throttle !== 0) {
      const s = b.stats;
      const spd = s.speed * b.throttle * 0.8;
      b.heading += b.steer * s.handling * dt * 1.2;
      b.position.x += Math.sin(b.heading) * spd * dt;
      b.position.z += Math.cos(b.heading) * spd * dt;
      b.speed = Math.abs(spd);
      if (b.def.fuel > 0) b.fuel = Math.max(0, b.fuel - Math.abs(b.throttle) * b.stats.fuelUse * dt * 0.35);
    } else b.speed = 0;
    b.position.y = waterHeightAt(b.position.x, b.position.z);
    b.locationLabel = regionAt(b.position.x, b.position.z)?.short || 'At sea';
  }

  updateDriving(b, dt, game) {
    const input = game.input;
    const player = game.get('player');
    if (input.uiCapture) { b.throttle = damp(b.throttle, 0, 0.02, dt); b.steer = 0; return; }

    const axis = input.moveAxis();
    const targetThrottle = b.engineOn ? axis.z : 0;
    b.throttle = damp(b.throttle, targetThrottle, 0.02, dt);
    b.steer = damp(b.steer, axis.x, 0.01, dt);
    if (input.down('Space')) {
      // Brake.
      if (b.entry) {
        const lv = b.entry.body.linvel();
        b.entry.body.applyImpulse({ x: -lv.x * b.def.mass * 1.4 * dt, y: 0, z: -lv.z * b.def.mass * 1.4 * dt }, true);
      }
      b.throttle *= 0.4;
    }
    if (input.justPressed('KeyF')) { b.lightsOn = !b.lightsOn; game.audio.play('ui_click'); }
    if (input.justPressed('KeyV')) { this.cameraMode = (this.cameraMode + 1) % 2; }
    if (this._ignoreE) {
      if (!input.rawDown('KeyE')) this._ignoreE = false;
    } else if (input.justPressed('KeyE')) { this.disembark(); return; }

    // ---- camera ----
    const cam = game.camera;
    const ud = b.object?.userData;
    if (!ud) return;
    if (input.locked) {
      const look = input.consumeLook();
      player.yaw += look.yaw;
      player.pitch = clamp(player.pitch + look.pitch, -1.2, 1.0);
    } else input.consumeLook();

    if (this.cameraMode === 0) {
      ud.helm.getWorldPosition(_v);
      cam.position.lerp(_v3.set(_v.x, _v.y + 0.9, _v.z), 1 - Math.pow(0.0001, dt));
      cam.rotation.order = 'YXZ';
      cam.rotation.set(player.pitch, player.yaw, 0);
      // Roll with the hull so waves read through the camera.
      _e.setFromQuaternion(b.object.quaternion, 'YXZ');
      cam.rotation.z = _e.z * 0.6;
      cam.rotation.x += _e.x * 0.5;
    } else {
      const dist = this.chaseDist + b.def.hull.length * 0.6;
      _v.set(
        b.position.x - Math.sin(player.yaw) * -dist,
        b.position.y + 4 + b.def.hull.height,
        b.position.z - Math.cos(player.yaw) * -dist,
      );
      cam.position.lerp(_v, 1 - Math.pow(0.0004, dt));
      cam.lookAt(b.position.x, b.position.y + 1, b.position.z);
    }
    // Keep the player entity glued to the helm so systems that read it work.
    ud.helm.getWorldPosition(_v);
    player.position.copy(_v);
    player.entry.body.setNextKinematicTranslation(player.position);

    // FOV kick with speed.
    player.fovKick = clamp(b.speed * 0.55, 0, 12);

    const hud = game.get('hud');
    if (hud) {
      hud.setInteract(`Leave ${b.name}  ·  V camera  ·  F lights`, 'E');
    }
  }

  /** Board prompts for docked boats. */
  updateInteractables(game) {
    const world = game.get('world');
    if (!world) return;
    world.interactables = world.interactables.filter((i) => i.kind !== 'boardBoat');
    if (this.driving) return;
    const player = game.get('player');
    for (const b of this.owned) {
      if (dist2DSq(b.position.x, b.position.z, player.position.x, player.position.z) > 400) continue;
      world.interactables.push({
        region: b.region, kind: 'boardBoat', label: `Board ${b.name}`, key: 'E',
        position: b.position.clone().setY(b.position.y + 1),
        radius: 4 + b.def.hull.width * 0.5,
        data: { boatId: b.id },
      });
    }
  }

  save() {
    return {
      boats: this.owned.map((b) => ({
        id: b.id, defId: b.defId, name: b.name, upgrades: b.upgrades,
        fuel: b.fuel, health: b.health, region: b.region,
        x: b.position.x, z: b.position.z, heading: b.heading,
        cargo: b.cargo, cargoWeight: b.cargoWeight, trips: b.trips, lifetimeProfit: b.lifetimeProfit,
      })),
      nextId: _boatId,
    };
  }

  load(d) {
    for (const b of [...this.owned]) this.despawnPhysical(b);
    this.owned.length = 0;
    this.driving = null;
    if (!d) return;
    _boatId = d.nextId || _boatId;
    for (const bd of d.boats || []) this.grant(bd.defId, bd);
    bus.emit('boats:changed', { count: this.owned.length });
  }
}

// --------------------------------------------------------------------------

function makeDeckCollider(d, y) {
  return RAPIER.ColliderDesc.cuboid(d.w / 2, 0.12, d.d / 2).setTranslation(d.x, y, d.z);
}

function buildBuoyancySamples(p) {
  const out = [];
  const nx = 3, nz = 5;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      out.push(new THREE.Vector3(
        lerp(-p.hx * 0.8, p.hx * 0.8, nx === 1 ? 0.5 : i / (nx - 1)),
        -p.hy * 0.18,
        lerp(-p.hz * 0.85, p.hz * 0.85, nz === 1 ? 0.5 : j / (nz - 1)),
      ));
    }
  }
  return out;
}

const BOAT_PREFIX = ['Sea', 'Salt', 'Storm', 'Iron', 'Lucky', 'Rusty', 'Grey', 'Blue', 'Old', 'Deep'];
const BOAT_SUFFIX = ['Rat', 'Dog', 'Widow', 'Maiden', 'Runner', 'Hauler', 'Gull', 'Anchor', 'Pearl', 'Wanderer', 'Bucket', 'Prospect'];
function generateBoatName(defId, n) {
  const a = BOAT_PREFIX[(Math.random() * BOAT_PREFIX.length) | 0];
  const b = BOAT_SUFFIX[(Math.random() * BOAT_SUFFIX.length) | 0];
  return `${a} ${b}`;
}
function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
