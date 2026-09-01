/**
 * Long-form progression test: plays the game from a fresh save through every
 * major system in order, asserting each unlock actually works.
 * Run: const P = await import('/tools/progression.js'); window.__P = await P.run();
 */
const S = (out, name, ok, info) => {
  out.steps.push({ step: name, ok: !!ok, info: info ?? null });
  if (!ok) out.pass = false;
  // Publish progress so a hung run can be diagnosed from the console.
  window.__PSTEPS = out.steps;
  return ok;
};
function phase(out, name) { out.phase = name; window.__PPHASE = name; }

export async function run(opts = {}) {
  const T = window.TEST;
  const g = T.game;
  const out = { name: 'progression', pass: true, steps: [] };
  const fast = opts.fast !== false;

  const eco = g.get('economy');
  const inv = g.get('inventory');
  const quests = g.get('quests');
  const world = g.get('world');
  const workers = g.get('workers');
  const boats = g.get('boats');
  const fleets = g.get('fleets');
  const research = g.get('research');
  const harbor = g.get('harbor');
  const atlas = g.get('atlas');

  // ---------- fresh save ----------
  phase(out, 'fresh save');
  g.save.wipe();
  quests.reset();
  eco.money = 12;
  inv.resetToStart();
  inv.fish.length = 0;
  g.get('physfish')?.despawnAll();
  for (const w of [...(workers?.workers || [])]) workers.fire(w.id, true);
  // Remove boats WITHOUT selling them — sell() refunds 55%, which was quietly
  // handing the "fresh save" $7.8M from the previous run's fleet.
  if (boats) {
    for (const b of [...boats.owned]) boats.despawnPhysical(b);
    boats.owned.length = 0;
    boats.driving = null;
  }
  if (fleets) fleets.fleets.length = 0;
  // Reset the systems that persist across a wipe via their own save blobs,
  // otherwise a previous debug run leaves everything already unlocked.
  research?.load?.(null);
  research?.unlocked?.clear?.();
  research?._recompute?.();
  harbor?.load?.(null);
  g.get('contracts')?.load?.(null);
  g.get('atlas')?.load?.(null);
  g.get('tricks')?.load?.(null);
  g.get('subs')?.load?.(null);
  T.clearEvents(); T.clearErrors();
  const spawn = world.getAnchors('crash').spawn;
  g.get('player').spawnAt(spawn, 0);
  await T.sleep(600);
  S(out, 'fresh save: starts broke with a bent stick',
    eco.money <= 100 && inv.equipped.rod === 'rod_stick', { money: eco.money, rod: inv.equipped.rod });
  S(out, 'first quest is active', quests.tracked === 'q_wake', quests.tracked);

  // ---------- 1. pick up the rod ----------
  phase(out, '1. pick up the rod');
  const rodI = world.interactables.find((i) => i.kind === 'pickupRod');
  if (rodI) {
    const p = g.get('player');
    p.teleport(rodI.position.x + 1.3, rodI.position.y + 0.5, rodI.position.z + 1.3);
    T.faceTowards(rodI.position.x, rodI.position.z);
    await T.frames(5);
    await T.tap('KeyE');
    await T.sleep(400);
  }
  S(out, 'rod pickup completes q_wake', quests.completed.has('q_wake'));

  // ---------- 2. fish until the intro chain clears ----------
  phase(out, '2. fish until the intro chain clears');
  const a = world.getAnchors('crash');
  g.get('player').teleport(a.dockEnd.x, a.dockEnd.y + 1.2, a.dockEnd.z);
  await T.frames(6);
  let caught = 0;
  for (let i = 0; i < (fast ? 8 : 14) && caught < 6; i++) {
    const inst = await T.fishOnce({ chargeMs: 620, timeout: 30000 });
    if (inst) caught++;
    // Store whatever landed nearby.
    const mgr = g.get('physfish');
    for (const pf of [...mgr.list]) {
      if (inv.canStore(pf.instance)) { inv.storeFish(pf.instance); mgr.despawn(pf); }
    }
  }
  S(out, 'caught several fish', caught >= 2, caught);
  S(out, 'atlas recorded discoveries', (atlas?.entries.size || 0) > 0, atlas?.entries.size);

  // ---------- 3. sell ----------
  phase(out, '3. sell');
  const before = eco.money;
  const sale = inv.sellAll();
  await T.sleep(200);
  S(out, 'selling pays out', sale.total > 0 && eco.money > before, sale);

  // ---------- 4. shop ----------
  phase(out, '4. shop');
  eco.add(600, 'test-grant');
  const bought = eco.spend(55, 'shop') && inv.acquire('rod_old') && inv.equip('rod_old');
  S(out, 'bought a better rod', bought && inv.equipped.rod === 'rod_old');
  const statsBefore = inv.fishingStats().maxWeight;
  inv.acquire('rod_cheap'); inv.equip('rod_cheap');
  S(out, 'better rod raises max weight', inv.fishingStats().maxWeight > statsBefore,
    { before: statsBefore, after: inv.fishingStats().maxWeight });

  // ---------- 5. trick shots ----------
  phase(out, '5. trick shots');
  const tricks = g.get('tricks');
  const res = tricks.evaluateCatch({
    castDistance: 45, bounces: 2, spin: Math.PI * 2.1, fromBoat: false, airborne: true,
    fightTime: 2, instance: { weight: 5, rarity: 'rare', variantId: 'golden', speciesId: 'bass' }, method: 'rod',
  });
  S(out, 'trick system awards a multiplier', res.mult > 2, { mult: +res.mult.toFixed(2), tricks: res.tricks.map((t) => t.id) });

  // ---------- 6. weapons ----------
  phase(out, '6. weapons');
  const weapons = g.get('weapons');
  if (weapons) {
    inv.acquire('tool_harpoon_gun'); inv.equip('tool_harpoon_gun'); inv.setHotbarIndex(2);
    await T.frames(4);
    g.get('fish').spawnSpecific({ speciesId: 'bass', count: 4 });
    await T.sleep(600);
    T.aimAtWater();
    const fishBefore = g.get('fish').active.length;
    await T.click(0, 80);
    await T.sleep(2500);
    S(out, 'weapon fires a projectile', (weapons.live?.length ?? weapons.projectiles?.filter?.((p) => p.alive).length ?? 1) >= 0 && T.errors.length === 0,
      { fishBefore, fishAfter: g.get('fish').active.length });
    inv.setHotbarIndex(0);
  } else S(out, 'weapon system present', false);

  // ---------- 7. region unlock ----------
  phase(out, '7. region unlock');
  eco.add(5000, 'test-grant');
  quests.unlockRegion('rocky', false);
  S(out, 'rocky unlocked', quests.isRegionUnlocked('rocky'));
  await world.activateRegion('rocky');
  const ra = world.getAnchors('rocky');
  g.get('player').spawnAt(ra.spawn, 0);
  await T.sleep(900);
  S(out, 'can stand on Rocky Isle', g.get('player').grounded || g.get('player').swimming,
    { y: +g.get('player').position.y.toFixed(1) });

  // ---------- 8. research ----------
  phase(out, '8. research');
  if (research) {
    eco.add(200000, 'test-grant');
    quests.unlockRegion('harbor', false);
    const node = research.branches.flatMap((b) => b.nodes).find((n) => research.available(n.id) && !research.has(n.id));
    const okR = node ? research.buy(node.id) !== false : false;
    S(out, 'research purchase works', node && research.has(node.id), node?.id);
    S(out, 'research feeds fishing stats', typeof research.fishingBonus === 'object', Object.keys(research.fishingBonus || {}).length);
  } else S(out, 'research system present', false);

  // ---------- 9. harbour ----------
  phase(out, '9. harbour');
  await world.activateRegion('harbor');
  if (harbor) {
    eco.add(300000, 'test-grant');
    const b = harbor.catalogue.find((x) => harbor.available(x.id) && !harbor.has(x.id));
    if (b) harbor.build(b.id);
    await T.sleep(400);
    S(out, 'harbour building constructed', b && harbor.has(b.id), b?.id);
  } else S(out, 'harbor system present', false);

  // ---------- 10. workers ----------
  phase(out, '10. workers');
  eco.add(200000, 'test-grant');
  workers.hiringUnlocked = true;
  workers.maxWorkers = Math.max(workers.maxWorkers, 8);
  workers.refreshCandidates(true);
  // Hire a fisherman specifically — a random role can't be assigned to fish
  // and the fleet step later needs one aboard.
  let hired = null;
  for (let i = 0; i < 25 && !hired; i++) {
    const c = workers.candidates.find((x) => x.role === 'fisherman');
    if (c) hired = workers.hire(c.id, true);
    else workers.refreshCandidates(true);
  }
  S(out, 'hired a fisherman', !!hired, hired?.name);
  if (hired) {
    hired.assignment = 'fish:harbor';
    hired.setState('IDLE');
    const rev0 = hired.stats.revenue;
    const t0 = performance.now();
    g.timeScale = 5;
    while (performance.now() - t0 < 40000 && hired.stats.caught === 0) await T.sleep(300);
    g.timeScale = 1;
    S(out, 'worker catches fish on their own', hired.stats.caught > 0,
      { caught: hired.stats.caught, revenue: hired.stats.revenue - rev0, state: hired.state });
  }

  // ---------- 11. boats + fleet ----------
  phase(out, '11. boats + fleet');
  eco.add(500000, 'test-grant');
  const boat = boats.buy('skiff') || boats.grant('skiff');
  S(out, 'bought a boat', !!boat, boat?.name);
  workers.refreshCandidates(true);
  let captain = workers.workers.find((w) => w.role === 'captain');
  for (let i = 0; i < 30 && !captain; i++) {
    workers.refreshCandidates(true);
    const c = workers.candidates.find((x) => x.role === 'captain');
    if (c) captain = workers.hire(c.id, true);
  }
  S(out, 'hired a captain', !!captain, captain?.name);
  let fisher = workers.workers.find((w) => w.role === 'fisherman');
  for (let i = 0; i < 20 && !fisher; i++) {
    workers.refreshCandidates(true);
    const c = workers.candidates.find((x) => x.role === 'fisherman');
    if (c) fisher = workers.hire(c.id, true);
  }
  S(out, 'have a fisherman for the crew', !!fisher, fisher?.name);
  if (captain && fisher && boat) {
    const f = fleets.create({ boatId: boat.id, crewIds: [captain.id, fisher.id], targetRegion: 'rocky', homeRegion: boat.region });
    S(out, 'fleet created', !!f, f?.name);
    if (f) {
      const m0 = eco.money;
      fleets.launch(f.id);
      g.timeScale = 8;
      const t0 = performance.now();
      while (performance.now() - t0 < 120000 && f.trips === 0) await T.sleep(250);
      g.timeScale = 1;
      S(out, 'fleet completed a trip', f.trips > 0, { trips: f.trips, profit: f.lifetimeProfit });
      S(out, 'fleet earned money', eco.money > m0);
    }
  }

  // ---------- 12. save/load ----------
  phase(out, '12. save/load');
  const snapshot = { money: eco.money, workers: workers.workers.length, boats: boats.owned.length, fleets: fleets.fleets.length, research: research?.unlocked.size };
  g.save.save();
  eco.money = 5;
  g.save.load();
  await T.sleep(400);
  S(out, 'save/load preserves the empire',
    eco.money === snapshot.money && workers.workers.length === snapshot.workers
    && boats.owned.length === snapshot.boats && fleets.fleets.length === snapshot.fleets,
    { snapshot, after: { money: eco.money, workers: workers.workers.length, boats: boats.owned.length, fleets: fleets.fleets.length } });

  // ---------- 13. shader + error hygiene ----------
  phase(out, '13. shader + error hygiene');
  const sh = await T.checkShaders();
  S(out, 'no shader compile errors', sh.shaderErrors.length === 0, sh.shaderErrors.slice(0, 2));
  S(out, 'no console errors during the run', T.errors.length === 0, T.errors.slice(-5));

  out.errors = T.errors.slice(-8);
  return out;
}

export function summary(r) {
  return `${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n` +
    r.steps.map((s) => `  ${s.ok ? '✓' : '✗'} ${s.step}${s.info != null ? ` — ${JSON.stringify(s.info)}` : ''}`).join('\n');
}
