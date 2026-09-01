import * as THREE from 'three';
import { REGIONS, REGION_BY_ID, regionAt } from '../data/regions.js';
import {
  buildRegionTerrain, buildHeightTexture, buildDeepSeabed, worldHeight, worldSlope,
  worldNormal, WORLD_EXTENT, scatterOnLand, scatterOnSeabed, findShoreline, findFlatSpot,
} from './Terrain.js';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, damp, makeRNG } from '../util/math.js';
import { setStatus } from '../core/Game.js';
import * as Props from './props/index.js';
import { batchStatic } from './StaticBatcher.js';
import { dressRegion } from './RegionDressing.js';
import { createTerrainMaterial } from './TerrainMaterial.js';

/**
 * Owns terrain, seabed, region streaming and static decoration.
 * Regions build their heavy content lazily the first time the player
 * gets within `activateRadius`.
 */
export class World {
  constructor(game) {
    this.game = game;
    this.name = 'world';
    this.order = 10;
    /** @type {Map<string, object>} */
    this.regions = new Map();
    this.activeRegion = null;
    this.props = Props;
    this.terrainMaterial = null;
    this.activateRadius = 620;
    this.deactivateRadius = 900;
    this._checkTimer = 0;
    this.anchors = new Map();    // region -> {dock, shop, sell, spawn, ...}
    this.sellZones = [];
    this.interactables = [];
  }

  async init(game) {

    this.terrainMaterial = createTerrainMaterial(game.assets, { scale: 0.34, detail: 0.85, normalStrength: 0.9 });
    this.propMaterial = this.props?.makeSharedPropMaterial?.()
      || new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.03 });
    this.flatPropMaterial = this.props?.makeFlatPropMaterial?.()
      || new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.03, flatShading: true });

    this.root = new THREE.Group();
    this.root.name = 'world';
    game.scene.add(this.root);

    setStatus('sculpting the ocean floor…');
    const { texture, minH, maxH } = await buildHeightTexture(1536, WORLD_EXTENT, (p) => {
      setStatus(`sculpting the ocean floor… ${Math.round(p * 100)}%`);
    });
    this.heightTexture = texture;
    const ocean = game.get('ocean');
    if (ocean) ocean.setHeightMap(texture, minH, maxH, WORLD_EXTENT);

    setStatus('placing the deep seabed…');
    const seabedGeo = buildDeepSeabed(WORLD_EXTENT);
    this.seabed = new THREE.Mesh(seabedGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1.0, metalness: 0, fog: true,
    }));
    this.seabed.receiveShadow = false;
    this.seabed.name = 'deep-seabed';
    this.root.add(this.seabed);

    // Build the starting region eagerly so spawn is instant.
    bus.on('interact:pickupRod', () => this.pickUpStarterRod());

    setStatus('raising Crash Island…');
    await this.activateRegion('crash');
    return this;
  }

  /** Starter-rod pickup: removes the world prop and equips the rod. */
  pickUpStarterRod() {
    const s = this.regions.get('crash');
    if (s?.rodProp) { s.group.remove(s.rodProp); s.rodProp = null; }
    if (s?.rodHalo) { s.group.remove(s.rodHalo); s.rodHalo.geometry.dispose(); s.rodHalo.material.dispose(); s.rodHalo = null; }
    this.interactables = this.interactables.filter((i) => i.kind !== 'pickupRod');
    const inv = this.game.get('inventory');
    inv?.acquire('rod_stick');
    inv?.equip('rod_stick');
    inv?.setHotbarIndex(0);
    this.game.audio.play('pickup', { volume: 0.7 });
    bus.emit('toast', { text: 'Picked up a <b>Bent Stick</b>. It is technically a fishing rod.', kind: 'success', duration: 5000 });
    bus.emit('quest:flag', { flag: 'picked_rod' });
  }

  regionState(id) {
    let s = this.regions.get(id);
    if (!s) {
      s = { id, def: REGION_BY_ID[id], active: false, built: false, group: null, terrain: null, bodies: [] };
      this.regions.set(id, s);
    }
    return s;
  }

  async activateRegion(id) {
    const s = this.regionState(id);
    if (s.active) return s;
    const def = s.def;
    if (!def) { console.warn('[World] unknown region', id); return null; }

    s.group = new THREE.Group();
    s.group.name = `region:${id}`;
    this.root.add(s.group);

    const t = buildRegionTerrain(def, this.game.physics);
    s.terrain = t;
    const mesh = new THREE.Mesh(t.geometry, this.terrainMaterial);
    mesh.position.set(def.x, 0, def.z);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = `terrain:${id}`;
    s.group.add(mesh);
    s.terrainMesh = mesh;
    if (t.body) s.bodies.push(t.body);

    this.buildAnchors(def);
    await this.decorate(s);

    // Collapse the island's static decoration into a few draw calls. Skip the
    // terrain (already one mesh) and anything a system needs to move later.
    const before = countMeshes(s.group);
    const res = batchStatic(s.group, {
      minPerBatch: 3,
      skip: (o) => o === mesh || o.name?.startsWith('terrain')
        || o.userData?.animated || o.parent?.userData?.animated,
    });
    if (res.batches) {
      console.info(`[World] ${id}: batched ${res.meshesRemoved} meshes into ${res.batches} draws (was ${before})`);
    }

    s.active = true;
    s.built = true;
    bus.emit('region:activated', def);
    return s;
  }

  deactivateRegion(id) {
    const s = this.regions.get(id);
    if (!s || !s.active || s.def.isHome || id === 'crash') return;
    for (const b of s.bodies) this.game.physics.remove(b);
    s.bodies.length = 0;
    disposeGroup(s.group);
    this.root.remove(s.group);
    s.group = null; s.terrain = null; s.active = false;
    this.interactables = this.interactables.filter((i) => i.region !== id);
    this.sellZones = this.sellZones.filter((z) => z.region !== id);
    bus.emit('region:deactivated', s.def);
  }

  /** Compute canonical points of interest for a region (dock, shop, spawn…). */
  buildAnchors(def) {
    if (this.anchors.has(def.id)) return this.anchors.get(def.id);
    const a = {};
    if (def.trench) {
      a.spawn = { x: def.x, y: 3, z: def.z };
      this.anchors.set(def.id, a);
      return a;
    }
    const shore = findShoreline(def, def.dockAngle, { targetH: 0.35 });
    a.shore = shore;
    // Dock runs from the shoreline out to ~2.5 m of water.
    const outward = new THREE.Vector2(Math.cos(def.dockAngle), Math.sin(def.dockAngle));
    let dockLen = 14;
    for (let d = 6; d < 60; d += 1.5) {
      const h = worldHeight(shore.x + outward.x * d, shore.z + outward.y * d);
      if (h < -2.6) { dockLen = d; break; }
      dockLen = d;
    }
    a.dock = {
      x: shore.x + outward.x * (dockLen * 0.5),
      z: shore.z + outward.y * (dockLen * 0.5),
      y: 1.8, angle: def.dockAngle, length: clamp(dockLen, 10, 46), width: def.hasHarbor ? 7 : 4.2,
    };
    a.dockEnd = { x: shore.x + outward.x * dockLen, y: 1.8, z: shore.z + outward.y * dockLen };
    a.dockStart = { x: shore.x - outward.x * 2, y: 1.8, z: shore.z - outward.y * 2 };

    // Shop and sell station sit back from the shore, slightly to either side.
    const inward = { x: -outward.x, z: -outward.y };
    const side = { x: -outward.y, z: outward.x };
    a.shop = findFlatSpot(shore.x + inward.x * 26 + side.x * 13, shore.z + inward.z * 26 + side.z * 13, 20, { targetH: 3.0 });
    a.sell = findFlatSpot(shore.x + inward.x * 13 - side.x * 9, shore.z + inward.z * 13 - side.z * 9, 14, { targetH: 2.2 });
    a.spawn = findFlatSpot(shore.x + inward.x * 9 + side.x * 4, shore.z + inward.z * 9 + side.z * 4, 12, { targetH: 2.0 });
    a.campfire = findFlatSpot(shore.x + inward.x * 20 - side.x * 16, shore.z + inward.z * 20 - side.z * 16, 16, { targetH: 2.6 });
    a.wreck = findFlatSpot(shore.x + inward.x * 5 - side.x * 20, shore.z + inward.z * 5 - side.z * 20, 14, { targetH: 1.2, minH: 0.2, maxH: 3.5 });
    a.hire = findFlatSpot(shore.x + inward.x * 34 - side.x * 6, shore.z + inward.z * 34 - side.z * 6, 20, { targetH: 3.4 });
    a.outward = { x: outward.x, z: outward.y };
    a.inward = inward;
    a.side = side;
    this.anchors.set(def.id, a);
    return a;
  }

  getAnchors(id) { return this.anchors.get(id) || this.buildAnchors(REGION_BY_ID[id]); }

  /** Populate a region with vegetation, rocks and structures. */
  async decorate(s) {
    const def = s.def;
    const P = this.props;
    const rng = makeRNG(hashStr(def.id));
    const group = s.group;
    const biome = def.biome;

    if (def.trench) { await this.decorateTrench(s, rng); return; }

    // ---- vegetation ----
    const treeCount = { tropical: 74, jungle: 128, rocky: 34, industrial: 20, storm: 30, arctic: 26, station: 4, abyss: 0 }[biome] ?? 30;
    const treeSpots = scatterOnLand(def, treeCount, {
      seed: hashStr(def.id + 'trees'), minH: 2.0, maxH: def.peak * 0.82,
      maxSlope: 0.5, minSpacing: 6.5, rMax: def.radius * 0.92,
    });
    const treeGroup = new THREE.Group();
    for (const sp of treeSpots) {
      let tree = null;
      const trng = makeRNG((sp.rng * 1e9) | 0);
      if (P) {
        if (biome === 'arctic' || biome === 'rocky') tree = P.buildPineTree?.(trng, { height: lerp(5, 11, sp.rng) });
        else if (biome === 'storm') tree = trng() < 0.5 ? P.buildDeadTree?.(trng, {}) : P.buildPineTree?.(trng, {});
        else if (biome === 'industrial') tree = P.buildPineTree?.(trng, { height: lerp(4, 8, sp.rng) });
        else tree = P.buildPalmTree?.(trng, { height: lerp(5.5, 11, sp.rng) });
      }
      if (!tree) tree = fallbackTree(trng, biome);
      tree.position.set(sp.x, sp.y - 0.25, sp.z);
      tree.rotation.y = sp.rot;
      tree.scale.setScalar(sp.scale);
      setShadows(tree);
      treeGroup.add(tree);
    }
    group.add(treeGroup);

    // ---- bushes / ground cover ----
    const bushSpots = scatterOnLand(def, treeCount * 2.1, {
      seed: hashStr(def.id + 'bush'), minH: 1.1, maxSlope: 0.66, minSpacing: 2.4, rMax: def.radius * 1.0,
    });
    for (const sp of bushSpots) {
      const brng = makeRNG((sp.rng * 1e9) | 0);
      let b = P?.buildBush?.(brng, { biome });
      if (!b) { b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0), this.flatPropMaterial); }
      b.position.set(sp.x, sp.y - 0.15, sp.z);
      b.rotation.y = sp.rot;
      b.scale.setScalar(sp.scale * 0.9);
      setShadows(b, false);
      group.add(b);
    }

    // ---- rocks ----
    // Rocks: mostly small boulders. `size` and `scale` multiply, so both are
    // kept modest — the first pass produced 7 m grey monoliths all over the
    // island.
    const rockSpots = scatterOnLand(def, 82, {
      seed: hashStr(def.id + 'rocks'), minH: -1.6, maxSlope: 1.0, minSpacing: 3.2, rMax: def.radius * 1.16,
      scaleMin: 0.32, scaleMax: 1.15,
    });
    for (const sp of rockSpots) {
      const rrng = makeRNG((sp.rng * 1e9) | 0);
      // Style mix: mostly boulders, some flat slabs, rare small pillars.
      const roll = rrng();
      const style = roll < 0.62 ? 'boulder' : roll < 0.86 ? 'flat' : roll < 0.96 ? 'shard' : 'pillar';
      const size = style === 'pillar' ? lerp(0.5, 1.1, rrng()) : lerp(0.35, 1.5, rrng());
      let r = P?.buildRock?.(rrng, { size, style, biome });
      if (!r) r = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), this.flatPropMaterial);
      r.position.set(sp.x, sp.y - 0.22 * sp.scale * size, sp.z);
      r.rotation.set(rrng() * 0.35, sp.rot, rrng() * 0.35);
      r.scale.setScalar(sp.scale);
      // Small rocks don't earn a shadow-map slot.
      if (sp.scale * size < 0.9) r.userData.noCast = true;
      // Break up the uniform grey a little per instance.
      const tint = 0.82 + rrng() * 0.34;
      r.traverse?.((o) => {
        if (o.isMesh && o.material?.color) { o.material = o.material.clone(); o.material.color.multiplyScalar(tint); }
      });
      setShadows(r, !r.userData.noCast);
      group.add(r);
      // Anything that stands proud of the ground blocks movement. This used
      // to gate on sp.scale * size -- the *input* to the builder rather than
      // what it actually produced -- which let a 2.1 m shard and a 1 m boulder
      // through as walk-through scenery. userData.bounds is the real rendered
      // extent, so use that. Flat slabs stay walkable on purpose.
      const b = r.userData?.bounds;
      const wr = (b ? b.radius : size * 0.6) * sp.scale;
      const wh = (b ? b.height : size) * sp.scale;
      if (wh >= 0.5) {
        // A cylinder, not a ball: a ball sized to the width leaves the base of
        // a tall rock uncovered, and one sized to the height floats an
        // invisible bump over a wide flat one.
        s.bodies.push(this.game.physics.addBody({
          type: 'fixed',
          position: { x: sp.x, y: r.position.y + wh * 0.5, z: sp.z },
          shape: { kind: 'cylinder', hh: wh * 0.5, r: Math.max(0.2, wr * 0.8) },
          tag: 'rock', events: false,
        }));
      }
    }

    // A handful of deliberately large landmark rocks, placed on high ground so
    // they read as part of the island rather than litter.
    const boulders = scatterOnLand(def, biome === 'rocky' ? 9 : 5, {
      seed: hashStr(def.id + 'boulders'), minH: 3.5, maxSlope: 0.55, minSpacing: 22, rMax: def.radius * 0.8,
      scaleMin: 1.0, scaleMax: 1.7,
    });
    for (const sp of boulders) {
      const brng = makeRNG((sp.rng * 1e9) | 0);
      const b = P?.buildRockCluster?.(brng, { size: 2.2, count: 3 }) || P?.buildRock?.(brng, { size: 2.4, style: 'boulder', biome });
      if (!b) continue;
      b.position.set(sp.x, sp.y - 0.5, sp.z);
      b.rotation.y = sp.rot;
      b.scale.setScalar(sp.scale);
      setShadows(b);
      group.add(b);
      s.bodies.push(this.game.physics.addBody({
        type: 'fixed', position: { x: sp.x, y: sp.y + sp.scale, z: sp.z },
        shape: { kind: 'ball', r: sp.scale * 2.0 }, tag: 'rock', events: false,
      }));
    }

    // ---- underwater decoration ----
    const seaSpots = scatterOnSeabed(def, biome === 'jungle' ? 70 : 42, {
      seed: hashStr(def.id + 'sea'), minDepth: 1.5, maxDepth: biome === 'jungle' ? 22 : 16,
    });
    for (const sp of seaSpots) {
      const srng = makeRNG((sp.rng * 1e9) | 0);
      let o = null;
      if (P) {
        if (biome === 'jungle' || biome === 'tropical') o = srng() < 0.6 ? P.buildCoral?.(srng, {}) : P.buildKelp?.(srng, {});
        else if (biome === 'arctic') o = P.buildRock?.(srng, { size: 1.4, style: 'flat' });
        else o = srng() < 0.5 ? P.buildKelp?.(srng, {}) : P.buildRock?.(srng, { size: 1.2, style: 'boulder' });
      }
      if (!o) o = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.8, 5), this.flatPropMaterial);
      o.position.set(sp.x, sp.y, sp.z);
      o.rotation.y = sp.rot;
      o.scale.setScalar(sp.scale);
      group.add(o);
    }

    // ---- icebergs ----
    if (biome === 'arctic') {
      const bergs = scatterOnSeabed(def, 14, { seed: hashStr(def.id + 'berg'), minDepth: 6, maxDepth: 40, scaleMin: 1.2, scaleMax: 3.4 });
      for (const sp of bergs) {
        const brng = makeRNG((sp.rng * 1e9) | 0);
        let b = P?.buildIceberg?.(brng, { size: sp.scale * 6 });
        if (!b) b = new THREE.Mesh(new THREE.IcosahedronGeometry(sp.scale * 4, 0), new THREE.MeshStandardMaterial({ color: 0xd8eef6, roughness: 0.4 }));
        b.position.set(sp.x, -1.2, sp.z);
        b.rotation.y = sp.rot;
        setShadows(b);
        group.add(b);
        s.bodies.push(this.game.physics.addBody({
          type: 'fixed', position: { x: sp.x, y: 1, z: sp.z },
          shape: { kind: 'ball', r: sp.scale * 3.2 }, tag: 'iceberg', events: false,
        }));
      }
    }

    this.buildGroundCover(s, def);
    await this.buildStructures(s, rng);
    dressRegion(this, s, def, this.getAnchors(def.id));
  }

  /**
   * Instanced ground cover. One InstancedMesh per region keeps hundreds of
   * grass/shell clumps at a single draw call.
   */
  buildGroundCover(s, def) {
    const P = this.props;
    if (def.biome === 'abyss' || def.biome === 'station') return;
    const isGreen = ['tropical', 'jungle', 'rocky', 'storm'].includes(def.biome);
    let geo = null;
    try { geo = P?.buildGrassTuft?.(makeRNG(hashStr(def.id + 'grass')), { biome: def.biome }); }
    catch (e) { console.warn('[World] grass tuft failed', e.message); }
    if (geo && geo.isGroup) {
      // Some builders return a Group; take its first geometry.
      const m = geo.children.find((c) => c.isMesh);
      geo = m?.geometry || null;
    }
    if (!geo || !geo.attributes) {
      geo = new THREE.PlaneGeometry(0.5, 0.6);
      geo.translate(0, 0.3, 0);
    }
    const spots = scatterOnLand(def, isGreen ? 520 : 260, {
      seed: hashStr(def.id + 'cover'), minH: isGreen ? 1.6 : 0.4, maxSlope: 0.55,
      minSpacing: 1.0, rMax: def.radius * 0.98, scaleMin: 0.7, scaleMax: 1.5,
    });
    if (!spots.length) return;
    const mat = new THREE.MeshStandardMaterial({
      color: isGreen ? 0x6fa84a : 0xc9bd9a, roughness: 1, metalness: 0,
      side: THREE.DoubleSide, alphaTest: 0.35, vertexColors: !!geo.attributes.color,
    });
    mat.__owned = true;
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    inst.castShadow = false;
    inst.receiveShadow = true;
    inst.userData.noBatch = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const pos = new THREE.Vector3();
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      pos.set(sp.x, sp.y - 0.05, sp.z);
      q.setFromAxisAngle(UP_AXIS, sp.rot);
      sc.setScalar(sp.scale);
      m4.compose(pos, q, sc);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    s.group.add(inst);
  }

  async buildStructures(s, rng) {
    const def = s.def;
    const P = this.props;
    const a = this.getAnchors(def.id);
    const group = s.group;

    // ---- dock ----
    if (a.dock) {
      let dock = P?.buildDock?.(makeRNG(hashStr(def.id + 'dock')), {
        length: a.dock.length, width: a.dock.width, height: a.dock.y,
        heightAt: (wx, wz) => worldHeight(wx, wz),
      });
      const proc = !!dock;
      if (!dock) {
        dock = new THREE.Mesh(
          new THREE.BoxGeometry(a.dock.width, 0.35, a.dock.length),
          new THREE.MeshStandardMaterial({ color: 0x9a7b52, roughness: 0.9 }),
        );
      }
      // buildDock puts its deck at `height` ABOVE the group origin and drives
      // its pilings below it, so the group belongs at the waterline — placing
      // it at deck height floated the planks 1.8 m over their own collider.
      dock.position.set(a.dock.x, proc ? 0 : a.dock.y, a.dock.z);
      // Its length runs along local +Z, so to point it along `outward` the
      // yaw is (pi/2 - angle), not -angle (which put it across the shore).
      const dockYaw = Math.PI / 2 - a.dock.angle;
      dock.rotation.y = dockYaw;
      setShadows(dock);
      group.add(dock);
      s.dockObject = dock;
      // Deck collider: same orientation, same axes, top surface exactly at the
      // deck height the anchors advertise.
      s.bodies.push(this.game.physics.addBody({
        type: 'fixed', position: { x: a.dock.x, y: a.dock.y - 0.2, z: a.dock.z },
        rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dockYaw),
        shape: { kind: 'box', hx: a.dock.width / 2, hy: 0.2, hz: a.dock.length / 2, friction: 0.98 },
        tag: 'dock', events: false, userData: { surface: 'wood' },
      }));
    }

    // ---- merchant shack (shop) ----
    if (def.hasShop && a.shop) {
      let shack = P?.buildShack?.(makeRNG(hashStr(def.id + 'shop')), { biome: def.biome, tier: def.shopTier });
      if (!shack) {
        shack = new THREE.Group();
        const m = new THREE.Mesh(new THREE.BoxGeometry(6, 3.4, 5), new THREE.MeshStandardMaterial({ color: 0xb08050, roughness: 0.9 }));
        m.position.y = 1.7; shack.add(m);
      }
      shack.position.set(a.shop.x, a.shop.y - 0.1, a.shop.z);
      shack.lookAt(a.dock ? new THREE.Vector3(a.dock.x, a.shop.y, a.dock.z) : new THREE.Vector3(def.x, a.shop.y, def.z));
      setShadows(shack);
      group.add(shack);
      s.bodies.push(this.game.physics.addBody({
        type: 'fixed', position: { x: a.shop.x, y: a.shop.y + 1.7, z: a.shop.z },
        shape: { kind: 'box', hx: 3.2, hy: 1.8, hz: 2.7 }, tag: 'building', events: false,
      }));
      this.interactables.push({
        region: def.id, kind: 'shop', label: 'Open Shop', key: 'E',
        position: new THREE.Vector3(a.shop.x, a.shop.y + 1.4, a.shop.z), radius: 4.2,
        data: { tier: def.shopTier, region: def.id },
      });
    }

    // ---- sell station ----
    if (def.hasSell && a.sell) {
      let sell = P?.buildSellStation?.(makeRNG(hashStr(def.id + 'sell')), {});
      if (!sell) {
        sell = new THREE.Group();
        const m = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 1.8), new THREE.MeshStandardMaterial({ color: 0x5f8fb0, roughness: 0.7 }));
        m.position.y = 0.55; sell.add(m);
      }
      sell.position.set(a.sell.x, a.sell.y, a.sell.z);
      sell.rotation.y = rng() * Math.PI * 2;
      setShadows(sell);
      group.add(sell);
      const zonePos = new THREE.Vector3(a.sell.x, a.sell.y + 0.9, a.sell.z);
      this.sellZones.push({ region: def.id, position: zonePos, radius: 2.4, object: sell });
      this.interactables.push({
        region: def.id, kind: 'sell', label: 'Sell Fish', key: 'E',
        position: zonePos.clone(), radius: 3.4, data: { region: def.id },
      });
    }

    // ---- campfire ----
    if (a.campfire && def.biome !== 'station') {
      let fire = P?.buildCampfire?.(makeRNG(hashStr(def.id + 'fire')), {});
      if (!fire) {
        fire = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x555049 }));
      }
      fire.position.set(a.campfire.x, a.campfire.y, a.campfire.z);
      setShadows(fire);
      group.add(fire);
      const light = new THREE.PointLight(0xff8b3a, 3.0, 18, 2);
      light.position.set(a.campfire.x, a.campfire.y + 1.1, a.campfire.z);
      group.add(light);
      s.fireLight = light;
      s.firePos = new THREE.Vector3(a.campfire.x, a.campfire.y + 0.5, a.campfire.z);
    }

    // ---- crashed boat (starter island only) ----
    if (def.id === 'crash' && a.wreck) {
      let wreck = P?.buildWreckedBoat?.(makeRNG(4242), {});
      if (!wreck) {
        wreck = new THREE.Mesh(new THREE.BoxGeometry(6, 1.6, 2.2), new THREE.MeshStandardMaterial({ color: 0x8a6a44 }));
        wreck.rotation.z = 0.4;
      }
      wreck.position.set(a.wreck.x, a.wreck.y - 0.35, a.wreck.z);
      wreck.rotation.y = 1.1;
      setShadows(wreck);
      group.add(wreck);
      s.bodies.push(this.game.physics.addBody({
        type: 'fixed', position: { x: a.wreck.x, y: a.wreck.y + 0.7, z: a.wreck.z },
        shape: { kind: 'box', hx: 3.2, hy: 0.9, hz: 1.3 }, tag: 'wreck', events: false,
      }));
      s.wreckPos = new THREE.Vector3(a.wreck.x, a.wreck.y, a.wreck.z);

      // The starter rod, leaning against the wreck — the very first objective.
      const rodPos = {
        x: a.wreck.x + a.side.x * 2.2 + a.outward.x * 0.6,
        z: a.wreck.z + a.side.z * 2.2 + a.outward.z * 0.6,
      };
      rodPos.y = worldHeight(rodPos.x, rodPos.z);
      let rodProp = P?.buildFishingRodProp?.(makeRNG(99), {});
      if (!rodProp) {
        rodProp = new THREE.Group();
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.035, 1.7, 6),
          new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.9 }),
        );
        shaft.rotation.z = 0.55;
        shaft.position.y = 0.85;
        rodProp.add(shaft);
      }
      rodProp.position.set(rodPos.x, rodPos.y, rodPos.z);
      rodProp.rotation.y = 1.9;
      setShadows(rodProp);
      group.add(rodProp);
      s.rodProp = rodProp;

      // A glowing marker so a new player can't miss it.
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.75, 24),
        new THREE.MeshBasicMaterial({ color: 0x2fd4c4, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.set(rodPos.x, rodPos.y + 0.06, rodPos.z);
      group.add(halo);
      s.rodHalo = halo;

      this.interactables.push({
        region: def.id, kind: 'pickupRod', label: 'Pick Up Fishing Rod', key: 'E',
        position: new THREE.Vector3(rodPos.x, rodPos.y + 0.9, rodPos.z), radius: 3.2,
        data: {}, node: rodProp, halo,
      });
    }

    // ---- scattered beach debris ----
    const debrisSpots = scatterOnLand(def, 46, {
      seed: hashStr(def.id + 'debris'), minH: 0.05, maxH: 5.0, maxSlope: 0.4, minSpacing: 2.8, rMax: def.radius * 1.08,
    });
    for (const sp of debrisSpots) {
      const drng = makeRNG((sp.rng * 1e9) | 0);
      let o = null;
      const roll = drng();
      if (P) {
        if (roll < 0.3) o = P.buildCrate?.(drng, { size: lerp(0.5, 0.9, drng()) });
        else if (roll < 0.5) o = P.buildBarrel?.(drng, {});
        else if (roll < 0.72) o = P.buildDriftwood?.(drng, {});
        else o = P.buildRopeCoil?.(drng, {});
      }
      if (!o) o = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), this.flatPropMaterial);
      o.position.set(sp.x, sp.y + 0.05, sp.z);
      o.rotation.y = sp.rot;
      setShadows(o, false);
      group.add(o);
    }

    // ---- harbor lamps for night ----
    if (a.dock) {
      const lampCount = def.hasHarbor ? 5 : 2;
      for (let i = 0; i < lampCount; i++) {
        const t = (i + 0.5) / lampCount;
        const lx = lerp(a.dockStart.x, a.dockEnd.x, t) + a.side.x * (a.dock.width * 0.42);
        const lz = lerp(a.dockStart.z, a.dockEnd.z, t) + a.side.z * (a.dock.width * 0.42);
        let lamp = P?.buildLampPost?.(makeRNG(hashStr(def.id + 'lamp' + i)), {});
        if (!lamp) {
          lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.4, 6), new THREE.MeshStandardMaterial({ color: 0x30353a }));
          lamp.position.y = 1.7;
          const g = new THREE.Group(); g.add(lamp); lamp = g;
        }
        lamp.position.set(lx, a.dock.y, lz);
        setShadows(lamp);
        group.add(lamp);
        const pl = new THREE.PointLight(0xffd9a0, 0, 16, 2);
        pl.position.set(lx, a.dock.y + 3.3, lz);
        group.add(pl);
        (s.lamps ||= []).push(pl);
      }
    }
  }

  async decorateTrench(s, rng) {
    const def = s.def;
    const P = this.props;
    const spots = scatterOnSeabed(def, 40, { seed: 777, minDepth: 200, maxDepth: 2000, scaleMin: 2, scaleMax: 7 });
    for (const sp of spots) {
      const srng = makeRNG((sp.rng * 1e9) | 0);
      let o = P?.buildRock?.(srng, { size: sp.scale * 2, style: 'shard' });
      if (!o) o = new THREE.Mesh(new THREE.TetrahedronGeometry(sp.scale * 2, 0), this.flatPropMaterial);
      o.position.set(sp.x, sp.y, sp.z);
      o.rotation.set(srng(), sp.rot, srng());
      s.group.add(o);
    }
    // A trench takes the same set-dressing pass as an island. It was skipped
    // here, which is why the Abyss was a bare bowl with nothing on the rim.
    dressRegion(this, s, def, this.getAnchors(def.id));
  }

  update(dt, game) {
    this._checkTimer += dt;
    const p = game.camera.position;

    // Region streaming — checked at 2 Hz, one activation per check.
    if (this._checkTimer > 0.5) {
      this._checkTimer = 0;
      let nearest = null, nd = Infinity;
      for (const def of REGIONS) {
        const d = Math.hypot(p.x - def.x, p.z - def.z);
        if (d < nd) { nd = d; nearest = def; }
        const st = this.regions.get(def.id);
        if (d < this.activateRadius && (!st || !st.active) && !this._activating) {
          this._activating = true;
          this.activateRegion(def.id).finally(() => { this._activating = false; });
          break;
        } else if (d > this.deactivateRadius && st?.active) {
          this.deactivateRegion(def.id);
        }
      }
      if (nearest && nearest !== this.activeRegion && nd < nearest.reach * 1.6) {
        this.activeRegion = nearest;
        bus.emit('region:entered', nearest);
      }
    }

    // Animate the terrain's underwater caustics.
    const tm = this.terrainMaterial?.userData?.uniforms;
    const sky = game.get('sky');
    const night = sky ? 1 - sky.dayFactor : 0;
    if (tm) {
      tm.uCausticTime.value += dt;
      tm.uSunUp.value = sky ? Math.max(0, sky.dayFactor) : 1;
      const ocean = game.get('ocean');
      tm.uWaterY.value = ocean ? ocean.seaLevel : 0;
      // Weather and quality both dial it back.
      const weather = game.get('weather');
      tm.uCausticStrength.value = (game.quality === 'low' ? 0 : 0.95)
        * (1 - (weather?.intensity ?? 0) * 0.7);
    }

    for (const s of this.regions.values()) {
      if (!s.active) continue;
      if (s.lamps) for (const l of s.lamps) l.intensity = night * 7.5;
      if (s.fireLight) {
        s.fireLight.intensity = 2.4 + Math.sin(game.time * 11.3) * 0.5 + Math.sin(game.time * 27.7) * 0.3 + night * 1.6;
      }
      if (s.rodHalo) {
        s.rodHalo.scale.setScalar(1 + Math.sin(game.time * 2.4) * 0.12);
        s.rodHalo.material.opacity = 0.35 + Math.sin(game.time * 2.4) * 0.18;
      }
    }
  }

  // ---- queries used by every other system ----
  heightAt(x, z) { return worldHeight(x, z); }
  slopeAt(x, z) { return worldSlope(x, z); }
  normalAt(x, z, out) { return worldNormal(x, z, out); }
  regionAt(x, z) { return regionAt(x, z); }
  /** Depth of water at XZ (0 if land). */
  waterDepthAt(x, z) {
    const ocean = this.game.get('ocean');
    const surf = ocean ? ocean.heightAt(x, z) : 0;
    return Math.max(0, surf - worldHeight(x, z));
  }
  isWater(x, z) { return worldHeight(x, z) < -0.15; }

  save() {
    return { activated: [...this.regions.keys()].filter((k) => this.regions.get(k).built) };
  }
  load(d) { /* regions rebuild on proximity */ }
}

function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * @param {THREE.Object3D} obj
 * @param {boolean} cast Whether this prop casts a shadow. Small, numerous
 *   props (bushes, beach litter, pebbles) are set false: at any shadow-map
 *   resolution that covers an island they contribute a dense field of hard
 *   low-res streaks rather than readable shadows.
 */
function setShadows(obj, cast = true) {
  obj.traverse?.((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = true; } });
  if (obj.isMesh) { obj.castShadow = cast; obj.receiveShadow = true; }
}

function disposeGroup(g) {
  if (!g) return;
  g.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose();
      // Shared materials are owned by World/props; only dispose per-instance ones.
      if (o.material && o.material.__owned) o.material.dispose();
    }
  });
}

function fallbackTree(rng, biome) {
  const g = new THREE.Group();
  const h = 5 + rng() * 4;
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.28, h, 6),
    new THREE.MeshStandardMaterial({ color: 0x7a5a38, roughness: 0.95 }),
  );
  trunk.position.y = h / 2;
  g.add(trunk);
  const leafColor = biome === 'arctic' ? 0x3f6b52 : biome === 'jungle' ? 0x3f9a2e : 0x5fa843;
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(
      new THREE.ConeGeometry(2.0 - i * 0.5, 2.4, 7),
      new THREE.MeshStandardMaterial({ color: leafColor, roughness: 0.9, flatShading: true }),
    );
    c.position.y = h * 0.62 + i * 1.1;
    g.add(c);
  }
  return g;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export { hashStr };
