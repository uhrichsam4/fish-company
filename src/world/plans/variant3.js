/**
 * Variant 3: silhouette and orientation.
 *
 * The island is composed so you always know where you are by looking up.
 * Pines crown the summit ridge (the high west-north-west mass) and nothing
 * else grows that tall. The north flank below the crown is left as a bald
 * rocky shoulder: a rock field, cliff chunks, a few dead trees on its
 * mid-slope and almost no green. The south flank is the opposite -- a dense
 * palm forest running down to a driftwood bay in the south-west. A second
 * driftwood cove, with an abandoned castaway camp above it, sits under the
 * shoulder on the north coast. Palms are tall in sheltered hollows and short
 * and squat on exposed ridges, so the canopy itself reads the terrain.
 *
 * Three clearings thread it together: hire post -> summit, summit -> south
 * bay, hire post -> north cove. Everything here is a pure function of
 * position; the only randomness used is the rng the framework hands in.
 */
import { worldHeight } from '../Terrain.js';
import { clamp, clamp01, lerp } from '../../util/math.js';

/** Height (m) above which the crown of pines begins. The summit is ~33 m. */
const CROWN_LINE = 22;
/** The crown dips lower over the bald shoulder so it is visible from the cove. */
const CROWN_LINE_OVER_SHOULDER = 19;
/** Boulders stay on the rocky half of the island: the shoulder and the crown's north-west face. */
const BOULDER_ARC = [200, 360];
/** Bearing arcs from the island centre, degrees, atan2(z, x) style. */
const SHOULDER_ARC = [235, 325];
const FOREST_ARC = [80, 200];
/** Half-width of a clearing, metres, per kind. */
const CLEARING = { tree: 4.5, bush: 3.5, rock: 2.0, boulder: 6.0 };
/** Radius around a landmark that scatter keeps out of, metres, per kind. */
const LANDMARK_KEEP_OUT = { tree: 4.0, bush: 2.5, rock: 3.0, boulder: 9.0 };
/** Landmarks stay at least this far from every start-area anchor. */
const LANDMARK_KEEP = 40;

function bearingDeg(x, z) {
  const b = Math.atan2(z, x) * 180 / Math.PI;
  return b < 0 ? b + 360 : b;
}

function inArc(x, z, [lo, hi]) {
  const b = bearingDeg(x, z);
  return b >= lo && b <= hi;
}

function crownLine(x, z) {
  return inArc(x, z, SHOULDER_ARC) ? CROWN_LINE_OVER_SHOULDER : CROWN_LINE;
}

function isCrown(x, z, h) { return h >= crownLine(x, z); }

/** The bald flank: north arc, below the crown, clear of the summit plateau. */
function isShoulder(x, z, h) {
  return inArc(x, z, SHOULDER_ARC) && !isCrown(x, z, h) && Math.hypot(x, z) > 30;
}

/** The green flank: south arc, below the crown. */
function isForest(x, z, h) {
  return inArc(x, z, FOREST_ARC) && !isCrown(x, z, h);
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp01(((px - ax) * dx + (pz - az) * dz) / len2) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/**
 * The three clearings, as polylines routed over the gentlest ground. Two start
 * at the hire post. The ridge clearing climbs the east slope and crosses one
 * short steep step below the summit; the south clearing leaves the summit by
 * its gentler south-west ramp; the cove clearing follows the east shore round.
 */
function clearings(anchors) {
  const hire = anchors?.hire ? [anchors.hire.x, anchors.hire.z] : [59.5, 28.4];
  const summit = [-6, -12];
  return [
    [hire, [66, 12], [60, -6], [21, -12], [12, -6], [3, -6], summit],
    [summit, [-12, -3], [-9, 6], [-18, 12], [-27, 12], [-33, 18], [-24, 42], [-36, 57], [-33, 66]],
    [hire, [69, 12], [75, -12], [78, -48], [51, -75], [19, -78]],
  ];
}

function distanceToClearing(paths, x, z) {
  let best = Infinity;
  for (const pts of paths) {
    for (let i = 1; i < pts.length; i++) {
      const d = segmentDistance(x, z, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * 0 = sheltered hollow low on the island, 1 = exposed knoll or ridge.
 * Compares a spot with the ground seven metres around it: a spot lower than
 * its surroundings is in a hollow, one higher is on a knoll.
 */
function exposure(x, z, h) {
  const rim = 7;
  const around = (worldHeight(x + rim, z) + worldHeight(x - rim, z) + worldHeight(x, z + rim) + worldHeight(x, z - rim)) / 4;
  const hollow = clamp((around - h) / 3, -1, 1);
  const height = clamp01((h - 2) / 12);
  return clamp01(0.15 + height * 0.6 - hollow * 0.45);
}

/** Height band first, then flank: pines crown, dead trees on the dry shoulder, palms below. */
function treeSpecies(x, z, h, rng) {
  if (isCrown(x, z, h)) return 'pine';
  if (h >= crownLine(x, z) - 3 && rng() < 0.35) return 'pine';
  if (isShoulder(x, z, h) && h >= 5) return 'dead';
  return 'palm';
}

/** Palm height, metres: tall in hollows, squat on ridges, with a little jitter. */
function palmHeight(x, z, h, r01) {
  return lerp(12.5, 4.5, exposure(x, z, h)) + (r01 - 0.5) * 2.5;
}

function palmScale(x, z, h, base) {
  return base * lerp(1.2, 0.8, exposure(x, z, h));
}

function treeDensity(x, z, h) {
  if (isShoulder(x, z, h)) return 0.1;
  if (isForest(x, z, h)) return 1.0;
  if (isCrown(x, z, h)) return 0.3;
  return 0.45;
}

function allowsBoulder(x, z, h) {
  return isShoulder(x, z, h) || (isCrown(x, z, h) && inArc(x, z, BOULDER_ARC));
}

function bushDensity(x, z, h, nearClearing) {
  if (nearClearing) return 0.2;
  if (isShoulder(x, z, h)) return 0.1;
  if (isForest(x, z, h)) return 1.0;
  if (isCrown(x, z, h)) return 0.35;
  return 0.5;
}

function rockDensity(x, z, h, nearClearing) {
  let d;
  if (isShoulder(x, z, h)) d = 1.0;
  else if (isCrown(x, z, h)) d = 0.45;
  else if (isForest(x, z, h)) d = 0.12;
  else d = 0.3;
  return nearClearing ? d * 0.25 : d;
}

function landmarks() {
  return [
    // Summit: a signpost and a cairn on the flat top, under the pines.
    { id: 'summitSign', builder: 'signpost', opts: { arrows: 3, height: 2.4 }, x: -6.6, z: -12.1, rot: 0.6, collider: { hh: 1.2, r: 0.16 } },
    { id: 'summitCairn', builder: 'rockCluster', opts: { size: 1.7, count: 5 }, x: -4.4, z: -16.3, rot: 2.1, scale: 1.2, collider: { hh: 1.4, r: 2.0 } },
    // Where the ridge clearing leaves the east slope and the cove clearing splits off.
    { id: 'forkSign', builder: 'signpost', opts: { arrows: 2, height: 2.2 }, x: 33.1, z: -8.7, rot: 3.4, collider: { hh: 1.1, r: 0.16 } },
    // The bald shoulder: two cliff chunks and a cluster that read from the sea.
    { id: 'shoulderCliffWest', builder: 'cliffChunk', opts: { width: 6, height: 6.5 }, x: -27.4, z: -70.2, rot: 1.1, yOffset: -0.8, collider: { hh: 3.0, r: 2.8 } },
    { id: 'shoulderCliffEast', builder: 'cliffChunk', opts: { width: 5, height: 5.5 }, x: 19.6, z: -51.4, rot: 4.4, yOffset: -0.8, collider: { hh: 2.6, r: 2.4 } },
    { id: 'shoulderCluster', builder: 'rockCluster', opts: { size: 1.9, count: 6 }, x: -36.0, z: -54.0, rot: 0.3, collider: { hh: 1.5, r: 2.4 } },
    // South-west driftwood bay at the foot of the palm forest.
    { id: 'southDriftA', builder: 'driftwood', opts: { length: 3.4 }, x: -32.9, z: 66.0, rot: 1.9, harvest: 'driftwood', radius: 1.7 },
    { id: 'southDriftB', builder: 'driftwood', opts: { length: 2.6 }, x: -41.0, z: 62.0, rot: 0.4, harvest: 'driftwood', radius: 1.4 },
    { id: 'southDriftC', builder: 'driftwood', opts: { length: 3.0 }, x: -22.0, z: 69.0, rot: 2.8, harvest: 'driftwood', radius: 1.5 },
    { id: 'southCrate', builder: 'crate', opts: { size: 0.8 }, x: -46.9, z: 57.5, rot: 0.9, harvest: 'crate', radius: 0.9 },
    // North cove under the shoulder, with a castaway camp on the grass above it.
    { id: 'coveDriftA', builder: 'driftwood', opts: { length: 3.2 }, x: 11.9, z: -88.9, rot: 0.7, harvest: 'driftwood', radius: 1.6 },
    { id: 'coveDriftB', builder: 'driftwood', opts: { length: 2.4 }, x: 36.7, z: -84.1, rot: 2.3, harvest: 'driftwood', radius: 1.3 },
    { id: 'coveTent', builder: 'tent', opts: {}, x: 19.1, z: -78.1, rot: 5.6, collider: { hh: 0.8, r: 1.5 } },
    { id: 'coveBarrel', builder: 'barrel', opts: {}, x: 22.6, z: -75.6, rot: 1.3, harvest: 'barrel', radius: 0.8 },
  ];
}

function farFromStart(anchors, lm) {
  return ['spawn', 'shop', 'sell', 'campfire', 'wreck', 'hire', 'dockStart']
    .map((k) => anchors?.[k]).filter(Boolean)
    .every((p) => Math.hypot(lm.x - p.x, lm.z - p.z) >= LANDMARK_KEEP);
}

function distanceToLandmark(lms, x, z) {
  let best = Infinity;
  for (const lm of lms) best = Math.min(best, Math.hypot(x - lm.x, z - lm.z));
  return best;
}

export function plan(def, anchors) {
  const paths = clearings(anchors);
  const lms = landmarks().filter((lm) => farFromStart(anchors, lm));
  const clearingDistance = (x, z) => distanceToClearing(paths, x, z);
  const landmarkDistance = (x, z) => distanceToLandmark(lms, x, z);

  return {
    counts: { trees: 110, bushes: 210, rocks: 140, boulders: 12 },
    // maxH raised past the framework default so pines can reach the actual
    // summit; maxSlope kept at the default so the start area scatters as today.
    trees: { minH: 2.0, maxH: 36, maxSlope: 0.5, minSpacing: 6.0 },
    rocks: { minSpacing: 2.8 },

    allow(kind, x, z, h) {
      if (kind === 'boulder' && !allowsBoulder(x, z, h)) return false;
      return clearingDistance(x, z) >= CLEARING[kind] && landmarkDistance(x, z) >= LANDMARK_KEEP_OUT[kind];
    },

    density(kind, x, z, h) {
      const nearClearing = clearingDistance(x, z) < 6;
      if (kind === 'tree') return treeDensity(x, z, h);
      if (kind === 'bush') return bushDensity(x, z, h, nearClearing);
      if (kind === 'rock') return rockDensity(x, z, h, nearClearing);
      return 1;
    },

    treeSpecies,
    treeHeight: palmHeight,
    treeScale: palmScale,
    landmarks: lms,
  };
}
