/**
 * Shared Gerstner wave definition.
 * The GLSL in Ocean.js and the CPU sampler below MUST stay in sync or
 * boats/floats will visibly detach from the surface.
 */

/** [direction.x, direction.z, steepness, wavelength] */
export const WAVE_SETS = {
  // Steepness values are chosen so amplitude (steepness/k) lands on the
  // commented metre value — Gerstner amplitude is NOT the steepness field.
  calm: [
    [1.0, 0.35, 0.0262, 42.0],   // 0.175 m
    [0.7, -1.0, 0.0273, 23.0],   // 0.100 m
    [-0.55, 0.85, 0.0251, 12.5], // 0.050 m
    [0.95, 0.25, 0.0262, 6.0],   // 0.025 m
  ],
  normal: [
    [1.0, 0.35, 0.0524, 42.0],   // 0.35 m
    [0.7, -1.0, 0.0546, 23.0],   // 0.20 m
    [-0.55, 0.85, 0.0503, 12.5], // 0.10 m
    [0.95, 0.25, 0.0524, 6.0],   // 0.05 m
  ],
  rough: [
    [1.0, 0.35, 0.1272, 52.0],   // 1.05 m
    [0.7, -1.0, 0.1183, 27.0],   // 0.51 m
    [-0.55, 0.85, 0.1005, 14.0], // 0.22 m
    [0.95, 0.25, 0.0942, 6.5],   // 0.10 m
  ],
  storm: [
    [1.0, 0.35, 0.2054, 72.0],   // 2.35 m
    [0.7, -1.0, 0.1885, 36.0],   // 1.08 m
    [-0.55, 0.85, 0.1571, 17.0], // 0.42 m
    [0.95, 0.25, 0.1414, 8.0],   // 0.18 m
  ],
};

const G = 9.81;

/** Live wave state; WeatherSystem writes `amplitude` and lerps `waves`. */
export const waveState = {
  waves: WAVE_SETS.normal.map((w) => w.slice()),
  amplitude: 1.0,
  time: 0,
  seaLevel: 0,
};

/** Normalize direction and precompute k/c per wave. */
function prep(w) {
  const len = Math.hypot(w[0], w[1]) || 1;
  const dx = w[0] / len, dz = w[1] / len;
  const k = (2 * Math.PI) / Math.max(0.5, w[3]);
  const c = Math.sqrt(G / k);
  const a = w[2] / k;
  return { dx, dz, k, c, a };
}

/**
 * Surface height at world XZ. Approximates the Gerstner inverse with one
 * fixed-point iteration so buoyancy tracks the rendered crest closely.
 */
export function waterHeightAt(x, z, t = waveState.time) {
  const amp = waveState.amplitude;
  if (amp < 0.001) return waveState.seaLevel;
  let sx = x, sz = z;
  for (let iter = 0; iter < 2; iter++) {
    let dx = 0, dz = 0;
    for (let i = 0; i < waveState.waves.length; i++) {
      const w = prep(waveState.waves[i]);
      const f = w.k * (w.dx * sx + w.dz * sz) - w.c * w.k * t;
      const cs = Math.cos(f);
      dx += w.dx * w.a * cs * amp;
      dz += w.dz * w.a * cs * amp;
    }
    sx = x - dx; sz = z - dz;
  }
  let y = 0;
  for (let i = 0; i < waveState.waves.length; i++) {
    const w = prep(waveState.waves[i]);
    const f = w.k * (w.dx * sx + w.dz * sz) - w.c * w.k * t;
    y += w.a * Math.sin(f) * amp;
  }
  return waveState.seaLevel + y;
}

/** Analytic surface normal at world XZ. */
export function waterNormalAt(x, z, t = waveState.time, out = { x: 0, y: 1, z: 0 }) {
  const amp = waveState.amplitude;
  let bx = 1, by = 0, bz = 0;
  let tx = 0, ty = 0, tz = 1;
  for (let i = 0; i < waveState.waves.length; i++) {
    const w = prep(waveState.waves[i]);
    const f = w.k * (w.dx * x + w.dz * z) - w.c * w.k * t;
    const cs = Math.cos(f) * amp, sn = Math.sin(f) * amp;
    const q = w.a * w.k;
    bx += -q * w.dx * w.dx * sn;
    by += q * w.dx * cs;
    bz += -q * w.dx * w.dz * sn;
    tx += -q * w.dx * w.dz * sn;
    ty += q * w.dz * cs;
    tz += -q * w.dz * w.dz * sn;
  }
  // n = cross(tangentZ, tangentX)
  const nx = ty * bz - tz * by;
  const ny = tz * bx - tx * bz;
  const nz = tx * by - ty * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / l; out.y = Math.abs(ny / l); out.z = nz / l;
  return out;
}

/** Orbital velocity of the water surface — drives float/boat drift. */
export function waterVelocityAt(x, z, t = waveState.time, out = { x: 0, y: 0, z: 0 }) {
  const amp = waveState.amplitude;
  let vx = 0, vy = 0, vz = 0;
  for (let i = 0; i < waveState.waves.length; i++) {
    const w = prep(waveState.waves[i]);
    const f = w.k * (w.dx * x + w.dz * z) - w.c * w.k * t;
    const om = w.c * w.k;
    vx += w.dx * w.a * om * Math.sin(f) * amp;
    vz += w.dz * w.a * om * Math.sin(f) * amp;
    vy += w.a * om * -Math.cos(f) * amp;
  }
  out.x = vx; out.y = vy; out.z = vz;
  return out;
}

/** GLSL source for the same displacement, injected into the ocean shader. */
export const GERSTNER_GLSL = /* glsl */`
uniform vec4 uWaves[4];
uniform float uAmplitude;
uniform float uTime;
const float GRAV = 9.81;

vec3 gerstner(vec2 p, out vec3 tangent, out vec3 binormal) {
  vec3 disp = vec3(0.0);
  tangent = vec3(1.0, 0.0, 0.0);
  binormal = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < 4; i++) {
    vec4 w = uWaves[i];
    vec2 d = normalize(w.xy);
    float k = 6.28318530718 / max(0.5, w.w);
    float c = sqrt(GRAV / k);
    float a = w.z / k;
    float f = k * dot(d, p) - c * k * uTime;
    float cf = cos(f), sf = sin(f);
    float A = a * uAmplitude;
    disp.x += d.x * A * cf;
    disp.z += d.y * A * cf;
    disp.y += A * sf;
    float q = A * k;
    tangent  += vec3(-q * d.x * d.x * sf, q * d.x * cf, -q * d.x * d.y * sf);
    binormal += vec3(-q * d.x * d.y * sf, q * d.y * cf, -q * d.y * d.y * sf);
  }
  return disp;
}
`;
