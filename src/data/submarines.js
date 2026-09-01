/**
 * SUBMARINE CATALOGUE.
 *
 * Mirrors ../data/boats.js in shape so the company UI, the upgrade panel and
 * the save system can treat a sub like a very heavy, very expensive boat that
 * happens to go down instead of along.
 *
 * Units:
 *   speed        m/s at full thrust (top speed, not acceleration)
 *   turnRate     rad/s of yaw authority at full helm
 *   ascendRate   m/s of vertical thrust (ballast + vertical thrusters)
 *   crushDepth   metres below the surface before the hull starts failing
 *   hullStrength hit points; pressure and collisions eat these
 *   battery      kWh-ish reservoir; drains with thrust + lights, recharges topside
 *   batteryUse   units/second at full thrust with lights on
 *   oxygen       seconds of breathable air for ONE occupant (divided by crew)
 *   cargo        kilograms of specimens the hold can carry
 *   lightRange   metres the floodlights reach
 *   lightCone    half-angle of the floodlight cone, radians
 *   sonarRange   metres the scope sweeps
 *   sonarDetail  0..5, fed straight into FishSystem.sonarContacts()
 *
 * `hull` drives the procedural mesh in ../submarines/SubMesh.js, `physics` the
 * kinematic collider, `seats`/`helm` the interior camera anchors.
 */

export const SUBMARINES = [
  {
    id: 'scout',
    name: 'Minnow Scout',
    icon: '🐟',
    price: 180000,
    tier: 1,
    desc: 'A one-seat acrylic bubble on a battery. Rated to 220 m by a man who has never been to 220 m.',

    speed: 6.4, turnRate: 0.85, ascendRate: 3.2,
    crushDepth: 220, hullStrength: 140,
    battery: 100, batteryUse: 1.5,
    oxygen: 2400, cargo: 90, crew: 1,
    lightRange: 26, lightCone: 0.50,
    sonarRange: 70, sonarDetail: 1,
    slots: 2,

    requiresResearch: 'deep_hull',
    unlockRegion: 'harbor',

    hull: {
      length: 5.2, width: 1.9, height: 2.0,
      style: 'bubble',
      color: '#f0d34a', accent: '#2b3138',
    },
    physics: { hx: 1.05, hy: 1.05, hz: 2.7 },
    seats: [{ id: 'pilot', x: 0, y: 0.05, z: 0.55 }],
    helm: { x: 0, y: 0.18, z: 0.62 },
  },

  {
    id: 'research',
    name: 'Nautilus Research',
    icon: '🔬',
    price: 1400000,
    tier: 2,
    desc: 'Three seats, a wet lab and a manipulator arm. Insurance was very specific about the arm.',

    speed: 5.6, turnRate: 0.62, ascendRate: 2.8,
    crushDepth: 900, hullStrength: 420,
    battery: 280, batteryUse: 2.4,
    oxygen: 5400, cargo: 380, crew: 3,
    lightRange: 46, lightCone: 0.55,
    sonarRange: 150, sonarDetail: 2,
    slots: 4,

    requiresResearch: 'sub_bay',
    unlockRegion: 'station',

    hull: {
      length: 9.4, width: 3.0, height: 3.1,
      style: 'research',
      color: '#e8e2d4', accent: '#d8541f',
    },
    physics: { hx: 1.6, hy: 1.6, hz: 4.8 },
    seats: [
      { id: 'pilot', x: 0, y: 0.05, z: 1.4 },
      { id: 'sonar', x: -0.7, y: 0.05, z: 0.1 },
      { id: 'observer', x: 0.7, y: 0.05, z: 0.1 },
    ],
    helm: { x: 0, y: 0.22, z: 1.5 },
  },

  {
    id: 'industrial',
    name: 'Dredger Industrial',
    icon: '⚙️',
    price: 8500000,
    tier: 3,
    desc: 'Six crew, a cargo basket you could park a car in, and a hull you can hear thinking.',

    speed: 4.8, turnRate: 0.44, ascendRate: 2.2,
    crushDepth: 1800, hullStrength: 1200,
    battery: 760, batteryUse: 3.8,
    oxygen: 10800, cargo: 1800, crew: 6,
    lightRange: 72, lightCone: 0.62,
    sonarRange: 260, sonarDetail: 3,
    slots: 7,

    requiresResearch: 'titanium_sphere',
    unlockRegion: 'station',

    hull: {
      length: 15.5, width: 4.6, height: 4.6,
      style: 'industrial',
      color: '#4a5560', accent: '#e8b023',
    },
    physics: { hx: 2.4, hy: 2.4, hz: 7.9 },
    seats: [
      { id: 'pilot', x: 0, y: 0.05, z: 2.6 },
      { id: 'sonar', x: -1.0, y: 0.05, z: 1.1 },
      { id: 'arm', x: 1.0, y: 0.05, z: 1.1 },
      { id: 'crew1', x: -1.0, y: 0.05, z: -0.6 },
      { id: 'crew2', x: 1.0, y: 0.05, z: -0.6 },
      { id: 'crew3', x: 0, y: 0.05, z: -2.0 },
    ],
    helm: { x: 0, y: 0.30, z: 2.7 },
  },

  {
    id: 'abyss',
    name: 'Hadal Abyss-Class',
    icon: '🌑',
    price: 40000000,
    tier: 4,
    desc: 'A forged titanium sphere inside a hull inside a rumour. Goes to three kilometres and comes back.',

    speed: 7.2, turnRate: 0.55, ascendRate: 3.6,
    crushDepth: 3000, hullStrength: 3600,
    battery: 2200, batteryUse: 5.2,
    oxygen: 25200, cargo: 6000, crew: 10,
    lightRange: 120, lightCone: 0.70,
    sonarRange: 520, sonarDetail: 5,
    slots: 12,

    requiresResearch: 'abyssal_drive',
    unlockRegion: 'abyss',

    hull: {
      length: 24, width: 6.4, height: 6.4,
      style: 'abyss',
      color: '#232a33', accent: '#4fe8d0',
    },
    physics: { hx: 3.3, hy: 3.3, hz: 12.2 },
    seats: [
      { id: 'pilot', x: 0, y: 0.05, z: 4.6 },
      { id: 'sonar', x: -1.4, y: 0.05, z: 2.6 },
      { id: 'arm', x: 1.4, y: 0.05, z: 2.6 },
      { id: 'crew1', x: -1.4, y: 0.05, z: 0.4 },
      { id: 'crew2', x: 1.4, y: 0.05, z: 0.4 },
      { id: 'crew3', x: -1.4, y: 0.05, z: -1.8 },
      { id: 'crew4', x: 1.4, y: 0.05, z: -1.8 },
      { id: 'crew5', x: 0, y: 0.05, z: -3.6 },
      { id: 'crew6', x: -1.0, y: 0.05, z: -5.2 },
      { id: 'crew7', x: 1.0, y: 0.05, z: -5.2 },
    ],
    helm: { x: 0, y: 0.42, z: 4.7 },
  },
];

export const SUB_BY_ID = Object.fromEntries(SUBMARINES.map((s) => [s.id, s]));

/**
 * Upgrades. Same shape as BOAT_UPGRADES: multiplicative on the named stat
 * unless the key is listed in ADDITIVE_KEYS below.
 */
export const SUB_UPGRADES = [
  {
    id: 'hull', name: 'Pressure Hull', icon: '🛡️', max: 5, baseCost: 40000, costMult: 2.5,
    effect: { hullStrength: 0.3, crushDepth: 0.18 },
    desc: '+30% hull integrity and +18% crush depth per level',
  },
  {
    id: 'battery', name: 'Battery Bank', icon: '🔋', max: 5, baseCost: 26000, costMult: 2.3,
    effect: { battery: 0.35 },
    desc: '+35% stored power per level',
  },
  {
    id: 'lights', name: 'Floodlights', icon: '💡', max: 4, baseCost: 18000, costMult: 2.2,
    effect: { lightRange: 0.3, lightCone: 0.07 },
    desc: '+30% light reach and a wider cone per level',
  },
  {
    id: 'sonar', name: 'Sonar Array', icon: '📡', max: 4, baseCost: 60000, costMult: 2.7,
    effect: { sonarRange: 0.35, sonarDetail: 1 },
    desc: '+35% sonar range and +1 detail tier per level',
    requiresResearch: 'advanced_sonar',
  },
  {
    id: 'cargo', name: 'Specimen Hold', icon: '📦', max: 5, baseCost: 34000, costMult: 2.5,
    effect: { cargo: 0.4 },
    desc: '+40% specimen capacity per level',
  },
  {
    id: 'thrusters', name: 'Thrusters', icon: '🌀', max: 5, baseCost: 30000, costMult: 2.4,
    effect: { speed: 0.12, turnRate: 0.1, ascendRate: 0.14, batteryUse: 0.06 },
    desc: '+12% speed, +10% turn, +14% ascent (and 6% more draw) per level',
  },
  {
    id: 'oxygen', name: 'Life Support', icon: '🫁', max: 4, baseCost: 22000, costMult: 2.3,
    effect: { oxygen: 0.45 },
    desc: '+45% breathable air per level',
  },
  {
    id: 'arm', name: 'Manipulator Arm', icon: '🦾', max: 3, baseCost: 90000, costMult: 2.9,
    effect: { grabRange: 1.8, grabSpeed: 0.25, armTier: 1 },
    desc: '+1.8 m reach, 25% faster grabs and heavier specimens per level',
  },
];

export const SUB_UPGRADE_BY_ID = Object.fromEntries(SUB_UPGRADES.map((u) => [u.id, u]));

/** Stats that add rather than scale when an upgrade level is applied. */
const ADDITIVE_KEYS = new Set(['sonarDetail', 'armTier', 'grabRange', 'lightCone', 'crew', 'slots']);

export function subUpgradeCost(upgradeId, level) {
  const u = SUB_UPGRADE_BY_ID[upgradeId];
  if (!u) return Infinity;
  return Math.round(u.baseCost * Math.pow(u.costMult, level));
}

/** Total spent so far on a sub's upgrades — used for resale value. */
export function subUpgradeValue(upgrades = {}) {
  let total = 0;
  for (const [id, lvl] of Object.entries(upgrades)) {
    for (let i = 0; i < (lvl || 0); i++) total += subUpgradeCost(id, i);
  }
  return total;
}

/**
 * Effective stats for a sub instance including its upgrades.
 * Same contract as `effectiveStats` in ../data/boats.js.
 */
export function effectiveSubStats(def, upgrades = {}) {
  const s = {
    speed: def.speed, turnRate: def.turnRate, ascendRate: def.ascendRate,
    crushDepth: def.crushDepth, hullStrength: def.hullStrength,
    battery: def.battery, batteryUse: def.batteryUse,
    oxygen: def.oxygen, cargo: def.cargo, crew: def.crew,
    lightRange: def.lightRange, lightCone: def.lightCone,
    sonarRange: def.sonarRange, sonarDetail: def.sonarDetail,
    slots: def.slots,
    // Derived, upgrade-only stats.
    grabRange: 5.5, grabSpeed: 1, armTier: def.tier >= 2 ? 1 : 0,
  };
  for (const [id, lvl] of Object.entries(upgrades)) {
    const u = SUB_UPGRADE_BY_ID[id];
    if (!u || !lvl) continue;
    for (const [k, v] of Object.entries(u.effect)) {
      if (s[k] == null) continue;
      if (ADDITIVE_KEYS.has(k)) s[k] += v * lvl;
      else s[k] *= 1 + v * lvl;
    }
  }
  return s;
}

/** Convenience for the shop: cheapest-first, already ordered by tier. */
export const SUB_TIERS = SUBMARINES.map((s) => s.tier);
