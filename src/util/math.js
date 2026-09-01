import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

/** Frame-rate independent exponential approach. `rate` = fraction remaining after 1 second. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(rate, dt));
export const dampAngle = (a, b, rate, dt) => a + shortestAngle(a, b) * (1 - Math.pow(rate, dt));

export function shortestAngle(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Deterministic 32-bit PRNG (mulberry32). */
export function makeRNG(seed = 1) {
  let a = seed >>> 0 || 1;
  const fn = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.int = (lo, hi) => Math.floor(lo + fn() * (hi - lo + 1));
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length) % arr.length];
  fn.chance = (p) => fn() < p;
  fn.sign = () => (fn() < 0.5 ? -1 : 1);
  /** Gaussian via Box-Muller, clamped to +/-3 sigma. */
  fn.gauss = (mean = 0, sd = 1) => {
    const u = Math.max(1e-9, fn()), v = fn();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
    return mean + clamp(g, -3, 3) * sd;
  };
  fn.seed = (s) => { a = s >>> 0 || 1; };
  return fn;
}

export const rand = makeRNG((Math.random() * 4294967296) >>> 0);
export const rrange = (lo, hi) => lo + Math.random() * (hi - lo);
export const rint = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1));
export const rpick = (arr) => arr[(Math.random() * arr.length) | 0];
export const rchance = (p) => Math.random() < p;
export const rsign = () => (Math.random() < 0.5 ? -1 : 1);

/** Weighted pick. `items` is [{weight, ...}] or use `key` to read the weight. */
export function weightedPick(items, rng = Math.random, key = 'weight') {
  let total = 0;
  for (const it of items) total += (typeof key === 'function' ? key(it) : it[key]) || 0;
  if (total <= 0) return items[(rng() * items.length) | 0] ?? null;
  let r = rng() * total;
  for (const it of items) {
    r -= (typeof key === 'function' ? key(it) : it[key]) || 0;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/**
 * Cheap 2D value noise. Uses an integer bit-mix rather than the classic
 * sin(dot(...)) trick — that one produces visible diagonal banding when the
 * sample grid is regular, which showed up as stripes across the terrain.
 */
export function hash2(x, y) {
  // The +constants avoid the degenerate all-zero input mapping to exactly 0.
  let h = Math.imul((x | 0) + 0x1b873593, 0x27d4eb2d) ^ Math.imul((y | 0) + 0x85ebca6b, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function valueNoise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}
export function fbm2(x, y, octaves = 4, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq) * amp;
    norm += amp; amp *= gain; freq *= lac;
  }
  return sum / norm;
}

// ---- Scratch vectors: avoid per-frame allocations in hot paths. ----
export const _v1 = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _v3 = new THREE.Vector3();
export const _v4 = new THREE.Vector3();
export const _q1 = new THREE.Quaternion();
export const _q2 = new THREE.Quaternion();
export const _m1 = new THREE.Matrix4();
export const _e1 = new THREE.Euler();

export function randomPointInDisc(radius, rng = Math.random) {
  const a = rng() * TAU, r = Math.sqrt(rng()) * radius;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

export function dist2D(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}
export function dist2DSq(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

export function formatMoney(n) {
  const neg = n < 0; n = Math.abs(Math.round(n));
  let s;
  if (n >= 1e12) s = (n / 1e12).toFixed(2).replace(/\.?0+$/, '') + 'T';
  else if (n >= 1e9) s = (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  else if (n >= 1e6) s = (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  else s = n.toLocaleString('en-US');
  return (neg ? '-$' : '$') + s;
}

export function formatMoneyExact(n) {
  const neg = n < 0;
  return (neg ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
}

export function formatWeight(kg) {
  if (kg < 1) return (kg * 1000).toFixed(0) + ' g';
  if (kg < 10) return kg.toFixed(2) + ' kg';
  if (kg < 1000) return kg.toFixed(1) + ' kg';
  return (kg / 1000).toFixed(2) + ' t';
}

export function formatDistance(m) {
  if (m < 1000) return m.toFixed(m < 10 ? 1 : 0) + ' m';
  return (m / 1000).toFixed(2) + ' km';
}

export function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
