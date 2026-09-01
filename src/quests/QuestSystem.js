import { bus } from '../core/EventBus.js';
import { QUESTS, QUEST_BY_ID, START_QUESTS } from '../data/quests.js';
import { REGIONS, REGION_BY_ID } from '../data/regions.js';
import { getItem } from '../data/equipment.js';
import { formatMoneyExact, clamp01 } from '../util/math.js';

/**
 * Quest tracking + region unlock gating + the on-screen objective.
 * Objectives are matched from gameplay events; nothing here is scripted
 * against a specific system's internals.
 */
export class QuestSystem {
  constructor(game) {
    this.game = game;
    this.name = 'quests';
    this.order = 70;
    /** @type {Map<string,{id, progress:number[], startedAt:number}>} */
    this.active = new Map();
    this.completed = new Set();
    this.flags = new Set();
    this.unlockedRegions = new Set(REGIONS.filter((r) => r.unlocked).map((r) => r.id));
    this.unlockedFeatures = new Set();
    this.tracked = null;
    this.xp = 0;
    this.level = 1;
  }

  async init(game) {
    this._wire();
    bus.on('game:newgame', () => this.reset());
    if (!this.active.size && !this.completed.size) this.reset();
    return this;
  }

  reset() {
    this.active.clear();
    this.completed.clear();
    this.flags.clear();
    this.unlockedRegions = new Set(REGIONS.filter((r) => r.unlocked).map((r) => r.id));
    this.unlockedFeatures.clear();
    this.xp = 0; this.level = 1;
    for (const id of START_QUESTS) this.start(id);
    this.refreshObjective();
  }

  _wire() {
    bus.on('fishing:caught', ({ instance, method }) => this.event('catch', { instance, method }));
    bus.on('weapon:caught', ({ instance, method }) => this.event('catch', { instance, method }));
    bus.on('worker:caught', ({ instance, worker }) => { this.event('workerCatch', { instance }); });
    bus.on('economy:sold', ({ instance, price }) => this.event('sell', { instance, price }));
    bus.on('money:changed', ({ total }) => this.event('money', { total }));
    bus.on('shop:purchased', ({ item }) => this.event('buy', { item }));
    bus.on('tricks:landed', ({ tricks, combo }) => { this.event('trick', { tricks }); this.event('combo', { combo }); });
    bus.on('boss:defeated', ({ id }) => this.event('boss', { id }));
    bus.on('region:entered', (r) => this.event('region', { id: r.id }));
    bus.on('workers:changed', ({ count }) => this.event('worker', { count }));
    bus.on('boats:changed', ({ count }) => this.event('boat', { count }));
    bus.on('fleet:tripComplete', (d) => this.event('fleetTrip', d));
    bus.on('fleets:changed', ({ count }) => this.event('fleetCount', { count }));
    bus.on('research:unlocked', ({ id }) => this.event('research', { id }));
    bus.on('player:depth', ({ depth }) => this.event('depth', { depth }));
    bus.on('atlas:discovered', ({ total }) => this.event('atlas', { total }));
    bus.on('quest:flag', ({ flag }) => this.setFlag(flag));
    bus.on('region:unlock', ({ id }) => this.unlockRegion(id, true));
    bus.on('region:tryUnlock', ({ id }) => this.tryUnlockRegion(id));
    bus.on('debug:completeQuest', () => { if (this.tracked) this.complete(this.tracked); });
    bus.on('debug:unlockAllQuests', () => {
      for (const q of QUESTS) { this.completed.add(q.id); }
      for (const r of REGIONS) this.unlockRegion(r.id, true);
      this.active.clear();
      this.refreshObjective();
    });
  }

  // ------------------------------------------------------------- lifecycle
  start(id) {
    const q = QUEST_BY_ID[id];
    if (!q || this.active.has(id)) return false;
    if (this.completed.has(id) && !q.repeatable) return false;
    if (q.requires && !q.requires.every((r) => this.completed.has(r))) return false;
    this.active.set(id, { id, progress: q.objectives.map(() => 0), startedAt: this.game.time });
    if (!this.tracked) this.tracked = id;
    bus.emit('quest:started', { quest: q });
    if (q.order !== 0 || q.chain !== 'intro') {
      bus.emit('toast', { text: `📋 New quest: <b>${q.name}</b>`, kind: 'gold', duration: 4200 });
    }
    this.refreshObjective();
    return true;
  }

  setFlag(flag) {
    if (this.flags.has(flag)) return;
    this.flags.add(flag);
    this.event('custom', { flag });
  }

  /** Feed a gameplay event to every active quest objective. */
  event(type, data) {
    let changed = false;
    for (const [id, st] of this.active) {
      const q = QUEST_BY_ID[id];
      if (!q) continue;
      for (let i = 0; i < q.objectives.length; i++) {
        const o = q.objectives[i];
        if (o.type !== type) continue;
        const inc = this.matchObjective(o, data);
        if (inc <= 0) continue;
        const cap = objectiveTarget(o);
        const before = st.progress[i];
        st.progress[i] = o.absolute ? Math.max(st.progress[i], inc) : Math.min(cap, st.progress[i] + inc);
        if (st.progress[i] !== before) changed = true;
      }
      if (this.isComplete(q, st)) this.complete(id);
    }
    if (changed) this.refreshObjective();
  }

  /** @returns {number} amount to add (or absolute value for absolute objectives) */
  matchObjective(o, d) {
    switch (o.type) {
      case 'custom': return d.flag === o.flag ? 1 : 0;
      case 'catchAny': return d.instance ? 1 : 0;
      case 'catch': {
        const i = d.instance;
        if (!i) return 0;
        if (o.species) {
          const list = Array.isArray(o.species) ? o.species : [o.species];
          if (!list.includes(i.speciesId)) return 0;
        }
        if (o.rarity) {
          const list = Array.isArray(o.rarity) ? o.rarity : [o.rarity];
          if (!list.includes(i.rarity)) return 0;
        }
        if (o.variant && i.variantId !== o.variant) return 0;
        if (o.minWeight && i.weight < o.minWeight) return 0;
        if (o.region) {
          const r = this.game.get('world')?.activeRegion;
          if (r?.id !== o.region) return 0;
        }
        if (o.weather) {
          const w = this.game.get('weather')?.current?.id;
          const list = Array.isArray(o.weather) ? o.weather : [o.weather];
          if (!list.includes(w)) return 0;
        }
        return 1;
      }
      case 'workerCatch': return 1;
      case 'sell': return o.value ? (d.price || 0) : 1;
      case 'money': { o.absolute = true; return d.total >= o.amount ? o.amount : 0; }
      case 'buy': {
        if (o.item) return d.item?.id === o.item ? 1 : 0;
        if (o.tier) return (d.item?.tier ?? 0) >= o.tier ? 1 : 0;
        return 1;
      }
      case 'trick': {
        if (!d.tricks?.length) return 0;
        if (o.trick) return d.tricks.some((t) => t.id === o.trick) ? 1 : 0;
        return 1;
      }
      case 'combo': { o.absolute = true; return d.combo || 0; }
      case 'boss': return d.id === o.id ? 1 : 0;
      case 'region': return d.id === o.id ? 1 : 0;
      case 'worker': case 'boat': case 'fleetCount': { o.absolute = true; return d.count || 0; }
      case 'fleetTrip': return 1;
      case 'research': return d.id === o.id ? 1 : 0;
      case 'depth': { o.absolute = true; return d.depth >= o.metres ? o.metres : 0; }
      case 'atlas': { o.absolute = true; return d.total || 0; }
      default: return 0;
    }
  }

  isComplete(q, st) {
    return q.objectives.every((o, i) => st.progress[i] >= objectiveTarget(o));
  }

  complete(id) {
    const q = QUEST_BY_ID[id];
    if (!q || !this.active.has(id)) return;
    this.active.delete(id);
    if (!q.repeatable) this.completed.add(id);
    if (this.tracked === id) this.tracked = null;

    const eco = this.game.get('economy');
    const inv = this.game.get('inventory');
    const r = q.rewards || {};
    if (r.money) eco?.add(r.money, 'quest_reward');
    if (r.xp) this.addXP(r.xp);
    if (r.item) { inv?.acquire(r.item); bus.emit('toast', { text: `Received: ${getItem(r.item)?.name || r.item}`, kind: 'success' }); }
    if (r.unlockRegion) this.unlockRegion(r.unlockRegion, true);
    if (r.unlockFeature) { this.unlockedFeatures.add(r.unlockFeature); bus.emit('feature:unlocked', { id: r.unlockFeature }); }

    this.game.audio.play('quest_complete', { volume: 0.7 });
    bus.emit('toast', {
      text: `✅ <b>${q.name}</b> complete${r.money ? ` — ${formatMoneyExact(r.money)}` : ''}`,
      kind: 'success', duration: 5000,
    });
    bus.emit('quest:completed', { quest: q });

    if (q.onComplete) this.start(q.onComplete);
    // Any quest whose prerequisites are now satisfied becomes available.
    for (const cand of QUESTS) {
      if (this.completed.has(cand.id) || this.active.has(cand.id)) continue;
      if (cand.requires?.length && cand.requires.every((x) => this.completed.has(x))) this.start(cand.id);
    }
    this.refreshObjective();
  }

  addXP(n) {
    this.xp += n;
    const need = () => 100 * Math.pow(1.35, this.level - 1);
    while (this.xp >= need()) {
      this.xp -= need();
      this.level++;
      this.game.audio.play('levelup', { volume: 0.7 });
      bus.emit('toast', { text: `⭐ Level ${this.level}!`, kind: 'gold', duration: 4200 });
      bus.emit('player:levelup', { level: this.level });
    }
  }

  // ------------------------------------------------------------- regions
  isRegionUnlocked(id) { return this.unlockedRegions.has(id); }

  unlockRegion(id, announce = false) {
    if (this.unlockedRegions.has(id)) return;
    this.unlockedRegions.add(id);
    const r = REGION_BY_ID[id];
    if (announce && r) {
      bus.emit('toast', { text: `🏝 New region unlocked: <b>${r.name}</b>`, kind: 'gold', duration: 6000 });
      this.game.audio.play('levelup', { volume: 0.8 });
    }
    bus.emit('region:unlocked', { id });
  }

  tryUnlockRegion(id) {
    const r = REGION_BY_ID[id];
    if (!r || this.unlockedRegions.has(id)) return;
    const req = r.unlockReq || {};
    if (req.boss && !this.completed.has(bossQuestFor(req.boss))) {
      bus.emit('toast', { text: `Requires defeating ${req.boss}`, kind: 'error' }); return;
    }
    if (req.research && !this.game.get('research')?.has(req.research)) {
      bus.emit('toast', { text: `Requires research: ${req.research}`, kind: 'error' }); return;
    }
    const eco = this.game.get('economy');
    if (r.unlockCost > 0 && !eco?.spend(r.unlockCost, 'region_unlock')) return;
    this.unlockRegion(id, true);
  }

  // ------------------------------------------------------------- display
  refreshObjective() {
    if (!this.tracked || !this.active.has(this.tracked)) {
      // Prefer the earliest main-chain quest, else any active.
      let best = null, bestScore = Infinity;
      for (const [id] of this.active) {
        const q = QUEST_BY_ID[id];
        const score = (q.chain === 'side' ? 1000 : 0) + (q.order ?? 50);
        if (score < bestScore) { bestScore = score; best = id; }
      }
      this.tracked = best;
    }
    if (!this.tracked) { bus.emit('objective:changed', null); return; }
    const q = QUEST_BY_ID[this.tracked];
    const st = this.active.get(this.tracked);
    if (!q || !st) { bus.emit('objective:changed', null); return; }
    const parts = q.objectives.map((o, i) => {
      const cap = objectiveTarget(o);
      const p = st.progress[i];
      return cap > 1 ? `${o.text}: ${Math.floor(p)}/${cap}` : o.text;
    });
    bus.emit('objective:changed', { text: q.name, progress: parts.join('  ·  '), quest: q });
  }

  activeList() {
    return [...this.active.keys()].map((id) => {
      const q = QUEST_BY_ID[id];
      const st = this.active.get(id);
      return {
        ...q,
        progress: q.objectives.map((o, i) => ({ text: o.text, cur: st.progress[i], max: objectiveTarget(o) })),
        pct: clamp01(q.objectives.reduce((a, o, i) => a + st.progress[i] / objectiveTarget(o), 0) / q.objectives.length),
      };
    });
  }

  update(dt, game) {
    // Depth objective needs polling; everything else is event-driven.
    const player = game.get('player');
    const ocean = game.get('ocean');
    if (player && ocean) {
      const depth = Math.max(0, ocean.heightAt(player.position.x, player.position.z) - player.position.y);
      if (depth > 5 && depth > (this._lastDepth || 0) + 5) {
        this._lastDepth = depth;
        const eco = game.get('economy');
        if (eco) eco.stats.deepestDive = Math.max(eco.stats.deepestDive || 0, depth);
        bus.emit('player:depth', { depth });
      }
    }
  }

  save() {
    return {
      active: [...this.active.entries()].map(([id, st]) => [id, st.progress]),
      completed: [...this.completed], flags: [...this.flags],
      regions: [...this.unlockedRegions], features: [...this.unlockedFeatures],
      tracked: this.tracked, xp: this.xp, level: this.level,
    };
  }
  load(d) {
    if (!d) return;
    this.active = new Map((d.active || []).map(([id, p]) => [id, { id, progress: p, startedAt: 0 }]));
    this.completed = new Set(d.completed || []);
    this.flags = new Set(d.flags || []);
    this.unlockedRegions = new Set(d.regions || ['crash']);
    this.unlockedFeatures = new Set(d.features || []);
    this.tracked = d.tracked || null;
    this.xp = d.xp || 0; this.level = d.level || 1;
    if (!this.active.size && !this.completed.size) for (const id of START_QUESTS) this.start(id);
    this.refreshObjective();
  }
}

function objectiveTarget(o) {
  if (o.type === 'money') return o.amount;
  if (o.type === 'depth') return o.metres;
  return o.count ?? 1;
}

function bossQuestFor(bossId) {
  const q = QUESTS.find((x) => x.objectives.some((o) => o.type === 'boss' && o.id === bossId));
  return q?.id || '';
}
