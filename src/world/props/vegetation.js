import * as THREE from 'three';
import { TAU, clamp, clamp01, lerp, valueNoise2 } from '../../util/math.js';
import {
  asRng, prep, paint, paintY, xf, merge, doubleSide, box, cyl, cone, sph, ico, tube, qbez, V,
  deform, groundIt, finish, meshOf, toColor, sharedPropMaterial, foliagePropMaterial,
} from './rocks.js';

/**
 * Stylized low-poly vegetation. Everything is vertex-coloured so one shared
 * MeshStandardMaterial draws the whole biome; leaves are built two-sided so no
 * DoubleSide material is required.
 */

const _c = new THREE.Color();
const mix = (a, b, t) => _c.copy(toColor(a)).lerp(toColor(b), clamp01(t));

// ---------------------------------------------------------------------------
// leaf primitives
// ---------------------------------------------------------------------------

/**
 * A pinnate (feather) frond built along +Z, base at the origin: two serrated
 * ribbons either side of a spine that arcs up then droops under gravity.
 * o: {length, width, segs, pitch, droop, fold, serration, taper}
 */
function pinnateFrond(rng, o = {}) {
  const L = o.length ?? 2.4;
  const W = o.width ?? L * 0.17;
  const segs = o.segs ?? 7;
  const pitch = o.pitch ?? 0.55;      // initial rise
  const droop = o.droop ?? 0.95;      // gravity fall-off
  const fold = o.fold ?? 0.35;        // leaflets hang below the rib
  const ser = o.serration ?? 0.32;
  const spine = [], hw = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    spine.push(V(0, L * (pitch * t - droop * t * t * 0.62), L * t * (1 - 0.1 * t * t)));
    hw.push(W * (0.05 + 0.95 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.58)), 0.75)) * (1 - 0.25 * t));
  }
  const P = [], U = [], C = [];
  const rib = toColor(o.ribColor ?? 0x3f7f3e);
  const near = toColor(o.color ?? 0x4fae52);
  const tip = toColor(o.tipColor ?? 0x93d45c);
  const pushV = (v, u, vv, col) => { P.push(v.x, v.y, v.z); U.push(u, vv); C.push(col.r, col.g, col.b); };
  for (const side of [-1, 1]) {
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const A = spine[i], B = spine[i + 1];
      const f0 = i % 2 ? 1 : 1 - ser, f1 = (i + 1) % 2 ? 1 : 1 - ser;
      const sk = (o.skew ?? 0.35) * (L / segs);
      const sk0 = (i % 2 ? 0 : -1) * sk, sk1 = ((i + 1) % 2 ? 0 : -1) * sk;
      const OA = V(A.x + side * hw[i] * f0, A.y - fold * hw[i] * f0, A.z + sk0);
      const OB = V(B.x + side * hw[i + 1] * f1, B.y - fold * hw[i + 1] * f1, B.z + sk1);
      const cA = mix(near, tip, t0).clone(), cB = mix(near, tip, t1).clone();
      const rA = mix(rib, cA, 0.25).clone(), rB = mix(rib, cB, 0.25).clone();
      const j = 1 + rng.gauss(0, 0.045);
      cA.multiplyScalar(j); cB.multiplyScalar(j);
      if (side > 0) {
        pushV(A, 0, t0, rA); pushV(B, 0, t1, rB); pushV(OB, 1, t1, cB);
        pushV(A, 0, t0, rA); pushV(OB, 1, t1, cB); pushV(OA, 1, t0, cA);
      } else {
        pushV(A, 0, t0, rA); pushV(OB, 1, t1, cB); pushV(B, 0, t1, rB);
        pushV(A, 0, t0, rA); pushV(OA, 1, t0, cA); pushV(OB, 1, t1, cB);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  return doubleSide(prep(g));
}

/** A simple curved tapered blade along +Z, base at origin. */
function blade(rng, o = {}) {
  const L = o.length ?? 0.5, W = o.width ?? 0.045, segs = o.segs ?? 2;
  const bend = o.bend ?? 0.55, lean = o.lean ?? 0;
  const P = [], U = [], C = [];
  const c0 = toColor(o.color ?? 0x4e7a35), c1 = toColor(o.tipColor ?? 0xa3cd5c);
  const pt = (t) => V(lean * L * t * t, L * t * (1 - bend * t * 0.55), L * bend * t * t * 0.75);
  const wd = (t) => W * (0.07 + 0.93 * (1 - t)) * (1 - t * 0.2);
  const pushV = (v, u, vv, col) => { P.push(v.x, v.y, v.z); U.push(u, vv); C.push(col.r, col.g, col.b); };
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const A = pt(t0), B = pt(t1), w0 = wd(t0), w1 = wd(t1);
    const cA = mix(c0, c1, t0).clone(), cB = mix(c0, c1, t1).clone();
    pushV(V(A.x - w0, A.y, A.z), 0, t0, cA); pushV(V(A.x + w0, A.y, A.z), 1, t0, cA); pushV(V(B.x + w1, B.y, B.z), 1, t1, cB);
    pushV(V(A.x - w0, A.y, A.z), 0, t0, cA); pushV(V(B.x + w1, B.y, B.z), 1, t1, cB); pushV(V(B.x - w1, B.y, B.z), 0, t1, cB);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  return doubleSide(prep(g));
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

/** Curved-trunk coconut palm. ~550 tris. */
export function buildPalmTree(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(4.5, 7.5);
  const lean = opts.lean ?? rng.gauss(0, 0.16);
  const bendDir = rng() * TAU;
  const r0 = opts.radius ?? h * rng.range(0.028, 0.038);
  const N = 8;
  // curved trunk along a quadratic bezier
  const a = V(0, 0, 0);
  const b = V(Math.cos(bendDir) * h * lean * 0.55, h * 0.5, Math.sin(bendDir) * h * lean * 0.55);
  const c = V(Math.cos(bendDir) * h * lean * 1.7, h, Math.sin(bendDir) * h * lean * 1.7);
  const pts = [], radii = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    pts.push(qbez(a, b, c, t));
    radii.push(r0 * lerp(1.55, 0.72, Math.pow(t, 0.55)) * (1 + Math.sin(t * 11) * 0.055));
  }
  let trunk = tube(pts, radii, 6, { caps: true });
  trunk = paint(trunk, (x, y, z, nx, ny) => {
    const ring = Math.sin(y * 7.2 + valueNoise2(x * 2, z * 2) * 1.6) * 0.5 + 0.5;
    return mix(0xc4a771, 0x8a6f46, ring * 0.55 + clamp01(1 - y / h) * 0.2);
  }, { rng, faceJitter: 0.045, dirShade: 0.1 });

  const tip = pts[N - 1];
  const tangent = pts[N - 1].clone().sub(pts[N - 2]).normalize();
  const crownM = new THREE.Matrix4().compose(
    tip,
    new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), tangent),
    new THREE.Vector3(1, 1, 1),
  );

  const crown = [];
  // collar where the fronds meet the trunk
  const collar = cone(radii[N - 1] * 2.1, radii[N - 1] * 3.2, 6);
  xf(collar, { y: radii[N - 1] * 1.2 });
  crown.push(paint(collar, 0x8f7448, { rng, faceJitter: 0.06 }));
  // coconuts
  const nuts = rng.int(2, 4);
  for (let i = 0; i < nuts; i++) {
    const g = ico(r0 * rng.range(1.5, 2.0), 0);
    xf(g, { s: [1, 0.9, 1] });
    const ang = rng() * TAU, rr = r0 * rng.range(1.5, 2.4);
    xf(g, { x: Math.cos(ang) * rr, z: Math.sin(ang) * rr, y: -r0 * rng.range(0.4, 1.6), ry: rng() * TAU });
    crown.push(paint(g, 0x6d4a2c, { rng, faceJitter: 0.1, topBias: 0.3, topColor: 0x8f6739 }));
  }
  // fronds
  const nf = opts.fronds ?? rng.int(7, 9);
  const fl = h * rng.range(0.55, 0.72);
  const start = rng() * TAU;
  for (let i = 0; i < nf; i++) {
    const ang = start + (i / nf) * TAU + rng.gauss(0, 0.16);
    const f = pinnateFrond(rng, {
      length: fl * rng.range(0.85, 1.15),
      width: fl * rng.range(0.2, 0.27),
      segs: 7,
      pitch: rng.range(0.5, 0.88),
      droop: rng.range(0.95, 1.4),
      fold: rng.range(0.24, 0.4),
      serration: rng.range(0.62, 0.8),
      skew: 0.55,
      color: mix(0x53bd57, 0x6bd05e, rng()).clone(),
      tipColor: mix(0x9ee065, 0xc2ee7c, rng()).clone(),
      ribColor: 0x3f8a41,
    });
    xf(f, { rx: rng.gauss(0, 0.1), ry: ang, y: radii[N - 1] * 1.6 });
    crown.push(f);
  }
  const crownGeo = merge(crown);
  crownGeo.applyMatrix4(crownM);
  const group = new THREE.Group();
  group.add(meshOf(merge([trunk, crownGeo]), opts.material || foliagePropMaterial()));
  return finish(group, 'palmTree', { crownHeight: h });
}

/** Conifer: trunk plus 3-5 stacked cone tiers, with an optional snow dusting. */
export function buildPineTree(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(4, 8);
  const tiers = opts.tiers ?? rng.int(3, 5);
  const snow = opts.snow ?? 0;
  const lean = rng.gauss(0, 0.05);
  const trunkR = h * 0.028;
  const parts = [];
  const trunk = cyl(trunkR * 0.7, trunkR * 1.35, h * 0.95, 6, { hSeg: 1 });
  xf(trunk, { y: h * 0.475 });
  parts.push(paintY(trunk, 0x4c3524, 0x7a5638, { rng, faceJitter: 0.05, dirShade: 0.1 }));
  // root flare
  const flare = cone(trunkR * 2.2, trunkR * 2.4, 6);
  xf(flare, { y: trunkR * 1.2 });
  parts.push(paint(flare, 0x50392a, { rng, faceJitter: 0.07 }));

  const dark = toColor(opts.needleColor ?? 0x276b3f);
  const light = toColor(opts.needleTip ?? 0x63b062);
  const base = h * 0.2;
  for (let i = 0; i < tiers; i++) {
    const t = i / Math.max(1, tiers - 1);
    const y = lerp(base, h * 0.9, t);
    const rr = lerp(h * 0.32, h * 0.065, Math.pow(t, 0.7)) * rng.range(0.94, 1.06);
    const hh = lerp(h * 0.36, h * 0.26, t);
    const g = cone(rr, hh, rng.int(7, 8), { hSeg: 2 });
    // droop the skirt outward
    const pos = g.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const py = pos.getY(k);
      if (py < -hh * 0.2) {
        const f = clamp01((-py - hh * 0.2) / (hh * 0.3));
        pos.setXYZ(k, pos.getX(k) * (1 + f * 0.16), py - f * hh * 0.07, pos.getZ(k) * (1 + f * 0.16));
      }
    }
    deform(g, { amp: 0.055, freq: 3.0, seed: rng() * 400, sharp: 2 });
    xf(g, { y: y + hh * 0.35, x: lean * y, ry: rng() * TAU });
    const geo = prep(g, true);
    paint(geo, (x, yy, z, nx, ny) => {
      const c = mix(dark, light, clamp01((yy - base) / (h - base)) * 0.75 + clamp01(ny) * 0.3).clone();
      if (snow > 0) {
        const patch = 0.45 + 0.55 * valueNoise2(x * 3.4, z * 3.4);
        c.lerp(toColor(0xfbfdff), clamp01(Math.pow(clamp01((ny - 0.4) / 0.6), 1.3) * patch * snow * 1.5));
      }
      return c;
    }, { rng, faceJitter: 0.075, vJitter: 0.025, dirShade: 0.09 });
    parts.push(geo);
  }
  const group = new THREE.Group();
  group.add(meshOf(merge(parts), opts.material || foliagePropMaterial()));
  return finish(group, 'pineTree');
}

/** Clustered flattened icospheres with optional berries. */
export function buildBush(rng, opts = {}) {
  rng = asRng(rng);
  const size = opts.size ?? rng.range(0.7, 1.4);
  const lobes = opts.lobes ?? rng.int(5, 7);
  const dark = toColor(opts.color ?? 0x3f8f31);
  const light = toColor(opts.tipColor ?? 0x9bd554);
  const parts = [];
  for (let i = 0; i < lobes; i++) {
    const s = size * (i === 0 ? rng.range(0.55, 0.7) : rng.range(0.3, 0.55));
    const g = ico(s, 0);
    xf(g, { s: [rng.range(0.9, 1.45), rng.range(0.55, 0.95), rng.range(0.9, 1.4)] });
    deform(g, { amp: 0.3, freq: 3.2, seed: rng() * 300, sharp: 2 });
    const a = (i / lobes) * TAU + rng.gauss(0, 0.6);
    const rr = i === 0 ? 0 : size * rng.range(0.18, 0.5);
    xf(g, { x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: s * rng.range(0.55, 0.9), ry: rng() * TAU });
    parts.push(g);
  }
  let geo = prep(merge(parts), true);
  groundIt(geo, true);
  geo.computeBoundingBox();
  const top = geo.boundingBox.max.y;
  paint(geo, (x, y, z, nx, ny) => mix(dark, light, clamp01(y / top) * 0.6 + clamp01(ny) * 0.45),
    { rng, faceJitter: 0.085, vJitter: 0.03, dirShade: 0.1, ao: 0.25 });
  const all = [geo];
  // leafy sprigs poking out of the mass so the silhouette is not a smooth blob
  if (opts.sprigs !== false) {
    for (let i = 0, n = rng.int(9, 14); i < n; i++) {
      const a = rng() * TAU;
      const rr = size * rng.range(0.3, 0.55);
      const yy = top * rng.range(0.4, 1.0);
      const b2 = blade(rng, {
        length: size * rng.range(0.32, 0.55),
        width: size * rng.range(0.05, 0.085),
        segs: 2,
        bend: rng.range(0.2, 0.55),
        lean: rng.gauss(0, 0.3),
        color: mix(dark, light, rng.range(0.2, 0.6)).clone(),
        tipColor: mix(light, 0xd0ea86, rng() * 0.6).clone(),
      });
      xf(b2, { ry: a + rng.gauss(0, 0.4), rx: rng.gauss(-0.25, 0.25), x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: yy });
      all.push(b2);
    }
  }
  if (opts.berries ?? rng.chance(0.35)) {
    const bc = opts.berryColor ?? rng.pick([0xd9455a, 0xe8792f, 0x8f4fd1]);
    for (let i = 0; i < rng.int(4, 8); i++) {
      const b = ico(size * 0.05, 0);
      const a = rng() * TAU, rr = size * rng.range(0.25, 0.55);
      xf(b, { x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: top * rng.range(0.45, 0.95) });
      all.push(paint(b, bc, { rng, faceJitter: 0.12 }));
    }
  }
  const group = new THREE.Group();
  group.add(meshOf(merge(all), opts.material || foliagePropMaterial()));
  return finish(group, 'bush');
}

/**
 * 5-9 crossed blades. Returns a BufferGeometry (vertex-coloured, two-sided)
 * ready to hand straight to an InstancedMesh.
 * @returns {THREE.BufferGeometry}
 */
export function buildGrassTuft(rng, opts = {}) {
  rng = asRng(rng);
  const n = opts.blades ?? rng.int(5, 9);
  const h = opts.height ?? rng.range(0.3, 0.55);
  const c0 = opts.color ?? 0x4c8a2c;
  const c1 = opts.tipColor ?? 0xb4dc55;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const b = blade(rng, {
      length: h * rng.range(0.65, 1.2),
      width: (opts.width ?? h * 0.1) * rng.range(0.75, 1.25),
      segs: opts.segs ?? 2,
      bend: rng.range(0.35, 0.85),
      lean: rng.gauss(0, 0.25),
      color: mix(c0, 0x3d6428, rng() * 0.5).clone(),
      tipColor: mix(c1, 0xd9ee92, rng() * 0.45).clone(),
    });
    const a = (i / n) * TAU + rng.gauss(0, 0.5);
    xf(b, { ry: a, x: rng.gauss(0, h * 0.09), z: rng.gauss(0, h * 0.09) });
    parts.push(b);
  }
  const geo = merge(parts);
  geo.computeBoundingBox();
  geo.userData.bounds = { radius: h * 0.5, height: geo.boundingBox.max.y };
  geo.name = 'grassTuft';
  return geo;
}

/** Bare branching tree for storm / dead islands. */
export function buildDeadTree(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(3.5, 6);
  const r0 = opts.radius ?? h * 0.035;
  const parts = [];
  const branch = (from, dir, len, rad, depth) => {
    const N = depth > 1 ? 4 : 3;
    const pts = [], radii = [];
    const bend = V(rng.gauss(0, 0.35), rng.gauss(0, 0.12), rng.gauss(0, 0.35));
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      pts.push(from.clone().addScaledVector(dir, len * t).addScaledVector(bend, len * t * t * 0.35));
      radii.push(rad * (1 - 0.62 * t));
    }
    parts.push(tube(pts, radii, depth > 1 ? 5 : 4, { caps: depth <= 1 }));
    if (depth <= 0) return;
    const end = pts[N - 1];
    const kids = depth > 1 ? rng.int(2, 3) : rng.int(1, 2);
    for (let k = 0; k < kids; k++) {
      const nd = dir.clone()
        .addScaledVector(V(rng.gauss(0, 1), rng.range(0.05, 0.5), rng.gauss(0, 1)), 0.85)
        .normalize();
      branch(end, nd, len * rng.range(0.5, 0.72), rad * 0.55, depth - 1);
    }
  };
  branch(V(0, 0, 0), V(rng.gauss(0, 0.12), 1, rng.gauss(0, 0.12)).normalize(), h * 0.5, r0, 2);
  // root flare
  const flare = cone(r0 * 2.4, r0 * 3.4, 6);
  xf(flare, { y: r0 * 1.7 });
  parts.push(flare);
  let geo = prep(merge(parts), true);
  paint(geo, (x, y, z, nx, ny) => {
    const g = valueNoise2(x * 4 + y * 2.5, z * 4);
    return mix(0x8d8073, 0x4d4238, g * 0.9 + clamp01(1 - y / h) * 0.25);
  }, { rng, faceJitter: 0.07, dirShade: 0.12 });
  const group = new THREE.Group();
  group.add(meshOf(geo, opts.material || sharedPropMaterial()));
  return finish(group, 'deadTree');
}

/** Underwater kelp strand. `group.userData.sway(t)` animates it. */
export function buildKelp(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(2.5, 6);
  const segs = opts.segs ?? 14;
  const w = opts.width ?? h * 0.036;
  const wob = rng.range(0.1, 0.22) * h;
  const phase = rng() * TAU;
  const P = [], U = [], C = [];
  const c0 = toColor(opts.color ?? 0x2c7a3e);
  const c1 = toColor(opts.tipColor ?? 0xaecf4e);
  const pushV = (x, y, z, u, v, col) => { P.push(x, y, z); U.push(u, v); C.push(col.r, col.g, col.b); };
  const spineX = (t) => Math.sin(t * 3.1 + phase) * wob * t;
  const spineZ = (t) => Math.cos(t * 2.3 + phase * 1.7) * wob * 0.55 * t;
  const width = (t) => w * (0.45 + 0.85 * Math.sin(Math.PI * Math.pow(t, 0.75)));
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const y0 = h * t0, y1 = h * t1;
    const x0 = spineX(t0), x1 = spineX(t1), z0 = spineZ(t0), z1 = spineZ(t1);
    const w0 = width(t0), w1 = width(t1);
    const a0 = mix(c0, c1, t0).clone(), a1 = mix(c0, c1, t1).clone();
    const e0 = a0.clone().multiplyScalar(0.82), e1 = a1.clone().multiplyScalar(0.82);
    // slight ruffle: alternate edges push forward/back in Z
    const rf = (i % 2 ? 1 : -1) * w * 0.5;
    pushV(x0 - w0, y0, z0 + rf, 0, t0, e0); pushV(x0 + w0, y0, z0 - rf, 1, t0, e0); pushV(x1 + w1, y1, z1 + rf, 1, t1, e1);
    pushV(x0 - w0, y0, z0 + rf, 0, t0, e0); pushV(x1 + w1, y1, z1 + rf, 1, t1, e1); pushV(x1 - w1, y1, z1 - rf, 0, t1, e1);
  }
  const strand = new THREE.BufferGeometry();
  strand.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  strand.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  strand.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  strand.computeVertexNormals();
  const parts = [doubleSide(prep(strand))];
  // gas bladders
  for (let i = 0; i < rng.int(2, 4); i++) {
    const t = rng.range(0.35, 0.95);
    const g = ico(w * rng.range(0.55, 0.85), 0);
    xf(g, { s: [0.9, 1.25, 0.9], x: spineX(t), y: h * t, z: spineZ(t) });
    parts.push(paint(g, 0xb9c74f, { rng, faceJitter: 0.08 }));
  }
  // holdfast
  const hold = ico(w * 1.4, 0);
  xf(hold, { s: [1.5, 0.45, 1.4], y: w * 0.25 });
  parts.push(paint(hold, 0x6f5a38, { rng, faceJitter: 0.12, topBias: 0.4, topColor: 0x8f7a4c }));

  const geo = merge(parts);
  const mesh = meshOf(geo, opts.material || foliagePropMaterial());
  const group = new THREE.Group();
  group.add(mesh);
  const basePos = Float32Array.from(geo.attributes.position.array);
  const amp = opts.swayAmount ?? h * 0.06;
  const speed = opts.swaySpeed ?? 0.9;
  group.userData.sway = (t) => {
    const pos = geo.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < arr.length; i += 3) {
      const by = basePos[i + 1];
      const f = Math.pow(clamp01(by / h), 1.6);
      const s = Math.sin(t * speed + phase + by * 0.9);
      arr[i] = basePos[i] + s * amp * f;
      arr[i + 2] = basePos[i + 2] + Math.cos(t * speed * 0.77 + phase) * amp * 0.55 * f;
    }
    pos.needsUpdate = true;
  };
  group.userData.height = h;
  return finish(group, 'kelp');
}

/** Branching or brain coral in loud reef colours. opts.type:'branch'|'brain'|'fan' */
export function buildCoral(rng, opts = {}) {
  rng = asRng(rng);
  const size = opts.size ?? rng.range(0.5, 1.3);
  const type = opts.type || rng.pick(['branch', 'branch', 'brain', 'fan']);
  let brainSeed = 0;
  const pal = opts.color ?? rng.pick([0xff5f9e, 0xff8a3d, 0xb060e8, 0x2fd3bd, 0xf24f5c, 0x4f8ff0]);
  const tipCol = opts.tipColor ?? mix(pal, 0xfff4f8, 0.62).getHex();
  const parts = [];
  if (type === 'brain') {
    const g = ico(size * 0.5, 1);
    xf(g, { s: [1.2, 0.78, 1.05] });
    deform(g, { amp: 0.16, freq: 7.5, seed: rng() * 200, sharp: 4 });
    groundIt(g, true);
    parts.push(prep(g, true));
    brainSeed = rng() * 40;
  } else if (type === 'fan') {
    const P = [], U = [];
    const rows = 5, cols = 7;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if ((i + j) % 3 === 2 && i > 1) continue; // holes -> lacy fan
        const t0 = i / rows, t1 = (i + 1) / rows;
        const u0 = (j / cols - 0.5), u1 = ((j + 1) / cols - 0.5);
        const spread = (t) => size * (0.35 + 0.95 * t);
        const yy = (t) => size * 1.15 * t;
        const zz = (u, t) => -Math.abs(u) * size * 0.45 * t;
        const A = V(u0 * spread(t0), yy(t0), zz(u0, t0)), B = V(u1 * spread(t0), yy(t0), zz(u1, t0));
        const C2 = V(u1 * spread(t1), yy(t1), zz(u1, t1)), D = V(u0 * spread(t1), yy(t1), zz(u0, t1));
        P.push(A.x, A.y, A.z, B.x, B.y, B.z, C2.x, C2.y, C2.z);
        P.push(A.x, A.y, A.z, C2.x, C2.y, C2.z, D.x, D.y, D.z);
        for (let k = 0; k < 6; k++) U.push(0, t0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.computeVertexNormals();
    parts.push(doubleSide(prep(g)));
  } else {
    const grow = (from, dir, len, rad, depth) => {
      const N = 3, pts = [], radii = [];
      const bend = V(rng.gauss(0, 0.5), rng.range(0.1, 0.5), rng.gauss(0, 0.5));
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        pts.push(from.clone().addScaledVector(dir, len * t).addScaledVector(bend, len * t * t * 0.45));
        radii.push(rad * (1 - 0.34 * t));
      }
      parts.push(tube(pts, radii, 4, { caps: false }));
      const end = pts[N - 1];
      if (depth <= 0) {
        // rounded polyp tip - a flat-cut branch reads as a dead twig
        const tip = ico(rad * 0.82, 0);
        xf(tip, { s: [1, 1.25, 1], x: end.x, y: end.y, z: end.z });
        parts.push(tip);
        return;
      }
      for (let k = 0, kn = rng.int(2, 3); k < kn; k++) {
        const nd = dir.clone().addScaledVector(V(rng.gauss(0, 1.15), rng.range(0.2, 0.85), rng.gauss(0, 1.15)), 1.25).normalize();
        grow(end, nd, len * rng.range(0.6, 0.85), rad * 0.68, depth - 1);
      }
    };
    // several short stems make a reef clump; one tall trunk makes a bare tree
    const stems = rng.int(2, 3);
    const a0 = rng() * TAU;
    for (let i = 0; i < stems; i++) {
      const a = a0 + (i / stems) * TAU + rng.gauss(0, 0.35);
      const dir = V(Math.cos(a) * rng.range(0.25, 0.5), 1, Math.sin(a) * rng.range(0.25, 0.5)).normalize();
      grow(
        V(Math.cos(a) * size * 0.08, 0, Math.sin(a) * size * 0.08),
        dir, size * rng.range(0.24, 0.34), size * rng.range(0.085, 0.115), 1,
      );
    }
  }
  let geo = prep(merge(parts), true);
  groundIt(geo, false);
  geo.computeBoundingBox();
  const top = Math.max(0.05, geo.boundingBox.max.y);
  paint(geo, (x, y, z, nx, ny) => {
    const c = mix(pal, tipCol, Math.pow(clamp01(y / top), 1.0) * 0.9).clone();
    // grooves / polyp banding so brain + fan corals are not flat blobs
    if (type === 'brain') {
      const meander = Math.sin(x * (11 / size) + valueNoise2(x * 2.2 + brainSeed, z * 2.2) * 7.5 + z * (3 / size));
      return c.lerp(toColor(pal).multiplyScalar(0.42), clamp01(0.62 - Math.abs(meander)) * 1.5);
    }
    const groove = valueNoise2(x * 7.5 + z * 2.1, z * 7.5 - y * 3.2);
    return c.lerp(toColor(pal).multiplyScalar(0.55), clamp01((groove - 0.52) * 2.2) * 0.55);
  }, { rng, faceJitter: 0.06, vJitter: 0.025, dirShade: 0.08, ao: 0.12 });
  const group = new THREE.Group();
  group.add(meshOf(geo, opts.material || foliagePropMaterial()));
  return finish(group, 'coral', { type });
}

/** Ribbed saguaro-style cactus with arms and blossoms. */
export function buildCactus(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(1.4, 3.2);
  const r = opts.radius ?? h * rng.range(0.1, 0.14);
  const ribs = opts.ribs ?? rng.int(7, 9);
  const parts = [];
  const column = (from, dir, len, rad, curve, N = 6) => {
    const pts = [], radii = [];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      pts.push(from.clone().addScaledVector(dir, len * t).addScaledVector(curve, len * t * t));
      radii.push(rad * (0.92 + 0.14 * Math.sin(t * 3)) * (1 - 0.18 * t * t));
    }
    return tube(pts, radii, ribs, { caps: true, lobes: ribs, lobeAmt: 0.16 });
  };
  parts.push(column(V(0, 0, 0), V(0, 1, 0), h, r, V(rng.gauss(0, 0.03), 0, rng.gauss(0, 0.03))));
  const arms = opts.arms ?? rng.int(1, 3);
  const tips = [V(0, h, 0)];
  for (let i = 0; i < arms; i++) {
    const ay = h * rng.range(0.35, 0.62);
    const ang = rng() * TAU;
    const outDir = V(Math.cos(ang), 0.35, Math.sin(ang)).normalize();
    const l1 = h * rng.range(0.18, 0.3);
    parts.push(column(V(0, ay, 0), outDir, l1, r * 0.62, V(0, l1 * 0.5, 0), 4));
    const elbow = V(Math.cos(ang) * l1 * 0.92, ay + l1 * 0.85, Math.sin(ang) * l1 * 0.92);
    const l2 = h * rng.range(0.25, 0.45);
    parts.push(column(elbow, V(0, 1, 0), l2, r * 0.58, V(Math.cos(ang) * 0.04, 0, Math.sin(ang) * 0.04), 4));
    tips.push(V(elbow.x, elbow.y + l2, elbow.z));
  }
  let geo = prep(merge(parts), false);
  paint(geo, (x, y, z, nx, ny) => {
    const rib = clamp01((Math.atan2(z, x) * ribs) % 1);
    const shade = 0.5 + 0.5 * Math.cos(Math.atan2(z, x) * ribs);
    return mix(0x2f7d43, 0x74bd66, shade * 0.7 + clamp01(y / h) * 0.2);
  }, { rng, faceJitter: 0.03, dirShade: 0.1 });
  const all = [geo];
  // spine dots + blossoms
  for (const tp of tips) {
    if (!rng.chance(0.65)) continue;
    for (let i = 0, n = rng.int(1, 3); i < n; i++) {
      const f = ico(r * 0.3, 0);
      const a = rng() * TAU;
      xf(f, { s: [1, 0.65, 1], x: tp.x + Math.cos(a) * r * 0.35, y: tp.y + r * 0.1, z: tp.z + Math.sin(a) * r * 0.35 });
      all.push(paint(f, rng.pick([0xff5f8a, 0xffd23f, 0xff8a3d]), { rng, faceJitter: 0.1 }));
    }
  }
  const group = new THREE.Group();
  group.add(meshOf(merge(all), opts.material || foliagePropMaterial()));
  return finish(group, 'cactus');
}

/** Shuttlecock fern: pinnate fronds radiating from a low crown. */
export function buildFernPlant(rng, opts = {}) {
  rng = asRng(rng);
  const size = opts.size ?? rng.range(0.7, 1.5);
  const n = opts.fronds ?? rng.int(5, 8);
  const parts = [];
  const start = rng() * TAU;
  for (let i = 0; i < n; i++) {
    const ang = start + (i / n) * TAU + rng.gauss(0, 0.18);
    const f = pinnateFrond(rng, {
      length: size * rng.range(0.85, 1.2),
      width: size * rng.range(0.15, 0.22),
      segs: 5,
      pitch: rng.range(0.95, 1.5),
      droop: rng.range(1.0, 1.5),
      fold: rng.range(0.2, 0.4),
      serration: 0.42,
      color: mix(0x2f7a3c, 0x4f9a44, rng()).clone(),
      tipColor: mix(0x7cc154, 0xa8d669, rng()).clone(),
      ribColor: 0x2a6634,
    });
    xf(f, { ry: ang, rx: rng.gauss(0, 0.08), y: size * 0.06 });
    parts.push(f);
  }
  // a couple of unfurling fiddleheads
  for (let i = 0; i < rng.int(0, 2); i++) {
    const N = 6, pts = [], radii = [];
    const a = rng() * TAU;
    for (let k = 0; k < N; k++) {
      const t = k / (N - 1), sp = t * 5.5;
      const cr = size * 0.09 * (1 - t) ;
      pts.push(V(Math.cos(a) * size * 0.05 + Math.cos(sp) * cr, size * (0.15 + 0.5 * t), Math.sin(a) * size * 0.05 + Math.sin(sp) * cr));
      radii.push(size * 0.018 * (1 - 0.4 * t));
    }
    parts.push(paint(tube(pts, radii, 4, { caps: true }), 0x5d9a3f, { rng, faceJitter: 0.08 }));
  }
  const crown = ico(size * 0.13, 0);
  xf(crown, { s: [1.3, 0.6, 1.3], y: size * 0.05 });
  parts.push(paint(crown, 0x4a3a26, { rng, faceJitter: 0.1 }));
  const group = new THREE.Group();
  group.add(meshOf(merge(parts), opts.material || foliagePropMaterial()));
  return finish(group, 'fernPlant');
}
