import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU, clamp, clamp01, lerp, valueNoise2 } from '../../util/math.js';

/**
 * Stylized low-poly rock / terrain-debris props, plus the small geometry
 * toolkit shared by every prop module.
 *
 * The toolkit lives here (rather than in index.js) so vegetation.js and
 * structures.js can use it without a circular import back through index.js.
 *
 * House rules for all prop geometry:
 *  - everything is NON-INDEXED and carries position/normal/uv/color, so any
 *    two pieces can always be fed to mergeGeometries().
 *  - "faceted" is achieved by recomputing normals on non-indexed geometry
 *    (per-face normals) rather than by flatShading on the material, so one
 *    smooth-shaded material can serve faceted rocks and smooth trunks alike.
 *  - colour lives in the vertex-colour attribute; a single shared
 *    MeshStandardMaterial({vertexColors:true}) draws nearly every prop.
 */

// ============================================================================
// RNG
// ============================================================================

/** Accepts makeRNG() output, a bare `()=>float`, or nothing. Always returns a
 *  full-featured rng with .range/.int/.pick/.chance/.sign/.gauss. */
export function asRng(rng) {
  if (typeof rng !== 'function') rng = Math.random;
  if (rng.range && rng.pick && rng.gauss && rng.int && rng.chance && rng.sign) return rng;
  const f = () => rng();
  f.range = (lo, hi) => lo + f() * (hi - lo);
  f.int = (lo, hi) => Math.floor(lo + f() * (hi - lo + 1));
  f.pick = (a) => a[Math.floor(f() * a.length) % a.length];
  f.chance = (p) => f() < p;
  f.sign = () => (f() < 0.5 ? -1 : 1);
  f.gauss = (m = 0, sd = 1) => {
    const u = Math.max(1e-9, f()), v = f();
    return m + clamp(Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v), -3, 3) * sd;
  };
  return f;
}

// ============================================================================
// Materials
// ============================================================================

/** The workhorse: one material for (almost) every prop, driven by vertex colour. */
export function makeSharedPropMaterial(over = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.03, flatShading: false, ...over,
  });
}
/** Same, but forces faceting even on smooth-normal geometry. */
export function makeFlatPropMaterial(over = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.85, metalness: 0.03, flatShading: true, ...over,
  });
}
/**
 * Painted / weathered metal. Deliberately NOT fully metallic: a metalness of
 * ~0.7 renders near-black in any scene without an environment map, which is
 * exactly the sort of scene a stylized game usually has.
 */
export function makeMetalPropMaterial(over = {}) {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.45, metalness: 0.28, flatShading: false, ...over,
  });
}

let _shared = null, _metal = null, _glassCache = null, _iceMat = null, _foliage = null;

/** Lazy singletons used as the default material of every builder. */
export function sharedPropMaterial() {
  if (!_shared) { _shared = makeSharedPropMaterial(); _shared.name = 'prop'; }
  return _shared;
}
export function metalPropMaterial() {
  if (!_metal) { _metal = makeMetalPropMaterial(); _metal.name = 'propMetal'; }
  return _metal;
}
/** Foliage: same look, but rendered double sided is unnecessary because leaf
 *  geometry is built two-sided; kept separate so foliage can be tuned/wind-ed. */
export function foliagePropMaterial() {
  if (!_foliage) { _foliage = makeSharedPropMaterial({ roughness: 0.92 }); _foliage.name = 'propFoliage'; }
  return _foliage;
}
/** Glowing bits (lamp glass, buoy lights, fire glow). Cached per colour. */
export function glowMaterial(color = 0xffd98a, intensity = 1.6) {
  _glassCache ||= new Map();
  const key = `${color}|${intensity}`;
  if (_glassCache.has(key)) return _glassCache.get(key);
  const m = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: new THREE.Color(color), emissiveIntensity: intensity,
    roughness: 0.35, metalness: 0, toneMapped: true,
  });
  m.name = 'propGlow';
  _glassCache.set(key, m);
  return m;
}
export function iceMaterial() {
  if (!_iceMat) {
    _iceMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.28, metalness: 0.0,
      transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide,
    });
    _iceMat.name = 'propIce';
  }
  return _iceMat;
}

// ============================================================================
// Geometry helpers
// ============================================================================

const _tmpC = new THREE.Color();
const _tmpC2 = new THREE.Color();

export function toColor(c) {
  if (c instanceof THREE.Color) return c.clone();
  return new THREE.Color(c);
}

/** Normalise geometry: non-indexed + normals + uv + white colour attribute.
 *  `flat` recomputes per-face normals (faceted look). Idempotent. */
export function prep(geo, flat = false) {
  if (geo.index) geo = geo.toNonIndexed();
  if (!geo.attributes.normal || flat) geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!geo.attributes.color) {
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  // Strip anything else so every geometry has an identical attribute set.
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') geo.deleteAttribute(k);
  }
  geo.clearGroups();
  return geo;
}

/**
 * Write vertex colours.
 * @param {THREE.BufferGeometry} geo
 * @param {number|THREE.Color|Function} color  hex/Color, or fn(x,y,z,nx,ny,nz)->hex|Color
 * @param {object} o
 *   rng          required for any jitter
 *   faceJitter   per-triangle brightness (+/-)
 *   vJitter      per-vertex brightness (+/-)
 *   topColor/topBias  blend toward topColor by upward-facing-ness
 *   ao           darken toward the geometry's bottom (0..1)
 *   dirShade     bake directional shading so silhouettes read (0..0.25)
 */
export function paint(geo, color, o = {}) {
  geo = prep(geo);
  const pos = geo.attributes.position, nrm = geo.attributes.normal, col = geo.attributes.color;
  const n = pos.count;
  const rng = o.rng;
  const fj = o.faceJitter ?? 0, vj = o.vJitter ?? 0, ds = o.dirShade ?? 0, ao = o.ao ?? 0;
  const isFn = typeof color === 'function';
  const base = isFn ? null : toColor(color);
  const topColor = o.topColor != null ? toColor(o.topColor) : null;
  const topBias = o.topBias ?? 0;
  let y0 = 0, y1 = 1;
  if (ao > 0) { geo.computeBoundingBox(); y0 = geo.boundingBox.min.y; y1 = geo.boundingBox.max.y; }
  for (let t = 0; t + 2 < n; t += 3) {
    const fjv = fj > 0 && rng ? (rng() - 0.5) * 2 * fj : 0;
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      if (isFn) { const r = color(x, y, z, nx, ny, nz); if (r instanceof THREE.Color) _tmpC.copy(r); else _tmpC.set(r); }
      else _tmpC.copy(base);
      if (topColor && topBias > 0) _tmpC.lerp(topColor, clamp01((ny - 0.12) / 0.88) * topBias);
      let m = 1 + fjv + (vj > 0 && rng ? (rng() - 0.5) * 2 * vj : 0);
      if (ds > 0) m *= 1 + ds * (0.78 * ny + 0.16 * nx - 0.09 * Math.abs(nz) - 0.06);
      if (ao > 0 && y1 > y0 + 1e-6) m *= lerp(1 - ao, 1, clamp01((y - y0) / (y1 - y0)));
      _tmpC.multiplyScalar(clamp(m, 0.02, 4));
      col.setXYZ(i, _tmpC.r, _tmpC.g, _tmpC.b);
    }
  }
  col.needsUpdate = true;
  return geo;
}

/** Vertical two-tone gradient, plus everything paint() supports. */
export function paintY(geo, low, high, o = {}) {
  geo = prep(geo);
  geo.computeBoundingBox();
  const y0 = o.y0 ?? geo.boundingBox.min.y, y1 = o.y1 ?? geo.boundingBox.max.y;
  const a = toColor(low), b = toColor(high);
  const p = o.pow ?? 1;
  return paint(geo, (x, y) => _tmpC2.copy(a).lerp(b, Math.pow(clamp01((y - y0) / Math.max(1e-6, y1 - y0)), p)), o);
}

/** Transform geometry in place. o: {x,y,z,rx,ry,rz,s(number|[x,y,z])} */
export function xf(geo, o = {}) {
  const s = o.s == null ? [1, 1, 1] : (typeof o.s === 'number' ? [o.s, o.s, o.s] : o.s);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0, o.order || 'YXZ')),
    new THREE.Vector3(s[0], s[1], s[2]),
  );
  geo.applyMatrix4(m);
  return geo;
}

/** Merge a list of prepped geometries into one. Nulls are skipped. */
export function merge(list) {
  const parts = [];
  for (const g of list) if (g && g.attributes && g.attributes.position.count) parts.push(prep(g));
  if (!parts.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    return prep(g);
  }
  if (parts.length === 1) return parts[0];
  const out = mergeGeometries(parts, false);
  if (!out) { console.warn('[props] mergeGeometries failed; returning first part'); return parts[0]; }
  return out;
}

/** Duplicate every triangle with reversed winding + flipped normals. */
export function doubleSide(geo) {
  geo = prep(geo);
  const back = geo.clone();
  for (const key of ['position', 'normal', 'uv', 'color']) {
    const a = back.attributes[key];
    const it = a.itemSize;
    for (let t = 0; t + 2 < a.count; t += 3) {
      for (let c = 0; c < it; c++) {
        const i1 = (t + 1) * it + c, i2 = (t + 2) * it + c;
        const tmp = a.array[i1]; a.array[i1] = a.array[i2]; a.array[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
  const nb = back.attributes.normal;
  for (let i = 0; i < nb.count; i++) nb.setXYZ(i, -nb.getX(i), -nb.getY(i), -nb.getZ(i));
  return merge([geo, back]);
}

// --- primitives (all returned prepped) --------------------------------------
export const box = (w = 1, h = 1, d = 1) => prep(new THREE.BoxGeometry(w, h, d), true);
export const cyl = (rt, rb, h, seg = 8, o = {}) =>
  prep(new THREE.CylinderGeometry(rt, rb, h, seg, o.hSeg || 1, !!o.open), o.flat !== false);
export const cone = (r, h, seg = 8, o = {}) =>
  prep(new THREE.ConeGeometry(r, h, seg, o.hSeg || 1, !!o.open), o.flat !== false);
export const sph = (r, w = 8, h = 6) => prep(new THREE.SphereGeometry(r, w, h), false);
export const ico = (r, detail = 0) => prep(new THREE.IcosahedronGeometry(r, detail), true);
export const dodec = (r, detail = 0) => prep(new THREE.DodecahedronGeometry(r, detail), true);
export const tor = (r, tube, rSeg = 4, tSeg = 8) => prep(new THREE.TorusGeometry(r, tube, rSeg, tSeg), true);
export const plane = (w, h, ws = 1, hs = 1) => prep(new THREE.PlaneGeometry(w, h, ws, hs), false);
export const lathe = (pts, seg = 8, flat = true) => prep(new THREE.LatheGeometry(pts, seg), flat);

/** Convex-ish extruded prism from a 2D footprint (XZ), height h, base at y=0. */
export function prism(footprint, h, o = {}) {
  const N = footprint.length;
  const tops = o.tops || new Array(N).fill(h);
  const P = [], U = [];
  const push = (x, y, z, u, v) => { P.push(x, y, z); U.push(u, v); };
  // sides
  const rows = o.rows || 1;
  for (let i = 0; i < N; i++) {
    const a = footprint[i], b = footprint[(i + 1) % N];
    const ta = tops[i], tb = tops[(i + 1) % N];
    for (let r = 0; r < rows; r++) {
      const t0 = r / rows, t1 = (r + 1) / rows;
      const w0 = o.waist ? o.waist(t0) : 1, w1 = o.waist ? o.waist(t1) : 1;
      const ax0 = a[0] * w0, az0 = a[1] * w0, bx0 = b[0] * w0, bz0 = b[1] * w0;
      const ax1 = a[0] * w1, az1 = a[1] * w1, bx1 = b[0] * w1, bz1 = b[1] * w1;
      const ay0 = ta * t0, ay1 = ta * t1, by0 = tb * t0, by1 = tb * t1;
      push(ax0, ay0, az0, 0, t0); push(bx1, by1, bz1, 1, t1); push(bx0, by0, bz0, 1, t0);
      push(ax0, ay0, az0, 0, t0); push(ax1, ay1, az1, 0, t1); push(bx1, by1, bz1, 1, t1);
    }
  }
  // top fan
  let cx = 0, cz = 0, cy = 0;
  for (let i = 0; i < N; i++) { cx += footprint[i][0]; cz += footprint[i][1]; cy += tops[i]; }
  cx /= N; cz /= N; cy = (cy / N) * (o.crown ?? 1.0);
  const wTop = o.waist ? o.waist(1) : 1;
  for (let i = 0; i < N; i++) {
    const a = footprint[i], b = footprint[(i + 1) % N];
    push(cx * wTop, cy, cz * wTop, 0.5, 0.5);
    push(b[0] * wTop, tops[(i + 1) % N], b[1] * wTop, 1, 1);
    push(a[0] * wTop, tops[i], a[1] * wTop, 0, 1);
  }
  if (o.bottom) {
    for (let i = 0; i < N; i++) {
      const a = footprint[i], b = footprint[(i + 1) % N];
      push(cx, 0, cz, 0.5, 0.5); push(a[0], 0, a[1], 0, 0); push(b[0], 0, b[1], 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.computeVertexNormals();
  return prep(g);
}

/**
 * Swept tube along a polyline with per-point radius (parallel-transport frames).
 * o: {caps:true, smooth:false, twist:0, lobes:0, lobeAmt:0}
 */
export function tube(points, radii, radial = 6, o = {}) {
  const N = points.length;
  const tangents = [];
  for (let i = 0; i < N; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(N - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(b, a);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    tangents.push(t.normalize());
  }
  let nrm = new THREE.Vector3(1, 0, 0);
  if (Math.abs(tangents[0].x) > 0.9) nrm.set(0, 0, 1);
  nrm.crossVectors(tangents[0], nrm);
  if (nrm.lengthSq() < 1e-8) nrm.set(0, 0, 1);
  nrm.normalize();
  const rings = [], normals = [];
  let prevT = tangents[0];
  const axis = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const t = tangents[i];
    axis.crossVectors(prevT, t);
    const s = axis.length();
    if (s > 1e-6) nrm.applyAxisAngle(axis.divideScalar(s), Math.atan2(s, clamp(prevT.dot(t), -1, 1)));
    nrm.addScaledVector(t, -nrm.dot(t));
    if (nrm.lengthSq() < 1e-8) nrm.set(t.y > 0.9 ? 1 : 0, 0, t.y > 0.9 ? 0 : 1);
    nrm.normalize();
    const bin = new THREE.Vector3().crossVectors(t, nrm).normalize();
    const ring = [], rn = [];
    const r = radii[i];
    const tw = (o.twist || 0) * (N > 1 ? i / (N - 1) : 0);
    for (let k = 0; k < radial; k++) {
      const ang = (k / radial) * TAU + tw;
      const lobe = o.lobes ? 1 + (o.lobeAmt ?? 0.12) * Math.cos(ang * o.lobes) : 1;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      ring.push(new THREE.Vector3().copy(points[i]).addScaledVector(nrm, dx * r * lobe).addScaledVector(bin, dy * r * lobe));
      rn.push(new THREE.Vector3().copy(nrm).multiplyScalar(dx * lobe).addScaledVector(bin, dy * lobe).normalize());
    }
    rings.push(ring); normals.push(rn);
    prevT = t;
  }
  const P = [], U = [], Nn = [];
  const smooth = !!o.smooth;
  const push = (v, u, vv, nv) => { P.push(v.x, v.y, v.z); U.push(u, vv); if (smooth) Nn.push(nv.x, nv.y, nv.z); };
  for (let i = 0; i < N - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      const A = rings[i][k], B = rings[i][k2], C = rings[i + 1][k2], D = rings[i + 1][k];
      const na = normals[i][k], nb = normals[i][k2], nc = normals[i + 1][k2], nd = normals[i + 1][k];
      const u0 = k / radial, u1 = (k + 1) / radial, v0 = i / (N - 1), v1 = (i + 1) / (N - 1);
      push(A, u0, v0, na); push(B, u1, v0, nb); push(C, u1, v1, nc);
      push(A, u0, v0, na); push(C, u1, v1, nc); push(D, u0, v1, nd);
    }
  }
  if (o.caps !== false) {
    for (const [idx, flip] of [[0, true], [N - 1, false]]) {
      if (radii[idx] < 1e-4) continue;
      const c = points[idx];
      const cn = tangents[idx].clone().multiplyScalar(flip ? -1 : 1);
      for (let k = 0; k < radial; k++) {
        const k2 = (k + 1) % radial;
        const A = rings[idx][k], B = rings[idx][k2];
        if (flip) { push(c, 0.5, 0.5, cn); push(B, 0, 0, cn); push(A, 1, 0, cn); }
        else { push(c, 0.5, 0.5, cn); push(A, 0, 0, cn); push(B, 1, 0, cn); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  if (smooth && Nn.length === P.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  else g.computeVertexNormals();
  return prep(g);
}

/** Quadratic bezier sample. */
export function qbez(a, b, c, t) {
  const it = 1 - t;
  return new THREE.Vector3(
    it * it * a.x + 2 * it * t * b.x + t * t * c.x,
    it * it * a.y + 2 * it * t * b.y + t * t * c.y,
    it * it * a.z + 2 * it * t * b.z + t * t * c.z,
  );
}
export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Position-hashed pseudo-3D noise: identical for co-located vertices, so
 *  deforming non-indexed meshes never cracks them open. */
export function noise3(x, y, z, s = 0) {
  const a = valueNoise2(x + s, y - s * 0.37);
  const b = valueNoise2(y + s * 1.7 + 11.3, z - s * 0.11);
  const c = valueNoise2(z + s * 2.3 + 5.9, x + s * 0.53);
  return (a + b + c) / 3 - 0.5;
}

/** Push vertices along their radial direction by noise. o:{amp,freq,seed,sharp,axis} */
export function deform(geo, o = {}) {
  const amp = o.amp ?? 0.18, freq = o.freq ?? 1.4, seed = o.seed ?? 0, sharp = o.sharp ?? 0;
  const ax = o.axis || [1, 1, 1];
  const pos = geo.attributes.position;
  const c = o.center || [0, 0, 0];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    v.set(x - c[0], y - c[1], z - c[2]);
    const len = v.length();
    if (len < 1e-6) continue;
    let d = noise3(x * freq, y * freq, z * freq, seed) * 2;
    if (sharp > 0) d = Math.round(d * sharp) / sharp;
    const k = 1 + d * amp;
    pos.setXYZ(i, c[0] + v.x * k * ax[0], c[1] + v.y * k * ax[1], c[2] + v.z * k * ax[2]);
  }
  pos.needsUpdate = true;
  geo.computeBoundingBox();
  return geo;
}

/** Translate geometry so its lowest point sits at y=0 (and optionally centre XZ). */
export function groundIt(geo, centerXZ = false) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  xf(geo, { y: -b.min.y, x: centerXZ ? -(b.min.x + b.max.x) / 2 : 0, z: centerXZ ? -(b.min.z + b.max.z) / 2 : 0 });
  return geo;
}

export function triCount(obj) {
  let n = 0;
  obj.traverse?.((o) => {
    const g = o.geometry;
    if (!g) return;
    const inst = o.isInstancedMesh ? o.count : 1;
    n += ((g.index ? g.index.count : g.attributes.position.count) / 3) * inst;
  });
  if (!obj.traverse && obj.attributes) n = obj.attributes.position.count / 3;
  return Math.round(n);
}

/** Bounds + shadow flags + name. Every builder ends with this. */
export function finish(group, name, extra = {}) {
  group.name = name;
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  let radius = 0.5, height = 1;
  if (isFinite(b.min.x) && isFinite(b.max.x)) {
    const s = b.getSize(new THREE.Vector3());
    radius = Math.max(1e-3, Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z)));
    height = s.y;
  }
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.userData.bounds = { radius, height, min: b.min.clone(), max: b.max.clone(), ...extra };
  group.userData.tris = triCount(group);
  return group;
}

/**
 * Drop zero-area triangles. Lathe poles, cone tips and leaves that taper to a
 * point all leave a few behind; they render as nothing but carry zero-length
 * normals, which is exactly the kind of junk that shows up in a mesh audit.
 * @returns {THREE.BufferGeometry} the same geometry, compacted in place
 */
export function pruneDegenerate(geo, eps = 1e-10) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const keep = [];
  const a = pos.array;
  for (let t = 0; t + 2 < n; t += 3) {
    const i = t * 3;
    const ax = a[i + 3] - a[i], ay = a[i + 4] - a[i + 1], az = a[i + 5] - a[i + 2];
    const bx = a[i + 6] - a[i], by = a[i + 7] - a[i + 1], bz = a[i + 8] - a[i + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    if (cx * cx + cy * cy + cz * cz > eps) keep.push(t);
  }
  if (keep.length * 3 === n) return geo;
  for (const key of Object.keys(geo.attributes)) {
    const attr = geo.attributes[key];
    const it = attr.itemSize;
    const out = new Float32Array(keep.length * 3 * it);
    let w = 0;
    for (const t of keep) {
      for (let k = 0; k < 3; k++) {
        const src = (t + k) * it;
        for (let c = 0; c < it; c++) out[w++] = attr.array[src + c];
      }
    }
    geo.setAttribute(key, new THREE.BufferAttribute(out, it));
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Convenience: geometry -> Mesh with the shared prop material. */
export function meshOf(geo, mat) {
  const m = new THREE.Mesh(pruneDegenerate(prep(geo)), mat || sharedPropMaterial());
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// ============================================================================
// Rock palettes
// ============================================================================

export const ROCK_PALETTES = {
  grey: { base: 0x969da6, top: 0xc9d1d9, low: 0x5c646d, accent: 0x77856f },
  warm: { base: 0xc0a077, top: 0xe8d5ae, low: 0x7e6749, accent: 0xa08a55 },
  volcanic: { base: 0x54505c, top: 0x7d7789, low: 0x2c2932, accent: 0x8a4a3a },
  sand: { base: 0xd9c491, top: 0xf2e4ba, low: 0x9d8757, accent: 0xc9a86a },
  ice: { base: 0x9ad9f0, top: 0xeafaff, low: 0x3f8fbd, accent: 0xc7f0ff },
  moss: { base: 0x848f78, top: 0x9dc271, low: 0x4a5344, accent: 0x6f9b4c },
  coralstone: { base: 0xbfa9a0, top: 0xe6d4c8, low: 0x7a6660, accent: 0xd4816f },
};
const paletteFor = (o, rng, fallback = 'grey') => {
  if (o.palette && ROCK_PALETTES[o.palette]) return ROCK_PALETTES[o.palette];
  if (o.palette && typeof o.palette === 'object') return o.palette;
  return ROCK_PALETTES[fallback];
};

function rockColorFn(pal, opts = {}) {
  const base = toColor(opts.color ?? pal.base), top = toColor(pal.top), low = toColor(pal.low);
  const accent = toColor(pal.accent);
  const mossy = opts.moss ?? 0;
  return (x, y, z, nx, ny, nz) => {
    const t = clamp01((y - (opts.y0 ?? 0)) / Math.max(1e-3, (opts.y1 ?? 1) - (opts.y0 ?? 0)));
    _tmpC2.copy(base).lerp(low, clamp01(1 - t * 2.6) * 0.5);
    _tmpC2.lerp(top, clamp01((ny - 0.2) / 0.8) * (opts.topBias ?? 0.55) * (0.55 + 0.45 * t));
    const veins = valueNoise2(x * 3.1 + 4.2, y * 2.4 - z * 1.7);
    _tmpC2.lerp(accent, clamp01((veins - 0.55) * 1.6) * 0.35);
    if (mossy > 0) _tmpC2.lerp(toColor(0x74a24a), clamp01((ny - 0.35) / 0.65) * mossy * clamp01(veins * 1.4));
    return _tmpC2;
  };
}

// ============================================================================
// Builders
// ============================================================================

/**
 * A single faceted rock.
 * opts: {size, style:'boulder'|'shard'|'flat'|'pillar', palette, color, moss, material}
 */
export function buildRock(rng, opts = {}) {
  rng = asRng(rng);
  const size = opts.size ?? 1;
  const style = opts.style || 'boulder';
  const pal = paletteFor(opts, rng, opts.paletteName || 'grey');
  const seed = rng() * 900;
  let g;
  if (style === 'shard') {
    g = ico(0.5, 0);
    xf(g, { s: [rng.range(0.5, 0.72), rng.range(1.7, 2.5), rng.range(0.5, 0.72)] });
    deform(g, { amp: 0.3, freq: 1.5, seed, sharp: 2 });
    xf(g, { rz: rng.gauss(0, 0.16), rx: rng.gauss(0, 0.14), ry: rng() * TAU });
  } else if (style === 'flat') {
    g = dodec(0.62, 0);
    xf(g, { s: [rng.range(1.15, 1.5), rng.range(0.24, 0.38), rng.range(1.0, 1.35)] });
    deform(g, { amp: 0.24, freq: 1.7, seed, sharp: 3 });
    xf(g, { ry: rng() * TAU, rz: rng.gauss(0, 0.07) });
  } else if (style === 'pillar') {
    const seg = rng.int(5, 7);
    g = cyl(rng.range(0.34, 0.44), rng.range(0.44, 0.55), 2.1, seg, { hSeg: 3 });
    xf(g, { y: 1.05 });
    deform(g, { amp: 0.12, freq: 1.1, seed, sharp: 3, center: [0, 1.05, 0] });
    xf(g, { rz: rng.gauss(0, 0.06), rx: rng.gauss(0, 0.05), ry: rng() * TAU });
  } else {
    g = ico(0.55, opts.lowPoly ? 0 : 1);
    xf(g, { s: [rng.range(1.0, 1.3), rng.range(0.66, 0.92), rng.range(0.95, 1.25)] });
    deform(g, { amp: opts.lowPoly ? 0.34 : 0.24, freq: 1.5, seed, sharp: opts.lowPoly ? 2 : 4 });
    xf(g, { ry: rng() * TAU, rz: rng.gauss(0, 0.1) });
  }
  xf(g, { s: size });
  groundIt(g, true);
  g = prep(g, true);
  g.computeBoundingBox();
  paint(g, rockColorFn(pal, { ...opts, y0: 0, y1: Math.max(0.05, g.boundingBox.max.y) }), {
    rng, faceJitter: 0.075, vJitter: 0.02, dirShade: 0.06,
  });
  const group = new THREE.Group();
  group.add(meshOf(g, opts.material));
  group.userData.style = style;
  return finish(group, 'rock', { style });
}

/** 3-7 rocks arranged naturally, merged into a single draw call. */
export function buildRockCluster(rng, opts = {}) {
  rng = asRng(rng);
  const n = opts.count ?? rng.int(3, 7);
  const lowPoly = opts.lowPoly ?? true;
  const spread = opts.spread ?? (opts.size ?? 1) * 1.5;
  const size = opts.size ?? 1;
  const geos = [];
  for (let i = 0; i < n; i++) {
    const isHero = i === 0;
    const s = size * (isHero ? rng.range(0.85, 1.15) : rng.range(0.3, 0.7));
    const sub = buildRock(rng, {
      ...opts, size: s, lowPoly: lowPoly && !isHero,
      style: isHero ? (opts.style || 'boulder') : rng.pick(['boulder', 'boulder', 'flat', 'shard']),
    });
    const a = (i / n) * TAU + rng.gauss(0, 0.5);
    const r = isHero ? rng.range(0, spread * 0.15) : Math.sqrt(rng()) * spread;
    for (const m of sub.children) {
      const gg = m.geometry;
      xf(gg, { x: Math.cos(a) * r, z: Math.sin(a) * r, y: -rng.range(0, 0.12) * s, ry: rng() * TAU });
      geos.push(gg);
    }
  }
  const group = new THREE.Group();
  group.add(meshOf(merge(geos), opts.material));
  return finish(group, 'rockCluster');
}

/** Large angular cliff-face chunk: a jam of terraced blocks, not one smooth wedge. */
export function buildCliffChunk(rng, opts = {}) {
  rng = asRng(rng);
  const w = opts.width ?? rng.range(4, 7);
  const d = opts.depth ?? w * rng.range(0.5, 0.8);
  const h = opts.height ?? w * rng.range(0.8, 1.3);
  const pal = paletteFor(opts, rng, opts.paletteName || 'grey');
  const parts = [];

  /** One terraced block: irregular n-gon footprint stepped inward with height. */
  const blockAt = (bw, bd, bh, faceDir, rows = 3) => {
    const N = rng.int(6, 8);
    const fp = [], tops = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + rng.gauss(0, 0.1);
      const rr = rng.range(0.68, 1.0);
      fp.push([Math.cos(a) * bw * 0.5 * rr, Math.sin(a) * bd * 0.5 * rr]);
      // a clean tilted crown reads as a sheared slab; random per-vertex heights
      // just make bat-wing spikes.
      const shear = 0.17 * Math.cos(a - faceDir);
      tops.push(bh * (0.92 + shear) * rng.range(0.96, 1.03));
    }
    const steps = [1.07, 1.0, 0.93, 0.87].map((v) => v * (1 + rng.gauss(0, 0.04)));
    const g = prism(fp, bh, {
      tops, rows, crown: 1.0,
      waist: (t) => {
        const i = clamp(Math.floor(t * rows + 1e-6), 0, rows);
        const f = t * rows - i;
        return lerp(steps[i], steps[Math.min(rows, i + 1)], clamp01(f * 4));
      },
    });
    deform(g, { amp: 0.055, freq: 1.5, seed: rng() * 500, sharp: 2, center: [0, bh * 0.5, 0] });
    return g;
  };

  const faceDir = rng() * TAU;
  parts.push(blockAt(w, d, h, faceDir, 3));
  // secondary blocks jammed against the main mass at different heights/angles
  for (let i = 0, n = rng.int(2, 4); i < n; i++) {
    const sc = rng.range(0.4, 0.72);
    const g = blockAt(w * sc, d * sc, h * rng.range(0.45, 0.85), faceDir + rng.gauss(0, 1.1), 2);
    const a = rng() * TAU, r = w * rng.range(0.22, 0.44);
    xf(g, {
      x: Math.cos(a) * r, z: Math.sin(a) * r * (d / w),
      y: h * rng.range(0, 0.35), ry: rng() * TAU, rz: rng.gauss(0, 0.16), rx: rng.gauss(0, 0.12),
    });
    parts.push(g);
  }
  // broken talus at the foot
  for (let i = 0, n = rng.int(3, 6); i < n; i++) {
    const s = rng.range(0.16, 0.4) * w * 0.5;
    const b = ico(s, 0);
    xf(b, { s: [rng.range(1.1, 1.5), rng.range(0.42, 0.7), rng.range(0.9, 1.25)], ry: rng() * TAU });
    deform(b, { amp: 0.3, freq: 2.2, seed: rng() * 400, sharp: 2 });
    const a = rng() * TAU, r = w * rng.range(0.4, 0.68);
    xf(b, { x: Math.cos(a) * r, z: Math.sin(a) * r * (d / w), y: s * rng.range(0.2, 0.55), rz: rng.gauss(0, 0.3), rx: rng.gauss(0, 0.2) });
    parts.push(b);
  }

  let geo = prep(merge(parts), true);
  groundIt(geo, true);
  geo.computeBoundingBox();
  const H = Math.max(0.5, geo.boundingBox.max.y);
  const base = toColor(pal.base), low = toColor(pal.low), top = toColor(pal.top), acc = toColor(pal.accent);
  paint(geo, (x, y, z, nx, ny) => {
    // hard-edged strata: quantised bands with a wandering seam
    const seam = valueNoise2(x * 0.5, z * 0.5) * 1.1;
    const band = Math.floor((y / H) * 7 + seam);
    _tmpC2.copy(base).lerp(low, band % 2 === 0 ? 0.4 : 0.02);
    // coarse block-to-block hue drift so a jam of blocks does not read as one mass
    _tmpC2.lerp(top, clamp01(valueNoise2(x * 0.34 + 17, z * 0.34 - 5) - 0.42) * 0.5);
    _tmpC2.lerp(top, clamp01((ny - 0.15) / 0.85) * 0.72);
    _tmpC2.lerp(acc, clamp01(valueNoise2(x * 2.2 + 9, z * 2.2) - 0.58) * 0.6);
    _tmpC2.lerp(low, clamp01(1 - y / (H * 0.35)) * 0.22);
    return _tmpC2;
  }, { rng, faceJitter: 0.09, vJitter: 0.03, dirShade: 0.05 });
  const group = new THREE.Group();
  group.add(meshOf(geo, opts.material));
  return finish(group, 'cliffChunk');
}

/** Faceted iceberg: opaque crown above the waterline, translucent mass below. */
export function buildIceberg(rng, opts = {}) {
  rng = asRng(rng);
  const s = opts.size ?? rng.range(4, 9);
  const pal = ROCK_PALETTES.ice;
  // --- above water: 2-3 angular peaks
  const above = [];
  const peaks = rng.int(2, 4);
  for (let i = 0; i < peaks; i++) {
    const ph = s * rng.range(0.6, 1.05) * (i === 0 ? 1 : rng.range(0.4, 0.72));
    const pr = s * rng.range(0.2, 0.36);
    const g = cone(pr, ph, rng.int(4, 6));
    xf(g, { y: ph * 0.5 });
    deform(g, { amp: 0.2, freq: 1.0, seed: rng() * 700, sharp: 2, center: [0, ph * 0.4, 0] });
    const a = rng() * TAU, r = i === 0 ? 0 : s * rng.range(0.14, 0.3);
    xf(g, { x: Math.cos(a) * r, y: s * 0.12, z: Math.sin(a) * r, rz: rng.gauss(0, 0.16), rx: rng.gauss(0, 0.14), ry: rng() * TAU });
    above.push(g);
  }
  // skirt at the waterline
  const skirt = dodec(s * 0.52, 0);
  xf(skirt, { s: [1.15, 0.72, 1.05], ry: rng() * TAU });
  deform(skirt, { amp: 0.28, freq: 1.1, seed: rng() * 300, sharp: 2 });
  xf(skirt, { y: s * 0.16, rz: rng.gauss(0, 0.06) });
  above.push(skirt);
  // a broken-off growler beside the main mass
  if (rng.chance(0.7)) {
    const gr = ico(s * rng.range(0.14, 0.24), 0);
    xf(gr, { s: [1.3, 0.8, 1.1] });
    deform(gr, { amp: 0.35, freq: 3, seed: rng() * 200, sharp: 2 });
    const a = rng() * TAU;
    xf(gr, { x: Math.cos(a) * s * 0.85, z: Math.sin(a) * s * 0.85, y: s * 0.03, ry: rng() * TAU });
    above.push(gr);
  }
  let aboveGeo = prep(merge(above), true);
  aboveGeo.computeBoundingBox();
  paint(aboveGeo, (x, y, z, nx, ny) => {
    _tmpC2.copy(toColor(pal.base)).lerp(toColor(pal.top), clamp01(ny * 0.8 + 0.2 + y / (s * 1.5)));
    // deep-blue crevices where the light does not reach
    const crev = clamp01((valueNoise2(x * 1.9, z * 1.9 + y) - 0.5) * 2.4);
    _tmpC2.lerp(toColor(0x2e8fc4), crev * clamp01(1 - ny) * 0.85);
    _tmpC2.lerp(toColor(0x4fa9d6), clamp01(0.3 - y / s) * 0.8);
    return _tmpC2;
  }, { rng, faceJitter: 0.055, dirShade: 0.06 });

  // --- below water: bigger, rounder, translucent
  const below = ico(s * 0.72, 1);
  xf(below, { s: [1.15, 1.5, 1.05] });
  deform(below, { amp: 0.22, freq: 0.95, seed: rng() * 800, sharp: 3 });
  below.computeBoundingBox();
  xf(below, { y: -below.boundingBox.max.y * 0.98 });
  const belowGeo = prep(below, true);
  paintY(belowGeo, 0x1c6f96, 0x8fdcf2, { rng, faceJitter: 0.05, pow: 0.7 });

  const group = new THREE.Group();
  const mAbove = meshOf(aboveGeo, opts.material);
  const mBelow = new THREE.Mesh(belowGeo, opts.iceMaterial || iceMaterial());
  mBelow.castShadow = false; mBelow.receiveShadow = false;
  mBelow.renderOrder = 1;
  group.add(mAbove, mBelow);
  group.userData.above = mAbove;
  group.userData.below = mBelow;
  group.userData.waterline = 0;
  return finish(group, 'iceberg', { waterline: 0 });
}

/** Tall eroded sea stack: flared foot, wave-cut notch, flared crown. */
export function buildSeaStack(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(6, 12);
  const r = opts.radius ?? h * rng.range(0.15, 0.22);
  const pal = paletteFor(opts, rng, opts.paletteName || 'warm');
  const N = 9;
  const pts = [], radii = [];
  const leanX = rng.gauss(0, 0.07) * h, leanZ = rng.gauss(0, 0.07) * h;
  // t -> radius multiplier: splayed foot, undercut notch, taper, flared cap
  const profile = [1.85, 1.12, 0.78, 1.02, 0.94, 0.82, 0.9, 1.16, 0.96];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    pts.push(V(leanX * t * t, h * Math.pow(t, 0.94), leanZ * t * t));
    radii.push(r * profile[i] * (1 + rng.gauss(0, 0.07)));
  }
  let g = tube(pts, radii, 8, { caps: true, twist: rng.gauss(0, 0.35), lobes: 4, lobeAmt: 0.11 });
  deform(g, { amp: 0.11, freq: 1.6, seed: rng() * 600, sharp: 2, center: [0, h * 0.5, 0] });
  g = prep(g, true);
  const base = toColor(pal.base), low = toColor(pal.low), top = toColor(pal.top);
  paint(g, (x, y, z, nx, ny) => {
    const t = clamp01(y / h);
    _tmpC2.copy(base);
    // stacked sediment bands
    const band = Math.floor(t * 9 + valueNoise2(x * 0.9, z * 0.9) * 1.4) % 2;
    _tmpC2.lerp(low, band ? 0.34 : 0.05);
    _tmpC2.lerp(top, clamp01((ny - 0.2) / 0.8) * 0.6);
    // dark wet splash zone at the foot
    _tmpC2.lerp(toColor(0x4a4335), clamp01(1 - t / 0.16) * 0.6);
    // guano streaks + grass cap
    if (t > 0.6) _tmpC2.lerp(toColor(0xf0efe4), clamp01(valueNoise2(x * 3.4, y * 0.7) - 0.66) * 1.8 * (t - 0.6) * 2);
    if (t > 0.88) _tmpC2.lerp(toColor(0x76a349), clamp01((ny - 0.35) / 0.65) * clamp01((t - 0.88) * 9));
    return _tmpC2;
  }, { rng, faceJitter: 0.08, vJitter: 0.03, dirShade: 0.08 });
  const group = new THREE.Group();
  group.add(meshOf(g, opts.material));
  return finish(group, 'seaStack');
}

/** Sun-bleached driftwood log with a couple of snapped stubs. */
export function buildDriftwood(rng, opts = {}) {
  rng = asRng(rng);
  const len = opts.length ?? rng.range(1.6, 3.2);
  const r0 = opts.radius ?? len * rng.range(0.055, 0.085);
  const N = 8;
  const a = V(-len / 2, 0, 0), b = V(0, len * rng.range(0.06, 0.16), rng.gauss(0, len * 0.12)), c = V(len / 2, 0, rng.gauss(0, len * 0.08));
  const pts = [], radii = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    pts.push(qbez(a, b, c, t));
    radii.push(r0 * (1 - 0.42 * t) * (1 + Math.sin(t * 7) * 0.09));
  }
  const parts = [tube(pts, radii, 6, { caps: true })];
  for (let i = 0; i < rng.int(1, 3); i++) {
    const t = rng.range(0.25, 0.8);
    const base = qbez(a, b, c, t);
    const dir = V(rng.gauss(0, 0.7), rng.range(0.3, 1), rng.gauss(0, 0.7)).normalize();
    const L = len * rng.range(0.12, 0.3);
    const sp = [], sr = [];
    for (let k = 0; k < 4; k++) {
      const tt = k / 3;
      sp.push(base.clone().addScaledVector(dir, L * tt).add(V(0, -0.05 * tt * tt * L, 0)));
      sr.push(r0 * 0.5 * (1 - 0.7 * tt));
    }
    parts.push(tube(sp, sr, 5, { caps: true }));
  }
  let g = prep(merge(parts), true);
  groundIt(g, false);
  paint(g, (x, y, z, nx, ny) => {
    const grain = valueNoise2(x * 6.5, (y + z) * 3.1);
    _tmpC2.copy(toColor(0xb9ae9c)).lerp(toColor(0x7d6f5f), grain * 0.85);
    _tmpC2.lerp(toColor(0xe2dbcb), clamp01((ny - 0.2) / 0.8) * 0.55);
    return _tmpC2;
  }, { rng, faceJitter: 0.06, dirShade: 0.07 });
  const group = new THREE.Group();
  group.add(meshOf(g, opts.material));
  return finish(group, 'driftwood');
}

/**
 * Beach scatter kit. Returns InstancedMesh-ready pieces plus a ready-built
 * group of InstancedMeshes for immediate use.
 * @returns {{pieces:{name:string,geometry:THREE.BufferGeometry,matrices:THREE.Matrix4[]}[], group:THREE.Group, userData:object}}
 */
export function buildShellsAndDebris(rng, opts = {}) {
  rng = asRng(rng);
  const scale = opts.scale ?? 1;
  const mat = opts.material || sharedPropMaterial();
  const mk = {};

  // scallop: ribbed half-fan
  {
    const P = [], U = [];
    const segs = 7, R = 0.09 * scale;
    for (let i = 0; i < segs; i++) {
      const a0 = Math.PI * (i / segs), a1 = Math.PI * ((i + 1) / segs);
      const r0 = R * (i % 2 ? 1.0 : 0.9), r1 = R * ((i + 1) % 2 ? 1.0 : 0.9);
      const dome = (a) => 0.035 * scale * Math.sin(a);
      P.push(0, 0.005 * scale, 0); U.push(0.5, 0);
      P.push(Math.cos(a0) * r0, dome(a0), Math.sin(a0) * r0); U.push(0, 1);
      P.push(Math.cos(a1) * r1, dome(a1), Math.sin(a1) * r1); U.push(1, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.computeVertexNormals();
    mk.shell = paint(doubleSide(prep(g)), (x, y, z) => _tmpC2.copy(toColor(0xfbe6d4)).lerp(toColor(0xef9f86), clamp01(Math.abs(x) / (0.09 * scale)) * 0.7), { rng, faceJitter: 0.05 });
  }
  // conch: little twisted spire
  {
    const N = 6, pts = [], radii = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1), a = t * 4.2;
      pts.push(V(Math.cos(a) * 0.03 * scale * (1 - t), t * 0.13 * scale, Math.sin(a) * 0.03 * scale * (1 - t)));
      radii.push(0.05 * scale * (1 - t * 0.85));
    }
    const g = tube(pts, radii, 5, { caps: true });
    mk.conch = paintY(g, 0xf6ddc0, 0xd98a63, { rng, faceJitter: 0.06 });
  }
  // starfish
  {
    const P = [], U = [], arms = 5, R = 0.12 * scale, r = 0.045 * scale;
    for (let i = 0; i < arms * 2; i++) {
      const a0 = (i / (arms * 2)) * TAU, a1 = ((i + 1) / (arms * 2)) * TAU;
      const R0 = i % 2 ? r : R, R1 = i % 2 ? R : r;
      const h0 = i % 2 ? 0.022 * scale : 0.008 * scale, h1 = i % 2 ? 0.008 * scale : 0.022 * scale;
      P.push(0, 0.03 * scale, 0); U.push(0.5, 0.5);
      P.push(Math.cos(a0) * R0, h0, Math.sin(a0) * R0); U.push(0, 1);
      P.push(Math.cos(a1) * R1, h1, Math.sin(a1) * R1); U.push(1, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.computeVertexNormals();
    mk.starfish = paint(doubleSide(prep(g)), (x, y, z) => _tmpC2.copy(toColor(0xff9a3c)).lerp(toColor(0xe0562f), clamp01(Math.hypot(x, z) / (0.12 * scale))), { rng, faceJitter: 0.05 });
  }
  // pebble
  {
    const g = ico(0.055 * scale, 0);
    xf(g, { s: [1.2, 0.62, 1.0] });
    deform(g, { amp: 0.28, freq: 12, seed: rng() * 100, sharp: 2 });
    mk.pebble = paint(prep(g, true), 0x9aa1a8, { rng, faceJitter: 0.14, vJitter: 0.05 });
  }
  // twig
  {
    const N = 5, pts = [], radii = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      pts.push(V(lerp(-0.13, 0.13, t) * scale, Math.sin(t * 3) * 0.012 * scale, Math.sin(t * 2.2) * 0.03 * scale));
      radii.push(0.012 * scale * (1 - t * 0.5));
    }
    mk.twig = paint(tube(pts, radii, 4, { caps: true }), 0x8c7a63, { rng, faceJitter: 0.1 });
  }

  const pieces = [];
  const group = new THREE.Group();
  const perKind = opts.count ?? 14;
  const spread = opts.spread ?? 2.2;
  for (const [name, geometry] of Object.entries(mk)) {
    const matrices = [];
    const n = Math.max(1, Math.round(perKind * (name === 'pebble' ? 1.4 : name === 'starfish' ? 0.3 : 0.8)));
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU, rr = Math.sqrt(rng()) * spread;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.gauss(0, 0.14), rng() * TAU, rng.gauss(0, 0.14))),
        new THREE.Vector3(1, 1, 1).multiplyScalar(rng.range(0.75, 1.35)),
      );
      matrices.push(m);
    }
    pieces.push({ name, geometry, matrices });
    const im = new THREE.InstancedMesh(geometry, mat, matrices.length);
    im.name = name;
    matrices.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    group.add(im);
  }
  finish(group, 'shellsAndDebris');
  return { pieces, group, material: mat, userData: group.userData };
}
