/**
 * Referential integrity across the progression tables: quests, NPCs, harbor
 * buildings and the starting loadout.
 *
 * Same failure mode as tests/data.test.js -- a stale id does not throw, it
 * just makes something permanently unreachable. An objective naming a species
 * that no longer exists can never be satisfied, so the quest chain behind it
 * stops dead; a harbor building whose prerequisite was renamed can never be
 * built. Both look like a working game right up until someone plays that far.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FISH_SPECIES, RARITY, VARIANTS } from '../src/data/fishData.js';
import { REGIONS } from '../src/data/regions.js';
import { QUESTS, QUEST_BY_ID, START_QUESTS } from '../src/data/quests.js';
import { NPCS } from '../src/data/npcs.js';
import { HARBOR_BUILDINGS } from '../src/data/harbor.js';
import { RESEARCH_NODES } from '../src/data/research.js';
import { STARTING_LOADOUT, getItem } from '../src/data/equipment.js';

const regionIds = new Set(REGIONS.map((r) => r.id));
const speciesIds = new Set(FISH_SPECIES.map((s) => s.id));
const researchIds = new Set(RESEARCH_NODES.map((n) => n.id));
const questIds = new Set(QUESTS.map((q) => q.id));
const variantIds = new Set(VARIANTS.map((v) => v.id));
const rarities = new Set(Object.keys(RARITY));
const harborIds = new Set(HARBOR_BUILDINGS.map((b) => b.id));

/** Objective fields accept either one id or a list of acceptable ids. */
const each = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

test('quest objectives only reference things that exist', () => {
  const bad = [];
  const check = (at, field, value, ok) => {
    for (const v of each(value)) if (!ok(v)) bad.push(`${at}: ${field} "${v}"`);
  };
  for (const q of QUESTS) {
    check(q.id, 'region', q.region, (v) => regionIds.has(v));
    for (const [i, o] of (q.objectives || []).entries()) {
      const at = `${q.id} objective ${i}`;
      check(at, 'species', o.species, (v) => speciesIds.has(v));
      check(at, 'region', o.region, (v) => regionIds.has(v));
      check(at, 'rarity', o.rarity, (v) => rarities.has(v));
      check(at, 'variant', o.variant, (v) => variantIds.has(v));
      check(at, 'item', o.item, (v) => !!getItem(v));
    }
  }
  assert.deepEqual(bad, [], `unsatisfiable objectives:\n  ${bad.join('\n  ')}`);
});

test('quest ids are unique and start quests exist', () => {
  const bad = [];
  const seen = new Set();
  for (const q of QUESTS) {
    if (seen.has(q.id)) bad.push(`duplicate quest id "${q.id}"`);
    seen.add(q.id);
    if (QUEST_BY_ID[q.id] !== q) bad.push(`QUEST_BY_ID["${q.id}"] does not point at its QUESTS entry`);
    if (!q.objectives?.length) bad.push(`${q.id}: no objectives`);
  }
  for (const id of START_QUESTS || []) {
    if (!questIds.has(id)) bad.push(`START_QUESTS references unknown quest "${id}"`);
  }
  assert.deepEqual(bad, [], `quests:\n  ${bad.join('\n  ')}`);
});

test('NPCs sit in real regions and offer real quests', () => {
  const bad = [];
  const seen = new Set();
  for (const n of NPCS) {
    if (seen.has(n.id)) bad.push(`duplicate npc id "${n.id}"`);
    seen.add(n.id);
    if (n.region && !regionIds.has(n.region)) bad.push(`${n.id}: region "${n.region}"`);
    for (const q of n.quests || []) {
      if (!questIds.has(q)) bad.push(`${n.id}: offers unknown quest "${q}"`);
    }
  }
  assert.deepEqual(bad, [], `npcs:\n  ${bad.join('\n  ')}`);
});

test('harbor buildings are buildable', () => {
  const bad = [];
  for (const b of HARBOR_BUILDINGS) {
    for (const req of b.requires || []) {
      if (!harborIds.has(req)) bad.push(`${b.id}: requires unknown building "${req}"`);
      if (req === b.id) bad.push(`${b.id}: requires itself`);
    }
    if (b.reqResearch && !researchIds.has(b.reqResearch)) bad.push(`${b.id}: reqResearch "${b.reqResearch}"`);
    if (b.reqRegion && !regionIds.has(b.reqRegion)) bad.push(`${b.id}: reqRegion "${b.reqRegion}"`);
    if (!(b.cost >= 0)) bad.push(`${b.id}: cost ${b.cost} is not >= 0`);
  }
  assert.deepEqual(bad, [], `harbor:\n  ${bad.join('\n  ')}`);
});

test('the starting loadout resolves to real items', () => {
  const bad = [];
  for (const [slot, id] of Object.entries(STARTING_LOADOUT)) {
    if (id == null) continue;               // an empty slot is legitimate
    if (!getItem(id)) bad.push(`${slot}: "${id}" is not an item`);
  }
  // A bad id here breaks the very first seconds of a new game.
  assert.deepEqual(bad, [], `starting loadout:\n  ${bad.join('\n  ')}`);
});
