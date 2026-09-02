/**
 * Variant 4: variant 2's pacing, with the summit and the flanks re-composed.
 *
 * The pacing idea is unchanged: everything gets richer the further you walk
 * from the start beach and the higher you climb -- young palms and pebbles
 * near camp, old tall palms and dead wood on the far-west hill, boulders only
 * on the high ground and the far side. What changes is how the high ground is
 * arranged, following the critic panel's fix list:
 *
 *  - The single pine blob on top is now two groves. The summit grove is two
 *    arms of pines running off the peak, one down the north ridge and one
 *    along the west ridge; a second grove sits on the south slope bench,
 *    ~20 m of open grass below the first. Nothing but three apex pines
 *    grows within 15 m of the true summit, the far-coast sightline from the
 *    summit viewpoint is kept as a tree-free cone, and the flank facing the
 *    start beach is bare grass, so the peak reads from the sea and the far
 *    coast reads from the peak. (The west arm hugs the south side of the
 *    west ridge because due west of the summit is exactly that sightline.)
 *  - Boulders: the four largest are stacked as one outcrop on the summit's
 *    far-coast shoulder, the rest may only stand at grove edges. The old
 *    crown rock in front of the summit viewpoint is gone.
 *  - Stone is one destination: a rock field on the bare north-east shoulder
 *    between the north arm and the north palms, with a cluster of 3 m rocks
 *    at its heart.
 *  - The flanks differ. The far-coast (north) arc has ~30% of its palms, lots
 *    of low bush and two rock shelves; the east flank has one tight palm
 *    clump and a pair of boulders. Thick palms mean the start side, bare rock
 *    means the far side.
 *  - Dead trees and two fallen logs mark the grove edges on the mid-slope;
 *    five driftwood logs line the south-west beach as axe-free wood; an 8 m
 *    standing stone on the summit's east shoulder is the one navigation mark
 *    that shows above the palms from the start beach.
 *  - Below the west-ridge pines, between them and the west palm ring, lies
 *    a 16 m band of bush with a few mid-height palms.
 *
 * Every landmark sits outside the 56 m start keep, which the framework holds
 * byte-identical anyway. The landmark budget (16) did not stretch to variant
 * 2's hermit camp, twin pillar stones, boulder hall, dead elder and cove
 * wreck; the dead hill's dead trees still come from the species rule.
 */
import { worldSlope } from '../Terrain.js';

/** Radius the framework keeps for the start area; the plan is first consulted just outside it. */
const START_EDGE = 34;
/** Metres past the start edge at which distance pacing saturates (roughly the far shore). */
const FAR_REACH = 110;
/** Altitude band over which height alone counts as "far". */
const HIGH_START = 12, HIGH_FULL = 26;

/** The true high point (33.5 m); the framework's summit viewpoint at (0,0) is 14 m east of it. */
const SUMMIT = { x: -7, z: -12.5 };
/** No scattered tree within this radius of the summit. */
const SUMMIT_CLEARING = 15;
/** The far-coast sightline from the summit viewpoint: a cone kept free of trees and boulders. */
const VISTA = { x: 0, z: 0, bearing: 0.6 + Math.PI, halfAngle: 0.36, reach: 46 };

/** Summit grove: two arms of pines, as capsules (segment plus radius), and the south-slope grove disc. */
const NORTH_ARM = { ax: -7, az: -25, bx: -10, bz: -42, r: 6 };
const WEST_ARM = { ax: -28, az: -4, bx: -40, bz: -5, r: 6 };
const SOUTH_GROVE = { x: -29, z: 32, r: 10 };
/** Open grass between the summit grove and the south grove: the bench below the peak and the grass face under it. */
const MEADOW = { ax: -12, az: 4, bx: -26, bz: 20, r: 10 };
/** Bare shoulder where the stone is: north-east of the summit, between the north arm and the north palms. */
const ROCK_FIELD = { x: 16, z: -34, r: 14 };
/** The east flank's one tight palm clump. */
const EAST_CLUMP = { x: 54, z: -38, r: 9 };
/** Mid-band palm grove on the south-west slope, below the south grove. */
const SW_GROVE = { x: -44, z: 46, r: 12 };
/** Far-west hill where the palms have died standing. */
const DEAD_HILL = { x: -58, z: 16, r: 20 };

/** Grove-edge band width (m outside a pine shape) where dead trees and boulders belong. */
const GROVE_EDGE = 8;
/** Below the west arm the band is wider and is bush with mid-height palms instead. */
const TRANSITION_REACH = 16;
/** Bearing arc from the island centre (atan2(z, x)) of the far-coast palms, and the height they stop at. */
const NORTH_ARC = { from: -2.35, to: -0.85, maxH: 24 };
/** Bearing wedge from the summit toward the start beach that stays bare grass above this height. */
const OPEN_FLANK = { from: -0.3, to: 1.25, minH: 12 };

/**
 * The scatter places a fixed number of each kind, so a density only sets a
 * zone's share of that number. Palms and rocks outside their feature zones
 * are scaled down by these so the pine groves, the east clump and the rock
 * field fill to their spacing before the rest of the island takes the count;
 * the pacing pattern among the palms is unchanged, only its share.
 */
const PALM_SHARE = 0.18;
const LOOSE_ROCK_SHARE = 0.35;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, x, z) => Math.hypot(x - a.x, z - a.z);
const inDisc = (d, x, z) => dist(d, x, z) < d.r;

function startPoints(anchors) {
  return ['spawn', 'shop', 'sell', 'campfire', 'wreck', 'hire', 'dockStart', 'shore']
    .map((k) => anchors?.[k]).filter(Boolean);
}

function distanceFromStart(pts, x, z) {
  let d = Infinity;
  for (const p of pts) d = Math.min(d, Math.hypot(x - p.x, z - p.z));
  return d;
}

/** 0 at the edge of the start area, 1 at the far shore or up on the summit. */
function progressFrom(pts) {
  return (x, z, h) => {
    const byDistance = clamp01((distanceFromStart(pts, x, z) - START_EDGE) / FAR_REACH);
    const byHeight = clamp01((h - HIGH_START) / (HIGH_FULL - HIGH_START));
    return Math.max(byDistance, byHeight);
  };
}

/** 1 at a disc's centre, fading to 0 over its outer third. */
function discWeight(disc, x, z) {
  const d = dist(disc, x, z) / disc.r;
  return clamp01((1 - d) * 3);
}

/** Distance from a point to a capsule's surface; 0 inside. */
function capsuleDistance(c, x, z) {
  const dx = c.bx - c.ax, dz = c.bz - c.az;
  const t = clamp01(((x - c.ax) * dx + (z - c.az) * dz) / (dx * dx + dz * dz));
  return Math.max(0, Math.hypot(x - (c.ax + dx * t), z - (c.az + dz * t)) - c.r);
}

/** Distance to the nearest pine grove; 0 inside one. */
function pineDistance(x, z) {
  return Math.min(
    capsuleDistance(NORTH_ARM, x, z),
    capsuleDistance(WEST_ARM, x, z),
    Math.max(0, dist(SOUTH_GROVE, x, z) - SOUTH_GROVE.r),
  );
}

function inBearingArc(arc, cx, cz, x, z) {
  const b = Math.atan2(z - cz, x - cx);
  return b >= arc.from && b <= arc.to;
}

function inVista(x, z) {
  const d = dist(VISTA, x, z);
  if (d > VISTA.reach) return false;
  const off = Math.atan2(z - VISTA.z, x - VISTA.x) - VISTA.bearing;
  return Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) < VISTA.halfAngle;
}

/**
 * Which part of the composition a point belongs to. Checked in priority
 * order, so the summit clearing and the vista beat the arms where they
 * touch them, the rock field beats the north arm's edge band, and so on.
 */
function zoneAt(x, z, h) {
  if (dist(SUMMIT, x, z) < SUMMIT_CLEARING) return 'summit';
  if (inVista(x, z)) return 'vista';
  const dPine = pineDistance(x, z);
  if (dPine === 0) return 'pines';
  if (inDisc(ROCK_FIELD, x, z)) return 'rockField';
  if (capsuleDistance(MEADOW, x, z) === 0) return 'meadow';
  if (capsuleDistance(WEST_ARM, x, z) < TRANSITION_REACH) return 'transition';
  if (dPine < GROVE_EDGE) return 'groveEdge';
  if (inDisc(EAST_CLUMP, x, z)) return 'eastClump';
  if (h > OPEN_FLANK.minH && inBearingArc(OPEN_FLANK, SUMMIT.x, SUMMIT.z, x, z)) return 'openFlank';
  if (h < NORTH_ARC.maxH && inBearingArc(NORTH_ARC, 0, 0, x, z)) return 'northArc';
  if (inDisc(DEAD_HILL, x, z)) return 'deadHill';
  return 'open';
}

/** Palms thicken with distance from the start; the pacing rule of variant 2. */
function pacedPalms(t) { return lerp(0.2, 0.85, t); }

function treeDensity(zone, t, x, z) {
  switch (zone) {
    case 'pines': case 'eastClump': return 1;
    case 'deadHill': return PALM_SHARE * 0.7;
    case 'groveEdge': return PALM_SHARE * 0.3;
    case 'transition': return PALM_SHARE * 0.08;
    case 'northArc': return PALM_SHARE * pacedPalms(t) * 0.3;
    case 'open': return PALM_SHARE * clamp01(pacedPalms(t) + discWeight(SW_GROVE, x, z) * 0.6);
    default: return 0;
  }
}

function bushDensity(zone, x, z) {
  switch (zone) {
    case 'transition': return 1;
    case 'northArc': return 0.8;
    case 'groveEdge': return 0.7;
    case 'eastClump': return 0.6;
    case 'pines': return 0.5;
    case 'deadHill': return 0.45;
    case 'openFlank': case 'vista': return 0.35;
    case 'summit': return 0.2;
    case 'rockField': case 'meadow': return 0.15;
    default: return 0.45 + discWeight(SW_GROVE, x, z) * 0.55;
  }
}

/** Rocks thin near the start, gather on slopes, and pile up in the one rock field. */
function rockDensity(zone, t, x, z) {
  if (zone === 'rockField') return 1;
  const paced = clamp01(lerp(0.15, 0.8, t) * (0.7 + 0.6 * worldSlope(x, z)));
  switch (zone) {
    case 'northArc': return LOOSE_ROCK_SHARE * clamp01(paced + 0.25);
    case 'groveEdge': return LOOSE_ROCK_SHARE * 0.35;
    case 'transition': case 'eastClump': return LOOSE_ROCK_SHARE * 0.3;
    case 'openFlank': return LOOSE_ROCK_SHARE * 0.25;
    case 'summit': case 'pines': case 'vista': return LOOSE_ROCK_SHARE * 0.15;
    case 'meadow': return LOOSE_ROCK_SHARE * 0.1;
    default: return LOOSE_ROCK_SHARE * paced;
  }
}

/** Boulders keep to the far/high band, and within it to the rock field and the grove edges. */
function boulderAllowed(zone, t) {
  return t >= 0.6 && (zone === 'rockField' || zone === 'groveEdge' || zone === 'transition');
}

function treeSpecies(zone, t, rng) {
  if (zone === 'pines') return 'pine';
  if (zone === 'deadHill') return rng() < 0.85 ? 'dead' : 'palm';
  if (zone === 'groveEdge') return rng() < 0.7 ? 'dead' : 'palm';
  if (zone === 'open' && t > 0.6 && rng() < 0.1) return 'dead';
  return 'palm';
}

/** Young palms near the start, old ones out far; mid-height in the transition band. */
function treeHeight(zone, t, r01) {
  if (zone === 'transition') return lerp(6, 7.5, r01);
  return lerp(lerp(3.8, 5.5, r01), lerp(8.5, 12.5, r01), t);
}

function treeScale(t, base) { return base * lerp(0.85, 1.15, t); }

function landmarks() {
  return [
    // ---- the summit: three apex pines and the outcrop on its far-coast shoulder ----
    { id: 'apex-a', builder: 'pineTree', opts: { height: 14 }, x: -4, z: -15.5, rot: 0.4, scale: 1.15, collider: { hh: 7, r: 0.55 } },
    { id: 'apex-b', builder: 'pineTree', opts: { height: 15 }, x: -9.5, z: -16.5, rot: 2.1, scale: 1.15, collider: { hh: 7.5, r: 0.55 } },
    { id: 'apex-c', builder: 'pineTree', opts: { height: 13 }, x: -3, z: -20, rot: 4.0, scale: 1.15, collider: { hh: 6.5, r: 0.55 } },
    { id: 'summit-outcrop', builder: 'rockCluster', opts: { size: 3.6, count: 4, spread: 2.6 }, x: -12, z: -20.5, rot: 0.8, collider: { hh: 1.8, r: 3.4 } },
    // ---- the one navigation mark: a standing stone on the east shoulder, bare grass all round ----
    { id: 'standing-stone', builder: 'rock', opts: { size: 3.8, style: 'pillar' }, x: 9, z: -13, rot: 1.3, collider: { hh: 4, r: 1.6 } },
    // ---- the rock field's heart ----
    { id: 'field-giants', builder: 'rockCluster', opts: { size: 3.2, count: 3, spread: 4.5 }, x: 16, z: -34, rot: 2.4, scale: 1.05, harvest: 'boulder', radius: 4.2, collider: { hh: 1.6, r: 4 } },
    // ---- flanks: rock shelves on the bare north arc, a boulder pair by the east clump ----
    { id: 'north-shelf-a', builder: 'rock', opts: { size: 3.2, style: 'flat' }, x: 6, z: -62, rot: 0.4, harvest: 'rock', radius: 2.2, collider: { hh: 0.55, r: 2 } },
    { id: 'north-shelf-b', builder: 'rock', opts: { size: 3.2, style: 'flat' }, x: -14, z: -60, rot: 2.0, harvest: 'rock', radius: 2.2, collider: { hh: 0.55, r: 2 } },
    { id: 'east-pair', builder: 'rockCluster', opts: { size: 2.8, count: 2, spread: 2.2 }, x: 44, z: -46, rot: 1.7, harvest: 'boulder', radius: 2.6, collider: { hh: 1.4, r: 2.4 } },
    // ---- fallen logs at the grove edges on the mid-slope ----
    { id: 'log-south', builder: 'driftwood', opts: { length: 4.4 }, x: -18, z: 42, rot: 2.6, scale: 1.2, harvest: 'driftwood', radius: 2.2 },
    { id: 'log-north', builder: 'driftwood', opts: { length: 4.0 }, x: -4, z: -50, rot: 0.9, scale: 1.2, harvest: 'driftwood', radius: 2.1 },
    // ---- south-west beach: wood without an axe ----
    { id: 'sw-drift-a', builder: 'driftwood', opts: { length: 3.6 }, x: -50, z: 55, rot: 0.5, scale: 1.2, harvest: 'driftwood', radius: 1.8 },
    { id: 'sw-drift-b', builder: 'driftwood', opts: { length: 3.0 }, x: -42, z: 59, rot: 2.2, scale: 1.2, harvest: 'driftwood', radius: 1.6 },
    { id: 'sw-drift-c', builder: 'driftwood', opts: { length: 3.8 }, x: -33, z: 62, rot: 1.1, scale: 1.2, harvest: 'driftwood', radius: 1.9 },
    { id: 'sw-drift-d', builder: 'driftwood', opts: { length: 3.2 }, x: -24, z: 65, rot: 2.9, scale: 1.2, harvest: 'driftwood', radius: 1.7 },
    { id: 'sw-drift-e', builder: 'driftwood', opts: { length: 3.4 }, x: -15, z: 67, rot: 0.2, scale: 1.2, harvest: 'driftwood', radius: 1.8 },
  ];
}

/** Keeps the scatter off the landmarks; trees get a wider berth so the marks stand alone. */
function landmarkClearance(list) {
  const spots = list.map((lm) => ({ x: lm.x, z: lm.z, r: Math.max(lm.radius ?? 0, lm.collider?.r ?? 0) }));
  return (kind, x, z) => {
    const margin = kind === 'tree' ? 5 : 2;
    for (const s of spots) if (Math.hypot(x - s.x, z - s.z) < s.r + margin) return false;
    return true;
  };
}

export function plan(def, anchors) {
  const progress = progressFrom(startPoints(anchors));
  const list = landmarks();
  const clearOfLandmarks = landmarkClearance(list);
  return {
    allow: (kind, x, z, h) => clearOfLandmarks(kind, x, z)
      && (kind !== 'boulder' || boulderAllowed(zoneAt(x, z, h), progress(x, z, h))),
    density: (kind, x, z, h) => {
      const zone = zoneAt(x, z, h);
      if (kind === 'tree') return treeDensity(zone, progress(x, z, h), x, z);
      if (kind === 'bush') return bushDensity(zone, x, z);
      if (kind === 'rock') return rockDensity(zone, progress(x, z, h), x, z);
      return 1;
    },
    counts: { trees: 110, bushes: 216, rocks: 138, boulders: 6 },
    trees: { minH: 2, maxH: 40, maxSlope: 0.64, minSpacing: 6 },
    rocks: { minSpacing: 2.8 },
    treeSpecies: (x, z, h, rng) => treeSpecies(zoneAt(x, z, h), progress(x, z, h), rng),
    treeHeight: (x, z, h, r01) => treeHeight(zoneAt(x, z, h), progress(x, z, h), r01),
    treeScale: (x, z, h, base) => treeScale(progress(x, z, h), base),
    landmarks: list,
  };
}
