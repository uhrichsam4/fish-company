import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { DEPTH_BANDS } from '../../submarines/SubSystem.js';
import { formatMoneyExact, formatWeight, formatTime, clamp, clamp01 } from '../../util/math.js';

/** Everything the sub is rated for stops at 92% of crush depth — see startExpedition. */
const BAND_MARGIN = 0.92;
/** startExpedition refuses to certify a hull below this fraction. */
const MIN_HULL = 0.35;

/**
 * Plan an autonomous dive: pick a sub, a depth band and a crew, read the
 * briefing, launch. The fleet equivalent is FleetEditorPanel and this follows
 * the same three-column shape, but a sub expedition is one-shot — there is no
 * standing "sub fleet" to edit, so confirming launches immediately.
 */
export class SubExpeditionPanel extends Panel {
  constructor(game) {
    super(game, { id: 'subExpedition', title: '🌊 Plan Expedition', width: '' });
    this.live = false;
    this.sel = { subId: null, band: null, crew: new Set() };
  }

  show() {
    const subs = this.game.get('subs');
    const ready = (subs?.owned || []).filter((s) => !s.expedition && subs.driving !== s);
    this.sel = {
      subId: ready.some((s) => s.id === this.data?.id) ? this.data.id : (ready[0]?.id || null),
      band: null,
      crew: new Set(),
    };
    super.show();
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const subs = g.get('subs');
    const workers = g.get('workers');
    const eco = g.get('economy');
    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800">${formatMoneyExact(eco?.money || 0)}</span>`);

    if (!subs?.owned.length) {
      this.bodyEl.innerHTML = `<div class="empty-state"><div class="es-icon">🌊</div><div class="es-text">You own no submarines.
        <div style="margin-top:8px;opacity:.7;font-size:12.5px">Buy one in the Subs tab of the company panel first.</div></div></div>`;
      this.setFoot('');
      return;
    }

    // A sub already out, or one the player is sitting in, cannot be dispatched.
    const fleet = subs.owned.filter((s) => !s.expedition && subs.driving !== s);
    const s = fleet.find((x) => x.id === this.sel.subId) || null;
    const crush = s ? subs.crushDepthOf(s) : 0;
    const free = (workers?.workers || []).filter((w) => !w.fleet && !w.subExpedition);
    const crew = [...this.sel.crew].map((id) => workers?.byId(id)).filter(Boolean);
    const band = DEPTH_BANDS.find((b) => b.id === this.sel.band) || null;

    // The pilot rule only bites once the company has staff at all: a one-seat
    // scout owned by a company with no employees dives on its own.
    const needsPilot = !!workers?.workers.length;
    const hasPilot = crew.some((w) => w.role === 'subpilot' || w.role === 'captain');
    const overCrew = s ? crew.length > s.stats.crew : false;
    const hullOk = s ? s.hull >= s.stats.hullStrength * MIN_HULL : false;
    const rated = s && band ? band.depth <= crush * BAND_MARGIN : false;
    const plan = s && band ? project(subs, s, band, crew) : null;

    this.bodyEl.innerHTML = `
      <div class="grid c3">
        <div class="card"><div class="card-title">1 · Submarine</div>
          ${fleet.length ? fleet.map((x) => `
            <div class="list-row ${x.id === this.sel.subId ? 'selected' : ''}" data-action="pickSub" data-id="${x.id}" style="cursor:pointer">
              <span class="lr-icon">${x.icon}</span>
              <div class="lr-main"><div class="lr-title">${x.name}</div>
                <div class="lr-sub">${x.def.name} · ${Math.round(subs.crushDepthOf(x))} m · ${Math.round(x.stats.crew)} seats</div></div>
              <div class="lr-right">${Math.round(clamp01(x.hull / x.stats.hullStrength) * 100)}%<br>
                <span style="color:var(--gold)">${Math.round(clamp01(x.battery / x.stats.battery) * 100)}%</span></div>
            </div>`).join('')
            : '<div class="lr-sub">Every sub is out or in use. Recall one first.</div>'}
        </div>
        <div class="card"><div class="card-title">2 · Depth band</div>
          ${DEPTH_BANDS.map((b) => {
            const tooDeep = s ? b.depth > crush * BAND_MARGIN : false;
            return `<div class="list-row ${b.id === this.sel.band ? 'selected' : ''}"
              data-action="pickBand" data-id="${b.id}" style="cursor:pointer;${tooDeep ? 'opacity:.45' : ''}">
              <span class="lr-icon">🌊</span>
              <div class="lr-main"><div class="lr-title">${b.name}</div>
                <div class="lr-sub">${b.depth} m · risk ${riskLabel(b.risk)}${tooDeep ? ' · beyond hull rating' : ''}</div></div>
              <div class="lr-right">×${b.valueMult}</div>
            </div>`;
          }).join('')}
        </div>
        <div class="card"><div class="card-title">3 · Crew ${s ? `<span class="chip ${overCrew ? 'bad' : ''}">${crew.length}/${Math.round(s.stats.crew)}</span>` : ''}</div>
          ${free.length ? free.map((w) => `
            <div class="list-row ${this.sel.crew.has(w.id) ? 'selected' : ''}" data-action="toggleCrew" data-id="${w.id}" style="cursor:pointer">
              <span class="lr-icon">${w.icon}</span>
              <div class="lr-main"><div class="lr-title">${w.name}</div>
                <div class="lr-sub">${w.roleName} · Lv ${w.level} · ${formatMoneyExact(w.wage)}/d</div></div>
              ${this.sel.crew.has(w.id) ? '<span class="chip good">On</span>' : ''}
            </div>`).join('')
            : '<div class="lr-sub">No free crew. An expedition needs a sub pilot or a captain once you employ anyone.</div>'}
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-title">Briefing</div>
        <div class="grid c4">
          <div class="stat-line"><span class="sl-k">Sub</span><span class="sl-v">${s?.name || '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Band</span><span class="sl-v ${band && !rated ? 'bad' : ''}">${band?.name || '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Depth</span><span class="sl-v">${band ? `${band.depth} m` : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Crush rating</span><span class="sl-v ${band && !rated ? 'bad' : 'good'}">${s ? `${Math.round(crush)} m` : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Round trip</span><span class="sl-v">${plan ? formatTime(plan.total) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">On station</span><span class="sl-v">${plan ? formatTime(plan.durations.survey) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Pilot</span><span class="sl-v ${hasPilot ? 'good' : needsPilot ? 'bad' : ''}">${hasPilot ? 'Aboard' : needsPilot ? 'Required' : 'Not needed'}</span></div>
          <div class="stat-line"><span class="sl-k">Hull</span><span class="sl-v ${hullOk ? 'good' : 'bad'}">${s ? `${Math.round(clamp01(s.hull / s.stats.hullStrength) * 100)}%` : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Est. specimens</span><span class="sl-v">${plan ? Math.round(plan.specimens) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Est. salvage</span><span class="sl-v gold">${plan ? formatMoneyExact(Math.round(plan.cash)) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Est. hull cost</span><span class="sl-v bad">${plan ? `−${Math.round(plan.hullLoss)}` : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Power</span><span class="sl-v ${plan && plan.powerDraw > s.battery ? 'bad' : ''}">${plan ? `${Math.round(plan.powerDraw)} / ${Math.round(s.battery)}` : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Hold</span><span class="sl-v">${s ? formatWeight(s.stats.cargo) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Risk</span><span class="sl-v">${band ? riskLabel(band.risk) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Daily wages</span><span class="sl-v bad">${formatMoneyExact(crew.reduce((a, w) => a + w.wage, 0))}</span></div>
          <div class="stat-line"><span class="sl-k">Value multiplier</span><span class="sl-v gold">×${band?.valueMult || '—'}</span></div>
        </div>
        ${plan && plan.powerDraw > s.battery
          ? '<div class="lr-sub" style="margin-top:8px;color:var(--warn)">She will surface early on a flat battery — recharge her in the refit bay first.</div>' : ''}
      </div>`;

    const ready = !!s && !!band && rated && hullOk && !overCrew && (!needsPilot || hasPilot);
    this.setFoot(`
      <span style="color:var(--ink-faint);font-size:12.5px">${readyHint(s, band, { rated, hullOk, overCrew, needsPilot, hasPilot })}</span>
      <div style="flex:1"></div>
      <button class="btn primary" data-action="launch" ${ready ? '' : 'disabled'}>Dive</button>`);

    this.onAction((act, ds) => {
      if (act === 'pickSub') { this.sel.subId = ds.id; this.render(); }
      else if (act === 'pickBand') { this.sel.band = ds.id; this.render(); }
      else if (act === 'toggleCrew') {
        if (this.sel.crew.has(ds.id)) this.sel.crew.delete(ds.id); else this.sel.crew.add(ds.id);
        this.render();
      } else if (act === 'launch') {
        bus.emit('company:launchExpedition', { subId: this.sel.subId, crewIds: [...this.sel.crew], band: this.sel.band });
        this.close();
        setTimeout(() => bus.emit('ui:show', { id: 'company', data: { tab: 'subs' } }), 120);
      }
    });
  }
}

/**
 * The briefing numbers. Durations and the event rate come straight from the
 * SubSystem, but the payout odds are averages of its own dice rolls — this is
 * an estimate to plan against, not a contract.
 */
function project(subs, s, band, crew) {
  const st = s.stats;
  const pilot = crew.find((w) => w.role === 'subpilot') || crew.find((w) => w.role === 'captain');
  const sonarOp = crew.find((w) => w.role === 'sonar');
  const diver = crew.find((w) => w.role === 'diver' || w.role === 'hunter');
  const durations = subs.expeditionDurations(s, band);
  const total = Object.values(durations).reduce((a, b) => a + b, 0);
  const rate = subs.expeditionRate({ sub: s, pilot, sonarOp, diver });
  const events = Math.max(1, Math.floor(durations.survey / clamp(16 / rate, 4, 40)));
  const salvage = events * 0.16 * band.valueMult * 3050 * (1 + (st.armTier || 0) * 0.4);
  const discoveries = Math.min(4, events * 0.10);
  return {
    durations, total, events,
    specimens: events * 0.62,
    cash: salvage + discoveries * band.valueMult * 2400,
    hullLoss: events * 0.12 * st.hullStrength * 0.05 * band.risk * 0.9 * (pilot ? 0.75 : 1.15),
    powerDraw: st.batteryUse * (0.55 * durations.descent + 0.85 * durations.survey + 0.45 * durations.ascent),
  };
}

function riskLabel(risk) {
  return risk < 0.3 ? 'low' : risk < 0.6 ? 'moderate' : risk < 1.0 ? 'high' : risk < 1.6 ? 'severe' : 'extreme';
}

function readyHint(s, band, f) {
  if (!s) return 'Pick a submarine.';
  if (!f.hullOk) return 'Her hull is too damaged to certify — repair her first.';
  if (!band) return 'Pick a depth band.';
  if (!f.rated) return 'That band is deeper than this hull is rated for.';
  if (f.overCrew) return 'Too many crew for the seats aboard.';
  if (f.needsPilot && !f.hasPilot) return 'An expedition needs a sub pilot (or a captain).';
  return 'Ready to dive.';
}
