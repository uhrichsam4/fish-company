import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collapses a region's static decoration into a handful of merged draw calls.
 *
 * Islands are built from hundreds of small prop Groups, which is convenient to
 * author and terrible to render — a single decorated island was costing ~400
 * draw calls. Everything tagged static gets baked into merged geometry grouped
 * by material; anything that animates, emits light, or is transparent is left
 * alone so it can still move.
 */
export function batchStatic(root, opts = {}) {
  const minPerBatch = opts.minPerBatch ?? 4;
  const skip = opts.skip || ((o) => false);

  /** @type {Map<string, {material: THREE.Material, geos: THREE.BufferGeometry[], sources: THREE.Mesh[]}>} */
  const groups = new Map();
  const keep = [];

  root.updateMatrixWorld(true);
  /**
   * noBatch has to be inherited.
   *
   * Prop builders return a Group of meshes, and callers set the flag on the
   * group they were handed -- which is the only object they have. Testing only
   * the mesh meant a rock or tree marked "keep me individual" was merged into
   * shared geometry anyway, its original detached from the scene, and every
   * later attempt to hide or move it silently did nothing to what was on
   * screen. That is why broken rocks stayed standing.
   */
  const excluded = (o) => {
    for (let n = o; n && n !== root.parent; n = n.parent) {
      if (n.userData?.dynamic || n.userData?.noBatch) return true;
    }
    return false;
  };

  root.traverse((o) => {
    if (!o.isMesh) return;
    if (excluded(o)) return;
    if (skip(o)) return;
    const mat = o.material;
    if (Array.isArray(mat)) return;                 // multi-material, leave it
    if (mat.transparent && mat.opacity < 0.99) return;
    // NB: emissiveIntensity defaults to 1 on MeshStandardMaterial, so test the
    // emissive COLOUR — testing intensity excluded literally every prop.
    if (mat.emissive && (mat.emissive.r + mat.emissive.g + mat.emissive.b) > 0.02) return;
    if (!o.geometry?.attributes?.position) return;
    if (o.geometry.attributes.position.count > 20000) return;   // already big

    // Group by VISUAL SIGNATURE, not material identity. Prop builders create a
    // fresh MeshStandardMaterial per instance, so keying on uuid produced
    // hundreds of one-member groups and batched nothing.
    // Batch shadow casters separately from non-casters, so a merge can't
    // promote a bush into a shadow caster (or demote a building).
    const key = `${materialSignature(mat)}|s${o.castShadow ? 1 : 0}`;
    let g = groups.get(key);
    if (!g) { g = { material: mat, geos: [], sources: [] }; groups.set(key, g); }
    g.geos.push(o);
    g.sources.push(o);
  });

  let merged = 0, removed = 0;
  for (const [key, g] of groups) {
    if (g.sources.length < minPerBatch) continue;
    // If the group mixes material instances, fold each instance's colour into
    // vertex colours so the merged mesh keeps every prop's tint.
    const mixed = g.sources.some((m) => m.material !== g.material);
    const useVC = !!g.material.vertexColors || mixed;
    const list = [];
    for (const mesh of g.sources) {
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      normalizeAttributes(geo, useVC);
      if (mixed && !g.material.vertexColors && mesh.material.color) {
        const col = geo.attributes.color;
        const c = mesh.material.color;
        for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
        col.needsUpdate = true;
      }
      list.push(geo);
    }
    let out = null;
    try { out = mergeGeometries(list, false); }
    catch (e) { console.warn('[Batcher] merge failed for a material group:', e.message); }
    for (const geo of list) geo.dispose();
    if (!out) continue;

    out.computeBoundingSphere();
    let mat = g.material;
    if (useVC && !mat.vertexColors) {
      mat = mat.clone();
      mat.vertexColors = true;
      mat.color.setRGB(1, 1, 1);
      mat.__owned = true;
    }
    const mesh = new THREE.Mesh(out, mat);
    mesh.castShadow = g.sources[0].castShadow !== false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = `batch:${merged}`;
    mesh.userData.batched = true;
    root.add(mesh);
    merged++;

    for (const src of g.sources) {
      src.parent?.remove(src);
      src.geometry.dispose();
      removed++;
    }
  }

  // Prune Groups that are now empty.
  const empties = [];
  root.traverse((o) => {
    if (o !== root && o.isGroup && o.children.length === 0) empties.push(o);
  });
  for (const e of empties) e.parent?.remove(e);

  return { batches: merged, meshesRemoved: removed };
}

/**
 * Two materials that render identically can share one instance in a batch.
 * Colour is quantised so near-identical prop tints collapse together.
 */
function materialSignature(m) {
  const q = (v) => Math.round(v * 24);
  const c = m.color ? `${q(m.color.r)},${q(m.color.g)},${q(m.color.b)}` : '-';
  return [
    m.type, c, q(m.roughness ?? 1), q(m.metalness ?? 0),
    m.vertexColors ? 1 : 0, m.flatShading ? 1 : 0, m.side,
    m.map?.uuid || '-', m.normalMap?.uuid || '-', m.roughnessMap?.uuid || '-',
    m.transparent ? 1 : 0,
  ].join('|');
}

/**
 * mergeGeometries rejects sets whose attributes differ. Give every geometry
 * the same attribute list (position, normal, uv, and colour when the target
 * material uses vertex colours).
 */
function normalizeAttributes(geo, wantColor) {
  const count = geo.attributes.position.count;
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (wantColor && !geo.attributes.color) {
    const c = new Float32Array(count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!wantColor && geo.attributes.color) geo.deleteAttribute('color');
  // Drop anything else so the attribute sets match exactly.
  for (const name of Object.keys(geo.attributes)) {
    if (!['position', 'normal', 'uv', 'color'].includes(name)) geo.deleteAttribute(name);
  }
  if (geo.morphAttributes) geo.morphAttributes = {};
  if (!geo.index) {
    // mergeGeometries wants a consistent indexed/non-indexed state.
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}
