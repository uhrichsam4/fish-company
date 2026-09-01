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
function addWeakPoint(parent, x, y, z, radius, colorHex, list, hp = 1) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const m = weakMat(colorHex);
  const core = put(g, sphere(), m, [0, 0, 0], [0, 0, 0], radius * 2);
  const socket = put(g, ring(), mat(0x14161a, { rough: 0.9 }), [0, 0, 0], [Math.PI / 2, 0, 0], radius * 3.1);
  // Flat halo so the point is visible even edge-on.
  const halo = put(g, disc(), new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex), transparent: true, opacity: 0.42,
    depthWrite: false, side: THREE.DoubleSide,
  }), [0, 0, 0], [0, 0, 0], radius * 5.2);
  halo.userData.isHalo = true;
  parent.add(g);
  const wp = {
    object3d: g, localPos: new THREE.Vector3(x, y, z), radius,
    broken: false, hp, maxHp: hp,
    _mat: m, _core: core, _halo: halo, _socket: socket, _color: colorHex,
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
  wp._core.scale.multiplyScalar(0.62);
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
  wp._core.scale.multiplyScalar(1 / 0.62);
}

// ---------------------------------------------------------------------------
// Per-boss builders. Each gets (host, species, rng, C) where `host` is the
// group that already contains the base fish mesh at 1.0 length, and returns
// { weakPoints, anim } with `anim(t, state, parts)` doing the boss motion.
// ---------------------------------------------------------------------------

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
function buildDockEater(host, species, rng, wps) {
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
  raft.position.set(-0.02, 0.115, 0);
  raft.rotation.z = -0.14;
  for (let i = 0; i < 4; i++) {
    put(raft, box(), mWood, [0, 0.008 * i, (i - 1.5) * 0.052], [0, 0.05 * (i - 1.5), 0],
      [0.30 - i * 0.012, 0.016, 0.046]);
  }
  put(raft, box(), mMetal, [0.06, 0.026, 0], [0, 0, 0.1], [0.012, 0.05, 0.19]);
  detail.add(raft);

  // --- mooring rope wrapped round the head, trailing behind ---------------
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9;
    put(detail, ring(), mRope, [0.22 - i * 0.012, 0.02 * Math.cos(a), 0], [0, 0, Math.PI / 2],
      [0.115 - i * 0.004, 0.115 - i * 0.004, 0.115 - i * 0.004]);
  }
  const ropeTail = new THREE.Group();
  ropeTail.position.set(-0.36, 0.02, 0.05);
  for (let i = 0; i < 8; i++) {
    put(ropeTail, cyl5(), mRope, [-i * 0.028, -i * 0.012 - Math.sin(i) * 0.006, Math.sin(i * 0.8) * 0.02],
      [0, 0, Math.PI / 2 + i * 0.06], [0.009, 0.03, 0.009]);
  }
  detail.add(ropeTail);

  // --- chain and shackle hanging off the jaw ------------------------------
  addChain(detail, mMetal, [0.30, -0.03, 0.04], [-0.25, -0.96, 0], 7, 0.011);

  // --- barnacle crust along the flanks ------------------------------------
  addBarnacles(detail, mCrust, rng, 26, (r) => {
    const t = r();
    const side = r() < 0.5 ? 1 : -1;
    return {
      x: lerp(0.30, -0.34, t),
      y: lerp(0.05, -0.06, r()),
      z: side * (0.055 + r() * 0.028) * (1 - Math.abs(t - 0.4)),
    };
  });

  // --- broken teeth in a wide catfish maw ---------------------------------
  addTeeth(detail, mBone, 13, (t) => ({
    x: 0.365 - Math.abs(t - 0.5) * 0.10,
    y: -0.028,
    z: (t - 0.5) * 0.14,
    rz: Math.PI + (t - 0.5) * 0.5,
  }), { size: 0.030, broken: 0.4, rng });
  addTeeth(detail, mBone, 9, (t) => ({
    x: 0.352 - Math.abs(t - 0.5) * 0.09,
    y: -0.062,
    z: (t - 0.5) * 0.11,
  }), { size: 0.024, broken: 0.5, rng, down: false });

  // --- scars ---------------------------------------------------------------
  addScar(detail, mBody, 0.10, 0.05, 0.062, 0.20, 0.3);
  addScar(detail, mBody, -0.05, -0.02, -0.066, 0.15, -0.5);
  addScar(detail, mBody, 0.18, 0.03, -0.060, 0.09, 0.9);

  // --- weak points: two swollen gill sacs and a glowing gullet ------------
  addWeakPoint(detail, 0.175, -0.008, 0.070, 0.030, C.accent, wps);
  addWeakPoint(detail, 0.175, -0.008, -0.070, 0.030, C.accent, wps);
  addWeakPoint(detail, 0.315, -0.048, 0.0, 0.028, C.accent, wps);

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
function buildIronshell(host, species, rng, wps) {
  const C = pal(species);
  const mShell = mat(C.dark, { rough: 0.62, metal: 0.15 });
  const mPlate = mat(0x7a3325, { rough: 0.5, metal: 0.3 });
  const mMetal = mat(C.metal, { rough: 0.5, metal: 0.75 });
  const mRust = mat(C.rust, { rough: 0.95 });
  const mCrust = mat(0x9aa088, { rough: 1 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- riveted armour plating over the carapace ---------------------------
  addPlates(detail, mPlate, 7, (t, i) => ({
    x: lerp(0.20, -0.24, t),
    y: 0.085 - Math.abs(t - 0.45) * 0.05,
    z: (i % 3 - 1) * 0.10,
    rz: 0.1 + (i % 3 - 1) * 0.18,
    rx: (i % 2 ? 0.2 : -0.2),
  }), (t) => 0.15 - t * 0.04, 0.05);
  // rivets
  for (let i = 0; i < 14; i++) {
    put(detail, blob(), mMetal, [
      lerp(0.21, -0.23, rng()), 0.10 + rng() * 0.02, (rng() - 0.5) * 0.26,
    ], [0, 0, 0], 0.011);
  }

  // --- snagged crab-pot cage riding the shell -----------------------------
  const cage = new THREE.Group();
  cage.position.set(-0.14, 0.115, 0.02);
  cage.rotation.set(0.25, 0.4, 0.15);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU;
    put(cage, cyl5(), mRust, [Math.cos(a) * 0.07, 0.05, Math.sin(a) * 0.07], [0, 0, 0], [0.006, 0.10, 0.006]);
  }
  for (const y of [0.0, 0.05, 0.10]) {
    put(cage, ring(), mRust, [0, y, 0], [Math.PI / 2, 0, 0], [0.20, 0.20, 0.20]);
  }
  // one wall bent out of shape
  put(cage, box(), mRust, [0.06, 0.05, 0.03], [0.3, 0.4, 0.5], [0.005, 0.09, 0.07]);
  detail.add(cage);

  // --- chains dragging from the shell -------------------------------------
  addChain(detail, mMetal, [-0.18, 0.06, 0.09], [-0.5, -0.85, 0.1], 8, 0.013);
  addChain(detail, mMetal, [-0.15, 0.05, -0.11], [-0.3, -0.94, -0.1], 6, 0.012);

  // --- barnacle crust on the shoulders ------------------------------------
  addBarnacles(detail, mCrust, rng, 30, (r) => ({
    x: lerp(0.24, -0.28, r()),
    y: 0.02 + r() * 0.09,
    z: (r() - 0.5) * 0.34,
  }));

  // --- big scar across the shell, and a cracked plate ---------------------
  addScar(detail, mShell, 0.02, 0.10, 0.05, 0.24, 0.5, 0.016);
  put(detail, box(), mShell, [0.10, 0.10, -0.13], [0.3, 0.2, 0.4], [0.09, 0.012, 0.05]);

  // --- weak points: the joint sockets, exposed where plating is missing ---
  addWeakPoint(detail, 0.08, 0.035, 0.155, 0.030, C.accent, wps);
  addWeakPoint(detail, 0.08, 0.035, -0.155, 0.030, C.accent, wps);
  addWeakPoint(detail, 0.235, 0.075, 0.0, 0.030, C.accent, wps);   // eye-stalk base

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
function buildTheHammer(host, species, rng, wps) {
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
  harpoons.push(addHarpoon(detail, mMetal, mMetal, [0.02, 0.055, 0.052], [-0.25, 0.9, 0.35], 0.16));
  harpoons.push(addHarpoon(detail, mMetal, mMetal, [-0.10, 0.030, -0.058], [-0.5, 0.7, -0.5], 0.13));
  harpoons.push(addHarpoon(detail, mMetal, mMetal, [0.12, 0.020, -0.048], [0.1, 0.6, -0.8], 0.10));
  for (let i = 0; i < 6; i++) {
    put(detail, cyl5(), mRope, [0.02 - i * 0.03, 0.19 - i * 0.012, 0.07 + i * 0.008],
      [0, 0, 1.2], [0.005, 0.035, 0.005]);
  }

  // --- long white scars, the signature of a shark nobody has killed ------
  addScar(detail, mScar, 0.10, 0.02, 0.060, 0.24, 0.22, 0.011);
  addScar(detail, mScar, -0.04, 0.05, 0.056, 0.16, -0.35, 0.009);
  addScar(detail, mScar, 0.06, -0.03, -0.060, 0.28, 0.12, 0.012);
  addScar(detail, mScar, 0.24, 0.04, 0.030, 0.10, 0.8, 0.008);
  addScar(detail, mScar, 0.24, 0.04, -0.030, 0.10, -0.8, 0.008);

  // --- a semicircular bite taken out of the dorsal ------------------------
  put(detail, sphere(), mat(0x101418, { rough: 1 }), [-0.02, 0.135, 0], [0, 0, 0], [0.075, 0.055, 0.05]);
  addTeeth(detail, mBone, 7, (t) => ({
    x: -0.055 + t * 0.075, y: 0.125, z: 0.0, rz: Math.PI * 0.5 * (t - 0.5),
  }), { size: 0.020, broken: 0.6, rng, down: false });

  // --- ragged tail: a bite out of the upper lobe --------------------------
  put(detail, box(), mat(0x0e1216, { rough: 1 }), [-0.455, 0.095, 0], [0, 0, 0.5], [0.05, 0.05, 0.02]);

  // --- exposed ribs where the flank has been stripped ---------------------
  addRibs(detail, mBone, 5, (t) => ({
    x: lerp(-0.05, -0.20, t),
    y: -0.028 + t * 0.012,
    z: 0.052,
    rz: 0.35 + t * 0.35,
    len: 0.075 - t * 0.016,
  }), { r: 0.007 });

  // --- teeth: three rows, plenty snapped -----------------------------------
  for (let row = 0; row < 2; row++) {
    addTeeth(detail, mBone, 15, (t) => ({
      x: 0.325 - Math.abs(t - 0.5) * 0.11 - row * 0.022,
      y: -0.010 - row * 0.004,
      z: (t - 0.5) * 0.12,
      rz: Math.PI + (t - 0.5) * 0.4,
    }), { size: 0.026 - row * 0.005, broken: 0.32, rng });
  }
  addTeeth(detail, mBone, 12, (t) => ({
    x: 0.318 - Math.abs(t - 0.5) * 0.10,
    y: -0.052,
    z: (t - 0.5) * 0.10,
  }), { size: 0.022, broken: 0.4, rng, down: false });

  // --- weak points: gill rakers and the scarred snout --------------------
  addWeakPoint(detail, 0.150, -0.020, 0.062, 0.028, C.accent, wps);
  addWeakPoint(detail, 0.150, -0.020, -0.062, 0.028, C.accent, wps);
  addWeakPoint(detail, 0.300, 0.045, 0.0, 0.026, C.accent, wps);

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
function buildStormfin(host, species, rng, wps) {
  const C = pal(species);
  const mDark = mat(0x18244a, { rough: 0.5, metal: 0.2 });
  const mVolt = mat(C.accent, { rough: 0.25, glow: 2.4 });
  const mSail = mat(C.fin, { rough: 0.55, glow: 0.5, side: THREE.DoubleSide });
  const mMetal = mat(0x8fa8c8, { rough: 0.3, metal: 0.9 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- storm veins: glowing filaments running nose to tail ---------------
  const veins = [];
  for (let k = 0; k < 3; k++) {
    const zOff = (k - 1) * 0.045;
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const v = put(detail, blob(), mVolt, [
        lerp(0.30, -0.36, t),
        lerp(0.055, 0.02, t) + Math.sin(t * 7 + k) * 0.018,
        zOff + Math.sin(t * 5 + k * 2) * 0.02,
      ], [0, 0, 0], 0.014 + (1 - t) * 0.008);
      veins.push(v);
    }
  }

  // --- torn sail dorsal: a row of spines with gaps -----------------------
  const sail = new THREE.Group();
  for (let i = 0; i < 11; i++) {
    const t = i / 10;
    if (i === 4 || i === 7) continue;   // torn away
    const h = (0.10 + Math.sin(t * Math.PI) * 0.11) * (1 - t * 0.35);
    put(sail, cone4(), mSail, [lerp(0.20, -0.16, t), 0.075 + h * 0.5, 0],
      [0, 0, -0.12], [0.012, h, 0.03]);
  }
  detail.add(sail);

  // --- lightning-rod bill with metal ferrules ----------------------------
  for (let i = 0; i < 4; i++) {
    put(detail, ring(), mMetal, [0.40 + i * 0.035, 0.008, 0], [0, 0, Math.PI / 2],
      [0.030 - i * 0.005, 0.030 - i * 0.005, 0.030 - i * 0.005]);
  }
  const tip = put(detail, cone6(), mVolt, [0.505, 0.008, 0], [0, 0, -Math.PI / 2], [0.016, 0.05, 0.016]);

  // --- arc nodes: little floating electrodes that spark ------------------
  const arcs = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    const a = put(detail, blob(), mVolt, [lerp(0.24, -0.28, t), 0.20 + Math.sin(t * 3) * 0.03,
      (i % 2 ? 1 : -1) * 0.07], [0, 0, 0], 0.02);
    arcs.push(a);
  }

  // --- scarring where lightning has hit it before ------------------------
  addScar(detail, mat(0xcfe4ff, { rough: 0.4, glow: 0.6 }), 0.05, 0.06, 0.055, 0.18, 0.4, 0.009);
  addScar(detail, mat(0xcfe4ff, { rough: 0.4, glow: 0.6 }), -0.10, 0.02, -0.058, 0.14, -0.6, 0.008);

  // --- weak points: three storm nodes along the spine --------------------
  addWeakPoint(detail, 0.185, 0.088, 0.0, 0.030, C.accent, wps);
  addWeakPoint(detail, -0.020, 0.098, 0.0, 0.030, C.accent, wps);
  addWeakPoint(detail, -0.215, 0.070, 0.0, 0.028, C.accent, wps);

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
      tip.scale.setScalar(1 + pulse * 0.25);
      if (parts.pecL) parts.pecL.rotation.x = Math.sin(t * 2.4) * 0.2;
      if (parts.pecR) parts.pecR.rotation.x = -Math.sin(t * 2.4) * 0.2;
    },
  };
}

// ------------------------------------------------------------------ frostjaw
function buildFrostjaw(host, species, rng, wps) {
  const C = pal(species);
  const mIce = mat(0xbfe8fa, { rough: 0.18, metal: 0.05, glow: 0.25, transparent: true, opacity: 0.86 });
  const mCrack = mat(C.accent, { rough: 0.3, glow: 2.0 });
  const mBone = mat(0xeef4f6, { rough: 0.4 });
  const mHide = mat(0x2e465c, { rough: 0.9 });

  const detail = new THREE.Group();
  host.add(detail);

  // --- ice plates and spikes frozen onto the back -------------------------
  const spikes = [];
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    const h = 0.05 + Math.sin(t * Math.PI) * 0.10;
    const s = put(detail, cone4(), mIce,
      [lerp(0.30, -0.34, t), 0.060 + Math.sin(t * Math.PI) * 0.035, ((i % 3) - 1) * 0.035],
      [(rng() - 0.5) * 0.4, rng() * TAU, (rng() - 0.5) * 0.3],
      [0.022 + rng() * 0.012, h, 0.022 + rng() * 0.012]);
    spikes.push(s);
  }
  addPlates(detail, mIce, 6, (t) => ({
    x: lerp(0.24, -0.28, t), y: 0.075, z: 0, rz: 0.2,
  }), 0.10, 0.1);

  // --- glowing cracks through the frozen crust ---------------------------
  const cracks = [];
  for (let i = 0; i < 22; i++) {
    const t = rng();
    const c = put(detail, box(), mCrack, [
      lerp(0.28, -0.32, t),
      lerp(0.06, -0.05, rng()),
      (rng() < 0.5 ? 1 : -1) * (0.035 + rng() * 0.026),
    ], [0, 0, rng() * TAU], [0.035 + rng() * 0.03, 0.006, 0.006]);
    cracks.push(c);
  }

  // --- exposed ribs along both flanks ------------------------------------
  for (const side of [1, -1]) {
    addRibs(detail, mBone, 6, (t) => ({
      x: lerp(0.06, -0.22, t),
      y: -0.020 + t * 0.010,
      z: side * 0.046,
      rz: 0.3 + t * 0.4,
      len: 0.085 - t * 0.02,
    }), { r: 0.008 });
  }

  // --- the jaw: oversized, crooked, half the teeth snapped ---------------
  const jaw = new THREE.Group();
  jaw.position.set(0.28, -0.02, 0);
  addTeeth(jaw, mBone, 17, (t) => ({
    x: 0.06 - Math.abs(t - 0.5) * 0.12,
    y: -0.012,
    z: (t - 0.5) * 0.16,
    rz: Math.PI + (t - 0.5) * 0.55,
  }), { size: 0.040, broken: 0.38, rng });
  addTeeth(jaw, mBone, 14, (t) => ({
    x: 0.05 - Math.abs(t - 0.5) * 0.10,
    y: -0.075,
    z: (t - 0.5) * 0.13,
  }), { size: 0.034, broken: 0.45, rng, down: false });
  detail.add(jaw);

  // --- frost breath vents ------------------------------------------------
  for (const s of [1, -1]) put(detail, cyl6(), mHide, [0.24, 0.03, s * 0.045], [0, 0, 0.4], [0.018, 0.03, 0.018]);

  // --- weak points: the melt-holes in the ice over its heart ------------
  addWeakPoint(detail, 0.055, 0.055, 0.052, 0.032, C.accent, wps);
  addWeakPoint(detail, 0.055, 0.055, -0.052, 0.032, C.accent, wps);
  addWeakPoint(detail, -0.170, 0.045, 0.0, 0.032, C.accent, wps);

  return {
    anim(t, s, parts) {
      mCrack.emissiveIntensity = 1.2 + Math.sin(t * 2.4) * 0.6 + s.aggro * 1.6;
      jaw.rotation.z = s.mouth * 0.42;
      jaw.position.y = -0.02 - s.mouth * 0.02;
      for (let i = 0; i < spikes.length; i++) {
        spikes[i].scale.y = spikes[i].scale.y * 0.0 + (0.05 + Math.sin(i * 0.7) * 0.02)
          + (0.10 * (0.6 + 0.4 * Math.sin(t * 1.2 + i)));
      }
      if (parts.tail) parts.tail.rotation.y = Math.sin(t * 1.4) * 0.2;
    },
  };
}

// --------------------------------------------------------------- abyss-mouth
function buildAbyssMouth(host, species, rng, wps) {
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
  stalk.position.set(0.20, 0.09, 0);
  const segs = 7;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    put(stalk, cyl5(), mFlesh, [t * 0.16, t * 0.20 + Math.sin(t * 2) * 0.03, 0],
      [0, 0, -0.7], [0.010 - t * 0.004, 0.045, 0.010 - t * 0.004]);
  }
  const bulb = put(stalk, sphere(), mLure, [0.185, 0.235, 0], [0, 0, 0], 0.062);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    put(stalk, cyl5(), mLure, [0.185 + Math.cos(a) * 0.03, 0.235 + Math.sin(a) * 0.03, 0],
      [0, 0, a], [0.004, 0.05, 0.004]);
  }
  detail.add(stalk);

  // --- glowing gullet behind the teeth ------------------------------------
  const gullet = put(detail, sphere(), mGullet, [0.24, -0.03, 0], [0, 0, 0], [0.12, 0.14, 0.15]);

  // --- ring of enormous teeth --------------------------------------------
  const toothRing = new THREE.Group();
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * TAU;
    const r = 0.115 + Math.sin(a * 3) * 0.012;
    const long = i % 4 === 0;
    const chip = rng() < 0.22;
    put(toothRing, cone4(), mTooth,
      [0.325, Math.sin(a) * r - 0.02, Math.cos(a) * r],
      [0, 0, -Math.PI / 2 - Math.sin(a) * 0.25],
      [0.017, chip ? 0.03 : (long ? 0.10 : 0.070), 0.017]);
  }
  detail.add(toothRing);

  // --- bioluminescent spot rows along the flanks -------------------------
  const spots = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const sp = put(detail, blob(), mSpot, [
        lerp(0.16, -0.40, t),
        lerp(-0.02, 0.03, t) + Math.sin(t * 6) * 0.02,
        side * (0.075 - t * 0.03),
      ], [0, 0, 0], 0.012);
      spots.push(sp);
    }
  }

  // --- tendrils trailing from the jaw ------------------------------------
  const tendrils = [];
  for (let k = 0; k < 6; k++) {
    const g = new THREE.Group();
    const a = (k / 6) * TAU;
    g.position.set(0.30, Math.sin(a) * 0.09 - 0.03, Math.cos(a) * 0.09);
    for (let i = 0; i < 5; i++) {
      put(g, cyl5(), mFlesh, [i * 0.038, -i * 0.012, 0], [0, 0, Math.PI / 2 - i * 0.10],
        [0.006, 0.045, 0.006]);
    }
    put(g, blob(), mSpot, [0.20, -0.06, 0], [0, 0, 0], 0.014);
    detail.add(g);
    tendrils.push(g);
  }

  // --- exposed ribs, because it is mostly mouth and skeleton -------------
  addRibs(detail, mTooth, 7, (t) => ({
    x: lerp(0.05, -0.28, t), y: -0.03, z: 0.055,
    rz: 0.3 + t * 0.5, len: 0.09 - t * 0.02,
  }), { r: 0.008 });

  // --- weak points: the lure bulb and the two eyes -----------------------
  addWeakPoint(detail, 0.385, 0.325, 0.0, 0.055, 0xff5a86, wps);   // on the lure
  addWeakPoint(detail, 0.235, 0.075, 0.075, 0.038, 0xff5a86, wps);
  addWeakPoint(detail, 0.235, 0.075, -0.075, 0.038, 0xff5a86, wps);

  return {
    anim(t, s, parts) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.5);
      mLure.emissiveIntensity = 2.0 + pulse * 2.0;
      mGullet.emissiveIntensity = 0.9 + pulse * 0.8 + s.mouth * 1.6;
      mSpot.emissiveIntensity = 1.2 + Math.sin(t * 2.2) * 0.6;
      stalk.rotation.z = Math.sin(t * 0.8) * 0.16;
      bulb.scale.setScalar(0.062 * (1 + pulse * 0.12));
      gullet.scale.set(0.12 + s.mouth * 0.05, 0.14 + s.mouth * 0.06, 0.15 + s.mouth * 0.06);
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
    base = buildFishMesh(species, null, { glow: clamp01((species.glow ?? 0) * 0.8 + 0.1) });
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
    try { anim = builder(host, species, rng, weakPoints).anim; }
    catch (e) { console.error('[BossMesh] detail build failed for', species.id, e); }
  }
  if (!weakPoints.length) {
    // Never leave a boss without something to shoot at.
    const C = pal(species);
    addWeakPoint(host, 0.20, 0.02, 0.06, 0.03, C.accent, weakPoints);
    addWeakPoint(host, 0.20, 0.02, -0.06, 0.03, C.accent, weakPoints);
    addWeakPoint(host, -0.10, 0.06, 0.0, 0.03, C.accent, weakPoints);
  }

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
      w._mat.emissiveIntensity = 1.5 + p * 1.6 + state.aggro * 1.2;
      w._halo.scale.setScalar((w.radius / (w.radius || 1)) * (1 + p * 0.22) * (w._halo.userData._s0 ?? 1));
      if (w._halo.userData._s0 === undefined) w._halo.userData._s0 = w._halo.scale.x;
      w._halo.lookAt(0, 1e4, 0);
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
