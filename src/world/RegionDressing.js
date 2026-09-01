import * as THREE from 'three';
import * as Props from './props/index.js';
import { worldHeight, worldSlope, scatterOnLand, scatterOnSeabed, findFlatSpot } from './Terrain.js';
import { makeRNG, lerp, clamp, clamp01, rrange, TAU } from '../util/math.js';

/**
 * Per-region set dressing.
 *
 * `World.decorate()` handles the generic layer (trees, rocks, ground cover).
 * This adds the things that make each place read as ITSELF: the wreck and
 * campfire on Crash Island, the sea stacks and shipwreck at Rocky Isle, the
 * containers and cranes at the harbour, and so on.
 *
 * Everything added here is static and gets swept into the region's batched
 * geometry, so the cost is a handful of draw calls per island.
 */
export function dressRegion(world, state, def, anchors) {
  const fn = DRESSERS[def.id] || DRESSERS[def.biome];
  if (!fn) return;
  const rng = makeRNG(hash(def.id + ':dress'));
  const group = new THREE.Group();
  group.name = `dressing:${def.id}`;
  _harvestGame = world.game;
  _harvestRegion = def.id;
  try {
    fn({ world, state, def, anchors, rng, group, game: world.game });
  } catch (e) {
    console.error(`[Dressing] ${def.id} failed:`, e);
  } finally {
    _harvestGame = null;
    _harvestRegion = null;
  }
  state.group.add(group);
}

// --------------------------------------------------------------------------

function place(group, obj, x, z, opts = {}) {
  if (!obj) return null;
  // Some builders return a descriptor ({ pieces, group, material }) rather than
  // the Object3D itself — buildShellsAndDebris does, and used to take the whole
  // region's dressing down with it.
  if (!obj.isObject3D) obj = obj.group;
  if (!obj?.isObject3D) return null;
  const y = opts.y != null ? opts.y : worldHeight(x, z) + (opts.yOffset || 0);
  obj.position.set(x, y, z);
  if (opts.rot != null) obj.rotation.y = opts.rot;
  if (opts.tilt) obj.rotation.x = opts.tilt;
  if (opts.roll) obj.rotation.z = opts.roll;
  if (opts.scale) obj.scale.setScalar(opts.scale);
  obj.traverse?.((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(obj);
  // Breakable dressing has to stay out of the static batch: batched geometry
  // lives inside a shared mesh and cannot be hidden on its own.
  if (opts.harvest && _harvestGame) {
    obj.userData.noBatch = true;
    _harvestGame.get('harvest')?.register({
      object: obj, kind: opts.harvest, x, z, y,
      radius: opts.harvestRadius ?? 0.7, region: _harvestRegion,
      scale: opts.scale ?? 1,
    });
  }
  return obj;
}

/**
 * Dressing runs as a pile of free functions with no access to the game, and
 * threading it through every dresser to register a crate is not worth the
 * churn. Set for the duration of one region's dressing pass instead.
 */
let _harvestGame = null;
let _harvestRegion = null;

/** Ring of positions around an anchor, on land, avoiding steep ground. */
function ringSpots(cx, cz, radius, count, rng, minH = 0.8) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rng() * 0.6;
    const r = radius * lerp(0.6, 1.25, rng());
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (worldHeight(x, z) < minH) continue;
    if (worldSlope(x, z) > 0.6) continue;
    out.push({ x, z, rot: rng() * TAU });
  }
  return out;
}

const DRESSERS = {
  // ------------------------------------------------------------ Crash Island
  crash({ def, anchors, rng, group }) {
    const a = anchors;
    // A trail of wreckage from the water up the beach to the crash site.
    if (a.wreck && a.shore) {
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const x = lerp(a.shore.x, a.wreck.x, t) + rng.gauss(0, 3.4);
        const z = lerp(a.shore.z, a.wreck.z, t) + rng.gauss(0, 3.4);
        if (worldHeight(x, z) < -0.6) continue;
        const roll = rng();
        const kind = roll < 0.45 ? 'driftwood' : roll < 0.72 ? 'crate' : 'barrel';
        const o = kind === 'driftwood' ? Props.buildDriftwood?.(rng, {})
          : kind === 'crate' ? Props.buildCrate?.(rng, { size: lerp(0.4, 0.8, rng()) })
            : Props.buildBarrel?.(rng, {});
        place(group, o, x, z, { rot: rng() * TAU, tilt: rng.gauss(0, 0.35), harvest: kind });
      }
    }
    // A crude shelter and a supply pile by the fire.
    if (a.campfire) {
      place(group, Props.buildTent?.(rng, {}), a.campfire.x + 3.2, a.campfire.z - 2.4, { rot: 1.1 });
      for (const s of ringSpots(a.campfire.x, a.campfire.z, 3.6, 5, rng)) {
        const isCrate = rng() < 0.5;
        place(group, isCrate ? Props.buildCrate?.(rng, { size: 0.5 }) : Props.buildRopeCoil?.(rng, {}),
          s.x, s.z, { rot: s.rot, harvest: isCrate ? 'crate' : null });
      }
      // Log seats.
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * TAU + 0.4;
        place(group, Props.buildDriftwood?.(rng, { length: 2.2 }),
          a.campfire.x + Math.cos(ang) * 2.4, a.campfire.z + Math.sin(ang) * 2.4,
          { rot: ang + Math.PI / 2, harvest: 'driftwood', harvestRadius: 1.1 });
      }
    }
    // A hand-painted signpost by the dock so the player knows where to go.
    if (a.dockStart) {
      place(group, Props.buildSignpost?.(rng, { labels: ['SHOP', 'FISHING'] }),
        a.dockStart.x - a.side.x * 2.4, a.dockStart.z - a.side.z * 2.4, { rot: def.dockAngle + 1.2 });
    }
    // Shells and small debris along the tideline.
    scatterTideline(def, group, rng, 34, (r) => r() < 0.6
      ? Props.buildShellsAndDebris?.(r, {}) : Props.buildDriftwood?.(r, { length: 1.1 }));
  },

  // ------------------------------------------------------------- Rocky Isle
  rocky({ def, anchors, rng, group }) {
    // Sea stacks offshore — the island's silhouette.
    for (let i = 0; i < 7; i++) {
      const ang = rng() * TAU;
      const r = def.radius * lerp(1.05, 1.5, rng());
      const x = def.x + Math.cos(ang) * r, z = def.z + Math.sin(ang) * r;
      const bed = worldHeight(x, z);
      const depth = -bed;
      if (depth < 1.5 || depth > 18) continue;
      // Stand it on the seabed and make it tall enough to breach convincingly.
      place(group, Props.buildSeaStack?.(rng, { height: depth + lerp(6, 18, rng()) }), x, z,
        { y: bed, rot: rng() * TAU });
    }
    // Cliff chunks along the steeper faces.
    const cliffs = scatterOnLand(def, 24, {
      seed: hash(def.id + 'cliff'), minH: 6, maxSlope: 1.2, minSpacing: 7, rMax: def.radius * 0.95,
      scaleMin: 1.2, scaleMax: 3.2,
    });
    for (const c of cliffs) {
      place(group, Props.buildCliffChunk?.(makeRNG((c.rng * 1e9) | 0), { size: c.scale * 3 }),
        c.x, c.z, { rot: c.rot, scale: c.scale, yOffset: -c.scale * 0.6 });
    }
    // A wrecked hull on the rocks and the fishing gear of whoever left it.
    if (anchors.shore) {
      const ang = def.dockAngle + 2.4;
      const wx = def.x + Math.cos(ang) * def.radius * 1.02;
      const wz = def.z + Math.sin(ang) * def.radius * 1.02;
      place(group, Props.buildWreckedBoat?.(rng, { size: 1.6 }), wx, wz,
        { rot: ang + 0.6, roll: 0.35, scale: 1.5 });
      for (const s of ringSpots(wx, wz, 6, 6, rng, -1)) {
        place(group, Props.buildBarrel?.(rng, {}), s.x, s.z, { rot: s.rot, tilt: rng.gauss(0, 0.4), harvest: 'barrel' });
      }
    }
    scatterTideline(def, group, rng, 26, (r) => Props.buildRock?.(r, { size: lerp(0.4, 1.3, r()), style: 'flat' }));
  },

  // -------------------------------------------------------------- Harbour
  industrial({ def, anchors, rng, group }) {
    const a = anchors;
    if (!a.dock) return;
    // Container yard behind the dock.
    const yard = findFlatSpot(a.shore.x + a.inward.x * 46, a.shore.z + a.inward.z * 46, 28, { targetH: 3 });
    const colors = ['#c0392b', '#2874a6', '#f39c12', '#27ae60', '#7d3c98', '#5d6d7e'];
    for (let i = 0; i < 14; i++) {
      const row = i % 5, col = Math.floor(i / 5);
      const x = yard.x + (row - 2) * 3.1 + rng.gauss(0, 0.25);
      const z = yard.z + col * 7.2 + rng.gauss(0, 0.3);
      if (worldHeight(x, z) < 1) continue;
      const stack = rng() < 0.35 ? 2 : 1;
      for (let k = 0; k < stack; k++) {
        place(group, Props.buildContainer?.(rng, { color: colors[(i + k) % colors.length] }),
          x, z, { yOffset: k * 2.6, rot: (rng() < 0.5 ? 0 : Math.PI / 2) + rng.gauss(0, 0.05) });
      }
    }
    // Cranes on the pier.
    for (let i = 0; i < 2; i++) {
      const t = 0.35 + i * 0.4;
      const cx = lerp(a.dockStart.x, a.dockEnd.x, t) + a.side.x * (a.dock.width * 0.75);
      const cz = lerp(a.dockStart.z, a.dockEnd.z, t) + a.side.z * (a.dock.width * 0.75);
      place(group, Props.buildCrane?.(rng, {}), cx, cz, { y: a.dock.y, rot: def.dockAngle + Math.PI });
    }
    // Warehouse row.
    for (let i = 0; i < 2; i++) {
      const wx = a.shore.x + a.inward.x * (26 + i * 20) - a.side.x * 24;
      const wz = a.shore.z + a.inward.z * (26 + i * 20) - a.side.z * 24;
      const spot = findFlatSpot(wx, wz, 18, { targetH: 3 });
      place(group, Props.buildWarehouse?.(rng, {}), spot.x, spot.z, { rot: def.dockAngle + Math.PI / 2 });
    }
    // Bollards and rope coils along the quay.
    for (let i = 0; i < 8; i++) {
      const t = i / 8;
      const bx = lerp(a.dockStart.x, a.dockEnd.x, t) - a.side.x * (a.dock.width * 0.42);
      const bz = lerp(a.dockStart.z, a.dockEnd.z, t) - a.side.z * (a.dock.width * 0.42);
      place(group, Props.buildRopeCoil?.(rng, {}), bx, bz, { y: a.dock.y + 0.06, rot: rng() * TAU });
    }
    // Fish crates stacked near the sell station.
    if (a.sell) {
      for (const s of ringSpots(a.sell.x, a.sell.z, 4.5, 9, rng)) {
        place(group, Props.buildFishCrate?.(rng, {}), s.x, s.z, { rot: s.rot, harvest: 'crate' });
      }
    }
    // Buoys marking the channel.
    for (let i = 0; i < 6; i++) {
      const d = 40 + i * 26;
      const bx = a.dockEnd.x + a.outward.x * d + a.side.x * (i % 2 ? 14 : -14);
      const bz = a.dockEnd.z + a.outward.z * d + a.side.z * (i % 2 ? 14 : -14);
      if (worldHeight(bx, bz) > -2) continue;
      place(group, Props.buildBuoy?.(rng, {}), bx, bz, { y: 0 });
    }
  },

  // ----------------------------------------------------------- Tropical Wilds
  jungle({ def, anchors, rng, group }) {
    // Dense undergrowth and ferns.
    const ferns = scatterOnLand(def, 90, {
      seed: hash(def.id + 'fern'), minH: 1.4, maxSlope: 0.6, minSpacing: 2.2, rMax: def.radius * 0.96,
    });
    for (const f of ferns) {
      place(group, Props.buildFernPlant?.(makeRNG((f.rng * 1e9) | 0), {}), f.x, f.z,
        { rot: f.rot, scale: f.scale });
    }
    // Reef structures on the shelf.
    const reef = scatterOnSeabed(def, 70, { seed: hash(def.id + 'reef'), minDepth: 1.5, maxDepth: 18, scaleMin: 0.7, scaleMax: 2.2 });
    for (const r of reef) {
      place(group, Props.buildCoral?.(makeRNG((r.rng * 1e9) | 0), {}), r.x, r.z,
        { y: r.y, rot: r.rot, scale: r.scale });
    }
    // An overgrown hut and a lookout on the high ground.
    const high = findFlatSpot(def.x, def.z, def.radius * 0.5, { targetH: def.peak * 0.7, minH: def.peak * 0.4, maxH: def.peak });
    place(group, Props.buildShack?.(rng, { biome: 'jungle', ruined: true }), high.x, high.z, { rot: rng() * TAU });
    place(group, Props.buildAntenna?.(rng, {}), high.x + 6, high.z + 4, {});
    scatterTideline(def, group, rng, 30, (r) => Props.buildShellsAndDebris?.(r, {}));
  },

  // ------------------------------------------------------------ Storm Shelf
  storm({ def, anchors, rng, group }) {
    // Dead trees and blown-down debris.
    const dead = scatterOnLand(def, 40, {
      seed: hash(def.id + 'dead'), minH: 2, maxSlope: 0.7, minSpacing: 5, rMax: def.radius * 0.92,
    });
    for (const d of dead) {
      place(group, Props.buildDeadTree?.(makeRNG((d.rng * 1e9) | 0), {}), d.x, d.z,
        { rot: d.rot, tilt: rng.gauss(0, 0.22), scale: d.scale });
    }
    // Weather station on the peak.
    const peak = findFlatSpot(def.x, def.z, def.radius * 0.35, { targetH: def.peak * 0.85, minH: def.peak * 0.5, maxH: def.peak * 1.1 });
    place(group, Props.buildShack?.(rng, { biome: 'storm' }), peak.x, peak.z, { rot: rng() * TAU });
    place(group, Props.buildAntenna?.(rng, { height: 12 }), peak.x + 4, peak.z - 3, {});
    // Wrecks driven onto the rocks.
    for (let i = 0; i < 3; i++) {
      const ang = rng() * TAU;
      const r = def.radius * lerp(0.98, 1.08, rng());
      const x = def.x + Math.cos(ang) * r, z = def.z + Math.sin(ang) * r;
      place(group, Props.buildWreckedBoat?.(rng, {}), x, z,
        { rot: ang + rng.gauss(0, 1), roll: rng.gauss(0, 0.5), scale: lerp(1.2, 2.2, rng()) });
    }
    scatterTideline(def, group, rng, 40, (r) => r() < 0.5
      ? Props.buildDriftwood?.(r, { length: lerp(1.5, 3.5, r()) }) : Props.buildBarrel?.(r, {}));
  },

  // ------------------------------------------------------------ Frozen Sea
  arctic({ def, anchors, rng, group }) {
    // Pack ice and pressure ridges on the shelf.
    const ice = scatterOnSeabed(def, 30, { seed: hash(def.id + 'ice'), minDepth: 2, maxDepth: 40, scaleMin: 0.8, scaleMax: 2.6 });
    for (const i of ice) {
      place(group, Props.buildIceberg?.(makeRNG((i.rng * 1e9) | 0), { size: i.scale * 4 }),
        i.x, i.z, { y: -0.6, rot: i.rot });
    }
    // A frozen-in hulk.
    const ang = def.dockAngle + 2.9;
    const wx = def.x + Math.cos(ang) * def.radius * 1.2;
    const wz = def.z + Math.sin(ang) * def.radius * 1.2;
    place(group, Props.buildWreckedBoat?.(rng, {}), wx, wz, { y: -0.4, rot: ang, roll: 0.28, scale: 2.4 });
    // Ice-fishing huts on the shore.
    for (const s of ringSpots(anchors.shore?.x ?? def.x, anchors.shore?.z ?? def.z, 16, 4, rng, 0.6)) {
      place(group, Props.buildTent?.(rng, {}), s.x, s.z, { rot: s.rot });
    }
    scatterTideline(def, group, rng, 24, (r) => Props.buildRock?.(r, { size: lerp(0.5, 1.6, r()), style: 'flat', biome: 'arctic' }));
  },

  // --------------------------------------------------------------- The Abyss
  //
  // There is no island here, so there is no shore to dress and no dock to build
  // around. What a player actually sees is the surface they sail to and the
  // trench rim they descend past — DeepSea.js streams the vents and wrecks
  // further down. Everything here hangs off the rim: the shelf where the
  // seabed falls away, and the water directly above it.
  abyss({ def, rng, group }) {
    const rimR = def.reach * 0.86;   // where the bowl meets the open seabed

    // Marker buoys in a wide ring on the surface, so the approach reads as a
    // place someone has been rather than empty water.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + rng() * 0.4;
      const r = rimR * lerp(0.94, 1.06, rng());
      place(group, Props.buildBuoy?.(rng, {}), def.x + Math.cos(a) * r, def.z + Math.sin(a) * r,
        { y: 0, rot: rng() * TAU });
    }

    // Spires and broken slabs along the rim, largest where it is steepest.
    const rim = scatterOnSeabed(def, 46, {
      seed: hash(def.id + 'rim'), minDepth: 40, maxDepth: 260, scaleMin: 1.4, scaleMax: 4.2,
    });
    for (const p of rim) {
      const r = makeRNG((p.rng * 1e9) | 0);
      const tall = r() < 0.45;
      place(group, tall
        ? Props.buildSeaStack?.(r, { height: p.scale * 9, biome: 'abyss' })
        : Props.buildRockCluster?.(r, { size: p.scale * 2.4, biome: 'abyss' }),
      p.x, p.z, { y: p.y, rot: p.rot, tilt: r.gauss(0, 0.13), roll: r.gauss(0, 0.13) });
    }

    // Tube worms and cold-seep growth on the shallower shoulder.
    const growth = scatterOnSeabed(def, 60, {
      seed: hash(def.id + 'growth'), minDepth: 30, maxDepth: 150, scaleMin: 0.6, scaleMax: 1.9,
    });
    for (const p of growth) {
      place(group, Props.buildCoral?.(makeRNG((p.rng * 1e9) | 0), { biome: 'abyss' }),
        p.x, p.z, { y: p.y, rot: p.rot, scale: p.scale });
    }

    // Things that went down here. They sit on the shoulder, not the floor —
    // a wreck two kilometres down is a wreck nobody ever sees.
    for (let i = 0; i < 3; i++) {
      const a = rng() * TAU;
      const r = rimR * lerp(0.55, 0.8, rng());
      const x = def.x + Math.cos(a) * r, z = def.z + Math.sin(a) * r;
      place(group, Props.buildWreckedBoat?.(rng, {}), x, z,
        { y: worldHeight(x, z) + 0.5, rot: a + rng.gauss(0, 0.8), roll: rng.gauss(0, 0.5), scale: lerp(1.6, 3.2, rng()) });
    }

    // Somebody's abandoned survey rig, half over the edge.
    const ra = rng() * TAU;
    const rx = def.x + Math.cos(ra) * rimR * 0.92, rz = def.z + Math.sin(ra) * rimR * 0.92;
    place(group, Props.buildAntenna?.(rng, { height: 14 }), rx, rz, { y: worldHeight(rx, rz), tilt: 0.4 });
    for (let i = 0; i < 5; i++) {
      const bx = rx + rng.gauss(0, 9), bz = rz + rng.gauss(0, 9);
      place(group, Props.buildBarrel?.(rng, {}), bx, bz,
        { y: worldHeight(bx, bz) + 0.3, rot: rng() * TAU, tilt: rng.gauss(0, 0.5) });
    }
  },

  // --------------------------------------------------------- Deep Sea Station
  station({ def, anchors, rng, group }) {
    const a = anchors;
    // The station is a platform of piers, containers and gantries.
    const base = findFlatSpot(def.x, def.z, def.radius * 0.5, { targetH: 4, minH: 0.5, maxH: 18 });
    for (let i = 0; i < 3; i++) {
      place(group, Props.buildWarehouse?.(rng, {}),
        base.x + (i - 1) * 16, base.z + rng.gauss(0, 4), { rot: rng() < 0.5 ? 0 : Math.PI / 2 });
    }
    for (let i = 0; i < 10; i++) {
      place(group, Props.buildContainer?.(rng, { color: ['#5d6d7e', '#c0392b', '#f39c12'][i % 3] }),
        base.x + rng.gauss(0, 18), base.z + rng.gauss(0, 18), { rot: rng() < 0.5 ? 0 : Math.PI / 2 });
    }
    place(group, Props.buildAntenna?.(rng, { height: 18 }), base.x + 12, base.z - 14, {});
    place(group, Props.buildCrane?.(rng, {}), base.x - 14, base.z + 10, { rot: 1.2 });
    if (a.dockEnd) {
      place(group, Props.buildPier?.(rng, { length: 34 }), a.dockEnd.x + a.outward.x * 16,
        a.dockEnd.z + a.outward.z * 16, { y: a.dock.y, rot: -def.dockAngle });
    }
    for (let i = 0; i < 8; i++) {
      const d = 30 + i * 22;
      const bx = a.dockEnd.x + a.outward.x * d + a.side.x * (i % 2 ? 18 : -18);
      const bz = a.dockEnd.z + a.outward.z * d + a.side.z * (i % 2 ? 18 : -18);
      if (worldHeight(bx, bz) > -3) continue;
      place(group, Props.buildBuoy?.(rng, {}), bx, bz, { y: 0 });
    }
  },
};

/** Scatter small props along the waterline ring. */
function scatterTideline(def, group, rng, count, make) {
  for (let i = 0; i < count; i++) {
    const ang = rng() * TAU;
    // Walk outward to the waterline along this bearing.
    let r = def.radius * 0.8;
    for (let k = 0; k < 60; k++) {
      const h = worldHeight(def.x + Math.cos(ang) * r, def.z + Math.sin(ang) * r);
      if (h < 0.15) break;
      r += 1.0;
    }
    r += rng.gauss(0, 2.2) - 1.5;
    const x = def.x + Math.cos(ang) * r, z = def.z + Math.sin(ang) * r;
    const h = worldHeight(x, z);
    if (h < -1.2 || h > 2.6) continue;
    place(group, make(rng), x, z, { rot: rng() * TAU, tilt: rng.gauss(0, 0.2) });
  }
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
