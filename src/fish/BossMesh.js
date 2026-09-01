/**
 * BossMesh — procedural boss meshes.
 *
 * Every boss is built on top of `buildFishMesh` (so it keeps the +X-forward,
 * 1.0-metre-normalised convention and the travelling-wave deformer) and then
 * has boss-specific geometry welded on: scars, broken teeth, armour plates,
 * barnacles, chains, harpoon shafts stuck in the flank, exposed ribs, a lure.
 *
 * Contract for the group returned by `buildBossMesh`:
 *   +X forward, +Y up, total length normalised to 1.0
 *   userData.weakPoints  Array<{object3d, localPos:Vector3, radius, broken, hp}>
 *   userData.animateBoss(t, state)   idle / wind-up / attack motion
 *   userData.parts       whatever the base fish exposed, plus boss parts
 *   userData.deform(t, amp, wavelength)  forwarded from the base mesh
 *   userData.setWeakPointBroken(i)   darken a weak point
 *   userData.triangles   triangle count, for profiling
 *
 * Nothing here touches the game loop; BossSystem drives `animateBoss`.
 */

import * as THREE from 'three';
import { buildFishMesh, countTriangles } from './FishMesh.js';
import { getSpecies } from '../data/fishData.js';
import { clamp, clamp01, lerp, TAU, makeRNG } from '../util/math.js';

const _box = new THREE.Box3();

// ---------------------------------------------------------------------------
// Shared material factory. One standard material per (colour, glow) bucket so
// a boss never costs more than a handful of draw calls.
// ---------------------------------------------------------------------------
const _matCache = new Map();

function mat(hex, { rough = 0.72, metal = 0.05, glow = 0, emissive = null, side = null, transparent = false, opacity = 1 } = {}) {
  // The scene has no environment map, so anything metallic renders black.
  // Keep metalness low and let colour + roughness do the work.
  metal = Math.min(metal, 0.18);
  const key = `${hex}|${rough}|${metal}|${glow}|${emissive}|${side}|${opacity}`;
  let m = _matCache.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    roughness: rough,
    metalness: metal,
    emissive: new THREE.Color(glow > 0 ? (emissive ?? hex) : 0x000000),
    emissiveIntensity: glow,
    side: side ?? THREE.FrontSide,
    transparent,
    opacity,
  });
  m.userData.shared = true;
  _matCache.set(key, m);
  return m;
}

/** Weak points are always their own material instance — they get darkened. */
function weakMat(hex) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    emissive: new THREE.Color(hex),
    emissiveIntensity: 2.2,
    roughness: 0.34,
    metalness: 0.0,
  });
  return m;
}

// ---------------------------------------------------------------------------
// Low-poly primitive pool. Geometries are shared and positioned per instance.
// ---------------------------------------------------------------------------
const GEO = {};
function geo(name, make) {
  let g = GEO[name];
  if (!g) { g = make(); GEO[name] = g; }
  return g;
}
const box = () => geo('box', () => new THREE.BoxGeometry(1, 1, 1));
const sphere = () => geo('sph', () => new THREE.IcosahedronGeometry(0.5, 1));      // 80 tris
const blob = () => geo('blob', () => new THREE.IcosahedronGeometry(0.5, 0));       // 20 tris
const cone4 = () => geo('cone4', () => new THREE.ConeGeometry(0.5, 1, 4));         // 8 tris
const cone6 = () => geo('cone6', () => new THREE.ConeGeometry(0.5, 1, 6));         // 12 tris
const cyl6 = () => geo('cyl6', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true));
const cyl5 = () => geo('cyl5', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 5, 1, false));
const ring = () => geo('ring', () => new THREE.TorusGeometry(0.5, 0.13, 4, 8));    // 64 tris
const plate = () => geo('plate', () => new THREE.CylinderGeometry(0.5, 0.42, 0.16, 6));
const disc = () => geo('disc', () => new THREE.CircleGeometry(0.5, 10));

/** Mark a node (and its subtree) as animated, so it survives the merge pass. */
function dyn(o) { o.userData.dynamic = true; return o; }

function put(parent, g, m, pos, rot = [0, 0, 0], scale = [1, 1, 1]) {
  const o = new THREE.Mesh(g, m);
  o.position.set(pos[0], pos[1], pos[2]);
  o.rotation.set(rot[0], rot[1], rot[2]);
  if (typeof scale === 'number') o.scale.setScalar(scale);
  else o.scale.set(scale[0], scale[1], scale[2]);
  parent.add(o);
  return o;
}

// ---------------------------------------------------------------------------
// Body profile sampler
//
// `buildFishMesh` hands back `spineSegments` — the lathe rings of the body in
// normalised space. Everything bolted onto a boss is placed against that
// profile instead of guessed coordinates, so scars sit on skin, teeth sit on
// the jaw line and barnacles do not vanish inside the animal.
// ---------------------------------------------------------------------------
function bodyProfile(base) {
  const segs = (base?.userData?.spineSegments || []).slice().sort((a, b) => b.x - a.x);
  const fallback = { y: 0, ry: 0.09, rz: 0.09 };
  const at = (x) => {
    if (!segs.length) return fallback;
    if (x >= segs[0].x) return { y: segs[0].y, ry: segs[0].radiusY, rz: segs[0].radiusZ };
    const last = segs[segs.length - 1];
    if (x <= last.x) return { y: last.y, ry: last.radiusY, rz: last.radiusZ };
    for (let i = 1; i < segs.length; i++) {
      if (x >= segs[i].x) {
        const a = segs[i - 1], b = segs[i];
        const t = (a.x - x) / Math.max(1e-5, a.x - b.x);
        return {
          y: lerp(a.y, b.y, t),
          ry: lerp(a.radiusY, b.radiusY, t),
          rz: lerp(a.radiusZ, b.radiusZ, t),
        };
      }
    }
    return fallback;
  };
  return {
    segs,
    at,
    nose: segs.length ? segs[0].x : 0.5,
    tail: segs.length ? segs[segs.length - 1].x : -0.5,
    /** Y of the back at x, pushed out by `k` radii. */
    top: (x, k = 1) => { const p = at(x); return p.y + p.ry * k; },
    /** Y of the belly at x. */
    bot: (x, k = 1) => { const p = at(x); return p.y - p.ry * k; },
    /** Half-width at x. */
    side: (x, k = 1) => at(x).rz * k,
    /** Centre-line Y at x. */
    mid: (x) => at(x).y,
  };
}

// ---------------------------------------------------------------------------
// Reusable boss detail kit
// ---------------------------------------------------------------------------

/** Raised keloid ridge — an old, badly healed wound. */
function addScar(parent, m, x, y, z, len, ang = 0, w = 0.012) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.z = ang;
  const n = 4;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    put(g, blob(), m, [t * len, Math.sin(t * 5) * w * 0.6, 0], [0, 0, 0],
      [w * 2.4, w * (1.6 - Math.abs(t)), w * 1.5]);
  }
  parent.add(g);
  return g;
}

/** Cluster of barnacles / crust. */
function addBarnacles(parent, m, rng, count, place) {
  for (let i = 0; i < count; i++) {
    const p = place(rng, i);
    const s = p.s ?? (0.012 + rng() * 0.02);
    put(parent, cone6(), m, [p.x, p.y, p.z],
      [p.rx ?? (rng() - 0.5) * 0.9, 0, p.rz ?? (rng() - 0.5) * 0.9],
      [s, s * (0.5 + rng() * 0.7), s]);
  }
}

/** Overlapping armour plates running along a line. */
function addPlates(parent, m, count, at, size, tilt = 0.35) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const p = at(t, i);
    const s = typeof size === 'function' ? size(t, i) : size;
    out.push(put(parent, plate(), m, [p.x, p.y, p.z],
      [p.rx ?? 0, p.ry ?? 0, (p.rz ?? 0) + tilt], [s, s * 0.5, s * 0.8]));
  }
  return out;
}

/** A row of teeth along an arc; a few of them snapped off short. */
function addTeeth(parent, m, count, arc, opts = {}) {
  const { size = 0.02, broken = 0.25, rng = Math.random, down = true } = opts;
  const grp = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1 || 1);
    const p = arc(t, i);
    const chipped = rng() < broken;
    const h = size * (chipped ? 0.35 + rng() * 0.25 : 0.85 + rng() * 0.5);
    const w = size * (0.42 + rng() * 0.2) * (chipped ? 1.25 : 1);
    put(grp, cone4(), m, [p.x, p.y, p.z],
      [p.rx ?? 0, (rng() - 0.5) * 0.5, (p.rz ?? 0) + (down ? Math.PI : 0)],
      [w, h, w]);
  }
  parent.add(grp);
  return grp;
}

/** Exposed ribs poking through the flank. */
function addRibs(parent, m, count, at, opts = {}) {
  const { r = 0.008, len = 0.09 } = opts;
  const grp = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const p = at(t, i);
    const o = put(grp, cyl5(), m, [p.x, p.y, p.z], [p.rx ?? 0, 0, p.rz ?? 0],
      [r, (p.len ?? len), r]);
    o.rotation.x = p.bend ?? 0;
  }
  parent.add(grp);
  return grp;
}

/** A hanging chain, links alternating axis. */
function addChain(parent, m, from, dir, links, linkR = 0.014) {
  const grp = new THREE.Group();
  grp.position.set(from[0], from[1], from[2]);
  for (let i = 0; i < links; i++) {
    const d = i * linkR * 1.55;
    put(grp, ring(), m,
      [dir[0] * d, dir[1] * d, dir[2] * d],
      i % 2 ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, Math.PI / 2],
      [linkR * 2, linkR * 2, linkR * 2]);
  }
  parent.add(grp);
  return grp;
}

/** A harpoon shaft left buried in the boss from a previous fight. */
function addHarpoon(parent, mShaft, mHead, pos, dir, len = 0.13) {
  const grp = new THREE.Group();
  grp.position.set(pos[0], pos[1], pos[2]);
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  put(grp, cyl5(), mShaft, [0, len * 0.5, 0], [0, 0, 0], [0.007, len, 0.007]);
  put(grp, cone4(), mHead, [0, len * 1.02, 0], [0, 0, 0], [0.016, 0.035, 0.016]);
  parent.add(grp);
  return grp;
}

/**
 * Glowing weak point. Returns the descriptor BossSystem consumes.
 * The pip is a bright core + a socket ring so it reads at distance.
 */
let _haloTex = null;
function haloTexture() {
  if (_haloTex) return _haloTex;
  if (typeof document === 'undefined') return null;   // headless build/test
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,0.85)');
  rg.addColorStop(0.22, 'rgba(255,255,255,0.34)');
  rg.addColorStop(0.55, 'rgba(255,255,255,0.10)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  _haloTex = new THREE.CanvasTexture(c);
  return _haloTex;
}

function addWeakPoint(parent, x, y, z, radius, colorHex, list, hp = 1) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const m = weakMat(colorHex);

  // Glowing core.
  const core = put(g, sphere(), m, [0, 0, 0], [0, 0, 0], radius * 2.6);

  // Broken plating around it — chips, not a black ring. A flat dark torus
  // reads as a hole punched through the animal at any distance.
  const chip = mat(0x171a1e, { rough: 0.95 });
  const outward = new THREE.Vector3(x, y, z);
  outward.setLength(1);
  const chips = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3;
    const r = radius * (1.5 + (i % 2) * 0.3);
    put(chips, cone4(), chip,
      [Math.cos(a) * r * 0.25, Math.sin(a) * r, Math.cos(a) * r],
      [0, a, Math.PI * 0.5 + Math.sin(a) * 0.4],
      [radius * 0.9, radius * 1.5, radius * 0.5]);
  }
  g.add(chips);

  // Billboard halo: always faces the camera, so a weak point reads from
  // every angle and at range. That is the whole point of a weak point.
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), color: new THREE.Color(colorHex),
    transparent: true, opacity: 0.5, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(radius * 5);
  halo.userData.isHalo = true;
  halo.userData.base = radius * 5;
  g.add(halo);
  parent.add(dyn(g));
  const wp = {
    object3d: g, localPos: new THREE.Vector3(x, y, z), radius,
    broken: false, hp, maxHp: hp,
    _mat: m, _core: core, _halo: halo, _socket: chips, _color: colorHex,
  };
  list.push(wp);
  return wp;
}

function darkenWeakPoint(wp) {
  if (!wp || wp.broken) return;
  wp.broken = true;
  wp._mat.emissiveIntensity = 0;
  wp._mat.color.setHex(0x1a1512);
  wp._mat.emissive.setHex(0x000000);
  wp._mat.needsUpdate = true;
  wp._halo.visible = false;
  wp._core.scale.multiplyScalar(0.55);
}

function relightWeakPoint(wp) {
  if (!wp || !wp.broken) return;
  wp.broken = false;
  wp.hp = wp.maxHp;
  wp._mat.emissiveIntensity = 2.2;
  wp._mat.color.setHex(wp._color);
  wp._mat.emissive.setHex(wp._color);
  wp._mat.needsUpdate = true;
  wp._halo.visible = true;
  wp._core.scale.multiplyScalar(1 / 0.55);
}

// ---------------------------------------------------------------------------
// Per-boss builders. Each gets (host, species, rng, C) where `host` is the
// group that already contains the base fish mesh at 1.0 length, and returns
// { weakPoints, anim } with `anim(t, state, parts)` doing the boss motion.
// ---------------------------------------------------------------------------

/**
 * Boss recolours. The stock species palettes are tuned for a 40 cm fish seen
 * at 3 m; blown up to 20 m the accent takes over and the whole animal turns
 * into a bright toy. These darken the flesh and pull the accent back so it
 * stays a highlight — the original accent is still used, undimmed, for the
 * glowing weak points and boss-specific emissive parts.
 */
const BOSS_PALETTE = {
  'dock-eater':     { main: '#2c332b', belly: '#5c684a', fin: '#171b16', accent: '#5d8a3a', eye: '#c8ff3a' },
  'king-crab-boss': { main: '#6d2f22', belly: '#a88361', fin: '#3d160f', accent: '#b06a3a', eye: '#f2e05a' },
  'the-hammer':     { main: '#414d57', belly: '#c8ccc3', fin: '#171c21', accent: '#2b343b', eye: '#ffd23a' },
  'stormfin':       { main: '#1c2f5c', belly: '#9fb2c8', fin: '#3b2878', accent: '#4c8fb8', eye: '#ffe14a' },
  'frostjaw':       { main: '#41586e', belly: '#b9cddb', fin: '#25384c', accent: '#6ea8c4', eye: '#e8f8ff' },
  'abyss-mouth':    { main: '#0f0916', belly: '#1c1226', fin: '#07040c', accent: '#3a1020', eye: '#ffd0dc' },
};

/** A species clone whose colours suit a 20 m animal. */
function bossSpecies(species) {
  const o = BOSS_PALETTE[species.id];
  if (!o) return species;
  return { ...species, colors: { ...species.colors, ...o } };
}

/** Palette shortcuts from the species colours. */
function pal(species) {
  const c = species.colors;
  return {
    main: c.main, belly: c.belly, fin: c.fin, accent: c.accent, eye: c.eye,
    dark: new THREE.Color(c.fin).multiplyScalar(0.45).getHex(),
    bone: 0xd8d2bd,
    rust: 0x6a3a20,
    metal: 0x50575e,
    wood: 0x54402a,
  };
}

// --------------------------------------------------------------- dock-eater
function buildDockEater(host, species, rng, wps, B) {
  const C = pal(species);
  const mBody = mat(C.dark, { rough: 0.86 });
  const mWood = mat(C.wood, { rough: 0.95 });
  const mMetal = mat(C.metal, { rough: 0.55, metal: 0.7 });
  const mRope = mat(0x9a8b62, { rough: 1 });
  const mBone = mat(C.bone, { rough: 0.5 });
  const mCrust = mat(0x8a9070, { rough: 1 });

  const detail = new THREE.Group();
  detail.name = 'bossDetail';
  host.add(detail);

  // --- dock planks jammed into its back, still bolted together -------------
  const raft = new THREE.Group();
  raft.position.set(-0.02, B.top(-0.02) + 0.012, 0);
  raft.rotation.z = -0.14;
  for (let i = 0; i < 5; i++) {
    put(raft, box(), mWood, [0, 0.010 * i, (i - 2) * 0.055], [0, 0.05 * (i - 2), 0],
      [0.34 - i * 0.014, 0.020, 0.050]);
  }
  put(raft, box(), mMetal, [0.06, 0.034, 0], [0, 0, 0.1], [0.014, 0.058, 0.24]);
  // a snapped piling still bolted to the decking
  put(raft, box(), mWood, [-0.10, 0.10, 0.06], [0.2, 0.3, 0.45], [0.030, 0.20, 0.030]);
  detail.add(dyn(raft));

  // --- mooring rope wrapped round the head, trailing behind ---------------
  for (let i = 0; i < 7; i++) {
    const x = 0.30 - i * 0.020;
    const r = (B.side(x) + 0.014) * 2;
    put(detail, ring(), mRope, [x, B.mid(x), 0], [0, 0, Math.PI / 2], [r, r, r]);
  }
  const ropeTail = new THREE.Group();
  ropeTail.position.set(B.tail + 0.02, 0.02, 0.05);
  for (let i = 0; i < 9; i++) {
    put(ropeTail, cyl5(), mRope, [-i * 0.030, -i * 0.014 - Math.sin(i) * 0.006, Math.sin(i * 0.8) * 0.024],
      [0, 0, Math.PI / 2 + i * 0.06], [0.010, 0.033, 0.010]);
  }
  detail.add(dyn(ropeTail));

  // --- chain and shackle hanging off the jaw ------------------------------
  addChain(detail, mMetal, [0.34, B.bot(0.34) + 0.01, 0.05], [-0.25, -0.96, 0], 9, 0.014);

  // --- barnacle crust along the flanks ------------------------------------
  addBarnacles(detail, mCrust, rng, 34, (r) => {
    const x = lerp(0.34, B.tail + 0.1, r());
    const up = r() * 2 - 1;
    return {
      x,
      y: B.mid(x) + up * B.at(x).ry * 0.75,
      z: (r() < 0.5 ? 1 : -1) * B.side(x) * (0.82 + r() * 0.2) * Math.sqrt(Math.max(0, 1 - up * up)),
      s: 0.014 + r() * 0.024,
    };
  });

  // --- broken teeth in a wide catfish maw ---------------------------------
  const jawX = 0.435;
  addTeeth(detail, mBone, 15, (t) => {
    const x = jawX - Math.abs(t - 0.5) * 0.09;
    return { x, y: B.mid(x) - B.at(x).ry * 0.30, z: (t - 0.5) * B.side(jawX) * 1.9, rz: Math.PI + (t - 0.5) * 0.5 };
  }, { size: 0.038, broken: 0.4, rng });
  addTeeth(detail, mBone, 11, (t) => {
    const x = jawX - 0.012 - Math.abs(t - 0.5) * 0.08;
    return { x, y: B.mid(x) - B.at(x).ry * 0.92, z: (t - 0.5) * B.side(jawX) * 1.6 };
  }, { size: 0.030, broken: 0.5, rng, down: false });

  // --- scars ---------------------------------------------------------------
  addScar(detail, mBody, 0.10, B.mid(0.10) + 0.03, B.side(0.10) * 0.96, 0.22, 0.3, 0.014);
  addScar(detail, mBody, -0.05, B.mid(-0.05) - 0.02, -B.side(-0.05) * 0.96, 0.17, -0.5, 0.013);
  addScar(detail, mBody, 0.20, B.mid(0.20) + 0.02, -B.side(0.20) * 0.96, 0.10, 0.9, 0.011);

  // --- weak points: two swollen gill sacs and a glowing gullet ------------
  addWeakPoint(detail, 0.21, B.mid(0.21) + 0.01, B.side(0.21) * 0.92, 0.036, C.accent, wps);
  addWeakPoint(detail, 0.21, B.mid(0.21) + 0.01, -B.side(0.21) * 0.92, 0.036, C.accent, wps);
  addWeakPoint(detail, 0.36, B.bot(0.36) + 0.012, 0, 0.034, C.accent, wps);

  const jawGrp = new THREE.Group();

  return {
    anim(t, s, parts) {
      const open = s.mouth;
      raft.rotation.z = -0.14 + Math.sin(t * 0.9) * 0.04;
      ropeTail.rotation.y = Math.sin(t * 1.7) * 0.35;
      ropeTail.rotation.z = Math.sin(t * 1.2 + 1) * 0.2;
      if (parts.jaw) parts.jaw.rotation.z = open * 0.5;
    },
  };
}

// ----------------------------------------------------------- king-crab-boss
function buildIronshell(host, species, rng, wps, B) {
  const C = pal(species);
  const mShell = mat(C.dark, { rough: 0.62, metal: 0.15 });
  const mPlate = mat(0x7a3325, { rough: 0.5, metal: 0.3 });
  const mMetal = mat(C.metal, { rough: 0.5, metal: 0.75 });
  const mRust = mat(C.rust, { rough: 0.95 });
  const mCrust = mat(0x9aa088, { rough: 1 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- riveted armour plating over the carapace ---------------------------
  // Two staggered rows across the shell — not a stack, a carapace.
  for (let row = 0; row < 2; row++) {
    addPlates(detail, mPlate, 5, (t, i) => {
      const x = lerp(0.20, -0.28, t);
      const zo = (row ? 1 : -1) * B.side(x) * 0.34 + (i % 2 - 0.5) * 0.03;
      return {
        x, y: B.top(x) - 0.004 - Math.abs(zo) * 0.10,
        z: zo,
        rz: 0.08 * (row ? 1 : -1),
        rx: (row ? 1 : -1) * 0.34,
      };
    }, (t) => 0.115 - t * 0.03, 0.04);
  }
  // a keel plate along the spine
  addPlates(detail, mPlate, 4, (t) => {
    const x = lerp(0.16, -0.24, t);
    return { x, y: B.top(x) + 0.006, z: 0, rz: 0.05 };
  }, (t) => 0.10 - t * 0.02, 0.02);
  // rivets
  for (let i = 0; i < 16; i++) {
    const x = lerp(0.22, -0.30, rng());
    put(detail, blob(), mMetal, [x, B.top(x) + 0.008, (rng() - 0.5) * B.side(x) * 1.2], [0, 0, 0], 0.012);
  }

  // --- snagged crab-pot cage riding the shell -----------------------------
  const cage = new THREE.Group();
  cage.position.set(-0.16, B.top(-0.16) + 0.02, B.side(-0.16) * 0.45);
  cage.rotation.set(0.25, 0.4, 0.15);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    put(cage, cyl5(), mRust, [Math.cos(a) * 0.085, 0.06, Math.sin(a) * 0.085], [0, 0, 0], [0.007, 0.12, 0.007]);
  }
  for (const y of [0.0, 0.06, 0.12]) {
    put(cage, ring(), mRust, [0, y, 0], [Math.PI / 2, 0, 0], [0.24, 0.24, 0.24]);
  }
  put(cage, box(), mRust, [0.07, 0.06, 0.04], [0.3, 0.4, 0.5], [0.006, 0.11, 0.085]);
  detail.add(dyn(cage));

  // --- chains dragging from the shell -------------------------------------
  addChain(detail, mMetal, [-0.18, B.top(-0.18) - 0.01, B.side(-0.18) * 0.7], [-0.5, -0.85, 0.1], 9, 0.015);
  addChain(detail, mMetal, [-0.15, B.top(-0.15) - 0.02, -B.side(-0.15) * 0.75], [-0.3, -0.94, -0.1], 7, 0.014);

  // --- barnacle crust on the shoulders ------------------------------------
  addBarnacles(detail, mCrust, rng, 36, (r) => {
    const x = lerp(0.24, -0.32, r());
    const up = r();
    return {
      x, y: lerp(B.mid(x), B.top(x), up) + 0.008,
      z: (r() - 0.5) * B.side(x) * 1.7,
      s: 0.014 + r() * 0.026,
    };
  });

  // --- big scar across the shell, and a cracked plate ---------------------
  addScar(detail, mShell, 0.02, B.top(0.02) + 0.008, B.side(0.02) * 0.35, 0.26, 0.5, 0.018);
  put(detail, box(), mShell, [0.10, B.top(0.10), -B.side(0.10) * 0.6], [0.3, 0.2, 0.4], [0.10, 0.014, 0.06]);

  // --- weak points: the joint sockets, exposed where plating is missing ---
  addWeakPoint(detail, 0.06, B.mid(0.06) + 0.02, B.side(0.06) * 0.96, 0.038, C.accent, wps);
  addWeakPoint(detail, 0.06, B.mid(0.06) + 0.02, -B.side(0.06) * 0.96, 0.038, C.accent, wps);
  addWeakPoint(detail, 0.26, B.top(0.26) + 0.012, 0, 0.036, C.accent, wps);   // eye-stalk base

  return {
    anim(t, s, parts) {
      cage.rotation.z = 0.15 + Math.sin(t * 1.4) * 0.09;
      const legs = parts.tentacles || [];
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        if (!l.userData._base) l.userData._base = l.rotation.z;
        l.rotation.z = l.userData._base + Math.sin(t * 3.2 + i * 0.9) * (0.09 + s.aggro * 0.16);
      }
      if (parts.clawL) parts.clawL.rotation.z = Math.sin(t * 2.1) * 0.12 + s.mouth * 0.6;
      if (parts.clawR) parts.clawR.rotation.z = -Math.sin(t * 2.1 + 1) * 0.12 - s.mouth * 0.6;
    },
  };
}

// ---------------------------------------------------------------- the-hammer
function buildTheHammer(host, species, rng, wps, B) {
  const C = pal(species);
  const mSkin = mat(C.dark, { rough: 0.78 });
  const mScar = mat(0xb8a99a, { rough: 0.62 });
  const mBone = mat(C.bone, { rough: 0.45 });
  const mMetal = mat(C.metal, { rough: 0.45, metal: 0.8 });
  const mRope = mat(0x8c7d58, { rough: 1 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- three harpoons still buried in the flank, ropes trailing ----------
  const harpoons = [];
  const hp = (x, up, side, dir, len) => harpoons.push(dyn(addHarpoon(detail, mMetal, mMetal,
    [x, lerp(B.mid(x), B.top(x), up), B.side(x) * side], dir, len)));
  hp(0.02, 0.55, 0.55, [-0.25, 0.9, 0.35], 0.20);
  hp(-0.12, 0.25, -0.75, [-0.5, 0.7, -0.5], 0.17);
  hp(0.14, 0.10, -0.70, [0.1, 0.6, -0.8], 0.13);
  for (let i = 0; i < 7; i++) {
    put(detail, cyl5(), mRope, [0.02 - i * 0.034, B.top(0.02) + 0.16 - i * 0.014, B.side(0.02) * 0.6 + i * 0.010],
      [0, 0, 1.2], [0.006, 0.038, 0.006]);
  }

  // --- long white scars, the signature of a shark nobody has killed ------
  const scarAt = (x, up, side, len, ang, w) =>
    addScar(detail, mScar, x, lerp(B.mid(x), up > 0 ? B.top(x) : B.bot(x), Math.abs(up)),
      B.side(x) * side * 0.97, len, ang, w);
  scarAt(0.10, 0.2, 1, 0.26, 0.22, 0.013);
  scarAt(-0.04, 0.55, 1, 0.18, -0.35, 0.011);
  scarAt(0.06, -0.3, -1, 0.30, 0.12, 0.014);
  scarAt(0.26, 0.35, 1, 0.11, 0.8, 0.010);
  scarAt(0.26, 0.35, -1, 0.11, -0.8, 0.010);

  // --- a semicircular bite taken out of the dorsal ------------------------
  put(detail, sphere(), mat(0x0d1116, { rough: 1 }), [-0.02, B.top(-0.02) + 0.05, 0], [0, 0, 0], [0.085, 0.07, 0.055]);
  addTeeth(detail, mBone, 8, (t) => ({
    x: -0.062 + t * 0.085, y: B.top(-0.02) + 0.035, z: 0.0, rz: Math.PI * 0.5 * (t - 0.5),
  }), { size: 0.024, broken: 0.6, rng, down: false });

  // --- ragged tail: a bite out of the upper lobe --------------------------
  put(detail, box(), mat(0x0b0f13, { rough: 1 }), [B.tail - 0.02, 0.11, 0], [0, 0, 0.5], [0.055, 0.055, 0.022]);

  // --- exposed ribs where the flank has been stripped ---------------------
  addRibs(detail, mBone, 6, (t) => {
    const x = lerp(-0.04, -0.22, t);
    return { x, y: B.mid(x) - B.at(x).ry * 0.35, z: B.side(x) * 0.9, rz: 0.35 + t * 0.35,
      len: Math.max(0.03, B.at(x).ry * 1.5) };
  }, { r: 0.008 });

  // --- teeth: two rows, plenty snapped -----------------------------------
  const jx = 0.36;
  for (let row = 0; row < 2; row++) {
    addTeeth(detail, mBone, 15, (t) => {
      const x = jx - row * 0.030 - Math.abs(t - 0.5) * 0.09;
      return { x, y: B.mid(x) - B.at(x).ry * 0.28, z: (t - 0.5) * B.side(jx) * 1.85, rz: Math.PI + (t - 0.5) * 0.4 };
    }, { size: 0.032 - row * 0.006, broken: 0.32, rng });
  }
  addTeeth(detail, mBone, 12, (t) => {
    const x = jx - 0.014 - Math.abs(t - 0.5) * 0.08;
    return { x, y: B.mid(x) - B.at(x).ry * 0.95, z: (t - 0.5) * B.side(jx) * 1.5 };
  }, { size: 0.026, broken: 0.4, rng, down: false });

  // --- weak points: gill rakers and the scarred snout --------------------
  addWeakPoint(detail, 0.17, B.mid(0.17) - 0.01, B.side(0.17) * 0.95, 0.034, C.accent, wps);
  addWeakPoint(detail, 0.17, B.mid(0.17) - 0.01, -B.side(0.17) * 0.95, 0.034, C.accent, wps);
  addWeakPoint(detail, 0.34, B.top(0.34) + 0.008, 0, 0.032, C.accent, wps);

  return {
    anim(t, s, parts) {
      for (let i = 0; i < harpoons.length; i++) {
        harpoons[i].rotation.z = Math.sin(t * 2.4 + i) * 0.05;
      }
      if (parts.jaw) parts.jaw.rotation.z = s.mouth * 0.55;
      if (parts.pecL) parts.pecL.rotation.x = Math.sin(t * 1.6) * 0.14 - s.aggro * 0.25;
      if (parts.pecR) parts.pecR.rotation.x = -Math.sin(t * 1.6) * 0.14 + s.aggro * 0.25;
    },
  };
}

// ------------------------------------------------------------------ stormfin
function buildStormfin(host, species, rng, wps, B) {
  const C = pal(species);
  const mDark = mat(0x18244a, { rough: 0.5, metal: 0.2 });
  const mVolt = mat(C.accent, { rough: 0.25, glow: 2.4 });
  const mSail = mat(C.fin, { rough: 0.55, glow: 0.5, side: THREE.DoubleSide });
  const mMetal = mat(0x8fa8c8, { rough: 0.3, metal: 0.9 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- storm veins: glowing filaments running nose to tail ---------------
  for (let k = 0; k < 3; k++) {
    const up = (k - 1) * 0.45;
    for (let i = 0; i < 10; i++) {
      const t = i / 9;
      const x = lerp(0.34, B.tail + 0.06, t);
      const side = Math.cos(t * 5 + k * 2) * 0.9;
      put(detail, blob(), mVolt, [
        x,
        lerp(B.mid(x), up > 0 ? B.top(x) : B.bot(x), Math.abs(up)) + Math.sin(t * 7 + k) * 0.012,
        B.side(x) * side,
      ], [0, 0, 0], 0.015 + (1 - t) * 0.010);
    }
  }

  // --- torn sail dorsal: a row of spines with gaps -----------------------
  const sail = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    if (i === 4 || i === 8) continue;   // torn away
    const x = lerp(0.26, -0.20, t);
    const h = (0.12 + Math.sin(t * Math.PI) * 0.16) * (1 - t * 0.3);
    put(sail, cone4(), mSail, [x, B.top(x) + h * 0.5, 0], [0, 0, -0.12], [0.013, h, 0.032]);
  }
  detail.add(dyn(sail));

  // --- lightning-rod bill with metal ferrules ----------------------------
  const billTip = B.nose + 0.14;
  for (let i = 0; i < 4; i++) {
    const r = 0.034 - i * 0.006;
    put(detail, ring(), mMetal, [B.nose - 0.05 + i * 0.045, B.mid(B.nose) + 0.004, 0], [0, 0, Math.PI / 2], [r, r, r]);
  }
  const tip = dyn(put(detail, cone6(), mVolt, [billTip, B.mid(B.nose) + 0.004, 0], [0, 0, -Math.PI / 2], [0.018, 0.06, 0.018]));
  const tipBase = tip.scale.clone();

  // --- arc nodes: little floating electrodes that spark ------------------
  const arcs = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const x = lerp(0.22, -0.26, t);
    const a = dyn(put(detail, blob(), mVolt,
      [x, B.top(x) + 0.16 + Math.sin(t * 3) * 0.04, (i % 2 ? 1 : -1) * 0.08], [0, 0, 0], 0.022));
    arcs.push(a);
  }

  // --- scarring where lightning has hit it before ------------------------
  const mBurn = mat(0xcfe4ff, { rough: 0.4, glow: 0.6 });
  addScar(detail, mBurn, 0.06, B.mid(0.06) + 0.02, B.side(0.06) * 0.96, 0.20, 0.4, 0.011);
  addScar(detail, mBurn, -0.10, B.mid(-0.10), -B.side(-0.10) * 0.96, 0.16, -0.6, 0.010);

  // --- weak points: three storm nodes along the spine --------------------
  addWeakPoint(detail, 0.20, B.top(0.20) + 0.012, 0, 0.036, C.accent, wps);
  addWeakPoint(detail, -0.02, B.top(-0.02) + 0.012, 0, 0.036, C.accent, wps);
  addWeakPoint(detail, -0.24, B.top(-0.24) + 0.010, 0, 0.033, C.accent, wps);

  return {
    anim(t, s, parts) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 6);
      const hot = 1.4 + pulse * 1.6 + s.aggro * 2;
      mVolt.emissiveIntensity = hot;
      for (let i = 0; i < arcs.length; i++) {
        const a = arcs[i];
        a.position.y = 0.20 + Math.sin(t * 3 + i) * 0.035;
        const k = 0.016 + Math.sin(t * 9 + i * 2) * 0.008;
        a.scale.setScalar(k);
      }
      sail.rotation.z = Math.sin(t * 2.2) * 0.05;
      tip.scale.copy(tipBase).multiplyScalar(1 + pulse * 0.25);
      if (parts.pecL) parts.pecL.rotation.x = Math.sin(t * 2.4) * 0.2;
      if (parts.pecR) parts.pecR.rotation.x = -Math.sin(t * 2.4) * 0.2;
    },
  };
}

// ------------------------------------------------------------------ frostjaw
function buildFrostjaw(host, species, rng, wps, B) {
  const C = pal(species);
  const mIce = mat(0xbfe8fa, { rough: 0.18, metal: 0.05, glow: 0.25, transparent: true, opacity: 0.86 });
  const mCrack = mat(C.accent, { rough: 0.3, glow: 2.0 });
  const mBone = mat(0xeef4f6, { rough: 0.4 });
  const mHide = mat(0x2e465c, { rough: 0.9 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- ice plates and spikes frozen onto the back -------------------------
  const spikes = new THREE.Group();
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const x = lerp(0.32, B.tail + 0.08, t);
    const h = 0.06 + Math.sin(t * Math.PI) * 0.13;
    const zo = ((i % 3) - 1) * B.side(x) * 0.45;
    put(spikes, cone4(), mIce,
      [x, B.top(x) + h * 0.35, zo],
      [(rng() - 0.5) * 0.4, rng() * TAU, (rng() - 0.5) * 0.3],
      [0.026 + rng() * 0.014, h, 0.026 + rng() * 0.014]);
  }
  detail.add(dyn(spikes));
  addPlates(detail, mIce, 7, (t) => {
    const x = lerp(0.26, -0.30, t);
    return { x, y: B.top(x) + 0.004, z: 0, rz: 0.2 };
  }, 0.12, 0.1);

  // --- glowing cracks through the frozen crust ---------------------------
  for (let i = 0; i < 26; i++) {
    const x = lerp(0.30, B.tail + 0.06, rng());
    const up = rng() * 2 - 1;
    put(detail, box(), mCrack, [
      x,
      B.mid(x) + up * B.at(x).ry * 0.8,
      (rng() < 0.5 ? 1 : -1) * B.side(x) * 0.95 * Math.sqrt(Math.max(0, 1 - up * up)),
    ], [0, 0, rng() * TAU], [0.04 + rng() * 0.04, 0.007, 0.007]);
  }

  // --- exposed ribs along both flanks ------------------------------------
  for (const side of [1, -1]) {
    addRibs(detail, mBone, 7, (t) => {
      const x = lerp(0.08, -0.24, t);
      return { x, y: B.mid(x) - B.at(x).ry * 0.30, z: side * B.side(x) * 0.92,
        rz: 0.3 + t * 0.4, len: Math.max(0.04, B.at(x).ry * 1.5) };
    }, { r: 0.009 });
  }

  // --- the jaw: oversized, crooked, half the teeth snapped ---------------
  const jaw = new THREE.Group();
  const fx = 0.34;
  addTeeth(jaw, mBone, 19, (t) => {
    const x = fx - Math.abs(t - 0.5) * 0.10;
    return { x, y: B.mid(x) - B.at(x).ry * 0.22, z: (t - 0.5) * B.side(fx) * 2.0,
      rz: Math.PI + (t - 0.5) * 0.55 };
  }, { size: 0.052, broken: 0.38, rng });
  addTeeth(jaw, mBone, 15, (t) => {
    const x = fx - 0.016 - Math.abs(t - 0.5) * 0.09;
    return { x, y: B.mid(x) - B.at(x).ry * 1.05, z: (t - 0.5) * B.side(fx) * 1.7 };
  }, { size: 0.044, broken: 0.45, rng, down: false });
  detail.add(dyn(jaw));

  // --- frost breath vents ------------------------------------------------
  for (const sd of [1, -1]) {
    put(detail, cyl6(), mHide, [0.26, B.mid(0.26) + 0.02, sd * B.side(0.26) * 0.8], [0, 0, 0.4], [0.022, 0.035, 0.022]);
  }

  // --- weak points: the melt-holes in the ice over its heart ------------
  addWeakPoint(detail, 0.08, B.mid(0.08) + 0.04, B.side(0.08) * 0.94, 0.040, C.accent, wps);
  addWeakPoint(detail, 0.08, B.mid(0.08) + 0.04, -B.side(0.08) * 0.94, 0.040, C.accent, wps);
  addWeakPoint(detail, -0.18, B.top(-0.18) + 0.012, 0, 0.038, C.accent, wps);

  return {
    anim(t, s, parts) {
      mCrack.emissiveIntensity = 1.2 + Math.sin(t * 2.4) * 0.6 + s.aggro * 1.6;
      jaw.rotation.z = s.mouth * 0.30;
      jaw.position.y = -s.mouth * 0.03;
      spikes.rotation.z = Math.sin(t * 1.1) * 0.05;
      spikes.position.y = Math.sin(t * 1.7) * 0.006;
      if (parts.tail) parts.tail.rotation.y = Math.sin(t * 1.4) * 0.2;
    },
  };
}

// --------------------------------------------------------------- abyss-mouth
function buildAbyssMouth(host, species, rng, wps, B) {
  const C = pal(species);
  const mFlesh = mat(0x120a1c, { rough: 0.92 });
  const mGullet = mat(C.accent, { rough: 0.6, glow: 1.4 });
  const mTooth = mat(0xf2e6d6, { rough: 0.35 });
  const mLure = mat(0xffd0dc, { rough: 0.2, glow: 3.0 });
  const mSpot = mat(0xff4a78, { rough: 0.4, glow: 1.8 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- the lure: a long stalk with a bulb that is not a light ------------
  const stalk = new THREE.Group();
  stalk.position.set(0.22, B.top(0.22) + 0.01, 0);
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    put(stalk, cyl5(), mFlesh, [t * 0.20, t * 0.26 + Math.sin(t * 2) * 0.035, 0],
      [0, 0, -0.7], [0.012 - t * 0.005, 0.055, 0.012 - t * 0.005]);
  }
  const bulb = dyn(put(stalk, sphere(), mLure, [0.225, 0.30, 0], [0, 0, 0], 0.085));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU;
    put(stalk, cyl5(), mLure, [0.225 + Math.cos(a) * 0.042, 0.30 + Math.sin(a) * 0.042, 0],
      [0, 0, a], [0.005, 0.06, 0.005]);
  }
  detail.add(dyn(stalk));

  // --- glowing gullet behind the teeth ------------------------------------
  const mouthX = 0.30;
  const gullet = dyn(put(detail, sphere(), mGullet, [mouthX - 0.03, B.mid(mouthX), 0], [0, 0, 0],
    [B.side(mouthX) * 1.0, B.at(mouthX).ry * 1.0, B.side(mouthX) * 1.1]));
  const gulletBase = gullet.scale.clone();

  // --- ring of enormous teeth --------------------------------------------
  const toothRing = new THREE.Group();
  const rr = B.side(mouthX) * 1.02, ry = B.at(mouthX).ry * 1.02;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const wob = 1 + Math.sin(a * 3) * 0.09;
    const long = i % 4 === 0;
    const chip = rng() < 0.22;
    put(toothRing, cone4(), mTooth,
      [mouthX + 0.03, B.mid(mouthX) + Math.sin(a) * ry * wob, Math.cos(a) * rr * wob],
      [0, 0, -Math.PI / 2 - Math.sin(a) * 0.3],
      [0.020, chip ? 0.035 : (long ? 0.125 : 0.085), 0.020]);
  }
  detail.add(dyn(toothRing));

  // --- bioluminescent spot rows along the flanks -------------------------
  for (const side of [1, -1]) {
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      const x = lerp(0.16, B.tail + 0.06, t);
      const up = Math.sin(t * 6) * 0.5;
      put(detail, blob(), mSpot, [
        x, B.mid(x) + up * B.at(x).ry,
        side * B.side(x) * 0.95 * Math.sqrt(Math.max(0, 1 - up * up)),
      ], [0, 0, 0], 0.014);
    }
  }

  // --- tendrils trailing from the jaw ------------------------------------
  const tendrils = [];
  for (let k = 0; k < 7; k++) {
    const g = new THREE.Group();
    const a = (k / 7) * TAU;
    g.position.set(mouthX + 0.02, B.mid(mouthX) + Math.sin(a) * ry * 0.95, Math.cos(a) * rr * 0.95);
    for (let i = 0; i < 5; i++) {
      put(g, cyl5(), mFlesh, [i * 0.042, -i * 0.014, 0], [0, 0, Math.PI / 2 - i * 0.10],
        [0.007, 0.05, 0.007]);
    }
    put(g, blob(), mSpot, [0.22, -0.07, 0], [0, 0, 0], 0.016);
    detail.add(dyn(g));
    tendrils.push(g);
  }

  // --- exposed ribs, because it is mostly mouth and skeleton -------------
  addRibs(detail, mTooth, 8, (t) => {
    const x = lerp(0.06, -0.28, t);
    return { x, y: B.mid(x) - B.at(x).ry * 0.3, z: B.side(x) * 0.92,
      rz: 0.3 + t * 0.5, len: Math.max(0.04, B.at(x).ry * 1.4) };
  }, { r: 0.009 });

  // --- weak points: the lure bulb and the two eyes -----------------------
  addWeakPoint(detail, 0.445, B.top(0.22) + 0.31, 0.0, 0.062, 0xff5a86, wps);   // on the lure
  addWeakPoint(detail, 0.22, B.top(0.22) - 0.02, B.side(0.22) * 0.85, 0.044, 0xff5a86, wps);
  addWeakPoint(detail, 0.22, B.top(0.22) - 0.02, -B.side(0.22) * 0.85, 0.044, 0xff5a86, wps);

  return {
    anim(t, s, parts) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.5);
      mLure.emissiveIntensity = 2.0 + pulse * 2.0;
      mGullet.emissiveIntensity = 0.9 + pulse * 0.8 + s.mouth * 1.6;
      mSpot.emissiveIntensity = 1.2 + Math.sin(t * 2.2) * 0.6;
      stalk.rotation.z = Math.sin(t * 0.8) * 0.16;
      bulb.scale.setScalar(0.085 * (1 + pulse * 0.12));   // bulb is uniform
      gullet.scale.copy(gulletBase).multiplyScalar(1 + s.mouth * 0.28);
      toothRing.position.x = s.mouth * 0.035;
      toothRing.scale.setScalar(1 + s.mouth * 0.22);
      for (let i = 0; i < tendrils.length; i++) {
        tendrils[i].rotation.x = Math.sin(t * 1.6 + i) * 0.35;
        tendrils[i].rotation.y = Math.cos(t * 1.3 + i * 0.7) * 0.25;
      }
    },
  };
}

const BUILDERS = {
  'dock-eater': buildDockEater,
  'king-crab-boss': buildIronshell,
  'the-hammer': buildTheHammer,
  'stormfin': buildStormfin,
  'frostjaw': buildFrostjaw,
  'abyss-mouth': buildAbyssMouth,
};

/**
 * Rendered length in metres for each boss. Deliberately larger than the raw
 * species length so a boss reads as a boss at 40 m of visibility.
 */
export const BOSS_LENGTH = {
  'dock-eater': 7.0,
  'king-crab-boss': 6.5,
  'the-hammer': 11.0,
  'stormfin': 12.5,
  'frostjaw': 19.0,
  'abyss-mouth': 38.0,
};

/**
 * Bake every non-animated primitive under `host` into one merged mesh per
 * material. Anything marked `userData.dynamic` (or any descendant of it) is
 * left alone so `animateBoss` can still move it.
 */
function mergeStatic(host, skip) {
  const roots = [host];
  host.traverse((o) => {
    if (o === host || o === skip) return;
    if (skip && isUnder(o, skip)) return;
    if (o.userData?.dynamic && o.children.length) roots.push(o);
  });
  for (const root of roots) mergeUnder(root, skip);
}

function isUnder(o, ancestor) {
  let p = o.parent;
  while (p) { if (p === ancestor) return true; p = p.parent; }
  return false;
}

/** Merge every static mesh that belongs directly to `root`. */
function mergeUnder(root, skip) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  const doomed = [];

  root.traverse((o) => {
    if (o === root || !o.isMesh || o.userData?.dynamic) return;
    if (o === skip || (skip && isUnder(o, skip))) return;
    // Belongs to a nested dynamic node? That node merges it instead.
    let p = o.parent;
    while (p && p !== root) { if (p.userData?.dynamic) return; p = p.parent; }
    if (p !== root) return;
    const g = o.geometry;
    // The painted fish geometry carries extra attributes; never touch it.
    if (!g?.attributes?.position || g.getAttribute('aT') || g.getAttribute('color')) return;
    let list = buckets.get(o.material);
    if (!list) { list = []; buckets.set(o.material, list); }
    list.push({ geo: g, matrix: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
    doomed.push(o);
  });
  if (!doomed.length) return;

  for (const [material, list] of buckets) {
    const merged = mergeToBuffer(list);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, material);
    m.name = 'bossStatic';
    root.add(m);
  }
  for (const o of doomed) o.parent?.remove(o);
  const empties = [];
  root.traverse((o) => { if (o.isGroup && o !== root && !o.children.length && !o.userData?.dynamic) empties.push(o); });
  for (const e of empties) e.parent?.remove(e);
}

/** Concatenate transformed position+normal into a single non-indexed buffer. */
function mergeToBuffer(list) {
  const parts = [];
  let total = 0;
  for (const { geo: g, matrix } of list) {
    const c = g.index ? g.toNonIndexed() : g.clone();
    c.applyMatrix4(matrix);
    if (!c.getAttribute('normal')) c.computeVertexNormals();
    parts.push(c);
    total += c.attributes.position.count;
  }
  if (!total) return null;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let off = 0;
  for (const c of parts) {
    pos.set(c.attributes.position.array, off * 3);
    nrm.set(c.attributes.normal.array, off * 3);
    off += c.attributes.position.count;
    c.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

/**
 * Build a boss mesh.
 *
 * @param {string|object} speciesOrId  boss species id or species object
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @returns {THREE.Group} +X forward, normalised to 1.0 length
 */
export function buildBossMesh(speciesOrId, opts = {}) {
  const species = typeof speciesOrId === 'string' ? getSpecies(speciesOrId) : speciesOrId;
  if (!species) throw new Error(`[BossMesh] unknown species "${speciesOrId}"`);
  const rng = makeRNG(opts.seed ?? hashId(species.id));

  const group = new THREE.Group();
  group.name = `boss:${species.id}`;

  // --- base body from the normal fish pipeline ---------------------------
  let base = null;
  try {
    base = buildFishMesh(bossSpecies(species), null, { glow: clamp01((species.glow ?? 0) * 0.4) });
  } catch (e) {
    console.error('[BossMesh] base mesh failed for', species.id, e);
  }
  const host = new THREE.Group();
  host.name = 'bossHost';
  group.add(host);
  if (base) host.add(base);

  const parts = { ...(base?.userData?.parts || {}) };

  // --- boss-specific geometry -------------------------------------------
  const weakPoints = [];
  const builder = BUILDERS[species.id];
  let anim = null;
  if (builder) {
    try { anim = builder(host, species, rng, weakPoints, bodyProfile(base)).anim; }
    catch (e) { console.error('[BossMesh] detail build failed for', species.id, e); }
  }
  if (!weakPoints.length) {
    // Never leave a boss without something to shoot at.
    const C = pal(species);
    addWeakPoint(host, 0.20, 0.02, 0.06, 0.03, C.accent, weakPoints);
    addWeakPoint(host, 0.20, 0.02, -0.06, 0.03, C.accent, weakPoints);
    addWeakPoint(host, -0.10, 0.06, 0.0, 0.03, C.accent, weakPoints);
  }

  // --- collapse the static detail into one mesh per material -------------
  // A boss is ~120 little primitives; merged, it costs a handful of draws.
  if (base) base.userData.dynamic = true;
  mergeStatic(host, base);

  // --- re-normalise the whole assembly to 1.0 m along X ------------------
  host.updateMatrixWorld(true);
  _box.setFromObject(host);
  const sizeX = Math.max(1e-4, _box.max.x - _box.min.x);
  const k = 1 / sizeX;
  host.scale.setScalar(k);
  host.position.x = -((_box.max.x + _box.min.x) * 0.5) * k;
  host.updateMatrixWorld(true);
  // Weak point local positions must be expressed in the *group* frame.
  for (const wp of weakPoints) {
    wp.object3d.getWorldPosition(wp.localPos);
    group.worldToLocal(wp.localPos);
    wp.radius *= k;
  }

  group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });

  const state = { mouth: 0, aggro: 0, phase: 0, hpPct: 1, hurt: 0 };
  group.userData.parts = parts;
  group.userData.weakPoints = weakPoints;
  group.userData.species = species.id;
  group.userData.isBossMesh = true;
  group.userData.deform = base?.userData?.deform || (() => {});
  group.userData.resetDeform = base?.userData?.resetDeform || (() => {});
  group.userData.base = base;
  group.userData.setWeakPointBroken = (i) => darkenWeakPoint(weakPoints[i]);
  group.userData.resetWeakPoints = () => { for (const w of weakPoints) relightWeakPoint(w); };

  /**
   * @param {number} t   seconds
   * @param {object} s   {mode, mouth, aggro, speed, hpPct, hurt, phase}
   */
  group.userData.animateBoss = (t, s = {}) => {
    state.mouth = clamp01(s.mouth ?? 0);
    state.aggro = clamp01(s.aggro ?? 0);
    state.hpPct = s.hpPct ?? 1;
    state.hurt = s.hurt ?? 0;
    state.phase = s.phase ?? 0;
    const speed = s.speed ?? 0.4;

    // Body wave: slow and heavy at rest, fast and hard during an attack.
    const amp = lerp(0.55, 1.5, clamp01(speed)) * (1 + state.aggro * 0.6);
    try { group.userData.deform(t * lerp(1.4, 4.2, clamp01(speed)), amp, 1.5); } catch { /* no deformer */ }

    // Full-body roll and a flinch when it has just been hit.
    host.rotation.x = Math.sin(t * 0.8) * 0.06 + state.hurt * Math.sin(t * 40) * 0.10;
    host.position.y = Math.sin(t * 0.6) * 0.012;

    // Weak points breathe so they read as targets.
    for (let i = 0; i < weakPoints.length; i++) {
      const w = weakPoints[i];
      if (w.broken) continue;
      const p = 0.5 + 0.5 * Math.sin(t * 3.2 + i * 1.7);
      w._mat.emissiveIntensity = 1.8 + p * 2.0 + state.aggro * 1.4;
      const hb = w._halo.userData.base ?? 1;
      w._halo.scale.setScalar(hb * (0.85 + p * 0.3));
      w._halo.material.opacity = 0.34 + p * 0.26;
    }

    if (anim) { try { anim(t, state, parts); } catch { /* detail anim optional */ } }
  };

  group.userData.triangles = countTriangles(group);
  return group;
}

/** Triangle counts for every boss — for profiling and tests. */
export function bossTriangleReport() {
  const out = {};
  for (const id of Object.keys(BUILDERS)) {
    const g = buildBossMesh(id);
    out[id] = countTriangles(g);
    disposeBossMesh(g);
  }
  return out;
}

export function disposeBossMesh(group) {
  if (!group) return;
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (g && !g.userData?.shared && !Object.values(GEO).includes(g)) g.dispose();
    const m = o.material;
    if (m && !m.userData?.shared) m.dispose?.();
  });
  if (group.parent) group.parent.remove(group);
  group.userData.weakPoints = null;
  group.userData.animateBoss = null;
}

function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export { darkenWeakPoint, relightWeakPoint };
