import * as THREE from 'three';
import { makeRNG, lerp, clamp, TAU } from '../util/math.js';

/**
 * Procedural submarine hulls.
 *
 * Convention matches BoatMesh: **+Z is forward (bow)**, origin at the hull
 * centreline. Everything is built from a small set of shared materials and
 * low-segment primitives so a whole sub stays under ~3.5 k triangles.
 *
 * userData contract consumed by SubSystem:
 *   lightAnchors[]  Object3D — parent for the SpotLight + its cone mesh
 *   propAnchor      Object3D — spun by thrust
 *   canopy          Mesh     — transparent bubble, hidden in first person
 *   helm            Object3D — first-person eye point
 *   cargoBasket     Object3D — specimens are dropped here visually
 *   armPivot        Object3D — manipulator shoulder, animated on a grab
 */

// ---------------------------------------------------------------- materials
const _mats = new Map();
function m(color, rough = 0.55, metal = 0.35, extra = null) {
  const k = `${color}:${rough}:${metal}:${extra ? JSON.stringify(extra) : ''}`;
  let mat = _mats.get(k);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...(extra || {}) });
    _mats.set(k, mat);
  }
  return mat;
}

function glassMat(tint = 0x9fd8ee) {
  return m(tint, 0.08, 0.0, { transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
}

/** Emissive lamp material — SubSystem drives `emissiveIntensity`. */
function lampMat(color) {
  const k = `lamp:${color}`;
  let mat = _mats.get(k);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0, roughness: 0.3, metalness: 0.1,
    });
    _mats.set(k, mat);
  }
  return mat;
}

/**
 * Cheap additive light cone. Real volumetrics cost far more than they add.
 * Apex sits at the origin and the mouth opens along +Z, so a unit cone scaled
 * by (radius, radius, length) lines up with a SpotLight aimed at +Z.
 */
const _coneGeoCache = new Map();
function coneGeometry(seg = 14) {
  let g = _coneGeoCache.get(seg);
  if (!g) {
    g = new THREE.ConeGeometry(1, 1, seg, 1, true);
    g.rotateX(-Math.PI / 2);   // apex -> -Z (z = -0.5), mouth at z = +0.5
    g.translate(0, 0, 0.5);    // apex -> origin, mouth at z = +1
    _coneGeoCache.set(seg, g);
  }
  return g;
}

export function makeLightCone(color = 0xbfeaff, seg = 14) {
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(coneGeometry(seg), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  return mesh;
}

// ------------------------------------------------------------------ helpers
/**
 * A pressure cylinder with hemispherical end caps, merged into one geometry.
 * The barrel runs along Z; the bow dome is stretched, the stern dome squashed.
 */
function pressureHullGeometry(radius, length, radial = 16, capRings = 5, taper = 0.0) {
  const rBow = radius * (1 - taper);

  const barrel = new THREE.CylinderGeometry(rBow, radius, length, radial, 1, true);
  barrel.rotateX(Math.PI / 2);           // +Y (top of cylinder) -> +Z (bow)

  const bow = new THREE.SphereGeometry(rBow, radial, capRings, 0, TAU, 0, Math.PI / 2);
  bow.rotateX(Math.PI / 2);              // dome opens toward +Z
  bow.scale(1, 1, 1.35);
  bow.translate(0, 0, length / 2);

  const stern = new THREE.SphereGeometry(radius, radial, capRings, 0, TAU, 0, Math.PI / 2);
  stern.rotateX(-Math.PI / 2);           // dome opens toward -Z
  stern.scale(1, 1, 0.8);
  stern.translate(0, 0, -length / 2);

  return mergeGeometries([barrel, bow, stern]);
}

/** Minimal BufferGeometry merge — avoids pulling in the addons build. */
function mergeGeometries(geos) {
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (n) nor.set(n.array.subarray(0, n.count * 3), vo * 3);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Count triangles in a subtree — used by the dev budget check below. */
export function countTris(object) {
  let n = 0;
  object.traverse((o) => {
    const g = o.geometry;
    if (!o.isMesh || !g) return;
    n += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(n);
}

// -------------------------------------------------------------------- build
/**
 * @param {object} def SUBMARINES entry
 * @param {object} [opts] {seed, upgrades}
 * @returns {THREE.Group}
 */
export function buildSubMesh(def, opts = {}) {
  const rng = makeRNG(opts.seed ?? 7331);
  const g = new THREE.Group();
  g.name = `sub:${def.id}`;

  const h = def.hull;
  const L = h.length, W = h.width, H = h.height;
  const R = W * 0.5;
  const style = h.style;
  const big = style === 'industrial' || style === 'abyss';

  const hullMat = m(h.color, 0.5, 0.42);
  const accentMat = m(h.accent || '#e8b023', 0.45, 0.35);
  const darkMat = m('#22272d', 0.65, 0.5);
  const steelMat = m('#8a9099', 0.4, 0.72);
  const glass = glassMat(style === 'abyss' ? 0x8fd0e0 : 0xa8dcf0);

  // ---- pressure hull ---------------------------------------------------
  const barrelLen = L * (style === 'bubble' ? 0.46 : 0.6);
  const hull = new THREE.Mesh(
    pressureHullGeometry(R, barrelLen, big ? 16 : 14, big ? 5 : 4, style === 'bubble' ? 0.12 : 0.04),
    hullMat,
  );
  g.add(hull);

  // Ring stiffeners: cheap open cylinders that read as a real pressure vessel.
  const rings = style === 'bubble' ? 2 : big ? 5 : 3;
  for (let i = 0; i < rings; i++) {
    const t = (i + 1) / (rings + 1);
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 1.045, R * 1.045, R * 0.13, 14, 1, true),
      steelMat,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.z = lerp(-barrelLen * 0.46, barrelLen * 0.46, t);
    g.add(ring);
  }

  // Ballast blisters along the flanks.
  if (style !== 'bubble') {
    for (const s of [-1, 1]) {
      const blister = new THREE.Mesh(
        new THREE.CapsuleGeometry(R * 0.26, barrelLen * 0.62, 2, 8),
        darkMat,
      );
      blister.rotation.x = Math.PI / 2;
      blister.position.set(s * R * 0.92, -R * 0.34, 0);
      g.add(blister);
    }
  }

  // ---- conning tower / sail -------------------------------------------
  const sail = new THREE.Group();
  const sailH = H * (style === 'bubble' ? 0.26 : 0.42);
  const sailL = L * (style === 'bubble' ? 0.16 : 0.22);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(W * 0.34, sailH, sailL), hullMat);
  tower.position.y = R * 0.72 + sailH * 0.5;
  sail.add(tower);
  const towerCap = new THREE.Mesh(new THREE.BoxGeometry(W * 0.4, sailH * 0.16, sailL * 1.08), accentMat);
  towerCap.position.y = R * 0.72 + sailH;
  sail.add(towerCap);
  // Periscope / comms mast.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.022, W * 0.03, sailH * 0.9, 6), steelMat);
  mast.position.set(0, R * 0.72 + sailH * 1.45, -sailL * 0.2);
  sail.add(mast);
  sail.position.z = style === 'bubble' ? -L * 0.06 : L * 0.04;
  g.add(sail);

  // ---- bubble canopy (transparent) ------------------------------------
  const canopyR = R * (style === 'bubble' ? 0.92 : 0.62);
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(canopyR, 14, 8, 0, TAU, 0, Math.PI * 0.62),
    glass,
  );
  canopy.position.set(0, R * (style === 'bubble' ? 0.2 : 0.42), def.helm.z);
  canopy.renderOrder = 4;
  canopy.name = 'sub-canopy';
  g.add(canopy);
  // Canopy retaining ring so the acrylic reads as bolted on.
  const canopyRing = new THREE.Mesh(
    new THREE.CylinderGeometry(canopyR * 1.03, canopyR * 1.03, canopyR * 0.1, 14, 1, true), steelMat,
  );
  canopyRing.position.copy(canopy.position);
  g.add(canopyRing);

  // Extra viewports down the flanks on the bigger boats.
  if (style !== 'bubble') {
    const ports = big ? 4 : 2;
    for (let i = 0; i < ports; i++) {
      for (const s of [-1, 1]) {
        const port = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.13, R * 0.13, R * 0.1, 8), glass);
        port.rotation.z = Math.PI / 2;
        port.position.set(s * R * 0.98, R * 0.16, lerp(barrelLen * 0.34, -barrelLen * 0.3, i / Math.max(1, ports - 1)));
        g.add(port);
      }
    }
  }

  // ---- control surfaces ------------------------------------------------
  const planeMat = accentMat;
  for (const s of [-1, 1]) {
    // Bow planes.
    const bp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, R * 0.07, L * 0.09), planeMat);
    bp.position.set(s * W * 0.52, R * 0.1, L * 0.3);
    g.add(bp);
    // Stern planes.
    const sp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, R * 0.08, L * 0.1), planeMat);
    sp.position.set(s * W * 0.56, 0, -L * 0.36);
    g.add(sp);
  }
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(R * 0.08, H * 0.5, L * 0.1), planeMat);
  rudder.position.set(0, R * 0.1, -L * 0.38);
  g.add(rudder);

  // ---- side thrusters --------------------------------------------------
  const thrusterCount = big ? 3 : 2;
  for (let i = 0; i < thrusterCount; i++) {
    for (const s of [-1, 1]) {
      const t = new THREE.Group();
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.2, R * 0.2, R * 0.34, 10), darkMat);
      pod.rotation.z = Math.PI / 2;
      t.add(pod);
      const duct = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.24, R * 0.24, R * 0.12, 10, 1, true), steelMat);
      duct.rotation.z = Math.PI / 2;
      duct.position.x = s * R * 0.14;
      t.add(duct);
      t.position.set(
        s * R * 1.0,
        -R * 0.1,
        lerp(barrelLen * 0.36, -barrelLen * 0.36, thrusterCount === 1 ? 0.5 : i / (thrusterCount - 1)),
      );
      g.add(t);
    }
  }

  // ---- main propulsion -------------------------------------------------
  const propAnchor = new THREE.Group();
  propAnchor.position.set(0, 0, -L * 0.5 - R * 0.06);
  const shroud = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.5, R * 0.46, R * 0.34, 12, 1, true), steelMat,
  );
  shroud.rotation.x = Math.PI / 2;
  shroud.position.z = -L * 0.5 - R * 0.06;
  g.add(shroud);
  const blades = big ? 6 : 5;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * TAU;
    const b = new THREE.Mesh(new THREE.BoxGeometry(R * 0.62, R * 0.05, R * 0.22), m('#b8bfc6', 0.32, 0.85));
    b.rotation.z = a;
    b.position.set(Math.cos(a) * R * 0.24, Math.sin(a) * R * 0.24, 0);
    b.rotation.y = 0.34;
    propAnchor.add(b);
  }
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.1, R * 0.08, R * 0.2, 8), darkMat);
  boss.rotation.x = Math.PI / 2;
  propAnchor.add(boss);
  g.add(propAnchor);

  // ---- floodlights on gimbals -----------------------------------------
  const lightAnchors = [];
  for (const s of [-1, 1]) {
    const gimbal = new THREE.Group();
    const yoke = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.05, R * 0.05, R * 0.3, 6), steelMat);
    yoke.position.y = R * 0.12;
    gimbal.add(yoke);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.17, R * 0.2, R * 0.3, 10), darkMat);
    housing.rotation.x = Math.PI / 2;
    gimbal.add(housing);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(R * 0.16, 10), lampMat(0xfff4d8));
    lens.position.z = R * 0.16;
    gimbal.add(lens);
    gimbal.userData.lens = lens;
    gimbal.position.set(s * W * 0.42, R * (style === 'bubble' ? 0.3 : 0.46), L * 0.4);
    gimbal.name = `sub-light-${s < 0 ? 'port' : 'stbd'}`;
    g.add(gimbal);
    lightAnchors.push(gimbal);
  }

  // ---- manipulator arm (tier 2+) --------------------------------------
  let armPivot = null;
  if (def.tier >= 2 || style !== 'bubble') {
    armPivot = new THREE.Group();
    armPivot.name = 'sub-arm';
    const seg = (len, r, mat) => {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.86, len, 8), mat);
      s.rotation.x = Math.PI / 2;
      s.position.z = len * 0.5;
      return s;
    };
    const upper = seg(L * 0.16, R * 0.1, accentMat);
    armPivot.add(upper);
    const elbow = new THREE.Group();
    elbow.position.z = L * 0.16;
    elbow.rotation.x = -0.5;
    const fore = seg(L * 0.14, R * 0.08, steelMat);
    elbow.add(fore);
    const claw = new THREE.Group();
    claw.position.z = L * 0.14;
    for (const s of [-1, 1]) {
      const finger = new THREE.Mesh(new THREE.BoxGeometry(R * 0.05, R * 0.05, L * 0.055), darkMat);
      finger.position.set(s * R * 0.07, 0, L * 0.028);
      finger.rotation.y = -s * 0.28;
      claw.add(finger);
    }
    elbow.add(claw);
    armPivot.add(elbow);
    armPivot.userData.elbow = elbow;
    armPivot.userData.claw = claw;
    armPivot.position.set(-W * 0.3, -R * 0.42, L * 0.3);
    armPivot.rotation.x = 0.25;
    g.add(armPivot);
  }

  // ---- cargo basket ----------------------------------------------------
  const cargoBasket = new THREE.Group();
  cargoBasket.name = 'sub-cargo';
  {
    const bw = W * 0.62, bd = L * 0.18, bh = R * 0.34;
    const barMat = steelMat;
    // Floor grid + corner posts + rim: 10 thin boxes, ~120 tris.
    const floorBars = 4;
    for (let i = 0; i < floorBars; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, R * 0.035, R * 0.035), barMat);
      bar.position.z = lerp(-bd * 0.5, bd * 0.5, i / (floorBars - 1));
      cargoBasket.add(bar);
    }
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(R * 0.04, R * 0.04, bd), barMat);
      rail.position.set(s * bw * 0.5, bh, 0);
      cargoBasket.add(rail);
      for (const f of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(R * 0.04, bh, R * 0.04), barMat);
        post.position.set(s * bw * 0.5, bh * 0.5, f * bd * 0.5);
        cargoBasket.add(post);
      }
    }
    cargoBasket.position.set(0, -R * 0.95, -L * 0.08);
  }
  g.add(cargoBasket);

  // ---- running lights --------------------------------------------------
  const runningLights = [];
  const rlGeo = new THREE.SphereGeometry(Math.max(0.05, R * 0.06), 6, 4);
  const rl = [
    [-W * 0.48, R * 0.3, L * 0.3, 0xff3b3b],
    [W * 0.48, R * 0.3, L * 0.3, 0x3bff6b],
    [0, R * 0.72 + sailH * 1.05, L * 0.04, 0xfff2c0],
    [0, R * 0.2, -L * 0.46, 0xfff2c0],
  ];
  for (const [x, y, z, c] of rl) {
    const lamp = new THREE.Mesh(rlGeo, lampMat(c));
    lamp.position.set(x, y, z);
    g.add(lamp);
    runningLights.push(lamp);
  }

  // ---- anchors ---------------------------------------------------------
  const helm = new THREE.Object3D();
  helm.position.set(def.helm.x, def.helm.y, def.helm.z);
  g.add(helm);
  const bubbleVent = new THREE.Object3D();
  bubbleVent.position.set(0, R * 0.6, -L * 0.2);
  g.add(bubbleVent);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

  g.userData = {
    def, lightAnchors, propAnchor, canopy, helm, cargoBasket, armPivot,
    runningLights, sail, hullMesh: hull, bubbleVent,
    tris: 0,
  };
  g.userData.tris = countTris(g);
  if (import.meta.env?.DEV && g.userData.tris > 3500) {
    console.warn(`[SubMesh] ${def.id} is ${g.userData.tris} tris (budget 3500)`);
  }
  // A little variety between two subs of the same class.
  g.userData.seedJitter = rng();
  return g;
}

// ------------------------------------------------------------------ interior
/**
 * First-person cockpit shell. Rendered in the MAIN scene, parented to a group
 * that SubSystem pins to the camera, so it must be small, self-lit and cheap.
 *
 * @returns {THREE.Group} +Z forward, origin at the pilot's eye.
 */
export function buildSubInterior(def) {
  const g = new THREE.Group();
  g.name = `sub-interior:${def.id}`;

  const shell = m('#252e37', 0.85, 0.12, {
    side: THREE.BackSide, emissive: 0x0b1218, emissiveIntensity: 1.0,
  });
  const panel = new THREE.MeshStandardMaterial({
    color: 0x232c36, roughness: 0.7, metalness: 0.25,
    emissive: 0x0d1a22, emissiveIntensity: 1.0,
  });
  const trim = m('#3b4854', 0.5, 0.6);
  const pipeMat = m('#57636e', 0.5, 0.7);
  const glow = (c, i = 1.6) => new THREE.MeshStandardMaterial({
    color: c, emissive: c, emissiveIntensity: i, roughness: 0.4, metalness: 0,
  });

  // ---- hull shell around the head -------------------------------------
  // An inside-out sphere band with a wedge cut out of the FRONT so the pilot
  // can actually see through the viewport. In THREE's sphere parameterisation
  // phi = PI/2 points along +Z, so the gap is centred there.
  const GAP = 0.78;   // half-angle of the forward opening, radians
  const cabin = new THREE.Mesh(
    new THREE.SphereGeometry(
      1.42, 16, 8,
      Math.PI / 2 + GAP, TAU - GAP * 2,
      Math.PI * 0.08, Math.PI * 0.84,
    ),
    shell,
  );
  cabin.position.set(0, -0.05, -0.35);
  cabin.scale.set(1, 0.92, 1.3);
  g.add(cabin);

  // ---- viewport frame --------------------------------------------------
  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.055, 5, 16), trim);
  frame.position.set(0, -0.02, 1.22);
  g.add(frame);
  const frameInner = new THREE.Mesh(new THREE.TorusGeometry(0.66, 0.028, 4, 14), m('#0f1519', 0.9, 0.2));
  frameInner.position.set(0, -0.02, 1.26);
  g.add(frameInner);
  // Bolt heads around the port.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 4), trim);
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(Math.cos(a) * 0.80, -0.02 + Math.sin(a) * 0.80, 1.20);
    g.add(bolt);
  }

  // ---- curved console --------------------------------------------------
  const console_ = new THREE.Mesh(
    new THREE.CylinderGeometry(0.95, 1.02, 0.36, 16, 1, true, -Math.PI * 0.42, Math.PI * 0.84),
    panel,
  );
  console_.rotation.x = -0.36;
  console_.position.set(0, -0.70, 0.34);
  g.add(console_);
  const consoleLip = new THREE.Mesh(
    new THREE.CylinderGeometry(1.03, 1.03, 0.05, 16, 1, true, -Math.PI * 0.42, Math.PI * 0.84),
    trim,
  );
  consoleLip.rotation.x = -0.36;
  consoleLip.position.set(0, -0.53, 0.42);
  g.add(consoleLip);

  // ---- gauges ----------------------------------------------------------
  const gaugeGeo = new THREE.CircleGeometry(0.075, 10);
  const needleGeo = new THREE.BoxGeometry(0.008, 0.06, 0.004);
  const gauges = [];
  const gaugeColors = [0x4fe8d0, 0xffc22e, 0x43a9ff, 0xff5470, 0x8affd8];
  for (let i = 0; i < 5; i++) {
    const a = lerp(-0.62, 0.62, i / 4);
    const gg = new THREE.Group();
    const face = new THREE.Mesh(gaugeGeo, glow(gaugeColors[i], 0.9));
    gg.add(face);
    const needle = new THREE.Mesh(needleGeo, m('#0b0e11', 0.6, 0));
    needle.position.z = 0.004;
    needle.position.y = 0.028;
    gg.add(needle);
    gg.position.set(Math.sin(a) * 0.80, -0.40 + Math.cos(a) * 0.02, 0.66 + Math.cos(a) * 0.10);
    gg.rotation.set(-0.55, -a, 0);
    gg.userData.needle = needle;
    g.add(gg);
    gauges.push(gg);
  }

  // ---- indicator strip -------------------------------------------------
  const strip = [];
  for (let i = 0; i < 6; i++) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.012), glow(i < 4 ? 0x4fe8d0 : 0xffa23a, 1.4));
    led.position.set(lerp(-0.30, 0.30, i / 5), -0.27, 0.86);
    led.rotation.x = -0.36;
    g.add(led);
    strip.push(led);
  }

  // ---- pipes and conduit ----------------------------------------------
  for (let i = 0; i < 4; i++) {
    const s = i < 2 ? -1 : 1;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1.9, 6), pipeMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.rotation.z = s * 0.12;
    pipe.position.set(s * (1.16 + (i % 2) * 0.09), 0.46 - (i % 2) * 0.26, -0.55);
    g.add(pipe);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.07, 6), trim);
    collar.rotation.x = Math.PI / 2;
    collar.position.copy(pipe.position);
    collar.position.z -= 0.35;
    g.add(collar);
  }
  // Overhead conduit + a grab rail.
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6), trim);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, 0.72, -0.1);
  g.add(rail);

  // ---- helm yoke -------------------------------------------------------
  const yoke = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.26, 6), trim);
  stem.rotation.x = -0.7;
  yoke.add(stem);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.045, 0.05), m('#12171c', 0.8, 0.1));
  bar.position.set(0, 0.1, 0.08);
  yoke.add(bar);
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.14, 6), m('#12171c', 0.9, 0));
    grip.rotation.z = Math.PI / 2;
    grip.rotation.y = 0.3;
    grip.position.set(s * 0.22, 0.1, 0.08);
    yoke.add(grip);
  }
  yoke.position.set(0, -0.52, 0.66);
  g.add(yoke);

  // ---- cabin light so the shell reads in total darkness ----------------
  const cabinLight = new THREE.PointLight(0x8fe0f0, 4.0, 7.0, 2);
  cabinLight.position.set(0, 0.62, -0.25);
  g.add(cabinLight);

  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = 3; }
  });
  g.userData = { gauges, strip, yoke, cabinLight, tris: 0 };
  g.userData.tris = countTris(g);
  if (import.meta.env?.DEV && g.userData.tris > 1200) {
    console.warn(`[SubMesh] interior ${def.id} is ${g.userData.tris} tris (budget 1200)`);
  }
  return g;
}
