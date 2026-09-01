import * as THREE from 'three';
import { clamp, clamp01, rrange } from '../util/math.js';
import { bus } from './EventBus.js';

/**
 * Web Audio manager: buses, 3D panning, loops with runtime pitch,
 * and a procedural synth fallback so every cue makes *some* sound even
 * when a file is missing.
 */
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.manifest = null;
    this.ready = false;
    this.muted = false;
    this.volumes = { master: 0.85, sfx: 1.0, music: 0.45, ambience: 0.6, ui: 0.8 };
    this.loops = new Map();
    this.ambience = new Map();
    this._music = null;
    this._musicName = null;
    this._underwater = 0;
    this._lastPlay = new Map();
    this.listenerPos = new THREE.Vector3();
    this.maxConcurrent = 48;
    this._active = 0;
    this.failed = new Set();
  }

  async init(manifest) {
    this.manifest = manifest || { sfx: {}, loops: {}, ambience: {}, music: {} };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { console.warn('[Audio] no WebAudio'); return; }
    this.ctx = new AC({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.master;

    // Low-pass used for the underwater / muffled effect.
    this.muffle = this.ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 22000;
    this.muffle.Q.value = 0.7;

    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;

    this.master.connect(this.muffle);
    this.muffle.connect(this.comp);
    this.comp.connect(this.ctx.destination);

    this.buses = {};
    for (const name of ['sfx', 'music', 'ambience', 'ui']) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[name];
      g.connect(this.master);
      this.buses[name] = g;
    }

    // Shared reverb for spacious cues (deep sea, submarine, boss).
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.4, 2.6);
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.0;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    this.ready = true;
    const resume = () => { if (this.ctx.state === 'suspended') this.ctx.resume(); };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.master.gain.value = 0;
      else this.master.gain.value = this.muted ? 0 : this.volumes.master;
    });
  }

  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  /** Preload every buffer named in the manifest. Missing files fall back to synth. */
  async preload(onProgress) {
    if (!this.ready) return;
    const jobs = [];
    const push = (name, entry) => {
      const variants = entry.variants || 1;
      for (let i = 0; i < variants; i++) {
        const url = variants > 1 ? `${entry.url}${i + 1}${entry.ext || '.ogg'}` : entry.url;
        const key = variants > 1 ? `${name}${i + 1}` : name;
        jobs.push({ key, url });
      }
    };
    for (const group of ['sfx', 'loops', 'ambience', 'music']) {
      for (const [name, entry] of Object.entries(this.manifest[group] || {})) push(name, entry);
    }
    let done = 0;
    const BATCH = 8;
    for (let i = 0; i < jobs.length; i += BATCH) {
      await Promise.all(jobs.slice(i, i + BATCH).map(async (j) => {
        try {
          const res = await fetch(j.url);
          if (!res.ok) throw new Error(res.status);
          const ab = await res.arrayBuffer();
          this.buffers.set(j.key, await this.ctx.decodeAudioData(ab));
        } catch {
          this.failed.add(j.key);
        } finally {
          done++;
          onProgress?.(done / jobs.length, j.key);
        }
      }));
    }
    if (this.failed.size) console.warn(`[Audio] ${this.failed.size}/${jobs.length} missing, using synth fallback`);
    return { total: jobs.length, missing: this.failed.size };
  }

  _entry(name) {
    for (const group of ['sfx', 'loops', 'ambience', 'music']) {
      const g = this.manifest?.[group];
      if (g && g[name]) return { ...g[name], group };
      // multi-variant lookup: footstep_sand3 -> footstep_sand
      const m = name.match(/^(.*?)(\d+)$/);
      if (m && g && g[m[1]]) return { ...g[m[1]], group };
    }
    return null;
  }

  _resolve(name) {
    if (this.buffers.has(name)) return name;
    const entry = this._entry(name);
    if (entry?.variants > 1) {
      const idx = 1 + ((Math.random() * entry.variants) | 0);
      const k = `${name}${idx}`;
      if (this.buffers.has(k)) return k;
      for (let i = 1; i <= entry.variants; i++) if (this.buffers.has(`${name}${i}`)) return `${name}${i}`;
    }
    return null;
  }

  /**
   * Play a one-shot.
   * @param {string} name
   * @param {object} o {volume, rate, position:Vector3, bus, detune, throttle(ms), maxDist}
   */
  play(name, o = {}) {
    if (!this.ready || this.muted || this.ctx.state === 'closed') return null;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    if (o.throttle) {
      const last = this._lastPlay.get(name) || 0;
      const now = performance.now();
      if (now - last < o.throttle) return null;
      this._lastPlay.set(name, now);
    }
    if (this._active > this.maxConcurrent) return null;

    // Distance cull before we build any nodes.
    let dist = 0;
    if (o.position) {
      dist = this.listenerPos.distanceTo(o.position);
      if (dist > (o.maxDist ?? 90)) return null;
    }

    const key = this._resolve(name);
    const entry = this._entry(name);
    const busName = o.bus || (entry?.group === 'music' ? 'music' : entry?.group === 'ambience' ? 'ambience' : 'sfx');
    const dest = this.buses[busName] || this.buses.sfx;
    const baseVol = (entry?.volume ?? 1) * (o.volume ?? 1);

    let src, out;
    if (key) {
      src = this.ctx.createBufferSource();
      src.buffer = this.buffers.get(key);
      src.playbackRate.value = o.rate ?? 1;
      if (o.detune && src.detune) src.detune.value = o.detune;
      out = src;
    } else {
      const synth = synthesize(this.ctx, name, o);
      if (!synth) return null;
      src = synth.node; out = synth.out;
    }

    const gain = this.ctx.createGain();
    gain.gain.value = baseVol;
    out.connect(gain);

    let tail = gain;
    if (o.position) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.refDist ?? 4;
      panner.maxDistance = o.maxDist ?? 90;
      panner.rolloffFactor = o.rolloff ?? 1.1;
      panner.positionX.value = o.position.x;
      panner.positionY.value = o.position.y;
      panner.positionZ.value = o.position.z;
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(dest);
    if (o.reverb) { const rg = this.ctx.createGain(); rg.gain.value = o.reverb; tail.connect(rg); rg.connect(this.reverb); }

    this._active++;
    src.onended = () => { this._active--; try { gain.disconnect(); tail.disconnect(); } catch { /* */ } };
    src.start(0);
    if (o.duration) src.stop(this.ctx.currentTime + o.duration);
    return { src, gain, stop: (fade = 0.05) => this._stopNode(src, gain, fade) };
  }

  _stopNode(src, gain, fade) {
    try {
      const t = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0.0001, t + fade);
      src.stop(t + fade + 0.02);
    } catch { /* already stopped */ }
  }

  /** Start (or fetch) a named persistent loop. Returns a handle with setVolume/setRate. */
  loop(name, o = {}) {
    if (!this.ready || this.ctx.state === 'closed') return null;
    if (this.loops.has(name)) return this.loops.get(name);
    const key = this._resolve(name);
    const entry = this._entry(name);
    const busName = o.bus || (entry?.group === 'ambience' ? 'ambience' : entry?.group === 'music' ? 'music' : 'sfx');

    let src, out;
    if (key) {
      src = this.ctx.createBufferSource();
      src.buffer = this.buffers.get(key);
      src.loop = true;
      src.playbackRate.value = o.rate ?? 1;
      out = src;
    } else {
      const synth = synthesizeLoop(this.ctx, name, o);
      if (!synth) return null;
      src = synth.node; out = synth.out;
      var _synthCtl = synth;
    }

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    out.connect(gain);

    let tail = gain, panner = null;
    if (o.position) {
      panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = o.refDist ?? 6;
      panner.maxDistance = o.maxDist ?? 140;
      panner.rolloffFactor = o.rolloff ?? 1.0;
      panner.positionX.value = o.position.x;
      panner.positionY.value = o.position.y;
      panner.positionZ.value = o.position.z;
      gain.connect(panner); tail = panner;
    }
    tail.connect(this.buses[busName] || this.buses.sfx);
    try { src.start(0); } catch { /* */ }

    const target = (entry?.volume ?? 1) * (o.volume ?? 1);
    const t0 = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(target, t0 + (o.fadeIn ?? 0.4));

    const handle = {
      name, src, gain, panner, base: entry?.volume ?? 1, synth: _synthCtl,
      setVolume: (v, t = 0.15) => {
        const now = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(clamp01(v) * handle.base, now + t);
      },
      setRate: (r, t = 0.1) => {
        const now = this.ctx.currentTime;
        const p = src.playbackRate || _synthCtl?.rateParam;
        if (!p) return;
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(clamp(r, 0.05, 4), now + t);
      },
      setPosition: (v) => {
        if (!panner) return;
        panner.positionX.value = v.x; panner.positionY.value = v.y; panner.positionZ.value = v.z;
      },
      stop: (fade = 0.3) => {
        this.loops.delete(name);
        this._stopNode(src, gain, fade);
      },
    };
    this.loops.set(name, handle);
    return handle;
  }

  stopLoop(name, fade = 0.3) { this.loops.get(name)?.stop(fade); }
  hasLoop(name) { return this.loops.has(name); }

  /** Cross-fade ambience beds. `mix` = {amb_beach: 0.8, amb_wind: 0.2} */
  setAmbience(mix, fade = 1.5) {
    for (const [name, h] of this.loops) {
      if (!name.startsWith('amb_')) continue;
      if (!(name in mix)) h.setVolume(0, fade);
    }
    for (const [name, vol] of Object.entries(mix)) {
      if (vol <= 0.001) { this.loops.get(name)?.setVolume(0, fade); continue; }
      let h = this.loops.get(name);
      if (!h) h = this.loop(name, { volume: 0, bus: 'ambience', fadeIn: 0.01 });
      h?.setVolume(vol, fade);
    }
  }

  playMusic(name, fade = 2.5) {
    if (this._musicName === name) return;
    if (this._music) { this._music.stop(fade); this._music = null; }
    this._musicName = name;
    if (!name) return;
    this._music = this.loop(name, { bus: 'music', fadeIn: fade });
  }

  /** 0 = above water, 1 = fully submerged. Drives the global low-pass. */
  setUnderwater(t, immediate = false) {
    if (!this.ready) return;
    this._underwater = t;
    const freq = 22000 - clamp01(t) * 21400;
    const now = this.ctx.currentTime;
    this.muffle.frequency.cancelScheduledValues(now);
    this.muffle.frequency.setValueAtTime(this.muffle.frequency.value, now);
    this.muffle.frequency.linearRampToValueAtTime(Math.max(320, freq), now + (immediate ? 0.02 : 0.35));
  }

  setReverb(amount, t = 1.0) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    this.reverbGain.gain.cancelScheduledValues(now);
    this.reverbGain.gain.setValueAtTime(this.reverbGain.gain.value, now);
    this.reverbGain.gain.linearRampToValueAtTime(clamp01(amount), now + t);
  }

  updateListener(camera) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    camera.getWorldPosition(this.listenerPos);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      const t = this.ctx.currentTime + 0.02;
      l.positionX.linearRampToValueAtTime(this.listenerPos.x, t);
      l.positionY.linearRampToValueAtTime(this.listenerPos.y, t);
      l.positionZ.linearRampToValueAtTime(this.listenerPos.z, t);
      l.forwardX.linearRampToValueAtTime(fwd.x, t);
      l.forwardY.linearRampToValueAtTime(fwd.y, t);
      l.forwardZ.linearRampToValueAtTime(fwd.z, t);
      l.upX.linearRampToValueAtTime(up.x, t);
      l.upY.linearRampToValueAtTime(up.y, t);
      l.upZ.linearRampToValueAtTime(up.z, t);
    } else {
      l.setPosition(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  setVolume(busName, v) {
    this.volumes[busName] = clamp01(v);
    if (!this.ready) return;
    if (busName === 'master') this.master.gain.value = this.muted ? 0 : v;
    else if (this.buses[busName]) this.buses[busName].gain.value = v;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ready) this.master.gain.value = this.muted ? 0 : this.volumes.master;
    bus.emit('audio:mute', this.muted);
    return this.muted;
  }
}

// ---------------------------------------------------------------------------
// Procedural fallback synthesis. Keeps the game audible with zero asset files.
// ---------------------------------------------------------------------------

function noiseBuffer(ctx, seconds = 1, color = 'white') {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else d[i] = w;
  }
  return b;
}

const _noiseCache = new Map();
function cachedNoise(ctx, seconds, color) {
  const k = `${seconds}:${color}`;
  if (!_noiseCache.has(k)) _noiseCache.set(k, noiseBuffer(ctx, seconds, color));
  return _noiseCache.get(k);
}

/** Descriptor-driven synth. Returns {node, out} or null. */
function synthesize(ctx, name, o = {}) {
  const t = ctx.currentTime;
  const spec = SYNTH_SPECS[name] || matchSpec(name);
  if (!spec) return null;

  if (spec.type === 'noise') {
    const src = ctx.createBufferSource();
    src.buffer = cachedNoise(ctx, 2, spec.color || 'white');
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;
    const filt = ctx.createBiquadFilter();
    filt.type = spec.filter || 'bandpass';
    filt.frequency.setValueAtTime(spec.f0, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, spec.f1), t + spec.dur);
    filt.Q.value = spec.q ?? 1;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(spec.peak ?? 0.7, t + (spec.attack ?? 0.005));
    env.gain.exponentialRampToValueAtTime(0.0005, t + spec.dur);
    src.connect(filt); filt.connect(env);
    src.stop(t + spec.dur + 0.05);
    return { node: src, out: env };
  }

  if (spec.type === 'tone') {
    const osc = ctx.createOscillator();
    osc.type = spec.wave || 'sine';
    osc.frequency.setValueAtTime(spec.f0 * (o.rate ?? 1), t);
    if (spec.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.f1 * (o.rate ?? 1)), t + spec.dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(spec.peak ?? 0.32, t + (spec.attack ?? 0.006));
    env.gain.exponentialRampToValueAtTime(0.0005, t + spec.dur);
    osc.connect(env);
    osc.stop(t + spec.dur + 0.05);
    return { node: osc, out: env };
  }

  if (spec.type === 'chord') {
    const out = ctx.createGain();
    out.gain.value = 0.001;
    const merger = ctx.createGain();
    let first = null;
    spec.notes.forEach((semi, i) => {
      const osc = ctx.createOscillator();
      osc.type = spec.wave || 'triangle';
      const f = spec.root * Math.pow(2, semi / 12);
      const st = t + i * (spec.stagger ?? 0.06);
      osc.frequency.setValueAtTime(f, st);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime((spec.peak ?? 0.22) / spec.notes.length, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, st + spec.dur);
      osc.connect(g); g.connect(merger);
      osc.start(st); osc.stop(st + spec.dur + 0.05);
      if (!first) first = osc;
    });
    // Merger needs a node with onended/start; reuse the first oscillator as driver.
    return { node: first, out: merger };
  }

  return null;
}

function matchSpec(name) {
  const base = name.replace(/\d+$/, '');
  if (SYNTH_SPECS[base]) return SYNTH_SPECS[base];
  if (base.startsWith('footstep')) return SYNTH_SPECS.footstep_sand;
  if (base.startsWith('splash')) return SYNTH_SPECS.splash_small;
  if (base.startsWith('coin')) return SYNTH_SPECS.coin;
  if (base.startsWith('combo')) return SYNTH_SPECS.coin;
  if (base.startsWith('seagull')) return SYNTH_SPECS.seagull;
  if (base.startsWith('thunder')) return SYNTH_SPECS.thunder;
  if (base.startsWith('sub_creak')) return SYNTH_SPECS.creak;
  if (base.startsWith('fish_flop')) return SYNTH_SPECS.fish_flop;
  if (base.includes('impact') || base.includes('hit')) return SYNTH_SPECS.thud;
  if (base.includes('ui')) return SYNTH_SPECS.ui_click;
  return SYNTH_SPECS.ui_click;
}

const SYNTH_SPECS = {
  splash_small: { type: 'noise', color: 'white', filter: 'bandpass', f0: 2600, f1: 500, q: 0.9, dur: 0.34, peak: 0.5 },
  splash_medium: { type: 'noise', color: 'white', filter: 'bandpass', f0: 1900, f1: 260, q: 0.8, dur: 0.6, peak: 0.7 },
  splash_big: { type: 'noise', color: 'pink', filter: 'lowpass', f0: 2600, f1: 140, q: 0.7, dur: 1.15, peak: 0.9 },
  cast_whoosh: { type: 'noise', color: 'pink', filter: 'bandpass', f0: 500, f1: 2600, q: 1.5, dur: 0.28, peak: 0.4 },
  fish_bite: { type: 'tone', wave: 'square', f0: 620, f1: 180, dur: 0.16, peak: 0.24 },
  fish_flop: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 900, f1: 190, q: 1, dur: 0.16, peak: 0.5 },
  fish_impact: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 500, f1: 90, q: 1, dur: 0.24, peak: 0.75 },
  thud: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 380, f1: 70, q: 1, dur: 0.22, peak: 0.65 },
  footstep_sand: { type: 'noise', color: 'pink', filter: 'bandpass', f0: 1500, f1: 620, q: 1.2, dur: 0.1, peak: 0.24 },
  footstep_wood: { type: 'noise', color: 'brown', filter: 'bandpass', f0: 900, f1: 300, q: 2.2, dur: 0.12, peak: 0.3 },
  footstep_metal: { type: 'noise', color: 'white', filter: 'bandpass', f0: 2600, f1: 1200, q: 3.5, dur: 0.11, peak: 0.22 },
  jump: { type: 'noise', color: 'pink', filter: 'bandpass', f0: 700, f1: 1500, q: 1.4, dur: 0.13, peak: 0.2 },
  land: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 600, f1: 110, q: 1, dur: 0.18, peak: 0.4 },
  ui_click: { type: 'tone', wave: 'square', f0: 900, f1: 640, dur: 0.05, peak: 0.11 },
  ui_hover: { type: 'tone', wave: 'sine', f0: 1500, f1: 1500, dur: 0.035, peak: 0.05 },
  ui_open: { type: 'tone', wave: 'triangle', f0: 500, f1: 1150, dur: 0.16, peak: 0.14 },
  ui_close: { type: 'tone', wave: 'triangle', f0: 1100, f1: 460, dur: 0.14, peak: 0.13 },
  ui_error: { type: 'tone', wave: 'sawtooth', f0: 250, f1: 120, dur: 0.24, peak: 0.16 },
  notification: { type: 'chord', root: 880, notes: [0, 7], wave: 'sine', dur: 0.35, peak: 0.16, stagger: 0.07 },
  coin: { type: 'tone', wave: 'triangle', f0: 1650, f1: 2400, dur: 0.1, peak: 0.16 },
  cash_register: { type: 'chord', root: 660, notes: [0, 4, 7, 12], wave: 'triangle', dur: 0.5, peak: 0.28, stagger: 0.045 },
  purchase: { type: 'chord', root: 523, notes: [0, 4, 7], wave: 'triangle', dur: 0.42, peak: 0.24, stagger: 0.05 },
  quest_complete: { type: 'chord', root: 523, notes: [0, 4, 7, 12, 16], wave: 'triangle', dur: 0.85, peak: 0.3, stagger: 0.09 },
  levelup: { type: 'chord', root: 440, notes: [0, 5, 9, 14], wave: 'triangle', dur: 0.8, peak: 0.28, stagger: 0.08 },
  rare_fish: { type: 'chord', root: 1046, notes: [0, 7, 12, 19], wave: 'sine', dur: 1.3, peak: 0.24, stagger: 0.11 },
  legendary: { type: 'chord', root: 261, notes: [0, 7, 12, 15, 19], wave: 'sawtooth', dur: 1.9, peak: 0.3, stagger: 0.13 },
  record: { type: 'chord', root: 784, notes: [0, 5, 12], wave: 'triangle', dur: 0.65, peak: 0.26, stagger: 0.07 },
  harpoon_fire: { type: 'noise', color: 'white', filter: 'bandpass', f0: 3200, f1: 380, q: 1.1, dur: 0.24, peak: 0.7 },
  harpoon_impact: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 900, f1: 90, q: 1, dur: 0.3, peak: 0.85 },
  harpoon_reload: { type: 'noise', color: 'white', filter: 'bandpass', f0: 1800, f1: 900, q: 4, dur: 0.28, peak: 0.24 },
  gun_shot: { type: 'noise', color: 'white', filter: 'lowpass', f0: 6000, f1: 200, q: 0.8, dur: 0.3, peak: 0.95 },
  gun_reload: { type: 'noise', color: 'white', filter: 'bandpass', f0: 2200, f1: 1100, q: 5, dur: 0.3, peak: 0.2 },
  explosion: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 2200, f1: 45, q: 0.7, dur: 1.6, peak: 1.0 },
  spear_throw: { type: 'noise', color: 'pink', filter: 'bandpass', f0: 700, f1: 3200, q: 2, dur: 0.2, peak: 0.4 },
  net_throw: { type: 'noise', color: 'pink', filter: 'bandpass', f0: 1200, f1: 500, q: 1, dur: 0.35, peak: 0.3 },
  club_hit: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 700, f1: 80, q: 1, dur: 0.24, peak: 0.8 },
  line_snap: { type: 'tone', wave: 'sawtooth', f0: 1800, f1: 220, dur: 0.22, peak: 0.3 },
  reel_click: { type: 'noise', color: 'white', filter: 'bandpass', f0: 3800, f1: 3000, q: 8, dur: 0.035, peak: 0.16 },
  sonar_ping: { type: 'tone', wave: 'sine', f0: 1400, f1: 700, dur: 1.1, peak: 0.28 },
  creak: { type: 'noise', color: 'brown', filter: 'bandpass', f0: 320, f1: 140, q: 6, dur: 1.5, peak: 0.4 },
  sub_dive: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 700, f1: 90, q: 1, dur: 2.0, peak: 0.5 },
  bubbles: { type: 'noise', color: 'white', filter: 'bandpass', f0: 1400, f1: 3000, q: 6, dur: 0.6, peak: 0.24 },
  underwater_whoosh: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 1200, f1: 200, q: 1, dur: 0.7, peak: 0.5 },
  thunder: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 900, f1: 35, q: 0.8, dur: 3.2, peak: 0.9 },
  seagull: { type: 'tone', wave: 'sawtooth', f0: 1500, f1: 900, dur: 0.32, peak: 0.13 },
  pickup: { type: 'tone', wave: 'triangle', f0: 800, f1: 1300, dur: 0.09, peak: 0.14 },
  drop: { type: 'tone', wave: 'triangle', f0: 700, f1: 320, dur: 0.11, peak: 0.14 },
  crate_break: { type: 'noise', color: 'brown', filter: 'bandpass', f0: 1400, f1: 260, q: 1.4, dur: 0.5, peak: 0.7 },
  door_open: { type: 'noise', color: 'brown', filter: 'bandpass', f0: 420, f1: 180, q: 5, dur: 0.7, peak: 0.3 },
  boss_roar: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 420, f1: 60, q: 1.4, dur: 2.4, peak: 1.0 },
  boss_slam: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 900, f1: 40, q: 1, dur: 1.4, peak: 1.0 },
  boat_impact: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 600, f1: 60, q: 1, dur: 0.55, peak: 0.85 },
  boat_engine_start: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 200, f1: 420, q: 2, dur: 1.1, peak: 0.5 },
  boat_engine_stop: { type: 'noise', color: 'brown', filter: 'lowpass', f0: 420, f1: 90, q: 2, dur: 0.9, peak: 0.4 },
  fish_thrash: { type: 'noise', color: 'white', filter: 'bandpass', f0: 2200, f1: 500, q: 0.9, dur: 0.5, peak: 0.6 },
  radio_static: { type: 'noise', color: 'white', filter: 'bandpass', f0: 2400, f1: 2400, q: 1.2, dur: 0.6, peak: 0.2 },
};

/** Looping synth fallbacks (engines, reels, ambience beds). */
function synthesizeLoop(ctx, name, o = {}) {
  const base = name.replace(/\d+$/, '');
  if (base.includes('engine')) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 58;
    const sub = ctx.createOscillator();
    sub.type = 'square'; sub.frequency.value = 29;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3;
    const mix = ctx.createGain(); mix.gain.value = 0.3;
    const subG = ctx.createGain(); subG.gain.value = 0.5;
    osc.connect(lp); sub.connect(subG); subG.connect(lp); lp.connect(mix);
    sub.start(0);
    return { node: osc, out: mix, rateParam: osc.frequency, extra: [sub] };
  }
  if (base.includes('reel')) {
    const src = ctx.createBufferSource();
    src.buffer = cachedNoise(ctx, 1, 'white'); src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 7;
    const g = ctx.createGain(); g.gain.value = 0.35;
    src.connect(bp); bp.connect(g);
    return { node: src, out: g, rateParam: src.playbackRate };
  }
  if (base.includes('tension')) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth'; osc.frequency.value = 180;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 9;
    const g = ctx.createGain(); g.gain.value = 0.14;
    osc.connect(bp); bp.connect(g);
    return { node: osc, out: g, rateParam: osc.frequency };
  }
  if (base.includes('rain') || base.includes('storm')) {
    const src = ctx.createBufferSource();
    src.buffer = cachedNoise(ctx, 3, 'white'); src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = base.includes('storm') ? 7000 : 5200;
    const g = ctx.createGain(); g.gain.value = base.includes('storm') ? 0.5 : 0.3;
    src.connect(hp); hp.connect(lp); lp.connect(g);
    return { node: src, out: g, rateParam: src.playbackRate };
  }
  if (base.includes('wind')) {
    const src = ctx.createBufferSource();
    src.buffer = cachedNoise(ctx, 3, 'pink'); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 480; bp.Q.value = 0.7;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
    const lfoG = ctx.createGain(); lfoG.gain.value = 260;
    lfo.connect(lfoG); lfoG.connect(bp.frequency); lfo.start(0);
    const g = ctx.createGain(); g.gain.value = 0.3;
    src.connect(bp); bp.connect(g);
    return { node: src, out: g, rateParam: src.playbackRate };
  }
  if (base.includes('underwater') || base.includes('deep')) {
    const src = ctx.createBufferSource();
    src.buffer = cachedNoise(ctx, 3, 'brown'); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = base.includes('deep') ? 180 : 380;
    const g = ctx.createGain(); g.gain.value = 0.55;
    src.connect(lp); lp.connect(g);
    return { node: src, out: g, rateParam: src.playbackRate };
  }
  // Generic ocean/beach/harbor bed: slow-swelling filtered noise.
  const src = ctx.createBufferSource();
  src.buffer = cachedNoise(ctx, 4, 'pink'); src.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
  const lfoG = ctx.createGain(); lfoG.gain.value = 420;
  lfo.connect(lfoG); lfoG.connect(bp.frequency); lfo.start(0);
  const amp = ctx.createGain(); amp.gain.value = 0.28;
  const alfo = ctx.createOscillator(); alfo.frequency.value = 0.11;
  const alfoG = ctx.createGain(); alfoG.gain.value = 0.12;
  alfo.connect(alfoG); alfoG.connect(amp.gain); alfo.start(0);
  src.connect(bp); bp.connect(amp);
  return { node: src, out: amp, rateParam: src.playbackRate };
}
