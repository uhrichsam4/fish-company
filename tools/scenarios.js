/**
 * Automated play-test scenarios. Loaded on demand from the browser console:
 *   const S = await import('/tools/scenarios.js'); await S.run('core');
 * Each scenario returns {name, pass, steps:[{step, ok, info}], errors}.
 */

const results = [];

function step(out, name, ok, info) {
  out.steps.push({ step: name, ok: !!ok, info: info ?? null });
  if (!ok) out.pass = false;
  return ok;
}

export async function newGame(T) {
  T.game.save.wipe();
  const q = T.game.get('quests');
  q.reset();
  const eco = T.game.get('economy');
  eco.money = 12;
  eco.stats.totalCaught = 0;
  const inv = T.game.get('inventory');
  inv.resetToStart();
  inv.fish.length = 0;
  T.game.get('physfish')?.despawnAll();
  T.clearEvents(); T.clearErrors();
  const w = T.game.get('world');
  const a = w.getAnchors('crash');
  T.game.get('player').spawnAt(a.spawn, 0);
  await T.frames(4);
}

/** Onboarding: pick up rod → cast → catch → sell → buy. */
export async function core(T) {
  const out = { name: 'core loop', pass: true, steps: [], errors: [] };
  const g = T.game;
  await newGame(T);

  // --- pick up the rod ---
  const w = g.get('world');
  const rodI = w.interactables.find((i) => i.kind === 'pickupRod');
  step(out, 'rod interactable exists', !!rodI);
  if (rodI) {
    const p = g.get('player');
    p.teleport(rodI.position.x + 1.4, rodI.position.y + 0.6, rodI.position.z + 1.4);
    T.faceTowards(rodI.position.x, rodI.position.z);
    await T.frames(5);
    await T.tap('KeyE');
    await T.sleep(400);
  }
  step(out, 'rod equipped', g.get('inventory').equipped.rod === 'rod_stick');
  step(out, 'quest q_wake done', g.get('quests').completed.has('q_wake'), g.get('quests').tracked);

  // --- move to a good fishing spot on the dock ---
  const a = w.getAnchors('crash');
  const p = g.get('player');
  p.teleport(a.dockEnd.x, a.dockEnd.y + 1.2, a.dockEnd.z);
  await T.frames(6);
  const aim = T.aimAtWater(70);
  step(out, 'found water to cast at', !!aim, aim);

  // --- cast ---
  g.get('inventory').setHotbarIndex(0);
  await T.frames(2);
  await T.holdMouse(0, 700);
  const inWater = await T.waitFor(() => ['inwater', 'nibble'].includes(g.get('fishing').state), 8000, 'cast lands');
  step(out, 'cast lands in water', inWater, g.get('fishing').state);
  step(out, 'quest cast flag', g.get('quests').flags.has('cast_in_water'));

  // --- catch up to 3 attempts ---
  let caught = null;
  for (let i = 0; i < 3 && !caught; i++) {
    caught = await T.fishOnce({ chargeMs: 650, timeout: 45000 });
  }
  step(out, 'caught a fish', !!caught, caught ? `${caught.name} ${caught.weight.toFixed(2)}kg $${caught.value}` : T.log.slice(-3));
  step(out, 'physical fish spawned', (g.get('physfish')?.list.length || 0) > 0, g.get('physfish')?.list.length);

  // --- carry & store ---
  const grabbed = await T.grabNearestFish();
  step(out, 'grabbed the fish', grabbed);
  if (grabbed) {
    await T.tap('KeyE');
    await T.sleep(350);
  }
  step(out, 'fish in storage', g.get('inventory').fish.length > 0, g.get('inventory').fish.length);

  // --- sell ---
  const before = T.money;
  const sale = await T.sellAll();
  step(out, 'sold for money', sale.total > 0, sale);
  step(out, 'money increased', T.money > before, { before, after: T.money });

  // --- buy ---
  g.get('economy').add(400, 'test');
  const bought = g.get('economy').spend(55, 'test') && g.get('inventory').acquire('rod_old') && g.get('inventory').equip('rod_old');
  step(out, 'bought+equipped a better rod', bought && g.get('inventory').equipped.rod === 'rod_old');

  out.errors = T.errors.slice(-10);
  return out;
}

/** Physics: fish flop, throw, sell-bin trick, buoyancy. */
export async function physics(T) {
  const out = { name: 'physics', pass: true, steps: [], errors: [] };
  const g = T.game;
  const { FISH_SPECIES, rollFishInstance, getSpecies } = await import('/src/data/fishData.js');
  const mgr = g.get('physfish');
  mgr.despawnAll();
  const p = g.get('player');
  const w = g.get('world');
  const a = w.getAnchors('crash');
  p.teleport(a.dockStart.x, a.dockStart.y + 1.4, a.dockStart.z);
  await T.frames(5);

  // Spawn a range of sizes and check they settle without NaN.
  for (const id of ['sardine', 'bass', 'catfish', 'tuna']) {
    const sp = getSpecies(id);
    if (!sp) continue;
    const inst = rollFishInstance(sp, Math.random, {});
    mgr.spawn({ instance: inst, position: { x: p.position.x + Math.random() * 3, y: p.position.y + 2, z: p.position.z + Math.random() * 3 }, velocity: { x: 0, y: 1, z: 0 } });
  }
  step(out, 'spawned physical fish', mgr.list.length >= 3, mgr.list.length);
  await T.sleep(2500);
  let nan = 0, moved = 0;
  for (const pf of mgr.list) {
    const pos = g.physics.getPosition(pf.entry);
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) nan++;
    if (pf.energy < 1) moved++;
  }
  step(out, 'no NaN transforms', nan === 0, nan);
  step(out, 'fish are flopping (energy drains)', moved > 0, moved);

  // Throw test.
  const inter = g.get('interaction');
  if (mgr.list.length) {
    const pf = mgr.list[0];
    const before = g.physics.getPosition(pf.entry).clone();
    inter.grab(pf.entry, g);
    await T.frames(10);
    inter.release(1.0);
    await T.sleep(900);
    const after = g.physics.getPosition(pf.entry);
    step(out, 'thrown fish travels', after.distanceTo(before) > 1.5, +after.distanceTo(before).toFixed(2));
  }

  // Sell-bin auto-sell.
  const zone = w.sellZones[0];
  if (zone && mgr.list.length) {
    const pf = mgr.list[mgr.list.length - 1];
    const before = T.money;
    g.physics.setPosition(pf.entry, zone.position.x, zone.position.y + 0.4, zone.position.z);
    await T.sleep(700);
    step(out, 'fish in sell bin auto-sells', T.money > before, { before, after: T.money });
  }
  mgr.despawnAll();
  out.errors = T.errors.slice(-10);
  return out;
}

/** Every region activates without error and has valid anchors. */
export async function regions(T) {
  const out = { name: 'regions', pass: true, steps: [], errors: [] };
  const g = T.game;
  const { REGIONS } = await import('/src/data/regions.js');
  for (const r of REGIONS) {
    T.clearErrors();
    await g.get('world').activateRegion(r.id);
    const a = g.get('world').getAnchors(r.id);
    const ok = !!a && (r.trench || (a.spawn && Number.isFinite(a.spawn.y)));
    step(out, `region ${r.id} builds`, ok && T.errors.length === 0, T.errors.slice(0, 2));
    if (a?.spawn) {
      g.get('player').spawnAt(a.spawn, 0);
      await T.sleep(500);
      const p = g.get('player');
      const grounded = p.grounded || p.swimming || r.trench;
      step(out, `region ${r.id} spawn is standable`, grounded, { y: +p.position.y.toFixed(1), terrain: +g.get('world').heightAt(p.position.x, p.position.z).toFixed(1) });
    }
  }
  return out;
}

/** Save → mutate → load round-trip. */
export async function saveLoad(T) {
  const out = { name: 'save/load', pass: true, steps: [], errors: [] };
  const g = T.game;
  const eco = g.get('economy'), inv = g.get('inventory'), q = g.get('quests');
  const { getSpecies, rollFishInstance } = await import('/src/data/fishData.js');
  eco.money = 54321;
  inv.acquire('rod_carbon'); inv.equip('rod_carbon');
  inv.storeFish(rollFishInstance(getSpecies('bass'), Math.random, {}));
  q.setFlag('test_flag');
  const wrote = g.save.save();
  step(out, 'save writes', wrote);
  eco.money = 1; inv.equip('rod_stick'); inv.fish.length = 0; q.flags.delete('test_flag');
  const loaded = g.save.load();
  step(out, 'load reads', loaded);
  step(out, 'money restored', eco.money === 54321, eco.money);
  step(out, 'equipment restored', inv.equipped.rod === 'rod_carbon', inv.equipped.rod);
  step(out, 'stored fish restored', inv.fish.length === 1, inv.fish.length);
  step(out, 'quest flag restored', q.flags.has('test_flag'));
  const slots = g.save.slots();
  step(out, 'slot metadata readable', Array.isArray(slots) && slots.length === 3);
  return out;
}

/** Stress: many fish + physics bodies, measure fps. */
export async function stress(T) {
  const out = { name: 'stress', pass: true, steps: [], errors: [] };
  const g = T.game;
  const { FISH_SPECIES, rollFishInstance } = await import('/src/data/fishData.js');
  const fs = g.get('fish');
  const mgr = g.get('physfish');
  const before = g.perf.fps;
  const p = g.get('player');
  // Flood physical fish.
  for (let i = 0; i < 24; i++) {
    const sp = FISH_SPECIES[(Math.random() * 25) | 0];
    mgr.spawn({
      instance: rollFishInstance(sp, Math.random, {}),
      position: { x: p.position.x + (Math.random() - 0.5) * 8, y: p.position.y + 3 + i * 0.2, z: p.position.z + (Math.random() - 0.5) * 8 },
      velocity: { x: 0, y: 0, z: 0 },
    });
  }
  await T.sleep(4000);
  const fps = g.perf.fps;
  step(out, 'fps under load >= 25', fps >= 25, { before: +before.toFixed(0), after: +fps.toFixed(0), bodies: g.physics.bodyCount, fish: fs.active.length, phys: mgr.list.length, draws: g.perf.drawCalls, tris: g.perf.tris });
  mgr.despawnAll();
  await T.sleep(600);
  return out;
}

const ALL = { core, physics, regions, saveLoad, stress };

export async function run(names) {
  const T = window.TEST;
  if (!T) throw new Error('test harness not installed');
  const list = names ? (Array.isArray(names) ? names : [names]) : Object.keys(ALL);
  const out = [];
  for (const n of list) {
    if (!ALL[n]) { out.push({ name: n, pass: false, steps: [{ step: 'exists', ok: false }] }); continue; }
    T.clearErrors();
    let r;
    try { r = await ALL[n](T); }
    catch (e) { r = { name: n, pass: false, steps: [{ step: 'threw', ok: false, info: String(e?.stack || e) }] }; }
    out.push(r);
  }
  results.push(...out);
  return out;
}

export function summary(res) {
  return res.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n` +
    r.steps.map((s) => `  ${s.ok ? '✓' : '✗'} ${s.step}${s.info != null ? ` — ${JSON.stringify(s.info)}` : ''}`).join('\n')).join('\n');
}
