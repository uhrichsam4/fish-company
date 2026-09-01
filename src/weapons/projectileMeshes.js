import * as THREE from 'three';

/**
 * Procedural projectile meshes for WeaponSystem.
 *
 * Everything is authored pointing along +Z with the origin at the balance
 * point, so orienting a projectile is a single
 * `quaternion.setFromUnitVectors(FORWARD_Z, velocityDir)`.
 *
 * Geometries and materials are module-level singletons: projectiles are
 * pooled and recycled, so a fired spear never allocates.
 */

const _geo = new Map();
const _mat = new Map();

function geo(key, make) {
  let g = _geo.get(key);
  if (!g) { g = make(); _geo.set(key, g); }
  return g;
}
function mat(key, make) {
  let m = _mat.get(key);
  if (!m) { m = make(); _mat.set(key, m); }
  return m;
}

const STEEL = () => mat('steel', () => new THREE.MeshStandardMaterial({ color: 0xc6ced6, roughness: 0.28, metalness: 0.92 }));
const DARK = () => mat('dark', () => new THREE.MeshStandardMaterial({ color: 0x39424b, roughness: 0.45, metalness: 0.7 }));
const WOOD = () => mat('wood', () => new THREE.MeshStandardMaterial({ color: 0x7d5c37, roughness: 0.92, metalness: 0.02 }));
const ORANGE = () => mat('orange', () => new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.5, metalness: 0.2 }));
const LEAD = () => mat('lead', () => new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.7, metalness: 0.5 }));

/** Cylinder whose axis runs along +Z. */
function shaftGeo(key, rTip, rBack, len, seg = 7) {
  return geo(key, () => new THREE.CylinderGeometry(rTip, rBack, len, seg).rotateX(Math.PI / 2));
}
/** Cone pointing along +Z. */
function coneGeo(key, r, h, seg = 6) {
  return geo(key, () => new THREE.ConeGeometry(r, h, seg).rotateX(Math.PI / 2));
}

// ---------------------------------------------------------------- spear
export function buildSpear() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(shaftGeo('spear.shaft', 0.017, 0.021, 1.32), WOOD());
  shaft.position.z = 0.02;
  g.add(shaft);
  const head = new THREE.Mesh(coneGeo('spear.head', 0.034, 0.2), STEEL());
  head.position.z = 0.77;
  g.add(head);
  for (const s of [-1, 1]) {
    const barb = new THREE.Mesh(coneGeo('spear.barb', 0.014, 0.09, 4), STEEL());
    barb.position.set(s * 0.026, 0, 0.6);
    barb.rotation.set(0, 0, 0);
    barb.rotateY(s * 0.5);
    barb.rotateX(Math.PI);
    g.add(barb);
  }
  // Fletching-ish tail wrap so the back end reads in flight.
  const wrap = new THREE.Mesh(shaftGeo('spear.wrap', 0.026, 0.026, 0.09, 6), DARK());
  wrap.position.z = -0.56;
  g.add(wrap);
  g.userData.length = 1.5;
  return g;
}

// -------------------------------------------------------------- harpoon
/** @param {number} k size multiplier (1 = harpoon, 1.7 = heavy harpoon) */
export function buildHarpoon(k = 1) {
  const g = new THREE.Group();
  const heavy = k > 1.3;
  const shaft = new THREE.Mesh(shaftGeo('harp.shaft', 0.023, 0.028, 1.5, 8), STEEL());
  g.add(shaft);
  const head = new THREE.Mesh(coneGeo('harp.head', 0.05, 0.26, 7), DARK());
  head.position.z = 0.88;
  g.add(head);
  // Three swept-back barbs around the head.
  for (let i = 0; i < 3; i++) {
    const barb = new THREE.Mesh(coneGeo('harp.barb', 0.019, 0.15, 4), STEEL());
    const a = (i / 3) * Math.PI * 2;
    barb.position.set(Math.cos(a) * 0.036, Math.sin(a) * 0.036, 0.6);
    barb.rotateX(Math.PI);
    barb.rotateOnWorldAxis(new THREE.Vector3(-Math.sin(a), Math.cos(a), 0), 0.55);
    g.add(barb);
  }
  // Rope eyelet at the tail — where the tether visually terminates.
  const eye = new THREE.Mesh(
    geo('harp.eye', () => new THREE.TorusGeometry(0.036, 0.009, 4, 10)),
    heavy ? ORANGE() : DARK(),
  );
  eye.position.z = -0.76;
  eye.rotation.y = Math.PI / 2;
  g.add(eye);
  // Guide fins keep the silhouette readable against the water.
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(
      geo('harp.fin', () => new THREE.BoxGeometry(0.006, 0.075, 0.2)),
      heavy ? ORANGE() : DARK(),
    );
    const a = (i / 3) * Math.PI * 2 + 0.5;
    fin.position.set(Math.cos(a) * 0.038, Math.sin(a) * 0.038, -0.55);
    fin.rotation.z = a;
    g.add(fin);
  }
  if (heavy) {
    const band = new THREE.Mesh(shaftGeo('harp.band', 0.034, 0.034, 0.1, 8), ORANGE());
    band.position.z = 0.24;
    g.add(band);
  }
  g.scale.setScalar(k);
  g.userData.length = 1.8 * k;
  return g;
}

// ------------------------------------------------------------------ net
/**
 * Weighted net. `userData.setOpen(t)` blends from a tight bundle to a full
 * disc of unit radius (the system scales it up to stats.netRadius).
 */
export function buildNet() {
  const g = new THREE.Group();

  const RINGS = 4, SPOKES = 12;
  const netGeo = geo('net.mesh', () => {
    const pts = [];
    for (let r = 1; r <= RINGS; r++) {
      const rad = r / RINGS;
      for (let s = 0; s < SPOKES; s++) {
        const a0 = (s / SPOKES) * Math.PI * 2, a1 = ((s + 1) / SPOKES) * Math.PI * 2;
        // Bowl-shaped sag so the net reads as a pouch, not a flat plate.
        const z = -rad * rad * 0.34;
        pts.push(Math.cos(a0) * rad, Math.sin(a0) * rad, z, Math.cos(a1) * rad, Math.sin(a1) * rad, z);
      }
    }
    for (let s = 0; s < SPOKES; s++) {
      const a = (s / SPOKES) * Math.PI * 2;
      for (let r = 0; r < RINGS; r++) {
        const r0 = r / RINGS, r1 = (r + 1) / RINGS;
        pts.push(Math.cos(a) * r0, Math.sin(a) * r0, -r0 * r0 * 0.34,
          Math.cos(a) * r1, Math.sin(a) * r1, -r1 * r1 * 0.34);
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return bg;
  });
  const netMat = mat('net.mat', () => new THREE.LineBasicMaterial({
    color: 0xdfe8e2, transparent: true, opacity: 0.8, depthWrite: false,
  }));
  const web = new THREE.LineSegments(netGeo, netMat);
  web.frustumCulled = false;
  g.add(web);

  const weights = [];
  const wGeo = geo('net.weight', () => new THREE.SphereGeometry(0.07, 6, 5));
  for (let i = 0; i < 8; i++) {
    const w = new THREE.Mesh(wGeo, LEAD());
    const a = (i / 8) * Math.PI * 2;
    w.userData.a = a;
    weights.push(w);
    g.add(w);
  }

  g.userData.setOpen = (t) => {
    const s = 0.1 + t * 0.9;
    web.scale.setScalar(s);
    for (const w of weights) {
      w.position.set(Math.cos(w.userData.a) * s, Math.sin(w.userData.a) * s, -0.34 * s);
      w.scale.setScalar(0.6 + (1 - t) * 0.9);
    }
  };
  g.userData.setOpen(0);
  g.userData.length = 0.4;
  return g;
}

// ----------------------------------------------------------------- beam
/**
 * Energy beam: crossed additive quads spanning z from 0 to 1, so the system
 * scales z by the hit distance and x/y by the beam width.
 */
export function buildBeam() {
  const g = new THREE.Group();
  const quad = geo('beam.quad', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5));
  const coreMat = mat('beam.core', () => new THREE.MeshBasicMaterial({
    color: 0xcffbff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  const glowMat = mat('beam.glow', () => new THREE.MeshBasicMaterial({
    color: 0x35d6ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  for (let i = 0; i < 3; i++) {
    const outer = new THREE.Mesh(quad, glowMat);
    outer.rotation.z = (i / 3) * Math.PI;
    outer.scale.set(3, 1, 1);
    g.add(outer);
  }
  for (let i = 0; i < 2; i++) {
    const core = new THREE.Mesh(quad, coreMat);
    core.rotation.z = (i / 2) * Math.PI;
    g.add(core);
  }
  g.renderOrder = 12;
  g.userData.length = 0;
  return g;
}

/** Cone volume shown while a suction weapon is firing. */
export function buildSuctionCone() {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(
    geo('suck.cone', () => new THREE.ConeGeometry(1, 1, 18, 3, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5)),
    mat('suck.mat', () => new THREE.MeshBasicMaterial({
      color: 0x7fe6ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false, wireframe: true,
    })),
  );
  g.add(cone);
  g.renderOrder = 11;
  return g;
}

export function buildProjectileMesh(kind) {
  switch (kind) {
    case 'spear': return buildSpear();
    case 'harpoon': return buildHarpoon(1);
    case 'heavy_harpoon': return buildHarpoon(1.7);
    case 'net': return buildNet();
    case 'beam': return buildBeam();
    default: return buildSpear();
  }
}
