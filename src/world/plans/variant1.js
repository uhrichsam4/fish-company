/**
 * Variant 1 -- groves and clearings.
 *
 * The island is composed the way a meadow biome is: ten palm GROVES (tight
 * stands of 5-12 trees, tallest in the middle, a dead trunk or two on the
 * rim) sit on the gentler benches, and everything between them is left open
 * so the player walks through CLEARINGS and along natural corridors rather
 * than through an even sprinkle of trunks. Bushes hug the grove rims where the
 * light is, with only stragglers out in the open. Rocks gather into three
 * ROCK FIELDS on the steep northern, western and southern shoulders, each
 * anchored by a cliff chunk and a boulder cluster, and thin out to a few tidal
 * stones at the waterline. Four lone giant palms mark the ridge -- the summit
 * crown and three sentinels -- as things to walk toward. Driftwood lies only
 * on the beaches, on the far shores the start area does not touch.
 *
 * Every decision is a pure function of position: the same island every time.
 */
import { worldSlope } from '../Terrain.js';
import { clamp01, lerp, smootherstep } from '../../util/math.js';

/** Tight stands of palms. `r` is the stand's radius in metres. */
const GROVES = [
  { x: -68, z: -18, r: 9 },  // west terrace, high
  { x: 24, z: -74, r: 9 },   // north-east shelf, low
  { x: 42, z: -36, r: 8 },   // east upland, high
  { x: 2, z: 50, r: 9 },     // south meadow
  { x: -38, z: -44, r: 8 },  // north-west bench, high
  { x: 68, z: -24, r: 8 },   // east coast, low
  { x: 32, z: -12, r: 7 },   // east saddle, high
  { x: -20, z: -58, r: 7 },  // north bench, high
  { x: -54, z: 14, r: 8 },   // south-west step, high
  { x: -20, z: 40, r: 7 },   // south slope
];

/** Steep shoulders where the stone collects. Density falls off to the rim. */
const ROCK_FIELDS = [
  { x: 2, z: -66, r: 12 },   // north scree
  { x: -64, z: -48, r: 14 }, // west shoulder
  { x: -42, z: 48, r: 13 },  // south shoulder
];

/** Lone giant palms on the ridge; no framework tree grows within LONE_R of one. */
const GIANTS = [
  { id: 'crown', x: -6, z: -12, height: 17, lean: 0.04, rot: 0.9 },
  { id: 'north-sentinel', x: 16, z: -24, height: 15.5, lean: 0.08, rot: 2.6 },
  { id: 'west-sentinel', x: -38, z: 18, height: 16, lean: 0.06, rot: 4.1 },
  { id: 'south-sentinel', x: -12, z: 36, height: 15, lean: 0.09, rot: 5.5 },
];
const LONE_R = 6;

/** One cliff chunk per rock field, on the flattest ground near its centre. */
const CLIFFS = [
  { id: 'north-scree', x: 0, z: -64, width: 6, rot: 1.2 },
  { id: 'west-shoulder', x: -66, z: -56, width: 6.5, rot: 3.4 },
  { id: 'south-shoulder', x: -37, z: 51, width: 5.5, rot: 0.4 },
];

/**
 * One boulder cluster per rock field, a dozen metres from its cliff. Placed by
 * hand rather than scattered: the framework cannot keep a scattered boulder
 * out of the start area, where the baseline has none.
 */
const BOULDERS = [
  { id: 'north-scree', x: 6, z: -74, rot: 0.6 },
  { id: 'west-shoulder', x: -72, z: -46, rot: 2.9 },
  { id: 'south-shoulder', x: -41, z: 39, rot: 4.4 },
];

/** Logs on the far beaches, each around the 0.9 m tide line. */
const DRIFTWOOD = [
  { id: 'south-beach', x: 4.8, z: 67.4, length: 3.1, rot: 1.9 },
  { id: 'west-beach', x: -96, z: 13.7, length: 3.4, rot: 1.4 },
  { id: 'north-beach', x: -19.3, z: -89.4, length: 3.0, rot: 0.7 },
  { id: 'north-east-beach', x: 64.7, z: -64.4, length: 2.8, rot: 2.2 },
];

/** Where wet sand starts: rocks below this are tidal stones, not scenery. */
const TIDE_H = 0.6;

/**
 * The framework forces allow() on inside this ring around the start anchors
 * but still asks density() there. Because the rest of the island now rejects
 * most spots, an unweighted start area would soak up the scatter and end up
 * far busier than it was. These weights bring it back to the baseline's yield
 * (about 13 trees, 20 bushes, 9 rocks) so the first minute keeps its look.
 */
const START_KEEP = 34;
const START_TREE_DENSITY = 0.095;
const START_BUSH_DENSITY = 0.22;
const START_ROCK_DENSITY = 0.011;

/** 0..1 hash of a position, stable per half-metre cell. `salt` separates uses. */
function hash01(x, z, salt) {
  let n = (Math.round(x * 2) * 73856093) ^ (Math.round(z * 2) * 19349663) ^ (salt * 83492791);
  n = Math.imul(n ^ (n >>> 13), 0x5bd1e995);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

/** Distance to the nearest grove centre as a fraction of that grove's radius (0 = centre, 1 = rim). */
function groveT(x, z) {
  let best = Infinity;
  for (const g of GROVES) best = Math.min(best, Math.hypot(x - g.x, z - g.z) / g.r);
  return best;
}

/** How deep inside a rock field a point is: 1 at a centre, easing to 0 at the rim. */
function rockFieldWeight(x, z) {
  let best = 0;
  for (const f of ROCK_FIELDS) best = Math.max(best, smootherstep(1 - Math.hypot(x - f.x, z - f.z) / f.r));
  return best;
}

function nearGiant(x, z) {
  return GIANTS.some((g) => Math.hypot(x - g.x, z - g.z) < LONE_R);
}

/** True inside the ring the framework keeps for the start area. */
function startAreaTest(anchors) {
  const pts = ['spawn', 'shop', 'sell', 'campfire', 'wreck', 'hire', 'dockStart', 'shore']
    .map((k) => anchors?.[k]).filter(Boolean);
  return (x, z) => pts.some((p) => Math.hypot(x - p.x, z - p.z) < START_KEEP);
}

function allowTree(x, z) {
  return groveT(x, z) <= 1 && !nearGiant(x, z);
}

/** A bush in a rock field's core is a bush growing out of scree; keep them to the fringes. */
function allowBush(x, z) {
  return rockFieldWeight(x, z) < 0.6;
}

function allowRock(x, z, h) {
  return rockFieldWeight(x, z) > 0 || h < TIDE_H;
}

/** Full stands with a softer rim, so groves read as domes rather than discs. */
function treeDensity(x, z, inStart) {
  if (inStart) return START_TREE_DENSITY;
  return groveT(x, z) < 0.75 ? 1 : 0.6;
}

/** Bushes crowd the grove rims; the open ground gets only stragglers. */
function bushDensity(x, z, h, inStart) {
  if (inStart) return START_BUSH_DENSITY;
  const t = groveT(x, z);
  if (t >= 0.7 && t <= 1.6) return 1;
  if (t < 0.7) return 0.25;
  const field = rockFieldWeight(x, z);
  if (field > 0) return 0.15 * (1 - field);
  return h < 2 ? 0.12 : 0.06;
}

/** Stone piles up on the steeper ground inside a field; a few stones sit in the shallows. */
function rockDensity(x, z, h, inStart) {
  if (inStart) return START_ROCK_DENSITY;
  const field = rockFieldWeight(x, z);
  if (field > 0) return clamp01(0.3 + field * (0.5 + worldSlope(x, z)));
  return h > -1.0 ? 0.025 : 0;
}

/** Palms, with the odd dead trunk on a grove's rim for silhouette. */
function treeSpecies(x, z) {
  return groveT(x, z) > 0.8 && hash01(x, z, 1) < 0.1 ? 'dead' : 'palm';
}

/** Grove cores stand tallest; the rim is shorter, so a stand domes. */
function treeHeight(x, z, h, r01) {
  const core = 1 - clamp01(groveT(x, z));
  return lerp(5.5, 10.5, r01) * lerp(0.85, 1.2, core);
}

function treeScale(x, z, h, base) {
  return base * lerp(0.9, 1.1, hash01(x, z, 2));
}

function giantLandmarks() {
  return GIANTS.map((g) => ({
    id: 'giant-' + g.id, builder: 'palmTree', opts: { height: g.height, lean: g.lean },
    x: g.x, z: g.z, rot: g.rot, scale: 1.15, yOffset: -0.25,
    collider: { hh: 3.5, r: 0.5 },
  }));
}

/** Sunk a little so the downhill side does not float off a shoulder. */
function cliffLandmarks() {
  return CLIFFS.map((c) => ({
    id: 'cliff-' + c.id, builder: 'cliffChunk', opts: { width: c.width },
    x: c.x, z: c.z, rot: c.rot, yOffset: -1.0,
    collider: { hh: 2.6, r: c.width * 0.4 },
  }));
}

/**
 * Unbreakable, so they can carry a collider: a landmark's body is not handed
 * to the harvest system and would outlive a mined boulder as an invisible wall.
 */
function boulderLandmarks() {
  return BOULDERS.map((b) => ({
    id: 'boulder-' + b.id, builder: 'rockCluster', opts: { size: 2.2, count: 3 },
    x: b.x, z: b.z, rot: b.rot, scale: 1.3, yOffset: -0.5,
    collider: { hh: 1.4, r: 2.2 },
  }));
}

/** Harvestable logs. Low enough to step over, so no collider that would outlive the wood. */
function driftwoodLandmarks() {
  return DRIFTWOOD.map((d) => ({
    id: 'driftwood-' + d.id, builder: 'driftwood', opts: { length: d.length },
    x: d.x, z: d.z, rot: d.rot, harvest: 'driftwood', radius: 1.4,
  }));
}

export function plan(def, anchors) {
  const inStart = startAreaTest(anchors);
  return {
    allow: (kind, x, z, h) => {
      if (kind === 'tree') return allowTree(x, z);
      if (kind === 'bush') return allowBush(x, z);
      if (kind === 'rock') return allowRock(x, z, h);
      return true;
    },
    density: (kind, x, z, h) => {
      if (kind === 'tree') return treeDensity(x, z, inStart(x, z));
      if (kind === 'bush') return bushDensity(x, z, h, inStart(x, z));
      if (kind === 'rock') return rockDensity(x, z, h, inStart(x, z));
      return 1;
    },
    counts: { trees: 100, bushes: 200, rocks: 120, boulders: 0 },
    trees: { minH: 2.0, maxH: 21.3, maxSlope: 0.5, minSpacing: 3.8 },
    rocks: { minSpacing: 2.6 },
    treeSpecies,
    treeHeight,
    treeScale,
    landmarks: [...giantLandmarks(), ...cliffLandmarks(), ...boulderLandmarks(), ...driftwoodLandmarks()],
  };
}
