import { bus } from '../core/EventBus.js';
import { formatMoneyExact } from '../util/math.js';

/**
 * Processing tiers. `mult` is the total sale multiplier the tier is advertised
 * to give; Economy.priceFor applies its own `1 + level * 0.28` curve, so the
 * small remainder is carried on the stored entry's `styleMult` (see `_finish`)
 * — that keeps the advertised numbers literally true without Economy changing.
 */
export const PROCESS_LEVELS = [
  { level: 0, name: 'Raw', mult: 1.0, seconds: 0 },
  { level: 1, name: 'Cleaned', mult: 1.3, seconds: 40 },
  { level: 2, name: 'Fillet', mult: 1.7, seconds: 65 },
  { level: 3, name: 'Premium Packed', mult: 2.1, seconds: 95 },
];

const ECONOMY_STEP = 0.28;

/** Correction so the effective sale multiplier matches PROCESS_LEVELS.mult. */
function styleCorrection(level) {
  const spec = PROCESS_LEVELS[level]?.mult ?? 1;
  return spec / (1 + level * ECONOMY_STEP);
}

/**
 * On-site fish processing. Fish leave the inventory into a timed queue and come
 * back one tier higher and worth more. Throughput scales with how many workers
 * hold the `processor` role (the Processing Plant guarantees at least one line).
 */
export class Processing {
  constructor(game) {
    this.game = game;
    this.name = 'processing';
    this.order = 36;

    /** @type {Array<{fishIndex:number, targetLevel:number, secondsLeft:number, totalSeconds:number, entry:object}>} */
    this.queue = [];
    this.lifetimeProcessed = 0;
    this.lifetimeValueAdded = 0;
    this._emitTimer = 0;
  }

  async init(game) {
    bus.on('company:process', ({ index }) => {
      if (index == null) this.processAll(); else this.processOne(index);
    });
    bus.on('company:processAll', () => this.processAll());
    bus.on('interact:processing', () => this.processAll());
    bus.on('game:newgame', () => this.reset());
    return this;
  }

  reset() {
    // Never destroy fish: hand anything mid-queue back at its current level.
    const inv = this.game.get('inventory');
    if (inv) for (const q of this.queue) inv.fish.push(q.entry);
    this.queue.length = 0;
    this.lifetimeProcessed = 0;
    this.lifetimeValueAdded = 0;
  }

  // ----------------------------------------------------------------- gating
  get unlocked() {
    return !!(this.game.get('research')?.features?.has('processing')
      || this.game.get('harbor')?.features?.has('processing')
      || this.game.get('quests')?.unlockedFeatures?.has('processing'));
  }

  /** Highest tier reachable right now (0..3). */
  get maxLevel() {
    const r = this.game.get('research')?.processLevels || 0;
    const h = this.game.get('harbor')?.processLevels || 0;
    return Math.max(0, Math.min(PROCESS_LEVELS.length - 1, Math.max(r, h)));
  }

  /** How many fish can be worked at once. */
  get lines() {
    const roled = this.game.get('workers')?.countRole?.('processor') ?? 0;
    const plant = this.game.get('harbor')?.has?.('processing_plant');
    return Math.max(plant ? 1 : 0, roled);
  }

  /** Seconds a single tier step takes, before dividing across the lines. */
  stepSeconds(targetLevel) {
    const base = PROCESS_LEVELS[targetLevel]?.seconds ?? 60;
    const auto = this.game.get('research')?.features?.has('automated_processing') ? 0.5 : 1;
    return Math.max(2, base * auto);
  }

  canProcess(fishEntry) {
    if (!fishEntry || !this.unlocked) return false;
    if (!this.lines) return false;
    return (fishEntry.processLevel || 0) < this.maxLevel;
  }

  // ---------------------------------------------------------------- queuing
  /** Queue one inventory slot for the next tier. @returns {boolean} */
  processOne(index) {
    const inv = this.game.get('inventory');
    if (!inv) return false;
    const entry = inv.fish[index];
    if (!entry) return false;
    if (!this.unlocked) {
      bus.emit('toast', { text: 'Processing is not unlocked — research the Gutting Line', kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    if (!this.lines) {
      bus.emit('toast', { text: 'No processing lines — build the Processing Plant or assign a processor', kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    if (!this.canProcess(entry)) {
      bus.emit('toast', { text: `Already at ${PROCESS_LEVELS[entry.processLevel || 0].name}`, kind: 'warn' });
      return false;
    }
    const target = (entry.processLevel || 0) + 1;
    const seconds = this.stepSeconds(target);
    inv.removeFish(index);
    this.queue.push({
      fishIndex: index, targetLevel: target, secondsLeft: seconds, totalSeconds: seconds,
      entry, baseStyle: entry.baseStyleMult ?? entry.styleMult ?? 1,
    });
    bus.emit('processing:queued', { instance: entry.instance, level: target });
    return true;
  }

  /** Queue every eligible fish in storage. @returns {number} queued */
  processAll() {
    const inv = this.game.get('inventory');
    if (!inv) return 0;
    if (!this.unlocked || !this.lines) { this.processOne(0); return 0; }
    let n = 0;
    // Walk backwards: removeFish() splices, so indices below stay valid.
    for (let i = inv.fish.length - 1; i >= 0; i--) {
      if (this.canProcess(inv.fish[i]) && this.processOne(i)) n++;
    }
    if (n) {
      bus.emit('toast', {
        text: `🏭 ${n} fish sent to the processing floor (${this.lines} line${this.lines > 1 ? 's' : ''})`,
        kind: 'info',
      });
    } else {
      bus.emit('toast', { text: 'Nothing to process', kind: 'warn' });
    }
    return n;
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    if (!this.queue.length || dt <= 0) return;
    const lines = Math.max(1, this.lines);
    const active = Math.min(lines, this.queue.length);
    for (let i = 0; i < active; i++) this.queue[i].secondsLeft -= dt;
    // Finished jobs are always at the front, so a single back-to-front pass works.
    for (let i = active - 1; i >= 0; i--) {
      if (this.queue[i].secondsLeft <= 0) this._finish(i);
    }
  }

  _finish(i) {
    const job = this.queue.splice(i, 1)[0];
    if (!job) return;
    const inv = this.game.get('inventory');
    const eco = this.game.get('economy');
    const entry = job.entry;
    const before = eco ? eco.priceFor(entry.instance, { freshness: entry.freshness, processLevel: entry.processLevel || 0 }) * (entry.styleMult || 1) : 0;

    entry.processLevel = job.targetLevel;
    entry.baseStyleMult = job.baseStyle;
    entry.styleMult = job.baseStyle * styleCorrection(job.targetLevel);

    const after = eco ? eco.priceFor(entry.instance, { freshness: entry.freshness, processLevel: entry.processLevel }) * entry.styleMult : 0;
    this.lifetimeProcessed++;
    this.lifetimeValueAdded += Math.max(0, after - before);

    if (inv) { inv.fish.push(entry); bus.emit('inventory:changed'); }
    this.game.audio?.play('purchase', { volume: 0.35 });
    bus.emit('processing:done', { instance: entry.instance, level: job.targetLevel, entry });
    bus.emit('toast', {
      text: `🏭 ${entry.instance.name} → <b>${PROCESS_LEVELS[job.targetLevel].name}</b> (+${formatMoneyExact(Math.max(0, after - before))})`,
      kind: 'success', duration: 3400,
    });
  }

  /** UI helper: 0..1 progress of the whole queue's front job. */
  get progress() {
    const q = this.queue[0];
    if (!q || !q.totalSeconds) return 0;
    return 1 - Math.max(0, q.secondsLeft) / q.totalSeconds;
  }

  levelName(level) { return PROCESS_LEVELS[level]?.name || 'Raw'; }

  // ---------------------------------------------------------------- persist
  save() {
    return {
      queue: this.queue.map((q) => ({
        fishIndex: q.fishIndex, targetLevel: q.targetLevel, secondsLeft: q.secondsLeft,
        totalSeconds: q.totalSeconds, baseStyle: q.baseStyle, entry: q.entry,
      })),
      lifetimeProcessed: this.lifetimeProcessed,
      lifetimeValueAdded: this.lifetimeValueAdded,
    };
  }

  load(d) {
    if (!d) return;
    this.queue = (d.queue || []).filter((q) => q && q.entry && q.entry.instance).map((q) => ({
      fishIndex: q.fishIndex ?? 0,
      targetLevel: q.targetLevel ?? 1,
      secondsLeft: Number.isFinite(q.secondsLeft) ? q.secondsLeft : 30,
      totalSeconds: q.totalSeconds || 60,
      baseStyle: q.baseStyle ?? 1,
      entry: q.entry,
    }));
    this.lifetimeProcessed = d.lifetimeProcessed || 0;
    this.lifetimeValueAdded = d.lifetimeValueAdded || 0;
  }
}
