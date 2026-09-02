/**
 * Variant 2: resources paced by distance from the start.
 *
 * The island is read as three bands measured from the protected start area,
 * with altitude counting as distance: the near band (just past the start
 * area) is thin and easy -- driftwood and a crate or two washed up along the
 * east beach, a few young palms and pebbles; the mid band carries the proper
 * palm groves and a scree field where the rocks pile up; the far side and
 * the high ground hold the wealth -- the framework's boulder clusters are
 * allowed only there, the palms are old and tall, dead trees stand on the
 * far-west hill for extra wood, and a pine crown rings the summit.
 *
 * Landmarks are the signposts of that walk, spaced so each one can be seen
 * from at least one other: signpost at the trailhead, wreck trail on the
 * east beach, leaning giant palm, cairn, standing stones, hermit camp, crown
 * rock on the summit, boulder hall, the dead elder, and a wrecked boat in a
 * cove on the far north-west shore.
 */
import { worldSlope } from '../Terrain.js';

/** Radius the framework keeps for the start area; the plan is first consulted just outside it. */
const START_EDGE = 34;
/** Metres past the start edge at which distance pacing saturates (roughly the far shore). */
const FAR_REACH = 110;
/** Altitude band over which height alone counts as "far". */
const HIGH_START = 12, HIGH_FULL = 26;
/** Above this height the crown is pine, not palm. */
const PINE_LINE = 28;

/** Mid-island palm groves: the second band's main feature. */
const GROVES = [
  { x: 18, z: 34, r: 16 },
  { x: 58, z: -40, r: 16 },
  { x: -30, z: 30, r: 18 },
];
/** Scree field on the mid-east shoulder: the place to fill a bag with stone. */
const ROCK_FIELD = { x: 50, z: -22, r: 24 };
/** Far-west hill where the palms have died standing. */
const DEAD_HILL = { x: -58, z: 16, r: 20 };

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

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
  const d = Math.hypot(x - disc.x, z - disc.z) / disc.r;
  return clamp01((1 - d) * 3);
}

function groveWeight(x, z) {
  let w = 0;
  for (const g of GROVES) w = Math.max(w, discWeight(g, x, z));
  return w;
}

function treeDensity(t, x, z, h) {
  if (h > PINE_LINE || onDeadHill(x, z)) return 1;
  return clamp01(lerp(0.2, 0.85, t) + groveWeight(x, z) * 0.6);
}

function bushDensity(x, z, h) {
  if (h > PINE_LINE) return 0.3;
  return 0.45 + groveWeight(x, z) * 0.55;
}

/** Rocks thin near the start, pile up in the scree field, and gather on slopes everywhere. */
function rockDensity(t, x, z) {
  const base = lerp(0.15, 0.8, t) + discWeight(ROCK_FIELD, x, z) * 0.8;
  return clamp01(base * (0.7 + 0.6 * worldSlope(x, z)));
}

function boulderAllowed(t) { return t >= 0.6; }

function onDeadHill(x, z) { return discWeight(DEAD_HILL, x, z) > 0; }

function treeSpecies(t, x, z, h, rng) {
  if (h > PINE_LINE - rng() * 3) return 'pine';
  if (onDeadHill(x, z)) return rng() < 0.85 ? 'dead' : 'palm';
  if (t > 0.6 && rng() < 0.1) return 'dead';
  return 'palm';
}

/** Young palms near the start, old ones out far. */
function treeHeight(t, r01) { return lerp(lerp(3.8, 5.5, r01), lerp(8.5, 12.5, r01), t); }

function treeScale(t, base) { return base * lerp(0.85, 1.15, t); }

const CENTRE_BEARING = (x, z) => Math.atan2(-z, -x);

function landmarks() {
  return [
    // ---- near band: the way out of camp ----
    { id: 'trailhead', builder: 'signpost', opts: { arrows: 2, height: 2.4 }, x: 12, z: 50, rot: CENTRE_BEARING(12, 50), collider: { hh: 1.2, r: 0.25 } },
    { id: 'trail-driftwood', builder: 'driftwood', opts: { length: 3.4 }, x: 84, z: -12, rot: 1.1, scale: 1.3, harvest: 'driftwood', radius: 1.7 },
    { id: 'trail-crate', builder: 'crate', opts: { size: 0.8 }, x: 75, z: -16, rot: 0.4, harvest: 'crate', radius: 0.9 },
    // ---- mid band: groves and scree ----
    { id: 'leaning-giant', builder: 'palmTree', opts: { height: 14, lean: 0.28 }, x: 26, z: 2, rot: 2.3, scale: 1.4, collider: { hh: 3, r: 0.5 } },
    { id: 'cairn', builder: 'rockCluster', opts: { size: 2.0, count: 5, spread: 3 }, x: 58, z: -16, rot: 0.7, scale: 1.2, collider: { hh: 1.35, r: 3.2 } },
    { id: 'stone-north', builder: 'rock', opts: { size: 2.6, style: 'pillar' }, x: 31, z: -40, rot: 0.3, collider: { hh: 2.8, r: 1.0 } },
    { id: 'stone-south', builder: 'rock', opts: { size: 2.6, style: 'pillar' }, x: 37, z: -36, rot: 2.1, collider: { hh: 2.8, r: 1.0 } },
    { id: 'hermit-tent', builder: 'tent', opts: {}, x: -23, z: 43, rot: 0.9, collider: { hh: 0.9, r: 1.5 } },
    { id: 'hermit-barrel', builder: 'barrel', opts: {}, x: -22, z: 46, rot: 0, harvest: 'barrel', radius: 0.8 },
    // ---- far band and high ground: the wealth ----
    { id: 'crown-rock', builder: 'cliffChunk', opts: { width: 6, depth: 4, height: 5.5 }, x: -7, z: -7, rot: 0.5, collider: { hh: 3.4, r: 3.5 } },
    { id: 'boulder-hall', builder: 'rockCluster', opts: { size: 3, count: 6, spread: 5 }, x: -52, z: -22, rot: 1.4, scale: 1.3, collider: { hh: 2.5, r: 5 } },
    { id: 'dead-elder', builder: 'deadTree', opts: { height: 9 }, x: -57, z: 18, rot: 0.2, scale: 1.6, collider: { hh: 6, r: 0.6 } },
    { id: 'cove-wreck', builder: 'wreckedBoat', opts: { length: 6.5, beam: 2.1 }, x: -90, z: -46, rot: 2.6, collider: { hh: 1.9, r: 3 } },
    { id: 'cove-barrel', builder: 'barrel', opts: {}, x: -88, z: -47, rot: 0.6, harvest: 'barrel', radius: 0.8 },
  ];
}

/** Keeps the scatter off the landmarks; trees get a wider berth so the giants stand alone. */
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
    allow: (kind, x, z, h) => clearOfLandmarks(kind, x, z) && (kind !== 'boulder' || boulderAllowed(progress(x, z, h))),
    density: (kind, x, z, h) => {
      if (kind === 'tree') return treeDensity(progress(x, z, h), x, z, h);
      if (kind === 'bush') return bushDensity(x, z, h);
      if (kind === 'rock') return rockDensity(progress(x, z, h), x, z);
      return 1;
    },
    counts: { trees: 104, bushes: 200, rocks: 132, boulders: 10 },
    trees: { minH: 2, maxH: 40, maxSlope: 0.5, minSpacing: 6 },
    rocks: { minSpacing: 2.8 },
    treeSpecies: (x, z, h, rng) => treeSpecies(progress(x, z, h), x, z, h, rng),
    treeHeight: (x, z, h, r01) => treeHeight(progress(x, z, h), r01),
    treeScale: (x, z, h, base) => treeScale(progress(x, z, h), base),
    landmarks: list,
  };
}
