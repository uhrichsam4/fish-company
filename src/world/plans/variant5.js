/**
 * Variant 5: silhouette graft.
 *
 * Variant 2's pacing survives underneath -- resources thin near the start
 * and pile up on the far side and the high ground -- but the island's shape
 * is now composed to be read from two places.
 *
 * From the start beach, looking inland: a thick palm line, and above it the
 * summit ridge carrying three tall apex pines and, left of them, a ten-metre
 * standing stone that shows over the palms. Thick palms mean the start side.
 *
 * From the summit viewpoint, looking toward the far coast: nothing. The view
 * wedge is kept clear of anything whose top would cut the horizon -- trees,
 * boulders, big rocks -- so the far coast is open. The pine crown is split
 * into two arms either side of that wedge: a north grove running down the
 * north ridge from the apex pines, and a south-west grove reached along a
 * thin arm of pines from the summit's west rim, with the open plateau meadow
 * between them. The far-coast flank below is bald: short palms, few bushes,
 * two cliff shelves, the boulder hall, dead trees. Bare rock means the far
 * side.
 *
 * Stone is its own destination: a rock field on the north-east upper slope
 * between the north grove and the east flank, with the scatter's boulders
 * allowed only there, at grove edges, by the east palm clump and on the bald
 * shoulder. Wood without an axe: driftwood along the south-west bay at the
 * foot of the palm forest. Three clearings thread it: hire post to summit,
 * summit to the south-west bay, hire post round the east shore to the north
 * cove. Palms are tall in hollows and squat on ridges, so the canopy reads
 * the ground.
 */
import { worldHeight, worldSlope } from '../Terrain.js';
import { clamp, clamp01, lerp } from '../../util/math.js';

/** Radius the framework keeps around the start anchors; landmarks stay outside it. */
const START_KEEP = 56;
/** Bearings are degrees, atan2(z, x) style. The start beach lies at 34 deg; the far coast is opposite. */
const FAR_BEARING = 214;
/** The summit viewpoint the far-coast view is judged from. */
const SUMMIT_EYE = worldHeight(0, 0) + 2.2;
/** No scattered tree this close to the summit point. */
const SUMMIT_CLEAR = 15;
/** Half-width of the far-coast view wedge, degrees either side of FAR_BEARING. */
const VIEW_HALF_ANGLE = 40;
/** A thing whose top rises above this gradient from the summit eye cuts the horizon. */
const VIEW_GRADIENT = -0.1;
/** Nominal top heights above ground, metres, for the horizon test. */
const TOP = { tree: 12, boulder: 4.5, rock: 1.8, bush: 1.4 };
/** Height above which the summit mass is open meadow unless a pine zone says otherwise. */
const PLATEAU = 20;

/** Bearing arcs from the island centre. */
const FOREST_ARC = [80, 205];
const BALD_ARC = [205, 300];
const EAST_ARC = [300, 345];
/** West-side transition from pines to palms: this arc, this height band. */
const TRANSITION_ARC = [150, 205], TRANSITION_H = [15, 23];

/** Pine zones: the two groves and the thin arm joining the summit rim to the south-west grove. */
const NORTH_GROVE = { x: 5, z: -32, r: 17 };
const SOUTH_GROVE = { x: -42, z: 12, r: 11 };
const WEST_ARM = { ax: -16, az: 9, bx: -30, bz: 16, halfWidth: 6 };
/** Dead trees stand in a ring this wide round each grove's edge, except up by the apex pines. */
const GROVE_RIM = 6, RIM_CLEAR_OF_SUMMIT = 24;
/** The stone field on the north-east upper slope. */
const ROCK_FIELD = { x: 24, z: -38, r: 14 };
/** The one tight palm clump on the east flank, and the boulder pair beside it. */
const EAST_CLUMP = { x: 49, z: -35, r: 10 };
const EAST_PAIR = { x: 56, z: -30, r: 9 };
/** Far-west hill of standing dead palms, wrapping the south-west grove, and the boulder hall below it. */
const DEAD_HILL = { x: -58, z: 16, r: 12 };
const BOULDER_HALL = { x: -52, z: -22, r: 16 };

/** Half-width of a clearing, metres, per kind. */
const CLEARING = { tree: 4.5, bush: 3.5, rock: 2.0, boulder: 6.0 };
/** Radius round a landmark that scatter keeps out of, metres, per kind, on top of the landmark's own radius. */
const LANDMARK_KEEP_OUT = { tree: 4.0, bush: 2.5, rock: 3.0, boulder: 6.0 };

function bearingDeg(x, z) {
  const b = Math.atan2(z, x) * 180 / Math.PI;
  return b < 0 ? b + 360 : b;
}

function inArc(x, z, [lo, hi]) {
  const b = bearingDeg(x, z);
  return b >= lo && b <= hi;
}

function angleGap(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function inDisc(disc, x, z) { return Math.hypot(x - disc.x, z - disc.z) <= disc.r; }

/** 1 at a disc's centre, fading to 0 over its outer third. */
function discWeight(disc, x, z) {
  return clamp01((1 - Math.hypot(x - disc.x, z - disc.z) / disc.r) * 3);
}

function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp01(((px - ax) * dx + (pz - az) * dz) / len2) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// ---- the far-coast view ----

/** True when something of the given top height at (x, z) would cut the horizon seen from the summit eye. */
function cutsSummitView(x, z, h, top) {
  const d = Math.hypot(x, z);
  if (d < 1) return true;
  if (angleGap(bearingDeg(x, z), FAR_BEARING) > VIEW_HALF_ANGLE) return false;
  return (h + top - SUMMIT_EYE) / d > VIEW_GRADIENT;
}

/** Inside the view wedge on the plateau: the meadow the camera looks across. */
function inSummitMeadow(x, z, h) {
  return h >= PLATEAU && angleGap(bearingDeg(x, z), FAR_BEARING) <= VIEW_HALF_ANGLE && Math.hypot(x, z) < 45;
}

// ---- zones ----

function onWestArm(x, z) {
  return segmentDistance(x, z, WEST_ARM.ax, WEST_ARM.az, WEST_ARM.bx, WEST_ARM.bz) <= WEST_ARM.halfWidth;
}

function inPineZone(x, z) {
  return inDisc(NORTH_GROVE, x, z) || inDisc(SOUTH_GROVE, x, z) || onWestArm(x, z);
}

function onGroveRim(x, z) {
  if (Math.hypot(x, z) < RIM_CLEAR_OF_SUMMIT) return false;
  for (const g of [NORTH_GROVE, SOUTH_GROVE]) {
    const d = Math.hypot(x - g.x, z - g.z);
    if (d > g.r && d <= g.r + GROVE_RIM) return true;
  }
  return false;
}

function inForest(x, z, h) { return inArc(x, z, FOREST_ARC) && h < PLATEAU; }

function inTransition(x, z, h) {
  return inArc(x, z, TRANSITION_ARC) && h >= TRANSITION_H[0] && h <= TRANSITION_H[1];
}

function onBaldShoulder(x, z, h) { return inArc(x, z, BALD_ARC) && h < PLATEAU && Math.hypot(x, z) > 34; }

function onEastFlank(x, z, h) { return inArc(x, z, EAST_ARC) && h < PLATEAU; }

/**
 * 0 = sheltered hollow low on the island, 1 = exposed knoll or ridge.
 * Compares a spot with the ground seven metres around it.
 */
function exposure(x, z, h) {
  const rim = 7;
  const around = (worldHeight(x + rim, z) + worldHeight(x - rim, z) + worldHeight(x, z + rim) + worldHeight(x, z - rim)) / 4;
  const hollow = clamp((around - h) / 3, -1, 1);
  const height = clamp01((h - 2) / 12);
  return clamp01(0.15 + height * 0.6 - hollow * 0.45);
}

// ---- densities ----

function treeDensity(x, z, h) {
  if (inDisc(NORTH_GROVE, x, z) || inDisc(SOUTH_GROVE, x, z)) return 1.0;
  if (onWestArm(x, z)) return 0.8;
  if (inDisc(EAST_CLUMP, x, z)) return 1.0;
  if (inDisc(DEAD_HILL, x, z)) return 0.9;
  if (onGroveRim(x, z)) return 0.35;
  if (h >= PLATEAU) return 0;
  if (inTransition(x, z, h)) return 0.5;
  if (inForest(x, z, h)) return 1.0;
  if (onBaldShoulder(x, z, h)) return 0.15;
  if (onEastFlank(x, z, h)) return 0.15;
  return 0.3;
}

function bushDensity(x, z, h, nearClearing) {
  if (nearClearing) return 0.2;
  if (inSummitMeadow(x, z, h) && Math.hypot(x, z) < 25) return 0.05;
  if (inPineZone(x, z)) return 0.45;
  if (inTransition(x, z, h) || inForest(x, z, h)) return 1.0;
  if (inDisc(EAST_CLUMP, x, z)) return 0.8;
  if (onBaldShoulder(x, z, h)) return 0.15;
  if (h >= PLATEAU) return 0.4;
  return 0.65;
}

/** Rocks pile up in the field and on the bald shoulder, thin in the woods, and gather on slopes everywhere. */
function rockDensity(x, z, h, nearClearing) {
  let d;
  if (inDisc(ROCK_FIELD, x, z)) d = 0.6 + discWeight(ROCK_FIELD, x, z) * 0.4;
  else if (inSummitMeadow(x, z, h) && Math.hypot(x, z) < 25) d = 0.05;
  else if (onBaldShoulder(x, z, h)) d = 0.55;
  else if (inDisc(EAST_PAIR, x, z)) d = 0.5;
  else if (inForest(x, z, h)) d = 0.08;
  else if (inPineZone(x, z)) d = 0.15;
  else d = 0.25;
  d *= 0.7 + 0.6 * worldSlope(x, z);
  return clamp01(nearClearing ? d * 0.25 : d);
}

/** Boulders: the field, the grove edges, the east pair, the bald shoulder and the boulder hall. */
function allowsBoulder(x, z, h) {
  if (inDisc(ROCK_FIELD, x, z) || inDisc(EAST_PAIR, x, z) || inDisc(BOULDER_HALL, x, z)) return true;
  if (onGroveRim(x, z)) return true;
  return onBaldShoulder(x, z, h) && h >= 4;
}

// ---- species, height, scale ----

function treeSpecies(x, z, h, rng) {
  if (inPineZone(x, z)) return 'pine';
  if (onGroveRim(x, z)) return h >= PLATEAU || rng() < 0.4 ? 'dead' : 'palm';
  if (inDisc(DEAD_HILL, x, z)) return rng() < 0.85 ? 'dead' : 'palm';
  if (onBaldShoulder(x, z, h) && h >= 5 && rng() < 0.2) return 'dead';
  return 'palm';
}

/** Palm height, metres: tall in hollows, squat on ridges; mid-height in the west transition band. */
function palmHeight(x, z, h, r01) {
  const byExposure = lerp(12.5, 4.5, exposure(x, z, h)) + (r01 - 0.5) * 2.5;
  return inTransition(x, z, h) ? clamp(byExposure, 6.5, 8.5) : byExposure;
}

function treeScale(x, z, h, base) {
  if (inPineZone(x, z)) return base * 1.2;
  return base * lerp(1.2, 0.85, exposure(x, z, h));
}

// ---- clearings ----

/**
 * Three clearings as polylines, each traced over the gentlest ground a grid
 * search could find. The ridge clearing rounds the east shoulder and climbs
 * the summit's east pocket, steep only at the very top; the bay clearing
 * leaves the summit along its south-west rim with the pine arm on its left,
 * crosses the one cliff band and drops to the driftwood bay; the cove
 * clearing follows the east shore round to the north cove.
 */
function clearings(anchors) {
  const hire = anchors?.hire ? [anchors.hire.x, anchors.hire.z] : [59.5, 28.4];
  const summit = [0, 0];
  return [
    [hire, [63, 7], [66, 4], [62, 0], [52, -2], [46, -7], [30, -8], [28, -10], [15, -10], summit],
    [summit, [-2, -1], [-7, 3], [-22, 7], [-32, 18], [-33, 22], [-30, 25], [-28, 37], [-21, 46], [-20, 54], [-22, 62]],
    [hire, [63, 7], [66, 4], [66, -16], [73, -23], [74, -29], [78, -33], [78, -49], [46, -78], [19, -78]],
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

// ---- landmarks ----

function landmarks() {
  return [
    // The summit: a standing stone on the ridge that shows over the palm line
    // from the start beach, three apex pines just left of the far-coast view,
    // and the outcrop of the four biggest boulders on the north shoulder.
    { id: 'summit-stone', builder: 'cliffChunk', opts: { width: 4.5, depth: 3, height: 10 }, x: -3, z: 8, rot: 0.9, yOffset: -0.8, collider: { hh: 4.6, r: 2.3 } },
    { id: 'apex-pine-a', builder: 'pineTree', opts: { height: 14, tiers: 5 }, x: -4, z: -15.5, rot: 0.4, collider: { hh: 6, r: 0.45 } },
    { id: 'apex-pine-b', builder: 'pineTree', opts: { height: 15, tiers: 5 }, x: -0.5, z: -14.5, rot: 2.6, collider: { hh: 6.5, r: 0.45 } },
    { id: 'apex-pine-c', builder: 'pineTree', opts: { height: 13, tiers: 4 }, x: 7, z: -18, rot: 4.1, collider: { hh: 5.5, r: 0.4 } },
    { id: 'north-outcrop', builder: 'rockCluster', opts: { size: 3.2, count: 4, spread: 4 }, x: -1.5, z: -21.5, rot: 1.7, collider: { hh: 2.2, r: 4.2 } },
    // The stone field's one really big rock; the scatter's boulders join it.
    { id: 'field-rock', builder: 'rock', opts: { size: 3.0, style: 'boulder' }, x: 21, z: -35, rot: 2.2, harvest: 'boulder', radius: 2.2, collider: { hh: 1.3, r: 1.8 } },
    // The bald far-coast flank: two cliff shelves, the boulder hall, the dead elder, the cove wreck.
    { id: 'shelf-west', builder: 'cliffChunk', opts: { width: 6, height: 6.5 }, x: -27, z: -70, rot: 1.1, yOffset: -0.8, collider: { hh: 3.0, r: 2.8 } },
    { id: 'shelf-north', builder: 'cliffChunk', opts: { width: 5.5, height: 5.5 }, x: 16, z: -56, rot: 4.4, yOffset: -0.8, collider: { hh: 2.6, r: 2.5 } },
    { id: 'boulder-hall', builder: 'rockCluster', opts: { size: 3, count: 6, spread: 5 }, x: -52, z: -22, rot: 1.4, scale: 1.3, collider: { hh: 2.5, r: 5 } },
    { id: 'dead-elder', builder: 'deadTree', opts: { height: 9 }, x: -57, z: 18, rot: 0.2, scale: 1.6, collider: { hh: 6, r: 0.6 } },
    { id: 'cove-wreck', builder: 'wreckedBoat', opts: { length: 6.5, beam: 2.1 }, x: -90, z: -46, rot: 2.6, collider: { hh: 1.9, r: 3 } },
    // Driftwood along the south-west bay: wood for anyone without an axe.
    { id: 'bay-drift-a', builder: 'driftwood', opts: { length: 3.6 }, x: -56, z: 56, rot: 1.9, scale: 1.2, harvest: 'driftwood', radius: 1.8 },
    { id: 'bay-drift-b', builder: 'driftwood', opts: { length: 2.8 }, x: -47, z: 62, rot: 0.4, harvest: 'driftwood', radius: 1.4 },
    { id: 'bay-drift-c', builder: 'driftwood', opts: { length: 3.2 }, x: -38, z: 66, rot: 2.8, harvest: 'driftwood', radius: 1.6 },
    { id: 'bay-drift-d', builder: 'driftwood', opts: { length: 3.0 }, x: -28, z: 69, rot: 1.2, scale: 1.1, harvest: 'driftwood', radius: 1.5 },
    { id: 'bay-drift-e', builder: 'driftwood', opts: { length: 2.6 }, x: -16, z: 71, rot: 2.1, harvest: 'driftwood', radius: 1.3 },
  ];
}

function farFromStart(anchors, lm) {
  return ['spawn', 'shop', 'sell', 'campfire', 'wreck', 'hire', 'dockStart', 'shore']
    .map((k) => anchors?.[k]).filter(Boolean)
    .every((p) => Math.hypot(lm.x - p.x, lm.z - p.z) >= START_KEEP);
}

/** Clear space to keep round each landmark for a kind of scatter. */
function landmarkKeepOut(lms, kind, x, z) {
  for (const lm of lms) {
    const own = Math.max(lm.radius ?? 0, lm.collider?.r ?? 0);
    if (Math.hypot(x - lm.x, z - lm.z) < own + LANDMARK_KEEP_OUT[kind]) return false;
  }
  return true;
}

export function plan(def, anchors) {
  const paths = clearings(anchors);
  const lms = landmarks().filter((lm) => farFromStart(anchors, lm));
  const clearingDistance = (x, z) => distanceToClearing(paths, x, z);

  return {
    counts: { trees: 110, bushes: 220, rocks: 140, boulders: 10 },
    // maxH raised past the framework default so pines can reach the summit ridge;
    // spacing and slope loosened a little so the groves pack on the broken ground up there.
    trees: { minH: 2.0, maxH: 40, maxSlope: 0.58, minSpacing: 5.2 },
    rocks: { minSpacing: 2.8 },

    allow(kind, x, z, h) {
      if (kind === 'tree' && Math.hypot(x, z) < SUMMIT_CLEAR) return false;
      if (kind === 'boulder' && !allowsBoulder(x, z, h)) return false;
      if (cutsSummitView(x, z, h, TOP[kind])) return false;
      return clearingDistance(x, z) >= CLEARING[kind] && landmarkKeepOut(lms, kind, x, z);
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
    treeScale,
    landmarks: lms,
  };
}
