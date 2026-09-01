import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { waterHeightAt } from '../world/waves.js';
import { worldHeight } from '../world/Terrain.js';
import { regionAt } from '../data/regions.js';
import { speciesForHabitat } from '../data/fishData.js';
import {
  clamp, clamp01, lerp, damp, hash2, rrange, rpick, rchance, makeRNG, weightedPick, TAU,
} from '../util/math.js';

const _v = new THREE.Vector3();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Depth palette. Each stop is the look of the world AT that depth; everything
 * between is interpolated. 0–50 m is still daylight, 200 m is the last of the
 * blue, past 500 m there is nothing at all except whatever you brought.
 */
// NB: densities are FogExp2. Underwater visibility should be tens of metres,
// not hundreds — the first pass used above-water values and the seabed
// rendered as bright dry sand with no water between it and the camera.
const DEPTH_STOPS = [
  { d: 0,    fog: 0x2f7fa8, density: 0.055, light: 1.00, water: { shallow: 0x2fbfae, deep: 0x07406e, horizon: 0x4d8fb5 }, tint: 'rgba(30,120,150,0)' },
  { d: 50,   fog: 0x14567a, density: 0.072, light: 0.62, water: { shallow: 0x1f8ea8, deep: 0x052c50, horizon: 0x2a6a90 }, tint: 'rgba(16,84,120,0.20)' },
  { d: 200,  fog: 0x07253c, density: 0.092, light: 0.24, water: { shallow: 0x0e5570, deep: 0x02121f, horizon: 0x123045 }, tint: 'rgba(6,38,62,0.46)' },
  { d: 500,  fog: 0x02101c, density: 0.105, light: 0.055, water: { shallow: 0x05283a, deep: 0x000508, horizon: 0x061520 }, tint: 'rgba(2,14,26,0.72)' },
  { d: 1200, fog: 0x01070d, density: 0.115, light: 0.012, water: { shallow: 0x021420, deep: 0x000203, horizon: 0x02090f }, tint: 'rgba(0,5,11,0.86)' },
  { d: 3000, fog: 0x000305, density: 0.125, light: 0.0,   water: { shallow: 0x010a10, deep: 0x000000, horizon: 0x010508 }, tint: 'rgba(0,2,5,0.92)' },
];

/** Deep-water habitat tags the seeded fauna is drawn from. */
const DEEP_HABITATS = ['deep', 'abyss', 'trench', 'vent', 'wreck'];

const CELL = 115;              // metres per dressing cell
const CELL_RADIUS = 1;         // 3x3 cells around the player
const DRESSING_DEPTH = 150;    // metres before the deep set dressing appears
const MAX_HALOS = 72;
const PLANKTON = 520;

/**
 * Everything that makes the deep look and sound like the deep.
 *
 * Runs after Sky (2), Ocean (5) and Weather (12), so whatever it writes to the
 * fog, the lights and the ocean uniforms is the last word before the frame is
 * drawn. All of it is driven by one number: how far the camera is below the
 * surface.
 */
export class DeepSea {
  constructor(game) {
    this.game = game;
    this.name = 'deepsea';
    this.order = 47;

    // Guard against being registered twice: SubSystem adds one from its own
    // constructor so the pair works without a main.js hook, and main.js may
    // also list DeepSea. The first instance wins; the second goes inert AND
    // drops its name so `game.get('deepsea')` still resolves to the live one.
    this._duplicate = !!game.__deepSeaClaimed;
    game.__deepSeaClaimed = true;
    if (this._duplicate) { this.name = undefined; this.disabled = true; }

    this.depth = 0;
    this.blend = 0;
    this.enabled = true;

    /** Phantom sonar returns the deep hands back. Read by SubSystem. */
    this.ghostContacts = [];
    /** Collectable resource nodes currently in the world. */
    this.nodes = [];

    this._surfaceFog = { color: new THREE.Color(0x9fd0e8), density: 0.0032 };
    this._surfaceWater = null;
    this._cells = new Map();       // cellKey -> [placed instances]
    this._pools = new Map();       // type -> {free:[], build:fn}
    this._dressTimer = 0;
    this._haloTimer = 0;
    this._ambTimer = rrange(6, 14);
    this._ghostTimer = 20;
    this._tintTimer = 0;
    this._fishTimer = 2;
    /** @type {object[]} live deep-species fish this system asked FishSystem for */
    this._deepFish = [];
    this._budget = { ms: 0 };
    this.rng = makeRNG(31415);
  }

  async init(game) {
    if (this._duplicate) { this.disabled = true; return this; }

    this.root = new THREE.Group();
    this.root.name = 'deepsea';
    this.root.visible = false;
    game.scene.add(this.root);

    this.dressingRoot = new THREE.Group();
    this.root.add(this.dressingRoot);

    this._buildMaterials();
    this._buildPools();
    this._buildPlankton();
    this._buildHalos();
    this._buildTint();

    bus.on('quality:changed', (q) => {
      this.quality = q;
      if (this.plankton) this.plankton.visible = q !== 'low';
    });
    return this;
  }

  // ------------------------------------------------------------- resources
  _buildMaterials() {
    this.rockMat = new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.97, metalness: 0.02, flatShading: true });
    this.darkRockMat = new THREE.MeshStandardMaterial({ color: 0x1a1f25, roughness: 1.0, metalness: 0.0, flatShading: true });
    this.rustMat = new THREE.MeshStandardMaterial({ color: 0x4a3830, roughness: 0.95, metalness: 0.18 });
    this.hullMat = new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.9, metalness: 0.3 });
    this.chimneyMat = new THREE.MeshStandardMaterial({
      color: 0x241d1a, roughness: 0.95, metalness: 0.05,
      emissive: 0x6a1c0a, emissiveIntensity: 0.5, flatShading: true,
    });
    this.wormMat = new THREE.MeshStandardMaterial({
      color: 0xd8d2c4, roughness: 0.8, metalness: 0,
      emissive: 0x220a08, emissiveIntensity: 0.4,
    });
    this.plumeMat = new THREE.MeshStandardMaterial({
      color: 0xe0563a, roughness: 0.6, emissive: 0xff5a2a, emissiveIntensity: 1.6, metalness: 0,
    });
    this.nodeMat = new THREE.MeshStandardMaterial({
      color: 0x7fe8d8, roughness: 0.25, metalness: 0.4,
      emissive: 0x2fd4c4, emissiveIntensity: 2.2,
    });
    this.spriteTex = makeGlowTexture();
  }

  _buildPools() {
    const P = (type, build, cap) => this._pools.set(type, { free: [], build, cap, made: 0 });
    P('vent', () => this._buildVent(), 6);
    P('wreck', () => this._buildWreck(), 3);
    P('spire', () => this._buildSpire(), 12);
    P('worms', () => this._buildWorms(), 8);
    P('wall', () => this._buildWall(), 4);
    P('node', () => this._buildNode(), 10);
    P('bloom', () => this._buildBloom(), 5);
  }

  _acquire(type) {
    const pool = this._pools.get(type);
    if (!pool) return null;
    let o = pool.free.pop();
    if (!o) {
      if (pool.made >= pool.cap) return null;
      o = pool.build();
      o.userData.poolType = type;
      pool.made++;
    }
    this.dressingRoot.add(o);
    o.visible = true;
    return o;
  }

  _release(o) {
    if (!o) return;
    const pool = this._pools.get(o.userData.poolType);
    o.visible = false;
    this.dressingRoot.remove(o);
    if (pool) pool.free.push(o);
  }

  // ------------------------------------------------------------ set pieces
  _buildVent() {
    const g = new THREE.Group();
    const rng = makeRNG(1 + (this.rng() * 1e6) | 0);
    const stacks = 2 + (rng() * 3 | 0);
    for (let i = 0; i < stacks; i++) {
      const h = rrange(3, 11);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(rrange(0.3, 0.8), rrange(1.1, 2.2), h, 7), this.chimneyMat);
      c.position.set(rrange(-3.5, 3.5), h * 0.5, rrange(-3.5, 3.5));
      c.rotation.z = rrange(-0.16, 0.16);
      g.add(c);
      const mouth = new THREE.Mesh(new THREE.CylinderGeometry(rrange(0.3, 0.7), 0.34, 0.5, 7), this.plumeMat);
      mouth.position.set(c.position.x, h + 0.2, c.position.z);
      g.add(mouth);
      if (i === 0) { g.userData.emitter = new THREE.Object3D(); g.userData.emitter.position.copy(mouth.position); g.add(g.userData.emitter); }
    }
    const mound = new THREE.Mesh(new THREE.SphereGeometry(6, 10, 5, 0, TAU, 0, Math.PI / 2), this.darkRockMat);
    mound.scale.y = 0.32;
    g.add(mound);
    const light = new THREE.PointLight(0xff5a2a, 2.6, 26, 2);
    light.position.y = 4;
    g.add(light);
    g.userData.light = light;
    g.userData.kind = 'vent';
    return g;
  }

  _buildWreck() {
    const g = new THREE.Group();
    // A broken hull: two box sections split apart, plus a leaning mast.
    const bow = new THREE.Mesh(new THREE.BoxGeometry(7, 5, 17), this.hullMat);
    bow.position.set(0, 2.4, 9);
    bow.rotation.set(0.16, 0, 0.34);
    g.add(bow);
    const stern = new THREE.Mesh(new THREE.BoxGeometry(7.6, 5.4, 14), this.rustMat);
    stern.position.set(2.4, 2.0, -9.5);
    stern.rotation.set(-0.12, 0.34, -0.5);
    g.add(stern);
    const spine = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 8), this.rustMat);
    spine.position.set(1.0, 1.0, 0);
    spine.rotation.y = 0.18;
    g.add(spine);
    const house = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.2, 4.6), this.hullMat);
    house.position.set(2.4, 5.0, -8);
    house.rotation.set(-0.12, 0.34, -0.5);
    g.add(house);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 15, 6), this.rustMat);
    mast.position.set(-1.6, 6.5, 6);
    mast.rotation.z = 0.75;
    g.add(mast);
    const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 6, 5), this.rustMat);
    spar.rotation.set(0, 0, Math.PI / 2);
    spar.position.set(-4.4, 10.5, 6);
    g.add(spar);
    for (let i = 0; i < 4; i++) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(rrange(1.6, 4), 0.18, rrange(1.6, 4)), this.rustMat);
      plate.position.set(rrange(-9, 9), 0.2, rrange(-14, 14));
      plate.rotation.set(rrange(-0.3, 0.3), rrange(0, TAU), rrange(-0.3, 0.3));
      g.add(plate);
    }
    g.userData.kind = 'wreck';
    return g;
  }

  _buildSpire() {
    const g = new THREE.Group();
    const h = rrange(8, 30);
    const shaft = new THREE.Mesh(new THREE.ConeGeometry(rrange(1.4, 4.2), h, 6, 2), this.rockMat);
    shaft.position.y = h * 0.5;
    g.add(shaft);
    const knuckle = new THREE.Mesh(new THREE.DodecahedronGeometry(rrange(1.6, 3.4), 0), this.darkRockMat);
    knuckle.position.set(rrange(-1.5, 1.5), h * rrange(0.25, 0.6), rrange(-1.5, 1.5));
    g.add(knuckle);
    g.userData.kind = 'spire';
    return g;
  }

  _buildWorms() {
    const g = new THREE.Group();
    const n = 9 + (Math.random() * 9 | 0);
    for (let i = 0; i < n; i++) {
      const h = rrange(1.4, 4.4);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, h, 5), this.wormMat);
      tube.position.set(rrange(-3.5, 3.5), h * 0.5, rrange(-3.5, 3.5));
      tube.rotation.set(rrange(-0.22, 0.22), 0, rrange(-0.22, 0.22));
      g.add(tube);
      const plume = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.6, 5), this.plumeMat);
      plume.position.set(tube.position.x, h + 0.22, tube.position.z);
      g.add(plume);
    }
    g.userData.kind = 'worms';
    g.userData.animated = true;
    return g;
  }

  _buildWall() {
    const g = new THREE.Group();
    // Trench wall: a run of tilted slabs that reads as a cliff face.
    for (let i = 0; i < 6; i++) {
      const w = rrange(10, 24), h = rrange(24, 70), d = rrange(5, 13);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), i % 2 ? this.rockMat : this.darkRockMat);
      slab.position.set((i - 2.5) * 16 + rrange(-4, 4), h * 0.4, rrange(-6, 6));
      slab.rotation.set(rrange(-0.14, 0.14), rrange(-0.3, 0.3), rrange(-0.12, 0.12));
      g.add(slab);
    }
    g.userData.kind = 'wall';
    return g;
  }

  _buildNode() {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 0), this.nodeMat);
    core.position.y = 0.9;
    g.add(core);
    const base = new THREE.Mesh(new THREE.DodecahedronGeometry(1.5, 0), this.darkRockMat);
    base.scale.y = 0.5;
    g.add(base);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.spriteTex, color: 0x6fffe0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.85,
    }));
    halo.scale.setScalar(5);
    halo.position.y = 0.9;
    g.add(halo);
    g.userData.kind = 'node';
    g.userData.core = core;
    g.userData.animated = true;
    return g;
  }

  _buildBloom() {
    // A drifting field of bioluminescent plankton: one additive Points cloud.
    const n = 260;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rrange(-16, 16);
      pos[i * 3 + 1] = rrange(0, 16);
      pos[i * 3 + 2] = rrange(-16, 16);
      size[i] = rrange(0.4, 1.6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = new THREE.PointsMaterial({
      color: 0x6fd8ff, size: 0.9, map: this.spriteTex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      opacity: 0.8, fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    const g = new THREE.Group();
    g.add(pts);
    g.userData.kind = 'bloom';
    g.userData.points = pts;
    g.userData.animated = true;
    return g;
  }

  // ---------------------------------------------------------- point clouds
  _buildPlankton() {
    const pos = new Float32Array(PLANKTON * 3);
    for (let i = 0; i < PLANKTON; i++) {
      pos[i * 3] = rrange(-80, 80);
      pos[i * 3 + 1] = rrange(-60, 60);
      pos[i * 3 + 2] = rrange(-80, 80);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x8fe4ff, size: 0.32, map: this.spriteTex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      opacity: 0, fog: false,
    });
    this.plankton = new THREE.Points(geo, mat);
    this.plankton.frustumCulled = false;
    this.plankton.renderOrder = 5;
    this.root.add(this.plankton);
  }

  /**
   * One additive Points cloud that draws a halo on every glowing fish nearby.
   * FishSystem's standard material barely registers at 600 m; this is the
   * cheapest way to make bioluminescence read without touching it.
   */
  _buildHalos() {
    const pos = new Float32Array(MAX_HALOS * 3);
    const col = new Float32Array(MAX_HALOS * 3);
    for (let i = 0; i < MAX_HALOS; i++) pos[i * 3 + 1] = 1e6;   // parked off-world
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.4, map: this.spriteTex, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
      opacity: 0.95, fog: false,
    });
    this.halos = new THREE.Points(geo, mat);
    this.halos.frustumCulled = false;
    this.halos.renderOrder = 7;
    this.root.add(this.halos);
    this._haloCount = 0;
  }

  _buildTint() {
    const root = document.getElementById('ui-root');
    if (!root) return;
    const el = document.createElement('div');
    el.id = 'deepsea-tint';
    // z-index -1 keeps the tint above the canvas but BEHIND every HUD element
    // in #ui-root — a depth vignette must not dim the instruments.
    el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;'
      + 'transition:background-color .5s linear, opacity .5s linear;z-index:-1;'
      + 'background:radial-gradient(ellipse at center, rgba(0,0,0,0) 12%, rgba(0,3,8,.9) 96%);';
    root.appendChild(el);
    this.tintEl = el;
    const wash = document.createElement('div');
    wash.id = 'deepsea-wash';
    wash.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;'
      + 'transition:opacity .4s linear;z-index:-1;background-color:rgba(6,38,62,0);';
    root.appendChild(wash);
    this.washEl = wash;
  }

  // ---------------------------------------------------------------- update
  update(dt, game) {
    if (this._duplicate || !this.enabled || dt <= 0) return;
    const t0 = performance.now();
    const cam = game.camera;
    const wy = waterHeightAt(cam.position.x, cam.position.z);
    this.depth = Math.max(0, wy - cam.position.y);
    // Blend in over the first few metres so a splash doesn't slam the palette.
    this.blend = damp(this.blend, this.depth > 0.6 ? 1 : 0, 0.0005, dt);

    this.updateAtmosphere(dt, game);

    const active = this.blend > 0.02;
    if (this.root.visible !== active) this.root.visible = active;
    if (active) {
      this.updateDressing(dt, game);
      this.updateDeepFish(dt, game);
      this.updatePlankton(dt, game);
      this.updateHalos(dt, game);
      this.updateAmbience(dt, game);
    } else if (this._cells.size) {
      this.clearDressing();
    }
    this._budget.ms = damp(this._budget.ms, performance.now() - t0, 0.02, dt);
  }

  /** Sample the depth palette. */
  sample(depth, out = {}) {
    const stops = DEPTH_STOPS;
    let i = 0;
    while (i < stops.length - 2 && depth > stops[i + 1].d) i++;
    const a = stops[i], b = stops[i + 1];
    const t = clamp01((depth - a.d) / Math.max(1, b.d - a.d));
    out.fog = _c1.setHex(a.fog).lerp(_c2.setHex(b.fog), t).clone();
    out.density = lerp(a.density, b.density, t);
    out.light = lerp(a.light, b.light, t);
    out.shallow = _c1.setHex(a.water.shallow).lerp(_c2.setHex(b.water.shallow), t).clone();
    out.deep = _c1.setHex(a.water.deep).lerp(_c2.setHex(b.water.deep), t).clone();
    out.horizon = _c1.setHex(a.water.horizon).lerp(_c2.setHex(b.water.horizon), t).clone();
    out.tint = t < 0.5 ? a.tint : b.tint;
    out.tintAlpha = lerp(alphaOf(a.tint), alphaOf(b.tint), t);
    out.tintColor = tintRGB(t < 0.5 ? a.tint : b.tint);
    return out;
  }

  updateAtmosphere(dt, game) {
    const scene = game.scene;
    const sky = game.get('sky');
    const ocean = game.get('ocean');
    const blend = this.blend;

    // While we are not writing, Sky/Weather own the fog — keep a live copy so
    // surfacing lands back exactly where they left it.
    if (blend <= 0.02) {
      if (scene.fog) {
        this._surfaceFog.color.copy(scene.fog.color);
        this._surfaceFog.density = scene.fog.density ?? 0.0032;
      }
      if (ocean && !this._surfaceWater) this._captureWater(ocean);
      else if (ocean) this._captureWater(ocean);
      if (this.tintEl) { this.tintEl.style.opacity = '0'; this.washEl.style.opacity = '0'; }
      if (sky) { sky.__deepMul = 1; }
      return;
    }

    const p = this.sample(this.depth, this._pal || (this._pal = {}));

    // ---- fog ----
    if (scene.fog) {
      scene.fog.color.copy(this._surfaceFog.color).lerp(p.fog, blend);
      scene.fog.density = lerp(this._surfaceFog.density, p.density, blend);
    }
    if (scene.background?.isColor) scene.background.lerp(p.fog, blend);

    // ---- lights ----
    // Sky writes these absolutely every frame at order 2, so scaling them here
    // is a clean override with nothing to restore.
    if (sky) {
      const k = lerp(1, p.light, blend);
      if (sky.sun) sky.sun.intensity *= k;
      if (sky.hemi) sky.hemi.intensity *= k;
      if (sky.ambient) sky.ambient.intensity = lerp(sky.ambient.intensity, sky.ambient.intensity * k + 0.012, blend);
      if (sky.bounce) sky.bounce.intensity *= k;
      sky.__deepMul = k;
    }

    // ---- ocean shader ----
    if (ocean && this._surfaceWater) {
      const w = this._surfaceWater;
      ocean.setColors({
        shallow: _c1.copy(w.shallow).lerp(p.shallow, blend).getHex(),
        deep: _c2.copy(w.deep).lerp(p.deep, blend).getHex(),
        horizon: _c1.copy(w.horizon).lerp(p.horizon, blend).getHex(),
      });
      // Ocean.update() re-copies these from Sky every frame, so scaling them
      // here is an override, not an accumulation.
      const k = lerp(1, p.light, blend);
      ocean.uniforms.uLight.value = Math.min(ocean.uniforms.uLight.value, k);
      ocean.uniforms.uSkyColor.value.multiplyScalar(k);
      ocean.uniforms.uSunColor.value.multiplyScalar(k);
      if (ocean.skirtMat) ocean.skirtMat.color.multiplyScalar(k);
    }

    // ---- full-screen tint ----
    this._tintTimer -= dt;
    if (this.tintEl && this._tintTimer <= 0) {
      this._tintTimer = 0.12;
      const a = p.tintAlpha * blend;
      this.tintEl.style.opacity = a.toFixed(3);
      this.washEl.style.opacity = (a * 0.75).toFixed(3);
      this.washEl.style.backgroundColor = `rgba(${p.tintColor},${(0.45 * blend).toFixed(3)})`;
    }
  }

  _captureWater(ocean) {
    const u = ocean.uniforms;
    if (!this._surfaceWater) {
      this._surfaceWater = {
        shallow: new THREE.Color(), deep: new THREE.Color(), horizon: new THREE.Color(),
      };
    }
    this._surfaceWater.shallow.copy(u.uShallowColor.value);
    this._surfaceWater.deep.copy(u.uDeepColor.value);
    this._surfaceWater.horizon.copy(u.uHorizonColor.value);
  }

  // ------------------------------------------------------------- dressing
  updateDressing(dt, game) {
    // Animate what is already placed (cheap: a handful of groups).
    const t = game.time;
    for (const list of this._cells.values()) {
      for (const it of list) {
        const o = it.object;
        if (!o) continue;
        if (o.userData.kind === 'node') {
          o.userData.core.rotation.y += dt * 0.6;
          o.userData.core.position.y = 0.9 + Math.sin(t * 1.6 + it.seed) * 0.14;
        } else if (o.userData.kind === 'bloom') {
          o.rotation.y += dt * 0.04;
          o.userData.points.material.opacity = 0.45 + Math.sin(t * 0.8 + it.seed) * 0.28;
        } else if (o.userData.kind === 'worms') {
          o.rotation.z = Math.sin(t * 0.5 + it.seed) * 0.03;
        } else if (o.userData.kind === 'vent' && o.userData.light) {
          o.userData.light.intensity = 2.2 + Math.sin(t * 2.3 + it.seed) * 0.8;
        }
      }
    }

    this._dressTimer -= dt;
    if (this._dressTimer > 0) return;
    this._dressTimer = 0.34;

    const cam = game.camera;
    if (this.depth < DRESSING_DEPTH) { if (this._cells.size) this.clearDressing(); return; }

    const cx = Math.floor(cam.position.x / CELL);
    const cz = Math.floor(cam.position.z / CELL);
    const wanted = new Set();
    for (let i = -CELL_RADIUS; i <= CELL_RADIUS; i++) {
      for (let j = -CELL_RADIUS; j <= CELL_RADIUS; j++) wanted.add(`${cx + i},${cz + j}`);
    }
    // Retire cells we have left.
    for (const [key, list] of this._cells) {
      if (wanted.has(key)) continue;
      for (const it of list) { this._release(it.object); if (it.node) this._removeNode(it.node); }
      this._cells.delete(key);
    }
    // Populate at most two new cells per pass so a fast sub never hitches.
    let budget = 2;
    for (const key of wanted) {
      if (this._cells.has(key)) continue;
      if (budget-- <= 0) break;
      this._cells.set(key, this.populateCell(key));
    }
  }

  populateCell(key) {
    const [ix, iz] = key.split(',').map(Number);
    const out = [];
    const h = hash2(ix * 7919, iz * 104729);
    const count = h < 0.28 ? 0 : h < 0.62 ? 1 : h < 0.88 ? 2 : 3;
    for (let k = 0; k < count; k++) {
      const r1 = hash2(ix * 31 + k * 977, iz * 17 + k * 613);
      const r2 = hash2(ix * 613 + k * 31, iz * 977 + k * 17);
      const r3 = hash2(ix * 97 + k * 41, iz * 41 + k * 97);
      const x = (ix + r1) * CELL;
      const z = (iz + r2) * CELL;
      const bed = worldHeight(x, z);
      const surf = waterHeightAt(x, z);
      if (surf - bed < DRESSING_DEPTH * 0.7) continue;

      // Genuinely steep ground can carry a trench wall, but only sometimes —
      // a bare slope test turns the whole trench into cliff faces.
      const slope = Math.abs(worldHeight(x + 26, z) - worldHeight(x - 26, z))
        + Math.abs(worldHeight(x, z + 26) - worldHeight(x, z - 26));
      const type = (slope > 120 && r3 < 0.34) ? 'wall'
        : r3 < 0.20 ? 'vent'
          : r3 < 0.30 ? 'wreck'
            : r3 < 0.50 ? 'spire'
              : r3 < 0.66 ? 'worms'
                : r3 < 0.82 ? 'bloom'
                  : 'node';

      const o = this._acquire(type);
      if (!o) continue;
      const scale = type === 'wall' ? 1 : lerp(0.7, 1.7, r3);
      o.position.set(x, bed + (type === 'bloom' ? 6 : 0), z);
      o.rotation.set(0, r1 * TAU, 0);
      o.scale.setScalar(scale);
      const item = { object: o, seed: r1 * 10, type };
      if (type === 'node') {
        item.node = {
          id: `${key}:${k}`, position: o.position.clone().setY(o.position.y + 0.9),
          name: rpick(NODE_KINDS), value: Math.round(lerp(2400, 42000, r2 * r3 + r1 * 0.3)),
          object: o,
        };
        this.nodes.push(item.node);
      }
      if (type === 'vent' && o.userData.emitter) {
        item.vent = o.userData.emitter;
        item.steamTimer = r1 * 2;
      }
      out.push(item);
    }
    return out;
  }

  clearDressing() {
    for (const list of this._cells.values()) {
      for (const it of list) { this._release(it.object); if (it.node) this._removeNode(it.node); }
    }
    this._cells.clear();
  }

  _removeNode(node) {
    const i = this.nodes.indexOf(node);
    if (i >= 0) this.nodes.splice(i, 1);
  }

  /**
   * Called by SubSystem's manipulator: grab the nearest resource node in front
   * of the camera. Returns `{name, value}` or null.
   */
  collectNodeNear(origin, dir, range) {
    let best = null, bestScore = -1;
    for (const n of this.nodes) {
      const d = n.position.distanceTo(origin);
      if (d > range + 2) continue;
      _v.copy(n.position).sub(origin);
      if (_v.lengthSq() < 1e-6) continue;
      const facing = _v.normalize().dot(dir);
      if (facing < 0.15) continue;
      const score = facing * 2 - d * 0.05;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (!best) return null;
    // Hide the node and forget it; the cell will not re-place it while loaded.
    for (const list of this._cells.values()) {
      for (const it of list) {
        if (it.node === best) { this._release(it.object); it.object = null; it.node = null; }
      }
    }
    this._removeNode(best);
    bus.emit('fx:sparkle', { position: best.position.clone(), color: 0x6fffe0 });
    return { name: best.name, value: best.value, position: best.position };
  }

  // ------------------------------------------------------------ deep fauna
  /**
   * FishSystem only ever spawns within 140 m of the surface, so below that the
   * ocean is completely empty. Seed the real deep species around the camera
   * through its public `spawnSpecific` API and let its own AI take over.
   */
  updateDeepFish(dt, game) {
    if (this.depth < 120) { this._deepFish.length = 0; return; }
    this._fishTimer -= dt;
    if (this._fishTimer > 0) return;
    this._fishTimer = 1.1;

    const fishSys = game.get('fish');
    if (!fishSys || !fishSys.spawnSpecific) return;
    const cam = game.camera;

    // Drop anything that wandered off or was collected.
    for (let i = this._deepFish.length - 1; i >= 0; i--) {
      const f = this._deepFish[i];
      if (!f.active || f.position.distanceToSquared(cam.position) > 190 * 190) this._deepFish.splice(i, 1);
    }
    const target = game.quality === 'low' ? 6 : game.quality === 'medium' ? 10 : 15;
    if (this._deepFish.length >= target) return;

    const region = regionAt(cam.position.x, cam.position.z)?.id || null;
    const pool = speciesForHabitat(DEEP_HABITATS, this.depth, { region, junk: false, bosses: false });
    if (!pool.length) return;
    const sky = game.get('sky');
    const night = sky?.isNight;
    const cands = pool.map((sp) => {
      let w = sp.spawnWeight;
      if (sp.time === 'night' && !night) w *= 0.45;
      if (sp.time === 'day' && night) w *= 0.45;
      return { sp, weight: Math.max(0.01, w) };
    });

    const batch = Math.min(3, target - this._deepFish.length);
    for (let i = 0; i < batch; i++) {
      const pick = weightedPick(cands, this.rng)?.sp;
      if (!pick) break;
      const a = this.rng() * TAU;
      const r = lerp(26, 72, this.rng());
      const x = cam.position.x + Math.cos(a) * r;
      const z = cam.position.z + Math.sin(a) * r;
      const bed = worldHeight(x, z);
      const surf = waterHeightAt(x, z);
      const y = clamp(cam.position.y + rrange(-18, 18), bed + 2.5, surf - 2);
      if (surf - y < 60) continue;
      const made = fishSys.spawnSpecific({ speciesId: pick.id, x, y, z, count: 1 });
      for (const f of made) this._deepFish.push(f);
    }
  }

  // ------------------------------------------------------------- particles
  updatePlankton(dt, game) {
    if (!this.plankton) return;
    const cam = game.camera;
    // Snap to a coarse grid so the field feels like world space, not a helmet.
    const snap = 24;
    this.plankton.position.set(
      Math.round(cam.position.x / snap) * snap,
      Math.round(cam.position.y / snap) * snap,
      Math.round(cam.position.z / snap) * snap,
    );
    const vis = clamp01((this.depth - 60) / 220) * this.blend;
    this.plankton.material.opacity = vis * (this.game.quality === 'low' ? 0.28 : 0.55);
    this.plankton.visible = vis > 0.01;
  }

  updateHalos(dt, game) {
    this._haloTimer -= dt;
    if (this._haloTimer > 0) return;
    this._haloTimer = 1 / 12;
    const fishSys = game.get('fish');
    const geo = this.halos.geometry;
    const pos = geo.attributes.position.array;
    const col = geo.attributes.color.array;
    let n = 0;
    const dark = clamp01((this.depth - 40) / 180);
    if (fishSys && dark > 0.01) {
      const cam = game.camera;
      for (const f of fishSys.active) {
        if (n >= MAX_HALOS) break;
        const sp = f.species;
        if (!sp || (sp.glow || 0) < 0.06) continue;
        const d2 = f.position.distanceToSquared(cam.position);
        if (d2 > 160 * 160) continue;
        pos[n * 3] = f.position.x;
        pos[n * 3 + 1] = f.position.y;
        pos[n * 3 + 2] = f.position.z;
        const c = _c1.set(sp.colors?.accent || sp.colors?.main || '#7fe8ff');
        const k = clamp01(sp.glow) * dark;
        col[n * 3] = c.r * k; col[n * 3 + 1] = c.g * k; col[n * 3 + 2] = c.b * k;
        n++;
      }
    }
    for (let i = n; i < this._haloCount; i++) { pos[i * 3 + 1] = 1e6; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; }
    this._haloCount = n;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, Math.max(1, n));
    this.halos.visible = n > 0;
  }

  // -------------------------------------------------------------- ambience
  updateAmbience(dt, game) {
    // Vent steam: only for vents actually near the camera.
    const cam = game.camera;
    for (const list of this._cells.values()) {
      for (const it of list) {
        if (!it.vent) continue;
        it.steamTimer -= dt;
        if (it.steamTimer > 0) continue;
        it.steamTimer = rrange(0.5, 1.4);
        it.vent.getWorldPosition(_v);
        if (_v.distanceToSquared(cam.position) > 90 * 90) { it.steamTimer = 3; continue; }
        bus.emit('fx:steam', { position: _v.clone(), scale: 2.2, color: 0x30202a });
      }
    }

    if (this.depth < 120) return;

    // Hull creaks and things that are almost certainly nothing.
    this._ambTimer -= dt;
    if (this._ambTimer <= 0) {
      this._ambTimer = rrange(11, 34) * (this.depth > 800 ? 0.6 : 1);
      const deep = clamp01((this.depth - 200) / 1400);
      const roll = Math.random();
      if (roll < 0.4) {
        game.audio?.play('sub_creak', { volume: 0.16 + deep * 0.3, rate: rrange(0.6, 0.85) });
      } else if (roll < 0.62) {
        game.audio?.play('underwater_whoosh', { volume: 0.2 + deep * 0.25, rate: rrange(0.5, 0.8) });
      } else if (roll < 0.82) {
        game.audio?.play('bubbles', { volume: 0.22, rate: rrange(0.7, 1.2) });
      } else if (deep > 0.25) {
        // Something a long way off, and much larger than you.
        game.audio?.play('boss_roar', { volume: 0.1 + deep * 0.16, rate: rrange(0.32, 0.5) });
        if (game.settings.subtitles) {
          bus.emit('toast', { text: rpick(DEEP_WHISPERS), kind: 'muted', duration: 5200 });
        }
      }
    }

    // Phantom sonar returns.
    this._ghostTimer -= dt;
    if (this._ghostTimer <= 0) {
      this._ghostTimer = rrange(14, 40);
      this.ghostContacts.length = 0;
      const n = this.depth > 900 ? 3 : this.depth > 400 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        if (!rchance(0.55)) continue;
        const a = Math.random() * TAU;
        const r = rrange(25, 160);
        this.ghostContacts.push({
          x: cam.position.x + Math.cos(a) * r,
          y: cam.position.y + rrange(-60, 40),
          z: cam.position.z + Math.sin(a) * r,
        });
      }
    }
  }

  /** Dev/debug read-out — how much of the frame this system is costing. */
  get costMs() { return this._budget.ms; }

  // No save()/load(): everything here is presentation derived from depth, so
  // there is nothing worth writing into the save file.
}

// --------------------------------------------------------------------------
const NODE_KINDS = [
  'a manganese nodule cluster', 'a rare-earth crust sample', 'a methane hydrate core',
  'a polymetallic sulphide chimney fragment', 'a vent-bacteria culture', 'a cobalt crust plate',
];

const DEEP_WHISPERS = [
  'Sonar: unidentified contact, bearing unclear.',
  'Hydrophone picked something up. It did not repeat.',
  'That was not the hull.',
  'Contact lost. It was very large and it was not moving like water.',
  'The scope drew something for one sweep and then stopped.',
];

function alphaOf(rgba) {
  const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/.exec(rgba);
  return m ? parseFloat(m[1]) : 1;
}
function tintRGB(rgba) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(rgba);
  return m ? `${Math.round(+m[1])},${Math.round(+m[2])},${Math.round(+m[3])}` : '0,0,0';
}

/** 64px radial gradient used by every additive sprite in this file. */
function makeGlowTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.65)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
