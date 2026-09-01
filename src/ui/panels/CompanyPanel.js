import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { formatMoneyExact, formatWeight, formatTime, clamp01 } from '../../util/math.js';
import { REGIONS, REGION_BY_ID } from '../../data/regions.js';

/**
 * The company hub: overview, workers, hiring, boats, fleets, research,
 * contracts and finances. Renders live data from the owning systems —
 * every number here is produced by real simulation.
 */
export class CompanyPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'company', title: '🏢 Fish Company', width: 'wide',
      tabs: [
        { id: 'overview', name: 'Overview', icon: '📊' },
        { id: 'workers', name: 'Workers', icon: '👷' },
        { id: 'hire', name: 'Hire', icon: '📋' },
        { id: 'boats', name: 'Boats', icon: '🚤' },
        { id: 'fleets', name: 'Fleets', icon: '⚓' },
        { id: 'research', name: 'Research', icon: '🔬' },
        { id: 'harbor', name: 'Harbor', icon: '🏗' },
        { id: 'finances', name: 'Finances', icon: '💰' },
      ],
    });
    this.live = true;
    this.selectedWorker = null;
    this.selectedBoat = null;
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const eco = g.get('economy');
    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800;font-size:17px">${formatMoneyExact(eco?.money || 0)}</span>`);

    const workers = g.get('workers');
    const boats = g.get('boats');
    const fleets = g.get('fleets');
    const research = g.get('research');
    const harbor = g.get('harbor');

    switch (this.activeTab) {
      case 'overview': this.renderOverview(g, eco, workers, boats, fleets); break;
      case 'workers': this.renderWorkers(g, workers); break;
      case 'hire': this.renderHire(g, workers, eco); break;
      case 'boats': this.renderBoats(g, boats, eco); break;
      case 'fleets': this.renderFleets(g, fleets, workers, boats); break;
      case 'research': this.renderResearch(g, research, eco); break;
      case 'harbor': this.renderHarbor(g, harbor, eco); break;
      case 'finances': this.renderFinances(g, eco); break;
    }

    this.onAction((act, ds) => {
      bus.emit(`company:${act}`, { ...ds, panel: this });
      // Local UI-only actions.
      if (act === 'selectWorker') { this.selectedWorker = ds.id; this.render(); }
      if (act === 'selectBoat') { this.selectedBoat = ds.id; this.render(); }
      if (act === 'tab') { this.activeTab = ds.id; this.render(); }
      setTimeout(() => { if (this.open) this.render(); }, 30);
    });
  }

  empty(icon, text, hint) {
    return `<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${text}
      ${hint ? `<div style="margin-top:8px;opacity:.7;font-size:12.5px">${hint}</div>` : ''}</div></div>`;
  }

  renderOverview(g, eco, workers, boats, fleets) {
    const wCount = workers?.workers.length || 0;
    const bCount = boats?.owned.length || 0;
    const fCount = fleets?.fleets.length || 0;
    const wages = workers?.dailyWages() || 0;
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;
    this.bodyEl.innerHTML = `<div class="grid c3">
      <div class="card"><div class="card-title">💰 Finances</div>
        ${line('Cash', formatMoneyExact(eco.money), 'gold')}
        ${line('Today revenue', formatMoneyExact(eco.today.revenue), 'good')}
        ${line('Today expenses', formatMoneyExact(eco.today.expenses), 'bad')}
        ${line('Today profit', formatMoneyExact(eco.dailyProfit), eco.dailyProfit >= 0 ? 'good' : 'bad')}
        ${line('Daily wages', formatMoneyExact(wages), 'bad')}
        ${line('Lifetime revenue', formatMoneyExact(eco.lifetimeRevenue))}
      </div>
      <div class="card"><div class="card-title">👷 Crew</div>
        ${line('Workers', wCount)}
        ${line('Idle', workers?.workers.filter((w) => !w.assignment).length || 0)}
        ${line('Working', workers?.workers.filter((w) => w.assignment).length || 0)}
        ${line('Avg level', wCount ? (workers.workers.reduce((a, w) => a + w.level, 0) / wCount).toFixed(1) : '—')}
        ${line('Avg morale', wCount ? `${Math.round(workers.workers.reduce((a, w) => a + w.morale, 0) / wCount * 100)}%` : '—')}
      </div>
      <div class="card"><div class="card-title">⚓ Fleet</div>
        ${line('Boats', bCount)}
        ${line('Fleets', fCount)}
        ${line('At sea', fleets?.fleets.filter((f) => f.state !== 'docked').length || 0)}
        ${line('Submarines', g.get('subs')?.owned.length || 0)}
        ${line('Cargo at sea', formatWeight(fleets?.totalCargo?.() || 0))}
      </div>
      <div class="card" style="grid-column:span 3"><div class="card-title">📈 Live operations</div>
        ${fleets?.fleets.length
          ? fleets.fleets.map((f) => `<div class="list-row">
              <span class="lr-icon">${f.state === 'docked' ? '⚓' : '🚤'}</span>
              <div class="lr-main"><div class="lr-title">${f.name}</div>
                <div class="lr-sub">${f.stateLabel || f.state} · ${f.crew.length} crew · ${REGION_BY_ID[f.targetRegion]?.name || '—'}</div>
                <div class="progress" style="margin-top:4px"><i style="width:${clamp01(f.progress || 0) * 100}%"></i></div></div>
              <div class="lr-right">${formatWeight(f.cargoWeight || 0)}<br><span style="color:var(--gold)">${formatMoneyExact(f.cargoValue || 0)}</span></div>
            </div>`).join('')
          : this.empty('⚓', 'No fleets at sea.', 'Buy a boat, hire a captain, then create a fleet.')}
      </div>
    </div>`;
    this.setFoot('');
  }

  renderWorkers(g, workers) {
    if (!workers?.workers.length) {
      this.bodyEl.innerHTML = this.empty('👷', 'You have no employees.',
        'Visit the Hire tab (or the employment office at the harbour) to hire your first fisherman.');
      this.setFoot('');
      return;
    }
    const sel = workers.workers.find((w) => w.id === this.selectedWorker) || workers.workers[0];
    this.bodyEl.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1.2fr;gap:14px">
      <div class="scroll-y" style="max-height:56vh">
        ${workers.workers.map((w) => `<div class="list-row ${w.id === sel.id ? 'selected' : ''}" data-action="selectWorker" data-id="${w.id}">
          <span class="lr-icon">${w.icon || '👷'}</span>
          <div class="lr-main"><div class="lr-title">${w.name} <span class="chip">Lv ${w.level}</span></div>
            <div class="lr-sub">${w.roleName} · ${w.assignmentLabel || 'Idle'}</div></div>
          <div class="lr-right">${formatMoneyExact(w.wage)}/d<br>
            <span style="color:${w.morale > 0.6 ? 'var(--good)' : w.morale > 0.3 ? 'var(--warn)' : 'var(--danger)'}">${Math.round(w.morale * 100)}%</span></div>
        </div>`).join('')}
      </div>
      ${this.workerDetail(g, workers, sel)}
    </div>`;
    this.setFoot(`<span style="color:var(--ink-faint)">${workers.workers.length} employees · ${formatMoneyExact(workers.dailyWages())}/day in wages</span>`);
  }

  workerDetail(g, workers, w) {
    if (!w) return '';
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;
    const xpPct = clamp01(w.xp / w.xpToNext) * 100;
    return `<div class="card">
      <div class="card-title" style="font-size:18px">${w.icon || '👷'} ${w.name}</div>
      <div class="card-desc">${w.roleName} · Level ${w.level}</div>
      <div class="progress xp" style="margin:8px 0"><i style="width:${xpPct}%"></i></div>
      <div class="lr-sub" style="margin-bottom:9px">${Math.floor(w.xp)} / ${w.xpToNext} XP</div>
      ${Object.entries(w.skills).map(([k, v]) => line(cap(k), `${v}`)).join('')}
      ${line('Wage', `${formatMoneyExact(w.wage)}/day`, 'bad')}
      ${line('Morale', `${Math.round(w.morale * 100)}%`, w.morale > 0.6 ? 'good' : 'bad')}
      ${line('Fish caught', w.stats?.caught || 0)}
      ${line('Revenue generated', formatMoneyExact(w.stats?.revenue || 0), 'gold')}
      <div style="margin-top:9px">${(w.traits || []).map((t) => `<span class="chip ${t.good ? 'good' : t.good === false ? 'bad' : ''}" title="${t.desc}">${t.name}</span>`).join(' ')}</div>
      <div style="margin-top:12px">
        <div class="card-title" style="font-size:13px">Assignment</div>
        <select data-action="assign" data-id="${w.id}" style="width:100%;background:var(--bg-1);border:1px solid var(--line);border-radius:5px;padding:6px;margin-top:5px">
          ${(workers.assignmentOptions(w) || []).map((o) =>
            `<option value="${o.id}" ${w.assignment === o.id ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
      </div>
      <div class="card-row">
        <button class="btn sm" data-action="equipWorker" data-id="${w.id}">Equipment</button>
        <button class="btn sm" data-action="trainWorker" data-id="${w.id}">Train (${formatMoneyExact(w.trainCost || 500)})</button>
        <button class="btn sm danger" data-action="fireWorker" data-id="${w.id}">Fire</button>
      </div>
    </div>`;
  }

  renderHire(g, workers, eco) {
    if (!workers) { this.bodyEl.innerHTML = this.empty('📋', 'Hiring is not available yet.'); return; }
    if (!workers.hiringUnlocked) {
      this.bodyEl.innerHTML = this.empty('🔒', 'The employment office is not open yet.',
        workers.unlockHint || 'Reach the harbour and build the employment office to hire staff.');
      this.setFoot('');
      return;
    }
    const cands = workers.candidates || [];
    this.bodyEl.innerHTML = `<div class="grid auto">${cands.map((c) => `
      <div class="card hover">
        <div class="card-title">${c.icon || '👷'} ${c.name} <span class="chip">Lv ${c.level}</span></div>
        <div class="card-desc">${c.roleName}</div>
        <div class="card-stats">${Object.entries(c.skills).map(([k, v]) => `${cap(k)}: <b>${v}</b>`).join('<br>')}</div>
        <div style="margin-top:7px">${(c.traits || []).map((t) => `<span class="chip ${t.good ? 'good' : t.good === false ? 'bad' : ''}" title="${t.desc}">${t.name}</span>`).join(' ')}</div>
        <div class="card-row">
          <span class="card-price">${formatMoneyExact(c.wage)}/day<br><span style="font-size:11px;color:var(--ink-faint)">hire fee ${formatMoneyExact(c.hireCost)}</span></span>
          <button class="btn sm ${eco.money >= c.hireCost ? 'gold' : ''}" data-action="hire" data-id="${c.id}" ${eco.money >= c.hireCost ? '' : 'disabled'}>Hire</button>
        </div>
      </div>`).join('') || this.empty('📋', 'No candidates right now.', 'New applicants arrive each day.')}</div>`;
    this.setFoot(`<button class="btn" data-action="refreshCandidates">Refresh applicants (${formatMoneyExact(workers.refreshCost || 100)})</button>
      <div style="flex:1"></div><span style="color:var(--ink-faint)">${workers.workers.length} / ${workers.maxWorkers} employees</span>`);
  }

  renderBoats(g, boats, eco) {
    if (!boats) { this.bodyEl.innerHTML = this.empty('🚤', 'Boats are not available yet.'); return; }
    const owned = boats.owned || [];
    const catalogue = boats.catalogue || [];
    this.bodyEl.innerHTML = `
      ${owned.length ? `<div class="card-title" style="margin-bottom:9px">Your boats</div>
      <div class="grid auto" style="margin-bottom:18px">${owned.map((b) => `
        <div class="card owned">
          <div class="card-title">${b.icon || '🚤'} ${b.name}</div>
          <div class="card-desc">${b.def.name}</div>
          <div class="card-stats">
            Speed: <b>${b.def.speed}</b><br>Storage: <b>${formatWeight(b.def.storage)}</b><br>
            Crew: <b>${b.def.crew}</b><br>Fuel: <b>${Math.round(b.fuel)}/${b.def.fuel}</b><br>
            Hull: <b>${Math.round(b.health)}%</b><br>Location: <b>${b.locationLabel || 'Docked'}</b>
          </div>
          <div class="card-row">
            <button class="btn sm" data-action="upgradeBoat" data-id="${b.id}">Upgrade</button>
            <button class="btn sm" data-action="repairBoat" data-id="${b.id}">Repair</button>
            <button class="btn sm" data-action="refuelBoat" data-id="${b.id}">Refuel</button>
          </div>
        </div>`).join('')}</div>` : ''}
      <div class="card-title" style="margin-bottom:9px">Shipyard</div>
      <div class="grid auto">${catalogue.map((d) => {
        const locked = !boats.isUnlocked(d);
        const afford = eco.money >= d.price;
        return `<div class="card hover ${locked ? 'locked' : ''}">
          <div class="card-title">${d.icon} ${d.name}</div>
          <div class="card-desc">${d.desc}</div>
          <div class="card-stats">
            Speed: <b>${d.speed}</b><br>Storage: <b>${formatWeight(d.storage)}</b><br>
            Crew: <b>${d.crew}</b><br>Fuel: <b>${d.fuel}</b><br>Range: <b>${d.range} m</b>
          </div>
          <div class="card-row">
            <span class="card-price ${afford ? '' : 'cant'}">${formatMoneyExact(d.price)}</span>
            ${locked ? `<span class="chip">${d.unlockHint || 'Locked'}</span>`
              : `<button class="btn sm ${afford ? 'gold' : ''}" data-action="buyBoat" data-id="${d.id}" ${afford ? '' : 'disabled'}>Buy</button>`}
          </div>
        </div>`;
      }).join('')}</div>`;
    this.setFoot('');
  }

  renderFleets(g, fleets, workers, boats) {
    if (!fleets) { this.bodyEl.innerHTML = this.empty('⚓', 'Fleets are not available yet.'); return; }
    this.bodyEl.innerHTML = `
      ${fleets.fleets.length ? `<div class="grid c2" style="margin-bottom:16px">${fleets.fleets.map((f) => `
        <div class="card">
          <div class="card-title">${f.name} <span class="chip ${f.state === 'docked' ? '' : 'good'}">${f.stateLabel || f.state}</span></div>
          <div class="card-desc">${f.boat?.name || 'No boat'} · ${f.crew.length}/${f.boat?.def.crew || 0} crew</div>
          <div class="progress" style="margin:8px 0"><i style="width:${clamp01(f.progress || 0) * 100}%"></i></div>
          <div class="card-stats">
            Target: <b>${REGION_BY_ID[f.targetRegion]?.name || '—'}</b><br>
            Cargo: <b>${formatWeight(f.cargoWeight || 0)}</b> / ${formatWeight(f.boat?.def.storage || 0)}<br>
            Value: <b style="color:var(--gold)">${formatMoneyExact(f.cargoValue || 0)}</b><br>
            Fuel: <b>${Math.round(f.boat?.fuel || 0)}</b><br>
            Trips: <b>${f.trips || 0}</b> · Profit: <b style="color:var(--gold)">${formatMoneyExact(f.lifetimeProfit || 0)}</b>
          </div>
          <div style="margin-top:8px">${f.crew.map((w) => `<span class="chip">${w.name} (${w.roleName})</span>`).join(' ')}</div>
          <div class="card-row">
            ${f.state === 'docked'
              ? `<button class="btn sm primary" data-action="launchFleet" data-id="${f.id}">Launch</button>`
              : `<button class="btn sm" data-action="recallFleet" data-id="${f.id}">Recall</button>`}
            <button class="btn sm" data-action="editFleet" data-id="${f.id}">Edit</button>
            <button class="btn sm danger" data-action="disbandFleet" data-id="${f.id}">Disband</button>
          </div>
        </div>`).join('')}</div>` : this.empty('⚓', 'No fleets yet.', 'A fleet needs a boat, a captain and at least one fisherman.')}
      <button class="btn primary" data-action="newFleet">+ Create Fleet</button>`;
    this.setFoot('');
  }

  renderResearch(g, research, eco) {
    if (!research) { this.bodyEl.innerHTML = this.empty('🔬', 'Research is not available yet.'); return; }
    const branches = research.branches || [];
    this.bodyEl.innerHTML = `<div class="grid c2">${branches.map((br) => `
      <div class="card"><div class="card-title">${br.icon} ${br.name}</div>
        <div class="card-desc">${br.desc}</div>
        <div style="margin-top:9px">${br.nodes.map((n) => {
          const owned = research.has(n.id);
          const avail = research.available(n.id);
          return `<div class="list-row ${owned ? 'selected' : ''}" ${owned || !avail ? '' : `data-action="research" data-id="${n.id}"`}
            style="${avail || owned ? '' : 'opacity:.4'};cursor:${avail && !owned ? 'pointer' : 'default'}">
            <span class="lr-icon">${owned ? '✅' : avail ? '🔓' : '🔒'}</span>
            <div class="lr-main"><div class="lr-title">${n.name}</div><div class="lr-sub">${n.desc}</div></div>
            <div class="lr-right">${owned ? '<span class="chip good">Done</span>'
              : `<span style="color:${eco.money >= n.cost ? 'var(--gold)' : 'var(--danger)'}">${formatMoneyExact(n.cost)}</span>`}</div>
          </div>`;
        }).join('')}</div>
      </div>`).join('')}</div>`;
    this.setFoot(`<span style="color:var(--ink-faint)">${research.unlocked.size} / ${research.total} technologies unlocked</span>`);
  }

  renderHarbor(g, harbor, eco) {
    if (!harbor) { this.bodyEl.innerHTML = this.empty('🏗', 'Harbour expansion is not available yet.'); return; }
    this.bodyEl.innerHTML = `<div class="grid auto">${(harbor.catalogue || []).map((b) => {
      const built = harbor.has(b.id);
      const avail = harbor.available(b.id);
      const afford = eco.money >= b.cost;
      return `<div class="card ${built ? 'owned' : avail ? 'hover' : 'locked'}">
        <div class="card-title">${b.icon} ${b.name}</div>
        <div class="card-desc">${b.desc}</div>
        <div class="card-stats">${(b.effects || []).join('<br>')}</div>
        <div class="card-row">
          <span class="card-price ${afford ? '' : 'cant'}">${formatMoneyExact(b.cost)}</span>
          ${built ? '<span class="chip good">Built</span>'
            : avail ? `<button class="btn sm ${afford ? 'gold' : ''}" data-action="build" data-id="${b.id}" ${afford ? '' : 'disabled'}>Build</button>`
            : `<span class="chip">${b.reqHint || 'Locked'}</span>`}
        </div>
      </div>`;
    }).join('')}</div>`;
    this.setFoot('');
  }

  renderFinances(g, eco) {
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;
    const hist = eco.history.slice(-14);
    const maxV = Math.max(1, ...hist.map((h) => Math.max(h.revenue, h.expenses)));
    this.bodyEl.innerHTML = `<div class="grid c2">
      <div class="card"><div class="card-title">Today (day ${eco.day})</div>
        ${line('Revenue', formatMoneyExact(eco.today.revenue), 'good')}
        ${line('Expenses', formatMoneyExact(eco.today.expenses), 'bad')}
        ${line('Profit', formatMoneyExact(eco.dailyProfit), eco.dailyProfit >= 0 ? 'good' : 'bad')}
        ${line('Fish sold', eco.today.sold)}
        ${line('Market index', `${(eco.marketMult * 100).toFixed(0)}%`, eco.marketMult > 1 ? 'good' : 'bad')}
      </div>
      <div class="card"><div class="card-title">Lifetime</div>
        ${line('Revenue', formatMoneyExact(eco.lifetimeRevenue), 'gold')}
        ${line('Expenses', formatMoneyExact(eco.lifetimeExpenses), 'bad')}
        ${line('Net', formatMoneyExact(eco.lifetimeRevenue - eco.lifetimeExpenses))}
        ${line('Best fish', eco.stats.mostValuable ? `${eco.stats.mostValuable.name} ${formatMoneyExact(eco.stats.mostValuable.value)}` : '—')}
        ${line('Net worth', formatMoneyExact(eco.netWorth), 'gold')}
      </div>
      <div class="card" style="grid-column:span 2"><div class="card-title">Last ${hist.length} days</div>
        <div style="display:flex;align-items:flex-end;gap:5px;height:120px;margin-top:9px">
          ${hist.map((h) => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:2px" title="Day ${h.day}: +${formatMoneyExact(h.revenue)} / -${formatMoneyExact(h.expenses)}">
            <div style="height:${(h.revenue / maxV) * 90}px;background:var(--good);border-radius:2px 2px 0 0"></div>
            <div style="height:${(h.expenses / maxV) * 90}px;background:var(--danger);border-radius:0 0 2px 2px"></div>
          </div>`).join('') || '<div class="lr-sub">No history yet</div>'}
        </div>
      </div>
      <div class="card" style="grid-column:span 2"><div class="card-title">Revenue by source (today)</div>
        ${Object.entries(eco.today.byReason).sort((a, b) => b[1] - a[1])
          .map(([k, v]) => line(cap(k.replace(/_/g, ' ')), formatMoneyExact(v), v >= 0 ? 'good' : 'bad')).join('') || '<div class="lr-sub">No activity yet</div>'}
      </div>
    </div>`;
    this.setFoot('');
  }
}

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }
