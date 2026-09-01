import { bus } from '../core/EventBus.js';
import { formatMoneyExact, clamp, makeRNG } from '../util/math.js';

const NAME_A = ['Grimsby', 'Northwind', 'Saltbite', 'Tidewater', 'Blackreef', 'Coldwater',
  'Harbourline', 'Deepkeel', 'Stormhook', 'Bluewater', 'Ironshell', 'Kelpline'];
const NAME_B = ['Fisheries', 'Seafood', 'Trawling', 'Marine', 'Catch Co.', 'Fishing Co.',
  'Provisions', 'Exports', 'Harvest', 'Angling'];

/**
 * The business layer that sits on top of Economy: identity, reputation, the
 * price multiplier every sale runs through, per-day rollups and the day clock.
 *
 * NOTE: the system contract requires `this.name === 'company'` (that is the
 * `game.get()` key), so the generated trading name lives on `companyName`.
 */
export class Company {
  constructor(game) {
    this.game = game;
    this.name = 'company';
    this.order = 34;

    /** Live sale multiplier. Read by Economy.priceFor and written to by AtlasPanel. */
    this.priceMult = 1;
    /** The part of `priceMult` currently contributed by harbour + reputation. */
    this._extApplied = 1;

    this.companyName = generateName();
    this.reputation = 50;
    this.founded = 1;

    /** Per-day rollups this system owns (Economy owns the money ledger). */
    this.today = newDay();
    /** @type {Array<object>} last 30 days of company rollups */
    this.history = [];
    this.lifetime = { sold: 0, workerCatches: 0, trips: 0, tripValue: 0, contracts: 0, contractsFailed: 0 };

    this._lastTod = -1;
    this._dayGuard = 0;
  }

  async init(game) {
    const eco = game.get('economy');
    this.founded = eco?.day ?? 1;

    bus.on('economy:sold', ({ instance, price, byWho }) => this._onSold(instance, price, byWho));
    bus.on('worker:caught', ({ instance }) => this._onWorkerCatch(instance));
    bus.on('fleet:tripComplete', (d) => this._onTrip(d));
    bus.on('economy:newDay', (d) => this.onNewDay(d));
    bus.on('harbor:changed', () => this._syncExternal());
    bus.on('harbor:built', () => this._syncExternal());
    bus.on('contract:completed', () => this.addReputation(3));
    bus.on('contract:failed', () => this.addReputation(-6));
    bus.on('game:newgame', () => this.reset());

    this._syncExternal();
    return this;
  }

  reset() {
    this.priceMult = 1;
    this._extApplied = 1;
    this.companyName = generateName();
    this.reputation = 50;
    this.founded = this.game.get('economy')?.day ?? 1;
    this.today = newDay();
    this.history.length = 0;
    this.lifetime = { sold: 0, workerCatches: 0, trips: 0, tripValue: 0, contracts: 0, contractsFailed: 0 };
    this._syncExternal();
  }

  // -------------------------------------------------------------- multiplier
  /**
   * Harbour buildings and reputation both scale prices, but AtlasPanel writes
   * `priceMult` directly, so their contribution is folded in as a delta rather
   * than by recomputing the whole product (which would wipe atlas bonuses).
   */
  _syncExternal() {
    const harborMult = this.game.get('harbor')?.priceMult || 1;
    const want = harborMult * this.reputationMult;
    if (!(want > 0) || !(this._extApplied > 0)) return;
    if (Math.abs(want - this._extApplied) < 1e-9) return;
    this.priceMult *= want / this._extApplied;
    this._extApplied = want;
  }

  /** 0.90 at zero reputation, 1.00 at 50, 1.10 at 100. */
  get reputationMult() { return 1 + (this.reputation - 50) / 500; }

  addReputation(n) {
    const before = this.reputation;
    this.reputation = clamp(this.reputation + n, 0, 100);
    if (this.reputation !== before) {
      this._syncExternal();
      bus.emit('company:reputation', { reputation: this.reputation, delta: this.reputation - before });
    }
  }

  // ------------------------------------------------------------- day rollups
  _onSold(instance, price, byWho) {
    this.today.sold++;
    this.today.revenue += price || 0;
    this.lifetime.sold++;
    if (byWho && byWho !== 'player') this.today.crewSales++;
  }

  _onWorkerCatch(instance) {
    this.today.workerCatches++;
    this.lifetime.workerCatches++;
    const eco = this.game.get('economy');
    // Dedicated key so it can never collide with Economy's own `caught` counter.
    if (eco) eco.today.workerCaught = (eco.today.workerCaught || 0) + 1;
  }

  _onTrip(d) {
    this.today.trips++;
    this.lifetime.trips++;
    const value = d?.value || d?.cargoValue || 0;
    this.today.tripValue += value;
    this.lifetime.tripValue += value;
    const eco = this.game.get('economy');
    if (eco) {
      eco.today.trips = (eco.today.trips || 0) + 1;
      eco.today.tripValue = (eco.today.tripValue || 0) + value;
    }
  }

  /** Economy has already rolled its ledger; `d.previous` is the closed day. */
  onNewDay(d) {
    const workers = this.game.get('workers');
    let wages = 0;
    try { wages = workers?.payWages?.() || 0; } catch (e) { console.warn('[Company] payWages threw', e); }

    const prev = d?.previous;
    const rev = prev?.revenue || 0;
    const exp = (prev?.expenses || 0);
    const profit = rev - exp;

    this.today.day = (d?.day ?? 1) - 1;
    this.today.revenue = rev;
    this.today.expenses = exp;
    this.today.profit = profit;
    this.today.wages = wages;
    this.history.push(this.today);
    if (this.history.length > 30) this.history.shift();
    this.today = newDay();

    // Reputation drifts with the health of the business.
    if (profit > 0) this.addReputation(1);
    else if (profit < 0) this.addReputation(-1);

    bus.emit('toast', {
      text: `📊 Day ${(d?.day ?? 1) - 1}: revenue ${formatMoneyExact(rev)} · expenses ${formatMoneyExact(exp)} · `
        + `<b style="color:${profit >= 0 ? 'var(--good)' : 'var(--danger)'}">${profit >= 0 ? '+' : ''}${formatMoneyExact(profit)}</b>`,
      kind: profit >= 0 ? 'success' : 'warn', duration: 6500,
    });
    bus.emit('company:dayClosed', { day: this.today.day, revenue: rev, expenses: exp, profit, wages });
  }

  // ------------------------------------------------------------------ update
  /** Watch the sky clock and fire `day:advanced` exactly once per midnight. */
  update(dt, game) {
    const sky = game.get('sky');
    if (!sky) return;
    const t = sky.timeOfDay;
    if (this._lastTod < 0) { this._lastTod = t; return; }
    if (this._dayGuard > 0) this._dayGuard -= dt;
    // timeOfDay is 0..1 and wraps; a large backwards step is midnight.
    if (t + 0.5 < this._lastTod && this._dayGuard <= 0) {
      this._dayGuard = 5;
      bus.emit('day:advanced', { day: (game.get('economy')?.day ?? 1) + 1 });
    }
    this._lastTod = t;
  }

  // ------------------------------------------------------------------ stats
  /** Everything Economy.priceFor will apply, for display purposes. */
  get totalPriceMult() {
    return this.priceMult * (this.game.get('research')?.priceMult || 1);
  }

  get age() { return Math.max(0, (this.game.get('economy')?.day ?? 1) - this.founded); }

  // ---------------------------------------------------------------- persist
  save() {
    return {
      companyName: this.companyName, priceMult: this.priceMult, ext: this._extApplied,
      reputation: this.reputation, founded: this.founded,
      today: { ...this.today }, history: this.history.slice(-15).map((h) => ({ ...h })),
      lifetime: { ...this.lifetime },
    };
  }

  load(d) {
    if (!d) return;
    this.companyName = d.companyName || this.companyName;
    this.priceMult = Number.isFinite(d.priceMult) ? d.priceMult : 1;
    this._extApplied = Number.isFinite(d.ext) && d.ext > 0 ? d.ext : 1;
    this.reputation = clamp(d.reputation ?? 50, 0, 100);
    this.founded = d.founded || 1;
    this.today = { ...newDay(), ...(d.today || {}) };
    this.history = d.history || [];
    this.lifetime = { ...this.lifetime, ...(d.lifetime || {}) };
    this._syncExternal();
  }
}

function newDay() {
  return {
    day: 0, sold: 0, revenue: 0, expenses: 0, profit: 0, wages: 0,
    crewSales: 0, workerCatches: 0, trips: 0, tripValue: 0,
  };
}

function generateName() {
  const rng = makeRNG((Math.random() * 4294967296) >>> 0);
  const a = NAME_A[Math.floor(rng() * NAME_A.length)];
  const b = NAME_B[Math.floor(rng() * NAME_B.length)];
  return `${a} ${b}`;
}
