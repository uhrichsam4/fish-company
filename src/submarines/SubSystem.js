import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { buildSubMesh, buildSubInterior, makeLightCone } from './SubMesh.js';
import { DeepSea } from './DeepSea.js';
import {
  SUBMARINES, SUB_BY_ID, SUB_UPGRADES, SUB_UPGRADE_BY_ID,
  subUpgradeCost, subUpgradeValue, effectiveSubStats,
} from '../data/submarines.js';
import { CG, groups } from '../physics/PhysicsWorld.js';
import { waterHeightAt } from '../world/waves.js';
import { worldHeight } from '../world/Terrain.js';
import { REGIONS, REGION_BY_ID, regionAt } from '../data/regions.js';
import {
  getSpecies, speciesForHabitat, rollFishInstance, RARITY,
} from '../data/fishData.js';
import {
  clamp, clamp01, lerp, damp, shortestAngle, rrange, rpick,
  makeRNG, weightedPick, formatMoneyExact, formatWeight, formatTime, dist2DSq, TAU,
} from '../util/math.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

let _subId = 1;
let _expId = 1;

/** Deep-water habitats a manipulator / expedition can pull specimens from. */
const DEEP_HABITATS = ['deep', 'abyss', 'trench', 'vent', 'wreck'];

/** Depth bands an autonomous expedition can be sent to. */
export const DEPTH_BANDS = [
  { id: 'shelf', name: 'Continental Shelf', depth: 180, minutes: 3.0, risk: 0.25, valueMult: 1.0 },
  { id: 'twilight', name: 'Twilight Zone', depth: 600, minutes: 4.5, risk: 0.5, valueMult: 2.2 },
  { id: 'midnight', name: 'Midnight Zone', depth: 1400, minutes: 6.5, risk: 0.9, valueMult: 5.0 },
  { id: 'abyssal', name: 'Abyssal Plain', depth: 2600, minutes: 9.0, risk: 1.4, valueMult: 11.0 },
  { id: 'hadal', name: 'Hadal Trench', depth: 4200, minutes: 12.0, risk: 2.1, valueMult: 24.0 },
];
export const BAND_BY_ID = Object.fromEntries(DEPTH_BANDS.map((b) => [b.id, b]));

const EXP_STATE = {
  PREP: 'prep', DESCENT: 'descent', SURVEY: 'survey', ASCENT: 'ascent', DEBRIEF: 'debrief', DONE: 'done',
};
const EXP_LABEL = {
  prep: 'Loading out', descent: 'Descending', survey: 'On station',
  ascent: 'Ascending', debrief: 'Unloading', done: 'Complete',
};

/**
 * Every submarine the player owns: buying, upgrading, piloting, the depth
 * systems (hull / power / oxygen / crush depth), the instrument HUD, the
 * manipulator collector and autonomous crewed expeditions.
 *
 * Structurally this mirrors BoatSystem — an ownership list, a near/far split,
 * `grant`/`buy`/`board`/`disembark`, and interactables pushed into
 * `world.interactables` — but a sub is integrated by hand as a kinematic body
 * rather than floated by Rapier, because it has to feel like 40 tonnes of
 * steel with a very long memory of its own velocity.
 */
export class SubSystem {
  constructor(game) {
    this.game = game;
    this.name = 'subs';
    this.order = 79;

    this.owned = [];
    this.catalogue = SUBMARINES;
    this.upgrades = SUB_UPGRADES;
    this.expeditions = [];
    this.root = null;
    this.driving = null;
    this.nearRadius = 320;
    this.cameraMode = 0;          // 0 = interior first person, 1 = external chase
    this.chaseDist = 14;
    this.rng = makeRNG(90210);

    this.depth = 0;
    this.crushWarn = 0;
    this.hudVisible = false;

    this._ambientLoop = null;
    this._thrustLoop = null;
    this._creakTimer = 4;
    this._pingTimer = 0;
    this._pingAge = 99;
    this._sonarSweep = 0;
    this._contacts = [];
    this._contactTimer = 0;
    this._grabCooldown = 0;
    this._armAnim = 0;
    this._hudTimer = 0;
    this._scopeTimer = 0;

    /**
     * Player.update() consumes the mouse delta at order 20 and throws it away
     * while `canMove` is false, so snapshot the raw delta before that happens.
     * Cheaper and far less invasive than reordering the Player.
     */
    this._rawLook = { x: 0, y: 0 };
    try {
      game.add({
        name: 'subinput', order: 8,
        update: (dt, g) => {
          if (!this.driving) { this._rawLook.x = 0; this._rawLook.y = 0; return; }
          this._rawLook.x += g.input.mouse.dx;
          this._rawLook.y += g.input.mouse.dy;
        },
      });
      // DeepSea rides along with the subs; registering it here from the
      // constructor keeps main.js untouched and is safe because every add()
      // happens before Game.initSystems() starts iterating.
      if (!game.__deepSeaClaimed) game.add(new DeepSea(game));
    } catch (e) {
      console.warn('[Subs] companion system registration failed:', e.message);
    }
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'subs';
    game.scene.add(this.root);

    // Floodlights are owned by the system and re-parented to whichever sub is
    // lit, so the scene never carries more than two extra shadowless spots.
    this.spots = [];
    this.cones = [];
    for (let i = 0; i < 2; i++) {
      const spot = new THREE.SpotLight(0xdff0ff, 0, 60, 0.5, 0.45, 1.2);
      spot.castShadow = false;
      spot.visible = false;
      const target = new THREE.Object3D();
      target.position.set(0, 0, 1);
      spot.add(target);
      spot.target = target;
      this.spots.push(spot);
      const cone = makeLightCone(0xbfe8ff, 14);
      cone.visible = false;
      this.cones.push(cone);
    }

    this.buildHUD();

    bus.on('company:buySub', ({ id }) => this.buy(id));
    bus.on('company:upgradeSub', ({ id }) => bus.emit('ui:show', { id: 'subUpgrade', data: { id } }));
    bus.on('company:upgradeSubApply', ({ id, upgrade }) => this.applyUpgrade(id, upgrade));
    bus.on('company:repairSub', ({ id }) => this.repair(id));
    bus.on('company:rechargeSub', ({ id }) => this.recharge(id));
    bus.on('company:launchExpedition', (d) => this.startExpedition(d));
    bus.on('company:recallExpedition', ({ id }) => this.recallExpedition(id));
    bus.on('interact:boardSub', ({ subId }) => this.board(subId));
    bus.on('debug:giveSub', (d = {}) => {
      if (d && d.all) { for (const def of SUBMARINES) this.grant(def.id); return; }
      const next = SUBMARINES.find((def) => !this.owned.some((s) => s.defId === def.id));
      if (next) this.grant(next.id);
      else this.grant(SUBMARINES[0].id);
    });
    bus.on('game:newgame', () => { this.owned.length = 0; this.expeditions.length = 0; });

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

  lockReason(def) {
    const quests = this.game.get('quests');
    const research = this.game.get('research');
    if (def.unlockRegion && quests && !quests.isRegionUnlocked(def.unlockRegion)) {
      return `Requires ${REGION_BY_ID[def.unlockRegion]?.name || def.unlockRegion}`;
    }
    if (def.requiresResearch && research && !research.has(def.requiresResearch)) {
      return `Requires research: ${research.node?.(def.requiresResearch)?.name || def.requiresResearch}`;
    }
    return '';
  }

  buy(defId) {
    const def = SUB_BY_ID[defId];
    if (!def) return null;
    if (!this.isUnlocked(def)) {
      bus.emit('toast', { text: this.lockReason(def) || `${def.name} is not available yet.`, kind: 'error' });
      return null;
    }
    const eco = this.game.get('economy');
    if (!eco || !eco.spend(def.price, 'submarine')) return null;
    const s = this.grant(defId);
    this.game.audio.play('purchase', { volume: 0.85 });
    bus.emit('toast', {
      text: `${def.icon} Bought <b>${def.name}</b> — she is in the sub bay`,
      kind: 'success', duration: 6000,
    });
    return s;
  }

  /** The region a new sub is cradled in: a sub bay if there is one. */
  bayRegion() {
    const quests = this.game.get('quests');
    const world = this.game.get('world');
    const bays = REGIONS.filter((r) => r.hasSubBay);
    const unlocked = bays.find((r) => !quests || quests.isRegionUnlocked(r.id));
    return (unlocked || bays[0] || world?.activeRegion || REGION_BY_ID.harbor)?.id || 'station';
  }

  /** Where in a region a sub floats — off the end of the dock, in a row. */
  bayBerth(regionId, slot) {
    const world = this.game.get('world');
    const anchors = world?.getAnchors(regionId);
    const def = REGION_BY_ID[regionId];
    const dock = anchors?.dockEnd || { x: def?.x ?? 0, z: def?.z ?? 0 };
    const outward = anchors?.outward || { x: 1, z: 0 };
    const side = anchors?.side || { x: 0, z: 1 };
    return {
      x: dock.x + outward.x * 16 + side.x * (10 + slot * 16),
      z: dock.z + outward.z * 16 + side.z * (10 + slot * 16),
      heading: Math.atan2(outward.x, outward.z),
    };
  }

  grant(defId, data = {}) {
    const def = SUB_BY_ID[defId];
    if (!def) { console.warn('[Subs] unknown sub', defId); return null; }
    const region = data.region || this.bayRegion();
    const slot = this.owned.filter((s) => s.region === region).length;
    const berth = this.bayBerth(region, slot);
    const px = data.x ?? berth.x;
    const pz = data.z ?? berth.z;
    const stats = effectiveSubStats(def, data.upgrades || {});

    const s = {
      id: data.id || `s${_subId++}`,
      defId, def,
      name: data.name || generateSubName(def, this.owned.length),
      icon: def.icon,
      upgrades: data.upgrades || {},
      stats,
      region,
      position: new THREE.Vector3(px, data.y ?? (waterHeightAt(px, pz) - def.physics.hy * 0.35), pz),
      heading: data.heading ?? berth.heading,
      pitch: 0, roll: 0,
      velocity: new THREE.Vector3(),
      yawVel: 0,
      throttle: 0, steer: 0, vertical: 0,
      hull: data.hull ?? stats.hullStrength,
      battery: data.battery ?? stats.battery,
      oxygen: data.oxygen ?? stats.oxygen,
      lightsOn: data.lightsOn ?? true,
      cargo: data.cargo || [],
      cargoWeight: data.cargoWeight || 0,
      physical: false, entry: null, object: null, interior: null,
      expedition: null,
      docked: true,
      depth: 0,
      deepest: data.deepest || 0,
      trips: data.trips || 0,
      lifetimeProfit: data.lifetimeProfit || 0,
      locationLabel: REGION_BY_ID[region]?.short || 'Sub bay',
      _creak: 0,
    };
    this.owned.push(s);
    bus.emit('subs:changed', { count: this.owned.length, sub: s });
    return s;
  }

  sell(id) {
    const i = this.owned.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = this.owned[i];
    if (this.driving === s) this.disembark();
    if (s.expedition) this.recallExpedition(s.expedition.id);
    this.despawnPhysical(s);
    const eco = this.game.get('economy');
    eco?.add(Math.round((s.def.price + subUpgradeValue(s.upgrades)) * 0.5), 'sub_sale');
    this.owned.splice(i, 1);
    bus.emit('subs:changed', { count: this.owned.length });
  }

  byId(id) { return this.owned.find((s) => s.id === id) || null; }
  totalValue() { return this.owned.reduce((a, s) => a + s.def.price * 0.6 + subUpgradeValue(s.upgrades) * 0.5, 0); }

  /**
   * Crush depth actually available: the hull rating, raised (but never wildly)
   * by whatever the research tree has certified.
   */
  crushDepthOf(s) {
    const research = this.game.get('research');
    const base = s.stats.crushDepth;
    const certified = research?.crushDepth || 0;
    return Math.max(base, Math.min(base * 2.5, certified));
  }

  sonarDetailOf(s) {
    const research = this.game.get('research');
    return clamp(Math.round(s.stats.sonarDetail + (research?.sonarLevel || 0) * 0.5), 1, 5);
  }

  applyUpgrade(id, upgradeId) {
    const s = this.byId(id);
    const u = SUB_UPGRADE_BY_ID[upgradeId];
    if (!s || !u) return;
    const lvl = s.upgrades[upgradeId] || 0;
    if (lvl >= u.max) { bus.emit('toast', { text: `${u.name} already maxed.`, kind: 'warn' }); return; }
    const research = this.game.get('research');
    if (u.requiresResearch && research && !research.has(u.requiresResearch)) {
      bus.emit('toast', { text: `Requires research: ${u.requiresResearch}`, kind: 'error' });
      return;
    }
    const cost = subUpgradeCost(upgradeId, lvl);
    const eco = this.game.get('economy');
    if (!eco || !eco.spend(cost, 'sub_upgrade')) return;
    s.upgrades[upgradeId] = lvl + 1;
    const hullFrac = clamp01(s.hull / Math.max(1, s.stats.hullStrength));
    s.stats = effectiveSubStats(s.def, s.upgrades);
    s.hull = s.stats.hullStrength * hullFrac;
    s.battery = Math.min(s.battery, s.stats.battery);
    s.oxygen = Math.min(s.oxygen, s.stats.oxygen);
    this.game.audio.play('purchase', { volume: 0.6 });
    bus.emit('toast', { text: `${s.name}: ${u.name} → level ${lvl + 1}`, kind: 'success' });
    bus.emit('subs:changed', { count: this.owned.length, sub: s });
  }

  repair(id) {
    const s = this.byId(id);
    if (!s) return;
    const missing = s.stats.hullStrength - s.hull;
    if (missing < 0.5) { bus.emit('toast', { text: `${s.name} is sound.`, kind: 'muted' }); return; }
    const research = this.game.get('research');
    const cost = Math.round((missing / s.stats.hullStrength) * s.def.price * 0.09 * (research?.repairMult ?? 1));
    const eco = this.game.get('economy');
    if (!eco || !eco.spend(cost, 'repairs')) return;
    if (eco.today) eco.today.repairs += cost;
    s.hull = s.stats.hullStrength;
    this.game.audio.play('purchase', { volume: 0.5 });
    bus.emit('toast', { text: `${s.name} hull recertified for ${formatMoneyExact(cost)}`, kind: 'success' });
  }

  recharge(id) {
    const s = this.byId(id);
    if (!s) return;
    const need = s.stats.battery - s.battery;
    if (need < 0.5) { bus.emit('toast', { text: `${s.name} is charged.`, kind: 'muted' }); return; }
    const cost = Math.round(need * 26);
    const eco = this.game.get('economy');
    if (!eco || !eco.spend(cost, 'power')) return;
    s.battery = s.stats.battery;
    s.oxygen = s.stats.oxygen;
    bus.emit('toast', { text: `${s.name} charged for ${formatMoneyExact(cost)}`, kind: 'success' });
  }

  // -------------------------------------------------------------- physical
  spawnPhysical(s) {
    if (s.physical) return;
    s.object = buildSubMesh(s.def, { seed: hashId(s.id) });
    s.object.position.copy(s.position);
    s.object.rotation.order = 'YXZ';
    this.root.add(s.object);

    const p = s.def.physics;
    s.entry = this.game.physics.addBody({
      type: 'kinematicPosition',
      position: s.position,
      rotation: _q.setFromAxisAngle(UP, s.heading),
      shape: [{
        kind: 'box', hx: p.hx * 0.92, hy: p.hy * 0.9, hz: p.hz * 0.94,
        friction: 0.9, restitution: 0.05, groups: groups(CG.BOAT, 0xffff),
      }],
      tag: 'sub',
      canSleep: false,
      events: false,
      userData: { sub: s, rideable: true, surface: 'metal' },
    });
    s.physical = true;
    bus.emit('sub:spawned', { sub: s });
  }

  despawnPhysical(s) {
    if (!s.physical) return;
    if (this._litSub === s) this.detachLights();
    this.game.physics.remove(s.entry);
    this.root.remove(s.object);
    disposeDeep(s.object);
    s.entry = null; s.object = null; s.physical = false;
  }

  // --------------------------------------------------------------- driving
  board(subId) {
    const s = this.byId(subId);
    if (!s) return null;
    if (s.expedition) { bus.emit('toast', { text: `${s.name} is out on an expedition.`, kind: 'error' }); return null; }
    if (s.hull <= 0) { bus.emit('toast', { text: `${s.name}'s hull has failed. Repair her first.`, kind: 'error' }); return null; }
    if (!s.physical) this.spawnPhysical(s);

    const game = this.game;
    const player = game.get('player');
    this.driving = s;
    this.cameraMode = 0;
    this._prevHeading = s.heading;
    this._rawLook.x = 0; this._rawLook.y = 0;
    this._grabCooldown = 0;
    s.docked = false;

    player.mode = 'sub';
    player.canMove = false;
    player.oxygen = player.maxOxygen;
    // Interaction (order 65) boards on the same E press this system (order 79)
    // would read a few systems later — swallow it until the key comes back up.
    this._ignoreE = true;
    // Face the way the boat is pointing. The camera uses the FPS convention
    // (forward = -Z at yaw 0) while the hull uses +Z, hence the half turn.
    player.yaw = s.heading + Math.PI;
    player.pitch = 0;

    // Interior shell, pinned to the camera every frame while in first person.
    if (!s.interior) {
      s.interior = buildSubInterior(s.def);
      s.interior.visible = false;
      game.scene.add(s.interior);
    }
    this.attachLights(s);
    this.setHudVisible(true);
    // The rod/harpoon viewmodel has no business floating inside a pressure hull.
    const held = game.get('held');
    if (held) { this._heldWasVisible = held.visible; held.visible = false; }

    game.audio.play('sub_dive', { volume: 0.7 });
    if (!this._ambientLoop) this._ambientLoop = game.audio.loop('sub_ambient_loop', { volume: 0.45 });
    bus.emit('toast', {
      text: `${s.icon} Piloting <b>${s.name}</b> — W/S thrust · A/D helm · Space up · Ctrl down · F lights · R sonar · LMB collector · V view · E surface`,
      kind: '', duration: 9000,
    });
    bus.emit('sub:boarded', { sub: s });
    return s;
  }

  disembark() {
    const s = this.driving;
    if (!s) return;
    const game = this.game;
    const player = game.get('player');
    this.driving = null;
    this._ignoreE = false;
    player.mode = 'walk';
    player.canMove = true;

    if (s.interior) s.interior.visible = false;
    this.detachLights();
    this.setHudVisible(false);
    this.restoreHeld();
    if (this._thrustLoop) { this._thrustLoop.stop(0.4); this._thrustLoop = null; }
    if (this._ambientLoop) { this._ambientLoop.stop(0.6); this._ambientLoop = null; }
    game.audio.setUnderwater(0);

    // Put the pilot on the sail, or back at the bay if the sub is still deep.
    const depth = waterHeightAt(s.position.x, s.position.z) - s.position.y;
    if (depth > 6) {
      this.returnToBay(s, 'You left the sub below the surface — she was recovered.');
    } else {
      player.teleport(s.position.x, s.position.y + s.def.hull.height * 0.7 + 1.4, s.position.z + 2);
      this.sellCargo(s, 'dock');
    }
    s.throttle = 0; s.steer = 0; s.vertical = 0;
    bus.emit('sub:left', { sub: s });
  }

  restoreHeld() {
    const held = this.game.get('held');
    if (held && this._heldWasVisible != null) held.visible = this._heldWasVisible;
    this._heldWasVisible = null;
  }

  update(dt, game) {
    if (dt <= 0) return;
    const player = game.get('player');
    if (!player) return;

    for (const s of this.owned) {
      if (s.expedition) { s.locationLabel = EXP_LABEL[s.expedition.state] || 'At sea'; continue; }
      const near = this.driving === s
        || dist2DSq(s.position.x, s.position.z, player.position.x, player.position.z) < this.nearRadius * this.nearRadius;
      if (near && !s.physical) this.spawnPhysical(s);
      else if (!near && s.physical) this.despawnPhysical(s);
      if (this.driving === s) continue;      // driven sub is handled below
      this.updateIdle(s, dt);
      this.syncTransform(s, dt);
    }

    if (this.driving) {
      // Order matters: integrate, push the transform to the mesh, THEN read
      // the helm anchor for the camera — otherwise the view trails a frame.
      this.updateDriving(this.driving, dt, game);
      if (this.driving) this.syncTransform(this.driving, dt);
      if (this.driving) this.updateCamera(this.driving, dt, game, player);
      if (this.driving) this.updateSystems(this.driving, dt, game);
      if (this.driving) this.updateCollector(this.driving, dt, game);
      if (this.driving) this.updateSonar(this.driving, dt, game);
      if (this.driving) this.updateHUD(this.driving, dt, game);
    }

    this.updateExpeditions(dt, game);
    this.updateInteractables(game);
  }

  /** A sub nobody is in: bob at the surface and slowly recharge in the bay. */
  updateIdle(s, dt) {
    const wy = waterHeightAt(s.position.x, s.position.z);
    const rest = wy - s.def.physics.hy * 0.35;
    s.position.y = damp(s.position.y, rest, 0.06, dt);
    s.velocity.multiplyScalar(Math.pow(0.1, dt));
    s.roll = damp(s.roll, Math.sin(this.game.time * 0.7 + hashId(s.id) % 10) * 0.035, 0.2, dt);
    s.pitch = damp(s.pitch, Math.sin(this.game.time * 0.53) * 0.02, 0.2, dt);
    s.depth = 0;
    if (s.battery < s.stats.battery) s.battery = Math.min(s.stats.battery, s.battery + s.stats.battery * 0.02 * dt);
    if (s.oxygen < s.stats.oxygen) s.oxygen = Math.min(s.stats.oxygen, s.oxygen + s.stats.oxygen * 0.05 * dt);
    s.docked = true;
  }

  syncTransform(s, dt) {
    if (!s.physical || !s.object) return;
    s.object.position.copy(s.position);
    s.object.rotation.set(s.pitch, s.heading, s.roll);
    if (s.entry && !s.entry.removed) {
      s.entry.body.setNextKinematicTranslation(s.position);
      _e.set(s.pitch, s.heading, s.roll, 'YXZ');
      _q.setFromEuler(_e);
      s.entry.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
    const ud = s.object.userData;
    if (ud.propAnchor) ud.propAnchor.rotation.z += dt * (1.2 + Math.abs(s.throttle) * 22);
    const lit = s.lightsOn ? 2.6 : 0;
    for (const l of ud.runningLights) l.material.emissiveIntensity = s.lightsOn ? 1.6 : 0.15;
    for (const a of ud.lightAnchors) if (a.userData.lens) a.userData.lens.material.emissiveIntensity = lit;
  }

  // ------------------------------------------------------------- piloting
  updateDriving(s, dt, game) {
    const input = game.input;
    const player = game.get('player');
    const st = s.stats;

    let axis = { x: 0, z: 0 };
    let vert = 0;
    if (!input.uiCapture) {
      axis = input.moveAxis();
      if (input.down('Space')) vert += 1;
      if (input.down('ControlLeft') || input.down('ControlRight') || input.down('KeyC')) vert -= 1;
      if (input.justPressed('KeyF')) {
        s.lightsOn = !s.lightsOn;
        game.audio.play('ui_click', { volume: 0.5 });
      }
      if (input.justPressed('KeyR')) this.ping(s, game);
      if (input.justPressed('KeyV')) {
        this.cameraMode = (this.cameraMode + 1) % 2;
        game.audio.play('ui_click', { volume: 0.4 });
      }
      if (this._ignoreE) {
        if (!input.rawDown('KeyE')) this._ignoreE = false;
      } else if (input.justPressed('KeyE')) { this.disembark(); return; }
    }

    // Dead battery: no thrust, lights out, but you still steer as you drift.
    const powered = s.battery > 0.01;
    if (!powered) { s.lightsOn = false; axis = { x: axis.x * 0.35, z: 0 }; vert = Math.min(0, vert); }

    // ---- heavy inertia -------------------------------------------------
    // Thrust is an acceleration; drag is exponential. Terminal speed works out
    // to exactly the catalogue figure, but the time constant is ~5 s so the
    // boat glides for a very long way after you let go.
    const K_LIN = 0.19, K_VERT = 0.55, K_YAW = 1.1;
    s.throttle = damp(s.throttle, axis.z, 0.06, dt);
    s.steer = damp(s.steer, axis.x, 0.04, dt);
    s.vertical = damp(s.vertical, vert, 0.05, dt);

    const fwd = _v.set(Math.sin(s.heading), 0, Math.cos(s.heading));
    const accel = st.speed * K_LIN;
    s.velocity.addScaledVector(fwd, s.throttle * accel * dt * (s.throttle < 0 ? 0.55 : 1));
    s.velocity.y += s.vertical * st.ascendRate * K_VERT * dt;

    // Trim: a sub without vertical input sinks very gently.
    if (Math.abs(s.vertical) < 0.05) s.velocity.y -= 0.09 * dt;

    const drag = Math.exp(-K_LIN * dt);
    s.velocity.x *= drag; s.velocity.z *= drag;
    s.velocity.y *= Math.exp(-K_VERT * dt);

    // Yaw: sluggish, and you barely turn at all without water over the planes.
    const authority = 0.35 + clamp01(Math.hypot(s.velocity.x, s.velocity.z) / Math.max(1, st.speed)) * 0.65;
    s.yawVel += -s.steer * st.turnRate * K_YAW * authority * dt;
    s.yawVel *= Math.exp(-K_YAW * dt);
    s.heading += s.yawVel * dt;

    // Integrate.
    s.position.addScaledVector(s.velocity, dt);

    // ---- attitude lags the input --------------------------------------
    const targetPitch = clamp(-s.velocity.y * 0.16 - s.vertical * 0.1, -0.42, 0.42);
    const targetRoll = clamp(s.yawVel * 1.5, -0.4, 0.4);
    s.pitch = damp(s.pitch, targetPitch, 0.12, dt);
    s.roll = damp(s.roll, targetRoll, 0.1, dt);

    // ---- world constraints ---------------------------------------------
    const wy = waterHeightAt(s.position.x, s.position.z);
    const hy = s.def.physics.hy;
    const ceiling = wy - hy * 0.35;
    if (s.position.y > ceiling) {
      s.position.y = damp(s.position.y, ceiling, 0.001, dt);
      if (s.velocity.y > 0) s.velocity.y *= 0.2;
    }
    const bed = worldHeight(s.position.x, s.position.z);
    const floor = bed + hy + 0.5;
    if (s.position.y < floor) {
      const impact = -s.velocity.y;
      s.position.y = floor;
      if (s.velocity.y < 0) s.velocity.y = 0;
      if (impact > 2.2) this.impact(s, impact, game, 'seabed');
    }
    // Terrain dead ahead: a wall stops 40 tonnes, hard.
    const look = Math.max(6, s.def.physics.hz + Math.hypot(s.velocity.x, s.velocity.z) * 1.6);
    const aheadBed = worldHeight(s.position.x + fwd.x * look, s.position.z + fwd.z * look);
    if (aheadBed > s.position.y - hy * 0.5) {
      const speed = Math.hypot(s.velocity.x, s.velocity.z);
      s.velocity.x *= 0.55; s.velocity.z *= 0.55;
      s.velocity.y += 2.4 * dt;
      if (speed > 3 && s.throttle > 0.2) this.impact(s, speed, game, 'rock');
    }
    // Keep her on the map.
    const EXT = 1650;
    s.position.x = clamp(s.position.x, -EXT, EXT);
    s.position.z = clamp(s.position.z, -EXT, EXT);

    s.depth = Math.max(0, wy - s.position.y);
    this.depth = s.depth;
    if (s.depth > s.deepest) s.deepest = s.depth;
    const eco = game.get('economy');
    if (eco?.stats && s.depth > (eco.stats.deepestDive || 0)) eco.stats.deepestDive = Math.round(s.depth);
    s.region = regionAt(s.position.x, s.position.z)?.id || s.region;
    s.locationLabel = regionAt(s.position.x, s.position.z)?.short || 'Open water';
    s.docked = s.depth < 3 && this.nearBay(s);

    this.updateLights(s, dt, game);
    this.updateAudio(s, dt, game);

    const hud = game.get('hud');
    if (hud) hud.setInteract(`Surface & leave ${s.name}  ·  V view  ·  F lights  ·  R sonar`, 'E');
    player.fovKick = clamp(Math.hypot(s.velocity.x, s.velocity.z) * 0.5, 0, 8);
  }

  updateCamera(s, dt, game, player) {
    const cam = game.camera;
    const ud = s.object?.userData;
    if (!ud) return;

    // The hull carries the view around with it; the mouse adds a free look on
    // top. Player.update() already discarded the delta, so use the snapshot.
    const dHead = shortestAngle(this._prevHeading ?? s.heading, s.heading);
    this._prevHeading = s.heading;
    player.yaw += dHead;
    if (game.input.locked && !game.input.uiCapture) {
      player.yaw += -this._rawLook.x * game.input.sensitivity;
      player.pitch = clamp(player.pitch + (game.input.invertY ? 1 : -1) * this._rawLook.y * game.input.sensitivity, -1.2, 1.1);
    }
    this._rawLook.x = 0; this._rawLook.y = 0;

    cam.rotation.order = 'YXZ';
    if (this.cameraMode === 0) {
      ud.helm.getWorldPosition(_v);
      cam.position.copy(_v);
      cam.rotation.set(player.pitch + s.pitch * 0.8, player.yaw, s.roll * 0.75);
      for (const o of ud.fpHide) o.visible = false;
      if (s.interior) {
        s.interior.visible = true;
        s.interior.position.copy(_v);
        s.interior.rotation.set(s.pitch, s.heading, s.roll);
      }
    } else {
      const dist = this.chaseDist + s.def.hull.length * 0.75;
      const fwd = _v.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      _v2.copy(s.position).addScaledVector(fwd, -dist);
      _v2.y += s.def.hull.height * 0.7 + 2.5 - Math.sin(player.pitch) * dist;
      // Never let the chase camera bury itself in the seabed.
      const bed = worldHeight(_v2.x, _v2.z) + 1.2;
      if (_v2.y < bed) _v2.y = bed;
      cam.position.lerp(_v2, 1 - Math.pow(0.0006, dt));
      cam.lookAt(s.position.x, s.position.y, s.position.z);
      for (const o of ud.fpHide) o.visible = true;
      if (s.interior) s.interior.visible = false;
    }

    // Keep the player entity glued to the helm so every other system agrees.
    ud.helm.getWorldPosition(_v);
    player.position.copy(_v);
    player.entry?.body.setNextKinematicTranslation(player.position);
    player.velocity.set(0, 0, 0);
  }

  attachLights(s) {
    if (!s.object) return;
    this.detachLights();
    const anchors = s.object.userData.lightAnchors || [];
    for (let i = 0; i < this.spots.length; i++) {
      const anchor = anchors[i] || anchors[0];
      if (!anchor) break;
      anchor.add(this.spots[i]);
      anchor.add(this.cones[i]);
      this.spots[i].visible = true;
      this.cones[i].visible = true;
    }
    this._litSub = s;
  }

  detachLights() {
    for (let i = 0; i < this.spots.length; i++) {
      this.spots[i].parent?.remove(this.spots[i]);
      this.cones[i].parent?.remove(this.cones[i]);
      this.spots[i].visible = false;
      this.cones[i].visible = false;
    }
    this._litSub = null;
  }

  updateLights(s, dt, game) {
    const st = s.stats;
    const on = s.lightsOn && s.battery > 0.01;
    const range = st.lightRange;
    const cone = clamp(st.lightCone, 0.15, 1.2);
    // Deeper water eats the beam, so pull the range in as the dark closes.
    const murk = 1 - clamp01(s.depth / 3500) * 0.35;
    for (let i = 0; i < this.spots.length; i++) {
      const spot = this.spots[i];
      const cm = this.cones[i];
      spot.visible = on;
      cm.visible = on;
      if (!on) { cm.material.opacity = 0; continue; }
      spot.distance = range * murk;
      spot.angle = cone;
      spot.penumbra = 0.5;
      spot.intensity = lerp(28, 190, clamp01(s.depth / 260)) * (range / 46);
      spot.color.setHex(0xdff0ff);
      // The cone mesh is a stand-in for volumetrics: barely visible in daylight
      // shallows, obvious once the sunlight has gone.
      const vis = clamp01((s.depth - 25) / 140);
      cm.scale.set(Math.tan(cone) * range * murk, Math.tan(cone) * range * murk, range * murk);
      cm.material.opacity = 0.035 + vis * 0.085;
    }
  }

  updateAudio(s, dt, game) {
    const audio = game.audio;
    const thrust = clamp01(Math.abs(s.throttle) * 0.7 + Math.abs(s.vertical) * 0.5);
    if (!this._thrustLoop && thrust > 0.02) this._thrustLoop = audio.loop('boat_engine_loop', { volume: 0.0 });
    if (this._thrustLoop) {
      this._thrustLoop.setVolume(lerp(0.0, 0.34, thrust), 0.3);
      this._thrustLoop.setRate(lerp(0.42, 0.78, thrust), 0.3);
    }
    audio.setUnderwater(clamp01(s.depth / 6));
    if (this._ambientLoop) this._ambientLoop.setVolume(lerp(0.28, 0.6, clamp01(s.depth / 400)), 0.6);
  }

  impact(s, speed, game, kind) {
    const dmg = clamp((speed - 2) * 3.2, 0, s.stats.hullStrength * 0.12);
    s.hull = Math.max(0, s.hull - dmg);
    game.audio.play('boat_impact', { volume: clamp01(speed / 8), throttle: 260 });
    bus.emit('player:shake', clamp01(speed / 8) * 0.7);
    bus.emit('fx:impact', { position: s.position.clone(), normal: UP.clone(), kind: kind === 'rock' ? 'stone' : 'sand' });
    if (s.hull <= 0) this.hullFailure(s, game);
  }

  // ------------------------------------------------------- depth systems
  updateSystems(s, dt, game) {
    const st = s.stats;
    const crush = this.crushDepthOf(s);
    const surfaced = s.depth < 2.5;

    // ---- POWER ----
    const draw = st.batteryUse * (0.18 + Math.abs(s.throttle) * 0.9 + Math.abs(s.vertical) * 0.55)
      + (s.lightsOn ? st.batteryUse * 0.22 * (st.lightRange / 46) : 0);
    if (surfaced && this.nearBay(s)) {
      s.battery = Math.min(st.battery, s.battery + st.battery * 0.09 * dt);
      s.oxygen = Math.min(st.oxygen, s.oxygen + st.oxygen * 0.16 * dt);
    } else if (surfaced) {
      // Snorkelling: the diesel/air comes back, slowly.
      s.battery = Math.min(st.battery, s.battery + st.battery * 0.02 * dt);
      s.oxygen = Math.min(st.oxygen, s.oxygen + st.oxygen * 0.06 * dt);
    } else {
      s.battery = Math.max(0, s.battery - draw * dt);
    }
    if (s.battery <= 0 && !s._powerWarned) {
      s._powerWarned = true;
      s.lightsOn = false;
      bus.emit('toast', { text: `🔋 <b>${s.name}</b> — batteries flat. Blow ballast and pray.`, kind: 'error', duration: 7000 });
      game.audio.play('ui_error', { volume: 0.6 });
    } else if (s.battery > st.battery * 0.1) s._powerWarned = false;

    // ---- OXYGEN ----
    if (!surfaced) {
      const crewAboard = 1;
      s.oxygen = Math.max(0, s.oxygen - dt * crewAboard);
      if (s.oxygen <= 0) {
        const player = game.get('player');
        player.oxygen = Math.max(0, player.oxygen - dt * 22);
        player.damage(dt * 7, 'suffocation');
        if (!s._oxyWarned) {
          s._oxyWarned = true;
          bus.emit('toast', { text: `🫁 <b>${s.name}</b> — air gone. Surface NOW.`, kind: 'error', duration: 8000 });
        }
      }
    } else { s._oxyWarned = false; }

    // ---- CRUSH DEPTH ----
    const over = s.depth - crush;
    if (over > 0) {
      this.crushWarn = clamp01(over / Math.max(40, crush * 0.25));
      // Escalating: 1 m over is a groan, 25% over is a countdown.
      const rate = st.hullStrength * (0.02 + Math.pow(clamp01(over / (crush * 0.3)), 2) * 0.22);
      s.hull = Math.max(0, s.hull - rate * dt);
      s._creak -= dt;
      if (s._creak <= 0) {
        s._creak = lerp(2.6, 0.45, this.crushWarn);
        game.audio.play('sub_creak', { volume: lerp(0.45, 1.0, this.crushWarn), rate: rrange(0.85, 1.1) });
        bus.emit('player:shake', 0.12 + this.crushWarn * 0.55);
      }
      if (s.hull <= 0) this.hullFailure(s, game);
    } else {
      this.crushWarn = 0;
      // Even inside the rating, deep hulls talk to themselves.
      this._creakTimer -= dt;
      if (this._creakTimer <= 0 && s.depth > 90) {
        this._creakTimer = rrange(9, 26);
        game.audio.play('sub_creak', { volume: 0.2 + clamp01(s.depth / crush) * 0.25, rate: rrange(0.7, 0.95) });
      }
    }

    // Auto-sell whatever is in the hold whenever she comes home.
    if (surfaced && this.nearBay(s) && s.cargo.length) this.sellCargo(s, 'surface');
  }

  hullFailure(s, game) {
    if (s._failing) return;
    s._failing = true;
    const lost = s.cargo.length;
    const lostValue = s.cargo.reduce((a, c) => a + (c.value || 0), 0);
    s.cargo.length = 0;
    s.cargoWeight = 0;
    s.hull = 0;

    game.audio.play('boat_impact', { volume: 1.0 });
    game.audio.play('splash_big', { volume: 0.9 });
    bus.emit('player:shake', 1.4);
    bus.emit('fx:explosion', { position: s.position.clone(), scale: 1.6 });
    bus.emit('toast', {
      text: `💥 <b>${s.name}</b> imploded. ${lost ? `${lost} specimens (${formatMoneyExact(lostValue)}) lost with her.` : 'The hold was empty, at least.'}`,
      kind: 'error', duration: 9000,
    });
    bus.emit('sub:lost', { sub: s, cargoLost: lost, value: lostValue });

    const player = game.get('player');
    player.damage(35, 'implosion');
    if (this.driving === s) {
      this.driving = null;
      player.mode = 'walk';
      player.canMove = true;
      if (s.interior) s.interior.visible = false;
      this.detachLights();
      this.setHudVisible(false);
      this.restoreHeld();
      if (this._thrustLoop) { this._thrustLoop.stop(0.2); this._thrustLoop = null; }
      if (this._ambientLoop) { this._ambientLoop.stop(0.4); this._ambientLoop = null; }
      game.audio.setUnderwater(0);
    }
    this.returnToBay(s, null);
    s.hull = Math.max(1, s.stats.hullStrength * 0.08);
    setTimeout(() => { s._failing = false; }, 400);
  }

  /** Teleport a sub (and the pilot, if aboard) back to its bay cradle. */
  returnToBay(s, message) {
    const region = this.bayRegion();
    const slot = Math.max(0, this.owned.indexOf(s));
    const berth = this.bayBerth(region, slot);
    s.region = region;
    s.position.set(berth.x, waterHeightAt(berth.x, berth.z) - s.def.physics.hy * 0.35, berth.z);
    s.heading = berth.heading;
    s.velocity.set(0, 0, 0);
    s.yawVel = 0; s.pitch = 0; s.roll = 0;
    s.depth = 0;
    s.docked = true;
    this.despawnPhysical(s);

    const player = this.game.get('player');
    const world = this.game.get('world');
    const spawn = world?.getAnchors(region)?.spawn;
    if (player && spawn) player.spawnAt(spawn, player.yaw);
    if (message) bus.emit('toast', { text: message, kind: 'warn', duration: 6000 });
  }

  nearBay(s) {
    const r = REGION_BY_ID[this.bayRegion()];
    if (!r) return false;
    return dist2DSq(s.position.x, s.position.z, r.x, r.z) < (r.reach * 0.85) ** 2;
  }

  // ------------------------------------------------------------- collector
  updateCollector(s, dt, game) {
    this._grabCooldown = Math.max(0, this._grabCooldown - dt);
    this._armAnim = Math.max(0, this._armAnim - dt * 2.2);

    const ud = s.object?.userData;
    if (ud?.armPivot) {
      const reach = Math.sin(clamp01(this._armAnim) * Math.PI);
      ud.armPivot.rotation.x = 0.25 - reach * 0.5;
      if (ud.armPivot.userData.elbow) ud.armPivot.userData.elbow.rotation.x = -0.5 + reach * 0.45;
      if (ud.armPivot.userData.claw) ud.armPivot.userData.claw.rotation.y = reach * 0.5;
    }

    const input = game.input;
    if (input.uiCapture || !input.mousePressed(0)) return;
    if (this._grabCooldown > 0) return;

    const st = s.stats;
    const range = st.grabRange + s.def.hull.length * 0.25;
    this._grabCooldown = 1.35 / Math.max(0.2, st.grabSpeed);
    this._armAnim = 1;
    game.audio.play('reel_click', { volume: 0.5, rate: 0.7 });

    if (s.battery <= 0) {
      bus.emit('toast', { text: 'No power for the manipulator.', kind: 'error' });
      return;
    }
    if (s.cargoWeight >= st.cargo) {
      bus.emit('toast', { text: `${s.name}'s hold is full (${formatWeight(s.cargoWeight)}).`, kind: 'warn' });
      return;
    }

    const fishSys = game.get('fish');
    if (!fishSys) return;
    const cam = game.camera;
    const dir = cam.getWorldDirection(_v3);
    let best = null, bestScore = -1;
    for (const f of fishSys.active) {
      if (!f.active || !f.instance) continue;
      const d = f.position.distanceTo(cam.position);
      if (d > range) continue;
      _v2.copy(f.position).sub(cam.position);
      if (_v2.lengthSq() < 1e-6) continue;
      const facing = _v2.normalize().dot(dir);
      if (facing < 0.2) continue;
      const score = facing * 2 - d * 0.06;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    if (!best) {
      // Nothing alive in reach — try for a resource node instead.
      const node = game.get('deepsea')?.collectNodeNear?.(cam.position, dir, range);
      if (node) {
        const eco = game.get('economy');
        eco?.add(node.value, 'sub_salvage');
        game.audio.play('pickup', { volume: 0.8 });
        bus.emit('fx:moneyBurst', { position: node.position.clone(), amount: node.value });
        this.flash(`${node.name} · ${formatMoneyExact(node.value)}`, '#6fffe0');
        bus.emit('sub:nodeCollected', { sub: s, node, value: node.value });
        return;
      }
      bus.emit('fx:bubbles', { position: _v.copy(cam.position).addScaledVector(dir, range * 0.6).clone(), count: 6 });
      return;
    }

    const inst = best.instance;
    const maxSpecimen = 40 * Math.pow(6, st.armTier);
    if (inst.weight > maxSpecimen) {
      bus.emit('toast', { text: `${inst.name} is far too heavy for this arm.`, kind: 'warn' });
      game.audio.play('ui_error', { volume: 0.4 });
      return;
    }

    this.collect(s, inst, best.position.clone(), game);
    fishSys.despawn(best);
  }

  /** Move one specimen into the hold and score it. */
  collect(s, inst, position, game) {
    s.cargo.push(inst);
    s.cargoWeight += inst.weight;

    const eco = game.get('economy');
    eco?.recordCatch(inst, 'player');
    const tricks = game.get('tricks');
    tricks?.evaluateCatch({ instance: inst, method: 'sub', depth: s.depth });

    const species = getSpecies(inst.speciesId);
    const quests = game.get('quests');
    quests?.onCatch?.(inst);
    bus.emit('atlas:discover', { speciesId: inst.speciesId, variantId: inst.variantId });
    bus.emit('sub:collected', { sub: s, instance: inst, depth: s.depth });

    game.audio.play('pickup', { volume: 0.7 });
    if (['legendary', 'mythic', 'epic'].includes(inst.rarity)) {
      game.audio.play('rare_fish', { volume: 0.6 });
    }
    bus.emit('fx:bubbles', { position, count: 14 });
    this.flash(`${inst.name} · ${formatWeight(inst.weight)}`, RARITY[inst.rarity]?.color || '#eaf4fb');
    if (species) bus.emit('player:xp', { amount: species.xp });
  }

  sellCargo(s, reason = 'dock') {
    if (!s.cargo.length) return 0;
    const game = this.game;
    const eco = game.get('economy');
    let total = 0;
    for (const inst of s.cargo) {
      const price = eco ? eco.priceFor(inst) : inst.value;
      total += price;
      eco?.recordSale(inst, price, 'submarine');
    }
    total = Math.round(total);
    const count = s.cargo.length;
    const weight = s.cargoWeight;
    s.cargo = [];
    s.cargoWeight = 0;
    s.trips++;
    s.lifetimeProfit += total;
    eco?.add(total, 'sub_specimens');
    game.audio.play('cash_register', { volume: 0.75 });
    bus.emit('fx:moneyBurst', { position: s.position.clone(), amount: total });
    bus.emit('toast', {
      text: `${s.icon} <b>${s.name}</b> landed ${count} specimens — <b style="color:var(--gold)">${formatMoneyExact(total)}</b>`,
      kind: 'gold', duration: 7000,
    });
    bus.emit('sub:cargoSold', { sub: s, subId: s.id, count, weight, total, reason });
    return total;
  }

  // ----------------------------------------------------------------- sonar
  ping(s, game) {
    if (s.battery <= 0) return;
    this._pingAge = 0;
    this._sonarSweep = 0;
    s.battery = Math.max(0, s.battery - s.stats.batteryUse * 0.4);
    game.audio.play('sonar_ping', { volume: 0.6 });
    this.refreshContacts(s, game);
  }

  refreshContacts(s, game) {
    const fishSys = game.get('fish');
    const detail = this.sonarDetailOf(s);
    const range = s.stats.sonarRange;
    let list = [];
    if (fishSys?.sonarContacts) {
      try { list = fishSys.sonarContacts(s.position, range, detail); }
      catch (e) { list = []; }
    }
    // Phantoms: the deep returns things that are not there.
    const deep = game.get('deepsea');
    if (deep?.ghostContacts?.length) {
      for (const g of deep.ghostContacts) {
        const d = Math.hypot(g.x - s.position.x, g.z - s.position.z);
        if (d < range) list.push({ x: g.x, y: g.y, z: g.z, dist: d, ghost: true, rarity: null });
      }
    }
    if (list.length > 120) list.length = 120;
    this._contacts = list;
  }

  updateSonar(s, dt, game) {
    this._pingAge += dt;
    this._sonarSweep = (this._sonarSweep + dt * 1.1) % 1;
    this._contactTimer -= dt;
    if (this._contactTimer <= 0) {
      this._contactTimer = 0.5;
      this.refreshContacts(s, game);
    }
  }

  // ------------------------------------------------------------------- HUD
  buildHUD() {
    const root = document.getElementById('ui-root');
    if (!root || document.getElementById('sub-hud')) return;

    if (!document.getElementById('sub-hud-style')) {
      const style = document.createElement('style');
      style.id = 'sub-hud-style';
      style.textContent = SUB_HUD_CSS;
      document.head.appendChild(style);
    }

    const el = document.createElement('div');
    el.id = 'sub-hud';
    el.innerHTML = `
      <div class="sh-tape"><canvas width="66" height="300"></canvas><div class="sh-tape-label">DEPTH</div></div>
      <div class="sh-cluster">
        <div class="sh-name">—</div>
        <div class="sh-readouts">
          <div><b data-r="depth">0</b><span>m DEPTH</span></div>
          <div><b data-r="speed">0.0</b><span>m/s</span></div>
          <div><b data-r="heading">000</b><span>HDG</span></div>
          <div><b data-r="cargo">0</b><span>kg HOLD</span></div>
        </div>
        <div class="sh-bar-row"><span>HULL</span><div class="sh-bar hull"><i></i></div><em data-b="hull">100%</em></div>
        <div class="sh-bar-row"><span>POWER</span><div class="sh-bar power"><i></i></div><em data-b="power">100%</em></div>
        <div class="sh-bar-row"><span>O2</span><div class="sh-bar oxy"><i></i></div><em data-b="oxy">100%</em></div>
        <div class="sh-crush"><b data-r="crush">220</b> m CRUSH</div>
      </div>
      <div class="sh-scope">
        <canvas width="180" height="180"></canvas>
        <div class="sh-scope-label">SONAR <b data-r="range">70</b>m</div>
      </div>
      <div class="sh-warn"><b>⚠ CRUSH DEPTH EXCEEDED</b><span>HULL FAILING — ASCEND</span></div>
      <div class="sh-flash"></div>`;
    root.appendChild(el);

    this.hud = {
      el,
      tape: el.querySelector('.sh-tape canvas'),
      scope: el.querySelector('.sh-scope canvas'),
      name: el.querySelector('.sh-name'),
      warn: el.querySelector('.sh-warn'),
      flash: el.querySelector('.sh-flash'),
      r: {},
      b: {},
      fill: {
        hull: el.querySelector('.sh-bar.hull > i'),
        power: el.querySelector('.sh-bar.power > i'),
        oxy: el.querySelector('.sh-bar.oxy > i'),
      },
    };
    for (const n of el.querySelectorAll('[data-r]')) this.hud.r[n.dataset.r] = n;
    for (const n of el.querySelectorAll('[data-b]')) this.hud.b[n.dataset.b] = n;
    this.hud.tapeCtx = this.hud.tape.getContext('2d');
    this.hud.scopeCtx = this.hud.scope.getContext('2d');
  }

  setHudVisible(v) {
    this.hudVisible = v;
    if (this.hud) this.hud.el.classList.toggle('show', !!v);
  }

  flash(text, color) {
    if (!this.hud) return;
    this.hud.flash.innerHTML = `<span style="color:${color}">${text}</span>`;
    this.hud.flash.classList.remove('go');
    void this.hud.flash.offsetWidth;
    this.hud.flash.classList.add('go');
  }

  updateHUD(s, dt, game) {
    const h = this.hud;
    if (!h) return;
    const st = s.stats;
    const crush = this.crushDepthOf(s);

    h.name.textContent = `${s.icon} ${s.name} · ${s.locationLabel}`;
    h.r.depth.textContent = s.depth.toFixed(s.depth < 100 ? 1 : 0);
    h.r.speed.textContent = Math.hypot(s.velocity.x, s.velocity.z).toFixed(1);
    h.r.heading.textContent = String(Math.round(((s.heading * 180 / Math.PI) % 360 + 360) % 360)).padStart(3, '0');
    h.r.cargo.textContent = `${Math.round(s.cargoWeight)}/${Math.round(st.cargo)}`;
    h.r.crush.textContent = Math.round(crush);
    h.r.range.textContent = Math.round(st.sonarRange);

    const hull = clamp01(s.hull / st.hullStrength);
    const power = clamp01(s.battery / st.battery);
    const oxy = clamp01(s.oxygen / st.oxygen);
    h.fill.hull.style.width = `${(hull * 100).toFixed(1)}%`;
    h.fill.power.style.width = `${(power * 100).toFixed(1)}%`;
    h.fill.oxy.style.width = `${(oxy * 100).toFixed(1)}%`;
    h.b.hull.textContent = `${Math.round(hull * 100)}%`;
    h.b.power.textContent = `${Math.round(power * 100)}%`;
    h.b.oxy.textContent = formatTime(s.oxygen);
    h.fill.hull.classList.toggle('low', hull < 0.3);
    h.fill.power.classList.toggle('low', power < 0.2);
    h.fill.oxy.classList.toggle('low', oxy < 0.15);

    const danger = s.depth > crush;
    h.warn.classList.toggle('show', danger);
    h.el.classList.toggle('danger', danger);

    // Instrument redraw is throttled: the tape and the scope don't need 120 Hz.
    this._hudTimer -= dt;
    if (this._hudTimer <= 0) {
      this._hudTimer = 1 / 24;
      this.drawTape(h.tapeCtx, s, crush);
      this.drawScope(h.scopeCtx, s);
    }
  }

  drawTape(ctx, s, crush) {
    const W = 66, H = 300;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,12,18,0.72)';
    ctx.fillRect(0, 0, W, H);

    const depth = s.depth;
    // 1 px = SCALE metres, centred on the current depth.
    const scale = depth > 900 ? 4 : depth > 300 ? 1.6 : 0.55;
    const top = depth - (H / 2) * scale;

    // Crush-depth band.
    const crushY = (crush - top) / scale;
    if (crushY < H) {
      ctx.fillStyle = 'rgba(255,84,112,0.22)';
      ctx.fillRect(0, Math.max(0, crushY), W, H - Math.max(0, crushY));
      ctx.strokeStyle = '#ff5470';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, crushY); ctx.lineTo(W, crushY); ctx.stroke();
    }
    // Surface line.
    const surfY = (0 - top) / scale;
    if (surfY > 0 && surfY < H) {
      ctx.strokeStyle = '#43a9ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, surfY); ctx.lineTo(W, surfY); ctx.stroke();
    }

    const step = scale > 3 ? 200 : scale > 1 ? 50 : 10;
    const first = Math.ceil(top / step) * step;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let d = first; ; d += step) {
      const y = (d - top) / scale;
      if (y > H) break;
      if (y < -10) continue;
      const major = d % (step * 5) === 0;
      ctx.strokeStyle = major ? 'rgba(165,188,205,0.85)' : 'rgba(111,139,161,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W - (major ? 20 : 11), y);
      ctx.lineTo(W, y);
      ctx.stroke();
      if (major && d >= 0) {
        ctx.fillStyle = 'rgba(165,188,205,0.9)';
        ctx.fillText(String(d), 3, y);
      }
    }
    // Current-depth cursor.
    ctx.fillStyle = s.depth > crush ? '#ff5470' : '#2fd4c4';
    ctx.beginPath();
    ctx.moveTo(W, H / 2); ctx.lineTo(W - 12, H / 2 - 6); ctx.lineTo(W - 12, H / 2 + 6);
    ctx.closePath(); ctx.fill();
    ctx.fillRect(0, H / 2 - 0.5, W, 1);
  }

  drawScope(ctx, s) {
    const S = 180, C = S / 2;
    const R = C - 6;
    ctx.clearRect(0, 0, S, S);

    ctx.save();
    ctx.beginPath(); ctx.arc(C, C, R, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(4,16,20,0.82)';
    ctx.fillRect(0, 0, S, S);

    // Rings + cross hairs.
    ctx.strokeStyle = 'rgba(47,212,196,0.22)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath(); ctx.arc(C, C, (R * i) / 3, 0, TAU); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(C, C - R); ctx.lineTo(C, C + R);
    ctx.moveTo(C - R, C); ctx.lineTo(C + R, C);
    ctx.stroke();

    // Sweep wedge.
    const sweep = this._sonarSweep * TAU;
    const grad = ctx.createRadialGradient(C, C, 0, C, C, R);
    grad.addColorStop(0, 'rgba(47,212,196,0.30)');
    grad.addColorStop(1, 'rgba(47,212,196,0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(C, C);
    ctx.arc(C, C, R, sweep - 0.55, sweep);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,255,230,0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(C, C);
    ctx.lineTo(C + Math.cos(sweep - Math.PI / 2) * R, C + Math.sin(sweep - Math.PI / 2) * R);
    ctx.stroke();

    // Contacts, rotated into the sub's own frame (bow = up).
    const detail = this.sonarDetailOf(s);
    const range = Math.max(1, s.stats.sonarRange);
    const cos = Math.cos(-s.heading), sin = Math.sin(-s.heading);
    ctx.font = '8px ui-monospace, monospace';
    for (const c of this._contacts) {
      const dx = c.x - s.position.x, dz = c.z - s.position.z;
      // Sub-space: +Z is the bow, so screen-up is +Z.
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      const px = C + (rx / range) * R;
      const py = C - (rz / range) * R;
      if (Math.hypot(px - C, py - C) > R - 1) continue;

      // Fade with the sweep so contacts bloom as the beam passes them.
      let a = Math.atan2(rx, rz);
      if (a < 0) a += TAU;
      let age = (sweep - a + TAU) % TAU;
      const alpha = clamp01(1 - age / (TAU * 0.85));

      const dy = (c.depth ?? c.y ?? s.position.y) - s.position.y;
      let col = c.ghost ? '185,140,255' : dy > 4 ? '110,200,255' : dy < -4 ? '255,190,90' : '90,255,190';
      if (detail >= 3 && c.rarity && RARITY[c.rarity]) {
        const rc = new THREE.Color(RARITY[c.rarity].color);
        col = `${Math.round(rc.r * 255)},${Math.round(rc.g * 255)},${Math.round(rc.b * 255)}`;
      }
      const size = detail >= 3 && c.size ? clamp(1.6 + Math.log10(1 + c.size) * 1.8, 1.6, 5.5) : 2.2;
      ctx.fillStyle = `rgba(${col},${(0.22 + alpha * 0.78).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(px, py, size, 0, TAU); ctx.fill();
      if (detail >= 4 && c.species && alpha > 0.55) {
        ctx.fillStyle = `rgba(200,240,255,${(alpha * 0.8).toFixed(2)})`;
        ctx.fillText(c.species.slice(0, 12), px + 5, py + 3);
      }
    }

    // Own ship.
    ctx.fillStyle = '#ffc22e';
    ctx.beginPath();
    ctx.moveTo(C, C - 6); ctx.lineTo(C - 4, C + 5); ctx.lineTo(C + 4, C + 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(47,212,196,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(C, C, R, 0, TAU); ctx.stroke();
  }

  // ------------------------------------------------------- interactables
  updateInteractables(game) {
    const world = game.get('world');
    if (!world) return;
    world.interactables = world.interactables.filter((i) => i.kind !== 'boardSub');
    if (this.driving) return;
    const player = game.get('player');
    if (!player) return;
    for (const s of this.owned) {
      if (s.expedition) continue;
      if (dist2DSq(s.position.x, s.position.z, player.position.x, player.position.z) > 900) continue;
      world.interactables.push({
        region: s.region, kind: 'boardSub',
        label: `Board ${s.name}`, key: 'E',
        position: s.position.clone().setY(s.position.y + s.def.hull.height * 0.5),
        radius: 5 + s.def.hull.width * 0.6,
        data: { subId: s.id },
      });
    }
  }

  // ------------------------------------------------------- sub expeditions
  /**
   * Autonomous crewed dives. Same idea as FleetSystem's trips, but a sub
   * expedition is simulated purely statistically — nobody ever sees it — so it
   * is a state machine over money, discoveries, battery and hull.
   *
   * @param {object} d {subId, crewIds, band}
   */
  startExpedition(d = {}) {
    const s = this.byId(d.subId);
    if (!s) { bus.emit('toast', { text: 'Pick a submarine for the expedition.', kind: 'error' }); return null; }
    if (s.expedition) { bus.emit('toast', { text: `${s.name} is already out.`, kind: 'error' }); return null; }
    if (this.driving === s) { bus.emit('toast', { text: `You are piloting ${s.name}.`, kind: 'error' }); return null; }

    const band = BAND_BY_ID[d.band] || DEPTH_BANDS[0];
    const crush = this.crushDepthOf(s);
    if (band.depth > crush * 0.92) {
      bus.emit('toast', { text: `${s.name} is rated to ${Math.round(crush)} m — ${band.name} is ${band.depth} m.`, kind: 'error', duration: 6000 });
      return null;
    }
    if (s.hull < s.stats.hullStrength * 0.35) {
      bus.emit('toast', { text: `${s.name}'s hull is too damaged to certify.`, kind: 'error' }); return null;
    }

    const workers = this.game.get('workers');
    const crew = (d.crewIds || []).map((id) => workers?.byId(id)).filter(Boolean);
    const pilot = crew.find((w) => w.role === 'subpilot') || crew.find((w) => w.role === 'captain');
    if (workers && workers.workers?.length && !pilot) {
      bus.emit('toast', { text: 'An expedition needs a sub pilot (or a captain).', kind: 'error' });
      return null;
    }
    if (crew.length > s.stats.crew) {
      bus.emit('toast', { text: `${s.name} seats ${Math.round(s.stats.crew)}.`, kind: 'error' }); return null;
    }

    const sonarOp = crew.find((w) => w.role === 'sonar');
    const diver = crew.find((w) => w.role === 'diver' || w.role === 'hunter');

    const e = {
      id: d.id || `x${_expId++}`,
      subId: s.id, sub: s,
      crewIds: crew.map((w) => w.id), crew,
      pilot, sonarOp, diver,
      bandId: band.id, band,
      state: EXP_STATE.PREP,
      stateLabel: EXP_LABEL.prep,
      stateTime: 0,
      progress: 0,
      // Scaled so a shelf run is a couple of minutes and a hadal run is a slog.
      durations: {
        prep: 6,
        descent: band.minutes * 18 * (1 / Math.max(0.4, s.stats.ascendRate / 3)),
        survey: band.minutes * 34,
        ascent: band.minutes * 14,
        debrief: 5,
      },
      eventTimer: 3,
      specimens: [],
      discoveries: [],
      salvage: 0,
      hullDamage: 0,
      batteryStart: s.battery,
      log: [],
      recalled: false,
    };
    s.expedition = e;
    s.docked = false;
    this.despawnPhysical(s);
    for (const w of crew) { w.assignment = `sub:${e.id}`; w.subExpedition = e; }
    this.expeditions.push(e);

    this.game.audio?.play('sub_dive', { volume: 0.5 });
    bus.emit('toast', {
      text: `${s.icon} <b>${s.name}</b> diving to the ${band.name} (${band.depth} m)`,
      kind: '', duration: 6000,
    });
    bus.emit('subs:changed', { count: this.owned.length, sub: s });
    bus.emit('sub:expeditionStarted', { expedition: e });
    return e;
  }

  recallExpedition(id) {
    const e = this.expeditions.find((x) => x.id === id);
    if (!e || e.recalled) return;
    e.recalled = true;
    if (e.state === EXP_STATE.SURVEY || e.state === EXP_STATE.DESCENT) this.setExpState(e, EXP_STATE.ASCENT);
    bus.emit('toast', { text: `${e.sub.name} recalled.`, kind: '' });
  }

  setExpState(e, state) {
    e.state = state;
    e.stateLabel = EXP_LABEL[state] || state;
    e.stateTime = 0;
    bus.emit('sub:expeditionState', { expedition: e, state });
  }

  updateExpeditions(dt, game) {
    for (let i = this.expeditions.length - 1; i >= 0; i--) {
      const e = this.expeditions[i];
      e.stateTime += dt;
      const s = e.sub;
      const dur = e.durations[e.state] || 1;
      e.progress = clamp01(e.stateTime / dur);

      switch (e.state) {
        case EXP_STATE.PREP:
          if (e.stateTime >= dur) this.setExpState(e, EXP_STATE.DESCENT);
          break;

        case EXP_STATE.DESCENT: {
          s.depth = e.band.depth * e.progress;
          s.battery = Math.max(0, s.battery - s.stats.batteryUse * 0.55 * dt);
          if (e.stateTime >= dur) { this.setExpState(e, EXP_STATE.SURVEY); e.log.push('On station.'); }
          break;
        }

        case EXP_STATE.SURVEY: {
          s.depth = e.band.depth;
          s.battery = Math.max(0, s.battery - s.stats.batteryUse * 0.85 * dt);
          e.eventTimer -= dt;
          if (e.eventTimer <= 0) {
            e.eventTimer = clamp(16 / this.expeditionRate(e), 4, 40);
            this.rollExpeditionEvent(e, game);
          }
          const bail = s.battery <= s.stats.battery * 0.22
            || s.hull <= s.stats.hullStrength * 0.25
            || s.cargoWeight + e.specimens.reduce((a, x) => a + x.weight, 0) >= s.stats.cargo;
          if (e.stateTime >= dur || bail || e.recalled) {
            if (bail && e.stateTime < dur) e.log.push(s.battery <= s.stats.battery * 0.22 ? 'Aborted: power low.' : 'Aborted: hull damage.');
            this.setExpState(e, EXP_STATE.ASCENT);
          }
          break;
        }

        case EXP_STATE.ASCENT: {
          s.depth = e.band.depth * (1 - e.progress);
          s.battery = Math.max(0, s.battery - s.stats.batteryUse * 0.45 * dt);
          if (e.stateTime >= dur) this.setExpState(e, EXP_STATE.DEBRIEF);
          break;
        }

        case EXP_STATE.DEBRIEF: {
          s.depth = 0;
          if (e.stateTime >= dur) { this.completeExpedition(e, game); this.expeditions.splice(i, 1); }
          break;
        }
        default:
          this.expeditions.splice(i, 1);
      }
    }
  }

  /** Events per unit time — better crew and better sonar find more, faster. */
  expeditionRate(e) {
    const s = e.sub;
    let rate = 1 + s.stats.sonarDetail * 0.14 + (s.stats.armTier || 0) * 0.2;
    if (e.pilot) rate *= 1 + (e.pilot.level || 1) * 0.03;
    if (e.sonarOp) rate *= 1.35 + (e.sonarOp.skills?.perception ?? 3) * 0.03;
    if (e.diver) rate *= 1.25;
    // A fully-teched company should be better at this, not twenty times better.
    const research = this.game.get('research');
    rate *= clamp(research?.catchRateMult ?? 1, 1, 1.6);
    return clamp(rate, 0.25, 4);
  }

  rollExpeditionEvent(e, game) {
    const s = e.sub;
    const band = e.band;
    const rng = this.rng;
    const luck = 1 + (e.diver ? 0.4 : 0) + (e.sonarOp ? 0.25 : 0);

    const roll = rng();
    // Specimen ~ 62%, salvage ~ 16%, discovery ~ 10%, hazard ~ 12%.
    if (roll < 0.62) {
      const pool = speciesForHabitat(DEEP_HABITATS, band.depth, {
        depthSlack: band.depth * 0.5, bosses: false, junk: false,
      });
      if (!pool.length) return;
      const pick = weightedPick(pool.map((sp) => ({ sp, weight: sp.spawnWeight })), rng)?.sp;
      if (!pick) return;
      const inst = rollFishInstance(pick, rng, { luck, sizeBias: e.diver ? 0.3 : 0.1 });
      if (!inst) return;
      const totalW = e.specimens.reduce((a, x) => a + x.weight, 0);
      if (totalW + inst.weight > s.stats.cargo) return;
      e.specimens.push(inst);
      if (e.diver) e.diver.stats && (e.diver.stats.caught = (e.diver.stats.caught || 0) + 1);
    } else if (roll < 0.78) {
      const value = Math.round(band.valueMult * rrange(900, 5200) * (1 + (s.stats.armTier || 0) * 0.4));
      e.salvage += value;
      e.log.push(`Recovered ${rpick(SALVAGE)} — ${formatMoneyExact(value)}`);
    } else if (roll < 0.88) {
      const d = rpick(DISCOVERIES);
      if (e.discoveries.length < 4 && !e.discoveries.includes(d)) {
        e.discoveries.push(d);
        e.log.push(`Logged: ${d}`);
      }
    } else {
      const severity = band.risk * rrange(0.4, 1.4) * (e.pilot ? 0.75 : 1.15);
      const dmg = s.stats.hullStrength * 0.05 * severity;
      s.hull = Math.max(0, s.hull - dmg);
      e.hullDamage += dmg;
      e.log.push(`${rpick(HAZARDS)} — hull −${Math.round(dmg)}`);
      if (s.hull <= 0) {
        // She does not come back.
        s.hull = 0;
        e.lost = true;
        this.setExpState(e, EXP_STATE.DEBRIEF);
      }
    }
    if (e.log.length > 24) e.log.shift();
  }

  completeExpedition(e, game) {
    const s = e.sub;
    const eco = game.get('economy');
    s.expedition = null;
    s.depth = 0;
    s.docked = true;
    for (const w of e.crew) { w.assignment = null; w.subExpedition = null; }

    if (e.lost) {
      const idx = this.owned.indexOf(s);
      if (idx >= 0) this.owned.splice(idx, 1);
      bus.emit('toast', {
        text: `💀 <b>${s.name}</b> did not come back up. ${e.crew.length ? `${e.crew.length} crew lost.` : ''}`,
        kind: 'error', duration: 10000,
      });
      game.audio?.play('ui_error', { volume: 0.8 });
      bus.emit('sub:expeditionComplete', { expedition: e, lost: true, total: 0 });
      bus.emit('subs:changed', { count: this.owned.length });
      return;
    }

    let specimenValue = 0;
    for (const inst of e.specimens) {
      const price = eco ? eco.priceFor(inst) : inst.value;
      specimenValue += price;
      eco?.recordCatch(inst, e.pilot?.name || 'Sub crew');
      eco?.recordSale(inst, price, e.pilot?.name || 'Sub crew');
    }
    const discoveryValue = e.discoveries.length * Math.round(e.band.valueMult * 2400);
    const total = Math.round(specimenValue + e.salvage + discoveryValue);
    eco?.add(total, 'sub_expedition');
    s.lifetimeProfit += total;
    s.trips++;

    const xp = Math.round(40 + e.band.valueMult * 12 + e.specimens.length * 4);
    for (const w of e.crew) { w.addXP?.(xp, game); w.stats && (w.stats.trips = (w.stats.trips || 0) + 1); }

    this.returnSubToBay(s);

    game.audio?.play('cash_register', { volume: 0.7 });
    bus.emit('toast', {
      text: `${s.icon} <b>${s.name}</b> surfaced from the ${e.band.name}<br>`
        + `${e.specimens.length} specimens · ${e.discoveries.length} discoveries · hull −${Math.round(e.hullDamage)}<br>`
        + `<b style="color:var(--gold)">${formatMoneyExact(total)}</b>`,
      kind: 'gold', duration: 10000,
    });
    bus.emit('sub:expeditionComplete', {
      expedition: e, subId: s.id, total, specimenValue,
      salvage: e.salvage, discoveries: e.discoveries.slice(), count: e.specimens.length,
    });
    bus.emit('subs:changed', { count: this.owned.length, sub: s });
  }

  returnSubToBay(s) {
    const region = this.bayRegion();
    const slot = Math.max(0, this.owned.indexOf(s));
    const berth = this.bayBerth(region, slot);
    s.region = region;
    s.position.set(berth.x, waterHeightAt(berth.x, berth.z) - s.def.physics.hy * 0.35, berth.z);
    s.heading = berth.heading;
    s.velocity.set(0, 0, 0);
    s.yawVel = 0; s.pitch = 0; s.roll = 0;
    s.locationLabel = REGION_BY_ID[region]?.short || 'Sub bay';
  }

  // --------------------------------------------------------------- persist
  save() {
    return {
      subs: this.owned.map((s) => ({
        id: s.id, defId: s.defId, name: s.name, upgrades: s.upgrades,
        hull: s.hull, battery: s.battery, oxygen: s.oxygen,
        region: s.region, x: s.position.x, y: s.position.y, z: s.position.z,
        heading: s.heading, lightsOn: s.lightsOn,
        cargo: s.cargo, cargoWeight: s.cargoWeight,
        trips: s.trips, lifetimeProfit: s.lifetimeProfit, deepest: s.deepest,
      })),
      expeditions: this.expeditions.map((e) => ({
        id: e.id, subId: e.subId, crewIds: e.crewIds, bandId: e.bandId,
        state: e.state, stateTime: e.stateTime, durations: e.durations,
        specimens: e.specimens, discoveries: e.discoveries, salvage: e.salvage,
        hullDamage: e.hullDamage, log: e.log, recalled: e.recalled, lost: e.lost,
      })),
      nextId: _subId, nextExpId: _expId,
      cameraMode: this.cameraMode,
    };
  }

  load(d) {
    if (this.driving) this.disembark();
    for (const s of [...this.owned]) this.despawnPhysical(s);
    this.owned.length = 0;
    this.expeditions.length = 0;
    if (!d) return;
    _subId = d.nextId || _subId;
    _expId = d.nextExpId || _expId;
    this.cameraMode = d.cameraMode ?? 0;
    for (const sd of d.subs || []) this.grant(sd.defId, sd);

    const workers = this.game.get('workers');
    for (const ed of d.expeditions || []) {
      const s = this.byId(ed.subId);
      if (!s) continue;
      const crew = (ed.crewIds || []).map((id) => workers?.byId(id)).filter(Boolean);
      const e = {
        ...ed,
        sub: s, crew,
        band: BAND_BY_ID[ed.bandId] || DEPTH_BANDS[0],
        pilot: crew.find((w) => w.role === 'subpilot') || crew.find((w) => w.role === 'captain'),
        sonarOp: crew.find((w) => w.role === 'sonar'),
        diver: crew.find((w) => w.role === 'diver' || w.role === 'hunter'),
        stateLabel: EXP_LABEL[ed.state] || ed.state,
        eventTimer: 3, progress: 0,
        batteryStart: s.battery,
        specimens: ed.specimens || [], discoveries: ed.discoveries || [], log: ed.log || [],
      };
      s.expedition = e;
      for (const w of crew) { w.assignment = `sub:${e.id}`; w.subExpedition = e; }
      this.expeditions.push(e);
    }
    bus.emit('subs:changed', { count: this.owned.length });
  }
}

// --------------------------------------------------------------------------
const SALVAGE = [
  'a sealed cargo container', 'a ship\'s bell, still legible', 'a crate of ballast ingots',
  'a black box from something that was never reported missing', 'a bronze propeller',
  'an anchor chain the length of the sub', 'a strongbox nobody wants opened',
  'a manganese nodule field', 'a rack of intact amphorae',
];

const DISCOVERIES = [
  'a cold seep with no name', 'a whale fall, three years gone', 'a new vent chimney field',
  'a bioluminescent bloom, kilometres across', 'a wreck not on any chart',
  'a brine pool with a shoreline', 'a basalt arch two hundred metres tall',
  'a species the atlas has no page for', 'a thermocline that reads like a wall',
];

const HAZARDS = [
  'Struck an uncharted pinnacle', 'Ballast valve froze', 'Something large brushed the hull',
  'Rock fall off the trench wall', 'Thruster fouled on a net', 'Seal weep in the aft compartment',
  'Pressure spike in a wave train',
];

const SUB_PREFIX = ['Deep', 'Black', 'Silent', 'Iron', 'Cold', 'Pale', 'Long', 'Quiet', 'Blue', 'Grey'];
const SUB_SUFFIX = ['Lantern', 'Sounding', 'Fathom', 'Descent', 'Trench', 'Bell', 'Nautilus', 'Vigil', 'Marrow', 'Kestrel'];
function generateSubName(def, n) {
  const a = SUB_PREFIX[(Math.random() * SUB_PREFIX.length) | 0];
  const b = SUB_SUFFIX[(Math.random() * SUB_SUFFIX.length) | 0];
  return `${a} ${b}`;
}

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function disposeDeep(o) {
  o?.traverse?.((c) => { if (c.isMesh) { c.geometry?.dispose(); } });
}

// --------------------------------------------------------------------------
const SUB_HUD_CSS = `
#sub-hud {
  position: absolute; inset: 0; opacity: 0; visibility: hidden;
  transition: opacity .25s ease; pointer-events: none; z-index: 2;
  font-family: var(--mono, ui-monospace, monospace);
}
#sub-hud.show { opacity: 1; visibility: visible; }
#sub-hud .sh-tape {
  position: absolute; left: 20px; top: 50%; transform: translateY(-50%);
  border: 1px solid rgba(47,212,196,.28); border-radius: 4px; overflow: hidden;
  background: rgba(6,12,18,.55); backdrop-filter: blur(6px);
  box-shadow: 0 6px 26px rgba(0,0,0,.5);
}
#sub-hud .sh-tape canvas { display: block; }
#sub-hud .sh-tape-label {
  position: absolute; top: 3px; left: 0; right: 0; text-align: center;
  font-size: 8.5px; letter-spacing: .18em; color: rgba(47,212,196,.85); font-weight: 800;
}
#sub-hud .sh-cluster {
  position: absolute; left: 100px; bottom: 22px; width: 292px;
  background: rgba(6,12,18,.68); border: 1px solid rgba(47,212,196,.22);
  border-radius: 6px; padding: 10px 12px 11px; backdrop-filter: blur(7px);
  box-shadow: 0 8px 30px rgba(0,0,0,.55);
}
#sub-hud.danger .sh-cluster { border-color: rgba(255,84,112,.65); box-shadow: 0 0 26px rgba(255,84,112,.28); }
#sub-hud .sh-name {
  font-size: 11px; letter-spacing: .1em; color: var(--accent, #2fd4c4);
  text-transform: uppercase; font-weight: 800; margin-bottom: 7px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#sub-hud .sh-readouts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 9px; }
#sub-hud .sh-readouts > div { text-align: center; }
#sub-hud .sh-readouts b {
  display: block; font-size: 17px; font-weight: 900; color: var(--ink, #eaf4fb);
  font-variant-numeric: tabular-nums; line-height: 1.05;
}
#sub-hud .sh-readouts span { font-size: 8px; letter-spacing: .1em; color: var(--ink-faint, #6f8ba1); }
#sub-hud .sh-bar-row { display: flex; align-items: center; gap: 7px; margin-top: 4px; }
#sub-hud .sh-bar-row > span { font-size: 9px; width: 38px; color: var(--ink-faint, #6f8ba1); letter-spacing: .08em; font-weight: 800; }
#sub-hud .sh-bar-row > em { font-size: 9.5px; width: 44px; text-align: right; font-style: normal; color: var(--ink-dim, #a5bccd); font-variant-numeric: tabular-nums; }
#sub-hud .sh-bar { flex: 1; height: 7px; background: rgba(255,255,255,.08); border-radius: 2px; overflow: hidden; }
#sub-hud .sh-bar > i { display: block; height: 100%; width: 100%; transition: width .16s linear; }
#sub-hud .sh-bar.hull > i { background: linear-gradient(90deg,#2fd4c4,#43a9ff); }
#sub-hud .sh-bar.power > i { background: linear-gradient(90deg,#ffc22e,#ffa23a); }
#sub-hud .sh-bar.oxy > i { background: linear-gradient(90deg,#7fd8e8,#43a9ff); }
#sub-hud .sh-bar > i.low { background: linear-gradient(90deg,#ff5470,#ff8a3a); animation: shPulse .9s ease-in-out infinite; }
@keyframes shPulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
#sub-hud .sh-crush { margin-top: 8px; font-size: 9.5px; color: var(--ink-faint, #6f8ba1); letter-spacing: .1em; }
#sub-hud .sh-crush b { color: #ff8a9c; font-size: 12px; }
#sub-hud .sh-scope {
  position: absolute; right: 22px; bottom: 22px; width: 180px;
  border-radius: 50%; box-shadow: 0 8px 30px rgba(0,0,0,.6);
}
#sub-hud .sh-scope canvas { display: block; border-radius: 50%; }
#sub-hud .sh-scope-label {
  position: absolute; left: 0; right: 0; bottom: -15px; text-align: center;
  font-size: 8.5px; letter-spacing: .18em; color: rgba(47,212,196,.8); font-weight: 800;
}
#sub-hud .sh-warn {
  position: absolute; left: 50%; top: 15%; transform: translateX(-50%);
  text-align: center; opacity: 0; transition: opacity .18s;
  color: #ff5470; text-shadow: 0 0 18px rgba(255,84,112,.7);
}
#sub-hud .sh-warn.show { opacity: 1; animation: shBlink .7s steps(2) infinite; }
#sub-hud .sh-warn b { display: block; font-size: 20px; font-weight: 900; letter-spacing: .14em; }
#sub-hud .sh-warn span { font-size: 11px; letter-spacing: .22em; color: #ffa8b6; }
@keyframes shBlink { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
#sub-hud .sh-flash {
  position: absolute; left: 50%; top: 62%; transform: translateX(-50%);
  font-size: 15px; font-weight: 900; letter-spacing: .06em; opacity: 0; white-space: nowrap;
  text-shadow: 0 2px 12px rgba(0,0,0,.9);
}
#sub-hud .sh-flash.go { animation: shFlash 1.6s ease-out forwards; }
@keyframes shFlash {
  0% { opacity: 0; transform: translate(-50%, 10px) }
  14% { opacity: 1; transform: translate(-50%, 0) }
  70% { opacity: 1 }
  100% { opacity: 0; transform: translate(-50%, -14px) }
}
`;
