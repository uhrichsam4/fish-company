/**
 * Layout plans: how an island's decoration is steered.
 *
 * World.decorate() does all the placing; a plan only answers questions about
 * it -- may a tree go here, how dense should rocks be here, which species,
 * what landmarks exist. Keeping the plan as data-plus-small-functions means a
 * whole island can be re-laid without touching the placement code, and two
 * plans for the same island can be compared in the running game by swapping
 * one import.
 *
 * Plan shape (every field optional except allow):
 *   allow(kind, x, z, h) -> bool         kind: 'tree' | 'bush' | 'rock' | 'boulder'
 *   density(kind, x, z, h) -> 0..1       thins a kind by chance
 *   counts: { trees, bushes, rocks, boulders }
 *   trees: { minH, maxH, maxSlope, minSpacing }
 *   rocks: { minSpacing }
 *   treeSpecies(x, z, h, rng) -> 'palm' | 'pine' | 'dead'
 *   treeHeight(x, z, h, r01) -> metres
 *   treeScale(x, z, h, base) -> scale
 *   landmarks: [{ id, builder, opts, x, z, rot, scale, yOffset, harvest, radius, collider:{hh,r}, dynamic }]
 *
 * The start area is protected by default: everything the player meets in
 * the first minute -- spawn, shop, sell station, dock, campfire, wreck, hire
 * post and the shoreline between them -- is excluded unless a plan says
 * otherwise with `startKeep` (metres; 0 hands the plan the whole island).
 * The classic island stays selectable, so a plan that reshapes the start is
 * an alternative, never a replacement.
 */

import { ACTIVE_PLAN } from './plans/active.js';

/** Default radius around the start-area anchors that a plan may not touch. */
const START_KEEP = 56;

function startAreaExcluder(anchors, keep) {
  const pts = ['spawn', 'shop', 'sell', 'campfire', 'wreck', 'hire', 'dockStart', 'shore']
    .map((k) => anchors?.[k]).filter(Boolean);
  if (!pts.length || keep <= 0) return () => false;
  return (x, z) => {
    for (const p of pts) if (Math.hypot(x - p.x, z - p.z) < keep) return true;
    return false;
  };
}

/** @returns {object|null} the plan for a region, with the start area excluded. */
export function planFor(def, anchors) {
  if (def.id !== 'crash') return null;
  const base = ACTIVE_PLAN(def, anchors);
  if (!base) return null;
  const inStart = startAreaExcluder(anchors, base.startKeep ?? START_KEEP);
  return {
    ...base,
    inStart,
    allow: (kind, x, z, h) => (base.allow ? base.allow(kind, x, z, h) : true),
  };
}
