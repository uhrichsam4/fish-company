import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { WAVE_SETS, waveState } from './waves.js';
import { REGION_BY_ID } from '../data/regions.js';
import { clamp, clamp01, lerp, damp, rrange, rchance, weightedPick } from '../util/math.js';

export const WEATHER_TYPES = [
  { id: 'clear', name: 'Clear', weight: 100, cloud: 0.12, storm: 0, waves: 'calm', fog: 0.9, wind: 0.4, rain: 0, lightning: 0 },
  { id: 'sunny', name: 'Sunny', weight: 70, cloud: 0.3, storm: 0, waves: 'calm', fog: 1.0, wind: 0.6, rain: 0, lightning: 0 },
  { id: 'cloudy', name: 'Cloudy', weight: 60, cloud: 0.68, storm: 0.12, waves: 'normal', fog: 1.3, wind: 0.8, rain: 0, lightning: 0 },
  { id: 'fog', name: 'Fog', weight: 22, cloud: 0.5, storm: 0.05, waves: 'calm', fog: 4.2, wind: 0.2, rain: 0, lightning: 0 },
  { id: 'rain', name: 'Rain', weight: 34, cloud: 0.88, storm: 0.35, waves: 'normal', fog: 2.1, wind: 1.0, rain: 0.55, lightning: 0.02 },
  { id: 'storm', name: 'Storm', weight: 15, cloud: 1.0, storm: 0.75, waves: 'rough', fog: 2.8, wind: 1.6, rain: 0.9, lightning: 0.16 },
  { id: 'heavy_storm', name: 'Heavy Storm', weight: 5, cloud: 1.0, storm: 1.0, waves: 'storm', fog: 3.6, wind: 2.2, rain: 1.0, lightning: 0.4 },
  { id: 'snow', name: 'Snow', weight: 0, cloud: 0.85, storm: 0.3, waves: 'normal', fog: 3.0, wind: 0.9, rain: 0, snow: 0.8, lightning: 0 },
];
export const WEATHER_BY_ID = Object.fromEntries(WEATHER_TYPES.map((w) => [w.id, w]));

/**
 * Weather state machine. Blends wave sets, sky, fog and ambience, and
 * respects per-region forced weather (Storm Shelf is always angry).
 */
export class Weather {
  constructor(game) {
    this.game = game;
    this.name = 'weather';
    this.order = 12;
    this.current = WEATHER_BY_ID.clear;
    this.target = WEATHER_BY_ID.clear;
    this.blend = 1;
    this.timer = 0;
    this.duration = 180;
    this.locked = false;
    this.windDir = new THREE.Vector2(1, 0.3).normalize();
    this.intensity = 0;
    this._rainHandle = null;
    this._regionOverride = null;
  }

  async init(game) {
    bus.on('weather:set', ({ id, instant }) => this.set(id, instant));
    bus.on('region:entered', (r) => {
      this._regionOverride = r.forceWeather || null;
      if (this._regionOverride) this.set(this._regionOverride);
      else if (this.locked) this.locked = false;
    });
    this.apply(1);
    return this;
  }

  set(id, instant = false) {
    const w = WEATHER_BY_ID[id];
    if (!w) { console.warn('[Weather] unknown', id); return; }
    if (this.target === w && !instant) return;
    this.prev = this.current;
    this.target = w;
    this.blend = instant ? 1 : 0;
    if (instant) this.current = w;
    this.timer = 0;
    this.duration = rrange(150, 400);
    bus.emit('weather:changed', { weather: w });
    bus.emit('toast', { text: `Weather: ${w.name}`, kind: 'muted', duration: 2400 });
  }

  roll() {
    if (this._regionOverride) { this.set(this._regionOverride); return; }
    const region = this.game.get('world')?.activeRegion;
    const list = WEATHER_TYPES.filter((w) => {
      if (w.id === 'snow') return region?.biome === 'arctic';
      return true;
    }).map((w) => {
      let weight = w.weight;
      if (region?.biome === 'arctic') { if (w.id === 'snow') weight = 90; if (w.id === 'sunny') weight *= 0.3; }
      if (region?.biome === 'storm') { if (w.storm > 0.5) weight *= 6; if (w.storm === 0) weight *= 0.1; }
      if (region?.biome === 'tropical' || region?.biome === 'jungle') { if (w.id === 'clear' || w.id === 'sunny') weight *= 1.8; }
      if (region?.tier >= 6 && w.id === 'fog') weight *= 2.2;
      return { w, weight };
    }).filter((x) => x.weight > 0);
    const pick = weightedPick(list, Math.random);
    if (pick) this.set(pick.w.id);
  }

  update(dt, game) {
    if (dt <= 0) return;
    this.timer += dt;
    if (this.timer > this.duration && !this.locked) { this.timer = 0; this.roll(); }

    if (this.blend < 1) {
      this.blend = clamp01(this.blend + dt / 24);
      if (this.blend >= 1) this.current = this.target;
    }
    this.apply(dt);
  }

  apply(dt) {
    const a = this.prev || this.current;
    const b = this.target;
    const t = this.blend;
    const cloud = lerp(a.cloud, b.cloud, t);
    const storm = lerp(a.storm, b.storm, t);
    const fogMult = lerp(a.fog, b.fog, t);
    const wind = lerp(a.wind, b.wind, t);
    const rain = lerp(a.rain ?? 0, b.rain ?? 0, t);
    const snow = lerp(a.snow ?? 0, b.snow ?? 0, t);
    this.intensity = storm;

    const sky = this.game.get('sky');
    if (sky) { sky.setCloudiness(cloud); sky.stormy = storm; }

    // Blend wave sets: each parameter interpolates so the sea state moves smoothly.
    const setA = WAVE_SETS[a.waves] || WAVE_SETS.normal;
    const setB = WAVE_SETS[b.waves] || WAVE_SETS.normal;
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 4; k++) waveState.waves[i][k] = lerp(setA[i][k], setB[i][k], t);
    }
    waveState.amplitude = 1;

    const region = this.game.get('world')?.activeRegion;
    const baseFog = region?.fogDensity ?? 0.0028;
    const scene = this.game.scene;
    if (scene.fog) {
      const target = baseFog * fogMult * (1 / (this.game.settings.viewDistance || 1));
      scene.fog.density = damp(scene.fog.density, target, 0.05, Math.max(dt, 1e-3));
    }
    const ocean = this.game.get('ocean');
    if (ocean) {
      ocean.uniforms.uWindStrength.value = damp(ocean.uniforms.uWindStrength.value, 0.6 + wind * 0.7, 0.05, Math.max(dt, 1e-3));
      ocean.uniforms.uSparkle.value = damp(ocean.uniforms.uSparkle.value, lerp(1.2, 0.15, storm), 0.05, Math.max(dt, 1e-3));
    }

    // Particles + audio.
    if (dt > 0) {
      bus.emit('weather:rain', rain);
      bus.emit('weather:snow', snow);
      if (rain > 0.05 || storm > 0.4) {
        if (rchance(dt * (lerp(a.lightning ?? 0, b.lightning ?? 0, t)))) this.strike();
      }
    }
  }

  strike() {
    const game = this.game;
    const player = game.get('player');
    if (!player) return;
    const ang = Math.random() * Math.PI * 2;
    const d = rrange(80, 400);
    const pos = new THREE.Vector3(player.position.x + Math.cos(ang) * d, 0, player.position.z + Math.sin(ang) * d);
    bus.emit('fx:lightning', { from: pos.clone().setY(400), to: pos.clone() });
    bus.emit('fx:screenFlash', { color: 'rgba(220,238,255,0.5)', duration: 120 });
    const delay = d / 340;
    setTimeout(() => {
      game.audio.play('thunder', { volume: clamp(1 - d / 500, 0.25, 1), rate: rrange(0.85, 1.1) });
    }, delay * 1000);
    bus.emit('weather:lightning', { position: pos, distance: d });
  }

  /** Spawn-rate modifier for a species under the current weather. */
  spawnMult(species) {
    if (species.weather === 'any') return 1;
    return species.weather === this.current.id ? 2.2 : 0.3;
  }

  save() { return { id: this.target.id, timer: this.timer }; }
  load(d) { if (d?.id) this.set(d.id, true); }
}
