import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, TAU } from '../util/math.js';
import { waveState, waterHeightAt } from '../world/waves.js';
import { buildParticleAtlas, TILE, PAL } from './spriteAtlas.js';
import { SpriteParticles, DebrisPool, VolumeParticles, makeSpawnDesc, resetDesc } from './ParticlePool.js';
import { WaterDecals } from './Decals.js';
import { Ribbon, LightningBolt, makeFoamStripTexture } from './Trails.js';
import { GodRays } from './GodRays.js';

/**
 * ============================== FX SYSTEM ==================================
 *
 * Every visual effect in the game lives here. Two entry points for each one:
 * a direct method (`fx.splash(pos, {scale:2})`) and a bus event
 * (`bus.emit('fx:splash', {position, scale})`) so gameplay code never has to
 * hold a reference.
 *
 * Draw-call budget for the WHOLE vfx layer:
 *   1  additive sprite batch      (sparks, flares, glints, fire, coins)
 *   1  alpha sprite batch         (droplets, foam, smoke, bubbles, dust)
 *   1  water decal batch          (ripples, foam rings, slicks)
 *   1  debris instanced mesh      (impact chips — CPU simulated, bounces)
 *   1  rain + 1 snow + 1 motes    (camera-wrapping volumes)
 *   n  ribbons (one per live boat wake, max 6)
 *   1  god rays  +  ≤3 lightning bolts
 *
 * See ParticlePool.js for why the sprite batches simulate in the vertex shader
 * and the debris does not.
 * ===========================================================================
 */

const CAP = {
  add: 1500,      // additive sprites
  alpha: 2400,    // alpha-blended sprites
  debris: 220,
  decals: 72,
  rain: 3200,
  snow: 2600,
  motes: 900,
  ribbons: 6,
  bolts: 3,
  lights: 4,
};

/** Per-frame spawn ceiling — a pathological event storm can't stall the CPU. */
const FRAME_SPAWN_BUDGET = 420;

const QUALITY_SCALE = { high: 1, medium: 0.72, low: 0.45 };

const IMPACT_KINDS = {
  wood: { chip: PAL.wood, chip2: PAL.woodDark, dust: PAL.dustTan, sparks: 0, chips: 8, dustN: 5, size: 0.14, ring: false },
  metal: { chip: PAL.metal, chip2: 0x8e97a3, dust: 0xc9d2dc, sparks: 16, chips: 6, dustN: 3, size: 0.10, ring: true },
  stone: { chip: PAL.stone, chip2: 0x6f6d68, dust: 0xcfc9bb, sparks: 0, chips: 9, dustN: 7, size: 0.15, ring: false },
  ice: { chip: PAL.ice, chip2: 0x7fd8f0, dust: 0xe6fbff, sparks: 8, chips: 10, dustN: 5, size: 0.13, ring: true },
  flesh: { chip: PAL.flesh, chip2: 0xf0b79a, dust: 0xffe6d6, sparks: 0, chips: 4, dustN: 9, size: 0.11, ring: false },
  water: null,   // routed to splash()
};

export class Effects {
  name = 'fx';
  order = 800;

  constructor(game) {
    this.game = game;
    /** fx clock — advances with game.dt so hit-stop and pause slow particles too */
    this.t = 0;
    /** unscaled clock, for timings that must not be affected by hit-stop */
    this.rt = 0;
    this.enabled = true;

    this._offs = [];
    this._emitters = [];
    this._ribbonPool = [];
    this._bolts = [];
    this._lights = [];
    this._lightsAdded = false;
    this._budget = FRAME_SPAWN_BUDGET;

    this._d = makeSpawnDesc();
    this._tmp = { x: 0, y: 0, z: 0 };
    this._axA = new Float32Array(3);
    this._axB = new Float32Array(3);
    this._axC = new Float32Array(3);
    this._dir = new Float32Array(3);

    this._wp = new THREE.Vector3();
    this._wp2 = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._frustum = new THREE.Frustum();
    this._projView = new THREE.Matrix4();
    this._fogColor = new THREE.Color(0x9fd0e8);
    this._sun = new THREE.Vector3(0.35, 0.9, 0.25).normalize();

    this._hsActive = false;
    this._hsUntil = 0;
    this._hsPrev = 1;

    this._motesOn = false;
    this._motesDensity = 0.6;
    this._godRaysOn = false;
    this._underwater = false;

    this.stats = { spawns: 0, dropped: 0, emitters: 0 };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async init(game) {
    this.game = game || this.game;
    const scene = this.game.scene;

    this.atlas = buildParticleAtlas();
    this.foamTex = makeFoamStripTexture();

    this.add = new SpriteParticles({ capacity: CAP.add, texture: this.atlas.texture, additive: true, name: 'fx-add' });
    this.alpha = new SpriteParticles({ capacity: CAP.alpha, texture: this.atlas.texture, additive: false, name: 'fx-alpha' });
    this.decals = new WaterDecals({ capacity: CAP.decals, texture: this.atlas.texture });
    this.debris = new DebrisPool({ capacity: CAP.debris });

    this.rain = new VolumeParticles({ capacity: CAP.rain, texture: this.atlas.texture, name: 'fx-rain' });
    this.rain.configure({
      box: [46, 34, 46], vel: [1.6, -19, 0.8], size: [0.035, 0.075],
      stretch: 13, tile: TILE.streak, color: 0xdff2ff, opacity: 0.75,
    });
    this.snow = new VolumeParticles({ capacity: CAP.snow, texture: this.atlas.texture, name: 'fx-snow' });
    this.snow.configure({
      box: [40, 28, 40], vel: [0.5, -1.5, 0.3], size: [0.06, 0.15], sway: [0.55, 0.6],
      stretch: 0, spin: 1.4, tile: TILE.flake, color: 0xffffff, opacity: 0.92,
    });
    this.motes = new VolumeParticles({ capacity: CAP.motes, texture: this.atlas.texture, additive: true, name: 'fx-motes' });
    this.motes.configure({
      box: [22, 16, 22], vel: [0.12, 0.07, -0.09], size: [0.012, 0.05], sway: [0.1, 0.25],
      stretch: 0, tile: TILE.blob, color: 0xcdf6ff, opacity: 0.85, twinkle: 1,
    });

    this.godrays = new GodRays();

    for (const m of [this.decals.mesh, this.alpha.mesh, this.add.mesh, this.debris.mesh,
      this.rain.mesh, this.snow.mesh, this.motes.mesh, this.godrays.mesh]) scene.add(m);

    for (let i = 0; i < CAP.bolts; i++) {
      const b = new LightningBolt();
      this._bolts.push(b);
      scene.add(b.mesh);
    }

    this._makeFlashEl();
    this._wireEvents();
    return this;
  }

  _wireEvents() {
    const on = (ev, fn) => this._offs.push(bus.on(ev, fn));
    const P = (p) => (p && p.position !== undefined ? p.position : p);

    on('fx:splash', (p) => this.splash(P(p), p || {}));
    on('fx:bigSplash', (p) => this.bigSplash(P(p), p || {}));
    on('fx:ripple', (p) => this.ripple(P(p), p?.radius));
    on('fx:bubbles', (p) => this.bubbles(P(p), p?.count, p || {}));
    on('fx:bubbleTrail', (p) => this.bubbleTrail(p?.object || p?.target, p || {}));
    on('fx:spray', (p) => this.spray(P(p), p?.direction, p || {}));
    on('fx:wake', (p) => this.wake(p?.object || p?.target, p || {}));
    on('fx:impact', (p) => this.impact(P(p), p?.normal, p || {}));
    on('fx:muzzle', (p) => this.muzzle(P(p), p?.direction));
    on('fx:explosion', (p) => this.explosion(P(p), p || {}));
    on('fx:moneyBurst', (p) => this.moneyBurst(P(p), p || {}));
    on('fx:sparkle', (p) => this.sparkle(P(p), p || {}));
    on('fx:rareAura', (p) => this.rareAura(p?.object || p?.target, p || {}));
    on('fx:dustPuff', (p) => this.dustPuff(P(p), p || {}));
    on('fx:leafBurst', (p) => this.leafBurst(P(p)));
    on('fx:steam', (p) => this.steam(P(p), p || {}));
    on('fx:hitMarker', (p) => this.hitMarker(P(p), p || {}));
    on('fx:lightning', (p) => this.lightning(p?.from, p?.to, p || {}));
    on('fx:screenFlash', (p) => this.screenFlash(p?.color, p?.duration));
    on('fx:rain', (p) => this.weatherRain(typeof p === 'number' ? p : p?.intensity ?? 0));
    on('fx:snow', (p) => this.weatherSnow(typeof p === 'number' ? p : p?.intensity ?? 0));
    on('fx:motes', (p) => this.underwaterMotes(typeof p === 'boolean' ? p : !!p?.enabled, p?.density));
    on('fx:godRays', (p) => this.godRays(typeof p === 'boolean' ? p : !!p?.enabled));
    on('fx:shake', (p) => this.shake(typeof p === 'number' ? p : p?.amount, p?.duration));
    on('fx:hitStop', (p) => this.hitStop(typeof p === 'number' ? p : p?.seconds));
    on('weather:changed', (w) => {
      if (!w) return;
      if (w.rain !== undefined) this.weatherRain(w.rain);
      if (w.snow !== undefined) this.weatherSnow(w.snow);
    });
    on('sun:changed', (d) => { if (d) this.setSun(d); });
    // Density is baked into the volume instance counts, so re-apply them when
    // quality or the particle slider moves.
    const reapply = () => {
      this.weatherRain(this._rainIntensity ?? 0);
      this.weatherSnow(this._snowIntensity ?? 0);
      this.underwaterMotes(this._motesOn, this._motesDensity);
    };
    on('quality:changed', reapply);
    on('settings:applied', reapply);
  }

  dispose() {
    // Never leave the game clock scaled, whatever else happens below.
    this._restoreTimeScale();
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;

    for (const e of this._emitters) { e.alive = false; if (e.ribbon) e.ribbon.dispose(); }
    this._emitters.length = 0;
    for (const r of this._ribbonPool) r.dispose();
    this._ribbonPool.length = 0;
    for (const b of this._bolts) b.dispose();
    this._bolts.length = 0;
    for (const l of this._lights) { l.light.parent?.remove(l.light); l.light.dispose?.(); }
    this._lights.length = 0;

    this.add?.dispose(); this.alpha?.dispose(); this.decals?.dispose();
    this.debris?.dispose(); this.rain?.dispose(); this.snow?.dispose();
    this.motes?.dispose(); this.godrays?.dispose();
    this.atlas?.dispose();
    this.foamTex?.dispose();
    this._flashEl?.remove();
    this._flashEl = null;
    this.enabled = false;
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------

  update(dt, game) {
    // Hit-stop restore happens FIRST so a throw further down can never strand
    // game.timeScale at 0.12.
    this.rt += game.rawDt ?? dt;
    if (this._hsActive && this.rt >= this._hsUntil) this._restoreTimeScale();

    this.t += dt;
    this._budget = FRAME_SPAWN_BUDGET;

    const cam = game.camera;
    this._camPos.copy(cam.position);
    this._projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projView);

    const seaY = waveState.seaLevel;
    this._underwater = this._camPos.y < waterHeightAt(this._camPos.x, this._camPos.z);

    // fog sync so spray/rain sit in the same haze as the world
    let fogDensity = 0;
    if (game.scene?.fog) {
      if (game.scene.fog.isFogExp2) { fogDensity = game.scene.fog.density; this._fogColor.copy(game.scene.fog.color); }
      else if (game.scene.fog.isFog) { fogDensity = 1 / Math.max(1, game.scene.fog.far); this._fogColor.copy(game.scene.fog.color); }
    }

    this._updateEmitters(dt);
    this.debris.update(dt, seaY);

    for (const s of [this.add, this.alpha]) {
      s.setTime(this.t);
      s.setWaterY(seaY);
      s.setFog(this._fogColor, fogDensity);
      s.flush();
    }
    this.decals.update(this.t);
    this.decals.flush();

    // Volume clocks are wrapped so the drift term never loses float precision
    // in a long session.
    const volT = this.t % 600;
    for (const v of [this.rain, this.snow, this.motes]) {
      if (v.geometry.instanceCount > 0) { v.update(volT, this._camPos); v.setFog(this._fogColor, fogDensity); }
    }
    // motes only exist below the surface
    this.motes.mesh.visible = this._motesOn && this._underwater && this.motes.geometry.instanceCount > 0;

    if (this._godRaysOn) {
      this.godrays.mesh.visible = this._underwater;
      if (this.godrays.mesh.visible) this.godrays.update(this.t, this._camPos, seaY);
    }

    for (const b of this._bolts) b.update(this.rt);

    for (const l of this._lights) {
      if (l.until > 0) {
        const left = l.until - this.rt;
        if (left <= 0) { l.until = 0; l.light.intensity = 0; l.light.visible = false; }
        else l.light.intensity = l.peak * Math.pow(left / l.life, 1.7);
      }
    }
    this.stats.emitters = this._emitters.length;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  get density() {
    const q = QUALITY_SCALE[this.game?.quality] ?? 1;
    return clamp01(this.game?.settings?.particles ?? 1) * q;
  }

  /** Scale a designed particle count by quality/settings, keeping a floor. */
  _n(base, min = 1) {
    return Math.max(min, Math.round(base * this.density));
  }

  _read(p) {
    const o = this._tmp;
    if (!p) { o.x = 0; o.y = 0; o.z = 0; return o; }
    if (Array.isArray(p)) { o.x = +p[0] || 0; o.y = +p[1] || 0; o.z = +p[2] || 0; return o; }
    o.x = +p.x || 0; o.y = +p.y || 0; o.z = +p.z || 0;
    return o;
  }

  /** Reset + return the shared spawn descriptor (never allocates). */
  _s() { return resetDesc(this._d); }

  _push(sys) {
    if (this._budget <= 0) { this.stats.dropped++; return; }
    this._budget--;
    this.stats.spawns++;
    sys.spawn(this._d, this.t);
  }

  /** Build an orthonormal basis whose primary axis is (ux,uy,uz). */
  _axis(ux, uy, uz) {
    const A = this._axA, B = this._axB, C = this._axC;
    let l = Math.hypot(ux, uy, uz);
    if (l < 1e-6) { ux = 0; uy = 1; uz = 0; l = 1; }
    A[0] = ux / l; A[1] = uy / l; A[2] = uz / l;
    const hx = Math.abs(A[1]) < 0.95 ? 0 : 1, hy = Math.abs(A[1]) < 0.95 ? 1 : 0, hz = 0;
    let bx = A[1] * hz - A[2] * hy, by = A[2] * hx - A[0] * hz, bz = A[0] * hy - A[1] * hx;
    const bl = Math.hypot(bx, by, bz) || 1;
    B[0] = bx / bl; B[1] = by / bl; B[2] = bz / bl;
    C[0] = A[1] * B[2] - A[2] * B[1];
    C[1] = A[2] * B[0] - A[0] * B[2];
    C[2] = A[0] * B[1] - A[1] * B[0];
  }

  /** Random unit vector inside a cone about the current axis. cosMin=1 -> axis. */
  _cone(cosMin) {
    const d = this._dir;
    const cz = cosMin + Math.random() * (1 - cosMin);
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
    const ph = Math.random() * TAU;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    for (let i = 0; i < 3; i++) d[i] = this._axA[i] * cz + this._axB[i] * (sz * cp) + this._axC[i] * (sz * sp);
    return d;
  }

  // -------------------------------------------------------------------------
  // WATER
  // -------------------------------------------------------------------------

  /**
   * The single most-used effect in the game: crown of foam + ballistic droplets
   * + a hard white flash + an expanding foam ring on the surface.
   * @param {THREE.Vector3|{x,y,z}|number[]} position
   * @param {{scale?:number, color?:number, up?:object, decal?:boolean, ripple?:boolean}} o
   */
  splash(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    const s = clamp(o.scale ?? 1, 0.12, 8);
    const tint = o.color ?? PAL.aqua;
    const u = o.up ? this._read(o.up) : null;
    const ux = u ? u.x : 0, uy = u ? u.y : 1, uz = u ? u.z : 0;
    const rs = Math.sqrt(s);
    let d;

    // 1 — hard white flash (the "hit" read; gone in 5 frames)
    d = this._s();
    d.x = x; d.y = y + 0.04 * s; d.z = z;
    d.life = 0.18; d.size = 0.7 * s; d.size2 = 2.3 * s; d.sizePow = 0.42;
    d.col = 0xffffff; d.col2 = tint; d.alphaPow = 2.6; d.fadeIn = 0.008;
    d.tile = TILE.splash; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 3;
    this._push(this.add);

    d = this._s();
    d.x = x; d.y = y + 0.05 * s; d.z = z;
    d.life = 0.22; d.size = 0.8 * s; d.size2 = 1.6 * s; d.sizePow = 0.5;
    d.col = tint; d.col2 = PAL.sea; d.alpha = 0.75; d.alphaPow = 2.2; d.fadeIn = 0.02;
    d.tile = TILE.flare;
    this._push(this.add);

    // 2 — the crown. Hard-edged BLOBS, barely growing, gone fast: water throws
    //     lumps, it does not billow. (Growing soft puffs = the grey-fuzz look.)
    this._axis(ux, uy, uz);
    const crown = this._n(9 * rs, 5);
    for (let i = 0; i < crown; i++) {
      const a = (i / crown) * TAU + Math.random() * 0.45;
      const out = (1.9 + Math.random() * 2.2) * rs;
      const upv = (4.2 + Math.random() * 3.4) * rs;
      d = this._s();
      d.x = x + Math.cos(a) * 0.12 * s; d.y = y + 0.02 * s; d.z = z + Math.sin(a) * 0.12 * s;
      d.vx = Math.cos(a) * out + ux * upv * 0.3;
      d.vy = upv * uy + 0.4;
      d.vz = Math.sin(a) * out + uz * upv * 0.3;
      d.grav = -17; d.drag = 1.1;
      const sv = 0.62 + Math.random() * 0.85;      // size variance kills the "row of identical bubbles" look
      d.life = 0.28 + Math.random() * 0.20;
      d.size = 0.30 * s * sv; d.size2 = 0.42 * s * sv;
      // alphaPow < 1 HOLDS the particle opaque then drops it — that is what
      // keeps foam reading as solid water instead of translucent haze.
      d.col = 0xffffff; d.col2 = 0xffffff; d.alpha = 1; d.alphaPow = 0.5; d.fadeIn = 0.012;
      d.tile = TILE.blob;
      d.stretch = 0.85;                          // sheets of water, not balls
      this._push(this.alpha);
    }
    // a little broken-up foam texture riding on top of the crown
    const froth = this._n(5 * rs, 3);
    for (let i = 0; i < froth; i++) {
      const a = Math.random() * TAU;
      const out = (0.8 + Math.random() * 1.6) * rs;
      const upv = (2.6 + Math.random() * 2.6) * rs;
      d = this._s();
      d.x = x + Math.cos(a) * 0.16 * s; d.y = y + 0.05 * s; d.z = z + Math.sin(a) * 0.16 * s;
      d.vx = Math.cos(a) * out; d.vy = upv; d.vz = Math.sin(a) * out;
      d.grav = -15; d.drag = 1.8; d.turb = 0.1;
      const fv = 0.6 + Math.random() * 0.9;
      d.life = 0.22 + Math.random() * 0.16;
      d.size = 0.22 * s * fv; d.size2 = 0.40 * s * fv; d.sizePow = 0.6;
      d.col = 0xffffff; d.col2 = PAL.foamCool; d.alpha = 1; d.alphaPow = 0.6;
      d.tile = TILE.foam; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 2.4;
      this._push(this.alpha);
    }

    // 3 — droplets on real ballistic arcs, stretched along velocity
    const drops = this._n(18 * rs, 7);
    for (let i = 0; i < drops; i++) {
      const dir = this._cone(0.40);
      const sp = (3.6 + Math.random() * 5.6) * rs;
      const big = Math.random() < 0.3;
      d = this._s();
      d.x = x + (Math.random() - 0.5) * 0.2 * s;
      d.y = y + 0.03 * s;
      d.z = z + (Math.random() - 0.5) * 0.2 * s;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp; d.vz = dir[2] * sp;
      d.grav = -23; d.drag = 0.10;
      d.life = 0.36 + Math.random() * 0.44;
      d.size = (big ? 0.14 : 0.085) * s; d.size2 = (big ? 0.10 : 0.055) * s;
      d.col = 0xffffff; d.col2 = PAL.sea; d.alpha = 1; d.alphaPow = 0.45; d.fadeIn = 0.01;
      d.tile = big ? TILE.droplet : TILE.blob;
      d.stretch = 1.25; d.water = 1;
      this._push(this.alpha);
    }

    // 3b — a couple of tall spikes: the silhouette that says "splash" at a glance
    const spikes = this._n(3 * rs, 2);
    for (let i = 0; i < spikes; i++) {
      const a = Math.random() * TAU;
      const sp = (6.5 + Math.random() * 3.5) * rs;
      d = this._s();
      d.x = x + Math.cos(a) * 0.08 * s; d.y = y; d.z = z + Math.sin(a) * 0.08 * s;
      d.vx = Math.cos(a) * 0.7 * rs; d.vy = sp; d.vz = Math.sin(a) * 0.7 * rs;
      d.grav = -19; d.drag = 1.4;
      d.life = 0.34 + Math.random() * 0.16;
      d.size = 0.20 * s; d.size2 = 0.13 * s;
      d.col = 0xffffff; d.col2 = 0xffffff; d.alpha = 1; d.alphaPow = 0.55; d.fadeIn = 0.01;
      d.tile = TILE.blob; d.stretch = 2.4;
      this._push(this.alpha);
    }

    // 4 — a few bright glints so the burst catches the eye
    const glints = this._n(4 * rs, 2);
    for (let i = 0; i < glints; i++) {
      const dir = this._cone(0.6);
      const sp = (2.5 + Math.random() * 4) * rs;
      d = this._s();
      d.x = x; d.y = y + 0.06 * s; d.z = z;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp; d.vz = dir[2] * sp;
      d.grav = -18; d.drag = 0.4;
      d.life = 0.30 + Math.random() * 0.2;
      d.size = 0.20 * s; d.size2 = 0.05 * s;
      d.col = 0xffffff; d.col2 = tint; d.alphaPow = 1.3;
      d.tile = TILE.star; d.spin = (Math.random() - 0.5) * 8;
      this._push(this.add);
    }

    // 5 — foam ring on the surface + the ocean shader's own vertex ripple
    if (o.decal !== false) {
      this.decals.spawn(x, z, {
        r0: 0.16 * s, r1: 1.25 * s, life: 0.45, tile: TILE.ring,
        col: 0xffffff, alpha: 1, alphaPow: 1.7, growPow: 0.4,
      }, this.t);
      this.decals.spawn(x, z, {
        r0: 0.3 * s, r1: 2.4 * s, life: 0.95, tile: TILE.ring,
        col: PAL.foamCool, alpha: 0.55, alphaPow: 1.2, growPow: 0.4,
        spin: (Math.random() - 0.5) * 0.6,
      }, this.t);
    }
    if (o.ripple !== false) bus.emit('ocean:ripple', { x, z, strength: clamp(0.45 * s, 0.12, 1.6) });
  }

  /** Something heavy hit the water: taller column, more debris, lingering foam. */
  bigSplash(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    const s = clamp(o.scale ?? 2.2, 0.4, 10);

    this.splash(position, { ...o, scale: s, decal: false, ripple: false });

    // vertical column of spray
    const col = this._n(11, 5);
    for (let i = 0; i < col; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * 0.35 * s;
      const up = (5.5 + Math.random() * 6.5) * Math.sqrt(s);
      const d = this._s();
      d.x = x + Math.cos(a) * r; d.y = y; d.z = z + Math.sin(a) * r;
      d.vx = Math.cos(a) * 0.7; d.vy = up; d.vz = Math.sin(a) * 0.7;
      d.grav = -14; d.drag = 1.0; d.turb = 0.2;
      d.life = 0.70 + Math.random() * 0.55;
      d.size = 0.42 * s; d.size2 = 1.5 * s; d.sizePow = 0.55;
      d.col = 0xffffff; d.col2 = PAL.foamCool; d.alpha = 1; d.alpha2 = 0.85; d.alphaPow = 1.6;
      d.tile = TILE.foam; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 1.6;
      d.delay = Math.random() * 0.08;
      this._push(this.alpha);
    }
    // drifting mist above the column
    const mist = this._n(7, 3);
    for (let i = 0; i < mist; i++) {
      const a = Math.random() * TAU;
      const d = this._s();
      d.x = x + Math.cos(a) * 0.6 * s; d.y = y + 0.8 * s; d.z = z + Math.sin(a) * 0.6 * s;
      d.vx = Math.cos(a) * 1.2; d.vy = 1.4 + Math.random(); d.vz = Math.sin(a) * 1.2;
      d.grav = -1.2; d.drag = 1.4; d.turb = 0.3;
      d.life = 1.1 + Math.random() * 0.8;
      d.size = 0.7 * s; d.size2 = 2.2 * s; d.sizePow = 0.6;
      d.col = 0xffffff; d.col2 = PAL.sky; d.alpha = 0.55; d.alphaPow = 1.2; d.fadeIn = 0.12;
      d.tile = TILE.smoke; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 0.8;
      d.delay = 0.1 + Math.random() * 0.2;
      this._push(this.alpha);
    }

    this.decals.spawn(x, z, {
      r0: 0.3 * s, r1: 2.6 * s, life: 0.9, tile: TILE.ring,
      col: PAL.foamCool, alpha: 1, alphaPow: 1.2, growPow: 0.42,
    }, this.t);
    // lingering foam patch
    this.decals.spawn(x, z, {
      r0: 0.9 * s, r1: 2.3 * s, life: 3.4, tile: TILE.foam,
      col: 0xffffff, alpha: 0.7, alphaPow: 0.7, growPow: 0.8,
      spin: (Math.random() - 0.5) * 0.25,
    }, this.t);

    bus.emit('ocean:ripple', { x, z, strength: clamp(0.5 * s, 0.2, 2.2) });
    this.shake(clamp(0.1 * s, 0.05, 0.5));
  }

  /** Expanding surface ring; also kicks the ocean shader's own ripple. */
  ripple(position, radius = 2.2, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    this.decals.spawn(p.x, p.z, {
      r0: Math.min(0.15, radius * 0.08), r1: radius, life: o.life ?? 1.4,
      tile: TILE.ring, col: o.color ?? PAL.foamCool,
      alpha: o.alpha ?? 0.7, alphaPow: 1.1, growPow: 0.5,
    }, this.t);
    bus.emit('ocean:ripple', { x: p.x, z: p.z, strength: clamp(radius * 0.2, 0.1, 1.5) });
  }

  /**
   * Rising bubbles that dissolve as they break the surface.
   * @param {*} position @param {number} count @param {{rise?:number, spread?:number, size?:number, color?:number}} o
   */
  bubbles(position, count = 12, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const rise = o.rise ?? 1.1;
    const spread = o.spread ?? 0.28;
    const size = o.size ?? 1;
    const n = this._n(count, 2);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * spread;
      const d = this._s();
      d.x = p.x + Math.cos(a) * r; d.y = p.y + (Math.random() - 0.5) * spread * 0.5; d.z = p.z + Math.sin(a) * r;
      d.vx = (Math.random() - 0.5) * 0.25;
      d.vy = rise * (0.7 + Math.random() * 0.7);
      d.vz = (Math.random() - 0.5) * 0.25;
      d.grav = 0.55; d.drag = 0.15; d.turb = 0.22;
      d.life = 1.1 + Math.random() * 1.9;
      const sz = (0.028 + Math.random() * 0.075) * size;
      d.size = sz; d.size2 = sz * 1.35;
      d.col = o.color ?? PAL.foamCool; d.col2 = 0xffffff;
      d.alpha = 0.9; d.alphaPow = 0.45; d.fadeIn = 0.08;
      d.tile = TILE.bubble; d.water = -1;   // pop at the surface
      d.spin = (Math.random() - 0.5) * 1.5;
      d.delay = Math.random() * 0.35;
      this._push(this.alpha);
    }
  }

  /** Persistent bubble stream following an object. @returns {{stop:Function}} */
  bubbleTrail(object3d, o = {}) {
    return this._addEmitter({
      kind: 'bubbles', obj: object3d,
      rate: o.rate ?? 16, offset: o.offset ? this._readArr(o.offset) : [0, 0, 0],
      spread: o.spread ?? 0.22, rise: o.rise ?? 1.0, size: o.size ?? 1,
      color: o.color ?? PAL.foamCool,
    });
  }

  /** Boat bow spray / anything throwing water forwards. */
  spray(position, direction, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    const dv = direction ? this._read(direction) : null;
    let dx = dv ? dv.x : 0, dy = dv ? dv.y : 0.6, dz = dv ? dv.z : 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const amt = clamp(o.amount ?? 1, 0.05, 4);

    this._axis(dx, dy + 0.55, dz);
    const puffs = this._n(5 * amt, 2);
    for (let i = 0; i < puffs; i++) {
      const dir = this._cone(0.55);
      const sp = (1.8 + Math.random() * 3.2) * amt;
      const d = this._s();
      d.x = x + (Math.random() - 0.5) * 0.3; d.y = y; d.z = z + (Math.random() - 0.5) * 0.3;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp + 0.8; d.vz = dir[2] * sp;
      d.grav = -9.5; d.drag = 1.9; d.turb = 0.18;
      d.life = 0.42 + Math.random() * 0.4;
      d.size = 0.2 * amt; d.size2 = 0.85 * amt; d.sizePow = 0.5;
      d.col = 0xffffff; d.col2 = PAL.foamCool; d.alpha = 0.95; d.alphaPow = 1.5;
      d.tile = TILE.foam; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 2;
      this._push(this.alpha);
    }
    const drops = this._n(9 * amt, 3);
    for (let i = 0; i < drops; i++) {
      const dir = this._cone(0.45);
      const sp = (3 + Math.random() * 5) * amt;
      const d = this._s();
      d.x = x; d.y = y + 0.05; d.z = z;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp + 1.2; d.vz = dir[2] * sp;
      d.grav = -21; d.drag = 0.12;
      d.life = 0.4 + Math.random() * 0.45;
      d.size = 0.07 * amt; d.size2 = 0.045 * amt;
      d.col = 0xffffff; d.col2 = PAL.aqua; d.alphaPow = 0.8;
      d.tile = TILE.blob; d.stretch = 0.9; d.water = 1;
      this._push(this.alpha);
    }
  }

  /** Persistent V-shaped foam wake behind a moving boat. @returns {{stop:Function}} */
  wake(object3d, o = {}) {
    const ribbon = this._takeRibbon(o);
    return this._addEmitter({
      kind: 'wake', obj: object3d, ribbon,
      width: o.width ?? 1.4, spread: o.spread ?? 0.45,
      offset: o.offset ? this._readArr(o.offset) : [0, 0, 0],
      sprayRate: o.sprayRate ?? 9, minSpeed: o.minSpeed ?? 0.8,
      prevX: 0, prevZ: 0, hasPrev: false, acc: 0, rippleAcc: 0,
    });
  }

  // -------------------------------------------------------------------------
  // COMBAT / WORLD
  // -------------------------------------------------------------------------

  /**
   * @param {*} position @param {*} normal surface normal (defaults to +Y)
   * @param {{kind?:'wood'|'metal'|'stone'|'water'|'flesh'|'ice', scale?:number}} o
   */
  impact(position, normal, o = {}) {
    if (!this.enabled) return;
    const kind = o.kind ?? 'stone';
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    if (kind === 'water') { this.splash(position, { scale: o.scale ?? 0.8 }); return; }
    const K = IMPACT_KINDS[kind] || IMPACT_KINDS.stone;
    const s = clamp(o.scale ?? 1, 0.2, 4);
    const nv = normal ? this._read(normal) : null;
    const nx = nv ? nv.x : 0, ny = nv ? nv.y : 1, nz = nv ? nv.z : 0;
    this._axis(nx, ny, nz);
    let d;

    // impact pop — always, so every hit has a moment of contrast
    d = this._s();
    d.x = x + nx * 0.02; d.y = y + ny * 0.02; d.z = z + nz * 0.02;
    d.life = 0.13; d.size = 0.18 * s; d.size2 = 0.75 * s; d.sizePow = 0.4;
    d.col = 0xffffff; d.col2 = K.dust; d.alphaPow = 2.4; d.fadeIn = 0.006;
    d.tile = kind === 'flesh' ? TILE.foam : TILE.splash;
    d.rot = Math.random() * TAU;
    this._push(this.add);

    // dust / puff
    const dustN = this._n(K.dustN * s, 2);
    for (let i = 0; i < dustN; i++) {
      const dir = this._cone(0.15);
      const sp = (0.7 + Math.random() * 2.1) * s;
      d = this._s();
      d.x = x; d.y = y; d.z = z;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp + 0.4; d.vz = dir[2] * sp;
      d.grav = kind === 'flesh' ? -2.5 : -3.2; d.drag = 2.4; d.turb = 0.2;
      d.life = 0.38 + Math.random() * 0.42;
      d.size = 0.16 * s * (0.7 + Math.random() * 0.7); d.size2 = 0.68 * s * (0.7 + Math.random() * 0.7); d.sizePow = 0.45;
      d.col = kind === 'flesh' ? PAL.flesh : K.dust;
      d.col2 = kind === 'flesh' ? 0xffffff : K.chip2;
      d.alpha = kind === 'flesh' ? 1 : 0.92; d.alphaPow = 0.65;
      d.tile = kind === 'flesh' ? TILE.foam : TILE.dust;
      d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 2.2;
      this._push(this.alpha);
    }

    // chunky bouncing debris
    const chips = this._n(K.chips * s, 2);
    for (let i = 0; i < chips; i++) {
      const dir = this._cone(0.1);
      const sp = (1.6 + Math.random() * 4.4) * s;
      this.debris.spawn({
        x: x + dir[0] * 0.04, y: y + dir[1] * 0.04 + 0.02, z: z + dir[2] * 0.04,
        vx: dir[0] * sp, vy: dir[1] * sp + 1.6, vz: dir[2] * sp,
        size: K.size * s, life: 0.9 + Math.random() * 0.9,
        col: Math.random() < 0.5 ? K.chip : K.chip2,
        floorY: y - 0.001, bounce: kind === 'ice' ? 0.5 : 0.32, spin: 14, water: true,
      });
    }

    // sparks (metal / ice glints)
    if (K.sparks) {
      const n = this._n(K.sparks * s, 3);
      for (let i = 0; i < n; i++) {
        const dir = this._cone(-0.2);
        const sp = (3 + Math.random() * 8) * s;
        d = this._s();
        d.x = x; d.y = y; d.z = z;
        d.vx = dir[0] * sp; d.vy = dir[1] * sp + 1.2; d.vz = dir[2] * sp;
        d.grav = -16; d.drag = 0.55;
        d.life = 0.26 + Math.random() * 0.42;
        d.size = kind === 'ice' ? 0.14 * s : 0.12 * s; d.size2 = 0.015;
        d.col = kind === 'ice' ? 0xffffff : 0xfff4c8;
        d.col2 = kind === 'ice' ? PAL.aqua : PAL.ember;
        d.alphaPow = 0.5;
        d.tile = kind === 'ice' ? TILE.star : TILE.spark;
        d.stretch = kind === 'ice' ? 0 : 2.6;
        d.spin = (Math.random() - 0.5) * 10;
        this._push(this.add);
      }
    }
    if (K.ring) {
      d = this._s();
      d.x = x + nx * 0.03; d.y = y + ny * 0.03; d.z = z + nz * 0.03;
      d.life = 0.24; d.size = 0.1 * s; d.size2 = 1.0 * s; d.sizePow = 0.35;
      d.col = kind === 'ice' ? PAL.ice : PAL.sun; d.alpha = 0.85; d.alphaPow = 2.0;
      d.tile = TILE.ring;
      this._push(this.add);
    }
  }

  /** Harpoon / gun flash. */
  muzzle(position, direction, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    const dv = direction ? this._read(direction) : null;
    let dx = dv ? dv.x : 0, dy = dv ? dv.y : 0, dz = dv ? dv.z : -1;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const s = o.scale ?? 1;
    let d;

    d = this._s();
    d.x = x + dx * 0.12; d.y = y + dy * 0.12; d.z = z + dz * 0.12;
    d.life = 0.085; d.size = 0.55 * s; d.size2 = 1.05 * s; d.sizePow = 0.4;
    d.col = 0xffffff; d.col2 = PAL.fire; d.alphaPow = 1.6; d.fadeIn = 0.004;
    d.tile = TILE.flare; d.rot = Math.random() * TAU;
    this._push(this.add);

    d = this._s();
    d.x = x + dx * 0.14; d.y = y + dy * 0.14; d.z = z + dz * 0.14;
    d.life = 0.10; d.size = 0.3 * s; d.size2 = 1.5 * s; d.sizePow = 0.35;
    d.col = PAL.fireHot; d.col2 = PAL.fire; d.alphaPow = 2.2; d.fadeIn = 0.004;
    d.tile = TILE.splash; d.rot = Math.random() * TAU;
    this._push(this.add);

    this._axis(dx, dy, dz);
    const sparks = this._n(9, 3);
    for (let i = 0; i < sparks; i++) {
      const dir = this._cone(0.86);
      const sp = 6 + Math.random() * 14;
      d = this._s();
      d.x = x + dx * 0.15; d.y = y + dy * 0.15; d.z = z + dz * 0.15;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp; d.vz = dir[2] * sp;
      d.grav = -9; d.drag = 3.5;
      d.life = 0.13 + Math.random() * 0.22;
      d.size = 0.09 * s; d.size2 = 0.01;
      d.col = PAL.fireHot; d.col2 = PAL.ember; d.alphaPow = 1.0;
      d.tile = TILE.spark; d.stretch = 1.8;
      this._push(this.add);
    }
    const puffs = this._n(4, 2);
    for (let i = 0; i < puffs; i++) {
      const dir = this._cone(0.7);
      const sp = 1 + Math.random() * 2.6;
      d = this._s();
      d.x = x + dx * 0.18; d.y = y + dy * 0.18; d.z = z + dz * 0.18;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp + 0.5; d.vz = dir[2] * sp;
      d.grav = 0.6; d.drag = 2.2; d.turb = 0.25;
      d.life = 0.55 + Math.random() * 0.5;
      d.size = 0.16 * s; d.size2 = 0.85 * s; d.sizePow = 0.5;
      d.col = 0xe9e2d6; d.col2 = PAL.smoke; d.alpha = 0.6; d.alphaPow = 1.5; d.fadeIn = 0.05;
      d.tile = TILE.smoke; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 1.4;
      this._push(this.alpha);
    }
    this.pointFlash(x + dx * 0.3, y + dy * 0.3, z + dz * 0.3, 0xffd08a, 9 * s, 9, 0.09);
  }

  explosion(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    const s = clamp(o.scale ?? 1, 0.2, 6);
    let d;

    // OPAQUE fireball body first. Additive light alone always reads as a white
    // flash — the alpha-blended orange lumps are what give it a silhouette.
    const balls = this._n(5, 3);
    for (let i = 0; i < balls; i++) {
      const a = Math.random() * TAU, r = Math.random() * 0.32 * s;
      const bv = 0.7 + Math.random() * 0.7;
      d = this._s();
      d.x = x + Math.cos(a) * r; d.y = y + (Math.random() - 0.35) * 0.35 * s; d.z = z + Math.sin(a) * r;
      d.vx = Math.cos(a) * 1.7 * s; d.vy = 1.3 * s; d.vz = Math.sin(a) * 1.7 * s;
      d.grav = 1.6; d.drag = 3.2;
      d.life = 0.34 + Math.random() * 0.22;
      d.size = 0.42 * s * bv; d.size2 = 1.5 * s * bv; d.sizePow = 0.45;
      d.col = 0xffc23a; d.col2 = 0x9c3410; d.alpha = 1; d.alphaPow = 0.85; d.fadeIn = 0.012;
      d.tile = TILE.foam; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 2.4;
      this._push(this.alpha);
    }
    // additive heat on top of the body
    for (let i = 0; i < 2; i++) {
      d = this._s();
      d.x = x; d.y = y + 0.05 * s; d.z = z;
      d.life = i === 0 ? 0.13 : 0.30;
      d.size = (i === 0 ? 0.3 : 0.5) * s;
      d.size2 = (i === 0 ? 1.2 : 2.0) * s;
      d.sizePow = 0.4;
      d.col = i === 0 ? 0xffffff : PAL.fire;
      d.col2 = i === 0 ? PAL.fire : PAL.ember;
      d.alpha = i === 0 ? 1 : 0.8; d.alphaPow = i === 0 ? 1.5 : 1.9; d.fadeIn = 0.008;
      d.tile = TILE.flare; d.rot = Math.random() * TAU;
      this._push(this.add);
    }
    // shockwave ring — thin, fast, gone
    d = this._s();
    d.x = x; d.y = y; d.z = z;
    d.life = 0.26; d.size = 0.4 * s; d.size2 = 3.4 * s; d.sizePow = 0.3;
    d.col = 0xfff0c0; d.col2 = PAL.ember; d.alpha = 1; d.alphaPow = 2.6;
    d.tile = TILE.ring;
    this._push(this.add);

    // embers
    this._axis(0, 1, 0);
    const embers = this._n(18 * s, 6);
    for (let i = 0; i < embers; i++) {
      const dir = this._cone(-0.85);
      const sp = (4 + Math.random() * 11) * s;
      d = this._s();
      d.x = x; d.y = y; d.z = z;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp + 2; d.vz = dir[2] * sp;
      d.grav = -14; d.drag = 0.8;
      d.life = 0.5 + Math.random() * 0.9;
      d.size = 0.14 * s; d.size2 = 0.02;
      d.col = PAL.fireHot; d.col2 = PAL.ember; d.alphaPow = 0.9;
      d.tile = TILE.spark; d.stretch = 1.3;
      this._push(this.add);
    }
    // smoke
    const smoke = this._n(8 * s, 4);
    for (let i = 0; i < smoke; i++) {
      const dir = this._cone(-0.5);
      const sp = (1.2 + Math.random() * 3.4) * s;
      d = this._s();
      d.x = x; d.y = y; d.z = z;
      d.vx = dir[0] * sp; d.vy = dir[1] * sp + 1.4; d.vz = dir[2] * sp;
      d.grav = 1.4; d.drag = 1.2; d.turb = 0.35;
      d.life = 0.85 + Math.random() * 0.9;
      d.size = 0.45 * s; d.size2 = 1.9 * s; d.sizePow = 0.55;
      d.col = 0x8a6a4c; d.col2 = 0xa9a49b; d.alpha = 0.8; d.alphaPow = 1.2; d.fadeIn = 0.09;
      d.tile = TILE.smoke; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 1.1;
      d.delay = Math.random() * 0.12;
      this._push(this.alpha);
    }
    const chips = this._n(9 * s, 3);
    for (let i = 0; i < chips; i++) {
      const dir = this._cone(-0.5);
      const sp = (3 + Math.random() * 8) * s;
      this.debris.spawn({
        x, y: y + 0.1, z,
        vx: dir[0] * sp, vy: dir[1] * sp + 3, vz: dir[2] * sp,
        size: 0.1 * s, life: 1.1 + Math.random(),
        col: Math.random() < 0.5 ? 0x6f6155 : 0x8a5a34, floorY: y - 0.02, bounce: 0.3, spin: 18, water: true,
      });
    }
    this.pointFlash(x, y + 0.4 * s, z, 0xffb060, 26 * s, 22 * s, 0.28);
    this.shake(clamp(0.35 * s, 0.1, 1.2));
    this.screenFlash('rgba(255,190,120,0.35)', 0.22);
  }

  /** Coins + bills popping out of a sale. Count scales with `amount`, capped at 24. */
  moneyBurst(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const x = p.x, y = p.y, z = p.z;
    const amount = o.amount ?? 100;
    const want = clamp(Math.round(5 + Math.log10(Math.max(10, amount)) * 7), 5, 24);
    const n = this._n(want, 4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const out = 0.7 + Math.random() * 2.2;
      const bill = i % 4 === 3;
      const d = this._s();
      d.x = x + (Math.random() - 0.5) * 0.15; d.y = y; d.z = z + (Math.random() - 0.5) * 0.15;
      d.vx = Math.cos(a) * out; d.vy = 3.4 + Math.random() * 2.6; d.vz = Math.sin(a) * out;
      d.grav = -11; d.drag = 0.5; d.turb = bill ? 0.35 : 0.05;
      d.life = 0.95 + Math.random() * 0.6;
      const sz = bill ? 0.16 : 0.15 + Math.random() * 0.08;
      d.size = sz; d.size2 = sz * 0.9;
      d.col = bill ? PAL.bill : PAL.gold; d.col2 = bill ? 0x5fbf5c : PAL.goldHot;
      d.alphaPow = 0.6; d.fadeIn = 0.02;
      d.tile = bill ? TILE.chip : TILE.coin;
      d.spin = (6 + Math.random() * 10) * (Math.random() < 0.5 ? -1 : 1);
      d.stretch = bill ? -0.5 : -0.85;      // negative = flip/tumble
      d.delay = Math.random() * 0.12;
      // `_s()` hands back the ONE shared descriptor, so capture anything the
      // follow-up spawn needs before resetting it.
      const px = d.x, py = d.y, pz = d.z, vx = d.vx, vy = d.vy, vz = d.vz;
      const life = d.life, delay = d.delay, spin = d.spin;
      this._push(this.alpha);

      if (!bill && i % 3 === 0) {
        const g = this._s();
        g.x = px; g.y = py; g.z = pz;
        g.vx = vx; g.vy = vy; g.vz = vz;
        g.grav = -11; g.drag = 0.5;
        g.life = life * 0.8; g.size = sz * 1.5; g.size2 = sz * 0.8;
        g.col = PAL.goldHot; g.col2 = PAL.gold; g.alpha = 0.85; g.alphaPow = 1.4;
        g.tile = TILE.star; g.spin = spin * 0.5; g.delay = delay;
        this._push(this.add);
      }
    }
  }

  /** Rare-fish shimmer. */
  sparkle(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const col = o.color ?? PAL.gold;
    const radius = o.radius ?? 0.6;
    const n = this._n(o.count ?? 14, 4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, b = Math.acos(2 * Math.random() - 1);
      const r = radius * (0.35 + Math.random() * 0.75);
      const d = this._s();
      d.x = p.x + Math.sin(b) * Math.cos(a) * r;
      d.y = p.y + Math.cos(b) * r;
      d.z = p.z + Math.sin(b) * Math.sin(a) * r;
      d.vx = (Math.random() - 0.5) * 0.35;
      d.vy = 0.25 + Math.random() * 0.5;
      d.vz = (Math.random() - 0.5) * 0.35;
      d.grav = 0.2; d.drag = 1.4; d.turb = 0.2;
      d.life = 0.5 + Math.random() * 0.6;
      d.size = 0.02; d.size2 = 0.19; d.sizePow = 0.4;
      d.col = 0xffffff; d.col2 = col; d.alphaPow = 1.6; d.fadeIn = 0.14;
      d.tile = TILE.star; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 6;
      d.delay = Math.random() * 0.5;
      this._push(this.add);
    }
  }

  /** Persistent orbiting glow. @returns {{stop:Function}} */
  rareAura(object3d, o = {}) {
    return this._addEmitter({
      kind: 'aura', obj: object3d,
      color: o.color ?? PAL.magic, intensity: clamp(o.intensity ?? 1, 0.1, 3),
      radius: o.radius ?? 0.7, rate: (o.rate ?? 16) * clamp(o.intensity ?? 1, 0.1, 3),
      offset: o.offset ? this._readArr(o.offset) : [0, 0, 0],
    });
  }

  dustPuff(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const s = o.scale ?? 1;
    const col = o.color ?? PAL.dustTan;
    const n = this._n(7 * s, 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.6;
      const sp = (0.7 + Math.random() * 1.5) * s;
      const d = this._s();
      d.x = p.x + Math.cos(a) * 0.1 * s; d.y = p.y + 0.03; d.z = p.z + Math.sin(a) * 0.1 * s;
      d.vx = Math.cos(a) * sp; d.vy = 0.35 + Math.random() * 0.7; d.vz = Math.sin(a) * sp;
      d.grav = -1.1; d.drag = 2.6; d.turb = 0.14;
      d.life = 0.45 + Math.random() * 0.5;
      d.size = 0.12 * s; d.size2 = 0.7 * s; d.sizePow = 0.45;
      d.col = col; d.col2 = 0xffffff; d.alpha = 0.75; d.alphaPow = 1.5;
      d.tile = TILE.dust; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 1.8;
      this._push(this.alpha);
    }
  }

  leafBurst(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const s = o.scale ?? 1;
    const cols = [0x74c04a, 0x9ad84f, 0x4f9b3a, 0xd9c455, 0xc98a3a];
    const n = this._n(14 * s, 5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (0.8 + Math.random() * 2.4) * s;
      const d = this._s();
      d.x = p.x + (Math.random() - 0.5) * 0.7 * s;
      d.y = p.y + (Math.random() - 0.5) * 0.7 * s;
      d.z = p.z + (Math.random() - 0.5) * 0.7 * s;
      d.vx = Math.cos(a) * sp; d.vy = 0.6 + Math.random() * 1.6; d.vz = Math.sin(a) * sp;
      d.grav = -2.6; d.drag = 1.5; d.turb = 0.75;
      d.life = 1.6 + Math.random() * 1.6;
      d.size = 0.13 * s; d.size2 = 0.11 * s;
      const c = cols[(Math.random() * cols.length) | 0];
      d.col = c; d.col2 = c; d.alphaPow = 0.5; d.fadeIn = 0.05;
      d.tile = TILE.chip;
      d.spin = (Math.random() - 0.5) * 9; d.stretch = -0.7;
      d.delay = Math.random() * 0.25;
      this._push(this.alpha);
    }
  }

  /** Hydrothermal vent plume. */
  steam(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const s = o.scale ?? 1;
    const n = this._n(13 * s, 4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, r = Math.random() * 0.22 * s;
      const d = this._s();
      d.x = p.x + Math.cos(a) * r; d.y = p.y; d.z = p.z + Math.sin(a) * r;
      d.vx = Math.cos(a) * 0.25; d.vy = 1.6 + Math.random() * 1.8; d.vz = Math.sin(a) * 0.25;
      d.grav = 1.6; d.drag = 0.7; d.turb = 0.4;
      d.life = 1.3 + Math.random() * 1.2;
      d.size = 0.26 * s; d.size2 = 1.45 * s; d.sizePow = 0.6;
      d.col = 0xffffff; d.col2 = o.color ?? PAL.sky;
      d.alpha = 0.9; d.alphaPow = 0.9; d.fadeIn = 0.1;
      d.tile = TILE.smoke; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 0.9;
      d.delay = Math.random() * 0.5;
      this._push(this.alpha);
    }
    // a shimmer of hot water right at the vent mouth
    const g = this._s();
    g.x = p.x; g.y = p.y + 0.1 * s; g.z = p.z;
    g.life = 0.6; g.size = 0.3 * s; g.size2 = 0.9 * s; g.sizePow = 0.6;
    g.col = PAL.sky; g.col2 = PAL.teal; g.alpha = 0.35; g.alphaPow = 1.4; g.fadeIn = 0.15;
    g.tile = TILE.flare;
    this._push(this.add);
  }

  /** Gore-free confirmation mark: a snappy ring + X. */
  hitMarker(position, o = {}) {
    if (!this.enabled) return;
    const p = this._read(position);
    const s = o.scale ?? 1;
    const col = o.color ?? 0xffffff;
    let d = this._s();
    d.x = p.x; d.y = p.y; d.z = p.z;
    d.life = 0.26; d.size = 0.1 * s; d.size2 = 0.42 * s; d.sizePow = 0.35;
    d.col = col; d.col2 = o.color2 ?? PAL.aqua; d.alphaPow = 1.8; d.fadeIn = 0.01;
    d.tile = TILE.cross;
    this._push(this.add);

    d = this._s();
    d.x = p.x; d.y = p.y; d.z = p.z;
    d.life = 0.32; d.size = 0.14 * s; d.size2 = 0.95 * s; d.sizePow = 0.32;
    d.col = col; d.col2 = o.color2 ?? PAL.aqua; d.alpha = 0.85; d.alphaPow = 2.2;
    d.tile = TILE.ring;
    this._push(this.add);
  }

  /** @param {*} from @param {*} to world points */
  lightning(from, to, o = {}) {
    if (!this.enabled) return;
    const a = this._read(from); const ax = a.x, ay = a.y, az = a.z;
    const b = this._read(to); const bx = b.x, by = b.y, bz = b.z;
    let bolt = this._bolts.find((x) => !x.mesh.visible) || this._bolts[0];
    const dur = o.duration ?? 0.12;
    bolt.material.uniforms.uCore.value.set(o.core ?? 0xffffff);
    bolt.material.uniforms.uGlow.value.set(o.color ?? PAL.volt);
    bolt.material.uniforms.uWidth.value = o.width ?? 0.34;
    bolt.strike(ax, ay, az, bx, by, bz, this.rt, dur, o.jitter ?? 0.10);

    // impact pop at the far end
    const d = this._s();
    d.x = bx; d.y = by; d.z = bz;
    d.life = dur * 1.6; d.size = 0.4; d.size2 = 2.4; d.sizePow = 0.35;
    d.col = 0xffffff; d.col2 = o.color ?? PAL.volt; d.alphaPow = 2.0; d.fadeIn = 0.005;
    d.tile = TILE.splash; d.rot = Math.random() * TAU;
    this._push(this.add);
    this.pointFlash((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5, o.color ?? 0x9fd0ff, 30, 40, dur * 1.3);
    if (o.flash !== false) this.screenFlash('rgba(190,225,255,0.30)', 0.16);
  }

  // -------------------------------------------------------------------------
  // SCREEN / CAMERA
  // -------------------------------------------------------------------------

  /** @param {string|number} color @param {number} duration seconds */
  screenFlash(color = 'rgba(255,255,255,0.5)', duration = 0.25) {
    const el = this._flashEl || this._makeFlashEl();
    if (!el) return;
    el.style.background = typeof color === 'number'
      ? `#${(color >>> 0).toString(16).padStart(6, '0')}`
      : color;
    el.style.transition = 'none';
    el.style.opacity = '1';
    void el.offsetWidth;                                  // force style flush
    el.style.transition = `opacity ${Math.max(0.02, duration)}s ease-out`;
    el.style.opacity = '0';
  }

  shake(amount = 0.3, duration = 0.3) {
    bus.emit('player:shake', amount);
    bus.emit('camera:shake', { amount, duration });
  }

  /**
   * Freeze-frame punch. Capped at 0.12 s. Calling it again while active only
   * extends the window — the ORIGINAL timeScale is what gets restored, and the
   * restore also runs at the top of update() and in dispose(), so no code path
   * can leave the game running in slow motion.
   */
  hitStop(seconds = 0.06, scale = 0.12) {
    const s = clamp(seconds ?? 0.06, 0, 0.12);
    if (s <= 0) return;
    if (!this._hsActive) {
      this._hsPrev = this.game?.timeScale ?? 1;
      this._hsActive = true;
    }
    this._hsUntil = Math.max(this._hsUntil, this.rt + s);
    if (this.game) this.game.timeScale = clamp(scale, 0.01, 1);
  }

  _restoreTimeScale() {
    if (!this._hsActive) return;
    this._hsActive = false;
    this._hsUntil = 0;
    if (this.game) this.game.timeScale = this._hsPrev;
  }

  /** Pooled short-lived PointLight (max 4). */
  pointFlash(x, y, z, color = 0xffffff, intensity = 10, distance = 10, life = 0.12) {
    if (this.game?.quality === 'low') return;
    if (!this._lightsAdded) {
      // Added once and kept resident: toggling the scene's light count would
      // force three to recompile every material.
      for (let i = 0; i < CAP.lights; i++) {
        const light = new THREE.PointLight(0xffffff, 0, 10, 2);
        light.visible = false;
        light.castShadow = false;
        this.game.scene.add(light);
        this._lights.push({ light, until: 0, peak: 0, life: 1 });
      }
      this._lightsAdded = true;
    }
    let slot = this._lights[0];
    for (const l of this._lights) if (l.until < slot.until) slot = l;
    slot.light.position.set(x, y, z);
    slot.light.color.set(color);
    slot.light.distance = distance;
    slot.light.intensity = intensity;
    slot.light.visible = true;
    slot.peak = intensity;
    slot.life = Math.max(0.01, life);
    slot.until = this.rt + slot.life;
  }

  // -------------------------------------------------------------------------
  // WEATHER / AMBIENCE
  // -------------------------------------------------------------------------

  /** @param {number} intensity 0..1 */
  weatherRain(intensity) {
    const i = clamp01(intensity ?? 0);
    this.rain.setCount(CAP.rain * i * this.density);
    this.rain.configure({
      opacity: 0.35 + 0.45 * i,
      vel: [1.2 + 4 * i, -(15 + 10 * i), 0.6 + 2 * i],
      size: [0.03 + 0.02 * i, 0.06 + 0.05 * i],
    });
    this._rainIntensity = i;
  }

  weatherSnow(intensity) {
    const i = clamp01(intensity ?? 0);
    this.snow.setCount(CAP.snow * i * this.density);
    this.snow.configure({ opacity: 0.55 + 0.45 * i, sway: [0.4 + 0.5 * i, 0.5 + 0.4 * i] });
    this._snowIntensity = i;
  }

  /** Floating specks; only rendered while the camera is submerged. */
  underwaterMotes(enabled, density = 0.6) {
    this._motesOn = !!enabled;
    this._motesDensity = clamp01(density);
    this.motes.setCount(this._motesOn ? CAP.motes * this._motesDensity * this.density : 0);
    this.motes.mesh.visible = this._motesOn && this._underwater;
  }

  godRays(enabled) {
    this._godRaysOn = !!enabled;
    this.godrays.mesh.visible = this._godRaysOn && this._underwater;
  }

  setSun(dir) {
    const d = this._read(dir);
    this._sun.set(d.x, d.y, d.z);
    if (this._sun.lengthSq() < 1e-6) this._sun.set(0.3, 0.9, 0.25);
    this.godrays.setSun(this._sun);
  }

  // -------------------------------------------------------------------------
  // persistent emitters
  // -------------------------------------------------------------------------

  _readArr(v) {
    const p = this._read(v);
    return [p.x, p.y, p.z];
  }

  _addEmitter(e) {
    e.alive = true;
    e.acc = e.acc ?? 0;
    e.stop = () => { e.alive = false; };
    this._emitters.push(e);
    return e;
  }

  _takeRibbon(o) {
    let r = this._ribbonPool.pop();
    if (!r) {
      if (this._liveRibbons() >= CAP.ribbons) return null;
      r = new Ribbon({
        texture: this.foamTex, capacity: 64, life: o.life ?? 3.6,
        spread: o.spread ?? 0.45, minDist: o.minDist ?? 0.55,
        color: o.color ?? 0xffffff, opacity: o.opacity ?? 0.9,
      });
      this.game.scene.add(r.mesh);
    }
    r.reset();
    return r;
  }

  _liveRibbons() {
    let n = this._ribbonPool.length;
    for (const e of this._emitters) if (e.ribbon) n++;
    return n;
  }

  _updateEmitters(dt) {
    const cam = this._camPos;
    for (let i = this._emitters.length - 1; i >= 0; i--) {
      const e = this._emitters[i];
      if (!e.alive && (!e.ribbon || e.ribbon.empty)) {
        if (e.ribbon) { e.ribbon.reset(); this._ribbonPool.push(e.ribbon); e.ribbon = null; }
        this._emitters.splice(i, 1);
        continue;
      }
      const obj = e.obj;
      if (obj && obj.isObject3D) obj.getWorldPosition(this._wp);
      else if (obj) this._wp.set(obj.x || 0, obj.y || 0, obj.z || 0);
      else { this._wp.set(0, 0, 0); }
      this._wp.x += e.offset ? e.offset[0] : 0;
      this._wp.y += e.offset ? e.offset[1] : 0;
      this._wp.z += e.offset ? e.offset[2] : 0;

      const dist = this._wp.distanceTo(cam);
      // sleep far away or fully off-screen (but keep near-camera emitters alive
      // so turning around doesn't reveal a gap in the trail)
      const asleep = dist > 120 || (dist > 35 && !this._frustum.containsPoint(this._wp));

      if (e.ribbon) e.ribbon.update(this.t);
      if (asleep || !e.alive) continue;

      switch (e.kind) {
        case 'bubbles': {
          e.acc += dt * e.rate * this.density;
          const n = Math.min(6, Math.floor(e.acc));
          e.acc -= n;
          for (let k = 0; k < n; k++) {
            const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * e.spread;
            const d = this._s();
            d.x = this._wp.x + Math.cos(a) * r;
            d.y = this._wp.y + (Math.random() - 0.5) * 0.1;
            d.z = this._wp.z + Math.sin(a) * r;
            d.vx = (Math.random() - 0.5) * 0.2;
            d.vy = e.rise * (0.7 + Math.random() * 0.8);
            d.vz = (Math.random() - 0.5) * 0.2;
            d.grav = 0.5; d.drag = 0.2; d.turb = 0.22;
            d.life = 1.4 + Math.random() * 2.2;
            const sz = (0.022 + Math.random() * 0.06) * e.size;
            d.size = sz; d.size2 = sz * 1.4;
            d.col = e.color; d.col2 = 0xffffff;
            d.alpha = 0.85; d.alphaPow = 0.4; d.fadeIn = 0.1;
            d.tile = TILE.bubble; d.water = -1;
            this._push(this.alpha);
          }
          break;
        }
        case 'aura': {
          e.acc += dt * e.rate * this.density;
          const n = Math.min(4, Math.floor(e.acc));
          e.acc -= n;
          for (let k = 0; k < n; k++) {
            const a = Math.random() * TAU;
            const b = Math.acos(2 * Math.random() - 1);
            const r = e.radius * (0.6 + Math.random() * 0.6);
            const d = this._s();
            d.x = this._wp.x + Math.sin(b) * Math.cos(a) * r;
            d.y = this._wp.y + Math.cos(b) * r * 0.7;
            d.z = this._wp.z + Math.sin(b) * Math.sin(a) * r;
            d.vx = -Math.sin(a) * 0.5; d.vy = 0.18 + Math.random() * 0.3; d.vz = Math.cos(a) * 0.5;
            d.grav = 0.1; d.drag = 1.1; d.turb = 0.12;
            d.life = 0.7 + Math.random() * 0.7;
            d.size = 0.015; d.size2 = 0.14 * e.intensity; d.sizePow = 0.4;
            d.col = 0xffffff; d.col2 = e.color; d.alpha = 0.95; d.alphaPow = 1.5; d.fadeIn = 0.2;
            d.tile = Math.random() < 0.35 ? TILE.star : TILE.blob;
            d.spin = (Math.random() - 0.5) * 5;
            this._push(this.add);
          }
          break;
        }
        case 'wake': {
          const x = this._wp.x, z = this._wp.z;
          if (!e.hasPrev) { e.prevX = x; e.prevZ = z; e.hasPrev = true; break; }
          const dx = x - e.prevX, dz = z - e.prevZ;
          const moved = Math.hypot(dx, dz);
          const speed = dt > 0 ? moved / dt : 0;
          e.prevX = x; e.prevZ = z;
          if (speed < e.minSpeed) break;
          const inv = 1 / (moved || 1);
          const nx = -dz * inv, nz = dx * inv;
          const y = waterHeightAt(x, z);
          if (e.ribbon) {
            e.ribbon.push(x, y, z, nx, nz, e.width * clamp(speed / 6, 0.35, 1.8), this.t);
          }
          e.acc += dt * e.sprayRate * clamp(speed / 6, 0.2, 2) * this.density;
          const n = Math.min(4, Math.floor(e.acc));
          e.acc -= n;
          for (let k = 0; k < n; k++) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const d = this._s();
            d.x = x + nx * side * e.width * 0.45 + (Math.random() - 0.5) * 0.2;
            d.y = y + 0.06;
            d.z = z + nz * side * e.width * 0.45 + (Math.random() - 0.5) * 0.2;
            d.vx = nx * side * 0.6 + dx * inv * speed * 0.12;
            d.vy = 0.5 + Math.random() * 1.1;
            d.vz = nz * side * 0.6 + dz * inv * speed * 0.12;
            d.grav = -6; d.drag = 2.2; d.turb = 0.14;
            d.life = 0.5 + Math.random() * 0.5;
            d.size = 0.18; d.size2 = 0.75; d.sizePow = 0.5;
            d.col = 0xffffff; d.col2 = PAL.foamCool; d.alpha = 0.9; d.alphaPow = 1.5;
            d.tile = TILE.foam; d.rot = Math.random() * TAU; d.spin = (Math.random() - 0.5) * 2;
            this._push(this.alpha);
          }
          e.rippleAcc += dt;
          if (e.rippleAcc > 0.22) {
            e.rippleAcc = 0;
            bus.emit('ocean:ripple', { x, z, strength: clamp(speed * 0.05, 0.05, 0.6) });
          }
          break;
        }
        default: break;
      }
    }
  }

  // -------------------------------------------------------------------------

  _makeFlashEl() {
    if (typeof document === 'undefined') return null;
    let el = document.getElementById('fx-flash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fx-flash';
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;z-index:60;mix-blend-mode:screen;';
      (document.getElementById('ui-root') || document.body).appendChild(el);
    }
    this._flashEl = el;
    return el;
  }

  /** Kill every live particle (region change, teleport, respawn). */
  clear() {
    for (const s of [this.add, this.alpha]) {
      s.arrays.iLife.fill(0);
      for (const k in s.attrs) { s.attrs[k].clearUpdateRanges(); s.attrs[k].needsUpdate = true; }
      s._dirtyLo = Infinity; s._dirtyHi = -1;
    }
    this.decals.arrays.iSpan.fill(0);
    for (const k in this.decals.attrs) { this.decals.attrs[k].clearUpdateRanges(); this.decals.attrs[k].needsUpdate = true; }
    this.decals._dirtyLo = Infinity; this.decals._dirtyHi = -1;
    this.debris.clear();
    for (const e of this._emitters) if (e.ribbon) e.ribbon.reset();
  }
}

export default Effects;
