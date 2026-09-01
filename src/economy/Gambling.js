import { bus } from '../core/EventBus.js';
import { REGIONS, REGION_BY_ID } from '../data/regions.js';
import { speciesInRegion, rollFishInstance } from '../data/fishData.js';
import { CATEGORY } from '../data/equipment.js';
import { clamp, makeRNG, weightedPick, formatMoneyExact } from '../util/math.js';

/**
 * Doubloon Dee's table. In-game currency only — there is nothing to buy with
 * real money anywhere in this file, and there is no path to add any.
 *
 * ODDS HONESTY
 * ------------
 * Every advertised payout in this module is *derived from* the probability the
 * code actually rolls:
 *
 *     payout = round2( (1 / p) * (1 - HOUSE_EDGE) )
 *
 * so the return to player on any single bet is `p * payout ≈ 1 - HOUSE_EDGE`.
 * Nothing rolls a payout and then decides the odds afterwards; the wheel, the
 * race and the crates all draw from the same distribution they display. The
 * house edge is a stated constant and is shown in the UI.
 *
 * A per-day loss cap stops the table eating a run: once you are down
 * `lossCap` for the day, the table closes until the next in-game day.
 */

export const HOUSE_EDGE = 0.06;             // 6% — stated on every game screen

const round2 = (n) => Math.round(n * 100) / 100;

/** Fair payout for probability `p`, after the house edge. */
export function payoutFor(p) {
  if (!(p > 0)) return 0;
  return round2((1 / p) * (1 - HOUSE_EDGE));
}

// ---------------------------------------------------------------- roulette

/**
 * 24 pockets. The colour of a pocket is its rarity band, so the wheel reads
 * like the rarity chips everywhere else in the UI.
 */
export const ROULETTE_BANDS = [
  { key: 'common', name: 'Common', color: '#b8c0c8', pockets: 10 },
  { key: 'uncommon', name: 'Uncommon', color: '#5ddb6a', pockets: 7 },
  { key: 'rare', name: 'Rare', color: '#4aa8ff', pockets: 4 },
  { key: 'epic', name: 'Epic', color: '#b96bff', pockets: 2 },
  { key: 'legendary', name: 'Legendary', color: '#ffb340', pockets: 1 },
];
export const ROULETTE_POCKETS = ROULETTE_BANDS.reduce((a, b) => a + b.pockets, 0);   // 24

/** Fixed wheel layout so the animation lands on a real, visible pocket. */
export const ROULETTE_WHEEL = buildWheel();
function buildWheel() {
  // Spread the scarce colours evenly instead of clumping them.
  const order = [
    'common', 'uncommon', 'common', 'rare', 'uncommon', 'common', 'epic', 'uncommon',
    'common', 'rare', 'uncommon', 'common', 'legendary', 'uncommon', 'common', 'rare',
    'uncommon', 'common', 'epic', 'uncommon', 'common', 'rare', 'common', 'common',
  ];
  const counts = {};
  for (const k of order) counts[k] = (counts[k] || 0) + 1;
  for (const b of ROULETTE_BANDS) {
    if (counts[b.key] !== b.pockets) {
      console.warn('[Gambling] wheel layout does not match band counts', b.key, counts[b.key], b.pockets);
    }
  }
  return order;
}

export function rouletteOdds() {
  return ROULETTE_BANDS.map((b) => {
    const p = b.pockets / ROULETTE_POCKETS;
    return { ...b, p, payout: payoutFor(p), rtp: round2(p * payoutFor(p)) };
  });
}

// -------------------------------------------------------------------- race

const RACERS = [
  { id: 'r1', name: 'Chunk', emoji: '🐟', color: '#4aa8ff' },
  { id: 'r2', name: 'Mrs Teeth', emoji: '🦈', color: '#ff5470' },
  { id: 'r3', name: 'Nine Lives', emoji: '🐡', color: '#ffb340' },
  { id: 'r4', name: 'The Accountant', emoji: '🦑', color: '#b96bff' },
  { id: 'r5', name: 'Doorstop', emoji: '🦀', color: '#5ddb6a' },
  { id: 'r6', name: 'Unnamed', emoji: '🐠', color: '#2fd4c4' },
];

// ------------------------------------------------------------------- crates

/**
 * Crate outcome table. Multipliers are of the fee paid.
 * Σ weight·mult = 0.94 exactly — the same 6% edge as everything else.
 */
export const CRATE_TABLE = [
  { weight: 0.34, mult: 0.20, label: 'Waterlogged', color: '#b8c0c8' },
  { weight: 0.30, mult: 0.55, label: 'Damp but fine', color: '#b8c0c8' },
  { weight: 0.20, mult: 1.00, label: 'Break even, basically', color: '#5ddb6a' },
  { weight: 0.11, mult: 2.00, label: 'Now we are talking', color: '#4aa8ff' },
  { weight: 0.04, mult: 4.50, label: 'Someone hid this', color: '#b96bff' },
  { weight: 0.01, mult: 10.70, label: 'THE BIG CRATE', color: '#ffb340' },
];

// -------------------------------------------------------------- risk a fish

/**
 * Stake a stored fish. Σ weight·mult = 0.94.
 * 45% of the time the fish is simply gone — which is the entire point.
 */
export const RISK_TABLE = [
  { weight: 0.45, mult: 0, label: 'Gone. Straight over the side.', color: '#ff5470' },
  { weight: 0.22, mult: 1.0, label: 'Survives. No better, no worse.', color: '#b8c0c8' },
  { weight: 0.18, mult: 1.5, label: 'Weighed again, weighed heavier.', color: '#5ddb6a' },
  { weight: 0.10, mult: 2.2, label: 'A buyer materialises.', color: '#4aa8ff' },
  { weight: 0.04, mult: 4.0, label: 'Somebody upstairs likes you.', color: '#b96bff' },
  { weight: 0.01, mult: 7.0, label: 'The fish is now a legend.', color: '#ffb340' },
];

function tableEV(rows) {
  return rows.reduce((a, r) => a + r.weight * r.mult, 0);
}

// ---------------------------------------------------------------------------

export class Gambling {
  constructor(game) {
    this.game = game;
    this.name = 'gambling';
    this.order = 37;

    this.edge = HOUSE_EDGE;
    this.rng = makeRNG((Math.random() * 4294967296) >>> 0);

    /** Per-day guard rail. */
    this.day = 1;
    this.lostToday = 0;
    this.wonToday = 0;
    this.wageredToday = 0;
    this.lossCap = 1000;

    this.race = null;          // current race card
    this.lastResult = null;
    this._offs = [];
  }

  async init(game) {
    // Verified at boot: if anyone edits a table, the console says so loudly.
    for (const [name, rows] of [['crate', CRATE_TABLE], ['risk', RISK_TABLE]]) {
      const w = rows.reduce((a, r) => a + r.weight, 0);
      if (Math.abs(w - 1) > 1e-6) console.warn(`[Gambling] ${name} weights sum to ${w}, not 1`);
      const ev = tableEV(rows);
      if (Math.abs(ev - (1 - HOUSE_EDGE)) > 0.005) {
        console.warn(`[Gambling] ${name} EV is ${ev.toFixed(4)}, expected ${(1 - HOUSE_EDGE).toFixed(4)}`);
      }
    }

    this._ensureStats();
    this.recomputeCap();
    this.newRace();

    this._offs.push(bus.on('economy:newDay', () => this.onNewDay()));
    this._offs.push(bus.on('game:newgame', () => {
      this.lostToday = 0; this.wonToday = 0; this.wageredToday = 0;
      this._ensureStats(true);
      this.recomputeCap();
    }));

    // The gambling panel is owned by the UI manager so Esc/pointer-lock work.
    const { GamblingPanel } = await import('../ui/panels/GamblingPanel.js');
    this.panel = new GamblingPanel(game);
    game.get('ui')?.register('gambling', this.panel);

    this._offs.push(bus.on('interact:gambling', (d) => this.open(d)));
    return this;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }

  open(data = {}) {
    const ui = this.game.get('ui');
    if (ui?.panels?.has('gambling')) ui.show('gambling', data);
    else if (this.panel) { this.panel.data = data; this.panel.show(); }
  }

  // ---------------------------------------------------------------- limits

  get eco() { return this.game.get('economy'); }
  get inv() { return this.game.get('inventory'); }

  _ensureStats(reset = false) {
    const eco = this.eco;
    if (!eco) return null;
    if (!eco.stats.gambling || reset) {
      eco.stats.gambling = { wagered: 0, won: 0, plays: 0, biggestWin: 0, biggestLoss: 0, byGame: {} };
    }
    return eco.stats.gambling;
  }

  /** Loss cap is a quarter of what you are worth, floored so it is never trivial. */
  recomputeCap() {
    const eco = this.eco;
    const worth = Math.max(0, eco?.netWorth ?? eco?.money ?? 0);
    this.lossCap = Math.round(clamp(worth * 0.25, 1000, 5000000));
    return this.lossCap;
  }

  onNewDay() {
    this.day = this.eco?.day ?? this.day + 1;
    this.lostToday = 0;
    this.wonToday = 0;
    this.wageredToday = 0;
    this.recomputeCap();
    this.newRace();
  }

  get remainingToday() { return Math.max(0, this.lossCap - this.lostToday); }
  get capped() { return this.remainingToday <= 0; }

  /** Largest stake allowed right now, for any game. */
  maxStake() {
    const money = this.eco?.money ?? 0;
    return Math.max(0, Math.min(money, this.remainingToday));
  }

  /** Coin flip is deliberately more limited than the rest. */
  flipCap() {
    const worth = Math.max(0, this.eco?.netWorth ?? 0);
    return Math.round(clamp(worth * 0.1, 100, 250000));
  }

  /** @returns {{ok:boolean, reason?:string}} */
  canBet(stake) {
    if (!(stake > 0)) return { ok: false, reason: 'Pick a stake first.' };
    const eco = this.eco;
    if (!eco) return { ok: false, reason: 'No economy.' };
    if (stake > eco.money) return { ok: false, reason: 'You do not have it.' };
    if (this.capped) {
      return { ok: false, reason: `Daily loss cap reached (${formatMoneyExact(this.lossCap)}). Table closed until tomorrow.` };
    }
    if (stake > this.remainingToday) {
      return { ok: false, reason: `That would breach today's loss cap — ${formatMoneyExact(this.remainingToday)} left.` };
    }
    return { ok: true };
  }

  // -------------------------------------------------------------- accounting

  /**
   * One settled bet. `stake` leaves the wallet, `payout` comes back (0 on a
   * loss). Everything lands in eco.stats.gambling so the lifetime numbers are
   * real rather than decorative.
   */
  _settle(gameId, stake, payout, note = '', opts = {}) {
    const eco = this.eco;
    const stats = this._ensureStats();
    const net = Math.round(payout - stake);
    // Cash movement can differ from the accounting figures: a crate hands over
    // gear and fish as well as cash, and Risk Your Catch never touches the
    // wallet at all — it re-values a fish you already own.
    const cashOut = Math.round(opts.cashOut ?? stake);
    const cashIn = Math.round(opts.cashIn ?? payout);

    if (cashOut > 0) eco.add(-cashOut, 'gambling');
    if (cashIn > 0) eco.add(cashIn, 'gambling_win');

    if (stats) {
      stats.wagered += Math.round(stake);
      stats.won += Math.round(payout);
      stats.plays++;
      const g = (stats.byGame[gameId] ||= { wagered: 0, won: 0, plays: 0 });
      g.wagered += Math.round(stake);
      g.won += Math.round(payout);
      g.plays++;
      if (net > (stats.biggestWin || 0)) stats.biggestWin = net;
      if (-net > (stats.biggestLoss || 0)) stats.biggestLoss = -net;
    }

    this.wageredToday += Math.round(stake);
    if (net < 0) this.lostToday += -net;
    else this.wonToday += net;

    const res = { game: gameId, stake: Math.round(stake), payout: Math.round(payout), net, note };
    this.lastResult = res;
    if (opts.sound !== false) {
      this.game.audio?.play(opts.sound || (net > 0 ? 'coin' : 'ui_error'), { volume: net > 0 ? 0.6 : 0.3 });
    }
    bus.emit('gambling:settled', res);
    if (this.capped) {
      bus.emit('toast', {
        text: `Table closed — you hit today's ${formatMoneyExact(this.lossCap)} loss cap. Dee is buying.`,
        kind: 'warn', duration: 7000,
      });
    }
    return res;
  }

  // ----------------------------------------------------------------- games

  /**
   * FISH ROULETTE. One pocket in 24 is drawn uniformly; the bet wins if that
   * pocket's colour matches. p is exactly pockets/24.
   */
  spinRoulette(bandKey, stake) {
    const guard = this.canBet(stake);
    if (!guard.ok) return { ok: false, reason: guard.reason };
    const band = ROULETTE_BANDS.find((b) => b.key === bandKey);
    if (!band) return { ok: false, reason: 'Unknown colour.' };

    const pocket = (this.rng() * ROULETTE_POCKETS) | 0;
    const landed = ROULETTE_WHEEL[pocket];
    const p = band.pockets / ROULETTE_POCKETS;
    const payout = payoutFor(p);
    const win = landed === bandKey;
    const res = this._settle('roulette', stake, win ? stake * payout : 0,
      `${band.name} @ ${payout}× · landed ${landed}`);
    return { ok: true, pocket, landed, win, payout, p, ...res };
  }

  /**
   * FISH RACE. Six runners with published win probabilities; the winner is
   * drawn from exactly those probabilities and the animation is then built to
   * agree with the draw.
   */
  newRace() {
    const raw = RACERS.map((r) => ({ ...r, w: 0.5 + this.rng() * 2.6 }));
    const total = raw.reduce((a, r) => a + r.w, 0);
    const runners = raw.map((r) => {
      const p = clamp(r.w / total, 0.04, 0.5);
      return { ...r, p };
    });
    // Re-normalise after clamping so the published p really sums to 1.
    const norm = runners.reduce((a, r) => a + r.p, 0);
    for (const r of runners) {
      r.p = r.p / norm;
      r.payout = payoutFor(r.p);
      r.odds = `${r.payout.toFixed(2)}×`;
    }
    this.race = { id: `race${Date.now().toString(36)}`, runners, ran: false };
    return this.race;
  }

  runRace(runnerId, stake) {
    const guard = this.canBet(stake);
    if (!guard.ok) return { ok: false, reason: guard.reason };
    const race = this.race || this.newRace();
    const bet = race.runners.find((r) => r.id === runnerId);
    if (!bet) return { ok: false, reason: 'Unknown runner.' };

    const winner = weightedPick(race.runners, this.rng, 'p') || race.runners[0];
    // Finish order: winner first, the rest shuffled by their own weights.
    const rest = race.runners.filter((r) => r !== winner);
    const order = [winner];
    while (rest.length) {
      const next = weightedPick(rest, this.rng, 'p') || rest[0];
      rest.splice(rest.indexOf(next), 1);
      order.push(next);
    }
    // Per-runner finishing times, consistent with the order.
    const times = {};
    let t = 4.2 + this.rng() * 0.5;
    for (const r of order) { times[r.id] = t; t += 0.25 + this.rng() * 0.9; }

    const win = winner.id === bet.id;
    const res = this._settle('race', stake, win ? stake * bet.payout : 0,
      `${bet.name} @ ${bet.payout}× · ${winner.name} won`);
    const card = { ...race, winner: winner.id, order: order.map((r) => r.id), times, ran: true };
    this.race = this.newRace();
    return { ok: true, win, winner, bet, payout: bet.payout, card, ...res };
  }

  /**
   * COIN FLIP. Pays a clean 2×, so the edge lives in the probability instead:
   * you win 47% of the time. Both numbers are on the button.
   */
  get flipChance() { return (1 - HOUSE_EDGE) / 2; }      // 0.47
  get flipPayout() { return 2; }

  flip(stake) {
    const cap = this.flipCap();
    if (stake > cap) return { ok: false, reason: `Coin flip is capped at ${formatMoneyExact(cap)}.` };
    const guard = this.canBet(stake);
    if (!guard.ok) return { ok: false, reason: guard.reason };
    const win = this.rng() < this.flipChance;
    const res = this._settle('coinflip', stake, win ? stake * this.flipPayout : 0,
      win ? 'heads' : 'tails');
    return { ok: true, win, face: win ? 'heads' : 'tails', ...res };
  }

  /** Crate fees scale with progression so the game stays interesting. */
  crateFees() {
    const worth = Math.max(0, this.eco?.netWorth ?? 0);
    const base = clamp(Math.round(worth * 0.02 / 50) * 50, 100, 200000);
    return [
      { id: 'small', name: 'Bait Crate', fee: base, emoji: '📦' },
      { id: 'medium', name: 'Deck Crate', fee: base * 5, emoji: '🧰' },
      { id: 'large', name: 'Hold Crate', fee: base * 25, emoji: '🚢' },
    ];
  }

  /**
   * CRATE GAMBLE. Draws a multiplier from CRATE_TABLE, then hands over exactly
   * that much value as a mix of gear, fish and cash — the split is flavour, the
   * total is the number the table promised.
   */
  openCrate(feeId) {
    const fee = this.crateFees().find((f) => f.id === feeId);
    if (!fee) return { ok: false, reason: 'Unknown crate.' };
    const guard = this.canBet(fee.fee);
    if (!guard.ok) return { ok: false, reason: guard.reason };

    const row = weightedPick(CRATE_TABLE, this.rng, 'weight') || CRATE_TABLE[0];
    const target = Math.round(fee.fee * row.mult);
    let remaining = target;
    const contents = [];

    // 1) Gear, occasionally, and only something they do not already own.
    if (remaining > 200 && this.rng() < 0.25) {
      const item = this._pickItem(remaining * 0.9);
      if (item) {
        this.inv?.acquire(item.id);
        contents.push({ kind: 'item', label: item.name, icon: item.icon, value: item.price });
        remaining -= item.price;
      }
    }

    // 2) A fish, so a crate feels like it came out of the sea.
    if (remaining > 20 && this.rng() < 0.65) {
      const f = this._pickFish(remaining);
      if (f) {
        const stored = this.inv?.storeFish(f, { freshness: 1 });
        if (!stored) this.eco?.add(f.value, 'crate_fish');    // no room: paid out instead
        contents.push({
          kind: 'fish', label: f.name, icon: '🐟', value: f.value,
          rarity: f.rarity, stored: !!stored,
        });
        remaining -= f.value;
      }
    }

    // 3) The balance in cash, so the total is exactly what the table said.
    const cash = Math.max(0, Math.round(remaining));
    if (cash > 0) contents.push({ kind: 'cash', label: 'Cash', icon: '💵', value: cash });

    const delivered = contents.reduce((a, c) => a + c.value, 0);
    // The gear and the fish are already in the player's hands, so only the
    // cash slice moves through the wallet — but the whole delivered value is
    // what the odds promised, so that is what the statistics record.
    const res = this._settle('crate', fee.fee, delivered, `${row.label} · ×${row.mult}`,
      { cashOut: fee.fee, cashIn: cash, sound: 'crate_break' });
    return { ok: true, row, target, delivered, contents, ...res };
  }

  _pickItem(maxPrice) {
    const inv = this.inv;
    const pool = [];
    for (const cat of Object.values(CATEGORY)) {
      for (const it of cat.list) {
        if (!it.price || it.price > maxPrice) continue;
        if (!it.consumable && inv?.own(it.id)) continue;
        pool.push(it);
      }
    }
    if (!pool.length) return null;
    return pool[(this.rng() * pool.length) | 0];
  }

  /** Best fish we can roll that still fits under `maxValue`. */
  _pickFish(maxValue) {
    const quests = this.game.get('quests');
    const regions = REGIONS.filter((r) => !r.trench && (!quests || quests.isRegionUnlocked(r.id)));
    const rid = (regions.length ? regions[(this.rng() * regions.length) | 0] : REGION_BY_ID.crash).id;
    const pool = speciesInRegion(rid).filter((s) => !s.boss && !s.body?.startsWith('junk_'));
    if (!pool.length) return null;
    let best = null;
    for (let i = 0; i < 8; i++) {
      const sp = pool[(this.rng() * pool.length) | 0];
      const inst = rollFishInstance(sp, this.rng, { luck: 1.4 });
      if (!inst || inst.value > maxValue) continue;
      if (!best || inst.value > best.value) best = inst;
    }
    return best;
  }

  /**
   * RISK YOUR CATCH. Stake a stored fish; 45% of the time it is gone for good,
   * otherwise its value is multiplied. EV is the same 94% as everything else.
   */
  riskFish(index) {
    const inv = this.inv;
    const entry = inv?.fish?.[index];
    if (!entry) return { ok: false, reason: 'No such fish.' };
    const eco = this.eco;
    const stake = Math.round(eco.priceFor(entry.instance, {
      freshness: entry.freshness, processLevel: entry.processLevel,
    }) * (entry.styleMult || 1));

    if (this.capped) {
      return { ok: false, reason: `Daily loss cap reached (${formatMoneyExact(this.lossCap)}).` };
    }

    const row = weightedPick(RISK_TABLE, this.rng, 'weight') || RISK_TABLE[0];

    if (row.mult === 0) {
      inv.removeFish(index);
      const res = this._settle('risk', stake, 0, row.label, { cashOut: 0, cashIn: 0, sound: 'line_snap' });
      bus.emit('toast', { text: `\u{1F3A3} ${entry.instance.name} \u2014 <b>${row.label}</b>`, kind: 'error', duration: 5000 });
      return { ok: true, row, lost: true, ...res };
    }

    // Winning re-values the specimen in place; it is still a real fish you
    // then have to carry and sell.
    const before = entry.instance.value;
    entry.instance.value = Math.max(1, Math.round(before * row.mult));
    entry.gambleMult = (entry.gambleMult || 1) * row.mult;
    if (row.mult > 1) entry.instance.name = tagName(entry.instance.name, row.mult);

    const payout = Math.round(stake * row.mult);
    const res = this._settle('risk', stake, payout, row.label, {
      cashOut: 0, cashIn: 0, sound: row.mult >= 4 ? 'legendary' : 'coin',
    });
    bus.emit('inventory:changed');
    bus.emit('toast', {
      text: `\u{1F3A3} ${entry.instance.name} \u2014 <b>${row.label}</b> (\u00d7${row.mult})`,
      kind: row.mult > 1 ? 'gold' : 'muted', duration: 5000,
    });
    return { ok: true, row, lost: false, instance: entry.instance, ...res };
  }

  // -------------------------------------------------------------- reporting

  /** Advertised vs. delivered, for the panel's honesty box and for tests. */
  report() {
    const s = this.eco?.stats?.gambling || { wagered: 0, won: 0, plays: 0, byGame: {} };
    const byGame = {};
    for (const [k, v] of Object.entries(s.byGame || {})) {
      byGame[k] = { ...v, rtp: v.wagered ? round2(v.won / v.wagered) : null };
    }
    return {
      edge: HOUSE_EDGE,
      advertisedRTP: round2(1 - HOUSE_EDGE),
      wagered: s.wagered, won: s.won, plays: s.plays,
      rtp: s.wagered ? round2(s.won / s.wagered) : null,
      byGame,
      lossCap: this.lossCap, lostToday: this.lostToday, remainingToday: this.remainingToday,
    };
  }

  update(dt, game) {
    // Cheap: keep the cap tracking net worth so it stays meaningful as the
    // player grows, but never let it shrink below what they have already lost.
    this._t = (this._t || 0) + dt;
    if (this._t < 5) return;
    this._t = 0;
    const cap = this.recomputeCap();
    if (cap < this.lostToday) this.lossCap = Math.round(this.lostToday);
  }

  save() {
    return {
      day: this.day, lostToday: this.lostToday, wonToday: this.wonToday,
      wageredToday: this.wageredToday, lossCap: this.lossCap,
    };
  }

  load(d) {
    if (!d) return;
    this.day = d.day ?? 1;
    this.lostToday = d.lostToday || 0;
    this.wonToday = d.wonToday || 0;
    this.wageredToday = d.wageredToday || 0;
    this.lossCap = d.lossCap || this.recomputeCap();
    this._ensureStats();
    this.newRace();
  }
}

function tagName(name, mult) {
  const clean = name.replace(/\s*\(Lucky ×[\d.]+\)$/, '');
  return `${clean} (Lucky ×${mult})`;
}
