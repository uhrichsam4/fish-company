import { bus } from '../core/EventBus.js';
import { clamp01, formatWeight, formatMoneyExact } from '../util/math.js';

/**
 * The fish bucket.
 *
 * Deliberately layered on top of Inventory rather than replacing it: the
 * inventory's fish list is already what workers, the gambling den, spearfishing
 * and the sell zones all read, and forking that into a second store would give
 * two sources of truth for the same fish. The bucket owns the things the
 * inventory has no concept of -- whether a fish is still alive, how heavy the
 * carry is, and which tier of container the player owns.
 *
 * A caught fish goes in alive. It stays alive, flopping, until the player
 * processes it with a spear or knife. Selling is gated on standing in a sell
 * zone, so the catch has to physically travel.
 */

export const BUCKET_TIERS = [
  { id: 'bucket_old', name: 'Old Bucket', capacity: 15, price: 0, desc: 'It held paint once. It has opinions about that.' },
  { id: 'bucket_steel', name: 'Steel Bucket', capacity: 30, price: 340, desc: 'Galvanised. Rattles honestly.' },
  { id: 'crate_fish', name: 'Fish Crate', capacity: 60, price: 1500, desc: 'Slatted, stackable, smells permanently of its job.' },
  { id: 'crate_large', name: 'Large Crate', capacity: 120, price: 6200, desc: 'You will feel this one in your back.' },
];
export const BUCKET_BY_ID = Object.fromEntries(BUCKET_TIERS.map((b) => [b.id, b]));

/** Weight at which the carry penalty is at its worst, as a fraction of capacity. */
const HEAVY_AT = 1;

export class BucketSystem {
  constructor(game) {
    this.game = game;
    this.name = 'bucket';
    this.order = 32;
    this.tierId = 'bucket_old';
    /** Set true while the player is physically holding the bucket. */
    this.carried = false;
  }

  async init() {
    bus.on('game:newgame', () => { this.tierId = 'bucket_old'; this.carried = false; });
    // A fish only enters the world alive; everything else about it is the
    // inventory's business.
    bus.on('inventory:fishStored', () => this._tagNewest());
    return this;
  }

  get tier() { return BUCKET_BY_ID[this.tierId] || BUCKET_TIERS[0]; }
  get capacity() { return this.tier.capacity; }
  get inv() { return this.game.get('inventory'); }
  get fish() { return this.inv?.fish || []; }

  get weight() { let w = 0; for (const f of this.fish) w += f.instance.weight; return w; }
  get count() { return this.fish.length; }
  get aliveCount() { return this.fish.reduce((n, f) => n + (f.alive ? 1 : 0), 0); }
  get processedCount() { return this.count - this.aliveCount; }

  /** Estimated take, using the same pricing the seller will actually apply. */
  get value() {
    const eco = this.game.get('economy');
    if (!eco) return 0;
    let v = 0;
    for (const f of this.fish) v += eco.priceFor(f.instance) * (f.styleMult || 1);
    return Math.round(v);
  }

  /** 0..1 how full by weight. */
  get fullness() { return clamp01(this.weight / Math.max(1, this.capacity)); }

  _tagNewest() {
    const f = this.fish[this.fish.length - 1];
    // Only a brand new entry is untagged; a loaded save already has its state.
    if (f && f.alive === undefined) f.alive = true;
  }

  /**
   * Kill one fish. This is what the spear does -- it is never automatic,
   * because the whole point of the loop is that the player does it.
   */
  process(index) {
    const f = this.fish[index];
    if (!f || !f.alive) return false;
    f.alive = false;
    f.processedAt = this.game.time;
    bus.emit('bucket:processed', { fish: f });
    bus.emit('inventory:changed');
    return true;
  }

  /** The topmost still-flopping fish, which is what a spear thrust should hit. */
  firstAlive() {
    const i = this.fish.findIndex((f) => f.alive);
    return i < 0 ? null : { index: i, fish: this.fish[i] };
  }

  upgradeTo(id) {
    const t = BUCKET_BY_ID[id];
    if (!t) return false;
    this.tierId = id;
    bus.emit('bucket:changed');
    bus.emit('toast', { text: `${t.name} — ${formatWeight(t.capacity)} capacity`, kind: 'gold' });
    return true;
  }

  /** Movement drag from the load. Kept mild: this is flavour, not a tax. */
  get carryPenalty() {
    if (!this.carried) return 0;
    return clamp01(this.weight / (this.capacity * HEAVY_AT)) * 0.22;
  }

  /** True when the player is close enough to a sell zone to trade. */
  atSeller() {
    const world = this.game.get('world');
    const p = this.game.get('player');
    if (!world?.sellZones || !p) return false;
    for (const z of world.sellZones) {
      const d = Math.hypot(p.position.x - z.position.x, p.position.z - z.position.z);
      if (d < (z.radius || 2.4) + 1.6) return true;
    }
    return false;
  }

  /**
   * Empty the bucket to the seller. Refuses at range on purpose: the catch has
   * to be carried there, which is the point of the bucket existing at all.
   */
  sell() {
    if (!this.count) {
      bus.emit('toast', { text: 'The bucket is empty.', kind: '' });
      return { count: 0, total: 0 };
    }
    if (!this.atSeller()) {
      bus.emit('toast', { text: 'Carry the bucket to a seller to sell your catch.', kind: 'error', duration: 3600 });
      return { count: 0, total: 0 };
    }
    const res = this.inv.sellAll();
    if (res.count) {
      this.game.audio?.play('bucket_sell', { volume: 0.8 });
      this.game.audio?.play('cash_register', { volume: 0.7 });
      bus.emit('toast', {
        text: `Sold ${res.count} fish for ${formatMoneyExact(res.total)}`, kind: 'gold', duration: 4200,
      });
      bus.emit('bucket:sold', res);
    }
    return res;
  }

  update() {
    const hud = this.game.get('hud');
    if (hud?.setBucket) {
      hud.setBucket({
        count: this.count, alive: this.aliveCount,
        weight: this.weight, capacity: this.capacity,
        value: this.value, carried: this.carried,
      });
    }
  }

  save() { return { tier: this.tierId, carried: this.carried }; }

  load(d) {
    if (!d) return;
    if (BUCKET_BY_ID[d.tier]) this.tierId = d.tier;
    this.carried = !!d.carried;
    // Fish saved before the bucket existed have no alive flag. Treat them as
    // already processed rather than resurrecting a boatload of them.
    for (const f of this.fish) if (f.alive === undefined) f.alive = false;
  }
}
