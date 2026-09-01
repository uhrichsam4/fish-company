import * as THREE from 'three';
import { TAU, clamp, clamp01, lerp, valueNoise2 } from '../../util/math.js';
import {
  asRng, prep, paint, paintY, xf, merge, doubleSide, box, cyl, cone, sph, ico, tor, lathe, prism,
  tube, qbez, V, deform, groundIt, finish, meshOf, toColor,
  sharedPropMaterial, metalPropMaterial, glowMaterial,
} from './rocks.js';

/**
 * Harbour / camp / industrial props. Wood is built from individual plank
 * boxes with per-plank colour + rotation jitter and real gaps between them,
 * so one vertex-coloured material still reads as timber.
 */

const _s = new THREE.Color();
const _s2 = new THREE.Color();
const mixc = (a, b, t) => _s.copy(toColor(a)).lerp(toColor(b), clamp01(t));

export const WOOD = {
  deck: 0xb98a55,
  plank: 0xa97443,
  dark: 0x7b5533,
  old: 0x9a8a72,
  drift: 0xc3b39a,
  crate: 0xc79a5c,
  post: 0x8b6239,
};
export const PAINT = {
  red: 0xc4483c, blue: 0x3d7fa6, green: 0x4e9060, yellow: 0xe0b23f,
  teal: 0x3fa8a0, orange: 0xdc7a35, cream: 0xe6d6b6, white: 0xdfe5e6, grey: 0x8d949a,
};

// ---------------------------------------------------------------------------
// wood / panel helpers
// ---------------------------------------------------------------------------

/** One timber board: colour-jittered, grain-streaked, slightly shaded by facing. */
export function woodPlank(rng, w, h, d, base = WOOD.plank, o = {}) {
  const g = box(w, h, d);
  const c = toColor(base).multiplyScalar(1 + rng.gauss(0, 0.085));
  c.lerp(toColor(rng.chance(0.5) ? 0xe3c194 : 0x63431f), Math.abs(rng.gauss(0, 0.17)));
  const dark = c.clone().multiplyScalar(0.7);
  const axis = o.grain || (w >= d ? 'x' : 'z');
  const f = o.grainFreq ?? 7;
  return paint(g, (x, y, z) => {
    const u = axis === 'x' ? x : z, v = axis === 'x' ? z : x;
    const grain = valueNoise2(u * f, v * 26 + y * 13);
    return _s2.copy(c).lerp(dark, clamp01((grain - 0.42) * 1.5) * 0.45);
  }, { rng, faceJitter: 0.028, dirShade: o.dirShade ?? 0.11, ao: o.ao ?? 0 });
}

/** Painted / plain panel with a light dirt gradient. */
export function panel(rng, w, h, d, base, o = {}) {
  const g = box(w, h, d);
  const c = toColor(base).multiplyScalar(1 + rng.gauss(0, 0.03));
  return paint(g, c, { rng, faceJitter: 0.02, dirShade: o.dirShade ?? 0.1, ao: o.ao ?? 0.12 });
}

/**
 * Corrugated sheet in the XY plane (normal +Z), centred, two-sided.
 * Ribs run vertically (along Y) by default.
 */
export function corrugated(rng, w, h, folds = 10, depth = 0.05, base = PAINT.grey, o = {}) {
  const P = [], U = [], C = [];
  const n = Math.max(2, Math.round(folds) * 2);
  const c = toColor(base);
  const cHi = c.clone().multiplyScalar(1.14), cLo = c.clone().multiplyScalar(0.8);
  const horiz = !!o.horizontal;
  const zAt = (i) => (i % 2 ? depth : -depth) * 0.5;
  const pushV = (a, b, zz, u, v, col) => {
    if (horiz) P.push(b, a, zz); else P.push(a, b, zz);
    U.push(u, v); C.push(col.r, col.g, col.b);
  };
  const W = horiz ? h : w, H = horiz ? w : h;
  for (let i = 0; i < n; i++) {
    const x0 = -W / 2 + (W * i) / n, x1 = -W / 2 + (W * (i + 1)) / n;
    const z0 = zAt(i), z1 = zAt(i + 1);
    const col0 = (i % 2 ? cHi : cLo), col1 = ((i + 1) % 2 ? cHi : cLo);
    pushV(x0, -H / 2, z0, 0, 0, col0); pushV(x1, -H / 2, z1, 1, 0, col1); pushV(x1, H / 2, z1, 1, 1, col1);
    pushV(x0, -H / 2, z0, 0, 0, col0); pushV(x1, H / 2, z1, 1, 1, col1); pushV(x0, H / 2, z0, 0, 1, col0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  return o.single ? prep(g) : doubleSide(prep(g));
}

/** Rope ring around a post. */
function ropeRing(rng, r, tube_ = 0.035, y = 0, tilt = 0) {
  const g = tor(r, tube_, 3, 8);
  xf(g, { rx: Math.PI / 2 + tilt, y, rz: rng.gauss(0, 0.08) });
  return paint(g, mixc(0xc9ab74, 0x9a7f52, rng() * 0.6).clone(), { rng, faceJitter: 0.07, dirShade: 0.1 });
}

/** Multi-material assembly bag. */
function bag() { return { main: [], metal: [], glow: [] }; }
function assemble(b, opts = {}, name = 'prop') {
  const g = new THREE.Group();
  if (b.main.length) g.add(meshOf(merge(b.main), opts.material || sharedPropMaterial()));
  if (b.metal.length) g.add(meshOf(merge(b.metal), opts.metalMaterial || metalPropMaterial()));
  if (b.glow.length) {
    const byColor = new Map();
    for (const it of b.glow) {
      const key = `${it.color}|${it.intensity ?? 1.6}`;
      if (!byColor.has(key)) byColor.set(key, { color: it.color, intensity: it.intensity ?? 1.6, geos: [] });
      byColor.get(key).geos.push(it.geo);
    }
    for (const v of byColor.values()) {
      const m = new THREE.Mesh(merge(v.geos), glowMaterial(v.color, v.intensity));
      m.castShadow = false; m.receiveShadow = false;
      g.add(m);
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
// DOCK
// ---------------------------------------------------------------------------

/** Planked jetty. opts:{length,width,pilings,height,boardWidth,cleats} */
export function buildDock(rng, opts = {}) {
  rng = asRng(rng);
  const L = opts.length ?? 8;
  const W = opts.width ?? 2.4;
  const H = opts.height ?? 1.15;
  const bw = opts.boardWidth ?? 0.26;
  const gap = opts.gap ?? 0.055;
  const b = bag();
  const deckY = H;

  // --- deck boards, laid across the width, running along Z
  const step = bw + gap;
  const rows = Math.max(2, Math.floor(L / step));
  const z0 = -L / 2 + (L - rows * step + gap) / 2 + bw / 2;
  for (let i = 0; i < rows; i++) {
    const z = z0 + i * step;
    const p = woodPlank(rng, W * rng.range(0.985, 1.0), 0.075, bw * rng.range(0.93, 1.0), WOOD.deck, { grain: 'x', grainFreq: 5 });
    xf(p, { z, y: deckY - 0.0375 + rng.gauss(0, 0.006), ry: rng.gauss(0, 0.008), rz: rng.gauss(0, 0.012), x: rng.gauss(0, 0.01) });
    b.main.push(p);
  }
  // --- stringers under the deck
  for (const x of [-W * 0.38, 0, W * 0.38]) {
    const s = woodPlank(rng, 0.11, 0.19, L * 0.99, WOOD.dark, { grain: 'z' });
    xf(s, { x, y: deckY - 0.075 - 0.095 });
    b.main.push(s);
  }

  // --- pilings
  if (opts.pilings !== false) {
    const bays = Math.max(2, Math.round(L / 2.6));
    for (let i = 0; i <= bays; i++) {
      const z = -L / 2 + (L * i) / bays;
      for (const sx of [-1, 1]) {
        const px = sx * W * 0.42;
        const top = deckY - 0.05, bot = -(opts.pileDepth ?? 0.9);
        const pts = [], radii = [];
        const tilt = rng.gauss(0, 0.035);
        for (let k = 0; k < 4; k++) {
          const t = k / 3;
          pts.push(V(px + tilt * (1 - t) * 0.6, lerp(top, bot, t), z + rng.gauss(0, 0.012)));
          radii.push(0.105 * (1 + t * 0.18) * (1 + Math.sin(t * 6) * 0.05));
        }
        const g = tube(pts, radii, 7, { caps: true });
        b.main.push(paint(g, (x, y) => mixc(0x7d5c3b, 0x4c3b2a, clamp01(1 - (y + 1) / (H + 1)) * 0.9 + valueNoise2(x * 5, y * 3) * 0.25),
          { rng, faceJitter: 0.05, dirShade: 0.11 }));
        // cross brace
        if (i > 0 && i < bays && sx < 0) {
          const br = woodPlank(rng, W * 0.92, 0.09, 0.1, WOOD.dark);
          xf(br, { y: deckY - 0.55, z, rz: rng.gauss(0, 0.02) });
          b.main.push(br);
        }
      }
    }
    // rope wraps on the two head pilings
    for (const sx of [-1, 1]) {
      const px = sx * W * 0.42, z = -L / 2;
      for (let k = 0; k < 3; k++) b.main.push(xf(ropeRing(rng, 0.135, 0.032, 0, rng.gauss(0, 0.05)), { x: px, y: deckY - 0.22 - k * 0.075, z }));
    }
  }

  // --- mooring cleats
  if (opts.cleats !== false) {
    for (let i = 0; i < 2; i++) {
      const z = lerp(-L * 0.32, L * 0.32, i);
      const sx = i % 2 ? 1 : -1;
      const x = sx * W * 0.36;
      const base = panel(rng, 0.1, 0.045, 0.24, 0x5b6167);
      xf(base, { x, y: deckY + 0.022, z });
      b.metal.push(base);
      for (const dz of [-0.075, 0.075]) {
        const post = cyl(0.028, 0.03, 0.11, 6);
        xf(post, { x, y: deckY + 0.08, z: z + dz });
        b.metal.push(paint(post, 0x6c737a, { rng, faceJitter: 0.05 }));
      }
      const bar = cyl(0.03, 0.03, 0.26, 6);
      xf(bar, { x, y: deckY + 0.135, z, rx: Math.PI / 2 });
      b.metal.push(paint(bar, 0x777f86, { rng, faceJitter: 0.05, dirShade: 0.12 }));
    }
  }
  const g = assemble(b, opts, 'dock');
  g.userData.deckHeight = deckY;
  return finish(g, 'dock', { deckHeight: deckY, length: L, width: W });
}

// ---------------------------------------------------------------------------
// SHACK
// ---------------------------------------------------------------------------

/** Small merchant shack with an open counter window, awning and lantern. */
export function buildShack(rng, opts = {}) {
  rng = asRng(rng);
  const W = opts.width ?? 3.6, D = opts.depth ?? 2.9, H = opts.height ?? 2.3;
  const roofKind = opts.roof || (rng.chance(0.5) ? 'thatch' : 'corrugated');
  const accent = opts.accent ?? rng.pick([PAINT.red, PAINT.blue, PAINT.teal, PAINT.green]);
  const b = bag();

  // ---- vertical wall planks
  const wallPlanks = (len, height, y0, freq) => {
    const out = [];
    const pw = 0.24, gap = 0.02;
    const n = Math.max(2, Math.floor(len / (pw + gap)));
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + (len / n) * (i + 0.5);
      const p = woodPlank(rng, (len / n) - gap, height * rng.range(0.985, 1.0), 0.09, WOOD.plank, { grain: 'z', grainFreq: 3 });
      xf(p, { x, y: y0 + height / 2, rz: rng.gauss(0, 0.006), ry: rng.gauss(0, 0.01) });
      out.push(p);
    }
    return out;
  };
  const place = (geos, o) => { for (const g of geos) b.main.push(xf(g, o)); };

  // back wall
  place(wallPlanks(W, H, 0), { z: -D / 2 });
  // side walls
  place(wallPlanks(D, H, 0), { x: -W / 2, ry: Math.PI / 2 });
  place(wallPlanks(D, H, 0), { x: W / 2, ry: Math.PI / 2 });
  // front: counter wall (low), header (high), two jambs -> leaves a serving window
  const openW = W * 0.62;
  const jamb = (W - openW) / 2;
  place(wallPlanks(jamb, H, 0), { x: -(openW + jamb) / 2, z: D / 2 });
  place(wallPlanks(jamb, H, 0), { x: (openW + jamb) / 2, z: D / 2 });
  place(wallPlanks(openW, 0.92, 0), { z: D / 2 });
  place(wallPlanks(openW, H - 1.72, 1.72), { z: D / 2 });

  // corner posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = woodPlank(rng, 0.14, H + 0.06, 0.14, WOOD.post);
    xf(p, { x: sx * (W / 2 - 0.02), y: (H + 0.06) / 2, z: sz * (D / 2 - 0.02) });
    b.main.push(p);
  }
  // counter slab jutting forward
  const counter = woodPlank(rng, openW + 0.5, 0.09, 0.55, WOOD.deck, { grain: 'x' });
  xf(counter, { y: 0.96, z: D / 2 + 0.12 });
  b.main.push(counter);
  // inner shelf + goods
  const shelf = woodPlank(rng, W - 0.35, 0.06, 0.3, WOOD.dark);
  xf(shelf, { y: 1.35, z: -D / 2 + 0.24 });
  b.main.push(shelf);
  for (let i = 0; i < 4; i++) {
    const j = panel(rng, 0.13, rng.range(0.16, 0.24), 0.13, rng.pick([0x6fae8f, 0xc98a5a, 0x8d7fc0, 0xd6bf6a]));
    xf(j, { x: lerp(-W * 0.33, W * 0.33, i / 3) + rng.gauss(0, 0.05), y: 1.48, z: -D / 2 + 0.24 });
    b.main.push(j);
  }

  // ---- roof
  const rw = W + 0.7, rd = D + 0.7, pitch = 0.55;
  if (roofKind === 'corrugated') {
    for (const s of [-1, 1]) {
      const slope = corrugated(rng, rw, Math.hypot(rd / 2, pitch) + 0.06, 9, 0.05, accent);
      xf(slope, { rx: -s * Math.atan2(pitch, rd / 2) + (s < 0 ? Math.PI : 0), ry: s < 0 ? Math.PI : 0 });
      xf(slope, { y: H + pitch / 2 + 0.03, z: s * rd / 4 });
      b.main.push(slope);
    }
    const ridge = panel(rng, rw + 0.05, 0.07, 0.16, toColor(accent).multiplyScalar(0.85).getHex());
    xf(ridge, { y: H + pitch + 0.05 });
    b.main.push(ridge);
  } else {
    // thatch: three stacked ragged layers per slope
    for (const s of [-1, 1]) {
      for (let l = 0; l < 3; l++) {
        const t = l / 2;
        const depth = (rd / 2) * (1 - t * 0.55);
        const P = [], U = [], C = [];
        const segs = 9;
        const c0 = toColor(0xc6a45c), c1 = toColor(0x8c6d38);
        for (let i = 0; i < segs; i++) {
          const x0 = -rw / 2 + (rw * i) / segs, x1 = -rw / 2 + (rw * (i + 1)) / segs;
          const fr0 = 1 + (i % 2 ? 0.16 : -0.13) + rng.gauss(0, 0.05);
          const fr1 = 1 + ((i + 1) % 2 ? 0.16 : -0.13) + rng.gauss(0, 0.05);
          const yTop = H + pitch * (1 - t * 0.3), zTop = 0;
          const yB0 = H - 0.3 + t * 0.5, zB = depth * s;
          const cA = mixc(c0, c1, rng() * 0.5 + 0.35).clone();
          const cB = mixc(c0, c1, rng() * 0.5).clone();
          const push = (x, y, z, u, v, c) => { P.push(x, y, z); U.push(u, v); C.push(c.r, c.g, c.b); };
          const yb0 = yB0 - (fr0 - 1) * 0.55, yb1 = yB0 - (fr1 - 1) * 0.55;
          push(x0, yTop, zTop, 0, 0, cB); push(x1, yTop, zTop, 1, 0, cB); push(x1, yb1, zB * fr1, 1, 1, cA);
          push(x0, yTop, zTop, 0, 0, cB); push(x1, yb1, zB * fr1, 1, 1, cA); push(x0, yb0, zB * fr0, 0, 1, cA);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
        g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
        g.computeVertexNormals();
        b.main.push(doubleSide(prep(g)));
      }
    }
    const ridgeRope = cyl(0.07, 0.07, rw * 0.9, 6);
    xf(ridgeRope, { rz: Math.PI / 2, y: H + pitch + 0.02 });
    b.main.push(paint(ridgeRope, 0xa98a58, { rng, faceJitter: 0.07 }));
  }
  // gable end fills
  for (const s of [-1, 1]) {
    const P = [-W / 2, H, 0, W / 2, H, 0, 0, H + pitch, 0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.computeVertexNormals();
    const gg = doubleSide(prep(g));
    xf(gg, { z: s * D / 2 });
    b.main.push(paint(gg, WOOD.plank, { rng, faceJitter: 0.04, dirShade: 0.1 }));
  }

  // ---- awning over the counter (striped)
  const aw = openW + 0.9, ad = 0.95;
  const stripes = 6;
  for (let i = 0; i < stripes; i++) {
    const sw = aw / stripes;
    const c = i % 2 ? accent : PAINT.cream;
    const P = [], U = [];
    const x0 = -aw / 2 + sw * i, x1 = x0 + sw;
    const yA = H - 0.08, yB = H - 0.42, zA = D / 2 + 0.02, zB = D / 2 + ad;
    P.push(x0, yA, zA, x1, yA, zA, x1, yB, zB, x0, yA, zA, x1, yB, zB, x0, yB, zB);
    for (let k = 0; k < 6; k++) U.push(0, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.computeVertexNormals();
    b.main.push(paint(doubleSide(prep(g)), c, { rng, faceJitter: 0.03, dirShade: 0.08 }));
  }
  // scalloped valance
  for (let i = 0; i < stripes * 2; i++) {
    const sw = aw / (stripes * 2);
    const x = -aw / 2 + sw * (i + 0.5);
    const v = panel(rng, sw * 0.95, 0.13, 0.02, i % 2 ? accent : PAINT.cream);
    xf(v, { x, y: H - 0.49, z: D / 2 + ad });
    b.main.push(v);
  }
  for (const sx of [-1, 1]) {
    const pole = cyl(0.035, 0.04, H - 0.42, 6);
    xf(pole, { x: sx * aw * 0.46, y: (H - 0.42) / 2, z: D / 2 + ad - 0.03 });
    b.main.push(paint(pole, WOOD.post, { rng, faceJitter: 0.05, dirShade: 0.1 }));
  }

  // ---- hanging lantern
  const lx = -aw * 0.34, ly = H - 0.78, lz = D / 2 + ad - 0.14;
  const hang = cyl(0.008, 0.008, 0.18, 4);
  xf(hang, { x: lx, y: ly + 0.16, z: lz });
  b.metal.push(paint(hang, 0x3f4348, { rng }));
  const cage = cyl(0.075, 0.09, 0.17, 6, { open: true });
  xf(cage, { x: lx, y: ly, z: lz });
  b.metal.push(paint(cage, 0x4a4f55, { rng, faceJitter: 0.05 }));
  const cap = cone(0.1, 0.07, 6);
  xf(cap, { x: lx, y: ly + 0.11, z: lz });
  b.metal.push(paint(cap, 0x3c4045, { rng, faceJitter: 0.05 }));
  const bulb = ico(0.055, 0);
  xf(bulb, { x: lx, y: ly, z: lz });
  b.glow.push({ geo: bulb, color: 0xffcf7a, intensity: 2.2 });

  // ---- crates & barrel outside
  const g = assemble(b, opts, 'shack');
  if (opts.clutter !== false) {
    const c1 = buildCrate(rng, { size: 0.55, material: opts.material });
    c1.position.set(-W / 2 - 0.45, 0, D / 2 - 0.35);
    c1.rotation.y = rng.gauss(0, 0.4);
    const c2 = buildCrate(rng, { size: 0.42, material: opts.material });
    c2.position.set(-W / 2 - 0.5, 0.55, D / 2 - 0.5);
    c2.rotation.y = rng.gauss(0, 0.5);
    const bar = buildBarrel(rng, { color: rng.pick([PAINT.blue, PAINT.green, PAINT.red]), material: opts.material });
    bar.position.set(W / 2 + 0.42, 0, D / 2 - 0.2);
    bar.rotation.y = rng() * TAU;
    g.add(c1, c2, bar);
  }
  const lightAnchor = new THREE.Object3D();
  lightAnchor.position.set(lx, ly, lz);
  g.add(lightAnchor);
  g.userData.lightAnchor = lightAnchor;
  g.userData.counter = new THREE.Vector3(0, 0.96, D / 2 + 0.12);
  return finish(g, 'shack', { roof: roofKind });
}

// ---------------------------------------------------------------------------
// CAMPFIRE
// ---------------------------------------------------------------------------

export function buildCampfire(rng, opts = {}) {
  rng = asRng(rng);
  const R = opts.radius ?? 0.62;
  const b = bag();
  // ash / char bed
  const bed = cyl(R * 0.82, R * 0.9, 0.05, 10);
  xf(bed, { y: 0.025 });
  b.main.push(paint(bed, (x, y, z) => mixc(0x3a332e, 0x6a5f55, valueNoise2(x * 4, z * 4)), { rng, faceJitter: 0.08 }));
  // stone ring
  const n = opts.stones ?? rng.int(6, 8);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.gauss(0, 0.12);
    const s = R * rng.range(0.16, 0.3);
    const g = ico(s, 0);
    xf(g, { s: [rng.range(1, 1.35), rng.range(0.65, 0.95), rng.range(1, 1.25)] });
    deform(g, { amp: 0.26, freq: 4, seed: rng() * 200, sharp: 2 });
    xf(g, { x: Math.cos(a) * R, z: Math.sin(a) * R, y: s * 0.62, ry: rng() * TAU, rz: rng.gauss(0, 0.2) });
    const sc = mixc(0x9b968c, 0x8393a0, rng()).clone();
    b.main.push(paint(prep(g, true), (x, y, z, nx, ny) => _s2.copy(sc).lerp(toColor(0xd6d2c6), clamp01(ny) * 0.55),
      { rng, faceJitter: 0.11, vJitter: 0.035 }));
  }
  // logs leaning into a teepee + two flat logs
  const logs = opts.logs ?? rng.int(3, 4);
  for (let i = 0; i < logs; i++) {
    const a = (i / logs) * TAU + rng.gauss(0, 0.2);
    const len = R * rng.range(1.3, 1.7);
    const r0 = R * 0.075;
    const from = V(Math.cos(a) * R * 0.85, 0.03, Math.sin(a) * R * 0.85);
    const to = V(Math.cos(a) * R * 0.1, len * 0.62, Math.sin(a) * R * 0.1);
    const pts = [], radii = [];
    for (let k = 0; k < 3; k++) { const t = k / 2; pts.push(from.clone().lerp(to, t)); radii.push(r0 * (1 - 0.2 * t)); }
    const g = tube(pts, radii, 5, { caps: true });
    b.main.push(paint(g, (x, y, z) => mixc(0x7a5a3a, 0x2b2320, clamp01(1 - y / (len * 0.5)) * 0.55 + valueNoise2(x * 8, z * 8) * 0.3),
      { rng, faceJitter: 0.07, dirShade: 0.1 }));
  }
  for (let i = 0; i < 1; i++) {
    const a = rng() * TAU;
    const len = R * rng.range(0.8, 1.2);
    const pts = [V(Math.cos(a) * R * 0.5, 0.06, Math.sin(a) * R * 0.5), V(Math.cos(a) * -R * 0.5, 0.06, Math.sin(a) * -R * 0.5)];
    const g = tube([pts[0], pts[0].clone().lerp(pts[1], 0.5), pts[1]], [R * 0.06, R * 0.065, R * 0.055], 5, { caps: true });
    b.main.push(paint(g, 0x4a3a2c, { rng, faceJitter: 0.09 }));
  }
  // embers
  for (let i = 0; i < 2; i++) {
    const e = ico(R * 0.055, 0);
    const a = rng() * TAU, rr = rng() * R * 0.4;
    xf(e, { x: Math.cos(a) * rr, y: 0.06, z: Math.sin(a) * rr });
    b.glow.push({ geo: e, color: 0xff7a2a, intensity: 2.6 });
  }
  const g = assemble(b, opts, 'campfire');
  const flameAnchor = new THREE.Object3D();
  flameAnchor.position.set(0, R * 0.28, 0);
  flameAnchor.name = 'flameAnchor';
  g.add(flameAnchor);
  g.userData.flameAnchor = flameAnchor;
  g.userData.lightAnchor = flameAnchor;
  return finish(g, 'campfire', { radius: R });
}

// ---------------------------------------------------------------------------
// CRATES / BARRELS / CONTAINERS
// ---------------------------------------------------------------------------

export function buildCrate(rng, opts = {}) {
  rng = asRng(rng);
  const s = opts.size ?? 0.7;
  const t = s * 0.075;
  const b = bag();
  const wood = opts.color ?? WOOD.crate;
  // corner posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = woodPlank(rng, t * 1.5, s, t * 1.5, toColor(wood).multiplyScalar(0.82).getHex());
    xf(p, { x: sx * (s / 2 - t * 0.75), y: s / 2, z: sz * (s / 2 - t * 0.75) });
    b.main.push(p);
  }
  // slats on each of the four sides
  const slats = 3;
  for (let f = 0; f < 4; f++) {
    const ry = (f * Math.PI) / 2;
    for (let i = 0; i < slats; i++) {
      const y = s * (0.16 + (i * 0.34));
      const p = woodPlank(rng, s - t * 1.6, s * 0.26, t, wood, { grain: 'x' });
      xf(p, { y, z: s / 2 - t / 2, rz: rng.gauss(0, 0.005) });
      xf(p, { ry });
      b.main.push(p);
    }
    // diagonal brace
    const d = woodPlank(rng, s * 1.24, s * 0.1, t * 0.7, toColor(wood).multiplyScalar(0.88).getHex());
    xf(d, { y: s / 2, z: s / 2 + t * 0.2, rz: (f % 2 ? 1 : -1) * 0.72 });
    xf(d, { ry });
    b.main.push(d);
  }
  // lid
  for (let i = 0; i < 3; i++) {
    const p = woodPlank(rng, s - t * 1.4, t, (s - t * 1.4) / 3 - 0.008, toColor(wood).multiplyScalar(1.05).getHex(), { grain: 'x' });
    xf(p, { y: s + t / 2, z: lerp(-(s - t * 1.4) / 3, (s - t * 1.4) / 3, i / 2), ry: rng.gauss(0, 0.006) });
    b.main.push(p);
  }
  const g = assemble(b, opts, 'crate');
  return finish(g, 'crate', { size: s });
}

export function buildBarrel(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? 0.92, r = opts.radius ?? 0.32;
  const col = opts.color ?? rng.pick([WOOD.plank, PAINT.blue, PAINT.red, PAINT.green, PAINT.teal]);
  const b = bag();
  const seg = 10;
  const pts = [
    new THREE.Vector2(0, 0), new THREE.Vector2(r * 0.86, 0), new THREE.Vector2(r, h * 0.18),
    new THREE.Vector2(r * 1.03, h * 0.5), new THREE.Vector2(r, h * 0.82), new THREE.Vector2(r * 0.86, h),
    new THREE.Vector2(0, h),
  ];
  const body = lathe(pts, seg, true);
  const c = toColor(col);
  b.main.push(paint(body, (x, y, z) => {
    const a = Math.atan2(z, x);
    const stave = 0.5 + 0.5 * Math.cos(a * seg);
    return _s2.copy(c).multiplyScalar(lerp(0.82, 1.08, stave)).lerp(toColor(0x3a2c20), clamp01(valueNoise2(a * 3, y * 4) - 0.55) * 0.6);
  }, { rng, faceJitter: 0.03, dirShade: 0.1 }));
  // hoops
  for (const hy of [h * 0.13, h * 0.5, h * 0.87]) {
    const rr = r * (hy === h * 0.5 ? 1.05 : 0.95) + 0.012;
    const hoop = cyl(rr, rr, h * 0.075, seg, { open: true });
    xf(hoop, { y: hy });
    b.metal.push(paint(hoop, 0x6f757c, { rng, faceJitter: 0.05, dirShade: 0.13 }));
  }
  const g = assemble(b, opts, 'barrel');
  return finish(g, 'barrel', { radius: r, height: h });
}

/** Shallow open fish crate packed with crushed ice. */
export function buildFishCrate(rng, opts = {}) {
  rng = asRng(rng);
  const W = opts.width ?? 0.8, D = opts.depth ?? 0.55, H = opts.height ?? 0.26;
  const t = 0.028;
  const b = bag();
  const col = opts.color ?? PAINT.blue;
  // floor slats
  for (let i = 0; i < 3; i++) {
    const p = woodPlank(rng, W - t * 2, t, D / 3 - 0.012, WOOD.drift, { grain: 'x' });
    xf(p, { y: t / 2, z: lerp(-D / 3, D / 3, i / 2) });
    b.main.push(p);
  }
  // walls (2 slats high, painted)
  for (const [w, ry] of [[W, 0], [D, Math.PI / 2]]) {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const p = woodPlank(rng, w, H * 0.42, t, col, { grain: 'x' });
        xf(p, { y: H * (0.23 + i * 0.5), z: s * ((ry ? W : D) / 2 - t / 2) });
        xf(p, { ry });
        b.main.push(p);
      }
    }
  }
  // corner posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = woodPlank(rng, t * 1.8, H, t * 1.8, toColor(col).multiplyScalar(0.8).getHex());
    xf(p, { x: sx * (W / 2 - t), y: H / 2, z: sz * (D / 2 - t) });
    b.main.push(p);
  }
  // ice
  const ice = [];
  for (let i = 0; i < 7; i++) {
    const g = ico(rng.range(0.045, 0.08), 0);
    xf(g, { s: [1.2, 0.7, 1] });
    deform(g, { amp: 0.3, freq: 14, seed: rng() * 100, sharp: 2 });
    xf(g, {
      x: rng.gauss(0, W * 0.24), z: rng.gauss(0, D * 0.22), y: H * rng.range(0.42, 0.78),
      rx: rng() * TAU, ry: rng() * TAU,
    });
    ice.push(paint(prep(g, true), mixc(0xd8f2ff, 0x9fd4ea, rng()).clone(), { rng, faceJitter: 0.1 }));
  }
  b.main.push(...ice);
  // a couple of fish
  if (opts.fish !== false) {
    for (let i = 0; i < rng.int(1, 3); i++) {
      const fl = rng.range(0.16, 0.26);
      const body = ico(fl * 0.34, 0);
      xf(body, { s: [1, 0.72, 2.1] });
      const tail = cone(fl * 0.18, fl * 0.2, 3);
      xf(tail, { rx: Math.PI / 2, z: -fl * 0.78, s: [1, 1, 0.35] });
      const fg = merge([body, tail]);
      const fc = rng.pick([0x7fb2d9, 0x9ec6a0, 0xd9b46a, 0xc98f9c]);
      paint(fg, (x, y) => mixc(fc, 0xf2f6f8, clamp01(y / (fl * 0.3)) * 0.75), { rng, faceJitter: 0.05, dirShade: 0.1 });
      xf(fg, { x: rng.gauss(0, W * 0.2), z: rng.gauss(0, D * 0.15), y: H * 0.72, ry: rng() * TAU, rz: rng.gauss(0, 0.2) });
      b.main.push(fg);
    }
  }
  const g = assemble(b, opts, 'fishCrate');
  return finish(g, 'fishCrate');
}

export function buildContainer(rng, opts = {}) {
  rng = asRng(rng);
  const L = opts.length ?? 6.06, W = opts.width ?? 2.44, H = opts.height ?? 2.59;
  const col = opts.color ?? rng.pick([0xc4483c, 0x2f6f9e, 0x3f8a5c, 0xd08a2c, 0x8a4f9e, 0x5a6169]);
  const b = bag();
  const rust = toColor(col).multiplyScalar(0.62).lerp(toColor(0x7a4a30), 0.4);
  const paintPanel = (g) => paint(g, (x, y, z) => {
    const w = valueNoise2(x * 0.9 + 3, y * 1.4 + z * 0.7);
    return _s2.copy(toColor(col)).lerp(rust, clamp01((w - 0.66) * 2.4) * 0.75).multiplyScalar(lerp(0.94, 1.04, valueNoise2(y * 3, x * 2)));
  }, { rng, faceJitter: 0.02, dirShade: 0.1, ao: 0.16 });

  for (const s of [-1, 1]) {
    const side = corrugated(rng, L - 0.16, H - 0.24, 16, 0.05, col);
    xf(side, { z: s * (W / 2 - 0.03), y: H / 2, ry: s > 0 ? 0 : Math.PI });
    b.main.push(paintPanel(side));
  }
  // back end
  const back = corrugated(rng, W - 0.16, H - 0.24, 6, 0.05, col);
  xf(back, { x: -(L / 2 - 0.03), y: H / 2, ry: -Math.PI / 2 });
  b.main.push(paintPanel(back));
  // roof
  const roof = corrugated(rng, L - 0.16, W - 0.16, 16, 0.04, col);
  xf(roof, { rx: -Math.PI / 2, y: H - 0.05 });
  b.main.push(paintPanel(roof));
  // door end: two flat leaves + locking bars
  for (const s of [-1, 1]) {
    const leaf = panel(rng, 0.06, H - 0.24, W / 2 - 0.12, col);
    xf(leaf, { x: L / 2 - 0.03, y: H / 2, z: s * (W / 4 - 0.02) });
    b.main.push(paintPanel(leaf));
    for (let i = 0; i < 2; i++) {
      const bar = cyl(0.035, 0.035, H - 0.34, 6);
      xf(bar, { x: L / 2 + 0.02, y: H / 2, z: s * (W / 4 - 0.02) + (i ? 0.24 : -0.24) });
      b.metal.push(paint(bar, 0x5c6268, { rng, faceJitter: 0.05, dirShade: 0.12 }));
    }
  }
  // frame rails + corner castings
  const frameCol = toColor(col).multiplyScalar(0.72).getHex();
  for (const sy of [0.09, H - 0.09]) for (const sz of [-1, 1]) {
    const r = panel(rng, L, 0.16, 0.13, frameCol);
    xf(r, { y: sy, z: sz * (W / 2 - 0.05) });
    b.main.push(r);
  }
  for (const sy of [0.09, H - 0.09]) for (const sx of [-1, 1]) {
    const r = panel(rng, 0.13, 0.16, W, frameCol);
    xf(r, { y: sy, x: sx * (L / 2 - 0.05) });
    b.main.push(r);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = panel(rng, 0.18, H, 0.18, frameCol);
    xf(p, { x: sx * (L / 2 - 0.07), y: H / 2, z: sz * (W / 2 - 0.07) });
    b.main.push(p);
    for (const sy of [0.09, H - 0.09]) {
      const c = panel(rng, 0.24, 0.2, 0.24, 0x565c62);
      xf(c, { x: sx * (L / 2 - 0.1), y: sy, z: sz * (W / 2 - 0.1) });
      b.metal.push(c);
    }
  }
  const g = assemble(b, opts, 'container');
  return finish(g, 'container', { color: col });
}

// ---------------------------------------------------------------------------
// SELL STATION
// ---------------------------------------------------------------------------

export function buildSellStation(rng, opts = {}) {
  rng = asRng(rng);
  const W = opts.width ?? 2.6, D = opts.depth ?? 1.1, H = opts.height ?? 0.95;
  const accent = opts.accent ?? rng.pick([PAINT.teal, PAINT.red, PAINT.blue]);
  const b = bag();
  // counter body: vertical planks + top slab
  const n = Math.max(4, Math.round(W / 0.28));
  for (let i = 0; i < n; i++) {
    const p = woodPlank(rng, W / n - 0.015, H, 0.07, WOOD.plank, { grain: 'z' });
    xf(p, { x: -W / 2 + (W / n) * (i + 0.5), y: H / 2, z: D / 2 - 0.035, rz: rng.gauss(0, 0.005) });
    b.main.push(p);
  }
  for (const sx of [-1, 1]) {
    const side = woodPlank(rng, 0.07, H, D, WOOD.plank, { grain: 'z' });
    xf(side, { x: sx * (W / 2 - 0.035), y: H / 2 });
    b.main.push(side);
  }
  for (let i = 0; i < 4; i++) {
    const p = woodPlank(rng, W + 0.16, 0.06, (D + 0.14) / 4 - 0.012, WOOD.deck, { grain: 'x' });
    xf(p, { y: H + 0.03, z: -(D + 0.14) / 2 + ((D + 0.14) / 4) * (i + 0.5), ry: rng.gauss(0, 0.004) });
    b.main.push(p);
  }
  // kick rail
  const rail = woodPlank(rng, W, 0.09, 0.05, WOOD.dark);
  xf(rail, { y: 0.1, z: D / 2 });
  b.main.push(rail);

  // ---- weighing scale (post, pan, dial)
  const sx0 = -W * 0.3;
  const post = cyl(0.045, 0.055, 0.42, 8);
  xf(post, { x: sx0, y: H + 0.24 });
  b.metal.push(paint(post, 0x8d949a, { rng, faceJitter: 0.04 }));
  const pan = cyl(0.24, 0.2, 0.045, 12);
  xf(pan, { x: sx0, y: H + 0.47 });
  b.metal.push(paint(pan, 0xb9c0c6, { rng, faceJitter: 0.03, dirShade: 0.12 }));
  const dialBack = cyl(0.16, 0.16, 0.05, 12);
  xf(dialBack, { x: sx0, y: H + 0.62, rx: Math.PI / 2 });
  b.metal.push(paint(dialBack, 0x5f666c, { rng, faceJitter: 0.03 }));
  const dialFace = cyl(0.135, 0.135, 0.02, 12);
  xf(dialFace, { x: sx0, y: H + 0.62, z: 0.03, rx: Math.PI / 2 });
  b.main.push(paint(dialFace, 0xf2ece0, { rng, faceJitter: 0.01 }));
  const needle = panel(rng, 0.012, 0.1, 0.012, 0xc03a34);
  xf(needle, { x: sx0, y: H + 0.655, z: 0.045, rz: rng.gauss(0, 0.5) });
  b.main.push(needle);

  // ---- price board on two posts
  const bx = W * 0.34, by = H + 0.95;
  for (const s of [-1, 1]) {
    const p = woodPlank(rng, 0.06, 1.0, 0.06, WOOD.post);
    xf(p, { x: bx + s * 0.36, y: H + 0.5, z: -D * 0.2 });
    b.main.push(p);
  }
  const board = woodPlank(rng, 0.9, 0.62, 0.05, 0x35302b);
  xf(board, { x: bx, y: by, z: -D * 0.2 });
  b.main.push(board);
  for (let i = 0; i < 4; i++) {
    const w = 0.62 * rng.range(0.45, 1);
    const bar = panel(rng, w, 0.05, 0.012, i === 0 ? accent : 0xe8e2d2);
    xf(bar, { x: bx - 0.32 + w / 2, y: by + 0.2 - i * 0.13, z: -D * 0.2 + 0.032 });
    b.main.push(bar);
  }
  // ---- fish bin on the counter
  const g = assemble(b, opts, 'sellStation');
  const bin = buildFishCrate(rng, { width: 0.8, depth: 0.55, height: 0.26, color: accent, material: opts.material });
  bin.position.set(W * 0.02, H + 0.06, D * 0.05);
  bin.rotation.y = rng.gauss(0, 0.12);
  g.add(bin);
  const interact = new THREE.Object3D();
  interact.position.set(0, H + 0.1, D / 2 + 0.5);
  g.add(interact);
  g.userData.interactAnchor = interact;
  g.userData.counterHeight = H;
  return finish(g, 'sellStation');
}

// ---------------------------------------------------------------------------
// SIGNPOST / LAMP / BUOY
// ---------------------------------------------------------------------------

/** Arrow-shaped board pointing +X, in the XY plane, thickness along Z. */
function arrowBoard(rng, w, h, t, col) {
  const fp = [
    [-w / 2, -h / 2], [w * 0.18, -h / 2], [w / 2, 0], [w * 0.18, h / 2], [-w / 2, h / 2],
  ];
  const g = prism(fp, t, { bottom: true, crown: 1 });
  xf(g, { rx: -Math.PI / 2, z: t / 2 });
  return woodPaintBoard(rng, g, col);
}
function woodPaintBoard(rng, g, col) {
  const c = toColor(col).multiplyScalar(1 + rng.gauss(0, 0.05));
  const dark = c.clone().multiplyScalar(0.68);
  return paint(prep(g, true), (x, y, z) => _s2.copy(c).lerp(dark, clamp01((valueNoise2(x * 6, y * 22) - 0.45) * 1.6) * 0.4),
    { rng, faceJitter: 0.025, dirShade: 0.12 });
}

export function buildSignpost(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(1.9, 2.5);
  const n = opts.arrows ?? rng.int(1, 3);
  const b = bag();
  const post = cyl(0.055, 0.075, h, 7);
  xf(post, { y: h / 2, rz: rng.gauss(0, 0.015) });
  b.main.push(paint(post, (x, y, z) => mixc(WOOD.post, 0x5a3f28, valueNoise2(y * 5, x * 6) * 0.7), { rng, faceJitter: 0.05, dirShade: 0.11 }));
  const cap = cone(0.085, 0.1, 7);
  xf(cap, { y: h + 0.05 });
  b.main.push(paint(cap, 0x5f4429, { rng, faceJitter: 0.06 }));
  const cols = [WOOD.deck, PAINT.cream, PAINT.teal, PAINT.yellow];
  for (let i = 0; i < n; i++) {
    const w = rng.range(0.72, 1.05), bh = 0.24;
    const board = arrowBoard(rng, w, bh, 0.05, rng.pick(cols));
    const flip = rng.chance(0.5) ? 0 : Math.PI;
    xf(board, { x: w / 2 * (flip ? -1 : 1) * 0 + 0, y: 0, z: 0 });
    xf(board, { x: (flip ? -1 : 1) * w * 0.42, ry: flip, y: h - 0.24 - i * 0.34, rz: rng.gauss(0, 0.03) });
    b.main.push(board);
    // fake lettering
    for (let k = 0; k < 3; k++) {
      const lw = w * rng.range(0.1, 0.2);
      const l = panel(rng, lw, 0.035, 0.012, 0x3a322a);
      xf(l, { x: -w * 0.28 + k * w * 0.19, y: 0, z: 0.032 });
      xf(l, { x: (flip ? -1 : 1) * w * 0.42, ry: flip, y: h - 0.24 - i * 0.34 });
      b.main.push(l);
    }
  }
  const g = assemble(b, opts, 'signpost');
  return finish(g, 'signpost');
}

export function buildLampPost(rng, opts = {}) {
  rng = asRng(rng);
  const h = opts.height ?? rng.range(3.2, 4.2);
  const col = opts.color ?? 0x3c4a52;
  const b = bag();
  const base = cyl(0.14, 0.2, 0.26, 8);
  xf(base, { y: 0.13 });
  b.metal.push(paint(base, col, { rng, faceJitter: 0.04, dirShade: 0.12 }));
  const ring = cyl(0.11, 0.13, 0.07, 8);
  xf(ring, { y: 0.3 });
  b.metal.push(paint(ring, col, { rng, faceJitter: 0.04 }));
  // pole
  const pp = [], pr = [];
  for (let i = 0; i < 5; i++) { const t = i / 4; pp.push(V(0, lerp(0.24, h * 0.78, t), 0)); pr.push(lerp(0.075, 0.05, t)); }
  b.metal.push(paint(tube(pp, pr, 7, { caps: false }), col, { rng, faceJitter: 0.03, dirShade: 0.12 }));
  // curved arm
  const armR = h * 0.2;
  const ap = [], ar = [];
  for (let i = 0; i < 6; i++) {
    const t = i / 5, a = t * Math.PI * 0.5;
    ap.push(V(Math.sin(a) * armR, h * 0.78 + (1 - Math.cos(a)) * armR * 0.85, 0));
    ar.push(lerp(0.05, 0.035, t));
  }
  b.metal.push(paint(tube(ap, ar, 6, { caps: false }), col, { rng, faceJitter: 0.03, dirShade: 0.12 }));
  const tip = ap[5];
  // lamp housing
  const hood = cone(0.19, 0.16, 8);
  xf(hood, { x: tip.x, y: tip.y + 0.04 });
  b.metal.push(paint(hood, col, { rng, faceJitter: 0.04 }));
  const collar = cyl(0.05, 0.07, 0.06, 8);
  xf(collar, { x: tip.x, y: tip.y + 0.13 });
  b.metal.push(paint(collar, col, { rng }));
  const glass = cone(0.15, 0.16, 8);
  xf(glass, { x: tip.x, y: tip.y - 0.09, rx: Math.PI });
  b.glow.push({ geo: glass, color: opts.lightColor ?? 0xffd493, intensity: 1.9 });

  const g = assemble(b, opts, 'lampPost');
  const anchor = new THREE.Object3D();
  anchor.position.set(tip.x, tip.y - 0.13, 0);
  anchor.name = 'lightAnchor';
  g.add(anchor);
  g.userData.lightAnchor = anchor;
  return finish(g, 'lampPost');
}

export function buildBuoy(rng, opts = {}) {
  rng = asRng(rng);
  const r = opts.radius ?? 0.42;
  const col = opts.color ?? rng.pick([0xd94f3d, 0xe8912f, 0xe0c33a]);
  const b = bag();
  const prof = [
    new THREE.Vector2(0, -r * 1.3), new THREE.Vector2(r * 0.55, -r * 1.05), new THREE.Vector2(r, -r * 0.3),
    new THREE.Vector2(r, r * 0.28), new THREE.Vector2(r * 0.72, r * 0.62), new THREE.Vector2(r * 0.3, r * 0.8),
    new THREE.Vector2(0, r * 0.84),
  ];
  const body = lathe(prof, 10, true);
  b.main.push(paint(body, (x, y, z) => {
    const band = Math.abs(y) < r * 0.2 ? 1 : 0;
    const wet = clamp01(-y / (r * 0.9));
    return _s2.copy(toColor(band ? 0xf0efe8 : col)).lerp(toColor(0x2d5f4f), wet * 0.5);
  }, { rng, faceJitter: 0.03, dirShade: 0.11 }));
  // mast + light + radar reflector
  const mast = cyl(0.03, 0.035, r * 1.5, 6);
  xf(mast, { y: r * 0.84 + r * 0.75 });
  b.metal.push(paint(mast, 0x5c6369, { rng, faceJitter: 0.04 }));
  const cage = box(r * 0.36, r * 0.36, 0.02);
  xf(cage, { y: r * 0.84 + r * 0.95, ry: Math.PI / 4 });
  b.metal.push(paint(cage, 0x8f979d, { rng }));
  const cage2 = box(0.02, r * 0.36, r * 0.36);
  xf(cage2, { y: r * 0.84 + r * 0.95, ry: Math.PI / 4 });
  b.metal.push(paint(cage2, 0x8f979d, { rng }));
  const lamp = ico(r * 0.15, 0);
  xf(lamp, { y: r * 0.84 + r * 1.55 });
  b.glow.push({ geo: lamp, color: opts.lightColor ?? 0xff6a3d, intensity: 2.4 });
  // rope collar
  b.main.push(xf(ropeRing(rng, r * 1.02, 0.035), { y: r * 0.05 }));

  const g = assemble(b, opts, 'buoy');
  const anchor = new THREE.Object3D();
  anchor.position.set(0, r * 0.84 + r * 1.55, 0);
  g.add(anchor);
  g.userData.lightAnchor = anchor;
  g.userData.floatRadius = r;
  return finish(g, 'buoy', { floatRadius: r, draft: r * 1.3 });
}

// ---------------------------------------------------------------------------
// WRECKED BOAT
// ---------------------------------------------------------------------------

/** The player's crashed starter boat: snapped hull, broken mast, loose planks. */
export function buildWreckedBoat(rng, opts = {}) {
  rng = asRng(rng);
  const L = opts.length ?? 5.2, B = opts.beam ?? 1.7, Dp = opts.draft ?? 0.95;
  const hullCol = opts.color ?? rng.pick([PAINT.red, PAINT.blue, PAINT.green, 0xb8562f]);
  const b = bag();
  const S = 7, ring = 9;
  const P = [], U = [];
  const station = (t) => {
    // t: 0 = bow, 1 = snapped stern
    const z = lerp(L * 0.5, -L * 0.5, t);
    const beam = B * 0.5 * Math.sin(Math.PI * clamp01(0.12 + t * 0.86)) * lerp(1.0, 0.92, t);
    const depth = Dp * lerp(0.45, 1.0, Math.pow(clamp01(t * 1.25), 0.7));
    return { z, beam, depth };
  };
  const sectionPt = (st, k, jag) => {
    const u = k / (ring - 1); // 0 = port gunwale -> 1 = starboard gunwale
    const a = Math.PI * u;
    const x = -Math.cos(a) * st.beam;
    const y = -Math.sin(a) * st.depth * (0.55 + 0.45 * Math.sin(a));
    return V(x, y + jag, st.z);
  };
  for (let i = 0; i < S - 1; i++) {
    const t0 = i / (S - 1), t1 = (i + 1) / (S - 1);
    const s0 = station(t0), s1 = station(t1);
    for (let k = 0; k < ring - 1; k++) {
      // ragged broken top edge near the stern
      const jag = (tt, kk) => (tt > 0.6 ? -(Math.abs(Math.sin(kk * 2.3)) * (tt - 0.6) * Dp * 1.1) : 0);
      const A = sectionPt(s0, k, jag(t0, k)), Bv = sectionPt(s0, k + 1, jag(t0, k + 1));
      const C = sectionPt(s1, k + 1, jag(t1, k + 1)), D = sectionPt(s1, k, jag(t1, k));
      P.push(A.x, A.y, A.z, Bv.x, Bv.y, Bv.z, C.x, C.y, C.z);
      P.push(A.x, A.y, A.z, C.x, C.y, C.z, D.x, D.y, D.z);
      for (let q = 0; q < 6; q++) U.push(k / ring, t0);
    }
  }
  const hull = new THREE.BufferGeometry();
  hull.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  hull.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  hull.computeVertexNormals();
  const hullG = doubleSide(prep(hull));
  paint(hullG, (x, y, z) => {
    const strake = Math.sin(y * 11 + z * 0.6) * 0.5 + 0.5;
    const worn = clamp01(valueNoise2(z * 1.6, x * 2.2 + y * 2) - 0.5) * 1.6;
    return _s2.copy(toColor(y > -Dp * 0.35 ? hullCol : 0x39534f))
      .multiplyScalar(lerp(0.9, 1.06, strake))
      .lerp(toColor(WOOD.old), worn * 0.7);
  }, { rng, faceJitter: 0.035, dirShade: 0.11 });
  b.main.push(hullG);
  // keel + gunwale rails
  const keel = woodPlank(rng, 0.1, 0.14, L * 0.9, WOOD.dark, { grain: 'z' });
  xf(keel, { y: -Dp * 0.98, z: -L * 0.02 });
  b.main.push(keel);
  for (const s of [-1, 1]) {
    const rail = woodPlank(rng, 0.09, 0.1, L * 0.75, WOOD.deck, { grain: 'z' });
    xf(rail, { x: s * B * 0.46, y: 0.02, z: L * 0.1, ry: s * 0.05 });
    b.main.push(rail);
  }
  // thwart seats
  for (let i = 0; i < 2; i++) {
    const st = station(0.3 + i * 0.2);
    const seat = woodPlank(rng, st.beam * 1.9, 0.06, 0.22, WOOD.deck, { grain: 'x' });
    xf(seat, { y: -st.depth * 0.35, z: st.z });
    b.main.push(seat);
  }
  // snapped mast lying across the wreck
  const mp = [], mr = [];
  const mLen = L * 0.75;
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    mp.push(V(lerp(-0.3, B * 0.9, t), lerp(0.35, -0.15, t) + Math.sin(t * 2) * 0.05, lerp(L * 0.15, -L * 0.5, t)));
    mr.push(lerp(0.075, 0.045, t) * (i === 4 ? 0.6 : 1));
  }
  b.main.push(paint(tube(mp, mr, 6, { caps: true }), (x, y, z) => mixc(WOOD.old, 0x6d5f4b, valueNoise2(z * 4, x * 4)),
    { rng, faceJitter: 0.06, dirShade: 0.11 }));
  // splintered stump
  const stump = cone(0.085, 0.42, 5);
  xf(stump, { y: 0.2, z: L * 0.18, rz: rng.gauss(0, 0.15) });
  b.main.push(paint(stump, WOOD.old, { rng, faceJitter: 0.1 }));
  // scattered planks in the sand
  for (let i = 0; i < rng.int(4, 7); i++) {
    const p = woodPlank(rng, rng.range(0.7, 1.6), 0.05, rng.range(0.14, 0.22), rng.chance(0.4) ? hullCol : WOOD.old, { grain: 'x' });
    const a = rng() * TAU, rr = rng.range(L * 0.35, L * 0.85);
    xf(p, { x: Math.cos(a) * rr * 0.6, z: Math.sin(a) * rr, y: -Dp * 0.68 + rng.range(0, 0.08), ry: rng() * TAU, rz: rng.gauss(0, 0.12) });
    b.main.push(p);
  }
  // sand mound the hull is buried in
  const mound = ico(L * 0.42, 1);
  xf(mound, { s: [1.35, 0.3, 1.6] });
  deform(mound, { amp: 0.22, freq: 0.9, seed: rng() * 300, sharp: 3 });
  xf(mound, { y: -Dp * 1.42 });
  b.main.push(paint(prep(mound, true), (x, y, z, nx, ny) => mixc(0xd9c48f, 0xf0e2b8, clamp01(ny) * 0.7),
    { rng, faceJitter: 0.05, dirShade: 0.06 }));

  const g = assemble(b, opts, 'wreckedBoat');
  g.rotation.z = rng.gauss(0, 0.09);
  g.rotation.x = rng.gauss(0.07, 0.04);
  g.position.y = Dp * 0.66;
  const anchor = new THREE.Object3D();
  anchor.position.set(0, 0.2, L * 0.1);
  g.add(anchor);
  g.userData.interactAnchor = anchor;
  return finish(g, 'wreckedBoat');
}

// ---------------------------------------------------------------------------
// WAREHOUSE / PIER / CRANE
// ---------------------------------------------------------------------------

export function buildWarehouse(rng, opts = {}) {
  rng = asRng(rng);
  const W = opts.width ?? 12, D = opts.depth ?? 9, H = opts.height ?? 5.2;
  const roofRise = opts.roofRise ?? 1.5;
  const col = opts.color ?? rng.pick([0xb9c0c4, 0xa8b4b8, 0xc3b49a, 0x9fb0bd]);
  const trim = opts.trim ?? rng.pick([PAINT.red, PAINT.blue, PAINT.teal, 0x4a5258]);
  const b = bag();
  const doorW = Math.min(W * 0.42, 4.4), doorH = Math.min(H * 0.72, 3.6);

  // --- walls (front wall is split around the roller door)
  const wall = (w, h, x, y, z, ry, folds) => {
    const g = corrugated(rng, w, h, folds ?? Math.max(4, Math.round(w * 1.4)), 0.055, col);
    xf(g, { x, y, z, ry });
    b.main.push(paint(g, (px, py) => _s2.copy(toColor(col)).multiplyScalar(lerp(0.78, 1.03, clamp01(py / H))), { rng, faceJitter: 0.02, dirShade: 0.09 }));
  };
  wall(W, H, 0, H / 2, -D / 2, 0);
  wall(D, H, -W / 2, H / 2, 0, Math.PI / 2);
  wall(D, H, W / 2, H / 2, 0, Math.PI / 2);
  const sideW = (W - doorW) / 2;
  wall(sideW, H, -(doorW + sideW) / 2, H / 2, D / 2, 0);
  wall(sideW, H, (doorW + sideW) / 2, H / 2, D / 2, 0);
  wall(doorW, H - doorH, 0, doorH + (H - doorH) / 2, D / 2, 0);

  // --- roller door
  const slats = 9;
  for (let i = 0; i < slats; i++) {
    const s = panel(rng, doorW - 0.14, doorH / slats - 0.02, 0.06, i % 2 ? 0xb0b7bb : 0xa2a9ad);
    xf(s, { y: (doorH / slats) * (i + 0.5), z: D / 2 + 0.03 });
    b.metal.push(s);
  }
  const frame = panel(rng, doorW + 0.22, 0.18, 0.14, trim);
  xf(frame, { y: doorH + 0.09, z: D / 2 + 0.04 });
  b.main.push(frame);
  for (const s of [-1, 1]) {
    const j = panel(rng, 0.16, doorH, 0.14, trim);
    xf(j, { x: s * (doorW / 2 + 0.08), y: doorH / 2, z: D / 2 + 0.04 });
    b.main.push(j);
  }
  // small personnel door
  const pd = panel(rng, 0.9, 2.05, 0.08, trim);
  xf(pd, { x: -(doorW / 2 + sideW * 0.55), y: 1.03, z: D / 2 + 0.06 });
  b.main.push(pd);

  // --- window band
  for (const [z, ry, len] of [[-D / 2 - 0.02, 0, W], [0, Math.PI / 2, D]]) {
    for (const sx of (ry ? [-1, 1] : [0])) {
      const nWin = Math.max(2, Math.round(len / 2.4));
      for (let i = 0; i < nWin; i++) {
        const w = len / nWin * 0.6;
        const g = panel(rng, w, 0.75, 0.05, 0x2b3a42);
        const off = -len / 2 + (len / nWin) * (i + 0.5);
        if (ry) xf(g, { x: sx * (W / 2 + 0.02), y: H * 0.7, z: off, ry });
        else xf(g, { x: off, y: H * 0.7, z });
        b.main.push(paint(g, (px, py) => mixc(0x6fa9c4, 0x2c4450, clamp01(0.5 - py + H * 0.7)), { rng, faceJitter: 0.05 }));
      }
    }
  }
  // --- base plinth
  const plinth = panel(rng, W + 0.3, 0.45, D + 0.3, 0x8f8d88);
  xf(plinth, { y: 0.22 });
  b.main.push(plinth);

  // --- gable roof
  const slopeLen = Math.hypot(D / 2, roofRise);
  for (const s of [-1, 1]) {
    const g = corrugated(rng, W + 0.55, slopeLen + 0.15, 22, 0.07, toColor(col).multiplyScalar(0.86).getHex(), { horizontal: false });
    const ang = Math.atan2(roofRise, D / 2);
    xf(g, { rx: -s * (Math.PI / 2 - ang) - (s > 0 ? 0 : 0) });
    xf(g, { y: H + roofRise / 2, z: s * D / 4 });
    b.main.push(g);
  }
  const ridge = panel(rng, W + 0.6, 0.14, 0.3, trim);
  xf(ridge, { y: H + roofRise + 0.03 });
  b.main.push(ridge);
  for (const s of [-1, 1]) {
    const P = [-W / 2, H, 0, W / 2, H, 0, 0, H + roofRise, 0];
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    gg.computeVertexNormals();
    const g2 = doubleSide(prep(gg));
    xf(g2, { z: s * D / 2 });
    b.main.push(paint(g2, toColor(col).multiplyScalar(0.94).getHex(), { rng, faceJitter: 0.02, dirShade: 0.09 }));
  }
  // roof vents
  for (let i = 0; i < 2; i++) {
    const v = cyl(0.3, 0.34, 0.4, 8);
    xf(v, { x: lerp(-W * 0.25, W * 0.25, i), y: H + roofRise + 0.22 });
    b.metal.push(paint(v, 0x8d949a, { rng, faceJitter: 0.04 }));
    const capv = cone(0.42, 0.16, 8);
    xf(capv, { x: lerp(-W * 0.25, W * 0.25, i), y: H + roofRise + 0.5 });
    b.metal.push(paint(capv, 0x7f868c, { rng, faceJitter: 0.04 }));
  }
  const g = assemble(b, opts, 'warehouse');
  g.userData.doorAnchor = new THREE.Object3D();
  g.userData.doorAnchor.position.set(0, 0, D / 2 + 1.2);
  g.add(g.userData.doorAnchor);
  return finish(g, 'warehouse');
}

export function buildPier(rng, opts = {}) {
  rng = asRng(rng);
  const L = opts.length ?? 22, W = opts.width ?? 4.5, H = opts.height ?? 1.8;
  const b = bag();
  // concrete deck
  const deck = panel(rng, W, 0.34, L, 0xb4b2a8, { ao: 0.05 });
  xf(deck, { y: H - 0.17 });
  b.main.push(paint(deck, (x, y, z) => _s2.copy(toColor(0xb6b4aa))
    .lerp(toColor(0x8d8b82), clamp01(valueNoise2(x * 1.4, z * 0.7) - 0.42) * 1.3)
    .lerp(toColor(0x6f6d66), y < H - 0.2 ? 0.35 : 0), { rng, faceJitter: 0.02, dirShade: 0.1 }));
  // expansion joints
  const joints = Math.max(2, Math.round(L / 3));
  for (let i = 1; i < joints; i++) {
    const j = panel(rng, W + 0.02, 0.04, 0.05, 0x6f6d66);
    xf(j, { y: H, z: -L / 2 + (L / joints) * i });
    b.main.push(j);
  }
  // timber edge trim
  for (const s of [-1, 1]) {
    const t = woodPlank(rng, 0.14, 0.2, L, WOOD.dark, { grain: 'z' });
    xf(t, { x: s * (W / 2 + 0.05), y: H - 0.1 });
    b.main.push(t);
  }
  // square pilings
  const bays = Math.max(2, Math.round(L / 3.4));
  for (let i = 0; i <= bays; i++) {
    const z = -L / 2 + (L * i) / bays;
    for (const s of [-1, 1]) {
      const p = panel(rng, 0.42, H + 1.1, 0.42, 0x9b988e);
      xf(p, { x: s * (W / 2 - 0.35), y: (H - 0.34) / 2 - 0.55, z, rz: rng.gauss(0, 0.008) });
      b.main.push(paint(p, (x, y) => _s2.copy(toColor(0x9b988e)).lerp(toColor(0x4f5e4f), clamp01(1 - (y + 0.55) / 0.9) * 0.8),
        { rng, faceJitter: 0.03, dirShade: 0.11 }));
    }
    // cross beam
    const cb = panel(rng, W - 0.2, 0.26, 0.3, 0xa8a59a);
    xf(cb, { y: H - 0.5, z });
    b.main.push(cb);
  }
  // bollards
  const nb = Math.max(2, Math.round(L / 5));
  for (let i = 0; i < nb; i++) {
    const z = lerp(-L * 0.4, L * 0.4, nb === 1 ? 0.5 : i / (nb - 1));
    const s = i % 2 ? 1 : -1;
    const x = s * (W / 2 - 0.45);
    const body = lathe([
      new THREE.Vector2(0, 0), new THREE.Vector2(0.2, 0), new THREE.Vector2(0.17, 0.42),
      new THREE.Vector2(0.22, 0.52), new THREE.Vector2(0.14, 0.58), new THREE.Vector2(0, 0.6),
    ], 9, true);
    xf(body, { x, y: H, z });
    b.metal.push(paint(body, 0x3f474d, { rng, faceJitter: 0.04, dirShade: 0.13 }));
    if (rng.chance(0.5)) b.main.push(xf(ropeRing(rng, 0.24, 0.04), { x, y: H + 0.12, z }));
  }
  // railing on one side
  if (opts.railing !== false) {
    const posts = Math.max(3, Math.round(L / 2.2));
    for (let i = 0; i <= posts; i++) {
      const z = -L / 2 + (L * i) / posts;
      const p = cyl(0.045, 0.05, 1.0, 6);
      xf(p, { x: -(W / 2 - 0.15), y: H + 0.5, z });
      b.metal.push(paint(p, 0x6e767c, { rng, faceJitter: 0.04 }));
    }
    for (const y of [H + 0.95, H + 0.55]) {
      const r = cyl(0.035, 0.035, L, 6);
      xf(r, { rx: Math.PI / 2, x: -(W / 2 - 0.15), y });
      b.metal.push(paint(r, 0x7b838a, { rng, faceJitter: 0.03, dirShade: 0.12 }));
    }
  }
  // tyre fenders
  for (let i = 0; i < Math.max(2, Math.round(L / 6)); i++) {
    const z = lerp(-L * 0.35, L * 0.35, i / Math.max(1, Math.round(L / 6) - 1));
    const t = tor(0.28, 0.1, 4, 9);
    xf(t, { x: W / 2 + 0.12, y: H - 0.75, z, ry: Math.PI / 2 });
    b.main.push(paint(t, 0x2e3033, { rng, faceJitter: 0.06, dirShade: 0.12 }));
  }
  const g = assemble(b, opts, 'pier');
  return finish(g, 'pier', { deckHeight: H, length: L, width: W });
}

export function buildCrane(rng, opts = {}) {
  rng = asRng(rng);
  const H = opts.height ?? 9, reach = opts.reach ?? 8;
  const col = opts.color ?? rng.pick([0xe0a233, 0xd4552f, 0x3f7fa8]);
  const b = bag();
  const beam = (w, h, d, x, y, z, rz = 0, rx = 0, c = col) => {
    const g = panel(rng, w, h, d, c);
    xf(g, { x, y, z, rz, rx });
    b.main.push(g);
    return g;
  };
  // base
  const base = panel(rng, 3.0, 0.4, 3.0, 0x6e747a);
  xf(base, { y: 0.2 });
  b.main.push(base);
  const house = panel(rng, 2.2, 1.1, 2.4, col);
  xf(house, { y: 0.95 });
  b.main.push(house);
  // tower legs + braces
  const legR = 0.75, top = H;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pts = [V(sx * legR * 1.5, 1.4, sz * legR * 1.5), V(sx * legR, top, sz * legR)];
    const g = tube([pts[0], pts[0].clone().lerp(pts[1], 0.5), pts[1]], [0.13, 0.11, 0.1], 4, { caps: true });
    b.main.push(paint(g, col, { rng, faceJitter: 0.03, dirShade: 0.13 }));
  }
  const rungs = Math.max(3, Math.round((top - 1.4) / 1.5));
  for (let i = 0; i <= rungs; i++) {
    const t = i / rungs, y = lerp(1.4, top, t), r = lerp(legR * 1.5, legR, t);
    for (const [ax, az] of [[1, 0], [0, 1]]) {
      beam(ax ? r * 2 : 0.08, 0.08, az ? r * 2 : 0.08, 0, y, 0);
    }
    if (i < rungs) {
      const y2 = lerp(1.4, top, (i + 1) / rungs);
      const len = Math.hypot(r * 2, y2 - y);
      for (const s of [-1, 1]) {
        beam(len, 0.06, 0.06, 0, (y + y2) / 2, s * lerp(legR * 1.5, legR, t), Math.atan2(y2 - y, r * 2) * (i % 2 ? 1 : -1));
        beam(0.06, 0.06, len, s * lerp(legR * 1.5, legR, t), (y + y2) / 2, 0, 0, Math.atan2(y2 - y, r * 2) * (i % 2 ? -1 : 1));
      }
    }
  }
  const g = assemble(b, opts, 'crane');

  // --- rotating arm
  const arm = new THREE.Object3D();
  arm.name = 'armPivot';
  arm.position.set(0, H + 0.15, 0);
  const ab = bag();
  const abeam = (w, h, d, x, y, z, rz = 0, c = col) => {
    const gg = panel(rng, w, h, d, c);
    xf(gg, { x, y, z, rz });
    ab.main.push(gg);
  };
  // boom chords
  for (const sy of [0.28, -0.28]) {
    for (const sz of [-0.3, 0.3]) abeam(reach, 0.1, 0.1, reach / 2 - 0.3, sy, sz);
  }
  const nD = Math.max(4, Math.round(reach / 1.1));
  for (let i = 0; i < nD; i++) {
    const x = -0.3 + (reach / nD) * (i + 0.5);
    const len = Math.hypot(reach / nD, 0.56);
    for (const sz of [-0.3, 0.3]) abeam(len, 0.055, 0.055, x, 0, sz, (i % 2 ? 1 : -1) * Math.atan2(0.56, reach / nD));
    abeam(0.06, 0.56, 0.6, x + reach / nD / 2, 0, 0);
  }
  // counterweight
  const cw = panel(rng, 2.1, 1.0, 1.5, 0x5a6167);
  xf(cw, { x: -1.6, y: -0.1 });
  ab.main.push(cw);
  abeam(2.4, 0.16, 0.7, -1.1, 0.34, 0);
  // cab
  const cab = panel(rng, 1.1, 0.9, 1.1, col);
  xf(cab, { x: 0.85, y: -0.62 });
  ab.main.push(cab);
  const glassC = panel(rng, 0.9, 0.5, 1.14, 0x4f7f96);
  xf(glassC, { x: 0.95, y: -0.5 });
  ab.main.push(glassC);
  const armG = assemble(ab, opts, 'craneArm');
  arm.add(armG);
  // cable + hook
  const hookY = opts.hookDrop ?? H * 0.55;
  const cb = bag();
  const cable = cyl(0.025, 0.025, hookY, 4);
  xf(cable, { x: reach * 0.85, y: -hookY / 2 });
  cb.metal.push(paint(cable, 0x3e4348, { rng }));
  const blockG = panel(rng, 0.26, 0.34, 0.2, 0x4b5158);
  xf(blockG, { x: reach * 0.85, y: -hookY - 0.16 });
  cb.metal.push(blockG);
  const hook = tor(0.14, 0.045, 3, 8);
  xf(hook, { x: reach * 0.85, y: -hookY - 0.42, rx: Math.PI / 2, ry: Math.PI / 2 });
  cb.metal.push(paint(hook, 0x8b9298, { rng, faceJitter: 0.05 }));
  arm.add(assemble(cb, opts, 'craneHook'));
  arm.rotation.y = rng.range(-0.6, 0.6);
  g.add(arm);
  g.userData.armPivot = arm;
  g.userData.hookAnchor = new THREE.Object3D();
  g.userData.hookAnchor.position.set(reach * 0.85, -hookY - 0.5, 0);
  arm.add(g.userData.hookAnchor);
  return finish(g, 'crane', { reach });
}

// ---------------------------------------------------------------------------
// TENT / ROPE / ROD / ANTENNA
// ---------------------------------------------------------------------------

export function buildTent(rng, opts = {}) {
  rng = asRng(rng);
  const W = opts.width ?? 2.2, L = opts.length ?? 2.8, H = opts.height ?? 1.6;
  const col = opts.color ?? rng.pick([0xd9683f, 0x3f8a6e, 0x4a6fa8, 0xd8b24a]);
  const b = bag();
  const P = [], U = [], C = [];
  const c0 = toColor(col), c1 = toColor(col).multiplyScalar(0.72);
  const push = (x, y, z, u, v, c) => { P.push(x, y, z); U.push(u, v); C.push(c.r, c.g, c.b); };
  const segs = 5;
  for (const s of [-1, 1]) {
    for (let i = 0; i < segs; i++) {
      const z0 = -L / 2 + (L * i) / segs, z1 = -L / 2 + (L * (i + 1)) / segs;
      const sag = (z) => H * (1 - 0.06 * Math.cos((z / L) * Math.PI * 2));
      const cA = _s.copy(c0).lerp(c1, 0.15 + 0.12 * (i % 2)).clone();
      const cB = _s.copy(c0).lerp(c1, 0.55).clone();
      push(0, sag(z0), z0, 0, 0, cA); push(0, sag(z1), z1, 0, 1, cA);
      push(s * W / 2, 0.02, z1, 1, 1, cB);
      push(0, sag(z0), z0, 0, 0, cA); push(s * W / 2, 0.02, z1, 1, 1, cB); push(s * W / 2, 0.02, z0, 1, 0, cB);
    }
  }
  // back wall
  push(0, H * 0.94, -L / 2, 0, 0, c1.clone()); push(-W / 2, 0.02, -L / 2, 0, 1, c1.clone()); push(W / 2, 0.02, -L / 2, 1, 1, c1.clone());
  // front flaps (rolled open)
  for (const s of [-1, 1]) {
    push(0, H * 0.94, L / 2, 0, 0, c1.clone());
    push(s * W * 0.42, 0.02, L / 2, 0, 1, c1.clone());
    push(s * W * 0.16, 0.02, L / 2, 1, 1, c1.clone());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  // colours are authored per-vertex above, so no repaint pass here
  b.main.push(doubleSide(prep(g)));
  // poles
  for (const s of [-1, 1]) {
    const p = cyl(0.028, 0.032, H + 0.14, 5);
    xf(p, { y: (H + 0.14) / 2, z: s * (L / 2 - 0.02) });
    b.main.push(paint(p, WOOD.post, { rng, faceJitter: 0.05 }));
  }
  const ridgePole = cyl(0.026, 0.026, L + 0.2, 5);
  xf(ridgePole, { rx: Math.PI / 2, y: H + 0.03 });
  b.main.push(paint(ridgePole, WOOD.post, { rng, faceJitter: 0.05 }));
  // guy ropes + pegs
  for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
    const from = V(0, H + 0.05, sz * (L / 2 + 0.02));
    const to = V(sx * W * 0.75, 0.02, sz * (L / 2 + 0.75));
    b.main.push(paint(tube([from, from.clone().lerp(to, 0.5).add(V(0, -0.05, 0)), to], [0.012, 0.012, 0.01], 3, { caps: false }),
      0xd6c39a, { rng, faceJitter: 0.05 }));
    const peg = cyl(0.016, 0.02, 0.16, 4);
    xf(peg, { x: to.x, y: 0.06, z: to.z, rz: sx * 0.25 });
    b.main.push(paint(peg, 0x6d5a3f, { rng, faceJitter: 0.06 }));
  }
  const grp = assemble(b, opts, 'tent');
  return finish(grp, 'tent');
}

export function buildRopeCoil(rng, opts = {}) {
  rng = asRng(rng);
  const R = opts.radius ?? 0.36, th = opts.thickness ?? 0.045;
  const col = opts.color ?? rng.pick([0xc9ab74, 0xb9a37e, 0xd8c396]);
  const b = bag();
  const loops = opts.loops ?? rng.int(4, 6);
  for (let i = 0; i < loops; i++) {
    const t = i / Math.max(1, loops - 1);
    const r = R * lerp(1.0, 0.62, t) * rng.range(0.97, 1.03);
    const g = tor(r, th, 3, 9);
    xf(g, { rx: Math.PI / 2, y: th + t * th * 1.55, ry: rng() * TAU, rz: rng.gauss(0, 0.035) });
    b.main.push(paint(g, (x, y, z) => {
      const a = Math.atan2(z, x);
      return _s2.copy(toColor(col)).multiplyScalar(lerp(0.78, 1.12, 0.5 + 0.5 * Math.cos(a * 26)));
    }, { rng, faceJitter: 0.05, dirShade: 0.12 }));
  }
  // loose tail
  const tail = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4, a = t * 2.4;
    tail.push(V(Math.cos(a) * R * lerp(0.62, 1.5, t), th * 1.2 + loops * th * 1.55 * (1 - t) * 0.2, Math.sin(a) * R * lerp(0.62, 1.5, t)));
  }
  b.main.push(paint(tube(tail, tail.map(() => th), 4, { caps: true }), col, { rng, faceJitter: 0.06, dirShade: 0.1 }));
  const g = assemble(b, opts, 'ropeCoil');
  return finish(g, 'ropeCoil');
}

/** A rod leaning against something — the world pickup. */
export function buildFishingRodProp(rng, opts = {}) {
  rng = asRng(rng);
  const L = opts.length ?? 2.1;
  const col = opts.color ?? rng.pick([0x2f4a5c, 0x5c2f2f, 0x2f5c3c, 0x3a3a44]);
  const b = bag();
  // rod blank (tapered, gentle bend)
  const pts = [], radii = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    pts.push(V(Math.pow(t, 2.1) * L * 0.1, L * t, 0));
    radii.push(lerp(0.019, 0.004, Math.pow(t, 0.75)));
  }
  b.main.push(paint(tube(pts, radii, 5, { caps: true }), (x, y) => mixc(col, 0x1c1f24, clamp01(y / L) * 0.5), { rng, faceJitter: 0.03, dirShade: 0.12 }));
  // cork grip + butt
  const grip = cyl(0.028, 0.03, 0.34, 7);
  xf(grip, { y: 0.2 });
  b.main.push(paint(grip, (x, y, z) => _s2.copy(toColor(0xd3b184)).lerp(toColor(0x9c7a4e), clamp01(valueNoise2(x * 40, z * 40 + y * 20) - 0.4) * 1.5),
    { rng, faceJitter: 0.06 }));
  const butt = cyl(0.032, 0.026, 0.06, 7);
  xf(butt, { y: 0.03 });
  b.main.push(paint(butt, 0x2b2f34, { rng, faceJitter: 0.04 }));
  // reel seat + reel
  const seat = cyl(0.03, 0.03, 0.1, 7);
  xf(seat, { y: 0.42 });
  b.metal.push(paint(seat, 0x8f979d, { rng, faceJitter: 0.04 }));
  const reelBody = cyl(0.085, 0.085, 0.06, 8);
  xf(reelBody, { y: 0.4, z: -0.09, rx: Math.PI / 2 });
  b.metal.push(paint(reelBody, 0x9aa2a8, { rng, faceJitter: 0.04, dirShade: 0.12 }));
  const spool = cyl(0.06, 0.06, 0.075, 8);
  xf(spool, { y: 0.4, z: -0.09, rx: Math.PI / 2 });
  b.main.push(paint(spool, 0xc9b98a, { rng, faceJitter: 0.05 }));
  const stem = panel(rng, 0.022, 0.1, 0.022, 0x8f979d);
  xf(stem, { y: 0.4, z: -0.045 });
  b.metal.push(stem);
  const handle = cyl(0.012, 0.012, 0.11, 5);
  xf(handle, { y: 0.4, z: -0.14, rz: Math.PI / 2 });
  b.metal.push(paint(handle, 0x767e85, { rng }));
  // guides
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    const r = tor(0.016 + 0.006 * (1 - t), 0.004, 3, 6);
    xf(r, { x: Math.pow(t, 2.1) * L * 0.1, y: L * t, rx: Math.PI / 2, rz: Math.PI / 2 });
    b.metal.push(paint(r, 0xb8c0c6, { rng }));
  }
  const g = assemble(b, opts, 'fishingRodProp');
  g.rotation.z = opts.lean ?? rng.range(0.16, 0.3);
  g.rotation.y = rng() * TAU;
  return finish(g, 'fishingRodProp');
}

export function buildAntenna(rng, opts = {}) {
  rng = asRng(rng);
  const H = opts.height ?? rng.range(5, 8);
  const col = opts.color ?? 0xb8bfc4;
  const b = bag();
  // mast
  const mp = [], mr = [];
  for (let i = 0; i < 6; i++) { const t = i / 5; mp.push(V(0, H * t, 0)); mr.push(lerp(0.1, 0.035, t)); }
  b.metal.push(paint(tube(mp, mr, 5, { caps: true }), (x, y) => mixc(col, 0xd94f3d, (Math.floor(y / (H / 6)) % 2) * 0.75),
    { rng, faceJitter: 0.03, dirShade: 0.12 }));
  // base plate
  const bp = panel(rng, 0.6, 0.14, 0.6, 0x6f767c);
  xf(bp, { y: 0.07 });
  b.metal.push(bp);
  // cross arms
  for (let i = 0; i < 3; i++) {
    const y = H * (0.5 + i * 0.16);
    const len = lerp(0.9, 0.45, i / 2);
    const arm = cyl(0.022, 0.022, len, 5);
    xf(arm, { y, rz: Math.PI / 2, ry: i * 0.7 });
    b.metal.push(paint(arm, col, { rng, faceJitter: 0.04 }));
    for (const s of [-1, 1]) {
      const el = cyl(0.014, 0.014, 0.34, 4);
      xf(el, { y: y + 0.17, x: s * len * 0.45 });
      xf(el, { ry: i * 0.7 });
      b.metal.push(paint(el, col, { rng }));
    }
  }
  // dish: apex-down cone tipped back so the bowl faces up and out
  const dishY = H * 0.44, dishZ = 0.34;
  const dish = cone(0.56, 0.3, 9, { open: true });
  xf(dish, { rx: Math.PI - 0.8, y: dishY, z: dishZ });
  b.metal.push(paint(doubleSide(dish), (x, y, z) => mixc(0xf2f5f6, 0xa7b0b5, clamp01(Math.hypot(x, z - dishZ) / 0.56)),
    { rng, faceJitter: 0.03, dirShade: 0.06 }));
  const feed = cyl(0.02, 0.02, 0.34, 4);
  xf(feed, { rx: -0.8, y: dishY + 0.13, z: dishZ + 0.12 });
  b.metal.push(paint(feed, 0x8b9298, { rng }));
  const feedTip = ico(0.05, 0);
  xf(feedTip, { y: dishY + 0.25, z: dishZ + 0.24 });
  b.metal.push(paint(feedTip, 0xb9c0c6, { rng }));
  const mount = panel(rng, 0.09, 0.09, 0.26, 0x7f868c);
  xf(mount, { y: dishY, z: dishZ * 0.45 });
  b.metal.push(mount);
  // guy wires
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4;
    const from = V(0, H * 0.72, 0), to = V(Math.cos(a) * H * 0.35, 0, Math.sin(a) * H * 0.35);
    b.metal.push(paint(tube([from, from.clone().lerp(to, 0.5), to], [0.012, 0.012, 0.012], 3, { caps: false }), 0x585f65, { rng }));
  }
  // beacon
  const beacon = ico(0.09, 0);
  xf(beacon, { y: H + 0.06 });
  b.glow.push({ geo: beacon, color: 0xff3b30, intensity: 2.6 });
  const g = assemble(b, opts, 'antenna');
  const anchor = new THREE.Object3D();
  anchor.position.set(0, H + 0.06, 0);
  g.add(anchor);
  g.userData.lightAnchor = anchor;
  return finish(g, 'antenna');
}
