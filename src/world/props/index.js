import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import {
  buildRock, buildRockCluster, buildCliffChunk, buildIceberg, buildSeaStack,
  buildDriftwood, buildShellsAndDebris, asRng, prep, sharedPropMaterial,
  makeSharedPropMaterial as _mkShared, makeFlatPropMaterial as _mkFlat,
} from './rocks.js';
import {
  buildPalmTree, buildPineTree, buildBush, buildGrassTuft, buildDeadTree,
  buildKelp, buildCoral, buildCactus, buildFernPlant,
} from './vegetation.js';
import {
  buildDock, buildShack, buildCampfire, buildCrate, buildBarrel, buildFishCrate,
  buildSellStation, buildSignpost, buildLampPost, buildBuoy, buildWreckedBoat,
  buildWarehouse, buildPier, buildCrane, buildTent, buildRopeCoil,
  buildFishingRodProp, buildAntenna, buildContainer,
} from './structures.js';

export * from './rocks.js';
export * from './vegetation.js';
export * from './structures.js';

/**
 * Procedural prop library.
 *
 *   import { buildProp, makeSharedPropMaterial } from './world/props/index.js';
 *   const mat = makeSharedPropMaterial();
 *   const palm = buildProp('palmTree', makeRNG(seed), { height: 6, material: mat });
 *
 * Every builder takes (rng, opts) and returns a THREE.Group with
 * `userData.bounds = {radius, height}` — except `grassTuft`, which returns a
 * BufferGeometry ready for an InstancedMesh, and `shellsAndDebris`, which
 * returns `{pieces, group}`.
 */
export const PROP_BUILDERS = {
  // vegetation
  palmTree: buildPalmTree,
  pineTree: buildPineTree,
  bush: buildBush,
  grassTuft: buildGrassTuft,
  deadTree: buildDeadTree,
  kelp: buildKelp,
  coral: buildCoral,
  cactus: buildCactus,
  fernPlant: buildFernPlant,
  // rocks
  rock: buildRock,
  rockCluster: buildRockCluster,
  cliffChunk: buildCliffChunk,
  iceberg: buildIceberg,
  seaStack: buildSeaStack,
  driftwood: buildDriftwood,
  shellsAndDebris: buildShellsAndDebris,
  // structures
  dock: buildDock,
  shack: buildShack,
  campfire: buildCampfire,
  crate: buildCrate,
  barrel: buildBarrel,
  fishCrate: buildFishCrate,
  sellStation: buildSellStation,
  signpost: buildSignpost,
  lampPost: buildLampPost,
  buoy: buildBuoy,
  wreckedBoat: buildWreckedBoat,
  warehouse: buildWarehouse,
  pier: buildPier,
  crane: buildCrane,
  tent: buildTent,
  ropeCoil: buildRopeCoil,
  fishingRodProp: buildFishingRodProp,
  antenna: buildAntenna,
  container: buildContainer,
};

/** All builder names, for editors / scatterers / debug UI. */
export const PROP_NAMES = Object.keys(PROP_BUILDERS);

/**
 * Dispatch by name.
 * @param {string} name key of PROP_BUILDERS
 * @param {Function} rng seeded RNG (makeRNG output, or any ()=>float)
 * @param {object} [opts]
 */
export function buildProp(name, rng, opts = {}) {
  const fn = PROP_BUILDERS[name];
  if (!fn) {
    throw new Error(
      `[props] unknown prop "${name}". Known props: ${PROP_NAMES.join(', ')}`,
    );
  }
  return fn(asRng(rng), opts);
}

/** The workhorse prop material: one draw call per material, colour from vertices. */
export function makeSharedPropMaterial(over = {}) { return _mkShared(over); }
/** Same, but forces hard faceting even on smooth-normal geometry. */
export function makeFlatPropMaterial(over = {}) { return _mkFlat(over); }

/**
 * Flatten one or more Groups into the fewest possible meshes: every mesh that
 * shares a material becomes a single baked BufferGeometry (world transforms
 * applied). Use for static scenery you will never animate.
 *
 * @param {THREE.Object3D|THREE.Object3D[]} groups
 * @returns {THREE.Group} group of merged meshes; `userData.parts` lists
 *          {material, geometry, sourceCount} and `userData.tris` the total.
 */
export function mergePropToInstanced(groups) {
  const list = Array.isArray(groups) ? groups : [groups];
  const buckets = new Map();
  const anchors = [];
  for (const root of list) {
    if (!root) continue;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    root.traverse((o) => {
      if (o.isInstancedMesh) {
        // bake every instance
        const m = new THREE.Matrix4();
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m);
          const world = new THREE.Matrix4().multiplyMatrices(o.matrixWorld, m).premultiply(inv);
          const g = prep(o.geometry.clone());
          g.applyMatrix4(world);
          push(o.material, g);
        }
        return;
      }
      if (!o.isMesh || !o.geometry) return;
      const g = prep(o.geometry.clone());
      g.applyMatrix4(new THREE.Matrix4().copy(o.matrixWorld).premultiply(inv));
      push(o.material, g);
    });
    for (const k of Object.keys(root.userData || {})) {
      const v = root.userData[k];
      if (v && v.isObject3D) anchors.push([k, v]);
    }
  }
  function push(material, geo) {
    const mats = Array.isArray(material) ? material : [material];
    const mat = mats[0] || sharedPropMaterial();
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat).push(geo);
  }

  const out = new THREE.Group();
  out.name = 'mergedProps';
  const parts = [];
  let tris = 0;
  for (const [mat, geos] of buckets) {
    const merged = geos.length === 1 ? geos[0] : (mergeGeometries(geos, false) || geos[0]);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    out.add(mesh);
    tris += merged.attributes.position.count / 3;
    parts.push({ material: mat, geometry: merged, sourceCount: geos.length });
  }
  for (const [k, v] of anchors) {
    const a = new THREE.Object3D();
    a.position.copy(v.getWorldPosition(new THREE.Vector3()));
    out.add(a);
    out.userData[k] = a;
  }
  out.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(out);
  const size = b.getSize(new THREE.Vector3());
  out.userData.parts = parts;
  out.userData.tris = Math.round(tris);
  out.userData.bounds = {
    radius: Math.max(size.x, size.z) * 0.5, height: size.y, min: b.min.clone(), max: b.max.clone(),
  };
  return out;
}
