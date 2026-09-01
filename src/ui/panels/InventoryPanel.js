import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { CATEGORY, getItem } from '../../data/equipment.js';
import { RARITY, getSpecies, VARIANT_BY_ID } from '../../data/fishData.js';
import { formatMoneyExact, formatWeight } from '../../util/math.js';

export class InventoryPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'inventory', title: '🎒 Inventory', width: '',
      tabs: [
        { id: 'catch', name: 'Catch', icon: '🐟' },
        { id: 'gear', name: 'Gear', icon: '🎣' },
        { id: 'stats', name: 'Stats', icon: '📊' },
      ],
    });
    this.live = true;
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const inv = g.get('inventory');
    const eco = g.get('economy');
    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800">${formatMoneyExact(eco.money)}</span>`);

    if (this.activeTab === 'catch') this.renderCatch(inv, eco);
    else if (this.activeTab === 'gear') this.renderGear(inv);
    else this.renderStats(eco, g);

    this.onAction((act, ds) => {
      if (act === 'sellone') {
        const price = inv.sellOne(+ds.index);
        if (price) { g.audio.play('coin', { volume: 0.6 }); bus.emit('toast', { text: `+${formatMoneyExact(price)}`, kind: 'gold', duration: 1600 }); }
        this.render();
      } else if (act === 'sellall') {
        const res = inv.sellAll();
        if (res.count) { g.audio.play('cash_register', { volume: 0.8 }); bus.emit('toast', { text: `Sold ${res.count} fish for ${formatMoneyExact(res.total)}`, kind: 'gold' }); }
        this.render();
      } else if (act === 'drop') {
        const f = inv.removeFish(+ds.index);
        if (f) {
          const p = g.get('player');
          const pos = p.eyePosition.clone();
          p.forward(_fwd); pos.addScaledVector(_fwd, 1.6);
          g.get('physfish')?.spawn({ instance: f.instance, position: pos, velocity: { x: _fwd.x * 3, y: 1.5, z: _fwd.z * 3 } });
          g.audio.play('drop', { volume: 0.5 });
        }
        this.render();
      } else if (act === 'equip') {
        inv.equip(ds.id); g.audio.play('ui_click'); this.render();
      }
    });
  }

  renderCatch(inv, eco) {
    if (!inv.fish.length) {
      this.bodyEl.innerHTML = `<div class="empty-state"><div class="es-icon">🪣</div>
        <div class="es-text">Your basket is empty.<br>Go stand near water and hold left mouse to cast.</div></div>`;
      this.setFoot(`<span style="color:var(--ink-faint)">Capacity ${formatWeight(inv.capacity)}</span>`);
      return;
    }
    const sorted = inv.fish.map((f, i) => ({ f, i }))
      .sort((a, b) => eco.priceFor(b.f.instance) - eco.priceFor(a.f.instance));
    this.bodyEl.innerHTML = sorted.map(({ f, i }) => {
      const inst = f.instance;
      const r = RARITY[inst.rarity] || RARITY.common;
      const sp = getSpecies(inst.speciesId);
      const price = Math.round(eco.priceFor(inst, { freshness: f.freshness, processLevel: f.processLevel }) * (f.styleMult || 1));
      return `<div class="list-row">
        <span class="lr-icon">🐟</span>
        <div class="lr-main">
          <div class="lr-title" style="color:${r.color}">${inst.name}</div>
          <div class="lr-sub">${formatWeight(inst.weight)} · ${inst.length.toFixed(2)} m · ${sp?.short || ''}
            ${f.styleMult > 1.05 ? `<span class="chip gold">×${f.styleMult.toFixed(1)} style</span>` : ''}
            ${f.processLevel ? `<span class="chip good">processed +${f.processLevel}</span>` : ''}</div>
        </div>
        <div class="lr-right" style="color:var(--gold)">${formatMoneyExact(price)}</div>
        <button class="btn sm" data-action="sellone" data-index="${i}">Sell</button>
        <button class="btn sm ghost" data-action="drop" data-index="${i}">Drop</button>
      </div>`;
    }).join('');
    this.setFoot(`<span style="color:var(--ink-faint)">${inv.fish.length} fish · ${formatWeight(inv.usedWeight)} / ${formatWeight(inv.capacity)}</span>
      <div style="flex:1"></div>
      <span style="color:var(--gold);font-weight:800;font-family:var(--mono)">${formatMoneyExact(inv.totalValue())}</span>
      <button class="btn gold" data-action="sellall">Sell All</button>`);
  }

  renderGear(inv) {
    const rows = Object.entries(CATEGORY).map(([key, cat]) => {
      const cur = getItem(inv.equipped[cat.slot]);
      const owned = cat.list.filter((i) => inv.own(i.id) || (i.consumable && inv.consumables[i.id] > 0) || i.price === 0);
      return `<div class="card">
        <div class="card-title">${cat.icon} ${cat.name}</div>
        <div class="card-desc" style="margin-bottom:8px">Equipped: <b style="color:var(--accent)">${cur?.name || '—'}</b></div>
        ${owned.map((i) => `<div class="list-row ${i.id === inv.equipped[cat.slot] ? 'selected' : ''}">
          <span class="lr-icon">${i.icon}</span>
          <div class="lr-main"><div class="lr-title">${i.name}</div>
          <div class="lr-sub">${i.consumable ? `${inv.consumables[i.id] || 0} left` : `Tier ${i.tier}`}</div></div>
          ${i.id === inv.equipped[cat.slot] ? '<span class="chip good">On</span>'
            : `<button class="btn sm" data-action="equip" data-id="${i.id}">Equip</button>`}
        </div>`).join('')}
      </div>`;
    }).join('');
    this.bodyEl.innerHTML = `<div class="grid c2">${rows}</div>`;

    const s = inv.fishingStats();
    this.setFoot(`<span style="font-family:var(--mono);font-size:11.5px;color:var(--ink-faint)">
      cast ${s.castPower.toFixed(0)} · reel ${s.reelSpeed.toFixed(2)} · max ${formatWeight(s.maxWeight)} ·
      line ${s.lineStrength.toFixed(0)} · hook ${(s.hookChance * 100).toFixed(0)}% · attract ${s.attract.toFixed(2)}</span>`);
  }

  renderStats(eco, g) {
    const s = eco.stats;
    const tricks = g.get('tricks');
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;
    const big = s.biggestFish, val = s.mostValuable;
    this.bodyEl.innerHTML = `<div class="grid c2">
      <div class="card"><div class="card-title">📈 Career</div>
        ${line('Fish caught', s.totalCaught)}
        ${line('Fish sold', s.totalSold)}
        ${line('Lifetime revenue', formatMoneyExact(eco.lifetimeRevenue), 'gold')}
        ${line('Lifetime expenses', formatMoneyExact(eco.lifetimeExpenses))}
        ${line('Net', formatMoneyExact(eco.lifetimeRevenue - eco.lifetimeExpenses), eco.lifetimeRevenue >= eco.lifetimeExpenses ? 'good' : 'bad')}
        ${line('Playtime', `${Math.floor(s.playtime / 60)}m`)}
        ${line('Day', eco.day)}
      </div>
      <div class="card"><div class="card-title">🏆 Records</div>
        ${line('Biggest fish', big ? `${big.name} (${formatWeight(big.weight)})` : '—')}
        ${line('Most valuable', val ? `${val.name} (${formatMoneyExact(val.value)})` : '—')}
        ${line('Longest cast', `${(s.longestCast || 0).toFixed(1)} m`)}
        ${line('Best combo', `x${s.bestCombo || 0}`)}
        ${line('Tricks landed', s.tricksLanded || 0)}
        ${line('Tricks discovered', `${tricks?.discovered.size || 0} / ${25}`)}
        ${line('Lines snapped', s.linesSnapped || 0, 'bad')}
        ${line('Fish lost', s.fishLost || 0, 'bad')}
      </div>
      <div class="card"><div class="card-title">🎨 By rarity</div>
        ${Object.entries(RARITY).map(([k, r]) =>
          line(`<span style="color:${r.color}">${r.name}</span>`, s.byRarity?.[k] || 0)).join('')}
      </div>
      <div class="card"><div class="card-title">🐠 Top species</div>
        ${Object.entries(s.bySpecies || {}).sort((a, b) => b[1] - a[1]).slice(0, 9)
          .map(([id, n]) => line(getSpecies(id)?.name || id, n)).join('') || '<div class="lr-sub">Nothing yet</div>'}
      </div>
    </div>`;
    this.setFoot('');
  }
}
import * as THREE from 'three';
const _fwd = new THREE.Vector3();
