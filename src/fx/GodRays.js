import * as THREE from 'three';

/**
 * Cheap underwater light shafts: a fan of large additive quads that hang from
 * the surface along the sun direction and billboard around that axis so they
 * always present their broad face to the camera. One draw call, no depth
 * prepass, no raymarching — the whole thing is a soft sin() falloff across the
 * shaft plus a depth fade.
 *
 * HONEST VERDICT after the visual passes: this is the weakest effect in the
 * pack and it is OFF by default. Against bright shallow water it disappears;
 * pushed bright enough to see, the billboarded quads merge into a shapeless
 * white wash rather than reading as separate shafts, because they all rotate to
 * face the camera and overlap. It only earns its place in a genuinely dark
 * scene (deep water, night, the abyss region) where a faint directional
 * brightening near the surface helps. Narrow shafts + a high-power cross
 * section (below) is as far as this technique goes without a depth-aware
 * raymarch; if it looks bad in your region, just never call `fx.godRays(true)`.
 * `intensity` is clamped to 0.6 so it can never blow out the frame.
 */

const VERT = /* glsl */`
attribute vec2 aLocal;    // x -0.5..0.5 across, y 0..1 down the shaft
attribute vec3 aParams;   // angle, radius, widthScale

uniform vec3 uSunDir;     // normalised, pointing toward the sun
uniform vec3 uCenter;     // camera position
uniform float uSeaLevel;
uniform float uWidth;
uniform float uLength;
uniform float uTime;

varying vec2 vUv;
varying float vSeed;

void main() {
  float ang = aParams.x + uTime * 0.035;
  vec3 origin = vec3(uCenter.x + cos(ang) * aParams.y, uSeaLevel, uCenter.z + sin(ang) * aParams.y);
  vec3 up = normalize(uSunDir);
  vec3 toCam = cameraPosition - origin;
  vec3 right = cross(up, toCam);
  float rl = length(right);
  right = (rl > 1e-4) ? right / rl : vec3(1.0, 0.0, 0.0);

  float wob = 1.0 + 0.14 * sin(uTime * 0.5 + aParams.x * 3.1);
  vec3 p = origin
    + right * (aLocal.x * uWidth * aParams.z * wob)
    - up * (aLocal.y * uLength);

  vUv = vec2(aLocal.x + 0.5, aLocal.y);
  vSeed = aParams.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
void main() {
  float across = pow(sin(clamp(vUv.x, 0.0, 1.0) * 3.14159), 3.4);
  float depth = pow(1.0 - vUv.y, 1.5);
  float head = smoothstep(0.0, 0.08, vUv.y);
  float pulse = 0.75 + 0.25 * sin(uTime * 0.7 + vSeed * 4.0);
  float a = across * depth * head * pulse * uIntensity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

export class GodRays {
  constructor({ count = 9, width = 2.4, length = 24, radius = 17, color = 0xdff6ff } = {}) {
    const pos = new Float32Array(count * 4 * 3);   // unused but required by three
    const local = new Float32Array(count * 4 * 2);
    const params = new Float32Array(count * 4 * 3);
    const idx = new Uint16Array(count * 6);
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const rad = radius * (0.45 + Math.random() * 0.75);
      const ws = 0.55 + Math.random() * 1.1;
      const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        local[v * 2] = corners[c][0];
        local[v * 2 + 1] = corners[c][1];
        params[v * 3] = ang; params[v * 3 + 1] = rad; params[v * 3 + 2] = ws;
      }
      const o = i * 6, v0 = i * 4;
      idx[o] = v0; idx[o + 1] = v0 + 1; idx[o + 2] = v0 + 2;
      idx[o + 3] = v0; idx[o + 4] = v0 + 2; idx[o + 5] = v0 + 3;
    }
    const geo = this.geometry = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aLocal', new THREE.BufferAttribute(local, 2));
    geo.setAttribute('aParams', new THREE.BufferAttribute(params, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0.3, 0.92, 0.25).normalize() },
        uCenter: { value: new THREE.Vector3() },
        uSeaLevel: { value: 0 },
        uWidth: { value: width },
        uLength: { value: length },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: 0.3 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'fx-godrays';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  setSun(v) { this.material.uniforms.uSunDir.value.copy(v).normalize(); }
  setIntensity(v) { this.material.uniforms.uIntensity.value = Math.max(0, Math.min(0.6, v)); }

  update(time, camPos, seaLevel) {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uCenter.value.copy(camPos);
    u.uSeaLevel.value = seaLevel;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
