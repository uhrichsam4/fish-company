import { bus } from '../core/EventBus.js';
import { RESEARCH_BRANCHES, RESEARCH_BY_ID, RESEARCH_NODES, RESEARCH_TOTAL } from '../data/research.js';
import { REGION_BY_ID } from '../data/regions.js';
import { formatMoneyExact, clamp } from '../util/math.js';

/** Fishing-bonus keys are multiplicative except autoReel, which is additive. */
const FISHING_KEYS = [
  'castPower', 'reelSpeed', 'maxWeight', 'hookChance', 'lineStrength',
  'lineLength', 'attract', 'rareBonus',
];

/**
 * The research tree: buys nodes, then folds every unlocked node's effects into
 * a small set of plain properties other systems read once per use.
 *
 *   inventory.fishingStats() -> research.fishingBonus
 *   Economy.priceFor()       -> research.priceMult
 *   workers / boats / subs   -> wageMult, fuelMult, repairMult, workerSlots…
 *
 * Aggregates are recomputed only when the unlocked set (or the harbour's
 * research discount) changes — never per frame.
 */
export class Research {
  constructor(game) {
    this.game = game;
    this.name = 'research';
    this.order = 32;

    /** @type {Set<string>} unlocked node ids */
    this.unlocked = new Set();
    /** Live catalogue handed to the UI; costs already include the lab discount. */
    this.branches = [];
    this.total = RESEARCH_TOTAL;
    /** 0..0.6 — reduces every node price (Research Lab building). */
    this.discount = 0;

    // ---- aggregates (recomputed by _recompute) ----
    this.fishingBonus = {
      castPower: 1, reelSpeed: 1, maxWeight: 1, hookChance: 1, lineStrength: 1,
      lineLength: 1, attract: 1, rareBonus: 1, autoReel: 0,
    };
    this.priceMult = 1;
    this.wageMult = 1;
    this.fuelMult = 1;
    this.repairMult = 1;
    this.catchRateMult = 1;
    this.xpMult = 1;
    this.sonarLevel = 0;
    this.crushDepth = 0;
    this.storageBonus = 0;
    this.workerSlots = 0;
    this.boatSlots = 0;
    this.processLevels = 0;
    /** @type {Set<string>} feature ids unlocked by research */
    this.features = new Set();

    this._rebuildBranches();
    this._recompute();
  }

  async init(game) {
    bus.on('company:research', ({ id }) => this.buy(id));
    bus.on('debug:unlockResearch', () => this.unlockAll());
    bus.on('game:newgame', () => this.reset());
    // The Research Lab changes every price; rebuild the catalogue when it lands.
    bus.on('harbor:built', () => { this.refreshDiscount(); });
    this.refreshDiscount();
    return this;
  }

  // ------------------------------------------------------------------ queries
  has(id) { return this.unlocked.has(id); }

  node(id) { return RESEARCH_BY_ID[id] || null; }

  /** Live price after the Research Lab discount. */
  costOf(id) {
    const n = RESEARCH_BY_ID[id];
    if (!n) return 0;
    return Math.max(1, Math.round(n.cost * (1 - this.discount)));
  }

  /** Everything gating a node is satisfied and it is not already owned. */
  available(id) {
    const n = RESEARCH_BY_ID[id];
    if (!n || this.unlocked.has(id)) return false;
    for (const r of n.requires) if (!this.unlocked.has(r)) return false;
    const quests = this.game.get('quests');
    if (n.reqRegion && quests && !quests.isRegionUnlocked(n.reqRegion)) return false;
    if (n.reqQuest && quests && !quests.completed.has(n.reqQuest)) return false;
    return true;
  }

  /** Human-readable reason a node cannot be bought right now. */
  lockReason(id) {
    const n = RESEARCH_BY_ID[id];
    if (!n) return 'Unknown technology';
    if (this.unlocked.has(id)) return 'Already researched';
    const missing = n.requires.filter((r) => !this.unlocked.has(r));
    if (missing.length) return `Requires ${missing.map((m) => RESEARCH_BY_ID[m]?.name || m).join(', ')}`;
    const quests = this.game.get('quests');
    if (n.reqRegion && quests && !quests.isRegionUnlocked(n.reqRegion)) {
      return `Requires ${REGION_BY_ID[n.reqRegion]?.name || n.reqRegion}`;
    }
    if (n.reqQuest && quests && !quests.completed.has(n.reqQuest)) return 'Requires an earlier contract';
    return '';
  }

  /** Convenience for gameplay systems: `research.hasFeature('processing')`. */
  hasFeature(id) { return this.features.has(id); }

  // ------------------------------------------------------------------ buying
  buy(id) {
    const n = RESEARCH_BY_ID[id];
    if (!n) { console.warn('[Research] unknown node', id); return false; }
    if (this.unlocked.has(id)) return false;
    if (!this.available(id)) {
      bus.emit('toast', { text: this.lockReason(id), kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    const eco = this.game.get('economy');
    const cost = this.costOf(id);
    if (!eco || !eco.spend(cost, 'research')) return false;

    this.unlocked.add(id);
    this._recompute();
    this.game.audio?.play('levelup', { volume: 0.65 });
    bus.emit('toast', {
      text: `🔬 Researched <b>${n.name}</b> — ${formatMoneyExact(cost)}`,
      kind: 'gold', duration: 4600,
    });
    bus.emit('research:unlocked', { id, node: n });
    return true;
  }

  /** Debug helper — grants everything without spending. */
  unlockAll() {
    let added = 0;
    for (const n of RESEARCH_NODES) {
      if (this.unlocked.has(n.id)) continue;
      this.unlocked.add(n.id);
      added++;
    }
    this._recompute();
    for (const n of RESEARCH_NODES) bus.emit('research:unlocked', { id: n.id, node: n });
    bus.emit('toast', { text: `🔬 All ${added} technologies unlocked`, kind: 'gold' });
    return added;
  }

  reset() {
    this.unlocked.clear();
    this.refreshDiscount();
    this._recompute();
  }

  /** Pull the current Research Lab discount from the harbour and rebuild costs. */
  refreshDiscount() {
    const d = clamp(this.game.get('harbor')?.researchDiscount || 0, 0, 0.6);
    if (d === this.discount && this.branches.length) return;
    this.discount = d;
    this._rebuildBranches();
  }

  // ------------------------------------------------------------- aggregation
  /** Rebuild the UI catalogue (cheap; only on discount change or boot). */
  _rebuildBranches() {
    this.branches = RESEARCH_BRANCHES.map((b) => ({
      id: b.id, icon: b.icon, name: b.name, desc: b.desc,
      nodes: b.nodes.map((n) => ({ ...n, cost: Math.max(1, Math.round(n.cost * (1 - this.discount))) })),
    }));
  }

  /** Fold every unlocked node's effects into the flat aggregates. */
  _recompute() {
    const fb = this.fishingBonus;
    for (const k of FISHING_KEYS) fb[k] = 1;
    fb.autoReel = 0;
    this.priceMult = 1;
    this.wageMult = 1;
    this.fuelMult = 1;
    this.repairMult = 1;
    this.catchRateMult = 1;
    this.xpMult = 1;
    this.sonarLevel = 0;
    this.crushDepth = 0;
    this.storageBonus = 0;
    this.workerSlots = 0;
    this.boatSlots = 0;
    this.processLevels = 0;
    this.features.clear();

    for (const id of this.unlocked) {
      const n = RESEARCH_BY_ID[id];
      if (!n) continue;
      const e = n.effects || {};
      if (e.fishingBonus) {
        for (const k of FISHING_KEYS) if (e.fishingBonus[k] != null) fb[k] *= e.fishingBonus[k];
        if (e.fishingBonus.autoReel != null) fb.autoReel += e.fishingBonus.autoReel;
      }
      if (e.priceMult != null) this.priceMult *= e.priceMult;
      if (e.wageMult != null) this.wageMult *= e.wageMult;
      if (e.fuelMult != null) this.fuelMult *= e.fuelMult;
      if (e.repairMult != null) this.repairMult *= e.repairMult;
      if (e.catchRateMult != null) this.catchRateMult *= e.catchRateMult;
      if (e.xpMult != null) this.xpMult *= e.xpMult;
      if (e.sonarLevel != null) this.sonarLevel = Math.max(this.sonarLevel, e.sonarLevel);
      if (e.crushDepth != null) this.crushDepth = Math.max(this.crushDepth, e.crushDepth);
      if (e.processLevels != null) this.processLevels = Math.max(this.processLevels, e.processLevels);
      if (e.storageBonus != null) this.storageBonus += e.storageBonus;
      if (e.workerSlots != null) this.workerSlots += e.workerSlots;
      if (e.boatSlots != null) this.boatSlots += e.boatSlots;
      if (e.unlock) this.features.add(e.unlock);
    }
    this.applyToInventory();
    bus.emit('research:changed', { unlocked: this.unlocked.size, total: this.total });
  }

  /**
   * Storage from research and from harbour buildings both land on the same
   * inventory field, so it is always recomputed from both sources.
   */
  applyToInventory() {
    const inv = this.game.get('inventory');
    if (!inv) return;
    const harborBonus = this.game.get('harbor')?.storageBonus || 0;
    inv.capacityBonus = this.storageBonus + harborBonus;
  }

  // ---------------------------------------------------------------- persist
  save() { return { unlocked: [...this.unlocked] }; }

  load(d) {
    if (!d) return;
    this.unlocked = new Set(d.unlocked || []);
    this.refreshDiscount();
    this._recompute();
  }
}
