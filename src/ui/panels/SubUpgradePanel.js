import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { SUB_UPGRADES, subUpgradeCost, subUpgradeValue } from '../../data/submarines.js';
import { formatMoneyExact, formatWeight, formatTime, clamp01 } from '../../util/math.js';

/** Refit bay for one submarine: pressure hull, power, optics and the arm. */
export class SubUpgradePanel extends Panel {
  constructor(game) {
    super(game, { id: 'subUpgrade', title: '🔧 Sub Refit', width: '' });
    this.live = true;
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const subs = g.get('subs');
    const eco = g.get('economy');
    const research = g.get('research');
    const s = subs?.byId(this.data?.id) || subs?.owned[0];
    if (!s) {
      this.bodyEl.innerHTML = '<div class="empty-state"><div class="es-icon">🌊</div><div class="es-text">No submarine selected.</div></div>';
      this.setFoot('');
      return;
    }

    this.el.querySelector('.panel-head h2').textContent = `🔧 ${s.icon} ${s.name}`;
    this.setSubtitle(`${s.def.name} · ${s.locationLabel}`);
    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800">${formatMoneyExact(eco.money)}</span>`);

    const st = s.stats;
    const hull = clamp01(s.hull / st.hullStrength);
    const power = clamp01(s.battery / st.battery);
    // Research certifies hulls deeper than the catalogue rating, so quote what
    // the sub may actually dive to rather than the number on the tin.
    const crush = subs.crushDepthOf(s);
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;

    this.bodyEl.innerHTML = `
      <div class="card" style="margin-bottom:12px"><div class="card-title">Current stats</div>
        <div class="grid c4">
          ${line('Crush depth', `${Math.round(crush)} m`)}
          ${line('Hull', `${Math.round(s.hull)}/${Math.round(st.hullStrength)}`, hull > 0.6 ? 'good' : 'bad')}
          ${line('Power', `${Math.round(s.battery)}/${Math.round(st.battery)}`, power > 0.3 ? 'good' : 'bad')}
          ${line('Air', formatTime(s.oxygen))}
          ${line('Speed', `${st.speed.toFixed(1)} m/s`)}
          ${line('Ascent', `${st.ascendRate.toFixed(1)} m/s`)}
          ${line('Hold', `${formatWeight(s.cargoWeight)} / ${formatWeight(st.cargo)}`)}
          ${line('Crew', Math.round(st.crew))}
          ${line('Sonar', `${Math.round(st.sonarRange)} m · tier ${subs.sonarDetailOf(s)}`)}
          ${line('Lights', `${Math.round(st.lightRange)} m`)}
          ${line('Arm reach', `${st.grabRange.toFixed(1)} m`)}
          ${line('Lifetime profit', formatMoneyExact(s.lifetimeProfit), 'gold')}
        </div>
      </div>
      <div class="grid auto">${SUB_UPGRADES.map((u) => {
        const lvl = s.upgrades[u.id] || 0;
        const maxed = lvl >= u.max;
        const cost = subUpgradeCost(u.id, lvl);
        const afford = eco.money >= cost;
        const locked = u.requiresResearch && research && !research.has(u.requiresResearch);
        const req = research?.node?.(u.requiresResearch)?.name || u.requiresResearch;
        return `<div class="card ${maxed ? 'owned' : locked ? 'locked' : 'hover'}">
          <div class="card-title"><span class="card-icon">${u.icon}</span>${u.name}
            <span class="chip">${lvl}/${u.max}</span></div>
          <div class="card-desc">${u.desc}</div>
          <div class="progress" style="margin-top:8px"><i style="width:${(lvl / u.max) * 100}%"></i></div>
          <div class="card-row">
            <span class="card-price ${afford ? '' : 'cant'}">${maxed ? '—' : formatMoneyExact(cost)}</span>
            ${maxed ? '<span class="chip good">Maxed</span>'
              : locked ? `<span class="chip">Needs ${req}</span>`
              : `<button class="btn sm ${afford ? 'gold' : ''}" data-action="up" data-id="${u.id}" ${afford ? '' : 'disabled'}>Upgrade</button>`}
          </div>
        </div>`;
      }).join('')}</div>`;

    this.setFoot(`<button class="btn" data-action="repair">Repair hull</button>
      <button class="btn" data-action="recharge">Recharge</button>
      <div style="flex:1"></div>
      <button class="btn danger" data-action="sell">Sell sub (${formatMoneyExact(Math.round((s.def.price + subUpgradeValue(s.upgrades)) * 0.5))})</button>`);

    this.onAction((act, ds) => {
      if (act === 'up') bus.emit('company:upgradeSubApply', { id: s.id, upgrade: ds.id });
      else if (act === 'repair') bus.emit('company:repairSub', { id: s.id });
      else if (act === 'recharge') bus.emit('company:rechargeSub', { id: s.id });
      else if (act === 'sell') { if (confirm(`Sell ${s.name}?`)) { subs.sell(s.id); this.close(); } }
      setTimeout(() => { if (this.open) this.render(); }, 40);
    });
  }
}
