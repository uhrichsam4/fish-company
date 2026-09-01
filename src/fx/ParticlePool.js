import * as THREE from 'three';
import { ATLAS_COLS } from './spriteAtlas.js';

/**
 * ============================ TECHNIQUE NOTES ==============================
 *
 * `SpriteParticles` (this file's workhorse) simulates entirely in the VERTEX
 * SHADER from per-particle spawn attributes. The CPU touches a particle exactly
 * once — at spawn — writing ~27 floats into a ring buffer and flagging a partial
 * attribute upload. After that the particle costs zero CPU: position, size,
 * colour, rotation, stretch and the whole alpha envelope are closed-form
 * functions of `uTime - birth`. That is what makes 4000 live sprites free, and
 * it is why splashes/spray/bubbles/rain all use it.
 *
 * It draws INSTANCED BILLBOARD QUADS rather than THREE.Points. gl_PointSize is
 * capped by the driver (often 255 px), point sprites pop out of view when their
 * centre leaves the frustum, and they cannot be rotated or stretched. Quads
 * cost 4 verts instead of 1 — irrelevant at these counts — and buy us
 * velocity-stretched rain streaks, tumbling coins and huge close-up fireballs.
 *
 * `DebrisPool` is deliberately the opposite: CPU-simulated instanced *meshes*.
 * Impact chips are low-volume (a dozen per hit), need to bounce off the surface
 * they were spawned on and read best as chunky faceted solids that catch a
 * silhouette. Analytic shader motion cannot bounce, so these are integrated on
 * the CPU — cheap because the pool is capped at a few hundred.
 *
 * `VolumeParticles` is the weather/motes volume: a fixed instance count that
 * WRAPS around the camera in the vertex shader (mod into a box), so rain, snow
 * and underwater motes are one draw call each with no CPU work at all.
 * ===========================================================================
 */

// A unit quad centred on the origin, shared by every instanced sprite system.
function baseQuad() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  // Never culled: everything is displaced in the vertex shader.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/** Fields a caller fills before `spawn()`. Reused — never allocate a spawn descriptor. */
export function makeSpawnDesc() {
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    life: 1, size: 1, size2: 1, sizePow: 1,
    drag: 0.8, grav: 0,
    /** colour start / end, sRGB hex or THREE.Color */
    col: 0xffffff, col2: 0xffffff, alpha: 1, alpha2: 1, alphaPow: 1,
    tile: 0,
    /** >0 elongates along velocity (rain, droplets); <0 = coin-flip squash amount */
    stretch: 0,
    turb: 0, fadeIn: 0.05,
    /** 1 = dissolve below the water plane, -1 = dissolve above it, 0 = ignore */
    water: 0,
    rot: 0, spin: 0,
    /** seconds to wait before the particle appears — free stagger, the shader
     *  simply treats a negative age as "not born yet". */
    delay: 0,
  };
}

const DEFAULTS = makeSpawnDesc();
export function resetDesc(d) { Object.assign(d, DEFAULTS); return d; }

const _c = new THREE.Color();

const SPRITE_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iLife;   // birth, life, seed, spin
attribute vec4 iSize;   // size0, size1, drag, gravity
attribute vec4 iColA;   // rgb + alpha at birth
attribute vec4 iColB;   // rgb + alpha at death
attribute vec4 iOpt;    // tile, stretch, turbulence, fadeIn
attribute vec4 iOpt2;   // waterMode, alphaPow, rot0, sizePow

uniform float uTime;
uniform float uWaterY;
uniform float uOpacity;
uniform float uFogDensity;

varying vec2 vUv;
varying vec4 vColor;
varying float vFog;

void main() {
  float life = max(0.0001, iLife.y);
  float age  = uTime - iLife.x;
  float t    = age / life;

  if (age < 0.0 || t > 1.0) {
    vColor = vec4(0.0); vUv = vec2(0.0); vFog = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // outside the clip volume
    return;
  }

  float seed = iLife.z;

  // ---- closed-form ballistic motion with linear drag ----
  float k = iSize.z;
  float decay = exp(-k * age);
  float f = (k > 0.0001) ? (1.0 - decay) / k : age;
  vec3 p = iPos + iVel * f;
  p.y += 0.5 * iSize.w * age * age;

  float turb = iOpt.z;
  if (turb > 0.0) {
    float ph = seed * 6.2831853;
    p += (turb * age) * vec3(sin(age * 2.7 + ph), sin(age * 1.9 + ph * 1.7), cos(age * 2.3 + ph * 0.6));
  }

  float sz = mix(iSize.x, iSize.y, pow(t, max(0.05, iOpt2.w)));

  float a = mix(iColA.a, iColB.a, t);
  a *= smoothstep(0.0, max(1e-4, iOpt.w), t);
  a *= pow(max(0.0, 1.0 - t), max(0.05, iOpt2.y));
  float wm = iOpt2.x;
  if (wm > 0.5)       a *= smoothstep(uWaterY - 0.30, uWaterY + 0.04, p.y);
  else if (wm < -0.5) a *= 1.0 - smoothstep(uWaterY - 0.06, uWaterY + 0.22, p.y);
  vColor = vec4(mix(iColA.rgb, iColB.rgb, pow(t, 0.65)), a * uOpacity);

  float tile = iOpt.x;
  float col = mod(tile, ${ATLAS_COLS}.0);
  float row = floor(tile / ${ATLAS_COLS}.0);
  vUv = vec2(col + uv.x, (${ATLAS_COLS}.0 - 1.0 - row) + uv.y) / ${ATLAS_COLS}.0;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 corner = position.xy;
  float stretch = iOpt.y;

  if (stretch > 0.001) {
    vec3 vel = iVel * decay + vec3(0.0, iSize.w * age, 0.0);
    vec3 mvv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
    float sp = length(mvv.xy);
    vec2 dir = (sp > 1e-4) ? mvv.xy / sp : vec2(0.0, 1.0);
    float elong = 1.0 + stretch * min(sp * 0.10, 6.0);
    mv.xy += dir * (corner.y * sz * elong) + vec2(dir.y, -dir.x) * (corner.x * sz);
  } else {
    // stretch < 0 overloads as a "coin flip": squash X on a cosine.
    float flip = (stretch < -0.001) ? mix(1.0, abs(cos(age * iLife.w)), -stretch) : 1.0;
    float ang = iOpt2.z + iLife.w * age;
    float ca = cos(ang), sa = sin(ang);
    vec2 c2 = vec2(corner.x * flip, corner.y);
    mv.xy += vec2(c2.x * ca - c2.y * sa, c2.x * sa + c2.y * ca) * sz;
  }

  float d = -mv.z;
  float fd = uFogDensity * d;
  vFog = 1.0 - exp(-fd * fd);
  gl_Position = projectionMatrix * mv;
}
`;

const SPRITE_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uFogColor;
varying vec2 vUv;
varying vec4 vColor;
varying float vFog;

void main() {
  if (vColor.a <= 0.0) discard;
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.006) discard;
  vec3 rgb = vColor.rgb * tex.rgb;
  #ifdef FX_ADDITIVE
    rgb *= (1.0 - vFog);
  #else
    rgb = mix(rgb, uFogColor, vFog);
  #endif
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}
`;

/**
 * Ring-buffered instanced billboard particles, simulated on the GPU.
 * The ring buffer IS the hard cap: spawning past capacity recycles the oldest.
 */
export class SpriteParticles {
  /**
   * @param {{capacity:number, texture:THREE.Texture, additive?:boolean, name?:string, renderOrder?:number}} o
   */
  constructor(o) {
    const n = this.capacity = o.capacity;
    this.additive = !!o.additive;
    this.cursor = 0;
    this.spawned = 0;
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;

    const geo = this.geometry = baseQuad();
    this.arrays = {};
    const add = (name, itemSize) => {
      const arr = new Float32Array(n * itemSize);
      const attr = new THREE.InstancedBufferAttribute(arr, itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, attr);
      this.arrays[name] = arr;
      return attr;
    };
    this.attrs = {
      iPos: add('iPos', 3), iVel: add('iVel', 3),
      iLife: add('iLife', 4), iSize: add('iSize', 4),
      iColA: add('iColA', 4), iColB: add('iColB', 4),
      iOpt: add('iOpt', 4), iOpt2: add('iOpt2', 4),
    };
    // Life 0 for everything -> nothing is drawn until spawned.
    geo.instanceCount = n;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: o.texture },
        uTime: { value: 0 },
        uWaterY: { value: 0 },
        uOpacity: { value: 1 },
        uFogColor: { value: new THREE.Color(0x9fd0e8) },
        uFogDensity: { value: 0.0 },
      },
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      defines: this.additive ? { FX_ADDITIVE: 1 } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: this.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = o.name || (this.additive ? 'fx-sprites-add' : 'fx-sprites-alpha');
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder ?? (this.additive ? 12 : 10);
    this.mesh.matrixAutoUpdate = false;
  }

  /** @param {ReturnType<makeSpawnDesc>} d @param {number} now */
  spawn(d, now) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.spawned++;
    const a = this.arrays;
    let o = i * 3;
    a.iPos[o] = d.x; a.iPos[o + 1] = d.y; a.iPos[o + 2] = d.z;
    a.iVel[o] = d.vx; a.iVel[o + 1] = d.vy; a.iVel[o + 2] = d.vz;
    o = i * 4;
    a.iLife[o] = now + d.delay; a.iLife[o + 1] = d.life; a.iLife[o + 2] = Math.random(); a.iLife[o + 3] = d.spin;
    a.iSize[o] = d.size; a.iSize[o + 1] = d.size2; a.iSize[o + 2] = d.drag; a.iSize[o + 3] = d.grav;
    if (d.col.isColor) _c.copy(d.col); else _c.set(d.col);
    a.iColA[o] = _c.r; a.iColA[o + 1] = _c.g; a.iColA[o + 2] = _c.b; a.iColA[o + 3] = d.alpha;
    if (d.col2.isColor) _c.copy(d.col2); else _c.set(d.col2);
    a.iColB[o] = _c.r; a.iColB[o + 1] = _c.g; a.iColB[o + 2] = _c.b; a.iColB[o + 3] = d.alpha2;
    a.iOpt[o] = d.tile; a.iOpt[o + 1] = d.stretch; a.iOpt[o + 2] = d.turb; a.iOpt[o + 3] = d.fadeIn;
    a.iOpt2[o] = d.water; a.iOpt2[o + 1] = d.alphaPow; a.iOpt2[o + 2] = d.rot; a.iOpt2[o + 3] = d.sizePow;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    return i;
  }

  /** Uploads only the slots written since the last flush. */
  flush() {
    if (this._dirtyHi < 0) return;
    const lo = this._dirtyLo, count = this._dirtyHi - lo + 1;
    for (const key in this.attrs) {
      const attr = this.attrs[key];
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * attr.itemSize, count * attr.itemSize);
      attr.needsUpdate = true;
    }
    this._dirtyLo = Infinity; this._dirtyHi = -1;
  }

  setTime(t) { this.material.uniforms.uTime.value = t; }
  setWaterY(y) { this.material.uniforms.uWaterY.value = y; }
  setFog(color, density) {
    this.material.uniforms.uFogColor.value.copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// CPU debris — chunky faceted chips that bounce off the surface they hit
// ---------------------------------------------------------------------------

/** Irregular faceted shard with per-face brightness baked into vertex colours,
 *  so debris reads as a solid 3D chip under any (or no) scene lighting. */
function shardGeometry() {
  const pts = [
    [0, 0.62, 0], [0.55, 0.1, 0.28], [-0.12, 0.16, 0.6], [-0.58, 0.08, -0.1],
    [0.1, 0.06, -0.62], [0.02, -0.55, 0.05],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
    [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4],
  ];
  const pos = new Float32Array(faces.length * 9);
  const col = new Float32Array(faces.length * 9);
  const shade = [1.0, 0.92, 0.8, 0.86, 0.6, 0.52, 0.45, 0.55];
  let p = 0;
  faces.forEach((f, fi) => {
    const s = shade[fi % shade.length];
    for (const vi of f) {
      pos[p] = pts[vi][0]; pos[p + 1] = pts[vi][1]; pos[p + 2] = pts[vi][2];
      col[p] = s; col[p + 1] = s; col[p + 2] = s;
      p += 3;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const _m4 = new THREE.Matrix4();
const _qq = new THREE.Quaternion();
const _ee = new THREE.Euler();
const _sv = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class DebrisPool {
  constructor({ capacity = 240, name = 'fx-debris' } = {}) {
    this.capacity = capacity;
    this.cursor = 0;
    this.live = 0;
    this.geometry = shardGeometry();
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = capacity;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const n = capacity;
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.rot = new Float32Array(n * 3);
    this.spin = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);      // 0 == dead
    this.size = new Float32Array(n * 3);
    this.floor = new Float32Array(n);
    this.bounce = new Float32Array(n);
    this.waterKill = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, _ZERO);
  }

  spawn(d) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    // Recycling a slot that is still alive must not inflate the live counter.
    if (this.life[i] <= 0) this.live++;
    const i3 = i * 3;
    this.p[i3] = d.x; this.p[i3 + 1] = d.y; this.p[i3 + 2] = d.z;
    this.v[i3] = d.vx; this.v[i3 + 1] = d.vy; this.v[i3 + 2] = d.vz;
    this.rot[i3] = Math.random() * 6.28; this.rot[i3 + 1] = Math.random() * 6.28; this.rot[i3 + 2] = Math.random() * 6.28;
    const sp = d.spin ?? 8;
    this.spin[i3] = (Math.random() * 2 - 1) * sp;
    this.spin[i3 + 1] = (Math.random() * 2 - 1) * sp;
    this.spin[i3 + 2] = (Math.random() * 2 - 1) * sp;
    this.age[i] = 0;
    this.life[i] = d.life ?? 1.2;
    const s = d.size ?? 0.1;
    this.size[i3] = s * (0.7 + Math.random() * 0.6);
    this.size[i3 + 1] = s * (0.7 + Math.random() * 0.6);
    this.size[i3 + 2] = s * (0.7 + Math.random() * 0.6);
    this.floor[i] = d.floorY ?? -1e9;
    this.bounce[i] = d.bounce ?? 0.35;
    this.waterKill[i] = d.water ? 1 : 0;
    if (d.col !== undefined) {
      if (d.col.isColor) _c.copy(d.col); else _c.set(d.col);
      const j = Math.random() * 0.28 + 0.86;
      this.mesh.instanceColor.setXYZ(i, _c.r * j, _c.g * j, _c.b * j);
      this.mesh.instanceColor.needsUpdate = true;
    }
    return i;
  }

  update(dt, waterY) {
    if (dt <= 0) { return; }
    let any = false;
    const { p, v, rot, spin, age, life, size } = this;
    for (let i = 0; i < this.capacity; i++) {
      if (life[i] <= 0) continue;
      any = true;
      const i3 = i * 3;
      age[i] += dt;
      if (age[i] >= life[i]) { life[i] = 0; this.live--; this.mesh.setMatrixAt(i, _ZERO); continue; }
      v[i3 + 1] -= 26 * dt;
      const dq = Math.max(0, 1 - 0.9 * dt);
      v[i3] *= dq; v[i3 + 2] *= dq;
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
      if (p[i3 + 1] < this.floor[i]) {
        p[i3 + 1] = this.floor[i];
        v[i3 + 1] = -v[i3 + 1] * this.bounce[i];
        v[i3] *= 0.55; v[i3 + 2] *= 0.55;
        spin[i3] *= 0.5; spin[i3 + 1] *= 0.5; spin[i3 + 2] *= 0.5;
        if (Math.abs(v[i3 + 1]) < 0.6) v[i3 + 1] = 0;
      }
      if (this.waterKill[i] && p[i3 + 1] < waterY) { life[i] = 0; this.live--; this.mesh.setMatrixAt(i, _ZERO); continue; }
      rot[i3] += spin[i3] * dt; rot[i3 + 1] += spin[i3 + 1] * dt; rot[i3 + 2] += spin[i3 + 2] * dt;

      const t = age[i] / life[i];
      const shrink = t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1;
      _ee.set(rot[i3], rot[i3 + 1], rot[i3 + 2]);
      _qq.setFromEuler(_ee);
      _pv.set(p[i3], p[i3 + 1], p[i3 + 2]);
      _sv.set(size[i3] * shrink, size[i3 + 1] * shrink, size[i3 + 2] * shrink);
      _m4.compose(_pv, _qq, _sv);
      this.mesh.setMatrixAt(i, _m4);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = this.live > 0;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) { this.life[i] = 0; this.mesh.setMatrixAt(i, _ZERO); }
    this.live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// Camera-following wrapping volume — rain / snow / underwater motes
// ---------------------------------------------------------------------------

const VOL_VERT = /* glsl */`
attribute vec4 iSeed;   // xyz = normalised slot in the box, w = per-particle seed

uniform float uTime;
uniform vec3  uCenter;
uniform vec3  uBox;
uniform vec3  uVel;
uniform vec2  uSize;     // min, max
uniform vec2  uSway;     // amplitude, frequency
uniform float uStretch;
uniform float uTile;
uniform float uOpacity;
uniform float uSpin;
uniform float uTwinkle;
uniform float uFogDensity;

varying vec2 vUv;
varying float vAlpha;
varying float vFog;

void main() {
  float seed = iSeed.w;
  float spd = 0.65 + seed * 0.7;
  vec3 drift = uVel * uTime * spd;
  vec3 base = iSeed.xyz * uBox;
  // wrap into a box that rides with the camera
  vec3 p = mod(base + drift - uCenter + uBox * 0.5, uBox) - uBox * 0.5 + uCenter;

  if (uSway.x > 0.0) {
    float ph = seed * 31.4;
    p.x += uSway.x * sin(uTime * uSway.y + ph);
    p.z += uSway.x * cos(uTime * uSway.y * 0.83 + ph * 1.7);
  }

  float sz = mix(uSize.x, uSize.y, seed);
  float col = mod(uTile, ${ATLAS_COLS}.0);
  float row = floor(uTile / ${ATLAS_COLS}.0);
  vUv = vec2(col + uv.x, (${ATLAS_COLS}.0 - 1.0 - row) + uv.y) / ${ATLAS_COLS}.0;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec2 corner = position.xy;

  if (uStretch > 0.001) {
    vec3 mvv = (modelViewMatrix * vec4(uVel * spd, 0.0)).xyz;
    float sp = length(mvv.xy);
    vec2 dir = (sp > 1e-4) ? mvv.xy / sp : vec2(0.0, 1.0);
    mv.xy += dir * (corner.y * sz * uStretch) + vec2(dir.y, -dir.x) * (corner.x * sz);
  } else {
    float ang = seed * 6.283 + uTime * uSpin * (seed - 0.5) * 2.0;
    float ca = cos(ang), sa = sin(ang);
    mv.xy += vec2(corner.x * ca - corner.y * sa, corner.x * sa + corner.y * ca) * sz;
  }

  float d = -mv.z;
  // fade out at the edge of the box so wrapping particles never pop
  float edge = 1.0 - smoothstep(uBox.x * 0.30, uBox.x * 0.5, length(p - uCenter));
  float twinkle = mix(1.0, 0.35 + 0.65 * pow(abs(sin(uTime * 1.7 + seed * 40.0)), 0.6), uTwinkle);
  vAlpha = uOpacity * edge * twinkle;
  float fd = uFogDensity * d;
  vFog = 1.0 - exp(-fd * fd);
  gl_Position = projectionMatrix * mv;
}
`;

const VOL_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform vec3 uFogColor;
varying vec2 vUv;
varying float vAlpha;
varying float vFog;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha;
  if (a < 0.008) discard;
  vec3 rgb = uColor * tex.rgb;
  #ifdef FX_ADDITIVE
    rgb *= (1.0 - vFog);
  #else
    rgb = mix(rgb, uFogColor, vFog);
  #endif
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}
`;

export class VolumeParticles {
  constructor({ capacity = 3000, texture, additive = false, name = 'fx-volume' }) {
    this.capacity = capacity;
    const geo = this.geometry = baseQuad();
    const seeds = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) {
      seeds[i * 4] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(40, 32, 40) },
        uVel: { value: new THREE.Vector3(0, -14, 0) },
        uSize: { value: new THREE.Vector2(0.05, 0.11) },
        uSway: { value: new THREE.Vector2(0, 1) },
        uStretch: { value: 6 },
        uSpin: { value: 0 },
        uTwinkle: { value: 0 },
        uTile: { value: 0 },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color(0xffffff) },
        uFogColor: { value: new THREE.Color(0x9fd0e8) },
        uFogDensity: { value: 0 },
      },
      vertexShader: VOL_VERT,
      fragmentShader: VOL_FRAG,
      defines: additive ? { FX_ADDITIVE: 1 } : {},
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /** @param {number} n 0..capacity — density without reallocating anything. */
  setCount(n) {
    const c = Math.max(0, Math.min(this.capacity, Math.round(n)));
    this.geometry.instanceCount = c;
    this.mesh.visible = c > 0;
  }

  configure(o) {
    const u = this.material.uniforms;
    if (o.box) u.uBox.value.set(o.box[0], o.box[1], o.box[2]);
    if (o.vel) u.uVel.value.set(o.vel[0], o.vel[1], o.vel[2]);
    if (o.size) u.uSize.value.set(o.size[0], o.size[1]);
    if (o.sway) u.uSway.value.set(o.sway[0], o.sway[1]);
    if (o.stretch !== undefined) u.uStretch.value = o.stretch;
    if (o.spin !== undefined) u.uSpin.value = o.spin;
    if (o.twinkle !== undefined) u.uTwinkle.value = o.twinkle;
    if (o.tile !== undefined) u.uTile.value = o.tile;
    if (o.opacity !== undefined) u.uOpacity.value = o.opacity;
    if (o.color !== undefined) u.uColor.value.set(o.color);
  }

  update(time, camPos) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uCenter.value.copy(camPos);
  }

  setFog(color, density) {
    this.material.uniforms.uFogColor.value.copy(color);
    this.material.uniforms.uFogDensity.value = density;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
