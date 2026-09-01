/**
 * Regression cover for dive-depth recording.
 *
 * s.deepest and eco.stats.deepestDive used to be written only from the piloted
 * update, which derives depth from s.position. An expedition never moves the
 * sub through the world -- it runs a state machine against a depth band -- so
 * a player who only ever sent expeditions kept a deepest of 0, the Company
 * panel's readout never moved, and the dive-depth dialogue gates in
 * data/npcs.js (deepestDive > 100, > 400) could never open.
 *
 * The recording point is entry to SURVEY, which is the only state in which the
 * sub is genuinely on station at the band depth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SubSystem, DEPTH_BANDS } from '../src/submarines/SubSystem.js';

/** Minimal stand-in: SubSystem only needs get('economy') for depth recording. */
function harness() {
  const economy = { stats: { deepestDive: 0 } };
  const game = { get: (id) => (id === 'economy' ? economy : null), add() {}, systems: [] };
  return { economy, subs: new SubSystem(game) };
}

const sub = () => ({ deepest: 0 });

test('_recordDepth advances both the sub and the run-wide stat', () => {
  const { economy, subs } = harness();
  const s = sub();
  subs._recordDepth(s, 180);
  assert.equal(s.deepest, 180);
  assert.equal(economy.stats.deepestDive, 180);
});

test('_recordDepth is monotonic', () => {
  const { economy, subs } = harness();
  const s = sub();
  subs._recordDepth(s, 400);
  subs._recordDepth(s, 90);
  assert.equal(s.deepest, 400, 'a shallower dive must not lower the record');
  assert.equal(economy.stats.deepestDive, 400);
});

test('_recordDepth ignores non-depths', () => {
  const { economy, subs } = harness();
  const s = sub();
  for (const bad of [0, -1, NaN, null, undefined]) subs._recordDepth(s, bad);
  assert.equal(s.deepest, 0);
  assert.equal(economy.stats.deepestDive, 0);
});

test('_recordDepth still records the run stat with no sub', () => {
  // The piloted path always has a sub; keeping this total means a future
  // caller cannot trip over it.
  const { economy, subs } = harness();
  subs._recordDepth(null, 250);
  assert.equal(economy.stats.deepestDive, 250);
});

test('reaching station on an expedition records the band depth', () => {
  const { economy, subs } = harness();
  const band = DEPTH_BANDS[0];
  const s = sub();
  const exp = { sub: s, band, state: 'descent', stateTime: 12 };

  subs.setExpState(exp, 'survey');

  assert.equal(s.deepest, band.depth, 'survey is the point the sub is at depth');
  assert.equal(economy.stats.deepestDive, band.depth);
});

test('an expedition recalled before station records nothing', () => {
  const { economy, subs } = harness();
  const s = sub();
  const exp = { sub: s, band: DEPTH_BANDS[0], state: 'prep', stateTime: 0 };

  // prep -> descent -> ascent, i.e. recalled on the way down.
  subs.setExpState(exp, 'descent');
  subs.setExpState(exp, 'ascent');
  subs.setExpState(exp, 'debrief');

  assert.equal(s.deepest, 0, 'the sub never reached the band');
  assert.equal(economy.stats.deepestDive, 0);
});

test('the deepest band reached across expeditions wins', () => {
  const { economy, subs } = harness();
  const s = sub();
  const deep = DEPTH_BANDS[Math.min(2, DEPTH_BANDS.length - 1)];
  const shallow = DEPTH_BANDS[0];
  assert.ok(deep.depth > shallow.depth, 'fixture assumes bands are ordered shallow-first');

  subs.setExpState({ sub: s, band: deep, state: 'descent' }, 'survey');
  subs.setExpState({ sub: s, band: shallow, state: 'descent' }, 'survey');

  assert.equal(s.deepest, deep.depth);
  assert.equal(economy.stats.deepestDive, deep.depth);
});
