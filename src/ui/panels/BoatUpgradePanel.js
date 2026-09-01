import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { BOAT_UPGRADES, upgradeCost, effectiveStats } from '../../data/boats.js';
import { formatMoneyExact, formatWeight } from '../../util/math.js';

export class BoatUpgradePanel extends Panel {
  constructor(game) {
    super(game, { id: 'boatUpgrade', title: '🔧 Boat Upgrades', width: '' });
    this.live = true;
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const boats = g.get('boats');
    const eco = g.get('economy');
    const research = g.get('research');
    const b = boats?.byId(this.data?.id) || boats?.owned[0];
    if (!b) { this.bodyEl.innerHTML = '<div class="empty-state"><div class="es-icon">🚤</div><div class="es-text">No boat selected.</div></div>'; return; }

    this.el.querySelector('.panel-head h2').textContent = `🔧 ${b.name}`;
    this.setSubtitle(b.def.name);
    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800">${formatMoneyExact(eco.money)}</span>`);

    const s = b.stats;
    this.bodyEl.innerHTML = `
      <div class="card" style="margin-bottom:12px"><div class="card-title">Current stats</div>
        <div class="grid c4">
          <div class="stat-line"><span class="sl-k">Speed</span><span class="sl-v">${s.speed.toFixed(1)} m/s</span></div>
          <div class="stat-line"><span class="sl-k">Storage</span><span class="sl-v">${formatWeight(s.storage)}</span></div>
          <div class="stat-line"><span class="sl-k">Crew</span><span class="sl-v">${s.crew}</span></div>
          <div class="stat-line"><span class="sl-k">Fuel</span><span class="sl-v">${Math.round(b.fuel)}/${Math.round(s.fuel)}</span></div>
          <div class="stat-line"><span class="sl-k">Hull</span><span class="sl-v ${b.health > 60 ? 'good' : 'bad'}">${Math.round(b.health)}%</span></div>
          <div class="stat-line"><span class="sl-k">Sonar</span><span class="sl-v">${s.sonar}</span></div>
          <div class="stat-line"><span class="sl-k">Range</span><span class="sl-v">${Math.round(s.range)} m</span></div>
          <div class="stat-line"><span class="sl-k">Catch rate</span><span class="sl-v">${(s.catchRate * 100).toFixed(0)}%</span></div>
        </div>
      </div>
      <div class="grid auto">${BOAT_UPGRADES.map((u) => {
        const lvl = b.upgrades[u.id] || 0;
        const maxed = lvl >= u.max;
        const cost = upgradeCost(u.id, lvl);
        const afford = eco.money >= cost;
        const locked = u.requiresResearch && research && !research.has(u.requiresResearch);
        return `<div class="card ${maxed ? 'owned' : locked ? 'locked' : 'hover'}">
          <div class="card-title"><span class="card-icon">${u.icon}</span>${u.name}
            <span class="chip">${lvl}/${u.max}</span></div>
          <div class="card-desc">${u.desc}</div>
          <div class="progress" style="margin-top:8px"><i style="width:${(lvl / u.max) * 100}%"></i></div>
          <div class="card-row">
            <span class="card-price ${afford ? '' : 'cant'}">${maxed ? '—' : formatMoneyExact(cost)}</span>
            ${maxed ? '<span class="chip good">Maxed</span>'
              : locked ? `<span class="chip">Needs ${u.requiresResearch}</span>`
              : `<button class="btn sm ${afford ? 'gold' : ''}" data-action="up" data-id="${u.id}" ${afford ? '' : 'disabled'}>Upgrade</button>`}
          </div>
        </div>`;
      }).join('')}</div>`;

    this.setFoot(`<button class="btn" data-action="repair">Repair</button>
      <button class="btn" data-action="refuel">Refuel</button>
      <div style="flex:1"></div>
      <button class="btn danger" data-action="sell">Sell boat (${formatMoneyExact(Math.round(b.def.price * 0.55))})</button>`);

    this.onAction((act, ds) => {
      if (act === 'up') bus.emit('company:upgradeApply', { id: b.id, upgrade: ds.id });
      else if (act === 'repair') bus.emit('company:repairBoat', { id: b.id });
      else if (act === 'refuel') bus.emit('company:refuelBoat', { id: b.id });
      else if (act === 'sell') { if (confirm(`Sell ${b.name}?`)) { boats.sell(b.id); this.close(); } }
      setTimeout(() => { if (this.open) this.render(); }, 40);
    });
  }
}
