import { bus } from '../core/EventBus.js';
import { clamp, makeRNG, formatMoneyExact, formatWeight } from '../util/math.js';
import { FISH_SPECIES, RARITY_ORDER } from '../data/fishData.js';

/**
 * Three small goals a day, refreshed on the day rollover.
 *
 * Deliberately not built on the quest system. Quests are authored content with
 * chains, givers and flags; these are generated, disposable and must not
 * pollute the completed-quest list or the tracked-objective UI. They share the
 * same *vocabulary* -- catch, weigh, sell -- and nothing else.
 *
 * The seed is the day number, so every player on a given day gets the same
 * three, and a reload does not reroll them into something easier.
 */

const TEMPLATES = [
  {
    id: 'catch_any', weight: 100,
    make: (rng) => { const n = 3 + Math.floor(rng() * 6); return { text: `Catch ${n} fish`, goal: n, reward: 60 + n * 18 }; },
    track: 'catch',
  },
  {
    id: 'catch_big', weight: 70,
    make: (rng) => { const kg = [2, 3, 5, 8][Math.floor(rng() * 4)]; return { text: `Catch something over ${kg} kg`, goal: 1, reward: 120 + kg * 40, minWeight: kg }; },
    track: 'catch',
  },
  {
    id: 'sell_value', weight: 80,
    make: (rng) => { const v = [200, 400, 800][Math.floor(rng() * 3)]; return { text: `Sell ${formatMoneyExact(v)} of fish`, goal: v, reward: Math.round(v * 0.35) }; },
    track: 'sell',
  },
  {
    id: 'catch_species', weight: 60,
    make: (rng) => {
      const pool = FISH_SPECIES.filter((s) => !s.boss && s.tier <= 3);
      const sp = pool[Math.floor(rng() * pool.length)] || pool[0];
      const n = 1 + Math.floor(rng() * 3);
      return { text: `Catch ${n} ${sp.name}`, goal: n, reward: 90 + n * 45, speciesId: sp.id };
    },
    track: 'catch',
  },
  {
    id: 'catch_rare', weight: 40,
    make: () => ({ text: 'Catch anything Rare or better', goal: 1, reward: 320, minRarity: 2 }),
    track: 'catch',
  },
  {
    id: 'chop_wood', weight: 50,
    make: (rng) => { const n = 6 + Math.floor(rng() * 10); return { text: `Gather ${n} wood`, goal: n, reward: 70 + n * 8 }; },
    track: 'wood',
  },
  {
    id: 'trap_collect', weight: 45,
    make: (rng) => { const n = 2 + Math.floor(rng() * 4); return { text: `Collect ${n} fish from traps`, goal: n, reward: 110 + n * 30 }; },
    track: 'trap',
  },
];

export class DailyChallenges {
  constructor(game) {
    this.game = game;
    this.name = 'daily';
    this.order = 58;
    /** @type {Array<object>} */
    this.list = [];
    this.day = -1;
  }

  async init(game) {
    bus.on('day:advanced', () => this.roll());
    bus.on('game:newgame', () => { this.day = -1; this.roll(); });

    bus.on('fishing:caught', ({ instance }) => this._onCatch(instance));
    bus.on('sell:completed', ({ total }) => this._progress('sell', total));
    // trees:felled already carries the amount; resources:changed would double
    // count it, since felling adds the wood that fires that event.
    bus.on('trees:felled', ({ wood }) => this._progress('wood', wood));
    bus.on('traps:collected', ({ count }) => this._progress('trap', count));
    return this;
  }

  get currentDay() { return this.game.get('economy')?.day ?? 1; }

  roll() {
    const day = this.currentDay;
    if (day === this.day && this.list.length) return;
    this.day = day;
    // Seeded on the day so a reload cannot reroll a hard one into an easy one.
    const rng = makeRNG(0x9e37 ^ (day * 2654435761));
    const picked = [];
    const pool = [...TEMPLATES];
    for (let i = 0; i < 3 && pool.length; i++) {
      let total = 0;
      for (const t of pool) total += t.weight;
      let r = rng() * total, idx = 0;
      for (let k = 0; k < pool.length; k++) { r -= pool[k].weight; if (r <= 0) { idx = k; break; } }
      const tpl = pool.splice(idx, 1)[0];
      const made = tpl.make(rng);
      picked.push({ id: `${tpl.id}_${day}`, tpl: tpl.id, track: tpl.track, progress: 0, done: false, claimed: false, ...made });
    }
    this.list = picked;
    bus.emit('daily:rolled', { day, list: this.list });
    bus.emit('toast', {
      text: `📋 <b>Today's challenges</b><br>${this.list.map((c) => `· ${c.text}`).join('<br>')}`,
      kind: 'gold', duration: 8000,
    });
  }

  _onCatch(instance) {
    if (!instance) return;
    for (const c of this.list) {
      if (c.done || c.track !== 'catch') continue;
      if (c.speciesId && instance.speciesId !== c.speciesId) continue;
      if (c.minWeight && instance.weight < c.minWeight) continue;
      if (c.minRarity != null && RARITY_ORDER.indexOf(instance.rarity) < c.minRarity) continue;
      this._bump(c, 1);
    }
  }

  _progress(track, amount) {
    if (!(amount > 0)) return;
    for (const c of this.list) {
      if (c.done || c.track !== track) continue;
      this._bump(c, amount);
    }
  }

  _bump(c, amount) {
    c.progress = Math.min(c.goal, c.progress + amount);
    if (c.progress < c.goal) { bus.emit('daily:progress', { challenge: c }); return; }
    c.done = true;
    // Paid on completion rather than needing a claim step: a challenge you
    // have to remember to collect is a chore, not a reward.
    this.game.get('economy')?.add(c.reward, 'daily');
    this.game.audio?.play('levelup', { volume: 0.55 });
    bus.emit('daily:completed', { challenge: c });
    bus.emit('toast', {
      text: `✅ <b>${c.text}</b><br>+${formatMoneyExact(c.reward)}`,
      kind: 'success', duration: 5000,
    });
  }

  update() {
    // Catch the first day, and any rollover that did not emit day:advanced.
    if (this.day !== this.currentDay) this.roll();
  }

  save() { return { day: this.day, list: this.list.map((c) => ({ ...c })) }; }

  load(d) {
    if (!d?.list) return;
    this.day = d.day ?? -1;
    this.list = d.list;
  }
}
