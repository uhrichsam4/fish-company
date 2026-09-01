import * as THREE from 'three';
import * as Props from '../world/props/index.js';
import { bus } from '../core/EventBus.js';
import { HARBOR_BUILDINGS, HARBOR_BY_ID } from '../data/harbor.js';
import { REGION_BY_ID } from '../data/regions.js';
import { formatMoneyExact, formatWeight, makeRNG, clamp } from '../util/math.js';

const HARBOR_REGION = 'harbor';

/** Deterministic per-part seed so a rebuilt harbour is identical. */
function partSeed(buildingId, i) {
  let h = 2166136261;
  const s = `${buildingId}:${i}`;
  for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function setShadows(o) {
  o.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
}

/**
 * Port Grimsby's buildable quay.
 *
 * Buying a building spends money, folds its effects into flat aggregates that
 * other systems read, and spawns real geometry plus a fixed collider inside
 * the harbour region group (so it is cleaned up with the region and rebuilt
 * when the region streams back in).
 */
export class Harbor {
  constructor(game) {
    this.game = game;
    this.name = 'harbor';
    this.order = 33;

    /** @type {Set<string>} built building ids */
    this.built = new Set();
    /** @type {Map<string, {group:THREE.Group, bodies:any[]}>} */
    this.spawned = new Map();

    // ---- aggregates ----
    this.workerSlots = 0;
    this.boatSlots = 0;
    this.contractSlots = 0;
    this.storageBonus = 0;
    this.freshness = 1;
    this.repairSpeed = 1;
    this.repairMult = 1;
    this.wageMult = 1;
    this.fuelMult = 1;
    this.priceMult = 1;
    this.processLevels = 0;
    this.sonarLevel = 0;
    this.researchDiscount = 0;
    /** @type {Set<string>} feature ids granted by buildings */
    this.features = new Set();

    this._catalogue = [];
    this._catalogueDirty = true;
    this._recompute();
  }

  async init(game) {
    bus.on('company:build', ({ id }) => this.build(id));
    bus.on('region:activated', (def) => {
      if (def?.id === HARBOR_REGION) this.rebuildAll();
    });
    bus.on('region:deactivated', (def) => {
      if (def?.id === HARBOR_REGION) this.spawned.clear();
    });
    bus.on('research:unlocked', () => { this._catalogueDirty = true; });
    bus.on('region:unlocked', () => { this._catalogueDirty = true; });
    bus.on('game:newgame', () => this.reset());
    bus.on('debug:buildHarbor', () => this.buildAll());
    this.rebuildAll();
    return this;
  }

  // -------------------------------------------------------------- catalogue
  /** UI catalogue: `{id, icon, name, desc, cost, effects:[string], reqHint}`. */
  get catalogue() {
    if (this._catalogueDirty) this._rebuildCatalogue();
    return this._catalogue;
  }

  _rebuildCatalogue() {
    this._catalogue = HARBOR_BUILDINGS.map((b) => ({
      id: b.id, icon: b.icon, name: b.name, desc: b.desc, cost: b.cost,
      effects: effectLines(b.effects),
      reqHint: this.reqHint(b.id),
      def: b,
    }));
    this._catalogueDirty = false;
  }

  has(id) { return this.built.has(id); }

  def(id) { return HARBOR_BY_ID[id] || null; }

  available(id) {
    const b = HARBOR_BY_ID[id];
    if (!b || this.built.has(id)) return false;
    for (const r of b.requires) if (!this.built.has(r)) return false;
    if (b.reqResearch && !this.game.get('research')?.has(b.reqResearch)) return false;
    const quests = this.game.get('quests');
    if (b.reqRegion && quests && !quests.isRegionUnlocked(b.reqRegion)) return false;
    return true;
  }

  reqHint(id) {
    const b = HARBOR_BY_ID[id];
    if (!b) return 'Unknown';
    if (this.built.has(id)) return 'Built';
    const missing = b.requires.filter((r) => !this.built.has(r));
    if (missing.length) return `Needs ${missing.map((m) => HARBOR_BY_ID[m]?.name || m).join(', ')}`;
    const research = this.game.get('research');
    if (b.reqResearch && !research?.has(b.reqResearch)) {
      return `Needs research: ${research?.node?.(b.reqResearch)?.name || b.reqResearch}`;
    }
    const quests = this.game.get('quests');
    if (b.reqRegion && quests && !quests.isRegionUnlocked(b.reqRegion)) {
      return `Needs ${REGION_BY_ID[b.reqRegion]?.name || b.reqRegion}`;
    }
    return '';
  }

  hasFeature(id) { return this.features.has(id); }

  // ------------------------------------------------------------------ build
  build(id) {
    const b = HARBOR_BY_ID[id];
    if (!b) { console.warn('[Harbor] unknown building', id); return false; }
    if (this.built.has(id)) return false;
    if (!this.available(id)) {
      bus.emit('toast', { text: this.reqHint(id) || 'Cannot build that yet', kind: 'error' });
      this.game.audio?.play('ui_error');
      return false;
    }
    const eco = this.game.get('economy');
    if (!eco || !eco.spend(b.cost, 'construction')) return false;

    this.built.add(id);
    this._recompute();
    this._spawn(b);
    this.game.audio?.play('levelup', { volume: 0.6 });
    bus.emit('toast', {
      text: `🏗 Built <b>${b.name}</b> — ${formatMoneyExact(b.cost)}`,
      kind: 'gold', duration: 4800,
    });
    bus.emit('harbor:built', { id, building: b });
    return true;
  }

  /** Debug helper — grants every building for free. */
  buildAll() {
    let n = 0;
    // Loop until nothing new resolves, so prerequisite chains complete.
    for (let pass = 0; pass < HARBOR_BUILDINGS.length; pass++) {
      let added = 0;
      for (const b of HARBOR_BUILDINGS) {
        if (this.built.has(b.id)) continue;
        const missing = b.requires.some((r) => !this.built.has(r));
        if (missing) continue;
        this.built.add(b.id);
        added++; n++;
      }
      if (!added) break;
    }
    this._recompute();
    this.rebuildAll();
    for (const id of this.built) bus.emit('harbor:built', { id, building: HARBOR_BY_ID[id] });
    return n;
  }

  reset() {
    this._despawnAll();
    this.built.clear();
    this._recompute();
  }

  // ------------------------------------------------------------ aggregation
  _recompute() {
    this.workerSlots = 0;
    this.boatSlots = 0;
    this.contractSlots = 0;
    this.storageBonus = 0;
    this.freshness = 1;
    this.repairSpeed = 1;
    this.repairMult = 1;
    this.wageMult = 1;
    this.fuelMult = 1;
    this.priceMult = 1;
    this.processLevels = 0;
    this.sonarLevel = 0;
    this.researchDiscount = 0;
    this.features.clear();

    for (const id of this.built) {
      const e = HARBOR_BY_ID[id]?.effects;
      if (!e) continue;
      if (e.workerSlots) this.workerSlots += e.workerSlots;
      if (e.boatSlots) this.boatSlots += e.boatSlots;
      if (e.contractSlots) this.contractSlots += e.contractSlots;
      if (e.storageBonus) this.storageBonus += e.storageBonus;
      if (e.freshness != null) this.freshness *= e.freshness;
      if (e.repairSpeed != null) this.repairSpeed *= e.repairSpeed;
      if (e.repairMult != null) this.repairMult *= e.repairMult;
      if (e.wageMult != null) this.wageMult *= e.wageMult;
      if (e.fuelMult != null) this.fuelMult *= e.fuelMult;
      if (e.priceMult != null) this.priceMult *= e.priceMult;
      if (e.processLevels != null) this.processLevels = Math.max(this.processLevels, e.processLevels);
      if (e.sonarLevel != null) this.sonarLevel = Math.max(this.sonarLevel, e.sonarLevel);
      if (e.researchDiscount) this.researchDiscount += e.researchDiscount;
      if (e.unlock) this.features.add(e.unlock);
    }
    this.researchDiscount = clamp(this.researchDiscount, 0, 0.6);
    this._catalogueDirty = true;

    const research = this.game.get('research');
    research?.refreshDiscount?.();
    // Research owns the shared inventory capacity field; ask it to re-add ours.
    if (research?.applyToInventory) research.applyToInventory();
    else {
      const inv = this.game.get('inventory');
      if (inv) inv.capacityBonus = this.storageBonus;
    }
    bus.emit('harbor:changed', { built: this.built.size });
  }

  // --------------------------------------------------------------- geometry
  /** (Re)create every built structure — used on boot, load and region stream-in. */
  rebuildAll() {
    const st = this.game.get('world')?.regions?.get(HARBOR_REGION);
    if (!st?.group) return 0;
    this._despawnAll();
    let n = 0;
    for (const id of this.built) { if (this._spawn(HARBOR_BY_ID[id])) n++; }
    return n;
  }

  _despawnAll() {
    const world = this.game.get('world');
    const st = world?.regions?.get(HARBOR_REGION);
    for (const [, rec] of this.spawned) {
      if (rec.group?.parent) rec.group.parent.remove(rec.group);
      disposeGroup(rec.group);
      for (const b of rec.bodies) {
        this.game.physics?.remove(b);
        if (st?.bodies) { const i = st.bodies.indexOf(b); if (i >= 0) st.bodies.splice(i, 1); }
      }
    }
    this.spawned.clear();
    if (world) world.interactables = world.interactables.filter((i) => !i.harborBuilding);
  }

  /** Build the mesh + collider for one building. Safe to call before the region exists. */
  _spawn(b) {
    if (!b || this.spawned.has(b.id)) return false;
    const world = this.game.get('world');
    const st = world?.regions?.get(HARBOR_REGION);
    if (!world || !st?.group) return false;

    const a = world.getAnchors(HARBOR_REGION);
    if (!a?.dockStart || !a.side || !a.inward) return false;

    const ang = a.dock?.angle ?? 0;
    const yaw = -(ang + Math.PI / 2);
    const [ox, oz] = b.offset;
    const wx = a.dockStart.x + a.side.x * ox + a.inward.x * oz;
    const wz = a.dockStart.z + a.side.z * ox + a.inward.z * oz;
    const wy = b.water ? (a.dock?.y ?? 1.8) : world.heightAt(wx, wz) - 0.12;

    const group = new THREE.Group();
    group.name = `harbor:${b.id}`;
    group.position.set(wx, wy, wz);
    group.rotation.y = yaw;

    b.parts.forEach((p, i) => {
      const fn = Props.PROP_BUILDERS?.[p.prop];
      let obj = null;
      try { obj = fn ? fn(makeRNG(partSeed(b.id, i)), p.opts || {}) : null; }
      catch (e) { console.warn(`[Harbor] prop "${p.prop}" failed for ${b.id}:`, e.message); }
      if (!obj) {
        obj = new THREE.Group();
        obj.add(new THREE.Mesh(
          new THREE.BoxGeometry(2, 2, 2),
          new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.9 }),
        ));
      }
      const at = p.at || [0, 0, 0];
      obj.position.set(at[0], at[1], at[2]);
      obj.rotation.y = p.ry || 0;
      setShadows(obj);
      group.add(obj);
    });

    st.group.add(group);

    // ---- colliders ----
    const bodies = [];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const wallH = b.wallH ?? 4.0;
    const boxes = [{
      at: [0, b.water ? -wallH / 2 : wallH / 2, 0],
      hx: b.size[0] / 2, hy: wallH / 2, hz: b.size[1] / 2,
      friction: b.water ? 0.98 : 0.7,
    }, ...(b.extraColliders || [])];

    for (const c of boxes) {
      const cat = c.at || [0, 0, 0];
      const lx = cat[0], ly = cat[1], lz = cat[2];
      // rotate the local offset into world space
      const px = wx + a.side.x * lx + a.inward.x * lz;
      const pz = wz + a.side.z * lx + a.inward.z * lz;
      const body = this.game.physics?.addBody({
        type: 'fixed', position: { x: px, y: wy + ly, z: pz }, rotation: q,
        shape: { kind: 'box', hx: c.hx, hy: c.hy, hz: c.hz, friction: c.friction ?? 0.7 },
        tag: 'building', events: false, userData: { building: b.id, surface: b.water ? 'wood' : 'concrete' },
      });
      if (body) { bodies.push(body); st.bodies?.push(body); }
    }

    // ---- interactable ----
    if (b.interact) {
      const iat = b.interact.at || [0, 1.4, 0];
      const ix = wx + a.side.x * iat[0] + a.inward.x * iat[2];
      const iz = wz + a.side.z * iat[0] + a.inward.z * iat[2];
      bus.emit('interaction:register', {
        region: HARBOR_REGION, kind: b.interact.kind, label: b.interact.label, key: 'E',
        position: new THREE.Vector3(ix, wy + iat[1], iz), radius: b.interact.radius ?? 3.6,
        data: { building: b.id }, harborBuilding: b.id,
      });
    }

    this.spawned.set(b.id, { group, bodies });
    return true;
  }

  // ---------------------------------------------------------------- persist
  save() { return { built: [...this.built] }; }

  load(d) {
    if (!d) return;
    this._despawnAll();
    this.built = new Set((d.built || []).filter((id) => HARBOR_BY_ID[id]));
    this._recompute();
    this.rebuildAll();
  }
}

// ---------------------------------------------------------------------------

/** Human-readable one-line summaries of an effects object, for the UI cards. */
function effectLines(e = {}) {
  const out = [];
  const pct = (v) => `${v >= 1 ? '+' : '-'}${Math.round(Math.abs(v - 1) * 100)}%`;
  if (e.workerSlots) out.push(`+${e.workerSlots} worker slots`);
  if (e.boatSlots) out.push(`+${e.boatSlots} boat berths`);
  if (e.contractSlots) out.push(`+${e.contractSlots} contract slot`);
  if (e.storageBonus) out.push(`+${formatWeight(e.storageBonus)} storage`);
  if (e.freshness) out.push(`${pct(e.freshness)} freshness value`);
  if (e.repairSpeed) out.push(`${pct(e.repairSpeed)} repair speed`);
  if (e.repairMult) out.push(`${pct(e.repairMult)} repair cost`);
  if (e.wageMult) out.push(`${pct(e.wageMult)} wages`);
  if (e.fuelMult) out.push(`${pct(e.fuelMult)} fuel cost`);
  if (e.priceMult) out.push(`${pct(e.priceMult)} fish prices`);
  if (e.processLevels) out.push(`Processing to tier ${e.processLevels}`);
  if (e.sonarLevel) out.push(`Sonar level ${e.sonarLevel}`);
  if (e.researchDiscount) out.push(`-${Math.round(e.researchDiscount * 100)}% research cost`);
  if (e.unlock) out.push(`Unlocks <b>${e.unlock.replace(/_/g, ' ')}</b>`);
  return out;
}

function disposeGroup(g) {
  if (!g) return;
  g.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
      // Shared prop materials are reused across props — leave them alone.
    }
  });
}
