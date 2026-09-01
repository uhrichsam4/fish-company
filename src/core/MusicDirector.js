import { bus } from './EventBus.js';
import { clamp01, rrange } from '../util/math.js';

/**
 * MusicDirector — picks a track from context and cross-fades between them.
 *
 * The ocean is the real soundtrack, so `music_calm` is deliberately
 * *intermittent*: it plays for ~90 s and then shuts up for 60-150 s. Story
 * beats (a big catch, a finished quest) restart it; boss fights and the deep
 * override it outright.
 */

const TRACKS = ['music_calm', 'music_boss', 'music_deep', 'music_menu'];

const CALM_PLAY = 90;         // seconds of calm music per cycle
const CALM_REST_MIN = 60;
const CALM_REST_MAX = 150;
const DEEP_METRES = 200;      // below this the deep track takes over
const BOSS_MAX = 600;         // failsafe if a `boss:defeated` never arrives
const BOOT_GRACE = 25;        // preload runs after init; don't latch the synth

const BIG_RARITY = new Set(['epic', 'legendary', 'mythic']);
const STING_RARITY = new Set(['legendary', 'mythic']);

export class MusicDirector {
  name = 'music';
  order = 881;

  constructor(game) {
    this.game = game;
    this.audio = game?.audio ?? null;
    this.enabled = true;

    this.track = null;          // what we last asked AudioManager to play
    this._evalT = 0;
    this._boot = 0;

    this._bossActive = 0;       // ref-count of live bosses
    this._bossT = 0;
    this._entered = false;

    this._calmPhase = 'rest';   // 'play' | 'rest'
    this._calmT = rrange(6, 18);

    this._offs = [];
  }

  async init(game) {
    this.game = game;
    this.audio = game.audio;
    const on = (e, fn) => this._offs.push(bus.on(e, fn));

    // Open the world with a track, then let the cycle breathe. `game:entered`
    // re-fires on every pointer re-lock, so only the first one restarts it.
    on('game:entered', () => {
      const first = !this._entered;
      this._entered = true;
      if (first) this.restartCalm(); else this._evalT = 99;
    });

    // `boss:spawn` is a REQUEST (debug menu, world events); BossSystem answers
    // it with `boss:spawned`. Counting both double-counted every summon and
    // left the fight music stuck on after the boss died.
    const spawned = () => { this._bossActive++; this._bossT = 0; this._evalT = 99; };
    const cleared = () => { this._bossActive = Math.max(0, this._bossActive - 1); this._evalT = 99; };
    on('boss:spawned', spawned);
    on('boss:defeated', cleared);
    on('boss:despawned', cleared);
    on('boss:escaped', cleared);

    on('catch:popup', (c) => {
      const r = String(c?.rarity || '').toLowerCase();
      if (STING_RARITY.has(r)) this.duck(0.4, 2.0);
      if (BIG_RARITY.has(r)) this.restartCalm();
    });
    on('quest:completed', () => { this.duck(0.4, 2.0); this.restartCalm(); });

    return this;
  }

  // ---------------------------------------------------------------- control

  setEnabled(on) {
    on = !!on;
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) { this.track = null; this.audio?.playMusic(null, 1.5); }
    else this._evalT = 99;
  }

  /** Kick the calm cycle back to the top of a fresh play phase. */
  restartCalm() {
    this._calmPhase = 'play';
    this._calmT = CALM_PLAY;
    this._evalT = 99;
  }

  /**
   * Drop the music bus so a sting can land, then bring it back.
   * Fully scheduled on the audio clock — no timers, no per-frame work.
   */
  duck(to = 0.4, hold = 2.0, attack = 0.25, release = 1.2) {
    const a = this.audio;
    const g = a?.buses?.music?.gain;
    if (!g || !a.ctx) return;
    const full = a.volumes.music;
    const now = a.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(full * clamp01(to), now + attack);
    g.setValueAtTime(full * clamp01(to), now + attack + hold);
    g.linearRampToValueAtTime(full, now + attack + hold + release);
  }

  // ---------------------------------------------------------------- driver

  update(dt, game) {
    const audio = this.audio;
    if (!audio?.ready) return;
    this._boot += game.rawDt;

    // The calm cycle and the boss failsafe run on real time so they keep
    // ticking while the game is paused in a menu.
    const rdt = game.rawDt;
    if (this._bossActive > 0) {
      this._bossT += rdt;
      if (this._bossT > BOSS_MAX) { this._bossActive = 0; this._evalT = 99; }
    }
    this._calmT -= rdt;
    if (this._calmT <= 0) {
      if (this._calmPhase === 'play') { this._calmPhase = 'rest'; this._calmT = rrange(CALM_REST_MIN, CALM_REST_MAX); }
      else { this._calmPhase = 'play'; this._calmT = rrange(CALM_PLAY * 0.9, CALM_PLAY * 1.1); }
      this._evalT = 99;
    }

    this._evalT += rdt;
    if (this._evalT < 0.5) return;
    this._evalT = 0;

    const want = this._choose(game);
    if (want === this.track) return;
    if (want && !this._ready(want)) return;   // wait for the real file to decode
    this.track = want;
    audio.playMusic(want, want ? 2.5 : 2.0);
  }

  _choose(game) {
    if (!this.enabled) return null;

    const ui = game.get('ui');
    const menu = game.paused || !this._entered || !!ui?.anyOpen?.();
    if (menu) return 'music_menu';

    if (this._bossActive > 0) return 'music_boss';

    const player = game.get('player');
    const region = game.get('world')?.activeRegion;
    const deep = (player && player.position.y < -DEEP_METRES)
      || region?.id === 'abyss' || region?.biome === 'abyss';
    if (deep) return 'music_deep';

    return this._calmPhase === 'play' ? 'music_calm' : null;
  }

  /** AudioManager.preload() runs after systems init; don't latch the fallback. */
  _ready(name) {
    if (this._boot > BOOT_GRACE) return true;
    return this.audio.buffers.has(name) || this.audio.failed.has(name);
  }

  // ---------------------------------------------------------------- teardown

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* */ } }
    this._offs.length = 0;
    this.audio?.playMusic(null, 0.5);
  }

  save() { return { enabled: this.enabled }; }
  load(d) { if (d && typeof d.enabled === 'boolean') this.setEnabled(d.enabled); }
}

export { TRACKS };
export default MusicDirector;
