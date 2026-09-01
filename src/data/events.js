/**
 * WORLD EVENTS — the ocean doing things without being asked.
 *
 * Every entry here changes real, observable game state: spawn tables, prices,
 * weather, boat condition, or fish in the water. Nothing in this file is a
 * cosmetic announcement.
 *
 * Contract (driven by src/world/EventSystem.js):
 *   {
 *     id, name, desc, icon, weight, minTier, duration (seconds),
 *     regions?   : string[] | (game) => string[]  -- candidate regions
 *     anywhere?  : true                           -- no region needed
 *     marker?    : true                           -- wants a world beacon
 *     apply(game, ev)      -- take effect. May set ev.marker / ev.data.
 *     tick(dt, game, ev)   -- called every frame while active.
 *     end(game, ev)        -- undo everything apply() did.
 *   }
 *
 * `ev` is the live instance the EventSystem owns:
 *   ev.regionId, ev.remaining, ev.elapsed, ev.data (serialised), ev.rng
 *   ev.mult(system, key, factor)  -- multiplicative modifier, auto-reverted
 *   ev.marker = {x,y,z,color,label}  -- EventSystem builds/destroys the beacon
 *   ev.emit / ev.toast / ev.sound / ev.spawnFish / ev.waterSpotNear
 *   ev.distToPlayer(x, z) / ev.playerIn(regionId)
 *
 * This module imports data + maths only — no renderer, no EventBus — so it
 * stays testable and cheap to load.
 */

import { REGIONS, REGION_BY_ID } from './regions.js';
import {
  getSpecies, speciesInRegion, rollFishInstance, VARIANT_BY_ID,
} from './fishData.js';
import { clamp, lerp, rpick, formatMoneyExact, formatWeight, weightedPick } from '../util/math.js';

/** Regions a player can actually stand in and be affected by an event. */
const LIVE_REGIONS = REGIONS.filter((r) => !r.trench).map((r) => r.id);

/** Regions currently unlocked, falling back to the starter island. */
function unlockedRegions(game, filter = null) {
  const quests = game.get('quests');
  let list = LIVE_REGIONS.filter((id) => !quests || quests.isRegionUnlocked(id));
  if (!list.length) list = ['crash'];
  if (filter) {
    const f = list.filter(filter);
    if (f.length) return f;
  }
  return list;
}

/** Species that make sense to feature at the player's current progression. */
function demandCandidates(game) {
  const ids = new Set();
  for (const rid of unlockedRegions(game)) {
    for (const s of speciesInRegion(rid)) {
      if (s.boss || s.body?.startsWith('junk_')) continue;
      ids.add(s.id);
    }
  }
  return [...ids].map(getSpecies).filter(Boolean);
}

// ---------------------------------------------------------------------------

export const WORLD_EVENTS = [

  // ======================================================= spawn-table events

  {
    id: 'golden_migration',
    name: 'Golden Migration',
    icon: '✨',
    desc: 'A shoal of freak-coloured fish is moving through. Variant rolls are massively inflated while it lasts.',
    weight: 22, minTier: 1, duration: 300, marker: true,

    apply(game, ev) {
      const r = REGION_BY_ID[ev.regionId];
      ev.mult('fish', 'luckMult', 7.5);
      ev.mult('fish', 'rareMult', 2.4);
      ev.mult('fish', 'densityMult', 1.25);
      const a = game.get('world')?.getAnchors(ev.regionId);
      const spot = ev.waterSpotNear(a?.dockEnd?.x ?? r.x, a?.dockEnd?.z ?? r.z, 90, 4);
      if (spot) ev.marker = { x: spot.x, y: 1.2, z: spot.z, color: 0xffc22e, label: 'Golden Shoal' };
      ev.data.spawnTimer = 3;
      ev.summary = `Variant chance ×7.5 around ${r?.short || ev.regionId}`;
    },

    tick(dt, game, ev) {
      ev.data.spawnTimer -= dt;
      if (ev.data.spawnTimer > 0) return;
      ev.data.spawnTimer = 11 + ev.rng() * 9;
      if (!ev.playerIn(ev.regionId)) return;
      const p = ev.playerPos();
      const spot = ev.waterSpotNear(p.x, p.z, 34, 2.4);
      if (!spot) return;
      const pool = speciesInRegion(ev.regionId).filter((s) => !s.boss && s.tier <= 6);
      const sp = pool.length ? rpick(pool) : getSpecies('sardine');
      ev.spawnFish({
        speciesId: sp.id,
        variantId: ev.rng() < 0.34 ? 'golden' : ev.rng() < 0.5 ? 'shiny' : 'albino',
        x: spot.x, y: spot.y, z: spot.z, count: 2 + Math.floor(ev.rng() * 3),
      });
    },

    end() { /* multipliers reverted by the EventSystem */ },
  },

  {
    id: 'tuna_school',
    name: 'Tuna School',
    icon: '🐟',
    desc: 'Sonar has a wall of tuna on it. Get out there before it moves on.',
    weight: 18, minTier: 3, duration: 260, marker: true,
    regions: (game) => unlockedRegions(game, (id) => (REGION_BY_ID[id]?.tier ?? 1) >= 3),

    apply(game, ev) {
      const r = REGION_BY_ID[ev.regionId];
      const a = game.get('world')?.getAnchors(ev.regionId);
      const ox = a?.outward?.x ?? 1, oz = a?.outward?.z ?? 0;
      const cx = (a?.dockEnd?.x ?? r.x) + ox * 70;
      const cz = (a?.dockEnd?.z ?? r.z) + oz * 70;
      const spot = ev.waterSpotNear(cx, cz, 110, 8) || ev.waterSpotNear(r.x, r.z, r.reach * 0.8, 6);
      if (!spot) { ev.abort = true; return; }
      ev.data.x = spot.x; ev.data.y = spot.y; ev.data.z = spot.z;
      ev.data.species = (r.tier >= 5 ? 'bluefin-tuna' : 'yellowfin-tuna');
      if (!getSpecies(ev.data.species)) ev.data.species = 'mackerel';
      ev.data.topUp = 0;
      ev.marker = { x: spot.x, y: 1.2, z: spot.z, color: 0x4aa8ff, label: 'Tuna School' };
      ev.mult('fish', 'densityMult', 1.4);
      ev.summary = `Dense school marked off ${r?.short || ev.regionId}`;
    },

    tick(dt, game, ev) {
      ev.data.topUp -= dt;
      if (ev.data.topUp > 0) return;
      ev.data.topUp = 14;
      // Only materialise the school when someone can actually see it.
      if (ev.distToPlayer(ev.data.x, ev.data.z) > 190) return;
      const fish = game.get('fish');
      if (!fish) return;
      const near = fish.countNear
        ? fish.countNear({ x: ev.data.x, y: ev.data.y, z: ev.data.z }, 30)
        : 0;
      if (near >= 14) return;
      ev.spawnFish({
        speciesId: ev.data.species,
        x: ev.data.x, y: ev.data.y, z: ev.data.z,
        count: 6,
      });
    },

    end() {},
  },

  {
    id: 'legendary_spotted',
    name: 'Legendary Sighting',
    icon: '🌟',
    desc: 'Something with the wrong colours surfaced and went back down. It is still there.',
    weight: 9, minTier: 2, duration: 420, marker: true,

    apply(game, ev) {
      const r = REGION_BY_ID[ev.regionId];
      const a = game.get('world')?.getAnchors(ev.regionId);
      const cx = (a?.dockEnd?.x ?? r.x), cz = (a?.dockEnd?.z ?? r.z);
      const spot = ev.waterSpotNear(cx, cz, 130, 5);
      if (!spot) { ev.abort = true; return; }
      const pool = speciesInRegion(ev.regionId).filter((s) => !s.boss && !s.body?.startsWith('junk_'));
      const sp = pool.length
        ? weightedPick(pool.map((s) => ({ s, weight: s.tier })), ev.rng)?.s || pool[0]
        : getSpecies('bass');
      ev.data.x = spot.x; ev.data.y = spot.y; ev.data.z = spot.z;
      ev.data.species = sp.id;
      ev.data.spawned = false;
      ev.marker = { x: spot.x, y: 1.2, z: spot.z, color: 0xff9d2e, label: `Legendary ${sp.short || sp.name}` };
      ev.mult('fish', 'luckMult', 1.6);
      ev.summary = `A Legendary ${sp.name} is marked near ${r?.short || ev.regionId}`;
    },

    tick(dt, game, ev) {
      if (ev.data.spawned) return;
      if (ev.distToPlayer(ev.data.x, ev.data.z) > 120) return;
      ev.data.spawned = true;
      const n = ev.spawnFish({
        speciesId: ev.data.species, variantId: 'legendary',
        x: ev.data.x, y: ev.data.y, z: ev.data.z, count: 1,
      });
      if (n > 0) {
        ev.sound('legendary', { volume: 0.6 });
        ev.toast('The water goes gold for a second. <b>It is here.</b>', 'gold', 6000);
      } else {
        ev.data.spawned = false;   // no free fish slot; try again next tick
      }
    },

    end() {},
  },

  {
    id: 'abyss_anomaly',
    name: 'Abyssal Anomaly',
    icon: '🕳',
    desc: 'Pressure readings are wrong in a way nobody wants to explain. Deep spawns spike.',
    weight: 10, minTier: 7, duration: 340,
    regions: (game) => unlockedRegions(game, (id) => (REGION_BY_ID[id]?.tier ?? 1) >= 7).concat(['abyss']),

    apply(game, ev) {
      ev.mult('fish', 'densityMult', 1.7);
      ev.mult('fish', 'rareMult', 2.6);
      ev.mult('fish', 'luckMult', 2.0);
      ev.mult('events', 'deepBonus', 2.2);
      ev.emit('weather:set', { id: 'fog' });
      ev.data.ambTimer = 6;
      const amb = game.get('ambience');
      if (amb?.setEventDrone) { amb.setEventDrone(0.75); ev.data.drone = true; }
      ev.summary = 'Deep spawn rate ×1.7, rare ×2.6, everything is listening';
    },

    tick(dt, game, ev) {
      ev.data.ambTimer -= dt;
      if (ev.data.ambTimer > 0) return;
      ev.data.ambTimer = 16 + ev.rng() * 22;
      ev.sound('sub_creak', { volume: 0.32, rate: 0.55 + ev.rng() * 0.2 });
      if (ev.rng() < 0.4) ev.emit('fx:screenFlash', { color: 'rgba(10,0,20,0.30)', duration: 500 });
    },

    end(game, ev) {
      const amb = game.get('ambience');
      if (ev.data.drone && amb?.setEventDrone) amb.setEventDrone(0);
    },
  },

  // ============================================================ world / weather

  {
    id: 'storm_front',
    name: 'Storm Front',
    icon: '🌩',
    desc: 'A front rolls in and locks the weather down. Big things feed in bad weather.',
    weight: 16, minTier: 2, duration: 280,

    apply(game, ev) {
      const weather = game.get('weather');
      ev.data.prevWeather = weather?.target?.id || 'clear';
      ev.data.prevLocked = !!weather?.locked;
      const heavy = (REGION_BY_ID[ev.regionId]?.tier ?? 1) >= 5 || ev.rng() < 0.35;
      ev.data.weather = heavy ? 'heavy_storm' : 'storm';
      ev.emit('weather:set', { id: ev.data.weather });
      if (weather) weather.locked = true;
      ev.mult('fish', 'rareMult', 2.0);
      ev.mult('fish', 'luckMult', 1.45);
      ev.mult('events', 'dangerMult', 1.8);
      ev.data.reassert = 20;
      ev.summary = `${heavy ? 'Heavy storm' : 'Storm'} locked in · rare ×2 · danger ×1.8`;
    },

    tick(dt, game, ev) {
      ev.data.reassert -= dt;
      if (ev.data.reassert > 0) return;
      ev.data.reassert = 25;
      const weather = game.get('weather');
      if (weather && weather.target?.id !== ev.data.weather && !weather._regionOverride) {
        ev.emit('weather:set', { id: ev.data.weather });
      }
    },

    end(game, ev) {
      const weather = game.get('weather');
      if (weather) weather.locked = ev.data.prevLocked;
      ev.emit('weather:set', { id: weather?._regionOverride || 'cloudy' });
    },
  },

  {
    id: 'boss_sighting',
    name: 'Boss Sighting',
    icon: '💀',
    desc: 'Something enormous is circling. It will surface the moment you are close enough.',
    weight: 8, minTier: 2, duration: 420, marker: true,
    regions: (game) => unlockedRegions(game, (id) => !!REGION_BY_ID[id]?.boss),

    apply(game, ev) {
      const r = REGION_BY_ID[ev.regionId];
      const bossId = r?.boss;
      if (!bossId) { ev.abort = true; return; }
      ev.data.boss = bossId;
      ev.data.fired = false;
      const a = game.get('world')?.getAnchors(ev.regionId);
      const spot = ev.waterSpotNear(a?.dockEnd?.x ?? r.x, a?.dockEnd?.z ?? r.z, 90, 6);
      if (spot) ev.marker = { x: spot.x, y: 1.4, z: spot.z, color: 0xff4d6d, label: getSpecies(bossId)?.name || 'Boss' };
      ev.mult('events', 'dangerMult', 1.4);
      ev.summary = `${getSpecies(bossId)?.name || bossId} is hunting ${r?.short || ev.regionId}`;
    },

    tick(dt, game, ev) {
      if (ev.data.fired) return;
      if (!ev.playerIn(ev.regionId)) return;
      const bosses = game.get('bosses');
      if (bosses?.boss) return;                    // one boss at a time
      ev.data.fired = true;
      ev.emit('boss:spawn', { id: ev.data.boss, fromWorldEvent: true });
      ev.sound('boss_roar', { volume: 0.8 });
      ev.toast(`<b>${getSpecies(ev.data.boss)?.name || ev.data.boss}</b> has surfaced.`, 'error', 7000);
    },

    end() {},
  },

  {
    id: 'treasure_signal',
    name: 'Sonar Contact',
    icon: '📡',
    desc: 'A hard metallic return, sitting on the bottom. Someone lost a payday out there.',
    weight: 14, minTier: 1, duration: 480, marker: true,

    apply(game, ev) {
      const r = REGION_BY_ID[ev.regionId];
      const a = game.get('world')?.getAnchors(ev.regionId);
      const cx = (a?.dockEnd?.x ?? r.x), cz = (a?.dockEnd?.z ?? r.z);
      const spot = ev.waterSpotNear(cx, cz, 95, 2.5);
      if (!spot) { ev.abort = true; return; }
      const eco = game.get('economy');
      const tier = REGION_BY_ID[ev.regionId]?.tier ?? 1;
      const base = 220 * Math.pow(2.35, tier - 1);
      // A treasure should feel like a good day, not like skipping the game:
      // the wealth term is capped relative to the region it was found in.
      const wealth = Math.min(Math.max(0, eco?.lifetimeRevenue || 0) * 0.008, base * 40);
      ev.data.x = spot.x; ev.data.y = spot.y; ev.data.z = spot.z;
      ev.data.reward = Math.round((base + wealth) * (0.75 + ev.rng() * 0.7));
      ev.data.claimed = false;
      ev.data.pingTimer = 0;
      ev.marker = { x: spot.x, y: 0.8, z: spot.z, color: 0x2fd4c4, label: 'Sonar Contact' };
      ev.summary = 'Swim to the beacon to bring it up';
    },

    tick(dt, game, ev) {
      if (ev.data.claimed) return;
      const d = ev.distToPlayer(ev.data.x, ev.data.z);
      ev.data.pingTimer -= dt;
      if (d < 120 && ev.data.pingTimer <= 0) {
        ev.data.pingTimer = clamp(d / 26, 0.55, 4.5);
        ev.sound('sonar_ping', { volume: clamp(1 - d / 130, 0.12, 0.5) });
      }
      if (d > 5.5) return;
      ev.data.claimed = true;
      const eco = game.get('economy');
      eco?.add(ev.data.reward, 'treasure');
      ev.sound('crate_break', { volume: 0.8 });
      ev.sound('cash_register', { volume: 0.7 });
      ev.emit('fx:moneyBurst', { position: ev.vec(ev.data.x, ev.data.y + 1, ev.data.z), amount: ev.data.reward });
      ev.toast(`Hauled up a strongbox — <b style="color:var(--gold)">${formatMoneyExact(ev.data.reward)}</b>`, 'gold', 7000);
      ev.emit('quest:flag', { flag: 'found_treasure' });
      ev.finish();
    },

    end() {},
  },

  // ==================================================================== economy

  {
    id: 'market_boom',
    name: 'Market Boom',
    icon: '📈',
    desc: 'Somebody upriver had a very bad year. Every fish you own is suddenly worth more.',
    weight: 18, minTier: 1, duration: 240, anywhere: true,

    apply(game, ev) {
      const eco = game.get('economy');
      ev.data.mult = +(1.5 + ev.rng() * 0.8).toFixed(2);
      ev.data.prev = eco?.marketMult ?? 1;
      eco?.setMarketBoost(ev.data.mult, ev.remaining);
      ev.summary = `All fish prices ×${ev.data.mult}`;
    },

    tick(dt, game, ev) {
      // Economy's slow random walk fights the boost; re-assert it periodically.
      ev.data.t = (ev.data.t || 0) + dt;
      if (ev.data.t < 8) return;
      ev.data.t = 0;
      const eco = game.get('economy');
      if (eco && Math.abs(eco.marketMult - ev.data.mult) > 0.02) eco.setMarketBoost(ev.data.mult, ev.remaining);
    },

    end(game, ev) {
      const eco = game.get('economy');
      if (eco) eco.setMarketBoost(1, 0.001);
    },
  },

  {
    id: 'market_crash',
    name: 'Market Crash',
    icon: '📉',
    desc: 'The wholesale price collapsed overnight. Hold your catch or eat the loss.',
    weight: 11, minTier: 2, duration: 200, anywhere: true,

    apply(game, ev) {
      const eco = game.get('economy');
      ev.data.mult = +(0.45 + ev.rng() * 0.2).toFixed(2);
      eco?.setMarketBoost(ev.data.mult, ev.remaining);
      ev.summary = `All fish prices ×${ev.data.mult} — sit on your stock`;
    },

    tick(dt, game, ev) {
      ev.data.t = (ev.data.t || 0) + dt;
      if (ev.data.t < 8) return;
      ev.data.t = 0;
      const eco = game.get('economy');
      if (eco && Math.abs(eco.marketMult - ev.data.mult) > 0.02) eco.setMarketBoost(ev.data.mult, ev.remaining);
    },

    end(game, ev) {
      const eco = game.get('economy');
      if (eco) eco.setMarketBoost(1, 0.001);
    },
  },

  {
    id: 'species_demand',
    name: 'Buyer on the Docks',
    icon: '🧾',
    desc: 'A restaurant chain wants one species and only one species. They are paying stupidly.',
    weight: 20, minTier: 1, duration: 300, anywhere: true,

    apply(game, ev) {
      const cands = demandCandidates(game);
      if (!cands.length) { ev.abort = true; return; }
      const sp = cands[(ev.rng() * cands.length) | 0];
      const mult = +(3 + ev.rng() * 3).toFixed(1);
      ev.data.species = sp.id;
      ev.data.mult = mult;
      const eco = game.get('economy');
      if (eco) {
        ev.data.prev = eco.priceMultipliers[sp.id];
        eco.priceMultipliers[sp.id] = (ev.data.prev ?? 1) * mult;
      }
      ev.marker = null;
      ev.icon = sp.icon || '🧾';
      ev.summary = `${sp.name} sells for ×${mult}`;
      ev.title = `Buyer wants ${sp.name}`;
    },

    tick() {},

    end(game, ev) {
      const eco = game.get('economy');
      if (!eco) return;
      if (ev.data.prev === undefined || ev.data.prev === null) delete eco.priceMultipliers[ev.data.species];
      else eco.priceMultipliers[ev.data.species] = ev.data.prev;
    },
  },

  // ================================================================ fleet / boats

  {
    id: 'boat_breakdown',
    name: 'Mechanical Failure',
    icon: '🛠',
    desc: 'Something expensive stopped turning. It will not fix itself.',
    weight: 12, minTier: 3, duration: 120, anywhere: true, once: true,

    apply(game, ev) {
      const boats = game.get('boats');
      const fleets = game.get('fleets');
      if (!boats?.owned?.length) { ev.abort = true; return; }

      // Prefer stranding a fleet that is actually out working — it hurts more.
      const outFleets = (fleets?.fleets || []).filter((f) => f.state && f.state !== 'docked');
      if (outFleets.length && ev.rng() < 0.55) {
        const f = outFleets[(ev.rng() * outFleets.length) | 0];
        const b = f.boat;
        if (b) {
          const dmg = 22 + ev.rng() * 34;
          b.health = clamp(b.health - dmg, 4, 100);
          ev.data.boatId = b.id;
          ev.data.damage = Math.round(dmg);
          if (fleets?.setState) fleets.setState(f, 'broken');
          ev.data.fleetId = f.id;
          ev.sound('boat_impact', { volume: 0.7 });
          ev.toast(`⚠ <b>${f.name}</b> broke down — hull at ${Math.round(b.health)}%. Repair it in the Company panel.`, 'error', 8000);
          ev.summary = `${f.name} disabled at sea (−${Math.round(dmg)}% hull)`;
          return;
        }
      }

      const b = boats.owned[(ev.rng() * boats.owned.length) | 0];
      const dmg = 14 + ev.rng() * 28;
      b.health = clamp(b.health - dmg, 4, 100);
      if (b.fuel !== undefined) b.fuel = Math.max(0, b.fuel * (0.4 + ev.rng() * 0.3));
      ev.data.boatId = b.id;
      ev.data.damage = Math.round(dmg);
      ev.sound('boat_impact', { volume: 0.6 });
      ev.toast(`⚠ <b>${b.name}</b> sprang a leak — hull ${Math.round(b.health)}%, fuel siphoned.`, 'error', 8000);
      ev.emit('boats:changed', { count: boats.owned.length, boat: b });
      ev.summary = `${b.name} damaged (−${Math.round(dmg)}% hull)`;
    },

    tick() {},
    end() {},
  },

  {
    id: 'crew_discovery',
    name: 'Crew Find',
    icon: '⚓',
    desc: 'A crew hauled up something that was not on the manifest.',
    weight: 13, minTier: 3, duration: 90, anywhere: true, once: true,

    apply(game, ev) {
      const fleets = game.get('fleets');
      const workers = game.get('workers');
      const eco = game.get('economy');
      const list = fleets?.fleets || [];
      const crew = workers?.workers || [];
      if (!list.length && !crew.length) { ev.abort = true; return; }

      const age = clamp(1 + (eco?.day || 1) * 0.05, 1, 3);
      const wealth = Math.min(Math.max(0, eco?.lifetimeRevenue || 0) * 0.008, 120000);
      const bonus = Math.round((320 + wealth) * (0.6 + ev.rng() * 1.1) * age);
      let who = 'A crew';

      if (list.length) {
        const f = list[(ev.rng() * list.length) | 0];
        who = f.name;
        // Real cargo: a rolled fish goes straight into the hold to be sold on return.
        const rid = f.targetRegion || f.homeRegion || 'crash';
        const pool = speciesInRegion(rid).filter((s) => !s.boss && !s.body?.startsWith('junk_'));
        const sp = pool.length ? pool[(ev.rng() * pool.length) | 0] : getSpecies('cod');
        const inst = sp ? rollFishInstance(sp, ev.rng, { variant: VARIANT_BY_ID.ancient, sizeBias: 0.8 }) : null;
        if (inst && f.cargo) {
          f.cargo.push(inst);
          f.cargoWeight = (f.cargoWeight || 0) + inst.weight;
          ev.data.fish = inst.name;
          ev.toast(`⚓ <b>${f.name}</b> netted an <b>${inst.name}</b> (${formatWeight(inst.weight)}) — it is in the hold.`, 'gold', 8000);
        }
        f.log?.push?.({ t: game.time, msg: `Found something strange: +${formatMoneyExact(bonus)}` });
      } else {
        const w = crew[(ev.rng() * crew.length) | 0];
        who = w.name;
      }

      eco?.add(bonus, 'crew_discovery');
      ev.data.bonus = bonus;
      ev.sound('coin', { volume: 0.7 });
      ev.toast(`<b>${who}</b> sold a find on the side — <b style="color:var(--gold)">${formatMoneyExact(bonus)}</b>`, 'gold', 7000);
      ev.summary = `${who} brought in ${formatMoneyExact(bonus)}`;
    },

    tick() {},
    end() {},
  },
];

export const EVENT_BY_ID = Object.fromEntries(WORLD_EVENTS.map((e) => [e.id, e]));

/**
 * Candidate regions for an event definition, respecting `regions` /
 * `anywhere` and the player's unlocks.
 */
export function candidateRegions(def, game) {
  if (def.anywhere) return [null];
  if (typeof def.regions === 'function') {
    const list = def.regions(game).filter(Boolean);
    return list.length ? list : [];
  }
  if (Array.isArray(def.regions)) {
    const un = new Set(unlockedRegions(game));
    const list = def.regions.filter((id) => un.has(id));
    return list.length ? list : [];
  }
  return unlockedRegions(game);
}

/** Highest unlocked region tier — the game's notion of "how far along are you". */
export function playerTier(game) {
  const quests = game.get('quests');
  let t = 1;
  for (const r of REGIONS) {
    if (!quests || quests.isRegionUnlocked(r.id)) t = Math.max(t, r.tier);
  }
  return t;
}

/**
 * Weighted roll for the next event. Events far below the player's tier are
 * damped so a tier-8 captain is not repeatedly told about a sardine buyer.
 */
export function rollEvent(game, rng, exclude = []) {
  const tier = playerTier(game);
  const rows = [];
  for (const def of WORLD_EVENTS) {
    if (exclude.includes(def.id)) continue;
    if ((def.minTier ?? 1) > tier) continue;
    const gap = tier - (def.minTier ?? 1);
    // Recent tiers stay relevant; very old ones fade to a third of their weight.
    const relevance = lerp(1, 0.34, clamp(gap / 5, 0, 1));
    const regions = candidateRegions(def, game);
    if (!regions.length) continue;
    rows.push({ def, regions, weight: def.weight * relevance });
  }
  if (!rows.length) return null;
  const pick = weightedPick(rows, rng);
  if (!pick) return null;
  const regionId = pick.regions[(rng() * pick.regions.length) | 0] ?? null;
  return { def: pick.def, regionId };
}
