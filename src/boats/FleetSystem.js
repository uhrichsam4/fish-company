import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { REGIONS, REGION_BY_ID } from '../data/regions.js';
import { speciesInRegion, rollFishInstance, getSpecies, RARITY } from '../data/fishData.js';
import { WS } from '../workers/Worker.js';
import { worldHeight } from '../world/Terrain.js';
import { waterHeightAt } from '../world/waves.js';
import {
  clamp, clamp01, lerp, damp, rrange, rint, rpick, rchance, makeRNG, weightedPick,
  formatMoneyExact, formatWeight, dist2DSq, TAU,
} from '../util/math.js';

export const FLEET_STATE = {
  DOCKED: 'docked', BOARDING: 'boarding', DEPARTING: 'departing', TRAVELLING: 'travelling',
  FISHING: 'fishing', RETURNING: 'returning', DOCKING: 'docking', UNLOADING: 'unloading',
  BROKEN: 'broken', STRANDED: 'stranded',
};

const STATE_LABEL = {
  docked: 'Docked', boarding: 'Crew boarding', departing: 'Leaving harbour',
  travelling: 'In transit', fishing: 'Fishing', returning: 'Returning',
  docking: 'Docking', unloading: 'Unloading', broken: 'Broken down', stranded: 'Out of fuel',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
let _fleetId = 1;

/**
 * Crews, autonomous fishing trips and the near/far simulation split.
 *
 * Near the player the boat is a real physics body, the crew physically board
 * it and stand on deck, and the hull is steered by an autopilot. Far away the
 * same trip advances as route + fuel + cargo + XP maths. Both paths write to
 * the same fleet record, so approaching a distant fleet reconstructs a
 * believable physical state rather than resetting it.
 */
export class FleetSystem {
  constructor(game) {
    this.game = game;
    this.name = 'fleets';
    this.order = 78;
    this.fleets = [];
    this.nearRadius = 220;
    this.rng = makeRNG(50505);
  }

  async init(game) {
    bus.on('company:newFleet', () => this.openCreator());
    bus.on('company:launchFleet', ({ id }) => this.launch(id));
    bus.on('company:recallFleet', ({ id }) => this.recall(id));
    bus.on('company:disbandFleet', ({ id }) => this.disband(id));
    bus.on('company:editFleet', ({ id }) => bus.emit('ui:show', { id: 'fleetEditor', data: { id } }));
    bus.on('fleet:create', (d) => this.create(d));
    bus.on('fleet:setTarget', ({ id, region }) => {
      const f = this.byId(id);
      if (f) { f.targetRegion = region; bus.emit('fleets:changed', { count: this.fleets.length }); }
    });
    return this;
  }

  byId(id) { return this.fleets.find((f) => f.id === id) || null; }
  totalCargo() { return this.fleets.reduce((a, f) => a + (f.cargoWeight || 0), 0); }

  /**
   * @param {object} d {boatId, crewIds, targetRegion, name}
   */
  create(d) {
    const boats = this.game.get('boats');
    const workers = this.game.get('workers');
    const boat = boats?.byId(d.boatId);
    if (!boat) { bus.emit('toast', { text: 'Pick a boat for the fleet.', kind: 'error' }); return null; }
    if (boat.fleet) { bus.emit('toast', { text: `${boat.name} is already crewed.`, kind: 'error' }); return null; }
    const crew = (d.crewIds || []).map((id) => workers?.byId(id)).filter(Boolean);
    const captain = crew.find((w) => w.role === 'captain');
    if (!captain) { bus.emit('toast', { text: 'A fleet needs a captain.', kind: 'error' }); return null; }
    if (!crew.some((w) => w.role === 'fisherman' || w.role === 'hunter')) {
      bus.emit('toast', { text: 'A fleet needs at least one fisherman.', kind: 'error' }); return null;
    }
    if (crew.length > boat.stats.crew) {
      bus.emit('toast', { text: `${boat.name} only holds ${boat.stats.crew} crew.`, kind: 'error' }); return null;
    }

    const f = {
      id: d.id || `f${_fleetId++}`,
      name: d.name || `${boat.name} Crew`,
      boat, boatId: boat.id,
      crew, crewIds: crew.map((w) => w.id),
      captain,
      targetRegion: d.targetRegion || boat.region,
      homeRegion: d.homeRegion || boat.region,
      state: FLEET_STATE.DOCKED,
      stateLabel: STATE_LABEL.docked,
      stateTime: 0,
      progress: 0,
      cargo: [],
      cargoWeight: 0,
      cargoValue: 0,
      trips: d.trips || 0,
      lifetimeProfit: d.lifetimeProfit || 0,
      position: boat.position.clone(),
      route: null,
      fishTimer: 0,
      autoRelaunch: d.autoRelaunch ?? true,
      physical: false,
      log: [],
    };
    boat.fleet = f;
    for (const w of crew) { w.fleet = f; w.assignment = `fleet:${f.id}`; w.setState(WS.IDLE); }
    this.fleets.push(f);
    bus.emit('fleets:changed', { count: this.fleets.length, fleet: f });
    bus.emit('toast', { text: `⚓ Fleet <b>${f.name}</b> formed — ${crew.length} crew aboard ${boat.name}`, kind: 'success', duration: 5000 });
    this.game.audio.play('quest_complete', { volume: 0.5 });
    return f;
  }

  disband(id) {
    const i = this.fleets.findIndex((f) => f.id === id);
    if (i < 0) return;
    const f = this.fleets[i];
    if (f.state !== FLEET_STATE.DOCKED) { bus.emit('toast', { text: 'Recall the fleet first.', kind: 'error' }); return; }
    for (const w of f.crew) { w.fleet = null; w.assignment = null; w.setState(WS.IDLE); }
    if (f.boat) f.boat.fleet = null;
    this.fleets.splice(i, 1);
    bus.emit('fleets:changed', { count: this.fleets.length });
  }

  launch(id) {
    const f = this.byId(id);
    if (!f) return;
    if (f.state !== FLEET_STATE.DOCKED) { bus.emit('toast', { text: `${f.name} is already out.`, kind: 'warn' }); return; }
    const b = f.boat;
    if (b.health < 25) { bus.emit('toast', { text: `${b.name} is too damaged to sail.`, kind: 'error' }); return; }
    if (b.def.fuel > 0 && b.fuel < b.stats.fuel * 0.15) {
      bus.emit('toast', { text: `${b.name} needs fuel.`, kind: 'error' }); return;
    }
    const target = REGION_BY_ID[f.targetRegion];
    const quests = this.game.get('quests');
    if (!target || (quests && !quests.isRegionUnlocked(f.targetRegion))) {
      bus.emit('toast', { text: 'That region is not unlocked.', kind: 'error' }); return;
    }
    const home = REGION_BY_ID[f.homeRegion] || REGION_BY_ID.crash;
    const dist = Math.hypot(target.x - home.x, target.z - home.z);
    if (dist > b.stats.range) {
      bus.emit('toast', { text: `${b.name} cannot reach ${target.name} (range ${Math.round(b.stats.range)} m).`, kind: 'error' });
      return;
    }
    f.route = {
      from: { x: home.x, z: home.z },
      to: { x: target.x + Math.cos(target.dockAngle + 0.7) * target.radius * 1.5,
        z: target.z + Math.sin(target.dockAngle + 0.7) * target.radius * 1.5 },
      dist,
    };
    this.setState(f, FLEET_STATE.BOARDING);
    f.log.push({ t: this.game.time, msg: `Departing for ${target.name}` });
    bus.emit('toast', { text: `${f.name} setting out for ${target.name}`, kind: '', duration: 4000 });
  }

  recall(id) {
    const f = this.byId(id);
    if (!f || f.state === FLEET_STATE.DOCKED) return;
    this.setState(f, FLEET_STATE.RETURNING);
    f.progress = 0;
    bus.emit('toast', { text: `${f.name} recalled.`, kind: '' });
  }

  setState(f, s) {
    f.state = s;
    f.stateLabel = STATE_LABEL[s] || s;
    f.stateTime = 0;
    bus.emit('fleet:state', { fleet: f, state: s });
  }

  // ------------------------------------------------------------- update
  update(dt, game) {
    if (dt <= 0) return;
    const player = game.get('player');
    for (const f of this.fleets) {
      f.stateTime += dt;
      const near = player && dist2DSq(f.position.x, f.position.z, player.position.x, player.position.z)
        < this.nearRadius * this.nearRadius;
      f.physical = near && f.boat.physical;
      this.tick(f, dt, game, near);
      f.position.copy(f.boat.position);
    }
  }

  tick(f, dt, game, near) {
    const b = f.boat;
    switch (f.state) {
      case FLEET_STATE.DOCKED: {
        f.progress = 0;
        b.throttle = 0; b.steer = 0;
        for (const w of f.crew) if (w.state === WS.ON_BOAT) w.setState(WS.IDLE);
        if (f.autoRelaunch && f.stateTime > 12 && f.trips > 0) this.launch(f.id);
        break;
      }
      case FLEET_STATE.BOARDING: {
        // Crew physically walk to the boat when the player is watching.
        let allAboard = true;
        for (const w of f.crew) {
          w.boat = b;
          if (near && w.physical) {
            const deck = this.deckSlot(f, w);
            if (!w.navTarget && w.position.distanceTo(deck) > 1.4) w.setNavTarget(deck.x, deck.y, deck.z);
            if (w.position.distanceTo(deck) > 1.6) { allAboard = false; w.setState(WS.IDLE); }
            else { w.setState(WS.ON_BOAT); w.navTarget = null; }
          } else {
            // Off-screen: they're aboard after a short beat.
            w.setState(WS.ON_BOAT);
          }
        }
        if (allAboard || f.stateTime > 14) {
          b.engineOn = true;
          game.audio.play('boat_engine_start', { volume: 0.45, position: b.position.clone() });
          this.setState(f, FLEET_STATE.DEPARTING);
          f.captain?.say('arrive');
        }
        break;
      }
      case FLEET_STATE.DEPARTING: {
        // Head out to open water before turning onto the route.
        const home = REGION_BY_ID[f.homeRegion] || REGION_BY_ID.crash;
        _v.set(b.position.x - home.x, 0, b.position.z - home.z);
        const outDist = _v.length();
        if (outDist < home.radius * 1.35 && f.stateTime < 30) {
          this.steerTowards(f, b, home.x + (_v.x / (outDist || 1)) * home.radius * 1.6,
            home.z + (_v.z / (outDist || 1)) * home.radius * 1.6, dt, near);
        } else {
          this.setState(f, FLEET_STATE.TRAVELLING);
        }
        break;
      }
      case FLEET_STATE.TRAVELLING: {
        const to = f.route?.to;
        if (!to) { this.setState(f, FLEET_STATE.FISHING); break; }
        const d = Math.hypot(to.x - b.position.x, to.z - b.position.z);
        const total = Math.max(1, f.route.dist);
        f.progress = clamp01(1 - d / total);
        if (d < 22) { this.setState(f, FLEET_STATE.FISHING); f.captain?.say('arrive'); break; }
        this.steerTowards(f, b, to.x, to.z, dt, near);
        this.burnFuel(f, b, dt, game);
        break;
      }
      case FLEET_STATE.FISHING: {
        b.throttle = damp(b.throttle, 0.08, 0.02, dt);
        b.steer = Math.sin(f.stateTime * 0.12) * 0.35;
        this.crewFish(f, dt, game, near);
        const cap = b.stats.storage;
        f.progress = clamp01(f.cargoWeight / cap);
        if (f.cargoWeight >= cap * 0.985 || f.stateTime > 600) {
          f.captain?.say('full');
          this.setState(f, FLEET_STATE.RETURNING);
        }
        this.burnFuel(f, b, dt * 0.25, game);
        break;
      }
      case FLEET_STATE.RETURNING: {
        const home = REGION_BY_ID[f.homeRegion] || REGION_BY_ID.crash;
        const anchors = game.get('world')?.getAnchors(home.id);
        const dock = anchors?.dockEnd || { x: home.x, z: home.z };
        const d = Math.hypot(dock.x - b.position.x, dock.z - b.position.z);
        f.progress = clamp01(1 - d / Math.max(1, f.route?.dist || 500));
        if (d < 30) { this.setState(f, FLEET_STATE.DOCKING); break; }
        this.steerTowards(f, b, dock.x, dock.z, dt, near);
        this.burnFuel(f, b, dt, game);
        break;
      }
      case FLEET_STATE.DOCKING: {
        const anchors = game.get('world')?.getAnchors(f.homeRegion);
        const dock = anchors?.dockEnd || { x: b.position.x, z: b.position.z };
        const d = Math.hypot(dock.x - b.position.x, dock.z - b.position.z);
        if (d > 8 && f.stateTime < 25) this.steerTowards(f, b, dock.x, dock.z, dt, near, 0.35);
        else {
          b.throttle = 0; b.steer = 0; b.engineOn = false;
          this.setState(f, FLEET_STATE.UNLOADING);
        }
        break;
      }
      case FLEET_STATE.UNLOADING: {
        f.progress = clamp01(f.stateTime / 4);
        if (f.stateTime > 4) { this.completeTrip(f, game); }
        break;
      }
      case FLEET_STATE.STRANDED: {
        b.throttle = 0;
        if (f.stateTime > 45) {
          // The company tows it home and bills itself for the privilege.
          const eco = game.get('economy');
          const cost = Math.round(b.def.price * 0.02);
          eco?.add(-cost, 'towing');
          b.fuel = b.stats.fuel * 0.35;
          bus.emit('toast', { text: `${f.name} was towed home (−${formatMoneyExact(cost)}).`, kind: 'warn' });
          this.setState(f, FLEET_STATE.RETURNING);
        }
        break;
      }
      case FLEET_STATE.BROKEN: {
        b.throttle = 0;
        const mech = f.crew.find((w) => w.role === 'mechanic');
        const rate = mech ? 6 * (1 + mech.treeBonus('repairSpeed')) : 1.2;
        b.health = Math.min(100, b.health + rate * dt);
        if (b.health > 45) { this.setState(f, FLEET_STATE.RETURNING); f.captain?.say('arrive'); }
        break;
      }
    }

    // Keep crew glued to their deck slots while aboard.
    if (near) {
      for (const w of f.crew) {
        if (w.state !== WS.ON_BOAT || !w.physical) continue;
        const slot = this.deckSlot(f, w);
        w.position.lerp(slot, 1 - Math.pow(0.0006, dt));
        w.facing = b.heading + (w.role === 'captain' ? 0 : Math.PI * 0.5);
        w.boat = b;
      }
    }
  }

  /** Where a given crew member stands on deck. */
  deckSlot(f, w) {
    const b = f.boat;
    const def = b.def;
    const idx = f.crew.indexOf(w);
    let local;
    if (w.role === 'captain') local = _v2.set(def.helm.x + 0.6, def.helm.y - 0.9, def.helm.z);
    else {
      const zone = def.deck[0];
      const n = Math.max(1, f.crew.length - 1);
      const t = ((idx + 1) % n) / n;
      local = _v2.set(
        (idx % 2 ? 1 : -1) * zone.w * 0.34,
        def.hull.height * 0.28,
        zone.z + lerp(-zone.d * 0.38, zone.d * 0.38, t),
      );
    }
    // Rotate into world space around the boat heading.
    const c = Math.cos(b.heading), s = Math.sin(b.heading);
    return _v.set(
      b.position.x + local.x * c + local.z * s,
      b.position.y + local.y,
      b.position.z - local.x * s + local.z * c,
    );
  }

  steerTowards(f, b, tx, tz, dt, near, throttleCap = 1) {
    const captain = f.captain;
    const skill = captain ? 1 + captain.treeBonus('travelSpeed') + (captain.skills.navigation - 3) * 0.04 : 1;
    const auto = b.stats.autonomy;
    const desired = Math.atan2(tx - b.position.x, tz - b.position.z);
    let diff = desired - b.heading;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;

    if (near && b.physical) {
      b.steer = clamp(-diff * 1.6, -1, 1);
      b.throttle = clamp(throttleCap * (1 - Math.abs(diff) * 0.45) * skill * (1 + auto), 0.15, 1);
      b.engineOn = b.def.fuel === 0 || b.fuel > 0;
    } else {
      // Statistical travel: move the boat directly along the route.
      const spd = b.stats.speed * skill * (0.85 + auto * 0.2) * throttleCap;
      b.heading = damp(b.heading, b.heading + diff, 0.02, dt);
      b.position.x += Math.sin(b.heading) * spd * dt;
      b.position.z += Math.cos(b.heading) * spd * dt;
      b.position.y = waterHeightAt(b.position.x, b.position.z);
      b.speed = spd;
      b.throttle = throttleCap;
      if (b.entry && b.physical) {
        b.entry.body.setTranslation({ x: b.position.x, y: b.position.y, z: b.position.z }, true);
      }
    }
  }

  burnFuel(f, b, dt, game) {
    if (b.def.fuel <= 0) return;
    const captain = f.captain;
    const eff = 1 - clamp01((captain?.treeBonus('fuelEff') || 0) + (captain?.traitSum('fuelEff') || 0));
    const research = game.get('research');
    b.fuel = Math.max(0, b.fuel - b.stats.fuelUse * dt * 0.28 * eff * (research?.fuelMult ?? 1));
    if (b.fuel <= 0 && f.state !== FLEET_STATE.STRANDED) {
      this.setState(f, FLEET_STATE.STRANDED);
      f.captain?.say('fuel');
      bus.emit('toast', { text: `⛽ ${f.name} is out of fuel!`, kind: 'error', duration: 6000 });
      f.log.push({ t: game.time, msg: 'Ran out of fuel' });
    }
    // Wear: hulls degrade, faster in rough weather.
    const weather = game.get('weather');
    const wear = dt * 0.035 * (1 + (weather?.intensity || 0) * 2.2)
      * (1 - clamp01(captain?.treeBonus('stormHandling') || 0));
    b.health = Math.max(0, b.health - wear);
    if (b.health < 18 && f.state !== FLEET_STATE.BROKEN && rchance(dt * 0.06)) {
      this.setState(f, FLEET_STATE.BROKEN);
      bus.emit('toast', { text: `🔧 ${f.name} has broken down.`, kind: 'error', duration: 6000 });
      f.log.push({ t: game.time, msg: 'Broke down at sea' });
    }
  }

  /** Crew catch fish into the hold. Physical when near, statistical when far. */
  crewFish(f, dt, game, near) {
    const b = f.boat;
    const region = REGION_BY_ID[f.targetRegion];
    if (!region) return;
    const fishers = f.crew.filter((w) => w.role === 'fisherman' || w.role === 'hunter');
    if (!fishers.length) return;

    const workers = game.get('workers');
    const research = game.get('research');
    const sonarOp = f.crew.find((w) => w.role === 'sonar');
    const sonarBonus = 1 + (b.stats.sonar * 0.06) + (sonarOp ? 0.18 + sonarOp.treeBonus('catchRate') : 0);
    const teamBonus = 1 + (workers?.managerBonus.catchRate || 0);
    const sky = game.get('sky');
    const nightPenalty = sky?.isNight ? (1 - 0.35 + b.stats.nightBonus) : 1;

    f.fishTimer -= dt;
    if (f.fishTimer > 0) return;

    // One catch attempt per fisherman on a shared cadence.
    const rate = fishers.reduce((a, w) => a + (1 + (w.skills.fishing - 3) * 0.12) * lerp(0.7, 1.2, w.morale), 0)
      * b.stats.catchRate * sonarBonus * teamBonus * nightPenalty * (research?.catchRateMult ?? 1);
    f.fishTimer = clamp(7 / Math.max(0.2, rate), 0.4, 25);

    const w = rpick(fishers);
    const inst = this.rollFleetCatch(w, region, b, game);
    if (!inst) return;

    if (f.cargoWeight + inst.weight > b.stats.storage) {
      f.cargoWeight = b.stats.storage;
      return;
    }
    f.cargo.push(inst);
    f.cargoWeight += inst.weight;
    const eco = game.get('economy');
    f.cargoValue += eco ? eco.priceFor(inst, { freshness: b.stats.freshness }) : inst.value;
    w.stats.caught++;
    w.stats.biggest = Math.max(w.stats.biggest, inst.weight);
    w.addXP(getSpecies(inst.speciesId)?.xp ?? 5, game);
    eco?.recordCatch(inst, w.name);
    bus.emit('worker:caught', { worker: w, instance: inst, fleet: f });

    if (near) {
      _v.set(b.position.x + rrange(-4, 4), b.position.y + 0.5, b.position.z + rrange(-4, 4));
      bus.emit('fx:splash', { position: _v.clone(), scale: clamp(0.4 + inst.weight * 0.02, 0.4, 1.5) });
      game.audio.play('splash_small', { volume: 0.28, position: _v.clone(), throttle: 220 });
      if (['legendary', 'mythic'].includes(inst.rarity)) {
        w.say('rare');
        game.audio.play('rare_fish', { volume: 0.5, position: b.position.clone() });
      }
    }
  }

  rollFleetCatch(w, region, b, game) {
    const pool = speciesInRegion(region.id).filter((s) => !s.boss);
    if (!pool.length) return null;
    const sky = game.get('sky');
    const weather = game.get('weather');
    const luck = 1 + (w.skills.luck - 3) * 0.07 + w.traitSum('rareBonus') + w.treeBonus('rareBonus');
    const cands = pool.map((s) => {
      let weight = s.spawnWeight;
      if (s.time !== 'any' && sky) { if ((s.time === 'night') !== sky.isNight) weight *= 0.25; }
      if (s.weather !== 'any' && weather) weight *= s.weather === weather.current.id ? 2 : 0.35;
      const rIdx = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'].indexOf(s.rarity);
      weight *= Math.pow(clamp(luck, 0.2, 5), rIdx * 0.75);
      // Commercial gear lands much bigger fish than a person on a dock.
      const cap = w.d.maxWeight * (1 + b.def.tier * 1.6);
      if (s.weight[0] > cap) weight *= 0.03;
      return { s, weight: Math.max(0.0001, weight) };
    });
    const pick = weightedPick(cands, this.rng)?.s;
    if (!pick) return null;
    return rollFishInstance(pick, this.rng, { luck });
  }

  completeTrip(f, game) {
    const eco = game.get('economy');
    const b = f.boat;
    let total = 0;
    for (const inst of f.cargo) {
      const price = eco ? eco.priceFor(inst, { freshness: b.stats.freshness }) : inst.value;
      total += price;
      eco?.recordSale(inst, price, f.name);
    }
    total = Math.round(total);
    eco?.add(total, 'fleet_sales');
    f.lifetimeProfit += total;
    b.lifetimeProfit += total;
    f.trips++;
    b.trips++;
    const count = f.cargo.length;
    f.cargo = [];
    f.cargoWeight = 0;
    f.cargoValue = 0;
    for (const w of f.crew) { w.stats.trips = (w.stats.trips || 0) + 1; w.addXP(28, game); }

    game.audio.play('cash_register', { volume: 0.7 });
    bus.emit('toast', {
      text: `⚓ <b>${f.name}</b> returned with ${count} fish — <b style="color:var(--gold)">${formatMoneyExact(total)}</b>`,
      kind: 'gold', duration: 7000,
    });
    bus.emit('fx:moneyBurst', { position: b.position.clone(), amount: total });
    bus.emit('fleet:tripComplete', { fleet: f, total, count });
    f.log.push({ t: game.time, msg: `Returned with ${count} fish worth ${formatMoneyExact(total)}` });
    if (f.log.length > 20) f.log.shift();

    // Auto-refuel and repair out of the trip's takings if it can be afforded.
    if (b.def.fuel > 0 && b.fuel < b.stats.fuel * 0.35) {
      const need = b.stats.fuel - b.fuel;
      const cost = Math.round(need * 2.4);
      if (eco?.canAfford(cost)) { eco.spend(cost, 'fuel'); eco.today.fuel += cost; b.fuel = b.stats.fuel; }
    }
    if (b.health < 60) {
      const cost = Math.round((100 - b.health) * b.def.price * 0.004);
      if (eco?.canAfford(cost)) { eco.spend(cost, 'repairs'); eco.today.repairs += cost; b.health = 100; }
    }
    this.setState(f, FLEET_STATE.DOCKED);
  }

  openCreator() { bus.emit('ui:show', { id: 'fleetEditor', data: { create: true } }); }

  save() {
    return {
      fleets: this.fleets.map((f) => ({
        id: f.id, name: f.name, boatId: f.boatId, crewIds: f.crew.map((w) => w.id),
        targetRegion: f.targetRegion, homeRegion: f.homeRegion, state: f.state,
        progress: f.progress, cargo: f.cargo, cargoWeight: f.cargoWeight, cargoValue: f.cargoValue,
        trips: f.trips, lifetimeProfit: f.lifetimeProfit, autoRelaunch: f.autoRelaunch,
        route: f.route, stateTime: f.stateTime,
      })),
      nextId: _fleetId,
    };
  }

  load(d) {
    this.fleets.length = 0;
    if (!d) return;
    _fleetId = d.nextId || _fleetId;
    const boats = this.game.get('boats');
    const workers = this.game.get('workers');
    for (const fd of d.fleets || []) {
      const boat = boats?.byId(fd.boatId);
      const crew = (fd.crewIds || []).map((id) => workers?.byId(id)).filter(Boolean);
      if (!boat || !crew.length) continue;
      const f = {
        ...fd, boat, crew,
        captain: crew.find((w) => w.role === 'captain'),
        stateLabel: STATE_LABEL[fd.state] || fd.state,
        position: boat.position.clone(),
        fishTimer: 0, physical: false, log: [],
      };
      boat.fleet = f;
      for (const w of crew) { w.fleet = f; w.assignment = `fleet:${f.id}`; }
      this.fleets.push(f);
    }
    bus.emit('fleets:changed', { count: this.fleets.length });
  }
}
