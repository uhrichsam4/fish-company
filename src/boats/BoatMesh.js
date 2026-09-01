import * as THREE from 'three';
import { makeRNG, lerp, clamp } from '../util/math.js';

/**
 * Procedural stylized boat hulls. One vertex-coloured mesh per boat keeps the
 * draw call count low; deck fittings are separate small meshes so they can be
 * toggled by upgrade level.
 */

const _mats = new Map();
function m(color, rough = 0.7, metal = 0.06) {
  const k = `${color}:${rough}:${metal}`;
  if (!_mats.has(k)) _mats.set(k, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  return _mats.get(k);
}

/**
 * @param {object} def BOATS entry
 * @param {object} opts {upgrades, seed}
 * @returns {THREE.Group} +Z is forward (bow), origin at the waterline centre.
 */
export function buildBoatMesh(def, opts = {}) {
  const rng = makeRNG(opts.seed ?? 12345);
  const g = new THREE.Group();
  g.name = `boat:${def.id}`;
  const h = def.hull;
  const L = h.length, W = h.width, H = h.height;
  const hullMat = m(h.color, 0.62, 0.08);
  const deckMat = m(h.deck, 0.88, 0.02);
  const accentMat = m(h.accent || '#e8b023', 0.55, 0.12);
  const darkMat = m('#2b3138', 0.7, 0.2);
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x8fc6e0, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.55,
  });

  // ---- hull ----
  const hull = new THREE.Mesh(buildHullGeometry(L, W, H, h.style), hullMat);
  hull.position.y = -H * 0.25;
  g.add(hull);

  // ---- deck plane ----
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.08, L * 0.94), deckMat);
  deck.position.y = H * 0.22;
  g.add(deck);

  // Deck planking lines for the wooden styles.
  if (h.style === 'raft' || h.style === 'work') {
    const planks = Math.floor(W / 0.38);
    for (let i = 0; i < planks; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, L * 0.92), m(shade(h.deck, 0.86 + rng() * 0.28), 0.92, 0));
      p.position.set((i - (planks - 1) / 2) * 0.38, H * 0.25, 0);
      g.add(p);
    }
  }

  // ---- gunwales (side rails) ----
  if (h.style !== 'raft') {
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.13, H * 0.34, L * 0.9), accentMat);
      rail.position.set(s * W * 0.46, H * 0.36, 0);
      g.add(rail);
    }
    const bowRail = new THREE.Mesh(new THREE.BoxGeometry(W * 0.6, H * 0.3, 0.12), accentMat);
    bowRail.position.set(0, H * 0.35, L * 0.44);
    g.add(bowRail);
  }

  // ---- superstructure ----
  switch (h.style) {
    case 'speed': {
      const wind = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, H * 0.42, 0.9), glassMat);
      wind.position.set(0, H * 0.55, L * 0.06);
      wind.rotation.x = -0.28;
      g.add(wind);
      const console_ = new THREE.Mesh(new THREE.BoxGeometry(W * 0.6, H * 0.35, 0.5), darkMat);
      console_.position.set(0, H * 0.4, -L * 0.02);
      g.add(console_);
      break;
    }
    case 'work': {
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.72, H * 0.75, L * 0.24), deckMat);
      cabin.position.set(0, H * 0.6, -L * 0.28);
      g.add(cabin);
      const win = new THREE.Mesh(new THREE.BoxGeometry(W * 0.66, H * 0.3, 0.06), glassMat);
      win.position.set(0, H * 0.75, -L * 0.28 + L * 0.12 + 0.03);
      g.add(win);
      // Rod holders.
      for (let i = 0; i < 4; i++) {
        const rh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.45, 6), darkMat);
        rh.position.set((i < 2 ? -1 : 1) * W * 0.44, H * 0.5, (i % 2 ? 0.6 : -0.6) + L * 0.1);
        rh.rotation.x = 0.25;
        g.add(rh);
      }
      break;
    }
    case 'cabin': {
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.78, H * 0.55, L * 0.42), deckMat);
      cabin.position.set(0, H * 0.5, -L * 0.14);
      g.add(cabin);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, H * 0.28, L * 0.2), deckMat);
      upper.position.set(0, H * 0.85, -L * 0.2);
      g.add(upper);
      const win = new THREE.Mesh(new THREE.BoxGeometry(W * 0.74, H * 0.2, L * 0.4), glassMat);
      win.position.set(0, H * 0.62, -L * 0.14);
      g.add(win);
      break;
    }
    case 'commercial':
    case 'trawler':
    case 'factory': {
      const scale = h.style === 'factory' ? 1.4 : 1;
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(W * 0.72, H * 0.5, L * 0.2), deckMat);
      bridge.position.set(0, H * 0.5, -L * 0.3);
      g.add(bridge);
      const wheelhouse = new THREE.Mesh(new THREE.BoxGeometry(W * 0.56, H * 0.3, L * 0.14), deckMat);
      wheelhouse.position.set(0, H * 0.85, -L * 0.3);
      g.add(wheelhouse);
      const bwin = new THREE.Mesh(new THREE.BoxGeometry(W * 0.52, H * 0.16, L * 0.145), glassMat);
      bwin.position.set(0, H * 0.9, -L * 0.3);
      g.add(bwin);
      // Funnel.
      const funnel = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.09, W * 0.1, H * 0.45, 10), accentMat);
      funnel.position.set(0, H * 1.15, -L * 0.34);
      g.add(funnel);
      // A-frame gantry over the stern.
      const gantryMat = m('#8a9099', 0.5, 0.6);
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * scale, 0.12 * scale, H * 0.9, 6), gantryMat);
        leg.position.set(s * W * 0.36, H * 0.65, -L * 0.44);
        leg.rotation.z = s * -0.16;
        g.add(leg);
      }
      const cross = new THREE.Mesh(new THREE.BoxGeometry(W * 0.78, 0.16 * scale, 0.16 * scale), gantryMat);
      cross.position.set(0, H * 1.08, -L * 0.46);
      g.add(cross);
      // Net drum.
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.16, W * 0.16, W * 0.55, 12), m('#4a4f55', 0.8, 0.3));
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, H * 0.42, -L * 0.36);
      g.add(drum);
      // Cargo hatches / containers.
      const hatches = h.style === 'factory' ? 6 : h.style === 'trawler' ? 3 : 2;
      for (let i = 0; i < hatches; i++) {
        const hz = lerp(L * 0.32, -L * 0.08, i / Math.max(1, hatches - 1));
        const hatch = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, H * 0.12, L * 0.1), m('#6a6f74', 0.85, 0.2));
        hatch.position.set(0, H * 0.3, hz);
        g.add(hatch);
      }
      if (h.style === 'factory') {
        // Deck cranes.
        for (const s of [-1, 1]) {
          const crane = new THREE.Group();
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, H * 0.7, 8), accentMat);
          mast.position.y = H * 0.35;
          crane.add(mast);
          const jib = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, L * 0.22), accentMat);
          jib.position.set(0, H * 0.66, L * 0.09);
          jib.rotation.x = -0.3;
          crane.add(jib);
          crane.position.set(s * W * 0.3, H * 0.28, L * 0.08);
          g.add(crane);
        }
      }
      break;
    }
    default: break;
  }

  // ---- outboard / propeller ----
  const propAnchor = new THREE.Group();
  if (h.style === 'raft') {
    // no engine
  } else if (L < 8) {
    const outboard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.55, 0.4), darkMat);
    outboard.position.set(0, H * 0.18, -L * 0.5 - 0.1);
    g.add(outboard);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6), darkMat);
    shaft.position.set(0, -H * 0.12, -L * 0.5 - 0.1);
    g.add(shaft);
    propAnchor.position.set(0, -H * 0.34, -L * 0.5 - 0.1);
  } else {
    propAnchor.position.set(0, -H * 0.45, -L * 0.47);
  }
  const prop = new THREE.Group();
  const bladeMat = m('#b8bfc6', 0.35, 0.85);
  const pr = clamp(L * 0.035, 0.12, 0.9);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(pr * 1.6, 0.04, pr * 0.5), bladeMat);
    b.rotation.z = (i / 4) * Math.PI * 2;
    b.position.set(Math.cos((i / 4) * Math.PI * 2) * pr * 0.5, Math.sin((i / 4) * Math.PI * 2) * pr * 0.5, 0);
    prop.add(b);
  }
  propAnchor.add(prop);
  g.add(propAnchor);

  // ---- navigation lights ----
  const lights = [];
  for (const [s, color] of [[-1, 0xff3b3b], [1, 0x3bff6b]]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.06, W * 0.03), 6, 5),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0 }));
    l.position.set(s * W * 0.46, H * 0.5, L * 0.36);
    g.add(l);
    lights.push(l);
  }
  const mastLight = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.06, W * 0.03), 6, 5),
    new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xfff2c0, emissiveIntensity: 0 }));
  mastLight.position.set(0, H * (h.style === 'raft' ? 0.5 : 1.25), -L * 0.28);
  g.add(mastLight);
  lights.push(mastLight);

  // ---- helm marker ----
  const helm = new THREE.Object3D();
  helm.position.set(def.helm.x, def.helm.y, def.helm.z);
  g.add(helm);

  // ---- wake emitters ----
  const wakeL = new THREE.Object3D(); wakeL.position.set(-W * 0.3, 0, -L * 0.45); g.add(wakeL);
  const wakeR = new THREE.Object3D(); wakeR.position.set(W * 0.3, 0, -L * 0.45); g.add(wakeR);
  const bowSpray = new THREE.Object3D(); bowSpray.position.set(0, -0.1, L * 0.46); g.add(bowSpray);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData = {
    prop, propAnchor, helm, lights, mastLight, wakeL, wakeR, bowSpray, def,
    hullMesh: hull, deckMesh: deck,
  };
  return g;
}

/** Lofted hull: a run of cross-sections from stern to bow. */
function buildHullGeometry(L, W, H, style) {
  const SECTIONS = 12;
  const RING = 9;
  const positions = [];
  const indices = [];
  const colors = [];

  // Per-style beam/deadrise profile.
  const beamAt = (t) => {
    if (style === 'raft') return 1;
    if (style === 'speed') return Math.pow(Math.sin(Math.PI * clamp(t * 0.92 + 0.06, 0, 1)), 0.42);
    if (style === 'factory' || style === 'trawler' || style === 'commercial') {
      return clamp(1 - Math.pow(Math.max(0, t - 0.72) / 0.28, 1.7) * 0.72, 0.2, 1) * (t < 0.08 ? 0.86 : 1);
    }
    return Math.pow(Math.sin(Math.PI * clamp(t * 0.9 + 0.08, 0, 1)), 0.5);
  };
  const keelAt = (t) => {
    if (style === 'raft') return 0;
    // Rocker: deeper amidships, rising at bow and stern.
    return -Math.sin(Math.PI * clamp(t, 0, 1)) * 0.22 - 0.08;
  };

  for (let i = 0; i <= SECTIONS; i++) {
    const t = i / SECTIONS;
    const z = lerp(-L / 2, L / 2, t);
    const beam = beamAt(t) * W / 2;
    const keel = keelAt(t) * H;
    for (let j = 0; j <= RING; j++) {
      const a = (j / RING) * Math.PI;       // 0 = port, PI = starboard, over the bottom
      // Half-ellipse cross section, flattened toward the deck.
      const x = -Math.cos(a) * beam;
      const yy = -Math.sin(a);
      const y = lerp(H * 0.28, keel, Math.pow(Math.abs(yy), style === 'speed' ? 1.35 : 1.0));
      positions.push(x, y, z);
      const shadeF = 0.72 + 0.28 * (1 - Math.abs(yy));
      colors.push(shadeF, shadeF, shadeF);
    }
  }
  for (let i = 0; i < SECTIONS; i++) {
    for (let j = 0; j < RING; j++) {
      const a = i * (RING + 1) + j;
      const b = a + 1;
      const c = (i + 1) * (RING + 1) + j;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  // Cap the transom.
  const sternBase = 0;
  for (let j = 1; j < RING; j++) {
    indices.push(sternBase, sternBase + j + 1, sternBase + j);
  }
  const bowBase = SECTIONS * (RING + 1);
  for (let j = 1; j < RING; j++) {
    indices.push(bowBase, bowBase + j, bowBase + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function shade(hex, mult) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(mult);
  return c.getHexString().padStart(6, '0').replace(/^/, '#');
}
