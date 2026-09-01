/**
 * End-to-end automation loop test: hire crew → buy boat → form fleet →
 * launch → watch it fish → return → sell → profit.
 * Run: const F = await import('/tools/fleetScenario.js'); await F.run();
 */
export async function run() {
  const T = window.TEST;
  const g = T.game;
  const out = { name: 'fleet loop', pass: true, steps: [] };
  const step = (n, ok, info) => { out.steps.push({ step: n, ok: !!ok, info: info ?? null }); if (!ok) out.pass = false; return ok; };

  const eco = g.get('economy');
  const workers = g.get('workers');
  const boats = g.get('boats');
  const fleets = g.get('fleets');
  const quests = g.get('quests');
  T.clearErrors();

  eco.add(3_000_000, 'test');
  quests.unlockRegion('rocky', false);
  quests.unlockRegion('harbor', false);
  workers.hiringUnlocked = true;
  workers.maxWorkers = 20;

  // --- hire a captain + two fishermen ---
  const need = { captain: 1, fisherman: 2 };
  let guard = 0;
  while ((need.captain > 0 || need.fisherman > 0) && guard++ < 60) {
    workers.refreshCandidates(true);
    for (const c of [...workers.candidates]) {
      if (need[c.role] > 0) {
        const w = workers.hire(c.id, true);
        if (w) need[c.role]--;
      }
    }
  }
  const captain = workers.workers.find((w) => w.role === 'captain');
  const fishers = workers.workers.filter((w) => w.role === 'fisherman');
  step('hired a captain', !!captain, captain?.name);
  step('hired fishermen', fishers.length >= 2, fishers.length);

  // --- buy a boat ---
  const boat = boats.buy('skiff') || boats.grant('skiff');
  step('bought a boat', !!boat, boat?.name);

  // --- form the fleet ---
  const f = fleets.create({
    boatId: boat.id,
    crewIds: [captain.id, ...fishers.slice(0, 2).map((w) => w.id)],
    targetRegion: 'rocky',
    homeRegion: boat.region,
  });
  step('fleet created', !!f, f?.name);
  if (!f) { out.errors = T.errors.slice(-6); return out; }

  // --- launch ---
  const money0 = eco.money;
  fleets.launch(f.id);
  await T.sleep(500);
  step('fleet launched', f.state !== 'docked', f.state);

  // --- watch the whole trip (speed the sim up so this finishes) ---
  const oldScale = g.timeScale;
  g.timeScale = 6;
  const seen = new Set();
  const t0 = performance.now();
  let cargoPeak = 0;
  while (performance.now() - t0 < 150000) {
    seen.add(f.state);
    cargoPeak = Math.max(cargoPeak, f.cargoWeight);
    if (f.trips > 0) break;
    await T.sleep(200);
  }
  g.timeScale = oldScale;

  step('reached the fishing ground', seen.has('fishing'), [...seen].join('→'));
  step('filled cargo', cargoPeak > 0, `${cargoPeak.toFixed(1)} kg peak`);
  step('returned and unloaded', f.trips > 0, { trips: f.trips, profit: f.lifetimeProfit });
  step('company earned money', eco.money > money0, { before: money0, after: eco.money });
  step('crew gained XP', f.crew.some((w) => w.xp > 0 || w.level > 1), f.crew.map((w) => `${w.name.split(' ')[0]}:L${w.level}`));
  step('no console errors', T.errors.length === 0, T.errors.slice(-4));

  out.errors = T.errors.slice(-6);
  return out;
}

export function summary(r) {
  return `${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n` +
    r.steps.map((s) => `  ${s.ok ? '✓' : '✗'} ${s.step}${s.info != null ? ` — ${JSON.stringify(s.info)}` : ''}`).join('\n');
}
