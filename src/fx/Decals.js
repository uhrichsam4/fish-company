import * as THREE from 'three';
import { GERSTNER_GLSL, waveState } from '../world/waves.js';
import { ATLAS_COLS } from './spriteAtlas.js';

/**
 * Water-hugging ring / patch decals (ripples, splash foam, lingering slicks).
 *
 * Technique: instanced subdivided quads whose vertices are pushed through the
 * SAME Gerstner GLSL the ocean shader uses (imported from world/waves.js), so a
 * foam ring sits exactly on the rendered wave surface instead of clipping
 * through a crest. Expansion, spin and fade are all closed-form in the vertex
 * shader — the CPU writes 15 floats per decal at spawn and never touches it
 * again.
 */

const SEG = 8;   // quad subdivisions; enough to follow a wave crest smoothly

const VERT = /* glsl */`
${GERSTNER_GLSL}

attribute vec3 iCenter;   // x, lift, z
attribute vec4 iSpan;     // birth, life, r0, r1
attribute vec4 iCol;      // rgb + alpha
attribute vec4 iOpt;      // tile, spin, alphaPow, growPow

uniform float uFxTime;
uniform float uSeaLevel;
uniform float uOpacity;

varying vec2 vUv;
varying vec4 vColor;

void main() {
  float life = max(0.0001, iSpan.y);
  float age = uFxTime - iSpan.x;
  float t = age / life;
  if (age < 0.0 || t > 1.0) {
    vColor = vec4(0.0); vUv = vec2(0.0);
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float r = mix(iSpan.z, iSpan.w, pow(t, max(0.05, iOpt.w)));
  float ang = iOpt.y * age;
  float ca = cos(ang), sa = sin(ang);
  vec2 local = position.xy * (2.0 * r);
  local = vec2(local.x * ca - local.y * sa, local.x * sa + local.y * ca);
  vec2 world = iCenter.xz + local;

  vec3 tanv, binv;
  vec3 disp = gerstner(world, tanv, binv);
  vec3 p = vec3(world.x + disp.x, uSeaLevel + disp.y + iCenter.y, world.y + disp.z);

  float a = iCol.a * pow(max(0.0, 1.0 - t), max(0.05, iOpt.z)) * smoothstep(0.0, 0.05, t);
  vColor = vec4(iCol.rgb, a * uOpacity);

  float col = mod(iOpt.x, ${ATLAS_COLS}.0);
  float row = floor(iOpt.x / ${ATLAS_COLS}.0);
  vUv = vec2(col + uv.x, (${ATLAS_COLS}.0 - 1.0 - row) + uv.y) / ${ATLAS_COLS}.0;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  if (vColor.a <= 0.0) discard;
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.006) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, a);
  #include <colorspace_fragment>
}
`;

const _col = new THREE.Color();

export class WaterDecals {
  constructor({ capacity = 64, texture, additive = false, name = 'fx-decals' } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;

    // Copy (don't share) the base plane's buffers so disposing either geometry
    // can never yank the other's GPU resources.
    const src = new THREE.PlaneGeometry(1, 1, SEG, SEG);
    const geo = this.geometry = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(src.getAttribute('position').array), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(src.getAttribute('uv').array), 2));
    geo.setIndex(new THREE.BufferAttribute(Uint16Array.from(src.getIndex().array), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    src.dispose();

    this.arrays = {}; this.attrs = {};
    const add = (nm, size) => {
      const arr = new Float32Array(capacity * size);
      const at = new THREE.InstancedBufferAttribute(arr, size);
      at.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(nm, at);
      this.arrays[nm] = arr; this.attrs[nm] = at;
    };
    add('iCenter', 3); add('iSpan', 4); add('iCol', 4); add('iOpt', 4);
    geo.instanceCount = capacity;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uFxTime: { value: 0 },
        uTime: { value: 0 },                 // gerstner clock (waveState.time)
        uAmplitude: { value: 1 },
        uWaves: { value: waveState.waves.map((w) => new THREE.Vector4(w[0], w[1], w[2], w[3])) },
        uSeaLevel: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * @param {number} x @param {number} z
   * @param {{r0,r1,life,col,alpha,alphaPow,tile,spin,lift,growPow}} o
   */
  spawn(x, z, o, now) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const a = this.arrays;
    let k = i * 3;
    a.iCenter[k] = x; a.iCenter[k + 1] = o.lift ?? 0.045; a.iCenter[k + 2] = z;
    k = i * 4;
    a.iSpan[k] = now; a.iSpan[k + 1] = o.life ?? 1;
    a.iSpan[k + 2] = o.r0 ?? 0.2; a.iSpan[k + 3] = o.r1 ?? 2;
    if (o.col?.isColor) _col.copy(o.col); else _col.set(o.col ?? 0xffffff);
    a.iCol[k] = _col.r; a.iCol[k + 1] = _col.g; a.iCol[k + 2] = _col.b; a.iCol[k + 3] = o.alpha ?? 1;
    a.iOpt[k] = o.tile ?? 0; a.iOpt[k + 1] = o.spin ?? 0;
    a.iOpt[k + 2] = o.alphaPow ?? 1; a.iOpt[k + 3] = o.growPow ?? 0.55;
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
  }

  flush() {
    if (this._dirtyHi < 0) return;
    const lo = this._dirtyLo, count = this._dirtyHi - lo + 1;
    for (const key in this.attrs) {
      const at = this.attrs[key];
      at.clearUpdateRanges();
      at.addUpdateRange(lo * at.itemSize, count * at.itemSize);
      at.needsUpdate = true;
    }
    this._dirtyLo = Infinity; this._dirtyHi = -1;
  }

  update(fxTime) {
    const u = this.material.uniforms;
    u.uFxTime.value = fxTime;
    u.uTime.value = waveState.time;
    u.uAmplitude.value = waveState.amplitude;
    u.uSeaLevel.value = waveState.seaLevel;
    const w = u.uWaves.value;
    for (let i = 0; i < 4; i++) {
      const s = waveState.waves[i];
      if (s) w[i].set(s[0], s[1], s[2], s[3]);
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
