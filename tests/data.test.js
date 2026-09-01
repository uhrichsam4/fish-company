/**
 * Cross-module referential integrity for the static data tables.
 *
 * The failure mode these guard against is specific to how this game boots:
 * almost nothing throws on a bad id. A submarine whose unlockRegion no longer
 * exists is simply never purchasable, an event whose region was renamed never
 * fires, a research prerequisite that was retired locks its node forever. The
 * game runs, the feature is just quietly gone -- which is exactly the kind of
 * thing that survives a play session and reaches a commit.
 *
 * Each table validates itself in isolation; nothing checked the references
 * *between* them until this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FISH_SPECIES, validateFishData } from '../src/data/fishData.js';
import { REGIONS, REGION_BY_ID } from '../src/data/regions.js';
import { WORLD_EVENTS } from '../src/data/events.js';
import { SUBMARINES, SUB_UPGRADES, subUpgradeCost } from '../src/data/submarines.js';
import { RESEARCH_NODES, RESEARCH_BY_ID } from '../src/data/research.js';

const regionIds = new Set(REGIONS.map((r) => r.id));
const researchIds = new Set(RESEARCH_NODES.map((n) => n.id));

test('fish data passes its own structural validator', () => {
  const problems = validateFishData();
  assert.deepEqual(problems, [], `fishData validator:\n  ${problems.join('\n  ')}`);
});

test('the fish validator is actually exercising the table', () => {
  // Guards the guard: if FISH_SPECIES ever imports as empty, validateFishData
  // returns [] and the test above passes while checking nothing at all.
  assert.ok(FISH_SPECIES.length > 50, `only ${FISH_SPECIES.length} species loaded`);
});

test('every fish region is a real region', () => {
  const bad = [];
  for (const s of FISH_SPECIES) {
    for (const r of s.regions || []) if (!regionIds.has(r)) bad.push(`${s.id} -> "${r}"`);
  }
  assert.deepEqual(bad, [], `unknown regions:\n  ${bad.join('\n  ')}`);
});

test('every submarine unlock gate resolves', () => {
  const bad = [];
  for (const d of SUBMARINES) {
    if (d.unlockRegion && !regionIds.has(d.unlockRegion)) {
      bad.push(`${d.id}: unlockRegion "${d.unlockRegion}" is not a region`);
    }
    if (d.requiresResearch && !researchIds.has(d.requiresResearch)) {
      bad.push(`${d.id}: requiresResearch "${d.requiresResearch}" is not a research node`);
    }
  }
  // A bad gate here is unrecoverable in-game: isUnlocked() returns false
  // forever and the sub can never be bought.
  assert.deepEqual(bad, [], `unreachable submarines:\n  ${bad.join('\n  ')}`);
});

test('submarine upgrade costs are positive and non-decreasing', () => {
  const bad = [];
  for (const u of SUB_UPGRADES) {
    let prev = -Infinity;
    for (let lvl = 0; lvl < (u.maxLevel ?? 3); lvl++) {
      const cost = subUpgradeCost(u.id, lvl);
      if (!(cost > 0)) bad.push(`${u.id} L${lvl}: cost ${cost} is not > 0`);
      else if (cost < prev) bad.push(`${u.id} L${lvl}: cost ${cost} dropped below L${lvl - 1} (${prev})`);
      prev = cost;
    }
  }
  assert.deepEqual(bad, [], `upgrade cost curve:\n  ${bad.join('\n  ')}`);
});

test('every world event region restriction resolves', () => {
  // The contract is candidateRegions() in data/events.js: `anywhere` means
  // regionless, a function is resolved at runtime against live game state, an
  // array is filtered against unlocked regions, and an absent field falls
  // through to "any unlocked region". Only an array can be statically wrong.
  const bad = [];
  for (const e of WORLD_EVENTS) {
    if (!Array.isArray(e.regions)) continue;
    if (!e.regions.length) bad.push(`${e.id}: regions is [] so candidateRegions can never place it`);
    for (const r of e.regions) if (!regionIds.has(r)) bad.push(`${e.id} -> "${r}"`);
  }
  assert.deepEqual(bad, [], `unknown event regions:\n  ${bad.join('\n  ')}`);
});

test('world events are well formed', () => {
  const bad = [];
  const seen = new Set();
  for (const e of WORLD_EVENTS) {
    if (seen.has(e.id)) bad.push(`duplicate event id "${e.id}"`);
    seen.add(e.id);
    if (!e.name) bad.push(`${e.id}: no name`);
    if (typeof e.apply !== 'function') bad.push(`${e.id}: apply is not a function`);
    if (e.regions != null && !Array.isArray(e.regions) && typeof e.regions !== 'function') {
      bad.push(`${e.id}: regions must be an array or a function`);
    }
    if (e.duration != null && !(e.duration > 0)) bad.push(`${e.id}: duration ${e.duration} is not > 0`);
  }
  assert.deepEqual(bad, [], `malformed events:\n  ${bad.join('\n  ')}`);
});

test('research prerequisites resolve and are acyclic', () => {
  const bad = [];
  for (const n of RESEARCH_NODES) {
    for (const r of n.requires || []) {
      if (!researchIds.has(r)) bad.push(`${n.id}: requires unknown node "${r}"`);
    }
  }
  assert.deepEqual(bad, [], `dangling prerequisites:\n  ${bad.join('\n  ')}`);

  // A cycle makes every node in it permanently unbuyable.
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      bad.push(`cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'open');
    for (const r of RESEARCH_BY_ID[id]?.requires || []) walk(r, [...trail, id]);
    state.set(id, 'done');
  };
  for (const n of RESEARCH_NODES) walk(n.id, []);
  assert.deepEqual(bad, [], `research graph:\n  ${bad.join('\n  ')}`);
});

test('region ids are unique and REGION_BY_ID agrees with REGIONS', () => {
  const seen = new Set();
  const bad = [];
  for (const r of REGIONS) {
    if (seen.has(r.id)) bad.push(`duplicate region id "${r.id}"`);
    seen.add(r.id);
    if (REGION_BY_ID[r.id] !== r) bad.push(`REGION_BY_ID["${r.id}"] does not point at its REGIONS entry`);
  }
  assert.deepEqual(bad, [], `regions:\n  ${bad.join('\n  ')}`);
});
