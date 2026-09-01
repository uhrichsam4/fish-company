import { bus } from '../core/EventBus.js';
import {
  generateContract, requirementMatches, requirementTarget, requirementIncrement, highestTier,
} from '../data/contracts.js';
import { formatMoneyExact, formatWeight, makeRNG, clamp01 } from '../util/math.js';

const BASE_SLOTS = 3;

/**
 * Generated delivery contracts.
 *
 * Offers refresh every in-game day. Accepting one starts a countdown; selling a
 * matching fish credits progress automatically (Inventory already emits
 * `economy:sold` for every sale, player or crew). Completing pays the reward,
 * missing the deadline charges the penalty.
 */
export class Contracts {
  constructor(game) {
    this.game = game;
    this.name = 'contracts';
    this.order = 35;

    /** @type {Array<object>} offers on the board */
    this.available = [];
    /** @type {Array<object>} taken contracts, each with a `progress` array */
    this.accepted = [];
    this.completed = 0;
    this.failed = 0;
    this.lifetimeReward = 0;
    this.seed = (Math.random() * 4294967296) >>> 0;
    this._lastRefreshDay = 0;
  }

  async init(game) {
    bus.on('economy:sold', ({ instance, price }) => this.credit(instance, price));
    bus.on('economy:newDay', ({ day }) => this.onNewDay(day));
    bus.on('company:acceptContract', ({ id }) => this.accept(id));
    bus.on('company:abandonContract', ({ id }) => this.abandon(id));
    bus.on('contracts:accept', ({ id }) => this.accept(id));
    bus.on('contracts:abandon', ({ id }) => this.abandon(id));
    bus.on('contracts:refresh', () => this.refresh(true));
    bus.on('game:newgame', () => this.reset());
    if (!this.available.length) this.refresh();
    return this;
  }

  reset() {
    this.available.length = 0;
    this.accepted.length = 0;
    this.completed = 0;
    this.failed = 0;
    this.lifetimeReward = 0;
    this.seed = (Math.random() * 4294967296) >>> 0;
    this._lastRefreshDay = 0;
    this.refresh();
  }

  // ------------------------------------------------------------------ board
  get maxAccepted() { return BASE_SLOTS + (this.game.get('harbor')?.contractSlots || 0); }

  get unlockedRegions() {
    return this.game.get('quests')?.unlockedRegions || new Set(['crash']);
  }

  /** Regenerate the offer board. 3–6 offers, scaled to the reachable world. */
  refresh(announce = false) {
    const day = this.game.get('economy')?.day ?? 1;
    const rng = makeRNG((this.seed ^ (day * 2654435761)) >>> 0);
    const regions = this.unlockedRegions;
    const tierBias = highestTier(regions);
    const count = 3 + Math.floor(rng() * 4);
    const out = [];
    let guard = 0;
    while (out.length < count && guard++ < count * 6) {
      const c = generateContract(rng, { regions, day, tierBias });
      if (!c) break;
      if (out.some((x) => x.name === c.name)) continue;
      out.push(c);
    }
    this.available = out;
    this._lastRefreshDay = day;
    if (announce && out.length) {
      bus.emit('toast', { text: `📄 ${out.length} new contracts on the board`, kind: 'info' });
    }
    bus.emit('contracts:changed', { available: this.available.length, accepted: this.accepted.length });
    return out.length;
  }

  // ----------------------------------------------------------------- accept
  accept(id) {
    const i = this.available.findIndex((c) => c.id === id);
    if (i < 0) return false;
    if (this.accepted.length >= this.maxAccepted) {
      bus.emit('toast', { text: `Contract slots full (${this.accepted.length}/${this.maxAccepted})`, kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    const c = this.available.splice(i, 1)[0];
    const day = this.game.get('economy')?.day ?? 1;
    const entry = {
      ...c,
      progress: c.requirements.map(() => 0),
      acceptedDay: day,
      dueDay: day + c.deadlineDays,
    };
    this.accepted.push(entry);
    this.game.audio?.play('ui_click', { volume: 0.5 });
    bus.emit('toast', {
      text: `📄 Accepted <b>${c.name}</b> — ${formatMoneyExact(c.reward)} within ${c.deadlineDays} days`,
      kind: 'gold', duration: 5200,
    });
    bus.emit('contract:accepted', { contract: entry });
    bus.emit('contracts:changed', { available: this.available.length, accepted: this.accepted.length });
    return true;
  }

  abandon(id) {
    const i = this.accepted.findIndex((c) => c.id === id);
    if (i < 0) return false;
    const c = this.accepted.splice(i, 1)[0];
    const eco = this.game.get('economy');
    const fee = Math.round(c.penalty * 0.5);
    if (fee > 0) eco?.add(-fee, 'contract_penalty');
    bus.emit('toast', { text: `Abandoned <b>${c.name}</b> — ${formatMoneyExact(fee)} fee`, kind: 'warn' });
    bus.emit('contract:abandoned', { contract: c, fee });
    bus.emit('contracts:changed', { available: this.available.length, accepted: this.accepted.length });
    return true;
  }

  // --------------------------------------------------------------- progress
  /** Credit a sale against every accepted contract it satisfies. */
  credit(instance, price) {
    if (!instance || !this.accepted.length) return;
    let changed = false;
    for (let ci = this.accepted.length - 1; ci >= 0; ci--) {
      const c = this.accepted[ci];
      let touched = false;
      for (let i = 0; i < c.requirements.length; i++) {
        const req = c.requirements[i];
        const target = requirementTarget(req);
        if (c.progress[i] >= target) continue;
        if (!requirementMatches(req, instance)) continue;
        c.progress[i] = Math.min(target, c.progress[i] + requirementIncrement(req, instance));
        touched = true;
      }
      if (!touched) continue;
      changed = true;
      if (this.isComplete(c)) this.complete(ci);
    }
    if (changed) bus.emit('contracts:changed', { available: this.available.length, accepted: this.accepted.length });
  }

  isComplete(c) {
    for (let i = 0; i < c.requirements.length; i++) {
      if (c.progress[i] < requirementTarget(c.requirements[i]) - 1e-6) return false;
    }
    return true;
  }

  /** 0..1 completion across every requirement line. */
  progressOf(c) {
    if (!c?.requirements?.length) return 0;
    let t = 0;
    for (let i = 0; i < c.requirements.length; i++) {
      t += clamp01(c.progress[i] / requirementTarget(c.requirements[i]));
    }
    return t / c.requirements.length;
  }

  /** Human-readable per-line progress, e.g. "18.4 kg / 40 kg". */
  lineLabel(c, i) {
    const req = c.requirements[i];
    const target = requirementTarget(req);
    const cur = c.progress[i];
    return req.kg
      ? `${formatWeight(cur)} / ${formatWeight(target)}`
      : `${Math.floor(cur)} / ${target}`;
  }

  complete(index) {
    const c = this.accepted.splice(index, 1)[0];
    if (!c) return;
    const eco = this.game.get('economy');
    eco?.add(c.reward, 'contract');
    this.completed++;
    this.lifetimeReward += c.reward;
    this.game.audio?.play('levelup', { volume: 0.7 });
    bus.emit('toast', {
      text: `✅ Contract complete: <b>${c.name}</b> — ${formatMoneyExact(c.reward)}`,
      kind: 'success', duration: 6000,
    });
    bus.emit('contract:completed', { contract: c, reward: c.reward });
  }

  expire(index) {
    const c = this.accepted.splice(index, 1)[0];
    if (!c) return;
    const eco = this.game.get('economy');
    if (c.penalty > 0) eco?.add(-c.penalty, 'contract_penalty');
    this.failed++;
    this.game.audio?.play('ui_error');
    bus.emit('toast', {
      text: `❌ Contract expired: <b>${c.name}</b> — ${formatMoneyExact(c.penalty)} penalty`,
      kind: 'error', duration: 6000,
    });
    bus.emit('contract:failed', { contract: c, penalty: c.penalty });
  }

  // ------------------------------------------------------------------- time
  onNewDay(day) {
    for (let i = this.accepted.length - 1; i >= 0; i--) {
      if (day > this.accepted[i].dueDay) this.expire(i);
    }
    this.refresh(true);
  }

  daysLeft(c) { return Math.max(0, (c.dueDay || 0) - (this.game.get('economy')?.day ?? 1)); }

  // ---------------------------------------------------------------- persist
  save() {
    return {
      available: this.available.map((c) => ({ ...c })),
      accepted: this.accepted.map((c) => ({ ...c, progress: [...c.progress] })),
      seed: this.seed,
      completed: this.completed, failed: this.failed, lifetimeReward: this.lifetimeReward,
      lastRefreshDay: this._lastRefreshDay,
    };
  }

  load(d) {
    if (!d) return;
    this.seed = d.seed ?? this.seed;
    this.available = Array.isArray(d.available) ? d.available : [];
    this.accepted = (Array.isArray(d.accepted) ? d.accepted : []).map((c) => ({
      ...c, progress: Array.isArray(c.progress) ? c.progress : c.requirements.map(() => 0),
    }));
    this.completed = d.completed || 0;
    this.failed = d.failed || 0;
    this.lifetimeReward = d.lifetimeReward || 0;
    this._lastRefreshDay = d.lastRefreshDay || 0;
    if (!this.available.length) this.refresh();
  }
}
