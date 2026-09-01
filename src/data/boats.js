/**
 * Boat catalogue. `hull` describes the procedural mesh; `physics` the collider
 * and buoyancy sampling; the rest are gameplay stats read by BoatSystem and
 * FleetSystem.
 */
export const BOATS = [
  {
    id: 'raft', name: 'Lashed Raft', icon: '🪵', price: 900, tier: 0,
    desc: 'Six logs and a prayer. Technically floats.',
    speed: 4.2, handling: 0.5, storage: 60, crew: 1, fuel: 0, fuelUse: 0,
    durability: 60, sonar: 0, range: 260, slots: 1, mass: 380,
    unlockRegion: 'crash',
    hull: { length: 3.6, width: 2.4, height: 0.34, style: 'raft', color: '#8a6a44', deck: '#a3835c' },
    physics: { hx: 1.8, hy: 0.2, hz: 1.2, draft: 0.16 },
    deck: [{ x: 0, z: 0, w: 2.0, d: 3.2 }],
    helm: { x: 0, y: 0.22, z: -1.0 },
  },
  {
    id: 'dinghy', name: 'Dinghy', icon: '🛶', price: 3200, tier: 1,
    desc: 'An outboard, a bench and a bailing bucket.',
    speed: 7.5, handling: 0.72, storage: 140, crew: 2, fuel: 110, fuelUse: 0.9,
    durability: 120, sonar: 0, range: 520, slots: 2, mass: 620,
    unlockRegion: 'rocky',
    hull: { length: 4.4, width: 1.9, height: 0.75, style: 'vee', color: '#3f6f9c', deck: '#c9c2a8' },
    physics: { hx: 2.2, hy: 0.42, hz: 0.95, draft: 0.3 },
    deck: [{ x: 0, z: 0.2, w: 1.5, d: 3.0 }],
    helm: { x: 0, y: 0.62, z: -1.1 },
  },
  {
    id: 'motorboat', name: 'Motorboat', icon: '🚤', price: 12000, tier: 2,
    desc: 'Fast, loud, and completely unsuitable for cargo.',
    speed: 13.5, handling: 0.9, storage: 260, crew: 3, fuel: 240, fuelUse: 1.8,
    durability: 220, sonar: 1, range: 900, slots: 3, mass: 1100,
    unlockRegion: 'harbor',
    hull: { length: 6.2, width: 2.3, height: 1.1, style: 'speed', color: '#e8e2d4', deck: '#3d4a55', accent: '#d8541f' },
    physics: { hx: 3.1, hy: 0.6, hz: 1.15, draft: 0.42 },
    deck: [{ x: 0, z: 0.6, w: 1.8, d: 3.4 }],
    helm: { x: 0.34, y: 1.0, z: -0.3 },
  },
  {
    id: 'skiff', name: 'Fishing Skiff', icon: '⛵', price: 34000, tier: 3,
    desc: 'Built for work. Wide deck, rod holders, smells permanently of bait.',
    speed: 10.5, handling: 0.8, storage: 900, crew: 4, fuel: 430, fuelUse: 2.2,
    durability: 420, sonar: 2, range: 1400, slots: 4, mass: 2600,
    unlockRegion: 'harbor',
    hull: { length: 8.5, width: 3.1, height: 1.5, style: 'work', color: '#2f6f5a', deck: '#b8a882', accent: '#e8b023' },
    physics: { hx: 4.25, hy: 0.8, hz: 1.55, draft: 0.62 },
    deck: [{ x: 0, z: 0.4, w: 2.6, d: 5.4 }],
    helm: { x: -0.62, y: 1.55, z: -0.9 },
  },
  {
    id: 'cabin', name: 'Cabin Cruiser', icon: '🛥️', price: 110000, tier: 4,
    desc: 'A boat with an indoors. Your crew will never stop mentioning it.',
    speed: 12.5, handling: 0.78, storage: 2200, crew: 6, fuel: 880, fuelUse: 3.4,
    durability: 800, sonar: 3, range: 2400, slots: 6, mass: 6500,
    unlockRegion: 'wilds',
    hull: { length: 12.5, width: 4.2, height: 2.6, style: 'cabin', color: '#f0ece2', deck: '#5a6570', accent: '#2f6fb5' },
    physics: { hx: 6.25, hy: 1.3, hz: 2.1, draft: 0.95 },
    deck: [{ x: 0, z: 2.4, w: 3.4, d: 4.6 }, { x: 0, z: -2.6, w: 3.0, d: 3.4 }],
    helm: { x: -0.95, y: 2.6, z: 0.6 },
  },
  {
    id: 'commercial', name: 'Commercial Boat', icon: '🚢', price: 420000, tier: 5,
    desc: 'Nets, winches, a crane and a crew who resent all three.',
    speed: 10.0, handling: 0.62, storage: 8000, crew: 8, fuel: 1900, fuelUse: 5.2,
    durability: 1800, sonar: 3, range: 3600, slots: 8, mass: 24000,
    unlockRegion: 'storm',
    hull: { length: 20, width: 6.4, height: 4.2, style: 'commercial', color: '#3f5f7f', deck: '#6a6f74', accent: '#e8b023' },
    physics: { hx: 10, hy: 2.1, hz: 3.2, draft: 1.6 },
    deck: [{ x: 0, z: 4.5, w: 5.2, d: 8.5 }, { x: 0, z: -5.5, w: 4.4, d: 5.0 }],
    helm: { x: -1.5, y: 4.3, z: -4.6 },
  },
  {
    id: 'trawler', name: 'Deep Sea Trawler', icon: '🛳️', price: 1600000, tier: 6,
    desc: 'Drags a net the size of a football pitch. Ethically ambiguous.',
    speed: 8.5, handling: 0.5, storage: 26000, crew: 12, fuel: 4800, fuelUse: 8.5,
    durability: 4200, sonar: 4, range: 6000, slots: 12, mass: 90000,
    unlockRegion: 'frozen',
    hull: { length: 34, width: 9.5, height: 6.5, style: 'trawler', color: '#5a3f3f', deck: '#6a6f74', accent: '#d8541f' },
    physics: { hx: 17, hy: 3.2, hz: 4.75, draft: 2.6 },
    deck: [{ x: 0, z: 7, w: 8, d: 14 }, { x: 0, z: -9, w: 7, d: 7 }],
    helm: { x: -2.4, y: 7.2, z: -8.4 },
  },
  {
    id: 'factory', name: 'Factory Ship', icon: '🏭', price: 12000000, tier: 7,
    desc: 'A moving fish processing plant. Has a canteen. Has a barber.',
    speed: 7.0, handling: 0.36, storage: 120000, crew: 24, fuel: 16000, fuelUse: 16,
    durability: 12000, sonar: 5, range: 12000, slots: 20, mass: 420000,
    unlockRegion: 'station', requiresResearch: 'factory_ship',
    hull: { length: 62, width: 16, height: 12, style: 'factory', color: '#4a5560', deck: '#6a6f74', accent: '#e8b023' },
    physics: { hx: 31, hy: 6, hz: 8, draft: 4.5 },
    deck: [{ x: 0, z: 12, w: 13, d: 24 }, { x: 0, z: -16, w: 11, d: 12 }],
    helm: { x: -3.6, y: 13.5, z: -16.5 },
    processing: 2,
  },
];

export const BOAT_BY_ID = Object.fromEntries(BOATS.map((b) => [b.id, b]));

export const BOAT_UPGRADES = [
  { id: 'engine', name: 'Engine', icon: '⚙️', max: 5, baseCost: 1200, costMult: 2.3, effect: { speed: 0.14 }, desc: '+14% top speed per level' },
  { id: 'hull', name: 'Hull Plating', icon: '🛡️', max: 5, baseCost: 1600, costMult: 2.4, effect: { durability: 0.25 }, desc: '+25% durability per level' },
  { id: 'fuel', name: 'Fuel Tank', icon: '⛽', max: 4, baseCost: 900, costMult: 2.1, effect: { fuel: 0.3 }, desc: '+30% fuel capacity per level' },
  { id: 'storage', name: 'Hold Expansion', icon: '📦', max: 5, baseCost: 2200, costMult: 2.5, effect: { storage: 0.3 }, desc: '+30% cargo per level' },
  { id: 'sonar', name: 'Sonar', icon: '📡', max: 4, baseCost: 4000, costMult: 2.8, effect: { sonar: 1 }, desc: '+1 sonar tier per level' },
  { id: 'crew', name: 'Crew Quarters', icon: '🛏️', max: 3, baseCost: 5000, costMult: 3.0, effect: { crew: 2 }, desc: '+2 crew capacity per level' },
  { id: 'station', name: 'Fishing Stations', icon: '🎣', max: 4, baseCost: 3200, costMult: 2.4, effect: { catchRate: 0.2 }, desc: '+20% crew catch rate per level' },
  { id: 'harpoon', name: 'Harpoon Station', icon: '🔱', max: 2, baseCost: 9000, costMult: 3.2, effect: { hunterSlots: 1 }, desc: 'Lets a hunter work the deck' },
  { id: 'freezer', name: 'Freezer', icon: '🧊', max: 3, baseCost: 7000, costMult: 2.6, effect: { freshness: 0.1 }, desc: '+10% catch value per level' },
  { id: 'autopilot', name: 'Autopilot', icon: '🧭', max: 2, baseCost: 22000, costMult: 3.5, effect: { autonomy: 0.3 }, desc: 'Faster, safer automated trips', requiresResearch: 'autopilot' },
  { id: 'radar', name: 'Radar', icon: '📶', max: 3, baseCost: 6000, costMult: 2.6, effect: { range: 0.25 }, desc: '+25% operating range per level' },
  { id: 'lights', name: 'Deck Lights', icon: '💡', max: 2, baseCost: 1800, costMult: 2.2, effect: { nightBonus: 0.25 }, desc: 'Crew work properly at night' },
];
export const UPGRADE_BY_ID = Object.fromEntries(BOAT_UPGRADES.map((u) => [u.id, u]));

export function upgradeCost(upgradeId, level) {
  const u = UPGRADE_BY_ID[upgradeId];
  if (!u) return Infinity;
  return Math.round(u.baseCost * Math.pow(u.costMult, level));
}

/** Effective stats for a boat instance including its upgrades. */
export function effectiveStats(def, upgrades = {}) {
  const s = {
    speed: def.speed, handling: def.handling, storage: def.storage, crew: def.crew,
    fuel: def.fuel, fuelUse: def.fuelUse, durability: def.durability, sonar: def.sonar,
    range: def.range, catchRate: 1, freshness: 1, autonomy: 0, nightBonus: 0, hunterSlots: 0,
  };
  for (const [id, lvl] of Object.entries(upgrades)) {
    const u = UPGRADE_BY_ID[id];
    if (!u || !lvl) continue;
    for (const [k, v] of Object.entries(u.effect)) {
      if (k === 'sonar' || k === 'crew' || k === 'hunterSlots') s[k] += v * lvl;
      else s[k] *= 1 + v * lvl;
    }
  }
  return s;
}
