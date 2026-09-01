import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp01, lerp, smoothstep, damp, rrange, rchance } from '../util/math.js';
import { waterHeightAt } from './waves.js';

/**
 * Ambience — the world's background audio bed.
 *
 * Blends the looping `amb_*` beds from the manifest against the player's
 * situation (region, shoreline distance, water depth, altitude, weather,
 * time of day, submerged / boat / submarine), drives the global underwater
 * filter and reverb send, and sprinkles positioned one-shots on top.
 *
 * Design notes:
 *  - The mix is recomputed at 2.5 Hz into a *fixed-key* object so nothing is
 *    allocated, and only re-issued to AudioManager when a component moves by
 *    more than MIX_EPS (or crosses silence). AudioManager cross-fades it.
 *  - `amb_beach` is created by us as a *positioned* loop parked on the nearest
 *    shoreline point, so surf pans toward the water; `setAmbience` then just
 *    rides its volume like any other bed.
 *  - Beds are only introduced once their buffer has decoded (or definitively
 *    failed), otherwise the very first mix would latch onto the synth fallback
 *    for the rest of the session — `preload()` runs *after* systems init.
 */

/** Fixed bed order. Keys never change => the mix object never re-shapes. */
const BEDS = [
  'amb_beach', 'amb_ocean', 'amb_wind', 'amb_rain', 'amb_storm',
  'amb_underwater', 'amb_deep', 'amb_harbor', 'amb_night',
];

const MIX_EPS = 0.05;
const MIX_INTERVAL = 0.4;
/**
 * Loop name for the world-event drone. Deliberately *not* `amb_*`: setAmbience()
 * zeroes every `amb_` loop missing from the mix, which would fight the drone
 * back to silence every MIX_INTERVAL.
 */
const DRONE = 'event_drone';
const DRONE_FADE = 4;         // slow enough that you notice it after it arrived
const SHORE_SCAN_MAX = 45;    // metres searched for a waterline
const ABYSS_DEPTH = 200;      // metres below the surface = "the deep"
const BOOT_GRACE = 25;        // give preload this long before falling back to synth

/** 8 unit directions used by the shoreline scan, flattened to [x,z,...]. */
const SCAN_DIRS = (() => {
  const a = [];
  for (let i = 0; i < 8; i++) { const t = (i / 8) * Math.PI * 2; a.push(Math.cos(t), Math.sin(t)); }
  return a;
})();

// ---- scratch: this module must not allocate per frame ----
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Ambience {
  name = 'ambience';
  order = 880;

  constructor(game) {
    this.game = game;
    this.audio = game?.audio ?? null;

    /** Live mix, rebuilt in place every MIX_INTERVAL. */
    this._mix = {};
    /** Last mix actually handed to AudioManager. */
    this._sent = {};
    for (const k of BEDS) { this._mix[k] = 0; this._sent[k] = 0; }

    this._mixT = MIX_INTERVAL;      // force a mix on the first update
    this._forceMix = true;
    this._boot = 0;

    /** Sampled world context, reused. */
    this.ctx = {
      onLand: false, terrainH: 0, waterY: 0, floorDepth: 0, belowSurface: 0,
      shoreDist: Infinity, shoreFound: false, altitude: 0, chop: 0,
      night: 0, day: 1, rain: 0, storm: 0, wind: 0, inside: false,
      mode: 'walk', underwater: 0, region: null,
    };

    // Positioned surf source (the `amb_beach` bed).
    this._surfPos = new THREE.Vector3();
    this._surfTarget = new THREE.Vector3();
    this._surfHandle = null;
    this._surfValid = false;
    this._surfRate = 1;

    this._rain = 0;
    this._drone = 0;
    this._underwaterTarget = 0;
    this._reverbTarget = 0;
    this._reverbSent = -1;
    this._revPulse = 0;

    // One-shot schedulers (seconds until the next attempt).
    this._t = {
      gull: rrange(2, 6),
      splash: rrange(8, 18),
      gust: rrange(6, 16),
      hull: rrange(6, 14),
      horn: rrange(40, 90),
    };
    this._creakCd = 0;

    this._offs = [];
  }

  async init(game) {
    this.game = game;
    this.audio = game.audio;

    const on = (e, fn) => this._offs.push(bus.on(e, fn));

    // Pause zeroes every loop's gain; nothing restores it, so re-issue on resume.
    on('game:paused', (p) => { if (!p) this._forceMix = true; });
    on('game:entered', () => { this._forceMix = true; });
    on('weather:changed', () => { this._forceMix = true; });
    // Weather.current only flips once a 24 s crossfade completes; the per-frame
    // `weather:rain` event carries the *blended* amount, which is what we want.
    on('weather:rain', (v) => { this._rain = +v || 0; });
    on('region:entered', () => { this._forceMix = true; });
    on('settings:applied', () => { this._forceMix = true; });

    // Boards and docks groan under your boots.
    on('player:footstep', (d) => {
      if (d?.surface !== 'wood') return;
      if (this._creakCd > 0 || !rchance(0.22)) return;
      this._creakCd = rrange(1.1, 2.6);
      const p = this.game.get('player');
      if (!p) return;
      _pos.set(
        p.position.x + rrange(-1.4, 1.4),
        p.position.y - rrange(0.1, 0.5),
        p.position.z + rrange(-1.4, 1.4),
      );
      // sub_creak is the only creak sample we ship; pitched up it reads as
      // tight dock planking rather than a submarine hull.
      this.audio.play('sub_creak', {
        position: _pos, volume: rrange(0.14, 0.3), rate: rrange(1.22, 1.62),
        throttle: 420, refDist: 2.5, maxDist: 30,
      });
    });

    // A close strike blooms the space open for the length of the thunder tail.
    on('weather:lightning', ({ distance } = {}) => {
      if (distance == null || distance > 220) return;
      this._revPulse = Math.max(this._revPulse, 0.3 * (1 - distance / 220));
    });

    return this;
  }

  // ---------------------------------------------------------------- lifecycle

  update(dt, game) {
    const audio = this.audio;
    if (!audio?.ready || dt <= 0) return;
    this._boot += game.rawDt;

    this._mixT += dt;
    if (this._mixT >= MIX_INTERVAL) {
      this._mixT = 0;
      this._sample(game);
      this._buildMix();
      this._applyMix();
      // Pausing zeroes every loop's gain and only the beds are re-issued, and
      // an event can fire before the audio context is ready — so the drone is
      // re-asserted on the bed cadence rather than only when an event starts.
      if (this._drone > 0.001) this._applyDrone();
    }

    this._updateSurf(dt);
    this._oneShots(dt, game);
    if (this._creakCd > 0) this._creakCd -= dt;
  }

  /**
   * Filters run after every other system so we always have the last word --
   * Player.update() also pokes setUnderwater() with a hard 0/1 each frame.
   * setUnderwater ramps over 0.35 s, so re-issuing it per frame behaves as a
   * smooth exponential approach rather than a snap.
   */
  lateUpdate(dt, game) {
    const audio = this.audio;
    if (!audio?.ready) return;
    audio.setUnderwater(this._underwaterTarget);
    if (this._revPulse > 0.002) this._revPulse = damp(this._revPulse, 0, 0.06, Math.max(dt, 1e-3));
    else this._revPulse = 0;
    const rev = clamp01(this._reverbTarget + this._revPulse);
    if (Math.abs(rev - this._reverbSent) > 0.02) {
      this._reverbSent = rev;
      audio.setReverb(rev, this._revPulse > 0.01 ? 0.4 : 1.4);
    }
  }

  // ---------------------------------------------------------------- sampling

  /** Gather everything the mix depends on. Runs at 2.5 Hz. */
  _sample(game) {
    const c = this.ctx;
    const player = game.get('player');
    const world = game.get('world');
    const sky = game.get('sky');
    const weather = game.get('weather');
    if (!player) return;

    const px = player.position.x, pz = player.position.z;
    c.mode = player.mode || 'walk';
    c.region = world?.activeRegion || null;
    c.altitude = player.position.y;

    c.terrainH = world ? world.heightAt(px, pz) : 0;
    c.waterY = waterHeightAt(px, pz);
    c.floorDepth = Math.max(0, c.waterY - c.terrainH);
    c.belowSurface = Math.max(0, c.waterY - player.position.y);
    c.onLand = c.terrainH > -0.2 && !player.swimming;

    // Chop right in front of the player — feeds surf loudness / pitch.
    player.flatForward(_dir);
    let lo = Infinity, hi = -Infinity;
    for (let d = 3; d <= 9; d += 3) {
      const h = waterHeightAt(px + _dir.x * d, pz + _dir.z * d);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    c.chop = clamp01((hi - lo) / 1.6);

    this._scanShore(world, px, pz);

    c.day = sky ? sky.dayFactor : 1;
    c.night = 1 - c.day;

    // Blend wind the same way Weather.apply() does so gusts ramp with the front.
    if (weather) {
      const wa = weather.prev || weather.current;
      const wb = weather.target || weather.current;
      c.wind = lerp(wa?.wind ?? 0.4, wb?.wind ?? 0.4, weather.blend ?? 1);
      c.storm = clamp01(weather.intensity);
    } else { c.wind = 0.4; c.storm = 0; }
    c.rain = clamp01(this._rain);

    // "Inside" ~= something solid directly overhead within 6 m.
    c.inside = false;
    if (c.mode === 'walk' && !player.underwater && game.physics) {
      _pos.set(px, player.position.y + 0.9, pz);
      const hit = game.physics.raycast(_pos, _up, 6, undefined, player.collider || null);
      c.inside = !!hit;
    }

    c.underwater = player.underwater ? 1 : clamp01((player.submergence ?? 0) * 0.35);
  }

  /**
   * March 8 directions looking for the terrain/sea-level crossing, then
   * bisect for a usable shoreline point. Writes ctx.shoreDist/shoreFound and
   * the surf target.
   */
  _scanShore(world, px, pz) {
    const c = this.ctx;
    c.shoreFound = false;
    c.shoreDist = Infinity;
    if (!world) return;

    const startsOnLand = c.terrainH > 0;
    let bestD = Infinity, bx = 0, bz = 0;

    for (let i = 0; i < 8; i++) {
      const dx = SCAN_DIRS[i * 2], dz = SCAN_DIRS[i * 2 + 1];
      let prev = 0;
      for (let d = 5; d <= SHORE_SCAN_MAX; d += 5) {
        if (d >= bestD) break;                       // a nearer crossing already won
        const h = world.heightAt(px + dx * d, pz + dz * d);
        if ((h > 0) !== startsOnLand) {
          let lo = prev, hi = d;
          for (let k = 0; k < 3; k++) {
            const m = (lo + hi) * 0.5;
            if ((world.heightAt(px + dx * m, pz + dz * m) > 0) !== startsOnLand) hi = m;
            else lo = m;
          }
          const dd = (lo + hi) * 0.5;
          if (dd < bestD) { bestD = dd; bx = px + dx * dd; bz = pz + dz * dd; }
          break;
        }
        prev = d;
      }
    }

    if (bestD < Infinity) {
      c.shoreFound = true;
      c.shoreDist = bestD;
      this._surfTarget.set(bx, waterHeightAt(bx, bz) + 0.25, bz);
      if (!this._surfValid) { this._surfPos.copy(this._surfTarget); this._surfValid = true; }
    }
  }

  // ---------------------------------------------------------------- the mix

  /** Buffers decode after systems init; don't latch a bed onto the synth. */
  _ready(name) {
    if (this._boot > BOOT_GRACE) return true;
    const a = this.audio;
    return a.buffers.has(name) || a.failed.has(name);
  }

  _buildMix() {
    const c = this.ctx;
    const m = this._mix;
    for (const k of BEDS) m[k] = 0;

    const regionBed = c.region?.ambience || null;
    const submerged = c.underwater > 0.6 || c.mode === 'sub';

    if (submerged) {
      // ---- below the surface ----
      const deep = smoothstep(clamp01((c.belowSurface - 40) / (ABYSS_DEPTH - 40)));
      const abyss = c.region?.biome === 'abyss' ? 1 : 0;
      const deepMix = Math.max(deep, abyss * 0.85);
      if (c.mode === 'sub') {
        // A hull between you and the water: quieter, deeper, less hiss.
        m.amb_underwater = 0.35 + (1 - deepMix) * 0.25;
        m.amb_deep = 0.35 + deepMix * 0.55;
      } else {
        m.amb_underwater = 1.0 - deepMix * 0.45;
        m.amb_deep = deepMix * 0.9;
      }
      // Rain is audible as a dull patter just under the surface only.
      m.amb_rain = c.rain * clamp01(1 - c.belowSurface / 6) * 0.35;
    } else {
      // ---- above the surface ----
      const shore = c.shoreFound ? clamp01(1 - c.shoreDist / 40) : 0;
      const surf = c.shoreFound
        ? clamp01(1 - c.shoreDist / 26) * (0.55 + c.chop * 0.35 + c.storm * 0.25)
        : 0;
      const openSea = 1 - shore;

      m.amb_beach = clamp01(surf * (c.onLand ? 1.0 : 0.85));
      m.amb_ocean = clamp01(0.35 + openSea * 0.55 + c.storm * 0.15);
      if (c.onLand) m.amb_ocean *= lerp(1, 0.45, shore);

      // Region character on top of the geometric blend.
      if (regionBed === 'amb_harbor') m.amb_harbor = clamp01(0.35 + shore * 0.5);
      else if (regionBed === 'amb_wind') m.amb_wind = 0.35;
      else if (regionBed === 'amb_deep') m.amb_deep = 0.3;
      if (c.region?.hasHarbor) m.amb_harbor = Math.max(m.amb_harbor, 0.3 + shore * 0.35);

      // Wind: weather + exposure (altitude, open water).
      const alt = clamp01((c.altitude - 6) / 70);
      m.amb_wind = clamp01(Math.max(m.amb_wind, c.wind * 0.32 + alt * 0.4 + openSea * 0.12 + c.storm * 0.3));

      // Night on land gets crickets/lapping water rather than gulls.
      m.amb_night = clamp01(c.night * (c.onLand ? 0.6 : 0.3) * (1 - c.storm * 0.6));

      m.amb_rain = clamp01(c.rain * (c.inside ? 0.55 : 1.0));
      m.amb_storm = clamp01(c.storm * (regionBed === 'amb_storm' ? 1.0 : 0.85));

      // Deep water under an open hull still reads as "a lot of ocean below".
      if (!c.onLand && c.floorDepth > 60) {
        m.amb_deep = Math.max(m.amb_deep, clamp01((c.floorDepth - 60) / 260) * 0.35);
      }

      // Indoors damps everything a little; the low-pass does the rest.
      if (c.inside) {
        for (const k of BEDS) if (k !== 'amb_rain') m[k] *= 0.65;
      }
    }

    // Don't start a bed that hasn't decoded yet — retry on the next tick.
    for (const k of BEDS) {
      if (m[k] > 0.001 && !this._ready(k)) { m[k] = 0; this._forceMix = true; }
    }

    // Filters/reverb ride the same sample.
    this._underwaterTarget = c.mode === 'sub'
      ? 0.45
      : clamp01(c.underwater + (c.inside ? 0.12 : 0));

    let rev = 0;
    if (c.mode === 'sub') rev = 0.35;
    if (c.belowSurface > ABYSS_DEPTH || c.region?.biome === 'abyss') rev = Math.max(rev, 0.55);
    else if (c.underwater > 0.6) rev = Math.max(rev, 0.2 + smoothstep(clamp01(c.belowSurface / ABYSS_DEPTH)) * 0.3);
    if (c.inside) rev = Math.max(rev, 0.2);
    this._reverbTarget = rev;
  }

  _applyMix() {
    const m = this._mix, s = this._sent;
    let changed = this._forceMix;
    if (!changed) {
      for (const k of BEDS) {
        const a = m[k], b = s[k];
        if (Math.abs(a - b) > MIX_EPS || ((a <= 0.001) !== (b <= 0.001))) { changed = true; break; }
      }
    }
    if (!changed) return;

    // Create the surf bed ourselves so it is *positioned*; setAmbience would
    // otherwise spawn a flat, non-directional one.
    if (m.amb_beach > 0.001 && !this.audio.hasLoop('amb_beach') && this._surfValid) {
      this._surfPos.copy(this._surfTarget);
      this._surfHandle = this.audio.loop('amb_beach', {
        volume: 0, bus: 'ambience', fadeIn: 0.01, position: this._surfPos,
        refDist: 14, rolloff: 0.75, maxDist: 220,
      });
    }

    for (const k of BEDS) s[k] = m[k];
    this._forceMix = false;
    this.audio.setAmbience(m, 2.0);
  }

  /** Slide the surf source toward the waterline so it pans as you turn/walk. */
  _updateSurf(dt) {
    if (!this._surfValid) return;
    if (!this._surfHandle || !this.audio.hasLoop('amb_beach')) {
      this._surfHandle = this.audio.loops.get('amb_beach') || null;
      if (!this._surfHandle) return;
    }
    this._surfPos.x = damp(this._surfPos.x, this._surfTarget.x, 0.02, dt);
    this._surfPos.y = damp(this._surfPos.y, this._surfTarget.y, 0.02, dt);
    this._surfPos.z = damp(this._surfPos.z, this._surfTarget.z, 0.02, dt);
    this._surfHandle.setPosition(this._surfPos);
    // Steeper water = faster, brighter surf. Only re-scheduled when it moves.
    const rate = 0.92 + this.ctx.chop * 0.16 + this.ctx.storm * 0.1;
    if (Math.abs(rate - this._surfRate) > 0.02) {
      this._surfRate = rate;
      this._surfHandle.setRate(rate, 0.6);
    }
  }

  // -------------------------------------------------------------- event drone

  /**
   * Fade an unsettling low bed in behind the mix. `amount` is 0..1; 0 fades it
   * back out. World events drive this (the abyssal anomaly) — the level is
   * theirs to own, so calls here are absolute, not additive.
   */
  setEventDrone(amount, fade = DRONE_FADE) {
    this._drone = clamp01(+amount || 0);
    this._applyDrone(fade);
    return this._drone;
  }

  /** Current drone level, 0..1. */
  get eventDrone() { return this._drone; }

  _applyDrone(fade = DRONE_FADE) {
    const audio = this.audio;
    if (!audio?.ready) return;                 // retried from the mix tick
    let h = audio.loops.get(DRONE);
    if (!h) {
      if (this._drone <= 0.001) return;        // don't build the bed just to mute it
      h = audio.loop(DRONE, { volume: 0, bus: 'ambience', fadeIn: 0.01 });
    }
    // Parked at silence rather than stopped: an oscillator that has been
    // stopped cannot be restarted, so the next event would get nothing.
    h?.setVolume(this._drone, fade);
  }

  // ---------------------------------------------------------------- one-shots

  _oneShots(dt, game) {
    const t = this._t;
    const c = this.ctx;
    const player = game.get('player');
    if (!player) return;
    const px = player.position.x, py = player.position.y, pz = player.position.z;
    const submerged = c.underwater > 0.6;

    // --- gulls: near land, daytime. The Birds system owns these when present.
    t.gull -= dt;
    if (t.gull <= 0) {
      t.gull = rrange(2, 14);
      const birds = game.get('birds');
      const nearLand = c.shoreFound || c.onLand;
      if (!submerged && nearLand && c.day > 0.35 && c.storm < 0.5 && !(birds && birds.active)) {
        const a = Math.random() * Math.PI * 2;
        const d = rrange(10, 40);
        _pos.set(px + Math.cos(a) * d, py + rrange(5, 20), pz + Math.sin(a) * d);
        this.audio.play('seagull', {
          position: _pos, volume: rrange(0.35, 0.75) * (0.5 + c.day * 0.5),
          rate: rrange(0.88, 1.18), throttle: 800, refDist: 12, rolloff: 0.85, maxDist: 90,
        });
      }
    }

    // --- distant splashes: only out where the water is open and deep.
    t.splash -= dt;
    if (t.splash <= 0) {
      t.splash = rrange(7, 22);
      if (!submerged && !c.shoreFound && c.floorDepth > 8) {
        const a = Math.random() * Math.PI * 2;
        const d = rrange(18, 55);
        const x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
        _pos.set(x, waterHeightAt(x, z) + 0.2, z);
        this.audio.play(rchance(0.3) ? 'splash_big' : 'splash_medium', {
          position: _pos, volume: rrange(0.25, 0.5), rate: rrange(0.72, 0.95),
          throttle: 1200, refDist: 20, rolloff: 0.8, maxDist: 120,
        });
      }
    }

    // --- wind gusts.
    t.gust -= dt;
    if (t.gust <= 0) {
      const gusty = clamp01(c.wind / 2.2);
      t.gust = rrange(5, 20) * (1.25 - gusty * 0.7);
      if (!submerged && c.wind > 0.45) {
        const a = Math.random() * Math.PI * 2;
        const d = rrange(6, 24);
        _pos.set(px + Math.cos(a) * d, py + rrange(1, 8), pz + Math.sin(a) * d);
        this.audio.play('cast_whoosh', {
          position: _pos, volume: 0.1 + gusty * 0.32, rate: rrange(0.34, 0.62),
          throttle: 1500, refDist: 10, rolloff: 0.8, maxDist: 70,
        });
      }
    }

    // --- submarine hull creaks, louder and slower the deeper you go.
    t.hull -= dt;
    if (t.hull <= 0) {
      const pressure = clamp01(c.belowSurface / 420);
      t.hull = rrange(4, 14) * (1.2 - pressure * 0.75);
      if (c.mode === 'sub' && c.belowSurface > 12) {
        _pos.set(px + rrange(-1.2, 1.2), py + rrange(-0.8, 0.8), pz + rrange(-1.2, 1.2));
        this.audio.play('sub_creak', {
          position: _pos, volume: 0.2 + pressure * 0.6, rate: rrange(0.6, 0.95),
          throttle: 900, refDist: 3, maxDist: 24, reverb: 0.35,
        });
      }
    }

    // --- a working harbour has boats leaving it.
    t.horn -= dt;
    if (t.horn <= 0) {
      t.horn = rrange(45, 130);
      if (!submerged && c.region?.hasHarbor && c.day > 0.15) {
        const a = Math.random() * Math.PI * 2;
        const d = rrange(90, 220);
        _pos.set(px + Math.cos(a) * d, py + rrange(-1, 3), pz + Math.sin(a) * d);
        this.audio.play('boat_engine_start', {
          position: _pos, volume: rrange(0.4, 0.7), rate: rrange(0.42, 0.58),
          throttle: 8000, refDist: 60, rolloff: 0.55, maxDist: 400,
        });
      }
    }
  }

  // ---------------------------------------------------------------- teardown

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* */ } }
    this._offs.length = 0;
    for (const k of BEDS) this.audio?.stopLoop?.(k, 0.5);
    this.audio?.stopLoop?.(DRONE, 0.5);
    this._drone = 0;
    this._surfHandle = null;
  }

  save() { return {}; }
  load() { this._forceMix = true; }
}

export default Ambience;
