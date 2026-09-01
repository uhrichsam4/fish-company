import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { bus } from './EventBus.js';

/**
 * Loads textures / models / audio with graceful procedural fallbacks so the
 * game is always playable even when an asset 404s.
 */
export class AssetManager {
  constructor(renderer) {
    this.renderer = renderer;
    this.textures = new Map();
    this.materials = new Map();
    this.models = new Map();
    this.audio = new Map();
    this.pending = 0;
    this.loaded = 0;
    this.failed = [];
    this.maxAniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;

    this.texLoader = new THREE.TextureLoader();
    this.gltf = new GLTFLoader();
    try {
      const draco = new DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      this.gltf.setDRACOLoader(draco);
    } catch { /* draco optional */ }

    this._procCache = new Map();
  }

  _progress(label) {
    bus.emit('assets:progress', { loaded: this.loaded, pending: this.pending, label });
  }

  /**
   * @param {string} url
   * @param {object} [opt] {srgb, repeat:[x,y], fallback:'noise'|'flat'|'normal', anisotropy}
   * @returns {THREE.Texture} — returns immediately; pixels fill in when loaded.
   */
  texture(url, opt = {}) {
    const key = url + JSON.stringify(opt.repeat || '');
    if (this.textures.has(key)) return this.textures.get(key);

    // Start with a procedural placeholder so nothing is ever black/undefined.
    const tex = this.procedural(opt.fallback || 'flat', opt);
    tex.name = url;
    this.textures.set(key, tex);
    this.pending++;

    this.texLoader.load(
      url,
      (loaded) => {
        tex.image = loaded.image;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        if (opt.repeat) tex.repeat.set(opt.repeat[0], opt.repeat[1]);
        tex.colorSpace = opt.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        if (opt.linear) tex.colorSpace = THREE.NoColorSpace;
        tex.anisotropy = opt.anisotropy ?? this.maxAniso;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        this.loaded++; this._progress(url);
      },
      undefined,
      () => {
        this.failed.push(url);
        this.loaded++; this._progress(url);
        console.warn('[Assets] texture missing, using procedural:', url);
      },
    );
    return tex;
  }

  /** Procedurally generated stand-in textures. Cached by kind. */
  procedural(kind, opt = {}) {
    const cacheKey = kind + (opt.color || '');
    if (this._procCache.has(cacheKey) && !opt.unique) {
      const src = this._procCache.get(cacheKey);
      const t = src.clone();
      t.needsUpdate = true;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      if (opt.repeat) t.repeat.set(opt.repeat[0], opt.repeat[1]);
      return t;
    }
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');

    if (kind === 'normal') {
      g.fillStyle = '#8080ff'; g.fillRect(0, 0, size, size);
    } else if (kind === 'noise') {
      const img = g.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const v = 150 + Math.floor(Math.random() * 60);
        img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    } else if (kind === 'checker') {
      const s = size / 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        g.fillStyle = (x + y) % 2 ? '#c8c8c8' : '#909090';
        g.fillRect(x * s, y * s, s, s);
      }
    } else if (kind === 'white') {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
    } else {
      g.fillStyle = opt.color || '#9aa0a6'; g.fillRect(0, 0, size, size);
      // subtle grain so flat placeholders don't look like plastic
      g.globalAlpha = 0.06;
      for (let i = 0; i < 900; i++) {
        g.fillStyle = Math.random() > 0.5 ? '#000' : '#fff';
        g.fillRect(Math.random() * size, Math.random() * size, 2, 2);
      }
      g.globalAlpha = 1;
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = (kind === 'normal' || opt.linear) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.anisotropy = this.maxAniso;
    if (opt.repeat) tex.repeat.set(opt.repeat[0], opt.repeat[1]);
    if (!opt.unique) this._procCache.set(cacheKey, tex);
    return tex;
  }

  /**
   * Build a MeshStandardMaterial from a manifest entry.
   * @param {string} name key into MATERIALS manifest
   * @param {object} def  {color,normal,rough,repeat}
   * @param {object} over material overrides
   */
  material(name, def, over = {}) {
    const key = name + JSON.stringify(over);
    if (this.materials.has(key)) return this.materials.get(key);
    const repeat = over.repeat || def?.repeat || [4, 4];
    const params = {
      roughness: over.roughness ?? 0.9,
      metalness: over.metalness ?? 0.02,
      color: over.color ?? 0xffffff,
      ...over.extra,
    };
    if (def?.color) params.map = this.texture(def.color, { repeat, srgb: true, fallback: 'flat' });
    if (def?.normal) {
      params.normalMap = this.texture(def.normal, { repeat, linear: true, fallback: 'normal' });
      params.normalScale = new THREE.Vector2(over.normalScale ?? 0.8, over.normalScale ?? 0.8);
    }
    if (def?.rough) {
      params.roughnessMap = this.texture(def.rough, { repeat, linear: true, fallback: 'white' });
    }
    const mat = new THREE.MeshStandardMaterial(params);
    mat.name = name;
    this.materials.set(key, mat);
    return mat;
  }

  /** @returns {Promise<THREE.Group|null>} */
  async model(url) {
    if (this.models.has(url)) return this.models.get(url);
    this.pending++;
    const p = new Promise((resolve) => {
      this.gltf.load(url,
        (g) => { this.loaded++; this._progress(url); resolve(g); },
        undefined,
        () => {
          this.failed.push(url); this.loaded++; this._progress(url);
          console.warn('[Assets] model missing:', url);
          resolve(null);
        });
    });
    this.models.set(url, p);
    return p;
  }

  /** Returns a fresh clone of a loaded model's scene, or null. */
  async instance(url) {
    const g = await this.model(url);
    if (!g?.scene) return null;
    const clone = g.scene.clone(true);
    clone.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return clone;
  }

  stats() {
    return { textures: this.textures.size, models: this.models.size, failed: this.failed.length, failedList: this.failed.slice(0, 20) };
  }
}
