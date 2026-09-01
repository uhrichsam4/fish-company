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
