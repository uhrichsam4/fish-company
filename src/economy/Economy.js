import { bus } from '../core/EventBus.js';
import { clamp, formatMoneyExact } from '../util/math.js';

/**
 * Money, transactions, lifetime statistics and the daily ledger.
 * Every figure here comes from a real gameplay event — nothing is faked.
 */
export class Economy {
  constructor(game) {
    this.game = game;
    this.name = 'economy';
    this.order = 30;
    this.money = 12;
    this.lifetimeRevenue = 0;
    this.lifetimeExpenses = 0;
    /** rolling per-day ledger */
    this.day = 1;
    this.today = newLedger();
    this.history = [];
    this.marketMult = 1;         // random events can boost/depress prices
    this.marketTimer = 0;
    this.priceMultipliers = {};  // per-species modifiers from contracts/events
    this.stats = {
      totalCaught: 0, totalSold: 0, biggestFish: null, mostValuable: null,
      bySpecies: {}, byRarity: {}, tricksLanded: 0, bestCombo: 0,
      distanceTravelled: 0, playtime: 0, bossesKilled: [], deepestDive: 0,
      linesSnapped: 0, fishLost: 0, longestCast: 0,
    };
  }

  async init(game) {
    bus.on('day:advanced', () => this.endDay());
    return this;
  }

  add(amount, reason = 'misc', opts = {}) {
    if (!Number.isFinite(amount)) { console.warn('[Economy] non-finite amount', amount, reason); return 0; }
    amount = Math.round(amount);
    this.money += amount;
    if (amount > 0) { this.lifetimeRevenue += amount; this.today.revenue += amount; this.today.byReason[reason] = (this.today.byReason[reason] || 0) + amount; }
    else if (amount < 0) { this.lifetimeExpenses -= amount; this.today.expenses -= amount; this.today.byReason[reason] = (this.today.byReason[reason] || 0) + amount; }
    bus.emit('money:changed', { total: this.money, delta: amount, reason });
    return amount;
  }

  canAfford(cost) { return this.money >= cost; }

  /** @returns {boolean} true if the purchase went through. */
  spend(cost, reason = 'purchase') {
    cost = Math.round(cost);
    if (cost > this.money) {
      bus.emit('toast', { text: `Not enough money — need ${formatMoneyExact(cost - this.money)} more`, kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    this.add(-cost, reason);
    return true;
  }

  /** Sale price for a caught-fish instance, including all live multipliers. */
  priceFor(instance, opts = {}) {
    let v = instance.value || 1;
    v *= this.marketMult;
    v *= this.priceMultipliers[instance.speciesId] ?? 1;
    if (opts.freshness) v *= opts.freshness;
    if (opts.processLevel) v *= 1 + opts.processLevel * 0.28;
    const research = this.game.get('research');
    if (research?.priceMult) v *= research.priceMult;
    const company = this.game.get('company');
    if (company?.priceMult) v *= company.priceMult;
    return Math.max(1, Math.round(v));
  }

  recordCatch(instance, byWho = 'player') {
    const s = this.stats;
    s.totalCaught++;
    s.bySpecies[instance.speciesId] = (s.bySpecies[instance.speciesId] || 0) + 1;
    s.byRarity[instance.rarity] = (s.byRarity[instance.rarity] || 0) + 1;
    let record = null;
    if (!s.biggestFish || instance.weight > s.biggestFish.weight) {
      s.biggestFish = { ...instance, by: byWho };
      record = 'weight';
    }
    if (!s.mostValuable || instance.value > s.mostValuable.value) {
      s.mostValuable = { ...instance, by: byWho };
      record = record || 'value';
    }
    this.today.caught++;
    bus.emit('economy:caught', { instance, byWho, record });
    return record;
  }

  recordSale(instance, price, byWho = 'player') {
    this.stats.totalSold++;
    this.today.sold++;
    this.today.fishRevenue += price;
    bus.emit('economy:sold', { instance, price, byWho });
  }

  endDay() {
    this.today.day = this.day;
    this.today.profit = this.today.revenue - this.today.expenses;
    this.history.push(this.today);
    if (this.history.length > 60) this.history.shift();
    this.day++;
    this.today = newLedger();
    bus.emit('economy:newDay', { day: this.day, previous: this.history[this.history.length - 1] });
  }

  get dailyProfit() { return this.today.revenue - this.today.expenses; }
  get netWorth() {
    let n = this.money;
    const boats = this.game.get('boats');
    if (boats?.totalValue) n += boats.totalValue();
    return n;
  }

  update(dt) {
    this.stats.playtime += dt;
    // Market drift: slow random walk, occasionally shocked by events.
    this.marketTimer += dt;
    if (this.marketTimer > 20) {
      this.marketTimer = 0;
      const target = 1 + (Math.random() - 0.5) * 0.22;
      this.marketMult += (target - this.marketMult) * 0.3;
      this.marketMult = clamp(this.marketMult, 0.75, 1.6);
    }
  }

  setMarketBoost(mult, seconds) {
    this.marketMult = mult;
    clearTimeout(this._boostTimer);
    this._boostTimer = setTimeout(() => { this.marketMult = 1; }, seconds * 1000);
  }

  save() {
    return {
      money: this.money, lifetimeRevenue: this.lifetimeRevenue, lifetimeExpenses: this.lifetimeExpenses,
      day: this.day, today: this.today, history: this.history.slice(-20), stats: this.stats,
    };
  }
  load(d) {
    if (!d) return;
    this.money = d.money ?? 12;
    this.lifetimeRevenue = d.lifetimeRevenue || 0;
    this.lifetimeExpenses = d.lifetimeExpenses || 0;
    this.day = d.day || 1;
    this.today = d.today || newLedger();
    this.history = d.history || [];
    this.stats = { ...this.stats, ...(d.stats || {}) };
    bus.emit('money:changed', { total: this.money, delta: 0, reason: 'load' });
  }
}

function newLedger() {
  return {
    day: 0, revenue: 0, expenses: 0, profit: 0, caught: 0, sold: 0,
    fishRevenue: 0, wages: 0, fuel: 0, repairs: 0, byReason: {},
  };
}
