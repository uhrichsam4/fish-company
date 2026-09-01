import * as THREE from 'three';
import { GERSTNER_GLSL, waveState, waterHeightAt } from './waves.js';
import { bus } from '../core/EventBus.js';
import { clamp01, lerp } from '../util/math.js';

/**
 * Camera-following clipmap ocean with Gerstner displacement, analytic normals,
 * heightmap-driven depth colouring and shoreline foam.
 */
export class Ocean {
  constructor(game, opts = {}) {
    this.game = game;
    this.name = 'ocean';
    this.order = 5;
    this.seaLevel = opts.seaLevel ?? 0;
    this.worldExtent = opts.worldExtent ?? 1600;
    this.followCam = true;
    this._center = new THREE.Vector2();
  }

  async init(game) {
    const g = game;
    // 80x80 inner + 6 rings covers +/-2560 m (the skirt starts at 2400 m) for
    // ~70k tris instead of ~101k.
    const geo = makeClipmap(80, 80, 6);
    this.geometry = geo;

    const normal1 = g.assets.texture('assets/textures/water_normal1.jpg', { linear: true, fallback: 'normal', repeat: [1, 1] });
    const normal2 = g.assets.texture('assets/textures/water_normal2.jpg', { linear: true, fallback: 'normal', repeat: [1, 1] });
    const foamTex = g.assets.texture('assets/textures/water_foam.png', { srgb: true, fallback: 'noise', repeat: [1, 1] });
    for (const t of [normal1, normal2, foamTex]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }

    this.uniforms = {
      uTime: { value: 0 },
      uWaves: { value: waveState.waves.map((w) => new THREE.Vector4(w[0], w[1], w[2], w[3])) },
      uAmplitude: { value: 1 },
      uCenter: { value: new THREE.Vector2(0, 0) },
      uSeaLevel: { value: this.seaLevel },
      uNormal1: { value: normal1 },
      uNormal2: { value: normal2 },
      uFoamTex: { value: foamTex },
      uHeightMap: { value: null },
      uHeightRange: { value: new THREE.Vector4(-this.worldExtent, -this.worldExtent, this.worldExtent * 2, this.worldExtent * 2) },
      uHeightScale: { value: new THREE.Vector2(-60, 90) }, // min height, range
      uShallowColor: { value: new THREE.Color(0x2fbfae) },
      uDeepColor: { value: new THREE.Color(0x07406e) },
      uHorizonColor: { value: new THREE.Color(0x4d8fb5) },
      uFoamColor: { value: new THREE.Color(0xf2fbff) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(0xfff2d0) },
      uSkyColor: { value: new THREE.Color(0x9fd0e8) },
      uCameraPos: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Color(0x9fd0e8) },
      uFogDensity: { value: 0.0032 },
      uUnderwater: { value: 0 },
      uWindStrength: { value: 1 },
      uSparkle: { value: 1 },
      uQuality: { value: 2 },
      uOpacity: { value: 1 },
      uLight: { value: 1 },
      uRipples: { value: Array.from({ length: 12 }, () => new THREE.Vector4(0, 0, -1, 0)) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      defines: { USE_HEIGHTMAP: 0 },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'ocean';
    this.mesh.matrixAutoUpdate = false;
    g.scene.add(this.mesh);

    // Flat skirt out to the horizon so the ocean never ends in mid-air.
    const skirtGeo = new THREE.RingGeometry(2400, 16000, 128, 1);
    skirtGeo.rotateX(-Math.PI / 2);
    this.skirtMat = new THREE.MeshBasicMaterial({
      color: 0x4d8fb5, fog: true, transparent: true, opacity: 1, depthWrite: true, side: THREE.DoubleSide,
    });
    this.skirt = new THREE.Mesh(skirtGeo, this.skirtMat);
    this.skirt.position.y = this.seaLevel - 0.05;
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 9;
    g.scene.add(this.skirt);

    this._ripplePool = this.uniforms.uRipples.value;
    this._rippleIdx = 0;

    bus.on('quality:changed', (q) => {
      this.uniforms.uQuality.value = q === 'high' ? 2 : q === 'medium' ? 1 : 0;
    });
    bus.on('ocean:ripple', ({ x, z, strength = 1 }) => this.addRipple(x, z, strength));
    return this;
  }

  /** Terrain heightmap enables depth colouring + shoreline foam. */
  setHeightMap(texture, minHeight, maxHeight, extent) {
    this.uniforms.uHeightMap.value = texture;
    this.uniforms.uHeightScale.value.set(minHeight, maxHeight - minHeight);
    this.uniforms.uHeightRange.value.set(-extent, -extent, extent * 2, extent * 2);
    this.material.defines.USE_HEIGHTMAP = 1;
    this.material.needsUpdate = true;
  }

  addRipple(x, z, strength = 1) {
    const r = this._ripplePool[this._rippleIdx];
    r.set(x, z, this.uniforms.uTime.value, strength);
    this._rippleIdx = (this._rippleIdx + 1) % this._ripplePool.length;
  }

  setColors({ shallow, deep, horizon, sky, sun, fog, fogDensity, skirt }) {
    const u = this.uniforms;
    if (shallow) u.uShallowColor.value.set(shallow);
    if (deep) u.uDeepColor.value.set(deep);
    if (horizon) { u.uHorizonColor.value.set(horizon); this.skirtMat.color.set(horizon); }
    if (skirt) this.skirtMat.color.set(skirt);
    if (sky) u.uSkyColor.value.set(sky);
    if (sun) u.uSunColor.value.set(sun);
    if (fog) u.uFogColor.value.set(fog);
    if (fogDensity != null) u.uFogDensity.value = fogDensity;
  }

  update(dt, game) {
    waveState.time += dt;
    const u = this.uniforms;
    u.uTime.value = waveState.time;
    u.uAmplitude.value = waveState.amplitude;
    for (let i = 0; i < 4; i++) {
      const w = waveState.waves[i];
      u.uWaves.value[i].set(w[0], w[1], w[2], w[3]);
    }
    const cam = game.camera;
    u.uCameraPos.value.copy(cam.position);
    if (game.scene.fog) {
      u.uFogColor.value.copy(game.scene.fog.color);
      u.uFogDensity.value = game.scene.fog.density ?? 0.003;
    }
    if (this.followCam) {
      // Snap to the coarsest cell so vertices don't shimmer as the camera moves.
      const snap = 32;
      const cx = Math.round(cam.position.x / snap) * snap;
      const cz = Math.round(cam.position.z / snap) * snap;
      this.mesh.position.set(cx, this.seaLevel, cz);
      this.mesh.updateMatrix();
      u.uCenter.value.set(cx, cz);
      this.skirt.position.set(cam.position.x, this.seaLevel - 0.05, cam.position.z);
    }
    u.uUnderwater.value = cam.position.y < waterHeightAt(cam.position.x, cam.position.z) ? 1 : 0;

    const sky = game.get('sky');
    if (sky) {
      const light = 0.06 + sky.dayFactor * 0.94;
      u.uLight.value = light;
      u.uSunDir.value.copy(sky.sunDir);
      u.uSunColor.value.copy(sky.uniforms.uSunColor.value);
      u.uSkyColor.value.copy(sky.uniforms.uHorizon.value);
      this.skirtMat.color.copy(u.uHorizonColor.value).multiplyScalar(0.35 + light * 0.65);
    }
  }

  heightAt(x, z) { return waterHeightAt(x, z); }

  dispose() {
    this.geometry.dispose(); this.material.dispose();
    this.skirt.geometry.dispose(); this.skirtMat.dispose();
  }
}

/**
 * Nested-ring "clipmap" grid: dense near the camera, cells doubling outwards.
 * @returns {THREE.BufferGeometry} positions are XZ offsets from the centre.
 */
function makeClipmap(innerSize, innerSegs, levels) {
  const positions = [];
  const indices = [];
  const uvs = [];
  let vi = 0;

  const addQuadGrid = (x0, z0, cell, nx, nz, holeHalf) => {
    const cols = nx + 1, rows = nz + 1;
    const base = vi;
    const idxMap = new Int32Array(cols * rows).fill(-1);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        idxMap[j * cols + i] = vi;
        positions.push(x, 0, z);
        uvs.push(i / nx, j / nz);
        vi++;
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell;
        if (holeHalf > 0 && Math.abs(cx) < holeHalf && Math.abs(cz) < holeHalf) continue;
        const a = idxMap[j * cols + i];
        const b = idxMap[j * cols + i + 1];
        const c = idxMap[(j + 1) * cols + i + 1];
        const d = idxMap[(j + 1) * cols + i];
        indices.push(a, d, b, b, d, c);
      }
    }
    return base;
  };

  // Inner dense block.
  const c0 = innerSize / innerSegs;
  addQuadGrid(-innerSize / 2, -innerSize / 2, c0, innerSegs, innerSegs, 0);

  // Rings: each doubles cell size and covers out to 2x the previous extent.
  let half = innerSize / 2;
  let cell = c0;
  for (let l = 0; l < levels; l++) {
    cell *= 2;
    const newHalf = half * 2;
    const segs = Math.round((newHalf * 2) / cell);
    addQuadGrid(-newHalf, -newHalf, cell, segs, segs, half);
    half = newHalf;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  geo.boundingSphere.radius = half * 2;
  return geo;
}

const VERT = /* glsl */`
precision highp float;
${GERSTNER_GLSL}
uniform vec2 uCenter;
uniform float uSeaLevel;
uniform vec4 uHeightRange;
uniform vec2 uHeightScale;
uniform sampler2D uHeightMap;
uniform vec4 uRipples[12];

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vDepth;
varying float vCrest;
varying float vDist;
varying float vRipple;

float sampleTerrain(vec2 wp) {
#if USE_HEIGHTMAP
  vec2 uv = (wp - uHeightRange.xy) / uHeightRange.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return uHeightScale.x;
  return uHeightScale.x + texture2D(uHeightMap, uv).r * uHeightScale.y;
#else
  return -40.0;
#endif
}

void main() {
  vec2 wp = position.xz + uCenter;
  vec3 tangent, binormal;
  vec3 disp = gerstner(wp, tangent, binormal);

  float terrain = sampleTerrain(wp);
  float depth = uSeaLevel - terrain;
  vDepth = depth;
  // Flatten waves in shallow water so they don't cut through the beach.
  float shoal = clamp(depth / 3.0, 0.0, 1.0);
  disp *= shoal;

  // Expanding ripple rings from splashes.
  float ripple = 0.0;
  for (int i = 0; i < 12; i++) {
    vec4 r = uRipples[i];
    if (r.w <= 0.0) continue;
    float age = uTime - r.z;
    if (age < 0.0 || age > 3.0) continue;
    float d = distance(wp, r.xy);
    float radius = age * 5.5;
    float w = exp(-abs(d - radius) * 1.4) * exp(-age * 1.5) * r.w;
    ripple += sin((d - radius) * 3.0) * w * 0.32;
  }
  disp.y += ripple * shoal;
  vRipple = abs(ripple);

  vec3 pos = vec3(wp.x + disp.x, uSeaLevel + disp.y, wp.y + disp.z);
  vec3 n = normalize(cross(binormal, tangent));
  vNormal = n;
  vWorldPos = pos;
  vUv = wp * 0.02;
  vCrest = clamp(disp.y * 0.6 * uAmplitude, 0.0, 1.0);
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uNormal1;
uniform sampler2D uNormal2;
uniform sampler2D uFoamTex;
uniform vec3 uShallowColor;
uniform vec3 uDeepColor;
uniform vec3 uHorizonColor;
uniform vec3 uFoamColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform float uUnderwater;
uniform float uWindStrength;
uniform float uSparkle;
uniform float uQuality;
uniform float uOpacity;
uniform float uLight;
uniform float uAmplitude;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vDepth;
varying float vCrest;
varying float vDist;
varying float vRipple;

uniform sampler2D uHeightMap;
uniform vec4 uHeightRange;
uniform vec2 uHeightScale;
uniform float uSeaLevel;

vec3 unpackNormal(vec4 c) { return c.rgb * 2.0 - 1.0; }

// Per-fragment water depth. Interpolating this from the vertex stage produced
// hard triangle edges in the shoreline foam.
float depthAt(vec2 wp) {
#if USE_HEIGHTMAP
  vec2 uv = (wp - uHeightRange.xy) / uHeightRange.zw;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 60.0;
  float terrain = uHeightScale.x + texture2D(uHeightMap, uv).r * uHeightScale.y;
  return uSeaLevel - terrain;
#else
  return 40.0;
#endif
}

void main() {
  float waterCol_t;
  // Fragment-accurate depth near the shore; the interpolated value is fine
  // further out and much cheaper.
  float fragDepth = vDist < 180.0 ? depthAt(vWorldPos.xz) : vDepth;
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  vec3 N = normalize(vNormal);

  // Detail normals: two layers scrolling in different directions.
  if (uQuality > 0.5) {
    float t = uTime * 0.035 * uWindStrength;
    vec3 n1 = unpackNormal(texture2D(uNormal1, vUv * 3.0 + vec2(t, t * 0.6)));
    vec3 n2 = unpackNormal(texture2D(uNormal2, vUv * 8.0 - vec2(t * 0.8, t * 1.3)));
    vec3 detail = normalize(n1 * 0.65 + n2 * 0.35);
    // Fade detail with distance to kill aliasing on the horizon.
    float fade = clamp(1.0 - vDist / 260.0, 0.0, 1.0);
    N = normalize(N + vec3(detail.x, 0.0, detail.y) * (0.55 * fade * uWindStrength));
  }

  float depthFade = clamp(fragDepth / 34.0, 0.0, 1.0);
  waterCol_t = pow(depthFade, 1.45);
  vec3 waterCol = mix(uShallowColor, uDeepColor, waterCol_t);

  // Horizon tint: distant water reads as sky-reflection, not deep blue.
  float horizonMix = smoothstep(240.0, 1500.0, vDist);
  waterCol = mix(waterCol, uHorizonColor, horizonMix * 0.88);

  float fres = pow(1.0 - clamp(dot(N, viewDir), 0.0, 1.0), 4.0);
  fres = mix(0.03, 1.0, fres) * 0.75;

  vec3 skyRefl = mix(uSkyColor, uSkyColor * 1.25, clamp(N.y, 0.0, 1.0));
  vec3 col = mix(waterCol, skyRefl, fres);

  // Specular sun glint.
  vec3 H = normalize(uSunDir + viewDir);
  float spec = pow(max(dot(N, H), 0.0), 220.0);
  float wide = pow(max(dot(N, H), 0.0), 22.0);
  col += uSunColor * (spec * 2.4 + wide * 0.16) * uSparkle;

  // Foam: shoreline band + wave crests + ripple rings.
  // Wave-phase-driven shoreline: the foam edge advances and retreats with the
  // swell instead of sitting at a fixed contour.
  float surge = sin(uTime * 0.55 + vWorldPos.x * 0.045 + vWorldPos.z * 0.037) * 0.42
              + sin(uTime * 0.31 - vWorldPos.x * 0.021 + vWorldPos.z * 0.029) * 0.28;
  // The depth lookup is only ~2 m/texel, so thresholding it directly gave a
  // stair-stepped foam line. Break it up with the foam texture (already bound)
  // rather than procedural noise -- three octaves of value noise per fragment
  // over the whole ocean cost about 40 fps.
  float shoreFoam = 0.0;
  if (fragDepth < 5.0) {
    float fn = texture2D(uFoamTex, vWorldPos.xz * 0.035 + vec2(uTime * 0.004, uTime * 0.003)).r * 0.66
             + texture2D(uFoamTex, vWorldPos.xz * 0.14 - vec2(uTime * 0.011, uTime * 0.008)).r * 0.34;
    float noisyDepth = fragDepth + (fn - 0.5) * 0.9;
    // A narrow, wave-driven swash band -- not a shelf-wide white sheet.
    float edge = 0.78 + surge * 0.55 * uAmplitude;
    shoreFoam = smoothstep(edge, edge - 0.6, noisyDepth) * 0.92;
    shoreFoam += smoothstep(edge + 0.9, edge, noisyDepth) * 0.16;
  }
  float crestFoam = smoothstep(0.45, 0.95, vCrest) * clamp(uAmplitude, 0.0, 1.6);
  float rippleFoam = clamp(vRipple * 3.0, 0.0, 1.0);
  float foamAmt = clamp(shoreFoam + crestFoam * 0.85 + rippleFoam * 0.6, 0.0, 1.0);
  if (foamAmt > 0.01) {
    float ft = texture2D(uFoamTex, vUv * 14.0 + vec2(uTime * 0.02, uTime * 0.013)).r;
    // Let the texture shape the foam rather than drowning it in a constant
    // term -- the band was rendering as flat white.
    float mask = smoothstep(0.62 - foamAmt * 0.55, 1.0 - foamAmt * 0.4, ft);
    col = mix(col, uFoamColor, mask * foamAmt * 0.92);
  }

  // Alpha: opaque offshore, translucent at the water's edge.
  float alpha = mix(0.5, 1.0, clamp(fragDepth / 2.6, 0.0, 1.0));
  alpha = max(alpha, foamAmt * 0.82);
  alpha *= uOpacity;

  if (uUnderwater > 0.5) {
    col = mix(col, uDeepColor * 1.4, 0.55);
    alpha = 0.85;
  }

  // Water is lit by the sky: at night it must go dark, not stay tropical.
  col *= mix(0.10, 1.0, uLight);
  col += vec3(0.012, 0.02, 0.034) * (1.0 - uLight);

  float fogAmt = 1.0 - exp(-uFogDensity * uFogDensity * vDist * vDist);
  col = mix(col, uFogColor, clamp(fogAmt, 0.0, 1.0));

  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;
