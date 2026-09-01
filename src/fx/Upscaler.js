import * as THREE from 'three';
import { bus } from '../core/EventBus.js';

/**
 * Render the scene below native resolution and scale it back up with a
 * contrast-adaptive sharpen, rather than letting the browser do a plain
 * bilinear stretch.
 *
 * This is the same idea as FSR 1.0's second pass (RCAS): a bilinear upscale
 * loses the high-frequency detail that makes an image read as sharp, so you
 * put some of it back by boosting each pixel against the local min and max of
 * its neighbours. It is a sharpening filter, not reconstruction -- there is no
 * temporal history here and nothing invents detail that was not rendered.
 *
 * Written rather than pulled in because the packaged upscalers in this space
 * are built for React Three Fiber's render loop, and this game drives its own.
 *
 * On whether it helps: yes, substantially. Frozen scene, GPU timer queries,
 * 40 resolved samples per cell, M4 Pro at a 1.39 Mpx drawing buffer:
 *
 *   native canvas (MSAA 4x)   1.39 Mpx   23.4 ms
 *   render target 0.75        0.78 Mpx   13.6 ms   -42%
 *   render target 0.50        0.35 Mpx    6.9 ms   -71%
 *
 * Same scene, same geometry, only the pixel count changing. MSAA is not the
 * variable -- at full resolution, 4x and 0x measured 22.0 and 22.8 ms, inside
 * the noise. This scene is fill-rate bound, exactly as the note on
 * Game.targetPixelRatio has always said.
 *
 * An earlier pass concluded the opposite from a run where the timer queries
 * were only partly resolving and the average was taken over whatever came
 * back. Harvest every query, or do not quote the number.
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 texel;      // 1 / source resolution
uniform float sharpness; // 0 = plain bilinear, 1 = strongest
varying vec2 vUv;

/** Linear -> sRGB. The scene arrives tone-mapped but linear; the canvas wants sRGB. */
vec3 encode(vec3 x) {
  return mix(x * 12.92, 1.055 * pow(max(x, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), x));
}

void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  if (sharpness <= 0.001) { gl_FragColor = vec4(encode(c), 1.0); return; }

  // Cross neighbourhood, as RCAS uses -- the diagonals cost four more taps
  // and mostly add ringing on the hard edges this art style is made of.
  vec3 n = texture2D(tSrc, vUv + vec2(0.0, -texel.y)).rgb;
  vec3 s = texture2D(tSrc, vUv + vec2(0.0,  texel.y)).rgb;
  vec3 w = texture2D(tSrc, vUv + vec2(-texel.x, 0.0)).rgb;
  vec3 e = texture2D(tSrc, vUv + vec2( texel.x, 0.0)).rgb;

  vec3 mn = min(min(min(n, s), min(w, e)), c);
  vec3 mx = max(max(max(n, s), max(w, e)), c);

  // How much headroom this pixel has before sharpening would clip it. Without
  // this the filter blows out highlights on the water and haloes the sky line.
  vec3 room = min(mn, 1.0 - mx) / max(mx, vec3(1e-4));
  float amount = sharpness * 0.4 * clamp(min(min(room.r, room.g), room.b), 0.0, 1.0);

  vec3 blur = (n + s + w + e) * 0.25;
  gl_FragColor = vec4(encode(clamp(c + (c - blur) * amount * 4.0, 0.0, 1.0)), 1.0);
}
`;

export class Upscaler {
  constructor(game) {
    this.game = game;
    this.name = 'upscaler';
    /** Not in the system update order: Game.render calls this directly. */
    this.order = 999;
    this.target = null;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = null;
    this._w = 0;
    this._h = 0;
  }

  async init(game) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        tSrc: { value: null },
        texel: { value: new THREE.Vector2(1, 1) },
        sharpness: { value: 0.7 },
      },
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);

    bus.on('settings:applied', () => this._sync());
    this._sync();
    return this;
  }

  get enabled() {
    const s = this.game.settings;
    return !!s.upscale && (s.upscaleScale ?? 0.75) < 0.995;
  }

  _sync() {
    const s = this.game.settings;
    if (this.material) this.material.uniforms.sharpness.value = s.upscaleSharpness ?? 0.7;
    if (!this.enabled) this._release();
  }

  _release() {
    if (this.target) { this.target.dispose(); this.target = null; }
    this._w = this._h = 0;
  }

  /** Source buffer sized to the drawing buffer times the chosen scale. */
  _ensure(renderer) {
    const size = renderer.getDrawingBufferSize(_size);
    const scale = Math.max(0.4, Math.min(1, this.game.settings.upscaleScale ?? 0.75));
    const w = Math.max(2, Math.round(size.x * scale));
    const h = Math.max(2, Math.round(size.y * scale));
    if (this.target && w === this._w && h === this._h) return this.target;

    if (this.target) this.target.dispose();
    // Multisampled, matching the canvas. Measured free at 0.75 scale, and
    // without it the sharpen pass makes the aliasing it inherits worse --
    // there is no point buying frame time with jagged edges when the same
    // scale costs nothing to antialias.
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false,
      // Left linear on purpose. Letting the target carry the output colour
      // space means three.js encodes on the way in and decodes on the way out
      // of the blit, and getting either half wrong darkens the whole image by
      // a full sRGB transfer. Encoding once, explicitly, in the blit shader is
      // the version that is obvious when it breaks.
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: this.game.settings.upscaleMSAA === false ? 0 : 4,
    });
    this.target.texture.colorSpace = THREE.NoColorSpace;   // no implicit decode
    this._w = w; this._h = h;
    this.material.uniforms.texel.value.set(1 / w, 1 / h);
    return this.target;
  }

  /**
   * Draw scene -> low-res target -> sharpened blit to the canvas.
   * @returns {boolean} false if it did nothing, so the caller renders normally.
   */
  render(renderer, scene, camera) {
    if (!this.enabled || !this.material) return false;
    const target = this._ensure(renderer);

    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    this.material.uniforms.tSrc.value = target.texture;
    // The blit is already in output space; tone mapping it twice would wash
    // the whole image out.
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.render(this.scene, this.camera);
    renderer.toneMapping = prevTone;
    return true;
  }

  /** Internal resolution, for the perf panel. */
  stats() {
    if (!this.enabled || !this.target) return null;
    return { w: this._w, h: this._h, mpx: (this._w * this._h) / 1e6 };
  }

  dispose() { this._release(); }
}

const _size = new THREE.Vector2();
