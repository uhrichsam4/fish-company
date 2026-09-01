/**
 * FishMesh — procedural, stylized fish meshes built entirely from THREE
 * primitives. No model files, no textures.
 *
 * Conventions for every group this module returns:
 *   +X = forward (nose)   +Y = up   +Z = the fish's left side
 *   Overall length is normalised to exactly 1.0, so callers do
 *   `group.scale.setScalar(lengthMetres)` and nothing else.
 *
 * Colour lives in vertex colours so a single MeshStandardMaterial can serve
 * the whole fish (and be shared between fish with the same glow bucket).
 */

import * as THREE from 'three';
import { TAU, clamp01, lerp, smoothstep, valueNoise2, fbm2, makeRNG } from '../util/math.js';

/** Every `species.body` key fishData.js is allowed to use. */
export const BODY_ARCHETYPES = [
  'sardine', 'bass', 'catfish', 'trout', 'eel', 'flatfish', 'pufferfish',
  'squid', 'octopus', 'crab', 'shark', 'tuna', 'marlin', 'ray', 'sunfish',
  'anglerfish', 'oarfish', 'isopod', 'jellyfish', 'nautilus', 'leviathan',
  'worm', 'junk_boot', 'junk_can', 'junk_weed',
];

const FALLBACK_BODY = 'bass';

// ===========================================================================
// Low-level geometry helpers
// ===========================================================================

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _box = new THREE.Box3();
const _vec = new THREE.Vector3();

/** Attach the scalar attributes the painter reads. Missing ones default to 0. */
function tagGeo(geo, kind, { aT, aV, aU } = {}) {
  const n = geo.attributes.position.count;
  geo.userData.kind = kind;
  if (!geo.getAttribute('aT')) geo.setAttribute('aT', new THREE.Float32BufferAttribute(aT || new Float32Array(n), 1));
  if (!geo.getAttribute('aV')) geo.setAttribute('aV', new THREE.Float32BufferAttribute(aV || new Float32Array(n), 1));
  if (!geo.getAttribute('aU')) geo.setAttribute('aU', new THREE.Float32BufferAttribute(aU || new Float32Array(n), 1));
  return geo;
}

/**
 * Swept elliptical tube — the workhorse for every fish body.
 *
 * `spec.r/h/w/y/z` are functions of t (0 = nose, 1 = tail).
 * Returns geometry plus userData.rings describing each ring's vertex span.
 */
function buildLatheBody(spec, rings, radial) {
  const { r, h = () => 1, w = () => 1, y = () => 0, z = () => 0, nose = 0.5, len = 1, ridge = 0, ridgeFreq = 12 } = spec;
  const R = rings, M = radial;
  const vCount = R * M + 2;
  const pos = new Float32Array(vCount * 3);
  const aT = new Float32Array(vCount);
  const aV = new Float32Array(vCount);
  const aU = new Float32Array(vCount);
  const idx = [];
  const ringInfo = [];

  let p = 0;
  for (let i = 0; i < R; i++) {
    const t = i / (R - 1);
    const x = nose - t * len;
    const cy = y(t), cz = z(t);
    let rad = r(t);
    if (ridge) rad *= 1 + ridge * Math.sin(t * ridgeFreq * Math.PI);
    const ry = Math.max(1e-4, rad * h(t));
    const rz = Math.max(1e-4, rad * w(t));
    ringInfo.push({ index: i, t, x, ry, rz, y: cy, z: cz, vertexStart: i * M, vertexCount: M });
    for (let j = 0; j < M; j++) {
      const a = (j / M) * TAU;
      pos[p * 3] = x;
      pos[p * 3 + 1] = cy + Math.sin(a) * ry;
      pos[p * 3 + 2] = cz + Math.cos(a) * rz;
      aT[p] = t;
      aV[p] = 0.5 + 0.5 * Math.sin(a);
      aU[p] = j / M;
      p++;
    }
  }
  // Cap centres.
  const noseIdx = p, tailIdx = p + 1;
  pos[p * 3] = nose + r(0) * 0.55; pos[p * 3 + 1] = y(0); pos[p * 3 + 2] = z(0);
  aT[p] = 0; aV[p] = 0.5; aU[p] = 0; p++;
  pos[p * 3] = nose - len - r(1) * 0.4; pos[p * 3 + 1] = y(1); pos[p * 3 + 2] = z(1);
  aT[p] = 1; aV[p] = 0.5; aU[p] = 0;

  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M;
      const a = i * M + j, b = i * M + j2, c = (i + 1) * M + j, d = (i + 1) * M + j2;
      idx.push(a, b, c, b, d, c);
    }
  }
  for (let j = 0; j < M; j++) {
    const j2 = (j + 1) % M;
    idx.push(noseIdx, j2, j);
    const base = (R - 1) * M;
    idx.push(tailIdx, base + j, base + j2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  tagGeo(geo, 'body', { aT, aV, aU });
  geo.computeVertexNormals();
  geo.userData.rings = ringInfo;
  geo.userData.noseX = nose;
  geo.userData.tailX = nose - len;
  return geo;
}

/**
 * Thin tapered fin from a rim outline. The polygon is fanned from its root at
 * the local origin, so rotating the mesh swishes about the attachment point.
 * `rim` is [[x,y], ...] ordered around the outline, root excluded.
 */
function buildFin(rim, thickness = 0.012, tipThin = 0.8) {
  const n = rim.length;
  let maxD = 1e-5;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = Math.hypot(rim[i][0], rim[i][1]);
    if (d[i] > maxD) maxD = d[i];
  }
  const vCount = (n + 1) * 2;
  const pos = new Float32Array(vCount * 3);
  const aT = new Float32Array(vCount);
  const half = thickness * 0.5;

  const put = (i, x, y, zz, t) => { pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = zz; aT[i] = t; };
  put(0, 0, 0, half, 0);
  for (let i = 0; i < n; i++) {
    const k = d[i] / maxD;
    put(1 + i, rim[i][0], rim[i][1], half * (1 - tipThin * k), k);
  }
  const off = n + 1;
  put(off, 0, 0, -half, 0);
  for (let i = 0; i < n; i++) {
    const k = d[i] / maxD;
    put(off + 1 + i, rim[i][0], rim[i][1], -half * (1 - tipThin * k), k);
  }

  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    idx.push(0, 1 + i, 2 + i);
    idx.push(off, off + 2 + i, off + 1 + i);
  }
  // Rim wall (and the two root edges) so the fin reads as a solid sliver.
  const ringF = [0, ...Array.from({ length: n }, (_, i) => 1 + i)];
  const ringB = [off, ...Array.from({ length: n }, (_, i) => off + 1 + i)];
  for (let i = 0; i < ringF.length; i++) {
    const a = ringF[i], b = ringF[(i + 1) % ringF.length];
    const c = ringB[i], e = ringB[(i + 1) % ringB.length];
    idx.push(a, c, b, b, c, e);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  tagGeo(geo, 'fin', { aT });
  geo.computeVertexNormals();
  return geo;
}

/** Flat two-sided ribbon along a path (weed, oral arms, trailing filaments). */
function buildRibbon(path, widthFn, segs = 10, axis = 'z') {
  const pos = new Float32Array((segs + 1) * 2 * 3);
  const aT = new Float32Array((segs + 1) * 2);
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const pt = path(t);
    const hw = widthFn(t) * 0.5;
    const a = i * 2, b = i * 2 + 1;
    pos[a * 3] = pt.x; pos[a * 3 + 1] = pt.y + (axis === 'y' ? hw : 0); pos[a * 3 + 2] = pt.z + (axis === 'z' ? hw : 0);
    pos[b * 3] = pt.x; pos[b * 3 + 1] = pt.y - (axis === 'y' ? hw : 0); pos[b * 3 + 2] = pt.z - (axis === 'z' ? hw : 0);
    aT[a] = t; aT[b] = t;
    if (i < segs) idx.push(a, b, a + 2, b, b + 2, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  tagGeo(geo, 'fin', { aT });
  geo.computeVertexNormals();
  return geo;
}

/** Tapered tube along an arbitrary path — tentacles, barbels, stalks, spirals. */
function buildTube(path, radiusFn, segs = 10, radial = 6, up = new THREE.Vector3(0, 1, 0)) {
  const vCount = (segs + 1) * radial + 1;
  const pos = new Float32Array(vCount * 3);
  const aT = new Float32Array(vCount);
  const aV = new Float32Array(vCount);
  const idx = [];
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), tan = new THREE.Vector3();
  const nrm = new THREE.Vector3(), bin = new THREE.Vector3();

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = path(clamp01(t - 0.02)), b = path(clamp01(t + 0.02));
    p0.set(a.x, a.y, a.z); p1.set(b.x, b.y, b.z);
    tan.subVectors(p1, p0);
    if (tan.lengthSq() < 1e-10) tan.set(1, 0, 0);
    tan.normalize();
    nrm.crossVectors(up, tan);
    if (nrm.lengthSq() < 1e-8) nrm.set(0, 0, 1).cross(tan);
    nrm.normalize();
    bin.crossVectors(tan, nrm).normalize();
    const c = path(t);
    const rad = Math.max(1e-4, radiusFn(t));
    for (let j = 0; j < radial; j++) {
      const ang = (j / radial) * TAU;
      const ca = Math.cos(ang) * rad, sa = Math.sin(ang) * rad;
      const k = i * radial + j;
      pos[k * 3] = c.x + nrm.x * ca + bin.x * sa;
      pos[k * 3 + 1] = c.y + nrm.y * ca + bin.y * sa;
      pos[k * 3 + 2] = c.z + nrm.z * ca + bin.z * sa;
      aT[k] = t;
      aV[k] = 0.5 + 0.5 * Math.sin(ang);
    }
  }
  const tip = (segs + 1) * radial;
  const e = path(1);
  pos[tip * 3] = e.x; pos[tip * 3 + 1] = e.y; pos[tip * 3 + 2] = e.z;
  aT[tip] = 1; aV[tip] = 0.5;

  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      const a = i * radial + j, b = i * radial + j2;
      const c = (i + 1) * radial + j, d = (i + 1) * radial + j2;
      idx.push(a, b, c, b, d, c);
    }
  }
  for (let j = 0; j < radial; j++) {
    const j2 = (j + 1) % radial;
    idx.push(tip, segs * radial + j, segs * radial + j2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  tagGeo(geo, 'tube', { aT, aV });
  geo.computeVertexNormals();
  return geo;
}

// --- Fin outline library ---------------------------------------------------

/** Caudal (tail) outlines. Root at (0,0); the fin extends toward -X. */
function tailRim(kind, L, H) {
  switch (kind) {
    case 'lunate': return [
      [0, -0.16 * H], [-0.30 * L, -0.62 * H], [-1.0 * L, -1.0 * H], [-0.88 * L, -0.70 * H],
      [-0.26 * L, -0.07 * H], [-0.26 * L, 0.07 * H], [-0.88 * L, 0.70 * H], [-1.0 * L, 1.0 * H],
      [-0.30 * L, 0.62 * H], [0, 0.16 * H]];
    case 'forked': return [
      [0, -0.20 * H], [-0.52 * L, -0.86 * H], [-0.96 * L, -1.0 * H], [-0.44 * L, -0.12 * H],
      [-0.44 * L, 0.12 * H], [-0.96 * L, 1.0 * H], [-0.52 * L, 0.86 * H], [0, 0.20 * H]];
    case 'square': return [
      [0, -0.30 * H], [-0.80 * L, -1.0 * H], [-0.96 * L, -0.9 * H], [-0.86 * L, 0],
      [-0.96 * L, 0.9 * H], [-0.80 * L, 1.0 * H], [0, 0.30 * H]];
    case 'hetero': return [
      [0, -0.12 * H], [-0.26 * L, -0.30 * H], [-0.46 * L, -0.42 * H], [-0.40 * L, -0.04 * H],
      [-0.50 * L, 0.22 * H], [-0.92 * L, 0.72 * H], [-1.05 * L, 1.05 * H], [-0.86 * L, 0.98 * H],
      [-0.26 * L, 0.38 * H], [0, 0.16 * H]];
    case 'pointed': return [
      [0, -0.42 * H], [-0.55 * L, -0.40 * H], [-1.0 * L, 0], [-0.55 * L, 0.40 * H], [0, 0.42 * H]];
    case 'frill': return [
      [0, -1.0 * H], [-0.9 * L, -0.86 * H], [-0.55 * L, -0.42 * H], [-1.0 * L, -0.05 * H],
      [-1.0 * L, 0.05 * H], [-0.55 * L, 0.42 * H], [-0.9 * L, 0.86 * H], [0, 1.0 * H]];
    case 'paddle': return [
      [0, -0.45 * H], [-0.55 * L, -0.95 * H], [-1.0 * L, -0.55 * H], [-1.05 * L, 0],
      [-1.0 * L, 0.55 * H], [-0.55 * L, 0.95 * H], [0, 0.45 * H]];
    case 'round':
    default: {
      const out = [];
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI;
        out.push([-L * (0.30 + 0.70 * Math.cos(a)), H * Math.sin(a)]);
      }
      return out;
    }
  }
}

/** Dorsal / anal outlines. Root line runs along X; the fin rises in +Y. */
function crestRim(kind, L, H) {
  switch (kind) {
    case 'sail': return [
      [0.52 * L, 0], [0.48 * L, 0.66 * H], [0.26 * L, 1.0 * H], [-0.06 * L, 1.04 * H],
      [-0.34 * L, 0.78 * H], [-0.52 * L, 0.26 * H], [-0.55 * L, 0.02 * H]];
    case 'spiny': return [
      [0.50 * L, 0], [0.42 * L, 0.62 * H], [0.22 * L, 0.92 * H], [0.02 * L, 0.70 * H],
      [-0.16 * L, 0.95 * H], [-0.40 * L, 0.66 * H], [-0.52 * L, 0.06 * H]];
    case 'long': {
      const out = [[0.5 * L, 0]];
      const n = 8;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const x = lerp(0.46, -0.5, u) * L;
        out.push([x, H * (0.72 + 0.28 * Math.sin(u * 9)) * smoothstep(clamp01(u * 5)) * smoothstep(clamp01((1 - u) * 4))]);
      }
      out.push([-0.52 * L, 0]);
      return out;
    }
    case 'ribbon': {
      const out = [[0.5 * L, 0]];
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const x = lerp(0.48, -0.5, u) * L;
        out.push([x, H * (0.55 + 0.45 * Math.sin(u * 13 + 0.6))]);
      }
      out.push([-0.52 * L, 0]);
      return out;
    }
    case 'tall': return [
      [0.45 * L, 0], [0.30 * L, 0.85 * H], [0.0, 1.0 * H], [-0.32 * L, 0.55 * H], [-0.5 * L, 0.02 * H]];
    case 'hook': return [
      [0.46 * L, 0], [0.34 * L, 0.9 * H], [-0.10 * L, 0.86 * H], [-0.48 * L, 0.18 * H], [-0.5 * L, 0]];
    case 'tri':
    default: return [
      [0.48 * L, 0], [0.22 * L, 0.92 * H], [-0.30 * L, 0.62 * H], [-0.5 * L, 0.04 * H]];
  }
}

/** Pectoral / pelvic outlines. Root at (0,0), fin sweeps back (-X) and up (+Y). */
function pecRim(kind, L, H) {
  switch (kind) {
    case 'swept': return [
      [0.22 * L, 0], [0.05 * L, 0.30 * H], [-0.55 * L, 1.0 * H], [-0.85 * L, 0.92 * H], [-0.30 * L, 0.06 * H]];
    case 'wing': return [
      [0.40 * L, 0], [0.24 * L, 0.55 * H], [-0.40 * L, 1.05 * H], [-0.95 * L, 0.85 * H],
      [-0.75 * L, 0.30 * H], [-0.42 * L, 0.02 * H]];
    case 'fan': return [
      [0.20 * L, 0], [0.14 * L, 0.55 * H], [-0.22 * L, 0.95 * H], [-0.62 * L, 0.80 * H], [-0.55 * L, 0.18 * H]];
    case 'leaf':
    default: return [
      [0.20 * L, 0], [0.08 * L, 0.42 * H], [-0.35 * L, 0.92 * H], [-0.66 * L, 0.62 * H], [-0.42 * L, 0.05 * H]];
  }
}

// ===========================================================================
// Archetype specifications
// ===========================================================================

/** Nose→peak→tail radius envelope. `pow` controls how late the taper bites. */
function taper(t, peakAt, noseR, peakR, tailR, pow = 1.7) {
  if (t <= peakAt) return lerp(noseR, peakR, smoothstep(t / Math.max(1e-4, peakAt)));
  const u = (t - peakAt) / Math.max(1e-4, 1 - peakAt);
  return lerp(peakR, tailR, Math.pow(u, pow) * 0.6 + smoothstep(u) * 0.4);
}

const A = {
  sardine: {
    rings: 15, radial: 10, len: 0.86, nose: 0.44,
    r: (t) => taper(t, 0.30, 0.014, 0.088, 0.016, 1.9),
    h: () => 1.18, w: () => 0.66,
    y: (t) => -0.008 * Math.sin(t * Math.PI),
    eyes: { t: 0.11, up: 0.42, out: 0.86, size: 0.030 },
    tail: { kind: 'forked', L: 0.20, H: 0.13, t: 1.0 },
    dorsal: { kind: 'tri', at: 0.44, L: 0.17, H: 0.075 },
    anal: { kind: 'tri', at: 0.72, L: 0.11, H: 0.045 },
    pec: { kind: 'leaf', at: 0.24, L: 0.14, H: 0.09, droop: 0.55 },
  },

  bass: {
    rings: 16, radial: 10, len: 0.82, nose: 0.42,
    r: (t) => taper(t, 0.36, 0.048, 0.152, 0.022, 2.4),
    h: (t) => lerp(1.32, 1.00, smoothstep(t)),
    w: (t) => lerp(0.72, 0.58, t),
    y: (t) => -0.020 * Math.sin(Math.pow(t, 0.8) * Math.PI),
    eyes: { t: 0.13, up: 0.40, out: 0.86, size: 0.036 },
    mouth: { t: 0.03, w: 0.9 },
    tail: { kind: 'forked', L: 0.24, H: 0.17, t: 1.0 },
    dorsal: { kind: 'spiny', at: 0.46, L: 0.42, H: 0.115 },
    anal: { kind: 'tri', at: 0.76, L: 0.16, H: 0.085 },
    pec: { kind: 'leaf', at: 0.28, L: 0.17, H: 0.13, droop: 0.62 },
    pelvic: { kind: 'leaf', at: 0.40, L: 0.11, H: 0.09 },
  },

  trout: {
    rings: 16, radial: 10, len: 0.84, nose: 0.44,
    r: (t) => taper(t, 0.34, 0.024, 0.106, 0.023, 2.0),
    h: () => 1.16, w: () => 0.74,
    y: (t) => -0.012 * Math.sin(t * Math.PI),
    eyes: { t: 0.10, up: 0.40, out: 0.86, size: 0.031 },
    tail: { kind: 'square', L: 0.20, H: 0.15, t: 1.0 },
    dorsal: { kind: 'tri', at: 0.42, L: 0.20, H: 0.09 },
    adipose: { at: 0.80, L: 0.07, H: 0.035 },
    anal: { kind: 'tri', at: 0.76, L: 0.14, H: 0.065 },
    pec: { kind: 'leaf', at: 0.24, L: 0.16, H: 0.11, droop: 0.60 },
    pelvic: { kind: 'leaf', at: 0.50, L: 0.11, H: 0.075 },
  },

  tuna: {
    rings: 16, radial: 10, len: 0.84, nose: 0.44,
    r: (t) => taper(t, 0.36, 0.022, 0.132, 0.014, 2.7),
    h: (t) => lerp(1.14, 1.02, t), w: () => 0.70,
    y: (t) => -0.010 * Math.sin(t * Math.PI),
    eyes: { t: 0.10, up: 0.36, out: 0.88, size: 0.032 },
    tail: { kind: 'lunate', L: 0.20, H: 0.23, t: 1.0 },
    dorsal: { kind: 'tall', at: 0.36, L: 0.18, H: 0.13 },
    dorsal2: { kind: 'hook', at: 0.62, L: 0.10, H: 0.055 },
    anal: { kind: 'hook', at: 0.70, L: 0.10, H: 0.055 },
    pec: { kind: 'swept', at: 0.26, L: 0.26, H: 0.16, droop: 0.45 },
    finlets: { from: 0.70, to: 0.94, n: 6, size: 0.022 },
    keel: true,
  },

  marlin: {
    rings: 17, radial: 10, len: 0.84, nose: 0.34,
    r: (t) => taper(t, 0.28, 0.022, 0.082, 0.010, 2.6),
    h: (t) => lerp(1.42, 1.05, t), w: () => 0.68,
    y: () => 0,
    eyes: { t: 0.08, up: 0.32, out: 0.88, size: 0.028 },
    tail: { kind: 'lunate', L: 0.19, H: 0.22, t: 1.0 },
    dorsal: { t0: 0.16, t1: 0.62, H: 0.24, peak: 0.30 },
    dorsal2: { kind: 'hook', at: 0.76, L: 0.08, H: 0.04 },
    anal: { kind: 'hook', at: 0.70, L: 0.10, H: 0.06 },
    pec: { kind: 'swept', at: 0.22, L: 0.26, H: 0.13, droop: 0.55 },
    bill: { len: 0.34, r: 0.020 },
    keel: true,
  },

  shark: {
    rings: 16, radial: 10, len: 0.88, nose: 0.46,
    r: (t) => taper(t, 0.30, 0.020, 0.118, 0.016, 2.3),
    h: (t) => lerp(0.98, 1.10, t), w: (t) => lerp(0.94, 0.72, t),
    y: (t) => -0.012 * Math.sin(t * Math.PI * 0.9),
    eyes: { t: 0.13, up: 0.30, out: 0.92, size: 0.026 },
    tail: { kind: 'hetero', L: 0.26, H: 0.24, t: 1.0 },
    dorsal: { kind: 'tall', at: 0.42, L: 0.20, H: 0.155 },
    dorsal2: { kind: 'tri', at: 0.76, L: 0.08, H: 0.04 },
    anal: { kind: 'tri', at: 0.80, L: 0.07, H: 0.035 },
    pec: { kind: 'wing', at: 0.28, L: 0.30, H: 0.20, droop: 0.50 },
    gills: 5,
  },

  catfish: {
    rings: 16, radial: 10, len: 0.86, nose: 0.44,
    r: (t) => taper(t, 0.22, 0.060, 0.110, 0.018, 1.6),
    h: (t) => lerp(0.66, 1.45, smoothstep(clamp01(t * 1.25))),
    w: (t) => lerp(1.55, 0.42, smoothstep(clamp01(t * 1.15))),
    y: (t) => -0.014 * Math.sin(t * Math.PI),
    eyes: { t: 0.13, up: 0.70, out: 0.62, size: 0.026 },
    tail: { kind: 'forked', L: 0.19, H: 0.14, t: 1.0 },
    dorsal: { kind: 'tri', at: 0.36, L: 0.14, H: 0.10 },
    anal: { t0: 0.58, t1: 0.95, H: 0.052 },
    pec: { kind: 'fan', at: 0.20, L: 0.17, H: 0.13, droop: 0.62 },
    barbels: 6,
    mouth: { t: 0.02, w: 1.05 },
  },

  eel: {
    rings: 20, radial: 8, len: 0.94, nose: 0.48,
    r: (t) => 0.040 * lerp(0.70, 1.0, smoothstep(clamp01(t * 7))) * lerp(1.0, 0.18, Math.pow(t, 2.6)) + 0.004,
    h: (t) => lerp(1.25, 1.75, t), w: (t) => lerp(1.15, 0.40, t),
    y: () => 0,
    eyes: { t: 0.055, up: 0.40, out: 0.86, size: 0.020 },
    tail: { kind: 'pointed', L: 0.10, H: 0.055, t: 1.0 },
    dorsal: { t0: 0.07, t1: 0.97, H: 0.032, peak: 0.62 },
    anal: { t0: 0.52, t1: 0.96, H: 0.022 },
    mouth: { t: 0.02, w: 1.0 },
    teeth: 8,
  },

  oarfish: {
    rings: 20, radial: 8, len: 0.96, nose: 0.48,
    r: (t) => 0.042 * lerp(0.9, 1.0, smoothstep(clamp01(t * 6))) * lerp(1.0, 0.18, Math.pow(t, 1.8)) + 0.004,
    h: (t) => lerp(2.1, 1.25, t), w: () => 0.30,
    y: () => 0,
    eyes: { t: 0.05, up: 0.36, out: 0.85, size: 0.026 },
    tail: { kind: 'pointed', L: 0.06, H: 0.05, t: 1.0 },
    dorsal: { t0: 0.02, t1: 0.98, H: 0.052, wave: true },
    crest: { n: 4, len: 0.15 },
    filaments: 2,
    pec: { kind: 'leaf', at: 0.12, L: 0.08, H: 0.06, droop: 0.5 },
  },

  flatfish: {
    rings: 15, radial: 10, len: 0.80, nose: 0.42,
    r: (t) => taper(t, 0.44, 0.030, 0.185, 0.030, 1.3),
    h: () => 0.26, w: () => 1.95,
    y: () => 0,
    eyes: { t: 0.16, up: 0.95, out: 0.26, size: 0.028 },
    tail: { kind: 'round', L: 0.15, H: 0.13, t: 1.0, plane: 'h' },
    fringe: { H: 0.055 },
    mouth: { t: 0.03, w: 0.8 },
  },

  pufferfish: {
    rings: 14, radial: 12, len: 0.72, nose: 0.34,
    r: (t) => taper(t, 0.42, 0.075, 0.235, 0.022, 2.3),
    h: (t) => lerp(0.94, 1.02, t), w: () => 0.96,
    y: () => 0,
    eyes: { t: 0.13, up: 0.44, out: 0.80, size: 0.048 },
    tail: { kind: 'round', L: 0.13, H: 0.10, t: 1.0 },
    dorsal: { kind: 'tri', at: 0.74, L: 0.10, H: 0.05 },
    anal: { kind: 'tri', at: 0.80, L: 0.09, H: 0.045 },
    pec: { kind: 'fan', at: 0.30, L: 0.12, H: 0.09, droop: 0.25 },
    spikes: 20,
    mouth: { t: 0.02, w: 0.55 },
  },

  sunfish: {
    rings: 14, radial: 12, len: 0.62, nose: 0.34,
    r: (t) => taper(t, 0.42, 0.055, 0.290, 0.115, 1.1),
    h: (t) => lerp(1.42, 1.30, t), w: (t) => lerp(0.42, 0.30, t),
    y: () => 0,
    eyes: { t: 0.14, up: 0.36, out: 0.86, size: 0.036 },
    tail: { kind: 'frill', L: 0.10, H: 0.30, t: 1.0 },
    dorsal: { kind: 'tall', at: 0.70, L: 0.22, H: 0.44 },
    anal: { kind: 'tall', at: 0.70, L: 0.22, H: 0.40 },
    pec: { kind: 'fan', at: 0.42, L: 0.10, H: 0.08, droop: 0.1 },
    mouth: { t: 0.03, w: 0.45 },
  },

  anglerfish: {
    rings: 15, radial: 11, len: 0.74, nose: 0.38,
    r: (t) => taper(t, 0.22, 0.105, 0.205, 0.014, 0.85),
    h: (t) => lerp(1.00, 1.25, t), w: (t) => lerp(1.16, 0.55, t),
    y: (t) => -0.024 * Math.sin(t * Math.PI * 0.7),
    eyes: { t: 0.15, up: 0.58, out: 0.70, size: 0.034 },
    tail: { kind: 'round', L: 0.15, H: 0.11, t: 1.0 },
    dorsal: { kind: 'tri', at: 0.66, L: 0.13, H: 0.07 },
    anal: { kind: 'tri', at: 0.78, L: 0.10, H: 0.055 },
    pec: { kind: 'fan', at: 0.42, L: 0.13, H: 0.09, droop: 0.45 },
    lure: { base: 0.10, len: 0.30, bulb: 0.045 },
    teeth: 12,
    mouth: { t: 0.02, w: 1.25 },
  },

  leviathan: {
    rings: 18, radial: 11, len: 0.86, nose: 0.44,
    r: (t) => taper(t, 0.20, 0.070, 0.150, 0.020, 1.5),
    h: (t) => lerp(1.05, 1.30, t), w: (t) => lerp(1.05, 0.55, t),
    y: (t) => -0.020 * Math.sin(t * Math.PI * 0.75),
    eyes: { t: 0.12, up: 0.52, out: 0.78, size: 0.034 },
    tail: { kind: 'lunate', L: 0.24, H: 0.26, t: 1.0 },
    dorsal: { kind: 'tri', at: 0.50, L: 0.20, H: 0.09 },
    anal: { kind: 'tri', at: 0.78, L: 0.12, H: 0.06 },
    pec: { kind: 'wing', at: 0.26, L: 0.26, H: 0.17, droop: 0.35 },
    spines: { from: 0.16, to: 0.76, n: 9, size: 0.055 },
    teeth: 12,
    mouth: { t: 0.02, w: 1.15 },
    gills: 4,
  },

  isopod: {
    rings: 16, radial: 10, len: 0.70, nose: 0.34,
    r: (t) => taper(t, 0.40, 0.055, 0.155, 0.055, 1.2),
    h: () => 0.60, w: () => 1.25,
    y: () => 0, ridge: 0.075, ridgeFreq: 15,
    eyes: { t: 0.10, up: 0.62, out: 0.72, size: 0.024 },
    tail: { kind: 'paddle', L: 0.16, H: 0.15, t: 1.0, plane: 'h' },
    legs: { pairs: 7, from: 0.22, to: 0.86, len: 0.11 },
    antennae: 2,
  },

  ray: {
    rings: 13, radial: 10, len: 0.44, nose: 0.30,
    r: (t) => taper(t, 0.45, 0.055, 0.135, 0.045, 1.2),
    h: () => 0.42, w: () => 1.05,
    y: () => 0,
    eyes: { t: 0.20, up: 0.88, out: 0.55, size: 0.026 },
    wings: { span: 0.42, chord: 0.54 },
    whip: { len: 0.52, r: 0.020 },
    lobes: true,
  },

  squid: {
    rings: 14, radial: 10, len: 0.60, nose: 0.48,
    r: (t) => 0.100 * Math.pow(Math.sin(Math.pow(clamp01(t * 1.02), 0.80) * Math.PI * 0.90), 0.85) + 0.006,
    h: () => 1.0, w: () => 0.94,
    y: () => 0,
    eyes: { t: 0.90, up: 0.15, out: 0.98, size: 0.044 },
    mantleFins: { at: 0.20, L: 0.26, H: 0.18 },
    tentacles: { n: 8, len: 0.46, r: 0.022, from: -0.12, spread: 0.075, long: 2 },
  },

  octopus: {
    rings: 13, radial: 11, len: 0.42, nose: 0.48,
    r: (t) => taper(t, 0.45, 0.030, 0.155, 0.115, 1.0),
    h: (t) => lerp(1.05, 0.95, t), w: () => 1.0,
    y: () => 0,
    eyes: { t: 0.86, up: 0.55, out: 0.82, size: 0.045 },
    tentacles: { n: 8, len: 0.62, r: 0.030, from: 0.06, spread: 0.10, curl: 0.9 },
  },

  jellyfish: {
    rings: 14, radial: 12, len: 0.40, nose: 0.46,
    r: (t) => 0.235 * Math.sin(Math.pow(clamp01(t), 0.55) * Math.PI * 0.72) + 0.010,
    h: () => 1.0, w: () => 1.0,
    y: () => 0,
    eyes: null,
    oralArms: 6,
    tentacles: { n: 10, len: 0.56, r: 0.008, from: 0.06, spread: 0.20 },
  },

  nautilus: {
    spiral: { turns: 1.70, r0: 0.050, growth: 3.4, tubeR: 0.052 },
    eyes: { size: 0.026 },
    tentacles: { n: 11, len: 0.26, r: 0.013, spread: 0.055 },
  },

  crab: {
    rings: 12, radial: 12, len: 0.46, nose: 0.24,
    r: (t) => taper(t, 0.45, 0.070, 0.185, 0.075, 1.1),
    h: () => 0.52, w: () => 1.55,
    y: () => 0,
    eyes: { t: 0.10, up: 0.90, out: 0.42, size: 0.026, stalk: 0.055 },
    legs: { pairs: 4, len: 0.30 },
    claws: true,
  },

  worm: {
    rings: 20, radial: 8, len: 0.90, nose: 0.46,
    r: (t) => 0.048 * lerp(0.7, 1.0, smoothstep(clamp01(t * 5))) * lerp(1.0, 0.55, t) + 0.004,
    h: () => 1.0, w: () => 1.0,
    y: () => 0, ridge: 0.11, ridgeFreq: 22,
    eyes: null,
    plume: 9,
  },
};

// ===========================================================================
// Blueprint assembly
// ===========================================================================

/**
 * A blueprint is the shape-only, colour-free description of an archetype.
 * `pieces` are `{ name, geo, kind, pos, rot, scale }`; `name` maps into
 * `group.userData.parts`.
 */
function pushPiece(bp, name, geo, kind, pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
  bp.pieces.push({ name, geo, kind, pos, rot, scale });
  return bp.pieces[bp.pieces.length - 1];
}

/** Radius/height of the body envelope at t, used to hang fins off the surface. */
function envelope(s, t) {
  const r = s.r(t);
  return { x: s.nose - t * s.len, ry: r * (s.h ? s.h(t) : 1), rz: r * (s.w ? s.w(t) : 1), cy: s.y ? s.y(t) : 0 };
}

const EYE_GEO = new THREE.IcosahedronGeometry(1, 0);
const PUPIL_GEO = new THREE.IcosahedronGeometry(1, 0);

function addEyes(bp, s) {
  if (!s.eyes) return;
  const e = s.eyes;
  const env = envelope(s, e.t);
  // Normalise (up, out) onto the cross-section ellipse, then push out a hair
  // so the eyeball always bulges instead of hiding inside the body.
  const m = Math.hypot(e.up, e.out) || 1;
  const up = (e.up / m) * 1.03, out = (e.out / m) * 1.03;
  const y = env.cy + env.ry * up;
  const z = env.rz * out;
  const r = e.size;
  for (const sign of [1, -1]) {
    if (e.stalk) {
      const g = buildTube(
        (t) => ({ x: env.x, y: env.cy + lerp(env.ry * 0.4, y + e.stalk, t), z: z * sign * lerp(0.5, 1, t) }),
        () => r * 0.35, 4, 5,
      );
      pushPiece(bp, null, g, 'main');
      const eg = EYE_GEO.clone().scale(r, r, r).translate(env.x, y + e.stalk, z * sign);
      pushPiece(bp, sign > 0 ? 'eyeL' : 'eyeR', tagGeo(eg, 'eyeball'), 'pupil');
      continue;
    }
    const eg = EYE_GEO.clone().scale(r, r, r * 0.85).translate(env.x, y, z * sign);
    pushPiece(bp, sign > 0 ? 'eyeL' : 'eyeR', tagGeo(eg, 'eyeball'), 'eyeball');
    const pg = PUPIL_GEO.clone().scale(r * 0.56, r * 0.56, r * 0.5)
      .translate(env.x + r * 0.34, y + r * 0.08, z * sign + r * 0.5 * sign);
    pushPiece(bp, null, tagGeo(pg, 'pupil'), 'pupil');
  }
}

function addTail(bp, s) {
  if (!s.tail) return;
  const tl = s.tail;
  const env = envelope(s, tl.t ?? 1);
  const rim = tailRim(tl.kind, tl.L, tl.H);
  const geo = buildFin(rim, 0.010);
  const rot = tl.plane === 'h' ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  pushPiece(bp, 'tail', geo, 'fin', [env.x - s.len * 0.005, env.cy, 0], rot);
}

function addCrest(bp, s, cfg, name, flip = false) {
  if (!cfg) return;
  // Long fins (eel/oarfish/catfish) hug the body outline instead of sitting
  // on a straight root line, otherwise they sink into the fatter head.
  if (cfg.t0 !== undefined) {
    const mid = (cfg.t0 + cfg.t1) * 0.5;
    const e0 = envelope(s, mid);
    const base0 = e0.ry * 0.90;
    const n = 14;
    const rim = [[envelope(s, cfg.t0).x - e0.x, 0]];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const t = lerp(cfg.t0, cfg.t1, u);
      const e = envelope(s, t);
      const wave = cfg.wave ? 0.72 + 0.28 * Math.sin(u * 11 + 0.5) : 1;
      const pk = cfg.peak ?? 0.5;
      const shape = cfg.peak !== undefined
        ? Math.sin(Math.PI * Math.pow(u, Math.log(0.5) / Math.log(pk)))
        : smoothstep(clamp01(u * 6)) * smoothstep(clamp01((1 - u) * 5));
      const h = cfg.H * wave * shape;
      rim.push([e.x - e0.x, e.ry * 0.90 + h - base0]);
    }
    rim.push([envelope(s, cfg.t1).x - e0.x, 0]);
    const geo = buildFin(rim, 0.008);
    const y = flip ? e0.cy - base0 : e0.cy + base0;
    pushPiece(bp, name, geo, 'fin', [e0.x, y, 0], flip ? [Math.PI, 0, 0] : [0, 0, 0]);
    return;
  }
  const env = envelope(s, cfg.at);
  const rim = crestRim(cfg.kind, cfg.L, cfg.H);
  const geo = buildFin(rim, 0.009);
  const y = flip ? env.cy - env.ry * 0.94 : env.cy + env.ry * 0.94;
  pushPiece(bp, name, geo, 'fin', [env.x, y, 0], flip ? [Math.PI, 0, 0] : [0, 0, 0]);
}

function addPec(bp, s) {
  if (!s.pec) return;
  const p = s.pec;
  const env = envelope(s, p.at);
  const rim = pecRim(p.kind, p.L, p.H);
  for (const sign of [1, -1]) {
    const geo = buildFin(rim, 0.008);
    const rx = (Math.PI / 2 - (p.droop ?? 0.25)) * sign;
    pushPiece(bp, sign > 0 ? 'pecL' : 'pecR', geo, 'fin',
      [env.x, env.cy - env.ry * 0.30, env.rz * 0.80 * sign], [rx, 0, 0]);
  }
  if (s.pelvic) {
    const pv = s.pelvic;
    const e2 = envelope(s, pv.at);
    for (const sign of [1, -1]) {
      const geo = buildFin(pecRim(pv.kind, pv.L, pv.H), 0.007);
      pushPiece(bp, sign > 0 ? 'pelvL' : 'pelvR', geo, 'fin',
        [e2.x, e2.cy - e2.ry * 0.82, e2.rz * 0.34 * sign], [(Math.PI * 0.78) * sign, 0, 0]);
    }
  }
}

const CONE_GEO = new THREE.ConeGeometry(1, 1, 5);
CONE_GEO.translate(0, 0.5, 0);

function coneAt(scaleR, scaleH, pos, rot) {
  const g = CONE_GEO.clone().scale(scaleR, scaleH, scaleR);
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  m.setPosition(pos[0], pos[1], pos[2]);
  g.applyMatrix4(m);
  return g;
}

/** Everything that is not a body/fin/eye: barbels, bills, teeth, legs, lures. */
function addExtras(bp, key, s) {
  switch (key) {
    case 'catfish': {
      const env = envelope(s, 0.045);
      const n = s.barbels;
      for (let i = 0; i < n; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const row = Math.floor(i / 2);
        const up = row === 0 ? 0.55 : row === 1 ? -0.15 : -0.55;
        const L = row === 0 ? 0.36 : 0.16;
        const g = buildTube((t) => ({
          x: env.x + t * 0.05 - t * t * L,
          y: env.cy + env.ry * up - t * t * L * 0.55,
          z: env.rz * side * (0.35 + t * 0.55),
        }), (t) => 0.0075 * (1 - 0.85 * t), 5, 5);
        pushPiece(bp, null, g, 'accent');
      }
      break;
    }
    case 'marlin': {
      const env = envelope(s, 0);
      const g = coneAt(s.bill.r, s.bill.len, [env.x - 0.01, env.cy + env.ry * 0.05, 0], [0, 0, -Math.PI / 2]);
      pushPiece(bp, 'bill', tagGeo(g, 'accent'), 'main');
      break;
    }
    case 'anglerfish': {
      const env = envelope(s, s.lure.base);
      const L = s.lure.len;
      const path = (t) => ({
        x: env.x + Math.sin(t * 1.5) * L * 0.72,
        y: env.cy + env.ry * 0.85 + Math.sin(t * Math.PI * 0.78) * L * 0.62,
        z: 0,
      });
      pushPiece(bp, 'lureStalk', buildTube(path, (t) => 0.010 * (1 - 0.45 * t), 7, 5), 'accent');
      const tip = path(1);
      const bg = EYE_GEO.clone().scale(s.lure.bulb, s.lure.bulb, s.lure.bulb).translate(tip.x, tip.y, tip.z);
      pushPiece(bp, 'lure', tagGeo(bg, 'glow'), 'glow');
      break;
    }
    case 'ray': {
      const wr = [
        [0.30, 0], [0.18, 0.36], [-0.06, 0.80], [-0.30, 1.02],
        [-0.46, 1.04], [-0.56, 0.80], [-0.56, 0.44], [-0.40, 0.10],
      ].map(([x, y]) => [x * s.wings.chord, y * s.wings.span * 2]);
      for (const sign of [1, -1]) {
        const geo = buildFin(wr, 0.030, 0.9);
        pushPiece(bp, sign > 0 ? 'pecL' : 'pecR', geo, 'fin',
          [s.nose - s.len * 0.42, 0, s.r(0.45) * s.w(0.45) * 0.72 * sign], [(Math.PI / 2) * sign, 0, 0]);
      }
      const wx = s.nose - s.len;
      pushPiece(bp, 'whip', buildTube(
        (t) => ({ x: wx - t * s.whip.len, y: 0.02 * Math.sin(t * 2.2), z: 0 }),
        (t) => s.whip.r * (1 - 0.9 * t), 8, 5,
      ), 'main');
      if (s.lobes) {
        for (const sign of [1, -1]) {
          const e0 = envelope(s, 0.02);
          const g = buildTube((t) => ({
            x: e0.x + t * 0.09, y: e0.cy - t * 0.02, z: e0.rz * 0.5 * sign * (1 + t * 0.4),
          }), (t) => 0.016 * (1 - 0.35 * t), 4, 5);
          pushPiece(bp, null, g, 'main');
        }
      }
      break;
    }
    case 'pufferfish': {
      const rng = makeRNG(9021);
      for (let i = 0; i < s.spikes; i++) {
        const t = 0.12 + rng() * 0.7;
        const a = rng() * TAU;
        const env = envelope(s, t);
        const y = env.cy + Math.sin(a) * env.ry, z = Math.cos(a) * env.rz;
        // Build along +Y then rotate the spike into the surface normal.
        const dir = new THREE.Vector3(0, Math.sin(a) / Math.max(1e-4, s.h(t)), Math.cos(a) / Math.max(1e-4, s.w(t))).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const g2 = CONE_GEO.clone().scale(0.013, 0.058, 0.013).applyQuaternion(q).translate(env.x, y, z);
        pushPiece(bp, null, tagGeo(g2, 'accent'), 'accent');
      }
      break;
    }
    case 'leviathan': {
      const sp = s.spines;
      for (let i = 0; i < sp.n; i++) {
        const t = lerp(sp.from, sp.to, i / (sp.n - 1));
        const env = envelope(s, t);
        const h = sp.size * (0.55 + 0.45 * Math.sin((i / (sp.n - 1)) * Math.PI));
        const g = CONE_GEO.clone().scale(0.016, h, 0.016)
          .applyMatrix4(new THREE.Matrix4().makeRotationZ(0.35))
          .translate(env.x, env.cy + env.ry * 0.95, 0);
        pushPiece(bp, null, tagGeo(g, 'accent'), 'accent');
      }
      break;
    }
    case 'squid': {
      const mf = s.mantleFins;
      const env = envelope(s, mf.at);
      const rim = [[0.5 * mf.L, 0], [0.30 * mf.L, 0.70 * mf.H], [-0.30 * mf.L, 0.95 * mf.H], [-0.55 * mf.L, 0.25 * mf.H], [-0.5 * mf.L, 0]];
      for (const sign of [1, -1]) {
        const geo = buildFin(rim, 0.012);
        pushPiece(bp, sign > 0 ? 'pecL' : 'pecR', geo, 'fin',
          [env.x, env.cy, env.rz * 0.7 * sign], [(Math.PI / 2) * sign, 0, 0]);
      }
      addTentacles(bp, s.tentacles, s);
      break;
    }
    case 'octopus':
      addTentacles(bp, s.tentacles, s);
      break;
    case 'jellyfish': {
      const rEdge = s.r(1) * 1.0;
      const baseX = s.nose - s.len;
      for (let i = 0; i < s.oralArms; i++) {
        const a = (i / s.oralArms) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const g = buildRibbon((t) => ({
          x: baseX - t * 0.42,
          y: sa * rEdge * 0.34 * (1 - t * 0.35) + Math.sin(t * 5 + i) * 0.02,
          z: ca * rEdge * 0.34 * (1 - t * 0.35),
        }), (t) => 0.075 * (1 - 0.75 * t), 8, i % 2 ? 'y' : 'z');
        pushPiece(bp, null, g, 'fin');
      }
      addTentacles(bp, s.tentacles, s, baseX, rEdge * 0.92);
      break;
    }
    case 'nautilus': {
      const sp = s.spiral;
      const spiralPt = (t) => {
        const ang = -t * sp.turns * TAU;
        const rad = sp.r0 * Math.pow(sp.growth, t * sp.turns);
        return { x: Math.cos(ang) * rad * 1.0, y: Math.sin(ang) * rad, z: 0 };
      };
      const g = buildTube(spiralPt, (t) => sp.tubeR * Math.pow(sp.growth, (t - 1) * sp.turns) * 1.9 + 0.004, 26, 8, new THREE.Vector3(0, 0, 1));
      pushPiece(bp, 'shell', g, 'body');
      const mouth = spiralPt(1);
      const hg = EYE_GEO.clone().scale(0.085, 0.075, 0.075).translate(mouth.x + 0.03, mouth.y, 0);
      pushPiece(bp, 'head', tagGeo(hg, 'belly'), 'belly');
      for (const sign of [1, -1]) {
        const eg = EYE_GEO.clone().scale(s.eyes.size, s.eyes.size, s.eyes.size)
          .translate(mouth.x + 0.04, mouth.y + 0.02, 0.055 * sign);
        pushPiece(bp, sign > 0 ? 'eyeL' : 'eyeR', tagGeo(eg, 'pupil'), 'pupil');
      }
      const tc = s.tentacles;
      bp.tentacleNames = [];
      for (let i = 0; i < tc.n; i++) {
        const a = ((i / tc.n) * TAU) + 0.3;
        const rad = 0.055;
        const g2 = buildTube((t) => ({
          x: mouth.x + 0.03 + t * tc.len,
          y: mouth.y + Math.sin(a) * rad * (0.5 + t * 1.5) - t * t * 0.03,
          z: Math.cos(a) * rad * (0.5 + t * 1.5),
        }), (t) => tc.r * (1 - 0.72 * t) + 0.002, 5, 4);
        const pc = pushPiece(bp, null, g2, 'accent');
        pc.tentacle = true;
      }
      break;
    }
    case 'crab': {
      const half = s.r(0.45) * s.w(0.45);
      const bodyY = 0;
      for (const sign of [1, -1]) {
        for (let i = 0; i < s.legs.pairs; i++) {
          const u = i / (s.legs.pairs - 1);
          const rootX = lerp(0.12, -0.16, u);
          const spread = lerp(0.72, 1.0, u);
          const L = s.legs.len * lerp(1.05, 0.8, u);
          const g = buildTube((t) => {
            const bend = smoothstep(clamp01((t - 0.42) / 0.58));
            return {
              x: rootX - t * L * 0.34 * spread,
              y: bodyY + Math.sin(t * Math.PI * 0.85) * L * 0.30 - bend * L * 0.85,
              z: sign * (half * 0.75 + t * L * 0.92 * spread),
            };
          }, (t) => 0.020 * (1 - 0.6 * t), 5, 4);
          const pc = pushPiece(bp, null, g, 'main');
          pc.leg = true;
        }
        // Claw arm + pincer.
        const armEnd = { x: 0.30, y: -0.03, z: sign * 0.20 };
        const arm = buildTube((t) => ({
          x: lerp(0.16, armEnd.x, t), y: lerp(0, armEnd.y, t) + Math.sin(t * Math.PI) * 0.03,
          z: sign * lerp(half * 0.7, Math.abs(armEnd.z), t),
        }), (t) => lerp(0.032, 0.024, t), 5, 6);
        pushPiece(bp, null, arm, 'main');
        // Palm plus two tapered fingers, slightly open.
        const palm = new THREE.SphereGeometry(1, 8, 5);
        palm.scale(0.085, 0.055, 0.045);
        palm.translate(armEnd.x + 0.04, armEnd.y, armEnd.z);
        pushPiece(bp, sign > 0 ? 'clawL' : 'clawR', tagGeo(palm, 'accent'), 'accent');
        for (const open of [0.30, -0.22]) {
          const f = CONE_GEO.clone().scale(0.024, 0.14, 0.022)
            .applyMatrix4(new THREE.Matrix4().makeRotationZ(-Math.PI / 2 + open))
            .translate(armEnd.x + 0.10, armEnd.y + open * 0.045, armEnd.z);
          pushPiece(bp, null, tagGeo(f, 'accent'), 'accent');
        }
      }
      break;
    }
    case 'isopod': {
      const lg = s.legs;
      for (const sign of [1, -1]) {
        for (let i = 0; i < lg.pairs; i++) {
          const t = lerp(lg.from, lg.to, i / (lg.pairs - 1));
          const env = envelope(s, t);
          const L = lg.len * lerp(1.0, 0.7, i / (lg.pairs - 1));
          const g = buildTube((u) => ({
            x: env.x - u * L * 0.25,
            y: env.cy - u * u * L * 0.85,
            z: sign * (env.rz * 0.85 + u * L * 0.75),
          }), (u) => 0.011 * (1 - 0.55 * u), 4, 3);
          const pc = pushPiece(bp, null, g, 'accent');
          pc.leg = true;
        }
        const e0 = envelope(s, 0.03);
        const ant = buildTube((t) => ({
          x: e0.x + t * 0.22, y: e0.cy + t * 0.035, z: sign * (e0.rz * 0.5 + t * 0.05),
        }), (t) => 0.010 * (1 - 0.7 * t), 5, 4);
        pushPiece(bp, null, ant, 'accent');
      }
      break;
    }
    case 'worm': {
      const env = envelope(s, 0);
      for (let i = 0; i < s.plume; i++) {
        const a = (i / s.plume) * TAU;
        const g = buildTube((t) => ({
          x: env.x + t * 0.14,
          y: env.cy + Math.sin(a) * (0.012 + t * 0.075),
          z: Math.cos(a) * (0.012 + t * 0.075),
        }), (t) => 0.014 * (1 - 0.55 * t), 4, 5);
        const pc = pushPiece(bp, null, g, 'accent');
        pc.tentacle = true;
      }
      break;
    }
    case 'oarfish': {
      const env = envelope(s, 0.03);
      for (let i = 0; i < s.crest.n; i++) {
        const u = i / (s.crest.n - 1);
        const g = buildTube((t) => ({
          x: env.x - u * 0.05 - t * 0.05,
          y: env.cy + env.ry * 0.9 + t * s.crest.len * lerp(1.0, 0.55, u),
          z: 0,
        }), (t) => 0.0085 * (1 - 0.5 * t), 4, 4);
        pushPiece(bp, null, g, 'accent');
      }
      const e2 = envelope(s, 0.14);
      for (const sign of [1, -1]) {
        const g = buildTube((t) => ({
          x: e2.x - t * 0.30, y: e2.cy - e2.ry * 0.9 - t * 0.20, z: sign * e2.rz * 0.5,
        }), (t) => 0.008 * (1 - 0.3 * t), 5, 4);
        pushPiece(bp, null, g, 'accent');
        const pad = buildFin([[0.03, 0.05], [-0.05, 0.075], [-0.10, 0.02], [-0.04, -0.03]], 0.006);
        pushPiece(bp, null, pad, 'fin', [e2.x - 0.30, e2.cy - e2.ry * 0.9 - 0.20, sign * e2.rz * 0.5]);
      }
      break;
    }
    case 'flatfish': {
      // The fin fringe that runs right round a flatfish lying on the bottom.
      for (const sign of [1, -1]) {
        const rim = [];
        const n = 14;
        rim.push([s.nose - 0.10 * s.len, 0]);
        for (let i = 0; i <= n; i++) {
          const t = lerp(0.10, 0.97, i / n);
          const env = envelope(s, t);
          rim.push([env.x, env.rz + s.fringe.H * (0.55 + 0.45 * Math.sin(i * 1.7))]);
        }
        rim.push([s.nose - 0.98 * s.len, 0]);
        const geo = buildFin(rim.map(([x, y]) => [x - (s.nose - 0.5 * s.len), y]), 0.008);
        pushPiece(bp, sign > 0 ? 'pecL' : 'pecR', geo, 'fin',
          [s.nose - 0.5 * s.len, 0, 0], [(Math.PI / 2) * sign, 0, 0]);
      }
      break;
    }
    default: break;
  }

  // Shared sub-features driven by spec flags.
  if (s.finlets) {
    const f = s.finlets;
    for (let i = 0; i < f.n; i++) {
      const t = lerp(f.from, f.to, i / (f.n - 1));
      const env = envelope(s, t);
      for (const sgn of [1, -1]) {
        const g = buildFin([[0, 0], [-f.size * 1.5, f.size * 0.9], [-f.size * 1.7, f.size * 0.2]], 0.005);
        pushPiece(bp, null, g, 'accent',
          [env.x, env.cy + sgn * env.ry * 0.92, 0], sgn > 0 ? [0, 0, 0] : [Math.PI, 0, 0]);
      }
    }
  }
  if (s.keel) {
    const env = envelope(s, 0.88);
    for (const sgn of [1, -1]) {
      const g = new THREE.BoxGeometry(0.10, 0.008, 0.030);
      g.translate(env.x, env.cy, env.rz * 0.7 * sgn);
      pushPiece(bp, null, tagGeo(g, 'accent'), 'accent');
    }
  }
  if (s.teeth) {
    const em = envelope(s, s.mouth ? s.mouth.t : 0.02);
    const eh = envelope(s, 0.14);
    const mw = s.mouth?.w ?? 1;
    const n = s.teeth;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) - 0.5;
      const z = u * eh.rz * 1.6 * mw;
      const top = i % 2 === 0;
      const y = eh.cy + (top ? eh.ry * 0.12 : -eh.ry * 0.52);
      const hgt = 0.034 * (1 - Math.abs(u) * 0.8);
      const g = CONE_GEO.clone().scale(0.009, hgt, 0.009)
        .applyMatrix4(new THREE.Matrix4().makeRotationZ(top ? Math.PI * 0.94 : 0.06))
        .translate(em.x + 0.01, y, z);
      pushPiece(bp, null, tagGeo(g, 'bone'), 'bone');
    }
  }
  if (s.gills) {
    const n = s.gills;
    for (let i = 0; i < n; i++) {
      const t = 0.16 + i * 0.035;
      const env = envelope(s, t);
      for (const sgn of [1, -1]) {
        const g = new THREE.BoxGeometry(0.006, env.ry * 0.85, 0.010);
        g.translate(env.x, env.cy - env.ry * 0.05, env.rz * 0.90 * sgn);
        pushPiece(bp, null, tagGeo(g, 'accent'), 'accent');
      }
    }
  }
  if (s.adipose) {
    const env = envelope(s, s.adipose.at);
    const g = buildFin(crestRim('tri', s.adipose.L, s.adipose.H), 0.006);
    pushPiece(bp, null, g, 'fin', [env.x, env.cy + env.ry * 0.94, 0]);
  }
  if (s.filaments) {
    const env = envelope(s, 0.5);
    for (let i = 0; i < s.filaments; i++) {
      const sgn = i === 0 ? 1 : -1;
      const g = buildTube((t) => ({
        x: env.x - t * 0.06, y: env.cy - env.ry * 0.85 - t * 0.28, z: sgn * 0.012,
      }), (t) => 0.006 * (1 - 0.4 * t), 4, 4);
      pushPiece(bp, null, g, 'accent');
    }
  }
  if (s.mouth) {
    // A dark ellipsoid poking out of the snout reads as a mouth from any angle.
    const em = envelope(s, s.mouth.t);
    const eh = envelope(s, 0.15);
    const w = s.mouth.w;
    const g = EYE_GEO.clone()
      .scale(0.055 * w, eh.ry * 0.30 * w, eh.rz * 1.02 * w)
      .translate(em.x + 0.012, eh.cy - eh.ry * 0.22, 0);
    pushPiece(bp, 'mouth', tagGeo(g, 'dark'), 'dark');
  }
}

function addTentacles(bp, tc, s, baseX = null, baseR = null) {
  if (!tc) return;
  const x0 = baseX !== null ? baseX : (tc.from ?? 0);
  const rBase = baseR !== null ? baseR : (tc.spread ?? 0.08);
  bp.tentacleCount = tc.n;
  for (let i = 0; i < tc.n; i++) {
    const a = (i / tc.n) * TAU + 0.19;
    const ca = Math.cos(a), sa = Math.sin(a);
    const long = tc.long && i < tc.long ? 1.55 : 1.0;
    const L = tc.len * long * (0.85 + 0.3 * ((i * 37) % 7) / 7);
    const curl = tc.curl ?? 0.35;
    const g = buildTube((t) => {
      const spread = rBase * (0.55 + t * (0.9 + curl * Math.sin(t * 2.6)));
      return {
        x: x0 - t * L,
        y: sa * spread + Math.sin(t * 4.1 + i) * L * 0.045 - t * t * L * 0.06,
        z: ca * spread + Math.cos(t * 3.3 + i) * L * 0.035,
      };
    }, (t) => tc.r * long * (1 - 0.88 * Math.pow(t, 0.8)) + 0.0025, 6, 5);
    const pc = pushPiece(bp, null, g, i % 2 ? 'accent' : 'tube');
    pc.tentacle = true;
  }
}

// --- Junk ------------------------------------------------------------------

function buildJunk(key, bp) {
  const add = (g, kind, name = null) => pushPiece(bp, name, tagGeo(g, kind), kind);
  if (key === 'junk_boot') {
    const sole = new THREE.BoxGeometry(0.86, 0.075, 0.32); sole.translate(0.02, -0.30, 0); add(sole, 'accent');
    const heel = new THREE.BoxGeometry(0.20, 0.09, 0.30); heel.translate(-0.30, -0.38, 0); add(heel, 'accent');
    const toe = new THREE.BoxGeometry(0.70, 0.20, 0.29); toe.translate(0.08, -0.15, 0); add(toe, 'main');
    const arch = new THREE.BoxGeometry(0.34, 0.26, 0.28); arch.translate(-0.20, -0.06, 0); add(arch, 'main');
    const shaft = new THREE.BoxGeometry(0.32, 0.56, 0.28); shaft.translate(-0.26, 0.22, 0); add(shaft, 'main');
    const cuff = new THREE.BoxGeometry(0.38, 0.10, 0.33); cuff.translate(-0.26, 0.50, 0); add(cuff, 'belly');
    for (let i = 0; i < 3; i++) {
      const lace = new THREE.BoxGeometry(0.035, 0.035, 0.31);
      lace.translate(-0.12 + i * 0.02, 0.10 + i * 0.16, 0); add(lace, 'accent');
    }
    return;
  }
  if (key === 'junk_can') {
    const body = new THREE.CylinderGeometry(0.26, 0.26, 0.62, 12, 1, true);
    body.rotateZ(Math.PI / 2); add(body, 'main');
    for (const x of [-0.29, 0.29]) {
      const rim = new THREE.CylinderGeometry(0.285, 0.285, 0.05, 12);
      rim.rotateZ(Math.PI / 2); rim.translate(x, 0, 0); add(rim, 'accent');
    }
    const inner = new THREE.CircleGeometry(0.255, 12);
    inner.rotateY(-Math.PI / 2); inner.translate(-0.29, 0, 0); add(inner, 'dark');
    const lid = new THREE.CircleGeometry(0.25, 12);
    lid.rotateY(Math.PI / 2); lid.rotateZ(0.5); lid.translate(0.34, 0.16, 0.04); add(lid, 'belly');
    const label = new THREE.CylinderGeometry(0.268, 0.268, 0.24, 12, 1, true);
    label.rotateZ(Math.PI / 2); label.translate(0.02, 0, 0); add(label, 'accent');
    return;
  }
  // junk_weed
  const rng = makeRNG(4711);
  for (let i = 0; i < 7; i++) {
    const a = rng() * TAU;
    const L = 0.55 + rng() * 0.45;
    const g = buildRibbon((t) => ({
      x: -0.45 + t * L * 1.05,
      y: Math.sin(t * 4.3 + a) * 0.16 * t,
      z: Math.cos(a) * 0.10 + Math.sin(t * 3.1 + a) * 0.13 * t,
    }), (t) => 0.10 * (1 - 0.55 * t) * (0.6 + 0.4 * Math.sin(t * 9)), 9, i % 2 ? 'y' : 'z');
    pushPiece(bp, null, g, i % 3 === 0 ? 'accent' : 'main');
  }
  for (let i = 0; i < 5; i++) {
    const g = EYE_GEO.clone().scale(0.05, 0.05, 0.05)
      .translate(-0.25 + rng() * 0.55, -0.12 + rng() * 0.26, -0.14 + rng() * 0.28);
    pushPiece(bp, null, tagGeo(g, 'belly'), 'belly');
  }
}

// ===========================================================================
// Blueprint cache
// ===========================================================================

const _blueprints = new Map();

function makeBlueprint(key, lowPoly = false) {
  const s = A[key];
  const bp = { key, pieces: [], body: null, spec: s };

  if (lowPoly && (key === 'nautilus' || key.startsWith('junk_'))) {
    // No spine to simplify — a coarse blob is all a distant viewer resolves.
    bp.body = buildLatheBody({
      r: (t) => 0.22 * Math.sin(Math.PI * clamp01(t)) + 0.03,
      h: () => 1, w: () => 1, y: () => 0, z: () => 0, nose: 0.5, len: 1,
    }, 5, 4);
    return bp;
  }
  if (key.startsWith('junk_')) { buildJunk(key, bp); return bp; }
  if (!s) { buildJunk('junk_can', bp); return bp; }

  if (key === 'nautilus') { addExtras(bp, key, s); return bp; }

  const rings = lowPoly ? Math.min(5, s.rings) : s.rings;
  const radial = lowPoly ? 4 : s.radial;
  bp.body = buildLatheBody(s, rings, radial);

  if (lowPoly) {
    if (s.tail) {
      const env = envelope(s, 1);
      const rim = tailRim(s.tail.kind === 'lunate' || s.tail.kind === 'forked' ? 'forked' : 'round', s.tail.L, s.tail.H);
      const geo = buildFin([rim[0], rim[Math.floor(rim.length / 2)], rim[rim.length - 1]], 0.012, 0.3);
      pushPiece(bp, 'tail', geo, 'fin', [env.x, env.cy, 0], s.tail.plane === 'h' ? [Math.PI / 2, 0, 0] : [0, 0, 0]);
    }
    return bp;
  }

  addTail(bp, s);
  addCrest(bp, s, s.dorsal, 'dorsal');
  addCrest(bp, s, s.dorsal2, 'dorsal2');
  addCrest(bp, s, s.anal, 'anal', true);
  addPec(bp, s);
  addEyes(bp, s);
  addExtras(bp, key, s);
  return bp;
}

/**
 * Cached shape-only blueprint for an archetype.
 * @param {string} bodyKey  one of BODY_ARCHETYPES
 * @param {boolean} [lowPoly]
 */
export function getFishGeometryCached(bodyKey, lowPoly = false) {
  const key = (A[bodyKey] || bodyKey.startsWith('junk_')) ? bodyKey : FALLBACK_BODY;
  const ck = lowPoly ? key + '#low' : key;
  let bp = _blueprints.get(ck);
  if (!bp) { bp = makeBlueprint(key, lowPoly); _blueprints.set(ck, bp); }
  return bp;
}

// ===========================================================================
// Painting
// ===========================================================================

function patternFactor(pattern, t, v, u, noise) {
  switch (pattern) {
    case 'stripes': {
      const d = Math.abs(v - 0.60);
      const band = 1 - smoothstep(clamp01((d - 0.03) / 0.10));
      const d2 = Math.abs(v - 0.86);
      const band2 = (1 - smoothstep(clamp01((d2 - 0.02) / 0.07))) * 0.55;
      return clamp01(band + band2) * smoothstep(clamp01(t * 6));
    }
    case 'bands': {
      const s = Math.sin(t * Math.PI * 2 * 4.5);
      const bars = smoothstep(clamp01((s - 0.05) / 0.35));
      return bars * smoothstep(clamp01((v - 0.22) / 0.35));
    }
    case 'spots': {
      const n = valueNoise2(t * 17 + 3.7, v * 6 + u * 9);
      return smoothstep(clamp01((n - 0.63) / 0.13)) * smoothstep(clamp01((v - 0.15) / 0.3));
    }
    case 'mottled':
      return clamp01((noise - 0.42) * 2.1);
    case 'gradient':
      return smoothstep(clamp01((t - 0.42) / 0.55)) * 0.75;
    case 'glow': {
      const n = valueNoise2(t * 22 + 1.3, v * 7 + u * 11);
      const dots = smoothstep(clamp01((n - 0.66) / 0.10));
      const line = 1 - smoothstep(clamp01((Math.abs(v - 0.5) - 0.02) / 0.05));
      return clamp01(dots + line * 0.85);
    }
    default: return 0;
  }
}

function paintGeometry(geo, kind, C, species, variant) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const aT = geo.getAttribute('aT'), aV = geo.getAttribute('aV'), aU = geo.getAttribute('aU');
  const col = new Float32Array(n * 3);
  const tint = variant?.tint ? _c2.set(variant.tint) : null;
  const tintAmt = tint ? 0.75 : 0;

  for (let i = 0; i < n; i++) {
    const t = aT ? aT.getX(i) : 0;
    const v = aV ? aV.getX(i) : 0.5;
    const u = aU ? aU.getX(i) : 0;

    switch (kind) {
      case 'body': {
        const b = smoothstep(clamp01((v - 0.26) / 0.34));
        _c1.copy(C.belly).lerp(C.main, b);
        const noise = fbm2(t * 9 + 1.7, (v * 3 + u * 5) * 1.6, 3);
        const p = patternFactor(species.pattern, t, v, u, noise);
        if (p > 0) _c1.lerp(C.accent, p * (species.pattern === 'glow' ? 0.92 : 0.72));
        // Counter-shading: darker along the back, a touch brighter at the belly.
        const shade = lerp(1.06, 0.80, smoothstep(clamp01((v - 0.45) / 0.55)));
        _c1.multiplyScalar(shade);
        break;
      }
      case 'fin':
        _c1.copy(C.fin).lerp(C.accent, clamp01(t) * 0.55);
        break;
      case 'tube':
        _c1.copy(C.main).lerp(C.accent, clamp01(t) * 0.6);
        break;
      case 'accent': _c1.copy(C.accent); break;
      case 'main': _c1.copy(C.main); break;
      case 'belly': _c1.copy(C.belly); break;
      case 'dark': _c1.copy(C.dark); break;
      case 'bone': _c1.copy(C.bone); break;
      case 'eyeball': _c1.copy(C.sclera); break;
      case 'pupil': _c1.copy(C.eye); break;
      case 'glow': _c1.copy(C.accent).multiplyScalar(1.6); break;
      default: _c1.copy(C.main); break;
    }

    if (tint && kind !== 'pupil' && kind !== 'eyeball') _c1.lerp(tint, tintAmt);
    col[i * 3] = _c1.r; col[i * 3 + 1] = _c1.g; col[i * 3 + 2] = _c1.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

// --- Materials -------------------------------------------------------------

const _materials = new Map();

function getMaterial(emissiveHex, intensity) {
  const key = `${emissiveHex}|${intensity.toFixed(2)}`;
  let m = _materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.52,
      metalness: 0.06,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(intensity > 0 ? emissiveHex : 0x000000),
      emissiveIntensity: intensity,
    });
    m.userData.shared = true;
    _materials.set(key, m);
  }
  return m;
}

// ===========================================================================
// Public builder
// ===========================================================================

const _paintCache = new Map();

function paletteFor(species) {
  const c = species.colors;
  const eye = new THREE.Color(c.eye);
  // Glowing-eyed deep-sea fish need a dark socket; dark-eyed fish need a pale
  // one. Either way the pupil has to win against what surrounds it.
  const lum = 0.2126 * eye.r + 0.7152 * eye.g + 0.0722 * eye.b;
  const sclera = lum > 0.25
    ? eye.clone().multiplyScalar(0.05)
    : new THREE.Color('#f6f2e6');
  return {
    main: new THREE.Color(c.main),
    belly: new THREE.Color(c.belly),
    fin: new THREE.Color(c.fin),
    accent: new THREE.Color(c.accent),
    eye,
    sclera,
    bone: new THREE.Color('#f0e8d2'),
    dark: new THREE.Color(c.main).multiplyScalar(0.14),
  };
}

/**
 * Build a fish.
 *
 * @param {object} species  a FISH_SPECIES entry
 * @param {object} [variant] a VARIANTS entry (tint + glow)
 * @param {object} [opts]
 * @param {boolean} [opts.lowPoly]  build the cheap LOD shape
 * @param {number}  [opts.glow]     override total emissive amount
 * @param {boolean} [opts.deform=true]
 * @returns {THREE.Group} +X forward, total length 1.0
 */
export function buildFishMesh(species, variant = null, opts = {}) {
  const key = BODY_ARCHETYPES.includes(species.body) ? species.body : FALLBACK_BODY;
  const lowPoly = !!opts.lowPoly;
  const bp = getFishGeometryCached(key, lowPoly);
  const C = paletteFor(species);

  const glow = clamp01(opts.glow ?? ((species.glow || 0) + (variant?.glow || 0)));
  const material = getMaterial(species.colors.accent, glow * 1.15);

  const group = new THREE.Group();
  group.name = `fish:${species.id}`;
  const root = new THREE.Group();
  root.name = 'fishRoot';
  group.add(root);

  const parts = { body: null, tail: null, dorsal: null, pecL: null, pecR: null, lure: null, bill: null, tentacles: [] };
  const owned = [];
  const shareKey = `${key}|${species.id}|${variant?.id || 'normal'}|${lowPoly ? 'L' : 'H'}`;
  let shared = _paintCache.get(shareKey);
  if (!shared) {
    shared = new Map();
    _paintCache.set(shareKey, shared);
  }

  // Body: always a private clone so `deform` can write into it.
  if (bp.body) {
    const geo = bp.body.clone();
    geo.userData = {
      kind: 'body',
      rings: bp.body.userData.rings,
      noseX: bp.body.userData.noseX,
      tailX: bp.body.userData.tailX,
    };
    paintGeometry(geo, 'body', C, species, variant);
    owned.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'body';
    root.add(mesh);
    parts.body = mesh;
  }

  for (let i = 0; i < bp.pieces.length; i++) {
    const p = bp.pieces[i];
    let geo = shared.get(i);
    if (!geo) {
      geo = p.geo.clone();
      paintGeometry(geo, p.kind, C, species, variant);
      geo.userData.shared = true;
      shared.set(i, geo);
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
    mesh.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
    if (p.scale !== 1) mesh.scale.setScalar(p.scale);
    if (p.name) { mesh.name = p.name; parts[p.name] = mesh; }
    if (p.tentacle || p.leg) parts.tentacles.push(mesh);
    if (p.name === 'lureStalk') parts.lureStalk = mesh;
    root.add(mesh);
  }
  if (parts.lure === null && parts.lureStalk) parts.lure = parts.lureStalk;

  // --- Normalise to exactly 1.0 metre along X, centred on X/Z. -------------
  root.updateMatrixWorld(true);
  _box.setFromObject(root);
  const sizeX = Math.max(1e-4, _box.max.x - _box.min.x);
  const scale = 1 / sizeX;
  const cx = (_box.max.x + _box.min.x) * 0.5;
  const cz = (_box.max.z + _box.min.z) * 0.5;
  root.scale.setScalar(scale);
  root.position.set(-cx * scale, 0, -cz * scale);
  root.updateMatrixWorld(true);

  group.userData.parts = parts;
  group.userData.species = species.id;
  group.userData.variant = variant?.id || 'normal';
  group.userData.ownedGeometries = owned;
  group.userData.material = material;
  group.userData.root = root;
  group.userData.buildScale = scale;

  // --- Spine + travelling-wave deformation ---------------------------------
  const bodyGeo = parts.body?.geometry;
  if (bodyGeo && bodyGeo.userData.rings) {
    group.userData.spineSegments = bodyGeo.userData.rings.map((r) => ({
      index: r.index, t: r.t, x: (r.x - cx) * scale, y: r.y * scale,
      radiusY: r.ry * scale, radiusZ: r.rz * scale,
      vertexStart: r.vertexStart, vertexCount: r.vertexCount,
    }));
  } else {
    group.userData.spineSegments = [];
  }

  if (bodyGeo && opts.deform !== false) {
    const pos = bodyGeo.attributes.position;
    const base = new Float32Array(pos.array);
    group.userData.basePositions = base;
    const noseX = bodyGeo.userData.noseX ?? 0.5;
    const tailX = bodyGeo.userData.tailX ?? -0.5;
    const span = Math.max(1e-4, noseX - tailX);
    const arr = pos.array;
    const count = pos.count;
    // Fins, barbels and tentacles ride the same wave as the flesh they hang
    // off, so nothing ever detaches from the body mid-stroke.
    const followers = [];
    for (const child of root.children) {
      if (child === parts.body) continue;
      followers.push({ obj: child, x: child.position.x, z: child.position.z });
    }
    const waveAt = (x, time, k, amplitude) => {
      const u = clamp01((noseX - x) / span);            // 0 nose -> 1 tail
      const env = u * u * (0.35 + 0.65 * u);            // barely moves at the head
      return Math.sin(time - x * k) * env * amplitude * span * 0.16;
    };
    group.userData.deform = (time, amplitude = 1, wavelength = 1.4) => {
      const k = TAU / Math.max(0.05, wavelength * span);
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        const x = base[i3];
        arr[i3 + 2] = base[i3 + 2] + waveAt(x, time, k, amplitude);
      }
      pos.needsUpdate = true;
      for (let i = 0; i < followers.length; i++) {
        const f = followers[i];
        f.obj.position.z = f.z + waveAt(f.x, time, k, amplitude);
      }
    };
    group.userData.resetDeform = () => {
      arr.set(base);
      pos.needsUpdate = true;
      for (let i = 0; i < followers.length; i++) followers[i].obj.position.z = followers[i].z;
    };
  } else {
    group.userData.deform = () => {};
    group.userData.resetDeform = () => {};
  }

  return group;
}

/** Free the per-instance geometry of a fish built by `buildFishMesh`. */
export function disposeFishMesh(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isMesh) {
      const g = o.geometry;
      if (g && !g.userData?.shared) g.dispose();
      const m = o.material;
      if (m && !m.userData?.shared) m.dispose();
    }
  });
  group.userData.parts = null;
  group.userData.basePositions = null;
  group.userData.deform = null;
  if (group.parent) group.parent.remove(group);
}

/** `{ high, low }` — `low` is a ~50-triangle stand-in for distant fish. */
export function buildFishLOD(species, variant = null, opts = {}) {
  return {
    high: buildFishMesh(species, variant, opts),
    low: buildFishMesh(species, variant, { ...opts, lowPoly: true, deform: false }),
  };
}

/**
 * Render a fish to a square texture for billboard impostors / UI icons.
 * Returns null without a renderer. The caller owns the returned target.
 */
export function buildImpostorTexture(species, variant = null, renderer = null, size = 128) {
  if (!renderer) return null;
  const group = buildFishMesh(species, variant, { lowPoly: false, deform: false });
  const scene = new THREE.Scene();
  scene.add(group);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x27384a, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(0.6, 1.2, 1.0);
  scene.add(key);

  const cam = new THREE.OrthographicCamera(-0.62, 0.62, 0.62, -0.62, 0.01, 10);
  cam.position.set(0, 0, 3);
  cam.lookAt(0, 0, 0);

  const rt = new THREE.WebGLRenderTarget(size, size, {
    magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true,
  });
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.clear(true, true, true);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prevTarget);

  disposeFishMesh(group);
  rt.texture.userData.renderTarget = rt;   // caller disposes this when done
  return rt.texture;
}

/** Drop every cached blueprint, painted geometry and material. */
export function clearFishCaches() {
  for (const bp of _blueprints.values()) {
    bp.body?.dispose();
    for (const p of bp.pieces) p.geo.dispose();
  }
  _blueprints.clear();
  for (const set of _paintCache.values()) for (const g of set.values()) g.dispose();
  _paintCache.clear();
  for (const m of _materials.values()) m.dispose();
  _materials.clear();
}

/** Rough triangle count of a built fish, for profiling. */
export function countTriangles(group) {
  let n = 0;
  group.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry;
      n += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return Math.round(n);
}
