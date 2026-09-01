import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { PROCESS_LEVELS } from '../../economy/Processing.js';
import { RARITY } from '../../data/fishData.js';
import { formatMoneyExact, formatWeight, formatTime, clamp01 } from '../../util/math.js';

/**
 * The processing floor. Storage on the left, the live queue in the middle,
 * the controls and the throughput maths on the right.
 *
 * Value uplift is computed from the same numbers Economy will charge at the
 * till: the advertised tier multiplier is the *total* sale multiplier over raw,
 * so a fish's value at tier T is its value now × (mult[T] / mult[now]).
 */
export class ProcessingPanel extends Panel {
  constructor(game) {
    super(game, { id: 'processing', title: '🏭 Processing Floor', width: 'wide' });
    this.live = true;
  }

  // -------------------------------------------------------------- valuation
  /** Sale value of a stored fish right now, including its style multiplier. */
  valueNow(entry) {
    const eco = this.game.get('economy');
    if (!eco || !entry?.instance) return 0;
    return eco.priceFor(entry.instance, { freshness: entry.freshness, processLevel: entry.processLevel || 0 })
      * (entry.styleMult || 1);
  }

  /** Sale value the same fish would fetch at `level`. */
  valueAt(entry, level) {
    const cur = PROCESS_LEVELS[entry.processLevel || 0]?.mult || 1;
    const to = PROCESS_LEVELS[level]?.mult || 1;
    return this.valueNow(entry) * (to / cur);
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const proc = g.get('processing');
    const inv = g.get('inventory');
    const eco = g.get('economy');

    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800;font-size:17px">${formatMoneyExact(eco?.money || 0)}</span>`);

    if (!proc) {
      this.setSubtitle('');
      this.bodyEl.innerHTML = empty('🏭', 'There is no processing floor yet.',
        'Research the Gutting Line or build the Processing Plant at the harbour.');
      this.setFoot('');
      this.bind();
      return;
    }

    const maxLevel = proc.maxLevel;
    const lines = proc.lines;
    this.setSubtitle(proc.unlocked
      ? `${lines} line${lines === 1 ? '' : 's'} · up to ${PROCESS_LEVELS[maxLevel]?.name || 'Raw'}`
      : 'Locked');

    const potential = this.totalPotential(proc, inv);
    this.bodyEl.innerHTML = `
      ${this.ladderStrip(proc, potential)}
      <div class="proc-cols">
        ${this.colStorage(proc, inv)}
        ${this.colQueue(proc)}
        ${this.colControls(proc, inv, g)}
      </div>`;

    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">
        ${inv?.fish.length || 0} in storage · ${proc.queue.length} on the floor ·
        lifetime <b style="color:var(--gold)">${formatMoneyExact(proc.lifetimeValueAdded)}</b> added over ${proc.lifetimeProcessed} fish</span>
      <div style="flex:1"></div>
      ${potential.gain > 0
        ? `<span class="chip gold">+${formatMoneyExact(potential.gain)} if fully processed</span>` : ''}
      <button class="btn ${proc.unlocked && lines && potential.eligible ? 'primary' : ''}" data-action="processAll"
        ${proc.unlocked && lines && potential.eligible ? '' : 'disabled'}>Process everything</button>`);

    this.bind();
  }

  bind() {
    this.onAction((act, ds) => {
      const g = this.game;
      const proc = g.get('processing');
      if (act === 'processOne') bus.emit('company:process', { index: Number(ds.index) });
      else if (act === 'processAll') bus.emit('company:processAll');
      else if (act === 'cancel') this.cancelJob(proc, Number(ds.index));
      else if (act === 'cancelAll') { for (let i = (proc?.queue.length || 0) - 1; i >= 0; i--) this.cancelJob(proc, i); }
      else if (act === 'shop') bus.emit('ui:show', { id: 'company', data: { tab: 'research' } });
      else if (act === 'crew') bus.emit('ui:show', { id: 'company', data: { tab: 'workers' } });
      setTimeout(() => { if (this.open) this.render(); }, 30);
    });
  }

  /** Pull a job back off the floor. The fish is never destroyed — it goes home. */
  cancelJob(proc, i) {
    if (!proc || !proc.queue[i]) return;
    const inv = this.game.get('inventory');
    const job = proc.queue.splice(i, 1)[0];
    if (inv && job.entry) { inv.fish.push(job.entry); bus.emit('inventory:changed'); }
    this.game.audio?.play('ui_click', { volume: 0.4 });
    bus.emit('toast', { text: `Pulled ${job.entry?.instance?.name || 'a fish'} off the line`, kind: 'warn', duration: 2200 });
  }

  // -------------------------------------------------------------- storage
  colStorage(proc, inv) {
    const rows = (inv?.fish || []).map((f, i) => {
      const lvl = f.processLevel || 0;
      const inst = f.instance;
      const r = RARITY[inst.rarity] || RARITY.common;
      const can = proc.canProcess(f);
      const next = Math.min(lvl + 1, PROCESS_LEVELS.length - 1);
      const gain = can ? this.valueAt(f, next) - this.valueNow(f) : 0;
      return `<div class="list-row">
        <span class="lr-icon">${lvl ? '🍣' : '🐟'}</span>
        <div class="lr-main">
          <div class="lr-title" style="color:${r.color}">${inst.name}</div>
          <div class="lr-sub">${formatWeight(inst.weight)} ·
            <span class="chip ${lvl ? 'good' : ''}" style="padding:1px 6px">${PROCESS_LEVELS[lvl].name}</span>
            ${can ? `<span style="color:var(--good)"> → ${PROCESS_LEVELS[next].name} +${formatMoneyExact(gain)}</span>` : ''}</div>
        </div>
        <div class="lr-right" style="color:var(--gold)">${formatMoneyExact(this.valueNow(f))}</div>
        ${can ? `<button class="btn sm" data-action="processOne" data-index="${i}">Process</button>`
          : `<span class="chip">${lvl >= proc.maxLevel ? 'Max' : '—'}</span>`}
      </div>`;
    }).join('');

    return `<div class="card proc-col">
      <div class="card-title">🧺 Storage <span class="chip">${inv?.fish.length || 0}</span></div>
      <div class="card-desc">Your catch and the tier it is currently packed at.</div>
      <div class="scroll-y proc-scroll">${rows || emptyInline('🪣', 'Nothing in storage.')}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- queue
  colQueue(proc) {
    const lines = Math.max(1, proc.lines);
    const rows = proc.queue.map((q, i) => {
      const active = i < lines;
      const pct = q.totalSeconds ? clamp01(1 - Math.max(0, q.secondsLeft) / q.totalSeconds) * 100 : 0;
      // Jobs beyond the line count only start once the ones in front clear.
      const waitAhead = active ? 0 : proc.queue.slice(0, i)
        .filter((_, j) => j % lines === i % lines).reduce((a, x) => a + Math.max(0, x.secondsLeft), 0);
      return `<div class="list-row ${active ? 'selected' : ''}">
        <span class="lr-icon">${active ? '🔪' : '⏳'}</span>
        <div class="lr-main">
          <div class="lr-title">${q.entry?.instance?.name || 'Fish'}</div>
          <div class="lr-sub">→ ${PROCESS_LEVELS[q.targetLevel]?.name || '—'} ·
            ${active ? `${formatTime(Math.max(0, q.secondsLeft))} left` : `queued · ~${formatTime(waitAhead + q.secondsLeft)}`}</div>
          <div class="progress ${active ? '' : 'gold'}" style="margin-top:4px"><i style="width:${active ? pct : 0}%"></i></div>
        </div>
        <button class="btn sm ghost" data-action="cancel" data-index="${i}" title="Pull it back off the line">✕</button>
      </div>`;
    }).join('');

    return `<div class="card proc-col">
      <div class="card-title">⏱ On the floor <span class="chip">${proc.queue.length}</span></div>
      <div class="card-desc">${proc.lines
        ? `${proc.lines} job${proc.lines === 1 ? '' : 's'} run at once — the rest wait their turn.`
        : 'No lines running. Nothing can be worked.'}</div>
      <div class="scroll-y proc-scroll">${rows || emptyInline('💤', 'The floor is idle.')}</div>
      ${proc.queue.length ? `<button class="btn sm block" data-action="cancelAll" style="margin-top:8px">Pull everything back</button>` : ''}
    </div>`;
  }

  // ------------------------------------------------------- tier value strip
  ladderStrip(proc, potential) {
    const maxLevel = proc.maxLevel;
    const ladder = PROCESS_LEVELS.map((L, i) => {
      const locked = i > maxLevel;
      const step = i > 0 ? proc.stepSeconds(i) : 0;
      return `<div class="tier-step ${locked ? 'locked' : ''} ${i === maxLevel ? 'top' : ''}">
        <span class="tier-name">${L.name}</span>
        <span class="tier-mult">×${L.mult.toFixed(1)}</span>
        <span class="tier-time">${i === 0 ? 'base' : `${step.toFixed(0)}s`}</span>
        ${locked ? '<span class="tier-lock">🔒</span>' : ''}
      </div>`;
    }).join('<div class="tier-arrow">→</div>');

    const term = (k, v, cls = '') => `<div><span class="ct-term-k">${k}</span><span class="ct-term-v ${cls}">${v}</span></div>`;
    return `<div class="card proc-strip">
      <div class="proc-strip-l">
        <div class="card-title">💹 Value per tier</div>
        <div class="card-desc">Each tier is a total sale multiplier over the raw price — the seconds are one step on one line.</div>
        <div class="tier-ladder">${ladder}</div>
      </div>
      <div class="proc-strip-r">
        <div class="card-title">📈 If you processed everything</div>
        <div class="ct-terms" style="border-top:none;padding-top:4px;flex-wrap:wrap">
          ${term('Eligible', `${potential.eligible} fish`)}
          ${term('Value now', formatMoneyExact(potential.now), 'gold')}
          ${term(`At ${PROCESS_LEVELS[maxLevel]?.name || 'Raw'}`, formatMoneyExact(potential.best), 'gold')}
          ${term('Gain', `+${formatMoneyExact(potential.gain)}`, potential.gain > 0 ? 'good' : '')}
          ${term('Floor time', potential.seconds ? formatTime(potential.seconds) : '—')}
        </div>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------- controls
  colControls(proc, inv, g) {
    const workers = g.get('workers');
    const processors = workers ? workers.workers.filter((w) => w.role === 'processor') : [];
    const assigned = processors.filter((w) => w.assignment === 'process');
    const plant = !!g.get('harbor')?.has?.('processing_plant');
    const auto = !!g.get('research')?.features?.has('automated_processing');
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;

    return `<div class="proc-col" style="display:flex;flex-direction:column;gap:11px">
      <div class="card">
        <div class="card-title">👷 Throughput</div>
        ${line('Processor crew', processors.length, processors.length ? 'good' : 'bad')}
        ${line('On the floor', `${assigned.length} assigned`)}
        ${line('Processing Plant', plant ? 'Built' : 'Not built', plant ? 'good' : '')}
        ${line('Parallel lines', proc.lines || 0, proc.lines ? 'good' : 'bad')}
        ${line('Automation', auto ? '2× faster' : 'None', auto ? 'good' : '')}
        <div class="card-desc" style="margin-top:7px">
          One line per processor on the payroll — the plant guarantees one. Lines run in parallel, so a
          second processor halves the wait on a full basket.
        </div>
        <div class="card-row">
          <button class="btn sm" data-action="crew">Manage crew</button>
          <button class="btn sm" data-action="shop">Research</button>
        </div>
      </div>

      ${!proc.unlocked ? `<div class="card" style="border-color:var(--warn)">
        <div class="card-title">🔒 Locked</div>
        <div class="card-desc">Research the Gutting Line, or build the Processing Plant at the harbour, to open the floor.</div>
      </div>` : ''}
    </div>`;
  }

  /** Total value now vs at the highest reachable tier, across storage. */
  totalPotential(proc, inv) {
    let now = 0, best = 0, eligible = 0, seconds = 0;
    const max = proc.maxLevel;
    for (const f of inv?.fish || []) {
      const v = this.valueNow(f);
      now += v;
      const target = Math.max(f.processLevel || 0, max);
      best += this.valueAt(f, target);
      if ((f.processLevel || 0) < max) {
        eligible++;
        for (let l = (f.processLevel || 0) + 1; l <= max; l++) seconds += proc.stepSeconds(l);
      }
    }
    return { now, best, gain: Math.max(0, best - now), eligible, seconds: seconds / Math.max(1, proc.lines) };
  }
}

function empty(icon, text, hint) {
  return `<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${text}
    ${hint ? `<div style="margin-top:8px;opacity:.7;font-size:12.5px">${hint}</div>` : ''}</div></div>`;
}
function emptyInline(icon, text) {
  return `<div style="text-align:center;padding:26px 10px;color:var(--ink-faint)">
    <div style="font-size:30px;opacity:.4">${icon}</div><div style="font-size:12.5px;margin-top:5px">${text}</div></div>`;
}
