import * as THREE from 'three';
import { GERSTNER_GLSL, waveState } from '../world/waves.js';

/**
 * Ribbon trails (boat wakes) and lightning bolts.
 *
 * The wake is a scrolling ribbon BufferGeometry: a new rib (2 verts) is
 * committed every `minDist` metres travelled and the head rib is dragged to the
 * boat each frame so the foam never detaches. Width GROWS WITH AGE in the
 * vertex shader, which is what produces the V — old ribs keep spreading after
 * they were written, exactly like a real wake, for zero CPU cost. Ribs also
 * ride the shared Gerstner surface so the foam never floats over a crest.
 */

// ---------------------------------------------------------------------------

/** Procedural foam band: bright clumpy edges, thinner in the middle. */
export function makeFoamStripTexture() {
  const W = 256, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  let s = 1234567;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const blob = (x, y, r, a) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(0.55, `rgba(255,255,255,${a * 0.75})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  // two dense foam rails along the outside edges + scattered clumps between
  for (let i = 0; i < 190; i++) {
    const x = rnd() * W;
    const edge = rnd() < 0.5 ? 0 : 1;
    const y = edge ? H - 3 - rnd() * 11 : 3 + rnd() * 11;
    blob(x, y, 4 + rnd() * 8, 0.55 + rnd() * 0.45);
  }
  for (let i = 0; i < 90; i++) blob(rnd() * W, 12 + rnd() * (H - 24), 3 + rnd() * 7, 0.16 + rnd() * 0.32);
  // wrap-safe: mirror the first 24 px onto the tail so u tiling is seamless
  const head = g.getImageData(0, 0, 24, H);
  g.putImageData(head, W - 24, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

const RIBBON_VERT = /* glsl */`
${GERSTNER_GLSL}

attribute vec3 aNorm;
attribute vec4 aInfo;   // birth, side(-1|1), u, width0

uniform float uFxTime;
uniform float uLife;
uniform float uSpread;
uniform float uSeaLevel;
uniform float uLift;
uniform float uScroll;

varying vec2 vUv;
varying float vAlpha;

void main() {
  float age = max(0.0, uFxTime - aInfo.x);
  float t = clamp(age / uLife, 0.0, 1.0);
  float halfW = (aInfo.w + age * uSpread) * 0.5;
  vec2 wp = position.xz + aNorm.xz * (aInfo.y * halfW);

  vec3 tanv, binv;
  vec3 disp = gerstner(wp, tanv, binv);
  vec3 p = vec3(wp.x + disp.x, uSeaLevel + disp.y + uLift, wp.y + disp.z);

  vAlpha = pow(1.0 - t, 1.35);
  vUv = vec2(aInfo.z + uScroll, aInfo.y * 0.5 + 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vAlpha * uOpacity;
  if (a < 0.008) discard;
  gl_FragColor = vec4(uColor * tex.rgb, a);
  #include <colorspace_fragment>
}
`;

export class Ribbon {
  /** @param {{capacity?:number, texture:THREE.Texture, color?:number, life?:number, spread?:number, minDist?:number, uScale?:number}} o */
  constructor(o) {
    const cap = this.capacity = o.capacity ?? 56;
    const verts = (cap + 1) * 2;
    this.life = o.life ?? 4.5;
    this.minDist = o.minDist ?? 0.55;
    this.uScale = o.uScale ?? 0.14;
    this.ribs = 0;
    this.u = 0;

    this.pos = new Float32Array(verts * 3);
    this.nrm = new Float32Array(verts * 3);
    this.inf = new Float32Array(verts * 4);

    const geo = this.geometry = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aNrm = new THREE.BufferAttribute(this.nrm, 3).setUsage(THREE.DynamicDrawUsage);
    this.aInf = new THREE.BufferAttribute(this.inf, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aNorm', this.aNrm);
    geo.setAttribute('aInfo', this.aInf);

    const idx = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 2, o6 = i * 6;
      idx[o6] = v; idx[o6 + 1] = v + 1; idx[o6 + 2] = v + 3;
      idx[o6 + 3] = v; idx[o6 + 4] = v + 3; idx[o6 + 5] = v + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: o.texture },
        uColor: { value: new THREE.Color(o.color ?? 0xffffff) },
        uOpacity: { value: o.opacity ?? 0.95 },
        uFxTime: { value: 0 },
        uLife: { value: this.life },
        uSpread: { value: o.spread ?? 0.75 },
        uSeaLevel: { value: 0 },
        uLift: { value: o.lift ?? 0.06 },
        uScroll: { value: 0 },
        uTime: { value: 0 },
        uAmplitude: { value: 1 },
        uWaves: { value: waveState.waves.map((w) => new THREE.Vector4(w[0], w[1], w[2], w[3])) },
      },
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'fx-ribbon';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;

    this._lastX = 0; this._lastZ = 0; this._hasLast = false;
    this._headBirth = 0;
  }

  reset() {
    this.ribs = 0; this.u = 0; this._hasLast = false;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  _writeRib(i, x, y, z, nx, nz, width, birth, u) {
    let k = i * 6;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.pos[k + 3] = x; this.pos[k + 4] = y; this.pos[k + 5] = z;
    this.nrm[k] = nx; this.nrm[k + 1] = 0; this.nrm[k + 2] = nz;
    this.nrm[k + 3] = nx; this.nrm[k + 4] = 0; this.nrm[k + 5] = nz;
    k = i * 8;
    this.inf[k] = birth; this.inf[k + 1] = -1; this.inf[k + 2] = u; this.inf[k + 3] = width;
    this.inf[k + 4] = birth; this.inf[k + 5] = 1; this.inf[k + 6] = u; this.inf[k + 7] = width;
  }

  /** Drop the oldest rib, sliding everything down one slot (no allocation). */
  _shift() {
    this.pos.copyWithin(0, 6);
    this.nrm.copyWithin(0, 6);
    this.inf.copyWithin(0, 8);
    this.ribs--;
  }

  /**
   * @param {number} x @param {number} y @param {number} z world position of the emitter
   * @param {number} nx @param {number} nz unit vector perpendicular to travel
   * @param {number} width start width in metres
   * @param {number} now fx clock
   */
  push(x, y, z, nx, nz, width, now) {
    if (!this._hasLast) {
      this._writeRib(0, x, y, z, nx, nz, width, now, 0);
      this._writeRib(1, x, y, z, nx, nz, width, now, 0);
      this.ribs = 2;
      this._lastX = x; this._lastZ = z; this._hasLast = true;
      this._headBirth = now;
    } else {
      const dx = x - this._lastX, dz = z - this._lastZ;
      const d = Math.hypot(dx, dz);
      if (d >= this.minDist) {
        this.u += d * this.uScale;
        if (this.ribs > this.capacity) this._shift();
        this._writeRib(this.ribs, x, y, z, nx, nz, width, now, this.u);
        this.ribs++;
        this._lastX = x; this._lastZ = z;
        this._headBirth = now;
      } else {
        // drag the head rib along so the trail stays glued to the boat
        this._writeRib(this.ribs - 1, x, y, z, nx, nz, width, this._headBirth,
          this.u + d * this.uScale);
      }
    }
    this.aPos.needsUpdate = this.aNrm.needsUpdate = this.aInf.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, (this.ribs - 1) * 6));
    this.mesh.visible = this.ribs > 1;
  }

  /** Age out ribs even when the emitter stopped moving. */
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
    // retire fully-faded tail ribs
    while (this.ribs > 1 && fxTime - this.inf[0] > this.life) {
      this._shift();
      this.aPos.needsUpdate = this.aNrm.needsUpdate = this.aInf.needsUpdate = true;
      this.geometry.setDrawRange(0, Math.max(0, (this.ribs - 1) * 6));
    }
    if (this.ribs <= 1) this.mesh.visible = false;
  }

  get empty() { return this.ribs <= 1; }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// Lightning
// ---------------------------------------------------------------------------

const BOLT_VERT = /* glsl */`
attribute vec3 aDir;
attribute vec2 aInfo;   // side(-1|1), taper 0..1

uniform float uWidth;
varying float vTaper;
varying float vSide;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 d = (modelViewMatrix * vec4(aDir, 0.0)).xyz;
  vec2 perp = normalize(vec2(-d.y, d.x) + vec2(1e-6));
  mv.xy += perp * (aInfo.x * uWidth * mix(0.35, 1.0, aInfo.y));
  vTaper = aInfo.y;
  vSide = aInfo.x;
  gl_Position = projectionMatrix * mv;
}
`;

const BOLT_FRAG = /* glsl */`
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uFlash;
varying float vTaper;
varying float vSide;
void main() {
  float e = 1.0 - abs(vSide);
  float core = smoothstep(0.35, 1.0, e);
  vec3 rgb = mix(uGlow, uCore, core);
  float a = (core * 0.85 + pow(e, 2.0) * 0.55) * uFlash * vTaper;
  if (a < 0.01) discard;
  gl_FragColor = vec4(rgb, a);
  #include <colorspace_fragment>
}
`;

export class LightningBolt {
  constructor({ segments = 26, width = 0.34, core = 0xffffff, glow = 0x76b9ff } = {}) {
    this.segments = segments;
    const verts = segments * 2;
    this.pos = new Float32Array(verts * 3);
    this.dir = new Float32Array(verts * 3);
    this.inf = new Float32Array(verts * 2);
    for (let i = 0; i < segments; i++) {
      this.inf[i * 4] = -1; this.inf[i * 4 + 1] = 1;
      this.inf[i * 4 + 2] = 1; this.inf[i * 4 + 3] = 1;
    }
    const geo = this.geometry = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aDir = new THREE.BufferAttribute(this.dir, 3).setUsage(THREE.DynamicDrawUsage);
    this.aInf = new THREE.BufferAttribute(this.inf, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aDir', this.aDir);
    geo.setAttribute('aInfo', this.aInf);
    const idx = new Uint16Array((segments - 1) * 6);
    for (let i = 0; i < segments - 1; i++) {
      const v = i * 2, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 3;
      idx[o + 3] = v; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: width },
        uCore: { value: new THREE.Color(core) },
        uGlow: { value: new THREE.Color(glow) },
        uFlash: { value: 0 },
      },
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'fx-bolt';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 16;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.until = 0;
    this.duration = 0.12;
  }

  /** Regenerate a jagged path between two points and start the flash. */
  strike(ax, ay, az, bx, by, bz, now, duration = 0.12, jitter = 0.16) {
    const n = this.segments;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    // an arbitrary basis perpendicular to the bolt
    let ux = -dz / len, uy = 0, uz = dx / len;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
    ux /= ul; uz /= ul;
    const wx = (dy / len) * uz - (dz / len) * uy;
    const wy = (dz / len) * ux - (dx / len) * uz;
    const wz = (dx / len) * uy - (dy / len) * ux;
    const amp = len * jitter;

    let px = ax, py = ay, pz = az;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const env = Math.sin(t * Math.PI);           // no offset at the endpoints
      const j1 = (Math.random() * 2 - 1) * amp * env;
      const j2 = (Math.random() * 2 - 1) * amp * env * 0.7;
      const x = ax + dx * t + ux * j1 + wx * j2;
      const y = ay + dy * t + uy * j1 + wy * j2;
      const z = az + dz * t + uz * j1 + wz * j2;
      const k = i * 6;
      this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
      this.pos[k + 3] = x; this.pos[k + 4] = y; this.pos[k + 5] = z;
      // direction from the previous point (first uses the next one)
      let tx = x - px, ty = y - py, tz = z - pz;
      if (i === 0) { tx = dx; ty = dy; tz = dz; }
      const tl = Math.hypot(tx, ty, tz) || 1;
      this.dir[k] = tx / tl; this.dir[k + 1] = ty / tl; this.dir[k + 2] = tz / tl;
      this.dir[k + 3] = tx / tl; this.dir[k + 4] = ty / tl; this.dir[k + 5] = tz / tl;
      const taper = Math.min(1, env * 1.9 + 0.25);
      this.inf[i * 4 + 1] = taper;
      this.inf[i * 4 + 3] = taper;
      px = x; py = y; pz = z;
    }
    this.aPos.needsUpdate = this.aDir.needsUpdate = this.aInf.needsUpdate = true;
    this.duration = duration;
    this.until = now + duration;
    this.mesh.visible = true;
    this.material.uniforms.uFlash.value = 1;
  }

  update(now) {
    if (!this.mesh.visible) return false;
    const left = this.until - now;
    if (left <= 0) { this.mesh.visible = false; this.material.uniforms.uFlash.value = 0; return false; }
    const t = 1 - left / this.duration;
    // hard strobe: bright, blink, bright, out
    const flick = t < 0.12 ? 1 : (t < 0.22 ? 0.25 : (t < 0.45 ? 1 : Math.pow(1 - (t - 0.45) / 0.55, 1.6)));
    this.material.uniforms.uFlash.value = flick;
    return true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
