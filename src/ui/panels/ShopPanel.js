import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { CATEGORY, getItem, itemsForShop } from '../../data/equipment.js';
import { formatMoneyExact, formatWeight } from '../../util/math.js';
import { TRAPS } from '../../world/TrapSystem.js';

const STAT_LABELS = {
  castPower: 'Cast Power', reelSpeed: 'Reel Speed', maxWeight: 'Max Fish', hookChance: 'Hook Chance',
  control: 'Control', lureRange: 'Lure Range', strength: 'Line Strength', elasticity: 'Stretch',
  drag: 'Water Drag', length: 'Line Length', reelRate: 'Reel Rate', recovery: 'Recovery',
  autoReel: 'Auto Reel', dragControl: 'Drag Control', attract: 'Attraction', rareBonus: 'Rare Chance',
  bigBonus: 'Big Fish', deepBonus: 'Deep Water', danger: 'Danger', capacity: 'Capacity',
  freshness: 'Freshness', damage: 'Damage', range: 'Range', rate: 'Fire Rate', knockback: 'Knockback',
  pull: 'Pull', speed: 'Projectile Speed', magazine: 'Magazine', reload: 'Reload', recoil: 'Recoil',
  scoopWeight: 'Scoop Limit', netRadius: 'Net Radius', explosive: 'Blast',
};
const FORMAT = {
  maxWeight: (v) => formatWeight(v), capacity: (v) => formatWeight(v),
  hookChance: (v) => `${Math.round(v * 100)}%`, length: (v) => `${v} m`, range: (v) => `${v} m`,
};

export class ShopPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'shop', title: '🏪 Shop', subtitle: '',
      tabs: [
        ...Object.entries(CATEGORY).map(([id, c]) => ({ id, name: c.name, icon: c.icon })),
        { id: 'traps', name: 'Traps', icon: '🪤' },
      ],
      width: '',
    });
    this.live = true;
    this.shopTier = 1;
  }

  show() {
    this.shopTier = this.data?.tier || 1;
    super.show();
  }

  /** Traps are world gear rather than equipment, so they get their own tab. */
  _renderTraps(g, eco) {
    const traps = g.get('traps');
    this.setSubtitle(`Tier ${this.shopTier}`);
    this.setHeadRight(`<span style="font-family:var(--mono);font-weight:800;color:var(--gold);font-size:17px">${formatMoneyExact(eco.money)}</span>`);
    const carrying = traps?.inventory.length || 0;
    const placed = traps?.traps.size || 0;

    this.bodyEl.innerHTML = `
      <div class="grid auto">${TRAPS.map((t) => {
        const afford = eco.money >= t.price;
        const held = (traps?.inventory || []).filter((x) => x === t.id).length;
        return `<div class="card ${held ? 'owned' : ''}">
          <div class="card-title">${t.icon} ${t.name}${held ? `<span class="chip good">x${held}</span>` : ''}</div>
          <div class="card-desc">${t.desc}</div>
          <div class="card-stats">
            Holds: <b>${t.capacity} fish</b><br>
            Rate: <b>${t.ratePerMin.toFixed(2)}/min</b><br>
            Max depth: <b>${t.maxDepth} m</b><br>
            Size bias: <b>${t.sizeBias.toFixed(2)}</b> · Luck: <b>${t.luck.toFixed(1)}x</b>
          </div>
          <div class="card-row">
            <span class="card-price ${afford ? '' : 'cant'}">${formatMoneyExact(t.price)}</span>
            <button class="btn sm ${afford ? 'gold' : ''}" data-action="buytrap" data-id="${t.id}" ${afford ? '' : 'disabled'}>Buy</button>
          </div>
        </div>`;
      }).join('')}</div>`;
    this.setFoot(`<span style="color:var(--ink-faint)">Carrying ${carrying} · ${placed} in the water · aim at open water and press <b>G</b> to set one, <b>E</b> to check, <b>F</b> to retrieve</span>`);
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const eco = g.get('economy');
    const inv = g.get('inventory');
    if (this.activeTab === 'traps') { this._renderTraps(g, eco); return; }
    const cat = CATEGORY[this.activeTab];
    if (!cat) return;

    this.setSubtitle(`Tier ${this.shopTier} · ${this.data?.region ? this.data.region : ''}`);
    this.setHeadRight(`<span style="font-family:var(--mono);font-weight:800;color:var(--gold);font-size:17px">${formatMoneyExact(eco.money)}</span>`);

    const list = cat.list;
    const equippedId = inv.equipped[cat.slot];
    const cards = list.map((item) => {
      const available = (item.shopTier ?? 1) <= this.shopTier;
      const owned = item.consumable ? false : inv.own(item.id);
      const equipped = equippedId === item.id;
      const count = item.consumable ? (inv.consumables[item.id] || 0) : 0;
      const affordable = eco.money >= item.price;
      const stats = Object.entries(item.stats || {})
        .filter(([k]) => STAT_LABELS[k])
        .map(([k, v]) => {
          const cur = getItem(equippedId)?.stats?.[k];
          let arrow = '';
          if (typeof v === 'number' && typeof cur === 'number' && !equipped) {
            arrow = v > cur ? ' <span style="color:var(--good)">▲</span>' : v < cur ? ' <span style="color:var(--danger)">▼</span>' : '';
          }
          const fmt = FORMAT[k] ? FORMAT[k](v) : (typeof v === 'number' ? (v % 1 ? v.toFixed(2) : v) : v);
          return `${STAT_LABELS[k]}: <b>${fmt}</b>${arrow}`;
        }).join('<br>');

      let action;
      if (!available) action = `<span class="chip">Tier ${item.shopTier} shop</span>`;
      else if (equipped && !item.consumable) action = `<span class="chip good">Equipped</span>`;
      else if (owned) action = `<button class="btn sm primary" data-action="equip" data-id="${item.id}">Equip</button>`;
      else if (item.price === 0) action = `<button class="btn sm" data-action="equip" data-id="${item.id}">Equip</button>`;
      else action = `<button class="btn sm ${affordable ? 'gold' : ''}" data-action="buy" data-id="${item.id}" ${affordable ? '' : 'disabled'}>Buy</button>`;

      return `<div class="card hover ${!available ? 'locked' : ''} ${owned || equipped ? 'owned' : ''}">
        <div class="card-title"><span class="card-icon">${item.icon}</span>${item.name}
          ${count ? `<span class="chip">x${count}</span>` : ''}</div>
        <div class="card-desc">${item.desc || ''}</div>
        <div class="card-stats">${stats}</div>
        <div class="card-row">
          <span class="card-price ${affordable ? '' : 'cant'}">${item.price ? formatMoneyExact(item.price) : 'Free'}</span>
          ${action}
        </div>
      </div>`;
    }).join('');

    this.bodyEl.innerHTML = `<div class="grid auto">${cards}</div>`;
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">
      Storage ${formatWeight(inv.usedWeight)} / ${formatWeight(inv.capacity)} ·
      ${inv.fish.length} fish worth ${formatMoneyExact(inv.totalValue())}</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn primary" data-action="sellall">Sell All Fish</button>`);

    this.onAction((act, ds) => {
      const item = getItem(ds.id);
      if (act === 'buy' && item) {
        if (eco.spend(item.price, 'equipment')) {
          inv.acquire(item.id);
          if (!item.consumable) inv.equip(item.id);
          else inv.equip(item.id);
          g.audio.play('purchase', { volume: 0.6 });
          bus.emit('toast', { text: `Bought ${item.name}`, kind: 'success' });
          bus.emit('shop:purchased', { item });
          this.render();
        }
      } else if (act === 'equip' && item) {
        inv.equip(item.id);
        g.audio.play('ui_click', { volume: 0.5 });
        this.render();
      } else if (act === 'buytrap') {
        g.get('traps')?.buy(ds.id);
        this.render();
      } else if (act === 'sellall') {
        // Route through the bucket so the seller-proximity rule applies: the
        // catch has to be carried here, not sold from across the island.
        const bucket = g.get('bucket');
        // bucket.sell() reports its own result (including refusing at range),
        // so only the fallback path needs to announce anything.
        if (bucket) bucket.sell();
        else {
          const res = inv.sellAll();
          if (res.count) {
            g.audio.play('cash_register', { volume: 0.8 });
            bus.emit('toast', { text: `Sold ${res.count} fish for ${formatMoneyExact(res.total)}`, kind: 'gold' });
          } else bus.emit('toast', { text: 'Nothing to sell', kind: 'warn' });
        }
        this.render();
      }
    });
  }
}
