import { bus } from '../core/EventBus.js';
import { clamp01 } from '../util/math.js';

/**
 * Contextual, non-blocking teaching hints.
 *
 * One hint on screen at a time, bottom-centre above the hotbar. Every hint is
 * triggered by real game state and cleared the moment the player does the
 * thing it was asking for — nothing here is on a script.
 *
 * A hint retires permanently the first time the player proves they have it
 * (`until`), or immediately after one showing (`once`). Retired ids are
 * persisted, so a hint is never taught twice across a save.
 */

const COOLDOWN = 6; // seconds before a not-yet-retired hint may re-show

/** @type {Record<string, {priority:number, once?:boolean, until?:string[], hold?:number}>} */
const HINTS = {
  // --- the core loop -------------------------------------------------------
  cast_wait: { priority: 40, until: ['fishing:hooked'], hold: 9 },
  hook_set: { priority: 100, until: ['fishing:hooked'] },
  reel: { priority: 60, until: ['fishing:caught'], hold: 7 },
  tension: { priority: 90, until: ['fishing:caught'], hold: 5 },
  snapped: { priority: 70, until: ['fishing:caught'], hold: 6 },
  pickup: { priority: 50, until: ['inventory:fishStored'], hold: 12 },
  sell: { priority: 45, until: ['sell:completed'], hold: 10 },
  // --- one-shot signposts --------------------------------------------------
  storage_full: { priority: 55, once: true, hold: 7 },
  keys: { priority: 20, once: true, hold: 8 },
  crew: { priority: 25, once: true, hold: 8 },
  processing: { priority: 30, once: true, hold: 8 },
  contracts: { priority: 30, once: true, hold: 8 },
};

export class Tutorial {
  constructor(game) {
    this.game = game;
    this.name = 'tutorial';
    this.order = 905;

    /** Hint ids that will never show again. */
    this.retired = new Set();
    /** id -> game time last shown, so a repeatable hint isn't spammy. */
    this._lastShown = new Map();
    this.current = null;
    this.el = null;
    this._offs = [];
    this._proxT = 0;
    this._hookWindowMax = 0;
  }

  get enabled() { return this.game.settings.tutorial !== false; }
  set enabled(v) { this.game.settings.tutorial = !!v; }

  async init(game) {
    const root = document.getElementById('ui-root');
    if (root) {
      this.el = document.createElement('div');
      this.el.id = 'tutorial-hint';
      this.el.className = 'tut-hint';
      this.el.innerHTML = `<div class="tut-body"></div><div class="tut-bar"><i></i></div>`;
      root.appendChild(this.el);
      this.bodyEl = this.el.querySelector('.tut-body');
      this.barEl = this.el.querySelector('.tut-bar');
      this.barFill = this.el.querySelector('.tut-bar > i');
    }
    this._wire();
    return this;
  }

  // ------------------------------------------------------------------ wiring
  _wire() {
    const on = (e, fn) => this._offs.push(bus.on(e, fn));

    // Retirement first, deliberately: the event that proves a lesson learned is
    // usually the same event that triggers the next one. Clearing the old hint
    // before the new one is offered stops a high-priority hint (the hook-set
    // bar) from blocking its own successor (the reel prompt).
    for (const [id, spec] of Object.entries(HINTS)) {
      if (!spec.until) continue;
      for (const evt of spec.until) on(evt, () => {
        // Only retire a lesson the player was actually taught — landing a first
        // fish without ever seeing the tension warning shouldn't bury it.
        if (this._lastShown.has(id)) this.retire(id);
        this.dismiss(id);
      });
    }

    on('fishing:landedInWater', () => this.show('cast_wait',
      'Now wait. When the bobber <b>dips and twitches</b>, the fish is testing the bait.'));

    on('fishing:nibble', () => {
      const f = this.game.get('fishing');
      this._hookWindowMax = Math.max(0.2, f?.hookSetWindow || 1);
      this.show('hook_set',
        `<span class="tut-strong">Click now!</span> <span class="tut-dim">Left mouse sets the hook — before the bar runs out.</span>`,
        { bar: () => clamp01((this.game.get('fishing')?.hookSetWindow || 0) / this._hookWindowMax) });
    });

    on('fishing:hooked', () => this.show('reel',
      '<b>Hold left mouse</b> to reel it in. Watch the <b>line tension</b> bar — let go before it fills.'));

    on('fishing:snapped', () => this.show('snapped',
      'The line snapped. Release the mouse whenever tension goes red and let the fish tire itself out.'));

    on('fishing:caught', () => this.show('pickup',
      'It landed on the ground. <b>E</b> picks it up — <b>E</b> again stores it in your basket.'));

    on('sell:completed', () => this.show('keys',
      'Money. <b>Tab</b> inventory · <b>J</b> quests · <b>K</b> contracts · <b>M</b> map · <b>O</b> company.'));

    on('workers:changed', ({ count }) => {
      if (count > 0) this.show('crew', 'You have crew. <b>O</b> opens the company — assign them, or fit them out from the Workers tab.');
    });

    on('feature:unlocked', ({ id }) => {
      if (id === 'processing') this.show('processing', 'Processing is open. <b>P</b> works your catch up a tier before you sell it.');
      if (id === 'contracts') this.show('contracts', 'Contracts are open. <b>K</b> shows the board — signed work pays far better than a plain sale.');
    });
    on('harbor:built', ({ id }) => {
      if (id === 'processing_plant') this.show('processing', 'The plant is running. <b>P</b> works your catch up a tier before you sell it.');
    });
    on('contract:accepted', () => { this.retire('contracts'); });
    on('game:newgame', () => this.reset());
  }

  // ------------------------------------------------------------------- show
  show(id, html, opts = {}) {
    const spec = HINTS[id];
    if (!spec || !this.enabled || !this.el) return;
    if (this.retired.has(id)) return;
    const now = this.game.time;
    if (!spec.once && now - (this._lastShown.get(id) ?? -1e9) < COOLDOWN) return;
    if (this.current && HINTS[this.current.id]?.priority > spec.priority) return;

    this._lastShown.set(id, now);
    if (spec.once) this.retired.add(id);

    this.current = { id, bar: opts.bar || null, until: now + (spec.hold ?? 6) };
    this.bodyEl.innerHTML = html;
    const hasBar = !!opts.bar;
    this.barEl.style.display = hasBar ? '' : 'none';
    if (hasBar) this.barFill.style.width = '100%';
    this.el.classList.toggle('urgent', (spec.priority || 0) >= 90);
    this.el.classList.add('show');
    this.game.audio?.play('ui_hover', { volume: 0.22, throttle: 200 });
  }

  dismiss(id) {
    if (!this.current || (id && this.current.id !== id)) return;
    this.current = null;
    this.el?.classList.remove('show', 'urgent');
  }

  retire(id) { this.retired.add(id); }

  /** Wipe progress (used by a fresh game). */
  reset() { this.retired.clear(); this._lastShown.clear(); this.dismiss(); }

  // ----------------------------------------------------------------- update
  update(dt, game) {
    if (!this.el) return;
    if (!this.enabled) { if (this.current) this.dismiss(); return; }

    const fishing = game.get('fishing');
    const ui = game.get('ui');
    const hud = game.get('hud');

    // Hidden while a panel is up or the HUD is off — hints are for play.
    const blocked = !!ui?.anyOpen?.() || hud?.visible === false;
    this.el.classList.toggle('blocked', blocked);

    // --- state-driven triggers (cheap polls, 4 Hz) ---
    this._proxT += dt;
    if (this._proxT >= 0.25 && !blocked) {
      this._proxT = 0;
      this._pollState(game, fishing);
    }

    if (!this.current) return;

    // Timing bar drains against the real window.
    if (this.current.bar) {
      const v = clamp01(this.current.bar());
      this.barFill.style.width = `${v * 100}%`;
      this.barEl.classList.toggle('low', v < 0.35);
    }

    // --- dismissal: the player did the thing, or the moment passed ---
    const id = this.current.id;
    if (id === 'hook_set' && fishing?.state !== 'nibble') this.dismiss(id);
    else if (id === 'cast_wait' && fishing && fishing.state !== 'inwater') this.dismiss(id);
    else if (id === 'reel' && (fishing?.state !== 'hooked' || fishing?.reeling)) this.dismiss(id);
    else if (id === 'tension' && (fishing?.state !== 'hooked' || fishing.tension < 0.7)) this.dismiss(id);
    else if (game.time > this.current.until) this.dismiss(id);
  }

  _pollState(game, fishing) {
    // Line about to go: the single most expensive lesson in the game.
    if (fishing?.state === 'hooked' && fishing.tension > 0.85) {
      this.show('tension', '<span class="tut-strong">Let go!</span> <span class="tut-dim">The line is about to snap.</span>');
    }

    const inv = game.get('inventory');
    if (inv && inv.capacity > 0 && inv.freeWeight <= 0.001 && inv.fish.length) {
      this.show('storage_full',
        'Storage is full. Sell what you have, or buy a bigger container from the <b>shop</b>.');
    }

    // Near a sell station holding fish.
    const world = game.get('world');
    const player = game.get('player');
    const carrying = !!game.get('interaction')?.held?.pf;
    if (world?.sellZones?.length && player && (carrying || (inv?.fish.length || 0) > 0)) {
      let near = false;
      for (const z of world.sellZones) {
        const dx = z.position.x - player.position.x, dz = z.position.z - player.position.z;
        if (dx * dx + dz * dz < 49) { near = true; break; }
      }
      if (near) {
        this.show('sell', carrying
          ? 'Drop it in the bin, or press <b>E</b> to sell everything you are carrying.'
          : 'Press <b>E</b> at the station to sell your whole basket.');
      } else this.dismiss('sell');
    }
  }

  // ---------------------------------------------------------------- persist
  save() { return { retired: [...this.retired] }; }
  load(d) {
    if (!d) return;
    this.retired = new Set(Array.isArray(d.retired) ? d.retired : []);
    this.dismiss();
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.el?.remove();
    this.el = null;
  }
}
