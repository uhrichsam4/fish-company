import * as THREE from 'three';
import { clamp01, lerp, smoothstep, damp } from '../util/math.js';
import { waterHeightAt } from './waves.js';
import { bus } from '../core/EventBus.js';

/**
 * Procedural sky dome + sun/moon + directional lighting, driven by a
 * normalized time-of-day. No HDRI dependency, so it can blend continuously
 * between weather states.
 */
export class Sky {
  constructor(game) {
    this.game = game;
    this.name = 'sky';
    this.order = 2;
    /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset */
    this.timeOfDay = 0.34;
    this.dayLengthSeconds = 20 * 60;
    this.paused = false;
    this.sunDir = new THREE.Vector3(0.4, 0.7, 0.3).normalize();
    this.cloudiness = 0.25;
    this.stormy = 0;
    this.fogBoost = 0;
    this._targetCloud = 0.25;
  }

  async init(game) {
    this.uniforms = {
      uSunDir: { value: this.sunDir },
      uTime: { value: 0 },
      uZenith: { value: new THREE.Color(0x2f74c8) },
      uHorizon: { value: new THREE.Color(0xbfe2f2) },
      uGround: { value: new THREE.Color(0x6f8ea0) },
      uSunColor: { value: new THREE.Color(0xfff3d6) },
      uSunSize: { value: 0.9985 },
      uCloud: { value: 0.25 },
      uCloudColor: { value: new THREE.Color(0xffffff) },
      uCloudDark: { value: new THREE.Color(0x9aa8b4) },
      uStars: { value: 0 },
      uHaze: { value: 0.35 },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.7, -0.3) },
      uExposure: { value: 1 },
      // Blended toward the water colour when the camera is submerged; the sky
      // dome ignores depth, so without this the sun disc glares through the
      // sea and the horizon shows up underwater.
      uSubmerged: { value: 0 },
      uSubColor: { value: new THREE.Color(0x1f7f92) },
    };

    const geo = new THREE.SphereGeometry(2600, 32, 20);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    game.scene.add(this.mesh);

    // --- lights ---
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.6);
    this.sun.castShadow = true;
    // Single cascade, so the box has to cover most of an island or its edge
    // shows up as a hard vertical seam across the ground. 130 m at 4096 is a
    // ~3.2 cm texel — comparable to the old tight box, without the seam.
    this.shadowExtent = 130;
    this._applyShadowSize(game.settings.shadowRes);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 420;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 3.4;
    this.sunTarget = new THREE.Object3D();
    game.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    game.scene.add(this.sun);

    this.hemi = new THREE.HemisphereLight(0xbfe2f2, 0x6b6152, 0.75);
    game.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.16);
    game.scene.add(this.ambient);

    // Bounce light from the water, keeps undersides from going black.
    this.bounce = new THREE.DirectionalLight(0x7fd4e0, 0.28);
    this.bounce.position.set(-0.3, -1, 0.2);
    game.scene.add(this.bounce);

    this._waterAt = waterHeightAt;
    this.apply();
    return this;
  }

  /** Resize the shadow map and its frustum together. */
  _applyShadowSize(res) {
    const S = this.shadowExtent;
    const cam = this.sun.shadow.camera;
    cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
    cam.updateProjectionMatrix();
    // A wider box needs more texels to keep the same footprint.
    const want = Math.min(4096, Math.max(1024, (res || 2048) * 2));
    if (this.sun.shadow.mapSize.x !== want) {
      this.sun.shadow.mapSize.setScalar(want);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  setTimeOfDay(t) { this.timeOfDay = ((t % 1) + 1) % 1; this.apply(); }
  setCloudiness(c, instant = false) { this._targetCloud = clamp01(c); if (instant) this.cloudiness = this._targetCloud; }

  update(dt, game) {
    // Track submersion so the dome can hide itself under the water.
    const camY = game.camera.position.y;
    const surf = this._waterAt ? this._waterAt(game.camera.position.x, game.camera.position.z) : 0;
    const sub = camY < surf ? clamp01((surf - camY) / 0.9) : 0;
    this.uniforms.uSubmerged.value = damp(this.uniforms.uSubmerged.value, sub, 0.001, Math.max(dt, 1e-3));
    if (sub > 0.001) {
      const deep = game.get('ocean')?.uniforms.uDeepColor.value;
      const shallow = game.get('ocean')?.uniforms.uShallowColor.value;
      if (deep && shallow) {
        this.uniforms.uSubColor.value.copy(shallow).lerp(deep, clamp01((surf - camY) / 45));
      }
    }

    if (!this.paused && dt > 0) {
      this.timeOfDay = (this.timeOfDay + dt / this.dayLengthSeconds) % 1;
    }
    this.cloudiness = damp(this.cloudiness, this._targetCloud, 0.15, dt);
    this.uniforms.uTime.value += dt;
    this.apply();
    this.mesh.position.copy(game.camera.position);
    this.mesh.updateMatrix();

    // Keep the shadow frustum tight around the camera, snapped to texel size
    // so shadows don't crawl as the player walks.
    const cam = game.camera;
    const d = 180;
    const focusForLight = game.get('player')?.position || cam.position;
    this.sun.position.set(
      focusForLight.x + this.sunDir.x * d,
      focusForLight.y + this.sunDir.y * d,
      focusForLight.z + this.sunDir.z * d,
    );
    // Centre the box on the PLAYER's ground position rather than the camera:
    // a camera looking down from height would otherwise drag the box off the
    // ground the player is standing on. Snap to texel size so shadows don't
    // crawl as they walk.
    const player = game.get('player');
    const focus = player ? player.position : cam.position;
    const texel = (this.shadowExtent * 2) / (this.sun.shadow.mapSize.x || 2048);
    this.sunTarget.position.set(
      Math.round(focus.x / texel) * texel,
      Math.round(focus.y / texel) * texel,
      Math.round(focus.z / texel) * texel,
    );
    this.sunTarget.updateMatrixWorld();
  }

  /** Recompute sun direction, colours and light intensities from timeOfDay. */
  apply() {
    const t = this.timeOfDay;
    const ang = (t - 0.25) * Math.PI * 2;
    // Tilted arc so the sun isn't perfectly overhead at noon.
    this.sunDir.set(Math.cos(ang) * 0.55, Math.sin(ang), Math.cos(ang) * 0.32 + 0.28).normalize();
    const elev = this.sunDir.y;
    const u = this.uniforms;
    u.uSunDir.value.copy(this.sunDir);
    u.uMoonDir.value.set(-this.sunDir.x, -this.sunDir.y, -this.sunDir.z);

    const day = smoothstep(clamp01((elev + 0.06) / 0.3));
    const golden = clamp01(1 - Math.abs(elev - 0.10) / 0.22);
    const night = 1 - day;

    // --- sky gradient ---
    const zenithDay = _c(0x2266c4), zenithNight = _c(0x05070f), zenithGold = _c(0x2f5f9a);
    const horizDay = _c(0xcfe9f5), horizNight = _c(0x0d1626), horizGold = _c(0xffb163);
    const sunDay = _c(0xfff4d8), sunGold = _c(0xff9b3d), sunNight = _c(0x35406b);

    u.uZenith.value.copy(zenithNight).lerp(zenithDay, day).lerp(zenithGold, golden * 0.55);
    u.uHorizon.value.copy(horizNight).lerp(horizDay, day).lerp(horizGold, golden * 0.8);
    u.uSunColor.value.copy(sunNight).lerp(sunDay, day).lerp(sunGold, golden * 0.9);
    u.uStars.value = clamp01(night * 1.3 - 0.15);
    u.uCloud.value = this.cloudiness;

    // Storms desaturate and darken everything.
    const storm = this.stormy;
    if (storm > 0.001) {
      const grey = _c(0x39424c);
      u.uZenith.value.lerp(grey, storm * 0.8);
      u.uHorizon.value.lerp(_c(0x5c6670), storm * 0.75);
      u.uSunColor.value.lerp(_c(0x8f96a0), storm * 0.7);
    }
    u.uCloudColor.value.copy(_c(0xffffff)).lerp(_c(0xffd9ad), golden * 0.7).lerp(_c(0x6d7681), storm * 0.85);
    u.uCloudDark.value.copy(_c(0x93a3b0)).lerp(_c(0xc4794a), golden * 0.5).lerp(_c(0x2b3138), storm * 0.9);
    u.uHaze.value = lerp(0.3, 0.62, this.cloudiness) + storm * 0.25;

    // --- lights ---
    const sunI = (0.12 + day * 2.7) * (1 - this.cloudiness * 0.5) * (1 - storm * 0.55);
    this.sun.intensity = sunI;
    this.sun.color.copy(u.uSunColor.value).lerp(_c(0xffffff), 0.25);
    this.sun.castShadow = this.game.settings.shadows && elev > -0.02;

    this.hemi.intensity = lerp(0.22, 1.15, day) * (1 - storm * 0.3) + this.cloudiness * 0.14;
    this.hemi.color.copy(u.uHorizon.value);
    this.hemi.groundColor.copy(_c(0x6b6152)).lerp(_c(0x161a22), night);
    this.ambient.intensity = lerp(0.07, 0.28, day) + this.cloudiness * 0.06;
    this.bounce.intensity = lerp(0.05, 0.3, day);

    // --- scene fog / background ---
    const sc = this.game.scene;
    if (sc.fog) {
      sc.fog.color.copy(u.uHorizon.value).lerp(_c(0x8fb6cc), 0.25);
      if (this.fogColorOverride) sc.fog.color.lerp(this.fogColorOverride, this.fogColorMix ?? 0.6);
    }
    if (sc.background?.isColor) sc.background.copy(u.uHorizon.value);
  }

  /** Human-readable clock, e.g. "07:42". */
  clockString() {
    const mins = Math.floor(this.timeOfDay * 24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  get isNight() { return this.sunDir.y < -0.02; }
  get dayFactor() { return smoothstep(clamp01((this.sunDir.y + 0.06) / 0.3)); }

  save() { return { t: this.timeOfDay, cloud: this._targetCloud }; }
  load(d) { if (d) { this.timeOfDay = d.t ?? 0.34; this._targetCloud = d.cloud ?? 0.25; this.cloudiness = this._targetCloud; this.apply(); } }
}

const _tmpC = new THREE.Color();
function _c(hex) { return _tmpC.setHex(hex).clone(); }

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999;
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir, uMoonDir, uZenith, uHorizon, uGround, uSunColor, uCloudColor, uCloudDark;
uniform float uTime, uSunSize, uCloud, uStars, uHaze, uExposure;
uniform float uSubmerged;
uniform vec3 uSubColor;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
float stars(vec3 d){
  vec3 s = d * 220.0;
  vec3 i = floor(s);
  float h = fract(sin(dot(i, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  if (h < 0.9955) return 0.0;
  vec3 f = fract(s) - 0.5;
  float d2 = dot(f, f);
  float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 8.0) + h * 40.0);
  return exp(-d2 * 55.0) * tw * (0.4 + h * 60.0 - 59.7);
}

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;

  // Gradient: horizon -> zenith with a soft ground bounce below.
  float t = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.42, 0.95, t));
  col = mix(col, uHorizon, pow(1.0 - clamp(up, 0.0, 1.0), 6.0) * uHaze);
  if (up < 0.0) col = mix(col, uGround, clamp(-up * 2.2, 0.0, 0.85));

  // Stars.
  if (uStars > 0.01 && up > -0.05) col += vec3(0.9, 0.93, 1.0) * stars(d) * uStars;

  // Moon.
  float moonD = dot(d, normalize(uMoonDir));
  if (moonD > 0.9992) {
    float m = smoothstep(0.9992, 0.99965, moonD);
    col = mix(col, vec3(0.95, 0.95, 0.88), m * uStars);
  }
  col += vec3(0.35, 0.38, 0.5) * pow(max(moonD, 0.0), 260.0) * uStars * 0.5;

  // Sun disc + glow.
  float sunD = dot(d, uSunDir);
  float disc = smoothstep(uSunSize, uSunSize + 0.0009, sunD);
  col += uSunColor * disc * 6.0;
  col += uSunColor * pow(max(sunD, 0.0), 180.0) * 0.9;
  col += uSunColor * pow(max(sunD, 0.0), 8.0) * 0.16;

  // Clouds: two fbm layers on a dome projection, lit from the sun side.
  if (up > -0.03 && uCloud > 0.01) {
    vec2 cuv = d.xz / max(0.06, up + 0.10);
    float drift = uTime * 0.0032;
    float base = fbm(cuv * 0.55 + vec2(drift, drift * 0.35));
    float detail = fbm(cuv * 1.9 - vec2(drift * 1.7, drift * 0.6));
    float density = base * 0.72 + detail * 0.28;
    float cover = mix(0.72, 0.30, uCloud);
    float c = smoothstep(cover, cover + 0.22, density);
    float lit = clamp(dot(normalize(vec3(uSunDir.x, 0.35, uSunDir.z)), normalize(vec3(d.x, 0.35, d.z))) * 0.5 + 0.5, 0.0, 1.0);
    vec3 cc = mix(uCloudDark, uCloudColor, pow(lit, 1.6) * 0.85 + 0.15);
    cc += uSunColor * pow(max(sunD, 0.0), 12.0) * 0.35 * c;
    float horizonFade = smoothstep(-0.02, 0.10, up);
    col = mix(col, cc, clamp(c, 0.0, 1.0) * 0.92 * horizonFade);
  }

  col *= uExposure;

  // Underwater: collapse to the water colour, keeping only a soft glow toward
  // the sun so "up" still reads as up.
  if (uSubmerged > 0.001) {
    float upGlow = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 3.0);
    vec3 sub = uSubColor * (0.55 + upGlow * 0.85);
    sub += uSunColor * pow(max(dot(d, uSunDir), 0.0), 26.0) * 0.10 * upGlow;
    col = mix(col, sub, uSubmerged);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
