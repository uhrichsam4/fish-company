import * as THREE from 'three';
import { REGIONS } from '../data/regions.js';
import { fbm2, valueNoise2, clamp, clamp01, lerp, smootherstep, makeRNG } from '../util/math.js';
import { CG, groups } from '../physics/PhysicsWorld.js';

export const WORLD_EXTENT = 1700;     // half-size of the playable square, metres
export const DEEP_FLOOR = -95;        // default open-ocean seabed
const TRENCH_FLOOR = -1500;

/**
 * Single authoritative world height function.
 * Everything — mesh, physics heightfield, ocean depth texture, fish spawning,
 * worker navigation — reads from here so they can never disagree.
 */
export function worldHeight(x, z) {
  let h = DEEP_FLOOR + fbm2(x * 0.0016, z * 0.0016, 3) * 22 - 11;

  for (let i = 0; i < REGIONS.length; i++) {
    const r = REGIONS[i];
    const dx = x - r.x, dz = z - r.z;
    const d0 = Math.hypot(dx, dz);
    if (d0 > r.reach * 1.15) continue;

    if (r.trench) {
      // Trench: a deep bowl instead of an island.
      const t = clamp01(d0 / r.reach);
      const bowl = 1 - smootherstep(t);
      const jag = (fbm2(x * 0.012, z * 0.012, 4) - 0.5) * 140 * bowl;
      h = Math.min(h, lerp(h, TRENCH_FLOOR, bowl) + jag);
      continue;
    }

    // Domain-warp so islands are lobed, not circular. `warp` can be turned
    // down for a region whose silhouette needs to read as a deliberate shape
    // rather than a natural one.
    const warp = r.warp ?? 0.9;
    const wx = x + (fbm2(x * 0.0055 + 11.3, z * 0.0055 - 4.1, 3) - 0.5) * r.radius * warp;
    const wz = z + (fbm2(x * 0.0055 - 7.7, z * 0.0055 + 2.9, 3) - 0.5) * r.radius * warp;
    const d = Math.hypot(wx - r.x, wz - r.z);
    // `star` modulates the effective radius by angle, giving pointed lobes.
    let shapeRadius = r.radius;
    if (r.star) {
      const sa = Math.atan2(wz - r.z, wx - r.x);
      shapeRadius *= 1 + r.star.amp * Math.cos(r.star.points * sa + (r.star.phase || 0));
    }
    const t = d / shapeRadius;

    // -1e9 (not 0) so points beyond the island don't clamp the shelf up to sea level.
    let land = -1e9;
    if (t < 1.0) {
      // Island body: dome + ridges, flattening near the waterline.
      // `flat` keeps a region's surface walkable and plaza-like: the dome
      // stays, everything that makes a hillside interesting is damped.
      const rough = r.flat ? 0.1 : 1;
      const dome = Math.pow(1 - t * t, r.flat ? 0.6 : 1.35);
      const ridge = (fbm2(x * 0.014, z * 0.014, 4) - 0.44) * r.peak * 0.85 * Math.pow(1 - t, 0.55) * rough;
      // Mid-scale relief: gullies and shoulders so hillsides aren't smooth domes.
      const relief = (fbm2(x * 0.038 + 5.1, z * 0.038 - 3.3, 3) - 0.5) * r.peak * 0.34 * Math.pow(1 - t, 0.35) * rough;
      // Erosion channels radiating from the peak.
      const ang = Math.atan2(z - r.z, x - r.x);
      const gully = Math.pow(Math.abs(Math.sin(ang * 5.5 + fbm2(x * 0.01, z * 0.01, 2) * 6)), 2.2);
      const erosion = -gully * r.peak * 0.16 * Math.pow(clamp01(t * 1.3), 1.1) * (1 - t * 0.5) * rough;
      // Terrain is sampled on a ~3 m grid, so any height term finer than
      // ~12 m wavelength aliases into a large-scale beat pattern — that was
      // the field of hard diagonal streaks across one half of every island.
      // Sub-grid detail belongs in the material's normal map, not the mesh.
      const detail = (valueNoise2(x * 0.045, z * 0.045) - 0.5) * 1.5 * (1 - t * 0.5) * rough;
      land = dome * r.peak + ridge + relief + erosion + detail;
      // Beach: a narrow apron with a berm crest, not a long flat ramp. The
      // beach width varies around the island so it isn't a uniform ring.
      const beachStart = 0.90 - fbm2(x * 0.006 + 21, z * 0.006 - 13, 2) * 0.09;
      if (t > beachStart) {
        const bt = clamp01((t - beachStart) / (1 - beachStart));
        land *= smootherstep(1 - bt) * 0.86 + 0.14;
        land += Math.sin(bt * Math.PI) * 0.75;
        // Wind ripples across the dry sand. `bt` spans the beach band, so 46
        // cycles across a ~30 m beach is ~0.65 m per ripple — far below the
        // grid. Keep it to a handful of broad ridges.
        land += Math.sin(bt * 7 + fbm2(x * 0.02, z * 0.02, 2) * 9) * 0.11 * (1 - bt);
      }
    }

    // Underwater shelf sloping from the shore out to the deep.
    const shelfEnd = r.reach / r.radius;
    let shelf = -400;
    if (t >= 0.92 && t < shelfEnd) {
      const s = clamp01((t - 0.92) / (shelfEnd - 0.92));
      const target = r.seabedDepth ?? -40;
      shelf = lerp(1.0, target, Math.pow(s, 1.5));
      shelf += (fbm2(x * 0.03, z * 0.03, 3) - 0.5) * 5.5 * (0.25 + s);
      // Occasional reef bumps and rock outcrops on the shelf.
      const reef = fbm2(x * 0.055 + 31, z * 0.055 - 17, 3);
      if (reef > 0.66) shelf += (reef - 0.66) * 34 * (1 - s * 0.6);
    }

    const contrib = Math.max(land, shelf);
    if (contrib > h) h = contrib;
  }
  return h;
}

/** Steepness 0..1 (0 = flat) — used for material blending and walkability. */
export function worldSlope(x, z, eps = 1.2) {
  const hL = worldHeight(x - eps, z), hR = worldHeight(x + eps, z);
  const hD = worldHeight(x, z - eps), hU = worldHeight(x, z + eps);
  const nx = (hL - hR) / (2 * eps), nz = (hD - hU) / (2 * eps);
  return clamp01(Math.hypot(nx, nz));
}

export function worldNormal(x, z, out = new THREE.Vector3(), eps = 1.0) {
  const hL = worldHeight(x - eps, z), hR = worldHeight(x + eps, z);
  const hD = worldHeight(x, z - eps), hU = worldHeight(x, z + eps);
  out.set(hL - hR, 2 * eps, hD - hU).normalize();
  return out;
}

// ---------------------------------------------------------------- palettes
const BIOME_COLORS = {
  tropical: { sandLow: 0xe6d5a8, sandHigh: 0xd8c48d, grass: 0x6fa84a, rock: 0x8f8a7c, high: 0x9aa88a, wet: 0xb9a678 },
  rocky: { sandLow: 0xc7bda6, sandHigh: 0xa89f8c, grass: 0x6d8a52, rock: 0x77756e, high: 0x8d8b84, wet: 0x8d8577 },
  industrial: { sandLow: 0xb5ada0, sandHigh: 0x9a958c, grass: 0x67794f, rock: 0x6e6d69, high: 0x807f7b, wet: 0x7a746b },
  jungle: { sandLow: 0xf0dcae, sandHigh: 0xe0c893, grass: 0x4f9a38, rock: 0x7d7a63, high: 0x3f7c2e, wet: 0xbfa87b },
  storm: { sandLow: 0x9a9483, sandHigh: 0x807a6b, grass: 0x556b45, rock: 0x5d5f61, high: 0x6b6d6e, wet: 0x6d6659 },
  arctic: { sandLow: 0xdfe8ee, sandHigh: 0xc9d6de, grass: 0xa8bcc4, rock: 0x8b98a1, high: 0xf2f7fa, wet: 0xa9b8c0 },
  station: { sandLow: 0x8a8c8e, sandHigh: 0x76797c, grass: 0x5e6a5a, rock: 0x63666a, high: 0x74787c, wet: 0x686a6c },
  abyss: { sandLow: 0x2a2e34, sandHigh: 0x22262b, grass: 0x2c3a34, rock: 0x1e2126, high: 0x2a2d31, wet: 0x1c1f24 },
};

const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();

/** Vertex colour for a terrain point, blending sand/grass/rock by height+slope. */
function terrainColor(x, z, h, slope, biome, out) {
  const p = BIOME_COLORS[biome] || BIOME_COLORS.tropical;
  if (h < -0.4) {
    // Underwater: seabed sand darkening with depth.
    _c1.setHex(p.wet);
    const t = clamp01((-h) / 30);
    out.copy(_c1).multiplyScalar(lerp(1.0, 0.34, t));
    // Low frequency ONLY. Vertices are ~3 m apart, so anything finer than
    // ~12 m aliases into large hard-edged polygonal blotches. Fine grain is
    // the splat material's job, in the fragment shader.
    out.offsetHSL(0, 0, (valueNoise2(x * 0.028, z * 0.028) - 0.5) * 0.09);
    return out;
  }
  const beach = clamp01((h - -0.4) / 2.4);
  _c1.setHex(p.wet); _c2.setHex(p.sandLow);
  out.copy(_c1).lerp(_c2, beach);
  if (h > 1.6) {
    _c2.setHex(p.sandHigh); _c3.setHex(p.grass);
    const g = clamp01((h - 1.6) / 5.0) * (1 - clamp01(slope / 0.55));
    out.lerp(_c2, clamp01((h - 1.6) / 3.0));
    out.lerp(_c3, g);
  }
  if (slope > 0.42) {
    _c2.setHex(p.rock);
    out.lerp(_c2, clamp01((slope - 0.42) / 0.4));
  }
  if (h > 30) {
    _c2.setHex(p.high);
    out.lerp(_c2, clamp01((h - 30) / 40));
  }
  // Same rule as the seabed: only variation coarser than the vertex spacing
  // belongs in vertex colours.
  const grain = (valueNoise2(x * 0.055 + 4.2, z * 0.055 - 1.7) - 0.5) * 0.09
              + (valueNoise2(x * 0.016, z * 0.016) - 0.5) * 0.13;
  out.offsetHSL(grain * 0.04, 0, grain);
  return out;
}

/**
 * Base spacing of the one global terrain lattice, in metres.
 *
 * Region footprints overlap — Crash reaches 250 m from the origin and Harbour
 * reaches 400 m from (-400, 400), so they share a 250 x 250 m corner, and seven
 * other pairs do the same. Every region samples the same `worldHeight`, so an
 * overlap means two near-identical surfaces fighting for the depth buffer: a
 * field of dark angular streaks with a razor-straight edge along the rect
 * boundary. `terrainOwner` below hands each cell to exactly one region; that
 * only tiles without cracks if every region's vertices land on the same
 * lattice, which is what this constant and the snapping in `gridFor` are for.
 */
export const TERRAIN_CELL = 3.2;

/**
 * Grid a region's terrain occupies, on the shared lattice. Derived from the
 * region alone: every region must be able to work out its neighbours' grids
 * without those neighbours being loaded, and get the same answer they will.
 */
function gridFor(region) {
  // Every region steps at the same spacing. A coarser trench grid was tempting
  // but it puts its cell centres somewhere the island grids have no vertex, and
  // the ownership test then leaves slivers neither region draws.
  const cell = TERRAIN_CELL;
  let segs = clamp(Math.round(region.reach * 2 / cell / 2) * 2, 48, 260);
  const size = segs * cell;
  const x0 = Math.round((region.x - size / 2) / cell) * cell;
  const z0 = Math.round((region.z - size / 2) / cell) * cell;
  return { cell, segs, size, x0, z0, x1: x0 + size, z1: z0 + size };
}

/**
 * Which region should draw the ground at (x, z)?
 *
 * Only regions whose footprint covers the point compete, so a region never
 * loses ground no other region would draw; among those the nearest centre wins.
 * Because every region's cells sit on the same lattice, all of them ask this
 * question about the same points and get the same answer — each cell is claimed
 * exactly once, leaving no seam and no double-draw.
 */
function terrainOwner(x, z, grids) {
  // Snap to the lattice first. Two regions reach the same cell centre by adding
  // different offsets to different origins, and the last-ulp disagreement that
  // leaves is enough to make them pick different winners for one cell.
  const cx = (Math.round(x / TERRAIN_CELL - 0.5) + 0.5) * TERRAIN_CELL;
  const cz = (Math.round(z / TERRAIN_CELL - 0.5) + 0.5) * TERRAIN_CELL;
  let best = -1, bestD = Infinity;
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k];
    if (!g || cx < g.x0 || cx > g.x1 || cz < g.z0 || cz > g.z1) continue;
    const r = REGIONS[k];
    const d = (cx - r.x) * (cx - r.x) + (cz - r.z) * (cz - r.z);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/**
 * Builds one region's terrain: a vertex-coloured mesh plus a Rapier heightfield.
 * Heightfield layout note: Rapier stores heights column-major with (nrows+1)
 * rows, i.e. heights[i + j*(nrows+1)] maps to local (x_i, z_j).
 */
export function buildRegionTerrain(region, phys) {
  const grid = gridFor(region);
  const { cell, segs, size } = grid;
  const n = segs + 1;

  // Footprints of every region that overlaps this one, for the ownership test.
  // Built from static region data, so two regions never disagree about a cell
  // regardless of which of them is streamed in.
  const selfIdx = REGIONS.findIndex((r) => r.id === region.id);
  const grids = REGIONS.map((r, k) => {
    if (k === selfIdx) return grid;
    const g = gridFor(r);
    const clear = g.x0 > grid.x1 || g.x1 < grid.x0 || g.z0 > grid.z1 || g.z1 < grid.z0;
    return clear ? null : g;
  });
  const contested = selfIdx >= 0 && grids.some((g, k) => g && k !== selfIdx);

  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const heights = new Float32Array(n * n);
  const col = new THREE.Color();

  const { x0, z0 } = grid;
  let minH = Infinity, maxH = -Infinity;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const wx = x0 + i * cell, wz = z0 + j * cell;
      const h = worldHeight(wx, wz);
      heights[idx] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      positions[idx * 3] = wx - region.x;
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = wz - region.z;
      // World-space UVs: the splat material tiles by world position, and the
      // ocean's foam lookup wants a stable mapping too.
      uvs[idx * 2] = wx * 0.05;
      uvs[idx * 2 + 1] = wz * 0.05;
    }
  }

  // Normals + colours from the sampled grid (cheaper and smoother than re-sampling).
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const hL = heights[j * n + Math.max(0, i - 1)];
      const hR = heights[j * n + Math.min(n - 1, i + 1)];
      const hD = heights[Math.max(0, j - 1) * n + i];
      const hU = heights[Math.min(n - 1, j + 1) * n + i];
      const nx = hL - hR, ny = 2 * cell, nz = hD - hU;
      const l = Math.hypot(nx, ny, nz) || 1;
      normals[idx * 3] = nx / l; normals[idx * 3 + 1] = ny / l; normals[idx * 3 + 2] = nz / l;
      const slope = 1 - Math.abs(ny / l);
      terrainColor(x0 + i * cell, z0 + j * cell, heights[idx], slope, region.biome, col);
      colors[idx * 3] = col.r; colors[idx * 3 + 1] = col.g; colors[idx * 3 + 2] = col.b;
    }
  }

  // Emit only the cells this region owns. Cells inside an overlapping
  // neighbour's footprint that sit closer to that neighbour are its to draw —
  // without this the two meshes z-fight over identical ground.
  const indices = new Uint32Array(segs * segs * 6);
  let ii = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      if (contested) {
        const cx = x0 + (i + 0.5) * cell, cz = z0 + (j + 0.5) * cell;
        if (terrainOwner(cx, cz, grids) !== selfIdx) continue;
      }
      const a = j * n + i, b = a + 1, c = (j + 1) * n + i, d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices.slice(0, ii), 1));
  geo.computeBoundingSphere();

  // --- physics heightfield ---
  let body = null;
  if (phys) {
    const hf = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) hf[i + j * n] = heights[j * n + i];
    }
    // Collision keeps the full rect even where the mesh yields to a neighbour:
    // the surfaces are identical, so overlapping heightfields agree, and a
    // neighbour that has not streamed in can never leave a hole to fall through.
    body = phys.addBody({
      type: 'fixed',
      position: { x: x0 + size / 2, y: 0, z: z0 + size / 2 },
      shape: {
        kind: 'heightfield', nrows: segs, ncols: segs, heights: hf,
        scale: new THREE.Vector3(size, 1, size),
        friction: 0.95, restitution: 0.02,
        groups: groups(CG.TERRAIN, 0xffff),
      },
      tag: 'terrain',
      userData: { region: region.id },
      events: false,
    });
  }

  return { geometry: geo, body, heights, n, cell, x0, z0, minH, maxH, segs, size };
}

/**
 * Renders the global height function into a DataTexture the ocean shader reads
 * for depth colouring and shoreline foam. Yields between rows to avoid a hitch.
 */
export async function buildHeightTexture(res = 1024, extent = WORLD_EXTENT, onProgress) {
  const data = new Uint8Array(res * res);
  const minH = -140, maxH = 110, range = maxH - minH;
  const step = (extent * 2) / (res - 1);
  const rowsPerChunk = 48;
  for (let j = 0; j < res; j += rowsPerChunk) {
    const jEnd = Math.min(res, j + rowsPerChunk);
    for (let jj = j; jj < jEnd; jj++) {
      const wz = -extent + jj * step;
      for (let i = 0; i < res; i++) {
        const wx = -extent + i * step;
        const h = worldHeight(wx, wz);
        data[jj * res + i] = clamp(Math.round(((h - minH) / range) * 255), 0, 255);
      }
    }
    onProgress?.(jEnd / res);
    await new Promise((r) => setTimeout(r, 0));
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, minH, maxH };
}

/** Coarse open-ocean floor so submarines and deep divers see ground. */
export function buildDeepSeabed(extent = WORLD_EXTENT) {
  const segs = 72;
  const size = extent * 2.4;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = Math.min(worldHeight(x, z), DEEP_FLOOR + 6);
    pos.setY(i, h - 1.2);
    const t = clamp01((-h - 40) / 400);
    col.setHex(0x4a4b45).lerp(_c1.setHex(0x14161a), t);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Scatter positions on walkable land for props. */
export function scatterOnLand(region, count, opts = {}) {
  const rng = makeRNG(opts.seed ?? 1337);
  const out = [];
  const minH = opts.minH ?? 1.2, maxH = opts.maxH ?? 999;
  const maxSlope = opts.maxSlope ?? 0.45;
  const rMin = opts.rMin ?? 0, rMax = opts.rMax ?? region.radius * 0.95;
  let tries = 0;
  while (out.length < count && tries < count * 60) {
    tries++;
    const a = rng() * Math.PI * 2;
    const r = lerp(rMin, rMax, Math.sqrt(rng()));
    const x = region.x + Math.cos(a) * r, z = region.z + Math.sin(a) * r;
    const h = worldHeight(x, z);
    if (h < minH || h > maxH) continue;
    if (worldSlope(x, z) > maxSlope) continue;
    // A region can keep its middle clear -- the lobby needs an open plaza for
    // the start pads, not a palm grove on top of them.
    if (region.clearRadius && Math.hypot(x - region.x, z - region.z) < region.clearRadius) continue;
    if (opts.minSpacing) {
      let ok = true;
      for (const p of out) { if (Math.hypot(p.x - x, p.z - z) < opts.minSpacing) { ok = false; break; } }
      if (!ok) continue;
    }
    out.push({ x, y: h, z, rot: rng() * Math.PI * 2, scale: lerp(opts.scaleMin ?? 0.8, opts.scaleMax ?? 1.2, rng()), rng: rng() });
  }
  return out;
}

/** Scatter positions on the seabed within a depth band. */
export function scatterOnSeabed(region, count, opts = {}) {
  const rng = makeRNG(opts.seed ?? 91);
  const out = [];
  const minD = opts.minDepth ?? 2, maxD = opts.maxDepth ?? 24;
  let tries = 0;
  while (out.length < count && tries < count * 60) {
    tries++;
    const a = rng() * Math.PI * 2;
    const r = lerp(region.radius * 0.85, region.reach * 0.9, Math.sqrt(rng()));
    const x = region.x + Math.cos(a) * r, z = region.z + Math.sin(a) * r;
    const h = worldHeight(x, z);
    const depth = -h;
    if (depth < minD || depth > maxD) continue;
    out.push({ x, y: h, z, rot: rng() * Math.PI * 2, scale: lerp(opts.scaleMin ?? 0.8, opts.scaleMax ?? 1.4, rng()), depth, rng: rng() });
  }
  return out;
}

/** Find a flat-ish spot near a target, for docks/buildings. */
export function findFlatSpot(x, z, searchRadius = 26, opts = {}) {
  let best = null, bestScore = -Infinity;
  const targetH = opts.targetH ?? 2.2;
  for (let i = 0; i < 240; i++) {
    const a = (i / 240) * Math.PI * 2 * 7;
    const r = (i / 240) * searchRadius;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    const h = worldHeight(px, pz);
    if (h < (opts.minH ?? 0.6) || h > (opts.maxH ?? 14)) continue;
    const s = worldSlope(px, pz);
    const score = -s * 10 - Math.abs(h - targetH) - r * 0.02;
    if (score > bestScore) { bestScore = score; best = { x: px, y: h, z: pz }; }
  }
  return best || { x, y: worldHeight(x, z), z };
}

/** Walk outward from an island centre to the waterline along a bearing. */
export function findShoreline(region, angle, opts = {}) {
  const targetH = opts.targetH ?? 0.0;
  let lo = 0, hi = region.reach;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const h = worldHeight(region.x + Math.cos(angle) * mid, region.z + Math.sin(angle) * mid);
    if (h > targetH) lo = mid; else hi = mid;
  }
  const r = (lo + hi) / 2;
  return { x: region.x + Math.cos(angle) * r, z: region.z + Math.sin(angle) * r, r, y: worldHeight(region.x + Math.cos(angle) * r, region.z + Math.sin(angle) * r) };
}
