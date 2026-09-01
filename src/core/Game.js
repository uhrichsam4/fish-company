import * as THREE from 'three';
import { bus } from './EventBus.js';
import { Input } from './Input.js';
import { AssetManager } from './AssetManager.js';
import { AudioManager } from './AudioManager.js';
import { SaveManager } from './SaveManager.js';
import { PhysicsWorld, initRapier } from '../physics/PhysicsWorld.js';
import { clamp, damp } from '../util/math.js';

/**
 * Root orchestrator. Owns renderer/scene/camera/physics and a list of systems.
 * Systems are plain objects with optional init/update/lateUpdate/dispose and
 * an `order` number controlling update sequence.
 */
export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.systems = [];
    this.systemsByName = new Map();
    this.time = 0;
    this.frame = 0;
    this.dt = 1 / 60;
    this.rawDt = 1 / 60;
    this.timeScale = 1;
    this.paused = false;
    this.running = false;
    this.perf = { fps: 60, ms: 0, physMs: 0, renderMs: 0, drawCalls: 0, tris: 0, samples: [] };
    this.quality = 'high';
    this.settings = {
      shadows: true, shadowRes: 2048, fov: 75, sensitivity: 0.0022, invertY: false,
      renderScale: 1, maxFish: 140, particles: 1, motionBlur: false, bobbing: 1,
      showFps: false, viewDistance: 1.0, waterQuality: 2, uiScale: 1, autosave: true,
      volMaster: 0.85, volSfx: 1.0, volMusic: 0.45, volAmb: 0.6, subtitles: true,
    };
    this._accumFrames = 0;
    this._accumTime = 0;
    this._raf = 0;
  }

  async init() {
    setStatus('creating renderer…');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    const gl = this.renderer.getContext();
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.error('[Game] WebGL context lost');
      this.running = false;
      bus.emit('toast', { text: 'Graphics context lost — reloading…', kind: 'error' });
      setTimeout(() => location.reload(), 2500);
    });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x89c6e8);
    this.scene.fog = new THREE.FogExp2(0x9fd0e8, 0.0032);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.08, 4000);
    this.camera.position.set(0, 3, 0);
    /** Separate camera rig lets systems (boat/sub) drive position while look stays FPS-native. */
    this.cameraRoot = new THREE.Object3D();
    this.scene.add(this.cameraRoot);

    setStatus('loading physics…');
    await initRapier();
    this.physics = new PhysicsWorld({ gravity: -22 });

    this.input = new Input(this.canvas);
    this.assets = new AssetManager(this.renderer);
    this.audio = new AudioManager();
    this.save = new SaveManager();

    const saved = this.save.loadSettings();
    if (saved) Object.assign(this.settings, saved);
    this.applySettings();

    this.raycaster = new THREE.Raycaster();
    this._lastTime = performance.now();

    window.addEventListener('resize', () => this.resize());
    this.resize();

    bus.on('settings:changed', () => { this.applySettings(); this.save.saveSettings(this.settings); });
    return this;
  }

  applySettings() {
    const s = this.settings;
    this.renderer.shadowMap.enabled = s.shadows;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * s.renderScale, 2));
    if (this.camera) { this.camera.fov = s.fov; this.camera.updateProjectionMatrix(); }
    if (this.input) { this.input.sensitivity = s.sensitivity; this.input.invertY = s.invertY; }
    if (this.audio?.ready) {
      this.audio.setVolume('master', s.volMaster);
      this.audio.setVolume('sfx', s.volSfx);
      this.audio.setVolume('music', s.volMusic);
      this.audio.setVolume('ambience', s.volAmb);
    }
    this.save.enabled = s.autosave;
    // Sky owns its own shadow sizing (the frustum and the map resolution have
    // to change together); tell it rather than poking the light directly.
    this.get('sky')?._applyShadowSize?.(s.shadowRes);
    bus.emit('settings:applied', s);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    bus.emit('resize', { w, h });
  }

  /** @param {{name:string, order?:number, init?:Function, update?:Function, lateUpdate?:Function}} sys */
  add(sys) {
    // A system may be registered both by main.js and by a sibling that owns
    // it; keep the first and hand the caller the existing instance.
    if (sys.name && this.systemsByName.has(sys.name)) {
      const existing = this.systemsByName.get(sys.name);
      if (existing !== sys) console.info(`[Game] "${sys.name}" already registered — reusing the existing instance`);
      return existing;
    }
    sys.game = this;
    sys.order = sys.order ?? 100;
    this.systems.push(sys);
    this.systems.sort((a, b) => a.order - b.order);
    if (sys.name) this.systemsByName.set(sys.name, sys);
    return sys;
  }

  get(name) { return this.systemsByName.get(name); }

  async initSystems() {
    for (const s of this.systems) {
      if (s.init) {
        setStatus(`init ${s.name ?? 'system'}…`);
        try { await s.init(this); }
        catch (e) { console.error(`[Game] system "${s.name}" init failed:`, e); }
      }
    }
  }

  start() {
    this.running = true;
    this._lastTime = performance.now();
    this._lastRaf = performance.now();
    const loop = (t) => {
      this._raf = requestAnimationFrame(loop);
      if (!this.running) return;
      this._lastRaf = performance.now();
      this.tick(t);
    };
    this._raf = requestAnimationFrame(loop);

    // rAF stops in a backgrounded tab AND in an off-screen embedded pane that
    // still reports document.hidden === false. Automated sessions set
    // `allowHiddenTick`; drive the loop from a worker whenever rAF has stalled.
    //
    // The ticker lives in a worker because a main-thread setInterval is clamped
    // to roughly 1 Hz in a background tab: the game did keep running, but at a
    // frame a second, which turned every timed assertion in an automated run
    // into a spurious failure. Worker timers are not clamped that way.
    this._startFallbackTicker();
  }

  _startFallbackTicker() {
    const tick = () => {
      if (!this.running || !this.allowHiddenTick) return;
      if (performance.now() - this._lastRaf < 150) return;
      this.tick(performance.now());
    };
    try {
      // Ping-pong rather than a free-running interval: the worker only schedules
      // the next tick once this one has been asked for. A fixed interval queues
      // messages faster than a slow frame can drain them, and the main thread
      // never catches up.
      const src = 'onmessage=(e)=>{setTimeout(()=>postMessage(0),e.data);};';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this._tickWorker = new Worker(url);
      URL.revokeObjectURL(url);
      this._tickWorker.onmessage = () => {
        tick();
        if (this.running) this._tickWorker?.postMessage(16);
      };
      this._tickWorker.postMessage(16);
    } catch (e) {
      // No worker (blob URLs blocked, or a very old runtime): a throttled timer
      // still beats no loop at all.
      this._hiddenTimer = setInterval(tick, 16);
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    clearInterval(this._hiddenTimer);
    this._tickWorker?.terminate();
    this._tickWorker = null;
  }

  tick(tMs) {
    const t0 = performance.now();
    const now = performance.now();
    let raw = (now - this._lastTime) / 1000;
    this._lastTime = now;
    // Clamp to survive tab-switch / breakpoints without exploding physics.
    raw = clamp(raw, 0, 0.1);
    this.rawDt = raw;
    const dt = this.paused ? 0 : raw * this.timeScale;
    this.dt = dt;
    this.time += dt;
    this.frame++;

    for (const s of this.systems) {
      if (!s.update || s.disabled) continue;
      try { s.update(dt, this); }
      catch (e) {
        console.error(`[Game] "${s.name}" update threw:`, e);
        s.errorCount = (s.errorCount || 0) + 1;
        s.lastError = this.frame;
        if (s.errorCount > 240) {
          s.disabled = true;
          console.error(`[Game] disabling "${s.name}" after ${s.errorCount} errors`);
        }
      }
    }

    const tp = performance.now();
    if (!this.paused) this.physics.step(dt);
    this.perf.physMs = damp(this.perf.physMs, performance.now() - tp, 0.02, raw);

    for (const s of this.systems) {
      if (!s.lateUpdate || s.disabled) continue;
      try { s.lateUpdate(dt, this); }
      catch (e) { console.error(`[Game] "${s.name}" lateUpdate threw:`, e); }
    }

    if (!this.paused) this.save.update(raw);
    this.audio.updateListener(this.camera);
    this.input.endFrame();

    const tr = performance.now();
    this.renderer.info.reset();
    this.render();
    this.perf.renderMs = damp(this.perf.renderMs, performance.now() - tr, 0.02, raw);
    this.perf.drawCalls = this.renderer.info.render.calls;
    this.perf.tris = this.renderer.info.render.triangles;

    // Decay error counts so a transient burst doesn't permanently kill a system.
    if ((this.frame & 255) === 0) {
      for (const s of this.systems) if (s.errorCount > 0 && this.frame - (s.lastError || 0) > 600) s.errorCount = 0;
    }

    this._accumFrames++;
    this._accumTime += raw;
    if (this._accumTime >= 0.5) {
      this.perf.fps = this._accumFrames / this._accumTime;
      this._accumFrames = 0; this._accumTime = 0;
      bus.emit('perf', this.perf);
      this.autoQuality();
    }
    this.perf.ms = performance.now() - t0;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    for (const s of this.systems) {
      if (!s.postRender || s.disabled) continue;
      try { s.postRender(this); }
      catch (e) { console.error(`[Game] "${s.name}" postRender threw:`, e); }
    }
  }

  /** Drop expensive features if the frame budget is blown for a sustained period. */
  autoQuality() {
    if (this.settings.autoQuality === false) return;
    const fps = this.perf.fps;
    this._qLow = (this._qLow || 0);
    this._qHigh = (this._qHigh || 0);
    if (fps < 34) { this._qLow++; this._qHigh = 0; } else if (fps > 55) { this._qHigh++; this._qLow = 0; } else { this._qLow = this._qHigh = 0; }
    if (this._qLow > 5 && this.quality !== 'low') {
      this.quality = this.quality === 'high' ? 'medium' : 'low';
      this._qLow = 0;
      bus.emit('quality:changed', this.quality);
      console.info('[Game] auto quality ->', this.quality);
    } else if (this._qHigh > 20 && this.quality !== 'high') {
      this.quality = this.quality === 'low' ? 'medium' : 'high';
      this._qHigh = 0;
      bus.emit('quality:changed', this.quality);
      console.info('[Game] auto quality ->', this.quality);
    }
  }

  setPaused(p) {
    if (this.paused === p) return;
    this.paused = p;
    bus.emit('game:paused', p);
    if (p) { for (const h of this.audio.loops.values()) h.setVolume(0.0, 0.2); }
  }
}

function setStatus(text) {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
}
export { setStatus };
