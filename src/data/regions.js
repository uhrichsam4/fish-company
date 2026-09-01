/**
 * World regions. Each has an island (or trench), a shop tier, spawn tables and
 * unlock requirements. Positions are world XZ metres.
 */
export const REGIONS = [
  {
    id: 'crash', name: 'Crash Island', short: 'Crash',
    x: 0, z: 0, radius: 88, peak: 26, reach: 250,
    biome: 'tropical', tier: 1,
    unlocked: true, unlockCost: 0, unlockReq: null,
    desc: 'A sandbar with delusions of grandeur. Your boat is in three pieces on the beach.',
    shopTier: 1, ambience: 'amb_beach',
    fogColor: '#a8d8ea', fogDensity: 0.0026,
    waterShallow: '#3fd0b8', waterDeep: '#0a3a5c', waterHorizon: '#2f7fa8',
    seabedDepth: -22, seabedColor: '#d9c89a',
    dockAngle: 0.6, hasShop: true, hasSell: true, hasHarbor: false,
    spawnDepthBands: [[0.5, 6, 1.0], [6, 16, 0.6]],
    maxFish: 34,
  },
  {
    id: 'rocky', name: 'Rocky Isle', short: 'Rocky',
    x: 430, z: -210, radius: 118, peak: 54, reach: 320,
    biome: 'rocky', tier: 2,
    unlocked: false, unlockCost: 400, unlockReq: { quest: 'q_first_boat' },
    desc: 'Sharp rocks, sharper prices. Something big lives under the pier.',
    shopTier: 2, ambience: 'amb_beach',
    fogColor: '#9fc4d6', fogDensity: 0.0028,
    waterShallow: '#35b8b0', waterDeep: '#06304f', waterHorizon: '#2a6f92',
    seabedDepth: -34, seabedColor: '#8d8a7e',
    dockAngle: 2.4, hasShop: true, hasSell: true, hasHarbor: false,
    spawnDepthBands: [[1, 10, 1.0], [10, 30, 0.8]],
    maxFish: 38, boss: 'dock-eater',
  },
  {
    id: 'harbor', name: 'Port Grimsby', short: 'Harbor',
    x: -400, z: 400, radius: 165, peak: 34, reach: 400,
    biome: 'industrial', tier: 3,
    unlocked: false, unlockCost: 2500, unlockReq: { boss: 'dock-eater' },
    desc: 'An industrial harbour that smells like diesel and opportunity. Your company starts here.',
    shopTier: 3, ambience: 'amb_harbor',
    fogColor: '#a3b3bd', fogDensity: 0.0030,
    waterShallow: '#3a9e9e', waterDeep: '#08283d', waterHorizon: '#3a6b82',
    seabedDepth: -40, seabedColor: '#6e6b60',
    dockAngle: 1.2, hasShop: true, hasSell: true, hasHarbor: true, isHome: true,
    spawnDepthBands: [[1, 12, 1.0], [12, 40, 0.9]],
    maxFish: 40, boss: 'king-crab-boss',
  },
  {
    id: 'wilds', name: 'Tropical Wilds', short: 'Wilds',
    x: 760, z: 520, radius: 142, peak: 72, reach: 380,
    biome: 'jungle', tier: 4,
    unlocked: false, unlockCost: 9000, unlockReq: { boss: 'king-crab-boss' },
    desc: 'Lush, loud and full of things with teeth. The reef is worth the risk.',
    shopTier: 4, ambience: 'amb_beach',
    fogColor: '#b6dcc9', fogDensity: 0.0024,
    waterShallow: '#2fd6c0', waterDeep: '#04304a', waterHorizon: '#2e7f9c',
    seabedDepth: -48, seabedColor: '#e0cf9f',
    dockAngle: 4.0, hasShop: true, hasSell: true, hasHarbor: false,
    spawnDepthBands: [[1, 14, 1.0], [14, 55, 1.0]],
    maxFish: 44, boss: 'the-hammer',
  },
  {
    id: 'storm', name: 'Storm Shelf', short: 'Storm',
    x: -230, z: -830, radius: 126, peak: 88, reach: 360,
    biome: 'storm', tier: 5,
    unlocked: false, unlockCost: 30000, unlockReq: { boss: 'the-hammer' },
    desc: 'It has been raining here since before the map was drawn. The fish like it.',
    shopTier: 5, ambience: 'amb_storm',
    fogColor: '#6d7a86', fogDensity: 0.0052,
    waterShallow: '#2b7d86', waterDeep: '#031e33', waterHorizon: '#3c5566',
    seabedDepth: -60, seabedColor: '#4d5158',
    dockAngle: 0.2, hasShop: true, hasSell: true, hasHarbor: false,
    forceWeather: 'storm',
    spawnDepthBands: [[2, 20, 1.0], [20, 80, 1.0]],
    maxFish: 42, boss: 'stormfin',
  },
  {
    id: 'frozen', name: 'Frozen Sea', short: 'Frozen',
    x: -980, z: -260, radius: 152, peak: 62, reach: 420,
    biome: 'arctic', tier: 6,
    unlocked: false, unlockCost: 90000, unlockReq: { boss: 'stormfin' },
    desc: 'Icebergs, cold species and a persistent feeling of being watched.',
    shopTier: 6, ambience: 'amb_wind',
    fogColor: '#c9dbe6', fogDensity: 0.0040,
    waterShallow: '#4fc2d8', waterDeep: '#031f39', waterHorizon: '#5b8aa5',
    seabedDepth: -72, seabedColor: '#8fa3ad',
    dockAngle: 3.1, hasShop: true, hasSell: true, hasHarbor: false,
    forceWeather: 'snow',
    spawnDepthBands: [[2, 25, 1.0], [25, 110, 1.0]],
    maxFish: 40, boss: 'frostjaw',
  },
  {
    id: 'station', name: 'Deep Sea Station', short: 'Station',
    x: 980, z: -780, radius: 96, peak: 18, reach: 320,
    biome: 'station', tier: 7,
    unlocked: false, unlockCost: 170000, unlockReq: { boss: 'frostjaw', research: 'deep_hull' },
    desc: 'A rusted research platform bolted over a hole in the world. Submarines launch from here.',
    shopTier: 7, ambience: 'amb_ocean',
    fogColor: '#7e93a3', fogDensity: 0.0036,
    waterShallow: '#2b8fa0', waterDeep: '#01121f', waterHorizon: '#365a70',
    seabedDepth: -180, seabedColor: '#3b4048',
    dockAngle: 5.2, hasShop: true, hasSell: true, hasHarbor: true, hasSubBay: true,
    spawnDepthBands: [[3, 40, 0.7], [40, 300, 1.0]],
    maxFish: 36, boss: null,
  },
  {
    id: 'abyss', name: 'The Abyss', short: 'Abyss',
    x: 340, z: 1180, radius: 46, peak: -6, reach: 460,
    biome: 'abyss', tier: 8,
    unlocked: false, unlockCost: 650000, unlockReq: { research: 'abyss_scanner', sub: true },
    desc: 'There is no island here. There is a trench, and the trench has opinions.',
    shopTier: 8, ambience: 'amb_deep',
    fogColor: '#0a1622', fogDensity: 0.0075,
    waterShallow: '#1a5f70', waterDeep: '#000508', waterHorizon: '#16303f',
    seabedDepth: -1400, seabedColor: '#1a1d22',
    dockAngle: 0, hasShop: false, hasSell: false, hasHarbor: false, trench: true,
    spawnDepthBands: [[100, 600, 0.8], [600, 2400, 1.0]],
    maxFish: 30, boss: 'abyss-mouth',
  },
];

export const REGION_BY_ID = Object.fromEntries(REGIONS.map((r) => [r.id, r]));
export const HOME_REGION = 'harbor';
export const START_REGION = 'crash';

export function regionAt(x, z) {
  let best = null, bestD = Infinity;
  for (const r of REGIONS) {
    const d = Math.hypot(x - r.x, z - r.z);
    if (d < r.reach && d < bestD) { best = r; bestD = d; }
  }
  return best;
}

/** Blend factor 0..1 for how strongly a region's look applies at a point. */
export function regionInfluence(r, x, z) {
  const d = Math.hypot(x - r.x, z - r.z);
  if (d >= r.reach) return 0;
  return 1 - Math.pow(d / r.reach, 2);
}
