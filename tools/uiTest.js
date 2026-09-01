/**
 * Real-pointer UI test.
 *
 * Every panel is exercised through `document.elementFromPoint` and synthetic
 * pointer events rather than by calling handlers directly, because the bug
 * class that matters here — a CSS rule leaving a panel un-clickable — is
 * completely invisible to a handler-level test.
 */
const PANELS = [
  { id: 'shop', data: { tier: 3, region: 'crash' } },
  { id: 'inventory' },
  { id: 'atlas' },
  { id: 'company' },
  { id: 'map' },
  { id: 'quests' },
  { id: 'contracts' },
  { id: 'processing' },
  { id: 'pause' },
  { id: 'fleetEditor' },
  { id: 'boatUpgrade' },
  { id: 'subUpgrade' },
  { id: 'subExpedition' },
  { id: 'workerGear' },
  { id: 'gambling' },
];

export async function run() {
  const T = window.TEST;
  const g = T.game;
  const ui = g.get('ui');
  const out = { name: 'ui', pass: true, steps: [] };
  const S = (n, ok, info) => { out.steps.push({ step: n, ok: !!ok, info: info ?? null }); if (!ok) out.pass = false; };

  // Give the panels something real to show.
  g.get('economy').add(500000, 'ui-test');
  const inv = g.get('inventory');
  const { FISH_SPECIES, rollFishInstance } = await import('/src/data/fishData.js');
  for (let i = 0; i < 6; i++) inv.storeFish(rollFishInstance(FISH_SPECIES[i * 3], Math.random, {}));
  const workers = g.get('workers');
  if (workers) {
    workers.hiringUnlocked = true; workers.maxWorkers = 12;
    workers.refreshCandidates(true);
    if (!workers.workers.length) workers.hire(workers.candidates[0]?.id, true);
  }
  g.get('boats')?.grant('skiff');
  g.get('subs')?.grant('scout');
  T.clearErrors();

  for (const p of PANELS) {
    ui.closeAll();
    await T.sleep(120);
    let threw = null;
    try { ui.show(p.id, p.data); } catch (e) { threw = String(e.message); }
    await T.sleep(320);
    const panel = ui.get(p.id);
    const open = !!panel?.open && !!panel.el && panel.el.style.display !== 'none';
    S(`${p.id}: opens`, open && !threw, threw);
    if (!open) continue;

    // Backdrop must be clickable, otherwise nothing inside it is reachable.
    const backdrop = panel.el;
    const bt = T.hitTest(backdrop);
    S(`${p.id}: backdrop accepts the pointer`, bt.ok, bt.why);

    // Close button and the first real control.
    const close = panel.el.querySelector('.panel-close');
    if (close) S(`${p.id}: close button is clickable`, T.hitTest(close).ok, T.hitTest(close).why);
    const btn = panel.el.querySelector('.panel-body .btn, .panel-body [data-action], .tab');
    if (btn) {
      const h = T.hitTest(btn);
      S(`${p.id}: a control is clickable`, h.ok, h.why);
    }

    // Content sanity: an empty body usually means the panel threw while rendering.
    const bodyLen = (panel.bodyEl?.textContent || '').trim().length;
    S(`${p.id}: renders content`, bodyLen > 20, bodyLen);

    // No horizontal overflow at this viewport.
    const box = panel.el.querySelector('.panel');
    if (box) S(`${p.id}: fits the viewport`, box.scrollWidth <= box.clientWidth + 2,
      { scrollW: box.scrollWidth, clientW: box.clientWidth });
  }

  // Tab switching on a tabbed panel, through a real click.
  ui.closeAll(); await T.sleep(150);
  ui.show('company'); await T.sleep(300);
  const tabs = [...(ui.get('company').el.querySelectorAll('.tab') || [])];
  if (tabs.length > 2) {
    const before = ui.get('company').activeTab;
    const r = T.realClick(tabs[2]);
    await T.sleep(250);
    S('company: tab switches on a real click', r.ok && ui.get('company').activeTab !== before,
      { before, after: ui.get('company').activeTab, click: r });
  }

  // Submarines, end to end: buy → refit → upgrade → expedition → recall.
  // Every step goes through a real pointer click on the rendered control.
  const subs = g.get('subs');
  if (subs) {
    g.get('economy').add(50000000, 'ui-test');
    T.bus.emit('debug:unlockResearch', {});
    ui.closeAll(); await T.sleep(150);
    ui.show('company'); await T.sleep(250);
    const company = ui.get('company');
    const subTab = [...company.el.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'subs');
    T.realClick(subTab); await T.sleep(320);
    S('subs: tab renders', company.activeTab === 'subs' && company.bodyEl.textContent.trim().length > 40,
      company.bodyEl.textContent.trim().length);

    // The shipyard sits below the owned subs, and a live re-render replaces the
    // node every 250 ms — scroll first, then re-query, then click.
    company.bodyEl.querySelector('[data-action=buySub]')?.scrollIntoView({ block: 'center' });
    await T.sleep(160);
    const buy = [...company.bodyEl.querySelectorAll('[data-action=buySub]')].find((b) => !b.disabled);
    if (buy) {
      const before = subs.owned.length;
      const r = T.realClick(buy);
      await T.sleep(400);
      S('subs: buying adds a sub', subs.owned.length === before + 1, { before, after: subs.owned.length, click: r });
    }
    // Anything the player cannot buy has to say why, or the shop is a dead end.
    const locked = [...company.bodyEl.querySelectorAll('.card.locked')];
    S('subs: locked hulls give a reason', locked.every((c) => (c.querySelector('.chip')?.textContent || '').length > 3),
      locked.map((c) => c.querySelector('.chip')?.textContent));

    const refit = company.bodyEl.querySelector('[data-action=upgradeSub]');
    const sub = subs.byId(refit?.dataset.id);
    if (refit) {
      T.realClick(refit); await T.sleep(400);
      const up = ui.get('subUpgrade');
      S('subUpgrade: opens from the Subs tab', up.open && !company.open);
      const btn = [...(up.el?.querySelectorAll('[data-action=up]') || [])].find((b) => !b.disabled);
      const lvl = sub ? (sub.upgrades[btn?.dataset.id] || 0) : 0;
      if (btn) {
        T.realClick(btn); await T.sleep(400);
        S('subUpgrade: an upgrade applies', (sub.upgrades[btn.dataset.id] || 0) === lvl + 1,
          { id: btn.dataset.id, before: lvl, after: sub.upgrades[btn.dataset.id] });
      }
    }

    // An expedition needs a qualified pilot the moment the company has staff.
    if (workers && !workers.workers.some((w) => w.role === 'subpilot' || w.role === 'captain')) {
      for (let i = 0; i < 40; i++) {
        workers.refreshCandidates(true);
        const c = workers.candidates.find((x) => x.role === 'subpilot' || x.role === 'captain');
        if (c) { workers.hire(c.id, true); break; }
      }
    }
    ui.closeAll(); await T.sleep(150);
    ui.show('subExpedition', { id: sub?.id }); await T.sleep(320);
    const ed = ui.get('subExpedition');
    T.realClick(ed.el.querySelector('[data-action=pickBand][data-id=shelf]')); await T.sleep(200);
    const pilot = workers?.workers.find((w) => w.role === 'subpilot' || w.role === 'captain');
    const pilotRow = pilot && ed.el.querySelector(`[data-action=toggleCrew][data-id="${pilot.id}"]`);
    if (pilotRow) { T.realClick(pilotRow); await T.sleep(200); }
    const launch = ed.el.querySelector('[data-action=launch]');
    S('subExpedition: dive unlocks once the plan is legal', !launch.disabled, ed.footEl.textContent.trim());
    const expBefore = subs.expeditions.length;
    T.realClick(launch); await T.sleep(500);
    S('subExpedition: launching starts a dive', subs.expeditions.length === expBefore + 1,
      { before: expBefore, after: subs.expeditions.length, state: subs.expeditions[0]?.state });

    const recall = ui.get('company').bodyEl.querySelector('[data-action=recallExpedition]');
    if (recall) {
      T.realClick(recall); await T.sleep(400);
      S('subs: an expedition can be recalled', !!subs.expeditions.find((e) => e.id === recall.dataset.id)?.recalled);
    } else S('subs: an expedition can be recalled', false, 'no recall button rendered');
  }

  ui.closeAll();
  await T.sleep(200);
  S('closing releases the UI capture', !g.input.uiCapture, g.input.uiCapture);
  S('no console errors', T.errors.length === 0, T.errors.slice(-4));
  out.errors = T.errors.slice(-6);
  return out;
}

export function summary(r) {
  return `${r.pass ? 'PASS' : 'FAIL'} ${r.name}\n` +
    r.steps.map((s) => `  ${s.ok ? '✓' : '✗'} ${s.step}${s.info != null ? ` — ${JSON.stringify(s.info)}` : ''}`).join('\n');
}
