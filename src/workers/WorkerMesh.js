import * as THREE from 'three';
import { makeRNG, lerp, clamp } from '../util/math.js';

/**
 * Procedural stylized worker characters. Every worker is a randomized
 * combination of body proportions, clothing and accessories so a crowd of
 * employees never looks like clones.
 *
 * The rig is a simple hierarchy (no skinning) — a hips root with a torso,
 * head, two arms and two legs — animated by rotating the joints. Cheap enough
 * to run dozens of them.
 */

const SKIN_TONES = [0xf1c9a5, 0xe0aa7e, 0xc98d5f, 0xa66b41, 0x7d4b2c, 0x5c3520, 0xf7dcc0, 0xd8a06e];
const HAIR_COLORS = [0x2b2118, 0x4a3423, 0x6d4a2a, 0x9c6b35, 0xc9a34e, 0x8a8a8a, 0xd8d3c8, 0x3a2f45, 0x7a2f2f];
const JACKET_COLORS = [0xd8541f, 0xe8a020, 0x2f6fb5, 0x2b8f6a, 0x8f3f3f, 0x3b4a58, 0x6b5b8f, 0xb0b7bd, 0x1f2a33, 0xc9c2a8];
const PANT_COLORS = [0x35414d, 0x2b2f36, 0x4a4034, 0x5a5f66, 0x2f3b2f, 0x3d3346];
const HAT_COLORS = [0xe8b023, 0xd8541f, 0x2f6fb5, 0x2b2f36, 0xb0b7bd, 0x8f3f3f];
const BOOT_COLORS = [0x2b2118, 0x3a3a3a, 0x4a3423, 0x1f2429];

const _geoCache = new Map();
function cached(key, make) {
  if (!_geoCache.has(key)) _geoCache.set(key, make());
  return _geoCache.get(key);
}

const _matCache = new Map();
function pmat(color, rough = 0.9, metal = 0.02) {
  const key = `${color}:${rough}:${metal}`;
  if (!_matCache.has(key)) {
    _matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  }
  return _matCache.get(key);
}

/**
 * @param {number} seed
 * @param {object} opts {role, level}
 * @returns {THREE.Group} with userData.rig = {hips, torso, head, armL, armR, legL, legR, ...}
 */
export function buildWorkerMesh(seed, opts = {}) {
  const rng = makeRNG(seed >>> 0 || 1);
  const g = new THREE.Group();
  g.name = 'worker';

  // ---- randomized proportions ----
  const height = lerp(0.9, 1.12, rng());       // overall scale multiplier
  const bulk = lerp(0.82, 1.24, rng());        // torso/limb thickness
  const legLen = lerp(0.40, 0.50, rng());
  const armLen = lerp(0.36, 0.45, rng());
  const headSize = lerp(0.115, 0.145, rng());

  const skin = pmat(SKIN_TONES[(rng() * SKIN_TONES.length) | 0], 0.92, 0);
  const jacketColor = JACKET_COLORS[(rng() * JACKET_COLORS.length) | 0];
  const jacket = pmat(jacketColor, 0.94, 0);
  const shirt = pmat(shade(jacketColor, rng() < 0.5 ? 0.7 : 1.25), 0.95, 0);
  const pants = pmat(PANT_COLORS[(rng() * PANT_COLORS.length) | 0], 0.95, 0);
  const boots = pmat(BOOT_COLORS[(rng() * BOOT_COLORS.length) | 0], 0.8, 0.05);
  const hairMat = pmat(HAIR_COLORS[(rng() * HAIR_COLORS.length) | 0], 0.96, 0);

  // ---- hips root ----
  const hips = new THREE.Group();
  hips.position.y = legLen + 0.06;
  g.add(hips);

  // ---- torso ----
  const torso = new THREE.Group();
  hips.add(torso);
  const chestW = 0.30 * bulk, chestD = 0.17 * bulk, chestH = 0.40;
  const chest = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), jacket);
  chest.scale.set(chestW, chestH, chestD);
  chest.position.y = chestH / 2;
  torso.add(chest);
  // Slight taper: a smaller box at the waist reads as a torso, not a fridge.
  const waist = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), pants);
  waist.scale.set(chestW * 0.88, 0.1, chestD * 0.94);
  waist.position.y = 0.02;
  torso.add(waist);

  // Open jacket front panel in the shirt colour.
  if (rng() < 0.65) {
    const front = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), shirt);
    front.scale.set(chestW * 0.42, chestH * 0.82, 0.02);
    front.position.set(0, chestH * 0.5, chestD / 2 + 0.005);
    torso.add(front);
  }
  // Life jacket.
  if (rng() < 0.45) {
    const lj = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), pmat(0xf5a017, 0.9, 0));
    lj.scale.set(chestW * 1.1, chestH * 0.62, chestD * 1.25);
    lj.position.y = chestH * 0.58;
    torso.add(lj);
    const strap = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), pmat(0x2b2f36, 0.9, 0));
    strap.scale.set(chestW * 1.14, 0.022, chestD * 1.28);
    strap.position.y = chestH * 0.45;
    torso.add(strap);
  }

  // ---- head ----
  const neck = new THREE.Mesh(cached('neck', () => new THREE.CylinderGeometry(0.04, 0.045, 0.05, 6)), skin);
  neck.position.y = chestH + 0.02;
  torso.add(neck);

  const head = new THREE.Group();
  head.position.y = chestH + 0.05 + headSize * 0.5;
  torso.add(head);
  const skull = new THREE.Mesh(cached('skull', () => new THREE.BoxGeometry(1, 1, 1)), skin);
  skull.scale.set(headSize * 1.5, headSize * 1.75, headSize * 1.45);
  head.add(skull);
  // Eyes.
  const eyeGeo = cached('eye', () => new THREE.SphereGeometry(0.5, 6, 5));
  const eyeMat = pmat(0x141414, 0.3, 0);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.scale.setScalar(headSize * 0.14);
    e.position.set(s * headSize * 0.34, headSize * 0.1, headSize * 0.74);
    head.add(e);
  }
  // Nose.
  const nose = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), skin);
  nose.scale.set(headSize * 0.2, headSize * 0.22, headSize * 0.2);
  nose.position.set(0, headSize * 0.0, headSize * 0.78);
  head.add(nose);

  // Hair / hat / beard.
  const hatRoll = rng();
  if (hatRoll < 0.34) {
    const hat = new THREE.Group();
    const brim = new THREE.Mesh(cached('brim', () => new THREE.CylinderGeometry(1, 1, 1, 12)), pmat(HAT_COLORS[(rng() * HAT_COLORS.length) | 0], 0.9, 0));
    brim.scale.set(headSize * 1.15, headSize * 0.08, headSize * 1.15);
    hat.add(brim);
    const crown = new THREE.Mesh(cached('brim', () => new THREE.CylinderGeometry(1, 1, 1, 12)), brim.material);
    crown.scale.set(headSize * 0.82, headSize * 0.7, headSize * 0.82);
    crown.position.y = headSize * 0.36;
    hat.add(crown);
    hat.position.y = headSize * 0.86;
    head.add(hat);
  } else if (hatRoll < 0.55) {
    // Beanie.
    const beanie = new THREE.Mesh(cached('beanie', () => new THREE.SphereGeometry(0.5, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62)),
      pmat(HAT_COLORS[(rng() * HAT_COLORS.length) | 0], 0.96, 0));
    beanie.scale.setScalar(headSize * 1.72);
    beanie.position.y = headSize * 0.12;
    head.add(beanie);
  } else {
    const hair = new THREE.Mesh(cached('hair', () => new THREE.BoxGeometry(1, 1, 1)), hairMat);
    hair.scale.set(headSize * 1.56, headSize * 0.6, headSize * 1.52);
    hair.position.y = headSize * 0.62;
    head.add(hair);
    if (rng() < 0.4) {
      const back = new THREE.Mesh(cached('hair', () => new THREE.BoxGeometry(1, 1, 1)), hairMat);
      back.scale.set(headSize * 1.5, headSize * 0.9, headSize * 0.5);
      back.position.set(0, headSize * 0.1, -headSize * 0.62);
      head.add(back);
    }
  }
  if (rng() < 0.35) {
    const beard = new THREE.Mesh(cached('hair', () => new THREE.BoxGeometry(1, 1, 1)), hairMat);
    beard.scale.set(headSize * 1.2, headSize * 0.6, headSize * 0.7);
    beard.position.set(0, -headSize * 0.6, headSize * 0.5);
    head.add(beard);
  }

  // ---- arms ----
  const arms = {};
  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? -1 : 1;
    const shoulder = new THREE.Group();
    shoulder.position.set(sgn * (chestW / 2 + 0.03), chestH * 0.9, 0);
    torso.add(shoulder);

    const upper = new THREE.Mesh(cached('limb', () => makeLimbGeo()), jacket);
    upper.scale.set(0.055 * bulk, armLen * 0.5, 0.055 * bulk);
    upper.position.y = -armLen * 0.25;
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -armLen * 0.5;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(cached('limb', () => makeLimbGeo()), rng() < 0.5 ? jacket : skin);
    fore.scale.set(0.048 * bulk, armLen * 0.5, 0.048 * bulk);
    fore.position.y = -armLen * 0.25;
    elbow.add(fore);

    const hand = new THREE.Group();
    hand.position.y = -armLen * 0.5;
    elbow.add(hand);
    const palm = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), skin);
    palm.scale.set(0.055, 0.07, 0.045);
    hand.add(palm);

    arms[side] = { shoulder, elbow, hand, upper, fore };
  }

  // ---- legs ----
  const legs = {};
  for (const side of ['L', 'R']) {
    const sgn = side === 'L' ? -1 : 1;
    const hip = new THREE.Group();
    hip.position.set(sgn * 0.075 * bulk, 0, 0);
    hips.add(hip);

    const thigh = new THREE.Mesh(cached('limb', () => makeLimbGeo()), pants);
    thigh.scale.set(0.068 * bulk, legLen * 0.5, 0.068 * bulk);
    thigh.position.y = -legLen * 0.25;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -legLen * 0.5;
    hip.add(knee);
    const shin = new THREE.Mesh(cached('limb', () => makeLimbGeo()), pants);
    shin.scale.set(0.058 * bulk, legLen * 0.5, 0.058 * bulk);
    shin.position.y = -legLen * 0.25;
    knee.add(shin);

    const foot = new THREE.Mesh(cached('chest', () => new THREE.BoxGeometry(1, 1, 1)), boots);
    foot.scale.set(0.085, 0.06, 0.15);
    foot.position.set(0, -legLen * 0.5 - 0.02, 0.03);
    knee.add(foot);

    legs[side] = { hip, knee, thigh, shin, foot };
  }

  // ---- held item socket ----
  const itemSocket = new THREE.Object3D();
  arms.R.hand.add(itemSocket);

  g.scale.setScalar(height * 1.72);   // ~1.7 m tall at height=1
  g.userData.rig = { hips, torso, head, arms, legs, itemSocket, chestH, legLen, armLen };
  g.userData.seed = seed;
  g.userData.height = height * 1.72;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  return g;
}

/** Tapered capsule-ish limb: cheaper than CapsuleGeometry and reads fine. */
function makeLimbGeo() {
  const g = new THREE.CylinderGeometry(0.9, 1.0, 2, 6, 1);
  // Centre so the limb hangs from y=0 downward once scaled by half-length.
  return g;
}

/** Simple procedural tool the worker holds. */
export function buildWorkerTool(kind) {
  const g = new THREE.Group();
  if (kind === 'rod') {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.014, 1.5, 5), pmat(0x4a3a28, 0.9));
    shaft.rotation.x = Math.PI / 2.4;
    shaft.position.set(0, 0.3, 0.35);
    g.add(shaft);
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 8), pmat(0xb8bfc6, 0.4, 0.7));
    reel.rotation.z = Math.PI / 2;
    reel.position.set(0.03, -0.06, -0.06);
    g.add(reel);
    const tip = new THREE.Object3D();
    tip.position.set(0, 0.92, 1.14);
    g.add(tip);
    g.userData.tip = tip;
  } else if (kind === 'harpoon') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.42), pmat(0x33393f, 0.5, 0.6));
    body.position.z = 0.16;
    g.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.5, 6), pmat(0xc3cad1, 0.3, 0.9));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 0.5;
    g.add(barrel);
    const tip = new THREE.Object3D();
    tip.position.set(0, 0, 0.78);
    g.add(tip);
    g.userData.tip = tip;
  } else if (kind === 'crate') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.32), pmat(0x8a6a44, 0.94));
    box.position.set(0, -0.1, 0.28);
    g.add(box);
  } else if (kind === 'wrench') {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 0.05), pmat(0xb0b7bd, 0.35, 0.85));
    w.position.set(0, -0.1, 0.06);
    g.add(w);
  } else if (kind === 'knife') {
    const k = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.22, 0.04), pmat(0xdde3e8, 0.2, 0.9));
    k.position.set(0, -0.1, 0.05);
    g.add(k);
  } else if (kind === 'clipboard') {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.012), pmat(0xd8c9a0, 0.95));
    c.position.set(0, -0.12, 0.09);
    c.rotation.x = 0.5;
    g.add(c);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
  return g;
}

export function disposeWorkerMesh(g) {
  // Geometries and materials are shared/cached — only drop the graph.
  g.traverse((o) => { if (o.isMesh) o.geometry = o.geometry; });
}

function shade(hex, mult) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(mult);
  return c.getHex();
}

export function clearWorkerMeshCaches() {
  for (const g of _geoCache.values()) g.dispose?.();
  _geoCache.clear();
  for (const m of _matCache.values()) m.dispose?.();
  _matCache.clear();
}
