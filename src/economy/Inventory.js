import { bus } from '../core/EventBus.js';
import { getItem, STARTING_LOADOUT, CATEGORY } from '../data/equipment.js';
import { getSpecies, RARITY, VARIANT_BY_ID } from '../data/fishData.js';
import { clamp, formatWeight, formatMoneyExact } from '../util/math.js';

/**
 * Player equipment loadout, owned items, caught-fish storage and hotbar.
 * Fish are stored as lightweight instance records, not physics bodies.
 */
export class Inventory {
  constructor(game) {
    this.game = game;
    this.name = 'inventory';
    this.order = 31;
    this.owned = new Set([...Object.values(STARTING_LOADOUT), 'tool_hands']);
    this.equipped = { ...STARTING_LOADOUT };
    this.consumables = { };     // itemId -> count
    /** @type {Array<{instance, freshness, processLevel, caughtAt}>} */
    this.fish = [];
    this.hotbar = ['rod', 'tool', 'weapon', 'bait', null, null, null, null, null];
    this.hotbarIndex = 0;
    this.capacityBonus = 0;
  }

  async init(game) {
    bus.on('game:newgame', () => this.resetToStart());
    return this;
  }

  resetToStart() {
    this.owned = new Set([...Object.values(STARTING_LOADOUT), 'tool_hands']);
    this.equipped = { ...STARTING_LOADOUT };
    this.consumables = {};
    this.fish.length = 0;
    this.hotbarIndex = 0;
    bus.emit('inventory:changed');
  }

  // ------------------------------------------------------------ equipment
  own(id) { return this.owned.has(id); }
  acquire(id) {
    const it = getItem(id);
    if (!it) { console.warn('[Inventory] unknown item', id); return false; }
    if (it.consumable) {
      this.consumables[id] = (this.consumables[id] || 0) + (it.stack || 1);
    } else {
      this.owned.add(id);
    }
    bus.emit('inventory:changed');
    return true;
  }

  equip(id) {
    const it = getItem(id);
    if (!it) return false;
    if (!it.consumable && !this.owned.has(id)) return false;
    if (it.consumable && !(this.consumables[id] > 0)) return false;
    const slot = it.slot || slotForItem(id);
    if (!slot) return false;
    this.equipped[slot] = id;
    bus.emit('inventory:changed');
    bus.emit('equipment:changed', { slot, id });
    return true;
  }

  get rod() { return getItem(this.equipped.rod); }
  get line() { return getItem(this.equipped.line); }
  get reel() { return getItem(this.equipped.reel); }
  get bait() { return getItem(this.equipped.bait); }
  get tool() { return getItem(this.equipped.tool); }
  get weapon() { return getItem(this.equipped.weapon); }
  get storage() { return getItem(this.equipped.storage); }

  /** Combined fishing stats from rod + line + reel + bait. */
  fishingStats() {
    const rod = this.rod?.stats || {};
    const line = this.line?.stats || {};
    const reel = this.reel?.stats || {};
    const bait = this.bait?.stats || {};
    const research = this.game.get('research');
    const rb = research?.fishingBonus || {};
    return {
      castPower: (rod.castPower ?? 10) * (rb.castPower ?? 1),
      reelSpeed: (rod.reelSpeed ?? 1) * (reel.reelRate ?? 1) * (rb.reelSpeed ?? 1),
      maxWeight: (rod.maxWeight ?? 3) * (rb.maxWeight ?? 1),
      hookChance: clamp((rod.hookChance ?? 0.6) * (rb.hookChance ?? 1), 0, 0.99),
      control: rod.control ?? 0.5,
      bend: rod.bend ?? 1,
      lineStrength: (line.strength ?? 50) * (rb.lineStrength ?? 1),
      elasticity: line.elasticity ?? 0.3,
      lineLength: (line.length ?? 30) * (rb.lineLength ?? 1),
      lineDrag: line.drag ?? 1,
      recovery: reel.recovery ?? 1,
      autoReel: (reel.autoReel ?? 0) + (rb.autoReel ?? 0),
      dragControl: reel.dragControl ?? 0.4,
      attract: (bait.attract ?? 0.6) * (rb.attract ?? 1),
      rareBonus: (bait.rareBonus ?? 1) * (rb.rareBonus ?? 1),
      bigBonus: bait.bigBonus ?? 1,
      deepBonus: bait.deepBonus ?? 1,
      danger: bait.danger ?? 1,
      lureRange: rod.lureRange ?? 1,
    };
  }

  consumeBait() {
    const id = this.equipped.bait;
    const it = getItem(id);
    if (!it?.consumable) return true;
    if (!(this.consumables[id] > 0)) {
      this.equipped.bait = 'bait_none';
      bus.emit('toast', { text: 'Out of bait', kind: 'warn' });
      bus.emit('inventory:changed');
      return false;
    }
    this.consumables[id]--;
    if (this.consumables[id] <= 0) {
      delete this.consumables[id];
      this.equipped.bait = 'bait_none';
      bus.emit('toast', { text: 'Out of bait', kind: 'warn' });
    }
    bus.emit('inventory:changed');
    return true;
  }

  // -------------------------------------------------------------- storage
  get capacity() { return (this.storage?.stats.capacity ?? 15) + this.capacityBonus; }
  get usedWeight() { let w = 0; for (const f of this.fish) w += f.instance.weight; return w; }
  get freeWeight() { return Math.max(0, this.capacity - this.usedWeight); }
  get isFull() { return this.freeWeight < 0.02; }

  canStore(instance) { return instance.weight <= this.freeWeight + 0.001; }

  storeFish(instance, opts = {}) {
    if (!this.canStore(instance)) {
      bus.emit('toast', { text: `Storage full — ${formatWeight(this.usedWeight)} / ${formatWeight(this.capacity)}`, kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    const freshness = (this.storage?.stats.freshness ?? 1) * (opts.freshness ?? 1);
    this.fish.push({
      instance, freshness, processLevel: opts.processLevel || 0,
      caughtAt: this.game.time, tricks: opts.tricks || [], styleMult: opts.styleMult || 1,
    });
    bus.emit('inventory:changed');
    bus.emit('inventory:fishStored', { instance });
    return true;
  }

  removeFish(index) {
    if (index < 0 || index >= this.fish.length) return null;
    const [f] = this.fish.splice(index, 1);
    bus.emit('inventory:changed');
    return f;
  }

  /** Sell everything (or a filtered subset). @returns {{count, total, best}} */
  sellAll(filter = null) {
    const eco = this.game.get('economy');
    if (!eco) return { count: 0, total: 0 };
    let total = 0, count = 0, best = null;
    const keep = [];
    for (const f of this.fish) {
      if (filter && !filter(f)) { keep.push(f); continue; }
      const price = Math.round(eco.priceFor(f.instance, { freshness: f.freshness, processLevel: f.processLevel }) * (f.styleMult || 1));
      total += price; count++;
      if (!best || price > best.price) best = { instance: f.instance, price };
      eco.recordSale(f.instance, price, 'player');
    }
    this.fish = keep;
    if (count) {
      eco.add(total, 'fish_sales');
      bus.emit('inventory:changed');
      bus.emit('sell:completed', { count, total, best });
    }
    return { count, total, best };
  }

  sellOne(index) {
    const eco = this.game.get('economy');
    const f = this.fish[index];
    if (!f || !eco) return 0;
    const price = Math.round(eco.priceFor(f.instance, { freshness: f.freshness, processLevel: f.processLevel }) * (f.styleMult || 1));
    this.removeFish(index);
    eco.add(price, 'fish_sales');
    eco.recordSale(f.instance, price, 'player');
    bus.emit('sell:completed', { count: 1, total: price, best: { instance: f.instance, price } });
    return price;
  }

  totalValue() {
    const eco = this.game.get('economy');
    if (!eco) return 0;
    let t = 0;
    for (const f of this.fish) t += eco.priceFor(f.instance, { freshness: f.freshness, processLevel: f.processLevel }) * (f.styleMult || 1);
    return Math.round(t);
  }

  // -------------------------------------------------------------- hotbar
  hotbarSlots() {
    return this.hotbar.map((kind) => {
      if (!kind) return null;
      if (kind === 'rod') { const i = this.rod; return i && { id: i.id, icon: i.icon, name: i.name }; }
      if (kind === 'tool') { const i = this.tool; return i && { id: i.id, icon: i.icon, name: i.name }; }
      if (kind === 'weapon') { const i = this.weapon; return i && { id: i.id, icon: i.icon, name: i.name }; }
      if (kind === 'bait') {
        const i = this.bait; if (!i) return null;
        return { id: i.id, icon: i.icon, name: i.name, count: i.consumable ? (this.consumables[i.id] || 0) : 0 };
      }
      const item = getItem(kind);
      return item && { id: item.id, icon: item.icon, name: item.name };
    });
  }
  get activeKind() { return this.hotbar[this.hotbarIndex]; }
  setHotbarIndex(i) {
    i = clamp(i, 0, this.hotbar.length - 1);
    if (i === this.hotbarIndex) return;
    this.hotbarIndex = i;
    bus.emit('hotbar:changed', { index: i, kind: this.hotbar[i] });
    this.game.audio?.play('ui_hover', { volume: 0.35 });
  }

  update(dt, game) {
    const input = game.input;
    for (let i = 0; i < 9; i++) {
      if (input.justPressed(`Digit${i + 1}`)) this.setHotbarIndex(i);
    }
    const w = input.consumeWheel();
    if (w) {
      let i = this.hotbarIndex + w;
      const n = this.hotbar.length;
      // Skip empty slots so the wheel always lands on something usable.
      for (let k = 0; k < n; k++) {
        i = ((i % n) + n) % n;
        if (this.hotbar[i]) break;
        i += Math.sign(w) || 1;
      }
      this.setHotbarIndex(((i % n) + n) % n);
    }
    const hud = game.get('hud');
    if (hud) {
      hud.setHotbar(this.hotbarSlots(), this.hotbarIndex);
      hud.setStorage(this.usedWeight, this.capacity, this.fish.length);
    }
  }

  save() {
    return {
      owned: [...this.owned], equipped: this.equipped, consumables: this.consumables,
      fish: this.fish.map((f) => ({ i: f.instance, fr: f.freshness, pl: f.processLevel, sm: f.styleMult })),
      hotbarIndex: this.hotbarIndex, capacityBonus: this.capacityBonus,
    };
  }
  load(d) {
    if (!d) return;
    this.owned = new Set(d.owned || Object.values(STARTING_LOADOUT));
    this.equipped = { ...STARTING_LOADOUT, ...(d.equipped || {}) };
    this.consumables = d.consumables || {};
    this.fish = (d.fish || []).map((f) => ({
      instance: f.i, freshness: f.fr ?? 1, processLevel: f.pl ?? 0,
      caughtAt: 0, tricks: [], styleMult: f.sm ?? 1,
    }));
    this.hotbarIndex = d.hotbarIndex || 0;
    this.capacityBonus = d.capacityBonus || 0;
    bus.emit('inventory:changed');
  }
}

function slotForItem(id) {
  for (const [k, c] of Object.entries(CATEGORY)) {
    if (c.list.some((i) => i.id === id)) return c.slot;
  }
  return null;
}
