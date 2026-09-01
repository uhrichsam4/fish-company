import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, damp, rrange } from '../util/math.js';
import { waveState, WAVE_SETS, waterHeightAt, waterVelocityAt } from './waves.js';

/**
 * Sea state above and beyond the weather: storm surge, rogue waves and
 * tsunami surges.
 *
 * WeatherSystem already owns wind, rain, lightning and which Gerstner set the
 * ocean uses. What it has no concept of is the sea itself *rising* -- and that
 * is the part with gameplay in it, because a raised sea level is what floods a
 * dock, lifts a moored boat over its mooring and puts water where the player
 * built. So this system owns exactly one number that matters,
 * `waveState.seaLevel`, plus the transient events that drive it.
 *
 * Everything that samples the ocean -- buoyancy, the fishing float, physical
 * fish, the shader -- already reads waveState, so raising sea level here moves
 * the whole world's water without touching any of those call sites.
 */

/** Metres of surge at full storm intensity. */
const SURGE_MAX = 1.35;
/** How fast the sea level chases its target. Slow: surge is not a step change. */
const SURGE_DAMP = 0.25;

const ROGUE = { minStorm: 0.6, meanGap: 95, warn: 4.5, rise: 2.5, hold: 1.5, fall: 5 };
const TSUNAMI = {
  warn: 14,        // rumble, birds leave, NPC shouts
  pullback: 9,     // sea withdraws — the classic tell
  surge: 11,       // water comes in
  hold: 8,
  recede: 26,
  pullDepth: -2.6,
  peak: 7.5,
};

export class StormSystem {
  constructor(game) {
    this.game = game;
    this.name = 'storm';
    this.order = 18;              // after weather, before anything that reads the sea

    /** Sea level contributed by sustained storm surge. */
    this.surge = 0;
    /** Sea level contributed by a transient event (rogue wave / tsunami). */
    this.event = 0;
    /** Extra wave amplitude multiplier from a transient event. */
    this.eventAmp = 0;

    this.rogueTimer = rrange(40, ROGUE.meanGap);
    /** @type {null|{phase:string,t:number}} */
    this.rogue = null;
    /** @type {null|{phase:string,t:number}} */
    this.tsunami = null;
  }

  async init() {
    bus.on('storm:rogue', () => this.startRogue(true));
    bus.on('storm:tsunami', () => this.startTsunami());
    bus.on('storm:clear', () => this.clearEvents());
    bus.on('game:newgame', () => { this.clearEvents(); this.surge = 0; });
    return this;
  }

  // ------------------------------------------------------------------ queries

  /**
   * Storm intensity 0..1. WeatherSystem publishes this as `intensity`, already
   * blended across a transition, so a front rolling in ramps the surge with it.
   */
  get intensity() {
    return clamp01(this.game.get('weather')?.intensity ?? 0);
  }

  get windSpeed() {
    const w = this.game.get('weather');
    return (w?.current?.wind ?? 0.4) * (1 + this.eventAmp * 0.5);
  }

  /** True while any transient sea event is running. */
  get eventActive() { return !!(this.rogue || this.tsunami); }

  /**
   * Kinetic energy per square metre of a wave face at this point, which is
   * what a damage model wants: roughly ½ρv² scaled by how much water is
   * actually above the local ground. Cheap, and derived from the same wave
   * field everything else samples, so it cannot disagree with what is drawn.
   */
  waveEnergyAt(x, z, groundY = 0) {
    const surf = waterHeightAt(x, z);
    const depth = surf - groundY;
    if (depth <= 0) return 0;
    const v = waterVelocityAt(x, z);
    const speed = Math.hypot(v.x, v.y, v.z);
    // 1025 kg/m³ seawater, expressed in kJ so callers deal in small numbers.
    const e = 0.5 * 1.025 * speed * speed;
    return e * clamp01(depth / 2.5);
  }

  // ------------------------------------------------------------------- events

  startRogue(forced = false) {
    if (this.tsunami || this.rogue) return false;
    if (!forced && this.intensity < ROGUE.minStorm) return false;
    this.rogue = { phase: 'warn', t: 0 };
    bus.emit('toast', { text: '🌊 The sea draws back…', kind: 'error', duration: 4200 });
    this.game.audio?.play('thunder2', { volume: 0.5, rate: 0.6 });
    return true;
  }

  startTsunami() {
    if (this.tsunami) return false;
    this.rogue = null;
    this.tsunami = { phase: 'warn', t: 0 };
    bus.emit('toast', {
      text: '⚠️ <b>Deep rumble offshore.</b><br>Get to high ground.',
      kind: 'error', duration: 9000,
    });
    this.game.audio?.play('thunder1', { volume: 0.85, rate: 0.45 });
    bus.emit('storm:tsunamiWarning', {});
    return true;
  }

  clearEvents() {
    this.rogue = null;
    this.tsunami = null;
    this.event = 0;
    this.eventAmp = 0;
  }

  // ------------------------------------------------------------------- update

  update(dt) {
    if (dt <= 0) return;

    // ---- sustained surge, driven by storm intensity ----
    const target = this.intensity * this.intensity * SURGE_MAX;
    this.surge = damp(this.surge, target, SURGE_DAMP, dt);

    // ---- transient events ----
    if (this.tsunami) this._stepTsunami(dt);
    else if (this.rogue) this._stepRogue(dt);
    else {
      this.event = damp(this.event, 0, 0.2, dt);
      this.eventAmp = damp(this.eventAmp, 0, 0.2, dt);
      // Rogues only brew in genuinely severe weather.
      if (this.intensity >= ROGUE.minStorm) {
        this.rogueTimer -= dt;
        if (this.rogueTimer <= 0) { this.rogueTimer = rrange(60, ROGUE.meanGap * 1.6); this.startRogue(); }
      } else {
        this.rogueTimer = Math.max(this.rogueTimer, 30);
      }
    }

    // ---- publish ----
    // One writer for sea level, so nothing else has to know these events exist.
    waveState.seaLevel = this.surge + this.event;
    // Weather sets amplitude to 1 every frame in its own apply(); this system
    // runs after it (order 18 vs 12) and scales that baseline, so a rogue wave
    // rides on top of whatever sea state the weather has decided on.
    waveState.amplitude = 1 + this.eventAmp;
  }

  _stepRogue(dt) {
    const r = this.rogue;
    r.t += dt;
    const P = ROGUE;
    if (r.phase === 'warn') {
      // Withdrawal: the give-away that something big is coming.
      this.event = lerp(0, -0.9, clamp01(r.t / P.warn));
      if (r.t >= P.warn) { r.phase = 'rise'; r.t = 0; this.game.audio?.play('splash_big', { volume: 0.9, rate: 0.5 }); }
    } else if (r.phase === 'rise') {
      const k = clamp01(r.t / P.rise);
      this.event = lerp(-0.9, 3.4, k);
      this.eventAmp = lerp(0, 1.6, k);
      if (r.t >= P.rise) { r.phase = 'hold'; r.t = 0; bus.emit('player:shake', 0.5); }
    } else if (r.phase === 'hold') {
      if (r.t >= P.hold) { r.phase = 'fall'; r.t = 0; }
    } else {
      const k = clamp01(r.t / P.fall);
      this.event = lerp(3.4, 0, k);
      this.eventAmp = lerp(1.6, 0, k);
      if (r.t >= P.fall) { this.rogue = null; this.event = 0; this.eventAmp = 0; }
    }
  }

  _stepTsunami(dt) {
    const s = this.tsunami;
    s.t += dt;
    const P = TSUNAMI;
    switch (s.phase) {
      case 'warn':
        if (s.t >= P.warn) {
          s.phase = 'pullback'; s.t = 0;
          bus.emit('toast', { text: '🌊 The water is going out.', kind: 'error', duration: 7000 });
        }
        break;
      case 'pullback': {
        // A long, smooth withdrawal rather than a drop, so the seabed is
        // revealed gradually and the player has time to read it and run.
        const k = clamp01(s.t / P.pullback);
        this.event = lerp(0, P.pullDepth, k * k);
        if (s.t >= P.pullback) {
          s.phase = 'surge'; s.t = 0;
          bus.emit('toast', { text: '🌊 <b>WAVE INBOUND</b>', kind: 'error', duration: 8000 });
          this.game.audio?.play('splash_big', { volume: 1, rate: 0.35 });
        }
        break;
      }
      case 'surge': {
        const k = clamp01(s.t / P.surge);
        // Long-period rise, not a vertical wall: the sea keeps coming.
        this.event = lerp(P.pullDepth, P.peak, k * k * (3 - 2 * k));
        this.eventAmp = lerp(0.2, 1.9, k);
        bus.emit('player:shake', 0.05 + k * 0.25);
        if (s.t >= P.surge) { s.phase = 'hold'; s.t = 0; }
        break;
      }
      case 'hold':
        if (s.t >= P.hold) { s.phase = 'recede'; s.t = 0; }
        break;
      default: {
        const k = clamp01(s.t / P.recede);
        this.event = lerp(P.peak, 0, k);
        this.eventAmp = lerp(1.9, 0, k);
        if (s.t >= P.recede) {
          this.tsunami = null; this.event = 0; this.eventAmp = 0;
          bus.emit('toast', { text: 'The water is going back down.', kind: '', duration: 5000 });
        }
        break;
      }
    }
  }

  /** Sea-level state is derived from live weather, so only events are saved. */
  save() {
    return {
      surge: +this.surge.toFixed(3),
      tsunami: this.tsunami ? { phase: this.tsunami.phase, t: +this.tsunami.t.toFixed(2) } : null,
    };
  }

  load(d) {
    if (!d) return;
    this.surge = d.surge || 0;
    this.tsunami = d.tsunami ? { phase: d.tsunami.phase, t: d.tsunami.t } : null;
    this.rogue = null;
  }
}
