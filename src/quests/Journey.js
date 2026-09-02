import { bus } from '../core/EventBus.js';
import { formatMoneyExact } from '../util/math.js';
import { RARITY_ORDER } from '../data/fishData.js';

/**
 * The guided ladder a new player follows: one goal at a time, in order, from
 * "cast a line" to "survive a storm in a house you built".
 *
 * This is deliberately not the quest system and not the daily challenges.
 * Quests are optional authored content you accept from a giver; dailies are
 * disposable and reroll. The journey is the game's spine -- it always has
 * exactly one active step, it never reorders, and it is the answer to "what am
 * I supposed to be doing", which is the question the game was failing to
 * answer at all.
 *
 * Each step teaches exactly one mechanic and then gets out of the way. The
 * ordering is load-bearing: nothing asks you to build before you have wood,
 * and nothing asks you to spend before you have sold. A step that can be
 * completed by accident before it is offered is still credited when it comes
 * up (see `_seed`), because being told to do something you have already done
 * reads as the game not paying attention.
 */

const STEPS = [
  {
    id: 'cast', title: 'Wet a Line', how: 'Hold left mouse to charge, release to cast',
    goal: 1, on: 'fishing:cast', reward: { money: 25 },
  },
  {
    id: 'first_fish', title: 'Catch a Fish', how: 'Click when the line dips, reel it in, then E to grab the fish',
    goal: 1, on: 'fishing:caught', reward: { money: 60 },
  },
  {
    id: 'fill_bucket', title: 'Fill the Bucket', how: 'Grab it (E), kill it with the axe (2), throw it in the bucket (E)',
    goal: 4, on: 'fishing:caught', reward: { money: 90 },
  },
  {
    id: 'sell', title: 'Sell Your Catch', how: 'Find the sell station on the beach and press E',
    goal: 1, on: 'sell:completed', reward: { money: 120 }, marker: 'sell',
  },
  {
    id: 'axe', title: 'Chop a Tree', how: 'Press 2 for your axe, walk up to a tree and click',
    goal: 1, on: 'trees:felled', reward: { money: 80 }, marker: 'tree',
  },
  {
    id: 'wood', title: 'Gather 25 Wood', how: 'Fell trees, smash crates and rocks — all of it drops materials',
    goal: 25, on: 'trees:felled', amount: (e) => e.wood || 1, reward: { money: 150 },
    marker: 'tree',
  },
  {
    id: 'foundation', title: 'Lay a Foundation', how: 'Press B to open the build menu, then place a Foundation',
    goal: 1, on: 'build:placed', match: (e) => e.piece?.type === 'foundation',
    reward: { wood: 12 },
  },
  {
    id: 'walls', title: 'Put Up Walls', how: 'Place 3 walls on your foundation — R rotates',
    goal: 3, on: 'build:placed', match: (e) => String(e.piece?.type || '').startsWith('wall'),
    reward: { wood: 15 },
  },
  {
    id: 'roof', title: 'Get a Roof On', how: 'Place a roof on top of your walls',
    goal: 1, on: 'build:placed', match: (e) => e.piece?.type === 'roof',
    reward: { money: 250, wood: 10 },
  },
  {
    id: 'upgrade', title: 'Buy Better Gear', how: 'Visit the shop and buy anything — a better rod pays for itself',
    goal: 1, on: 'shop:purchased', reward: { money: 200 }, marker: 'shop',
  },
  {
    id: 'rare', title: 'Land Something Rare', how: 'Rare fish hold out in deeper water. Watch for circling birds',
    goal: 1, on: 'fishing:caught',
    match: (e) => RARITY_ORDER.indexOf(e.instance?.rarity) >= 2,
    reward: { money: 400 },
  },
  {
    id: 'trap', title: 'Set a Fish Trap', how: 'Traps keep catching while you do something else',
    goal: 1, on: 'traps:placed', reward: { money: 220 },
  },
  {
    id: 'seawall', title: 'Hold Back the Sea', how: 'Build a Sea Wall between the water and your house',
    goal: 2, on: 'build:placed', match: (e) => e.piece?.type === 'seawall',
    reward: { money: 300, stone: 8 },
  },
  {
    id: 'storm', title: 'Ride Out a Storm', how: 'Stay standing until the weather turns. Shelter helps',
    goal: 1, on: 'weather:changed',
    match: (e) => _sawStorm && !STORMY.has(e.weather?.id),
    reward: { money: 800 },
  },
  {
    id: 'rich', title: 'Turn a Profit', how: 'Bank $5,000. Sell, upgrade, repeat',
    goal: 5000, on: 'sell:completed', amount: (e) => e.total || 0,
    reward: { money: 1500 },
  },
];

/** Weather ids that count as "a storm you rode out". */
const STORMY = new Set(['storm', 'heavy_storm']);
/** Set by the weather listener so the storm step needs a storm, not just clear sky. */
let _sawStorm = false;

export class Journey {
  constructor(game) {
    this.game = game;
    this.name = 'journey';
    this.order = 57;
    this.index = 0;
    this.progress = 0;
    this.done = false;
    this._offs = [];
    /** Counts banked before a step was offered, so it can start part-done. */
    this._seed = Object.create(null);
  }

  get step() { return this.done ? null : STEPS[this.index]; }

  async init(game) {
    // One listener per distinct event, not one per step: several steps share
    // fishing:caught and build:placed, and only the active one should count.
    const events = [...new Set(STEPS.map((s) => s.on))];
    for (const ev of events) {
      this._offs.push(bus.on(ev, (payload) => this._onEvent(ev, payload || {})));
    }
    this._offs.push(bus.on('weather:changed', (w) => {
      if (STORMY.has(w?.weather?.id)) _sawStorm = true;
    }));
    this._offs.push(bus.on('game:newgame', () => {
      this.index = 0; this.progress = 0; this.done = false;
      this._seed = Object.create(null); _sawStorm = false;
      this._announce(true);
    }));
    // Late enough that the HUD exists to receive it.
    setTimeout(() => this._announce(true), 800);
    return this;
  }

  _onEvent(ev, payload) {
    const step = this.step;
    if (!step) return;
    if (step.on !== ev) {
      // Credit progress toward steps not yet offered, so finishing something
      // early is not silently thrown away.
      for (let i = this.index + 1; i < STEPS.length; i++) {
        const s = STEPS[i];
        if (s.on !== ev || (s.match && !s.match(payload))) continue;
        this._seed[s.id] = (this._seed[s.id] || 0) + (s.amount ? s.amount(payload) : 1);
      }
      return;
    }
    if (step.match && !step.match(payload)) return;
    this.progress += step.amount ? step.amount(payload) : 1;
    if (this.progress >= step.goal) this._complete(step);
    else { this._announce(); bus.emit('journey:progress', { step, progress: this.progress }); }
  }

  _complete(step) {
    const eco = this.game.get('economy');
    const res = this.game.get('resources');
    const r = step.reward || {};
    if (r.money) eco?.add(r.money, 'journey');
    for (const [id, n] of Object.entries(r)) if (id !== 'money') res?.add(id, n);

    const parts = [];
    if (r.money) parts.push(formatMoneyExact(r.money));
    for (const [id, n] of Object.entries(r)) if (id !== 'money') parts.push(`${n} ${id}`);

    this.game.audio?.play('levelup', { volume: 0.6 });
    bus.emit('toast', {
      text: `⭐ <b>${step.title}</b> — done!${parts.length ? `<br>+${parts.join(' · ')}` : ''}`,
      kind: 'gold', duration: 5200,
    });
    bus.emit('journey:completed', { step });

    this.index++;
    this.progress = 0;
    if (this.index >= STEPS.length) {
      this.done = true;
      bus.emit('journey:changed', {
        title: 'Journey complete', how: 'You built a fishing company. Now go bigger.',
        frac: 1, count: '', done: true,
      });
      return;
    }
    // Carry over anything already earned toward the newly active step.
    const next = STEPS[this.index];
    this.progress = Math.min(next.goal, this._seed[next.id] || 0);
    if (this.progress >= next.goal) { this._complete(next); return; }
    this._announce(true);
  }

  /**
   * Push the active step to its own HUD card.
   *
   * Not the objective card: that one belongs to the quest system, which emits
   * `objective:changed` with null whenever nothing is tracked. Sharing it would
   * mean the journey step vanished every time a quest was turned in.
   */
  _announce(loud = false) {
    const step = this.step;
    if (!step) return;
    bus.emit('journey:changed', {
      title: step.title,
      how: step.how,
      frac: step.goal > 1 ? this.progress / step.goal : 0,
      count: step.goal > 1 ? `${Math.floor(this.progress)}/${step.goal}` : '',
      index: this.index, total: STEPS.length,
    });
    if (loud) {
      bus.emit('toast', {
        text: `🎯 <b>${step.title}</b><br>${step.how}`,
        kind: '', duration: 6500,
      });
    }
  }

  /**
   * Where the active step wants you to go, for the waypoint layer.
   *
   * Telling a new player to "find the sell station" and then not showing them
   * where it is is the same as not telling them. Resolved live rather than
   * stored on the step, because the nearest tree changes as you fell them and
   * the nearest merchant changes as you travel.
   */
  markerTarget(game) {
    const step = this.step;
    if (!step?.marker) return null;
    const player = game.get('player');
    if (!player) return null;
    const near = (list, get) => {
      let best = null, bestD = Infinity;
      for (const it of list || []) {
        const p = get(it);
        if (!p) continue;
        const d = (p.x - player.position.x) ** 2 + (p.z - player.position.z) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    };

    if (step.marker === 'sell') {
      const p = near(game.get('world')?.sellZones, (z) => z.position);
      return p && { icon: '💰', label: 'Sell here', x: p.x, y: p.y + 1.4, z: p.z };
    }
    if (step.marker === 'shop') {
      const p = near((game.get('npcs')?.npcs || []).filter((n) => n.def?.shop),
        (n) => n.object?.position);
      return p && { icon: '🛒', label: 'Shop', x: p.x, y: p.y + 2.2, z: p.z };
    }
    if (step.marker === 'tree') {
      const trees = game.get('trees')?.trees;
      const p = near(trees ? [...trees.values()].filter((t) => !t.stump) : [],
        (t) => t.object?.position || t.position);
      return p && { icon: '🌴', label: 'Chop this', x: p.x, y: p.y + 3, z: p.z };
    }
    return null;
  }

  save() { return { index: this.index, progress: this.progress, done: this.done, seed: this._seed }; }

  load(d) {
    if (!d) return;
    this.index = Math.min(d.index ?? 0, STEPS.length);
    this.progress = d.progress ?? 0;
    this.done = !!d.done || this.index >= STEPS.length;
    this._seed = d.seed || Object.create(null);
    this._announce();
  }
}
