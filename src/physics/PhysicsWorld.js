import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { bus } from '../core/EventBus.js';
import { clamp } from '../util/math.js';

/** Collision groups — 16 bits membership | 16 bits filter. */
export const CG = {
  TERRAIN: 1 << 0,
  PLAYER: 1 << 1,
  FISH: 1 << 2,
  PROP: 1 << 3,
  BOAT: 1 << 4,
  PROJECTILE: 1 << 5,
  WORKER: 1 << 6,
  TRIGGER: 1 << 7,
  HOOK: 1 << 8,
  DEBRIS: 1 << 9,
};
export const ALL = 0xffff;

/** Build a Rapier collision-groups bitfield. */
export const groups = (membership, filter = ALL) => ((membership & 0xffff) << 16) | (filter & 0xffff);

let _rapierReady = null;
export function initRapier() {
  if (!_rapierReady) _rapierReady = RAPIER.init().then(() => RAPIER);
  return _rapierReady;
}
export { RAPIER };

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Wrapper around a Rapier world.
 * Bodies are registered with an optional THREE.Object3D so transforms sync automatically.
 */
export class PhysicsWorld {
  constructor(opts = {}) {
    this.gravity = new RAPIER.Vector3(0, opts.gravity ?? -20.0, 0);
    this.world = new RAPIER.World(this.gravity);
    this.world.integrationParameters.dt = 1 / 60;
    this.world.integrationParameters.numSolverIterations = 4;
    this.eventQueue = new RAPIER.EventQueue(true);

    /** @type {Map<number, object>} rigidBody handle -> entry */
    this.entries = new Map();
    /** @type {Map<number, object>} collider handle -> entry */
    this.byCollider = new Map();
    this.accumulator = 0;
    this.fixedDt = 1 / 60;
    this.maxSubsteps = 4;
    this.stepCount = 0;
    this.enabled = true;
    /** Objects whose transform should be pushed to THREE each frame. */
    this._syncList = [];
    this._removeQueue = [];
    this._contactCallbacks = new Map();
  }

  // ---------------------------------------------------------------- bodies
  /**
   * @param {object} o
   * @param {'dynamic'|'fixed'|'kinematicPosition'|'kinematicVelocity'} o.type
   * @param {THREE.Vector3|{x,y,z}} o.position
   * @param {THREE.Quaternion} [o.rotation]
   * @param {object|object[]} o.shape  {kind:'box',hx,hy,hz} | {kind:'ball',r} | {kind:'capsule',hh,r}
   *                                   | {kind:'cylinder',hh,r} | {kind:'cone',hh,r}
   *                                   | {kind:'trimesh',vertices,indices} | {kind:'hull',points}
   *                                   | {kind:'heightfield',nrows,ncols,heights,scale}
   * @param {THREE.Object3D} [o.object3d]
   */
  addBody(o) {
    let desc;
    switch (o.type) {
      case 'fixed': desc = RAPIER.RigidBodyDesc.fixed(); break;
      case 'kinematicPosition': desc = RAPIER.RigidBodyDesc.kinematicPositionBased(); break;
      case 'kinematicVelocity': desc = RAPIER.RigidBodyDesc.kinematicVelocityBased(); break;
      default: desc = RAPIER.RigidBodyDesc.dynamic();
    }
    const p = o.position || { x: 0, y: 0, z: 0 };
    desc.setTranslation(p.x, p.y, p.z);
    if (o.rotation) desc.setRotation({ x: o.rotation.x, y: o.rotation.y, z: o.rotation.z, w: o.rotation.w });
    if (o.linearDamping != null) desc.setLinearDamping(o.linearDamping);
    if (o.angularDamping != null) desc.setAngularDamping(o.angularDamping);
    if (o.ccd) desc.setCcdEnabled(true);
    if (o.gravityScale != null) desc.setGravityScale(o.gravityScale);
    if (o.canSleep === false) desc.setCanSleep(false);
    if (o.lockRotation) desc.lockRotations();
    if (o.additionalMass) desc.setAdditionalMass(o.additionalMass);

    const body = this.world.createRigidBody(desc);
    const shapes = Array.isArray(o.shape) ? o.shape : [o.shape];
    const colliders = [];
    for (const s of shapes) {
      const cd = this._colliderDesc(s);
      if (!cd) continue;
      cd.setDensity(s.density ?? o.density ?? 1.0);
      cd.setFriction(s.friction ?? o.friction ?? 0.7);
      cd.setRestitution(s.restitution ?? o.restitution ?? 0.15);
      cd.setCollisionGroups(s.groups ?? o.groups ?? groups(CG.PROP, ALL));
      if (s.offset) cd.setTranslation(s.offset.x || 0, s.offset.y || 0, s.offset.z || 0);
      if (s.rotationOffset) cd.setRotation(s.rotationOffset);
      if (o.sensor || s.sensor) cd.setSensor(true);
      if (o.events !== false) cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const col = this.world.createCollider(cd, body);
      colliders.push(col);
    }

    const entry = {
      body, colliders, object3d: o.object3d || null, userData: o.userData || null,
      tag: o.tag || 'prop', handle: body.handle, sync: o.object3d ? true : false,
      onContact: o.onContact || null, birth: performance.now(),
    };
    this.entries.set(body.handle, entry);
    for (const c of colliders) this.byCollider.set(c.handle, entry);
    if (entry.sync) this._syncList.push(entry);
    return entry;
  }

  _colliderDesc(s) {
    switch (s.kind) {
      case 'box': return RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
      case 'ball': return RAPIER.ColliderDesc.ball(s.r);
      case 'capsule': return RAPIER.ColliderDesc.capsule(s.hh, s.r);
      case 'cylinder': return RAPIER.ColliderDesc.cylinder(s.hh, s.r);
      case 'cone': return RAPIER.ColliderDesc.cone(s.hh, s.r);
      case 'roundBox': return RAPIER.ColliderDesc.roundCuboid(s.hx, s.hy, s.hz, s.border ?? 0.03);
      case 'trimesh': return RAPIER.ColliderDesc.trimesh(s.vertices, s.indices);
      case 'hull': {
        const d = RAPIER.ColliderDesc.convexHull(s.points);
        if (!d) { console.warn('[Physics] convexHull failed, falling back to box'); return RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5); }
        return d;
      }
      case 'heightfield':
        return RAPIER.ColliderDesc.heightfield(s.nrows, s.ncols, s.heights, s.scale);
      default:
        console.warn('[Physics] unknown shape kind', s.kind);
        return null;
    }
  }

  remove(entry) {
    if (!entry || entry.removed) return;
    entry.removed = true;
    this._removeQueue.push(entry);
  }

  _flushRemovals() {
    for (const e of this._removeQueue) {
      for (const c of e.colliders) this.byCollider.delete(c.handle);
      this.entries.delete(e.handle);
      const i = this._syncList.indexOf(e);
      if (i >= 0) this._syncList.splice(i, 1);
      try { this.world.removeRigidBody(e.body); } catch (err) { console.warn('[Physics] remove failed', err); }
    }
    this._removeQueue.length = 0;
  }

  // ---------------------------------------------------------------- helpers
  setPosition(entry, x, y, z) {
    entry.body.setTranslation({ x, y, z }, true);
  }
  setRotation(entry, q) { entry.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true); }
  getPosition(entry, out = _v) { const t = entry.body.translation(); return out.set(t.x, t.y, t.z); }
  getVelocity(entry, out = _v) { const t = entry.body.linvel(); return out.set(t.x, t.y, t.z); }
  setVelocity(entry, x, y, z) { entry.body.setLinvel({ x, y, z }, true); }
  addForce(entry, x, y, z) { entry.body.addForce({ x, y, z }, true); }
  addImpulse(entry, x, y, z) { entry.body.applyImpulse({ x, y, z }, true); }
  addTorqueImpulse(entry, x, y, z) { entry.body.applyTorqueImpulse({ x, y, z }, true); }
  addImpulseAtPoint(entry, ix, iy, iz, px, py, pz) {
    entry.body.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, { x: px, y: py, z: pz }, true);
  }

  /** Radial explosion impulse on every dynamic body inside `radius`. */
  explode(x, y, z, radius, force, filterTag = null) {
    const r2 = radius * radius;
    for (const e of this.entries.values()) {
      if (e.removed || e.body.isFixed()) continue;
      if (filterTag && e.tag !== filterTag) continue;
      const t = e.body.translation();
      const dx = t.x - x, dy = t.y - y, dz = t.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const falloff = 1 - d / radius;
      const mag = (force * falloff * falloff) / Math.max(0.5, e.body.mass());
      e.body.applyImpulse({ x: (dx / d) * mag, y: (dy / d) * mag + mag * 0.35, z: (dz / d) * mag }, true);
    }
  }

  /** @returns {{point:THREE.Vector3, normal:THREE.Vector3, distance:number, entry:object}|null} */
  raycast(origin, dir, maxDist = 100, filterGroups = undefined, excludeCollider = null) {
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const hit = this.world.castRayAndGetNormal(
      ray, maxDist, true, undefined, filterGroups, excludeCollider || undefined, undefined,
    );
    if (!hit) return null;
    const t = hit.timeOfImpact ?? hit.toi;
    return {
      point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: t,
      entry: this.byCollider.get(hit.collider.handle) || null,
      collider: hit.collider,
    };
  }

  /** Shape-cast a sphere; useful for thick projectiles and interaction probes. */
  sphereCast(origin, dir, radius, maxDist = 50, filterGroups = undefined) {
    const shape = new RAPIER.Ball(radius);
    const hit = this.world.castShape(
      { x: origin.x, y: origin.y, z: origin.z }, { x: 0, y: 0, z: 0, w: 1 },
      { x: dir.x, y: dir.y, z: dir.z }, shape, 0, maxDist, true, undefined, filterGroups,
    );
    if (!hit) return null;
    const t = hit.time_of_impact ?? hit.toi ?? 0;
    return {
      point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: hit.normal1 ? new THREE.Vector3(hit.normal1.x, hit.normal1.y, hit.normal1.z) : new THREE.Vector3(0, 1, 0),
      distance: t,
      entry: this.byCollider.get(hit.collider.handle) || null,
    };
  }

  /** Calls `cb(entry)` for every entry with a collider intersecting the sphere. */
  querySphere(center, radius, cb, filterGroups = undefined) {
    const shape = new RAPIER.Ball(radius);
    this.world.intersectionsWithShape(
      { x: center.x, y: center.y, z: center.z }, { x: 0, y: 0, z: 0, w: 1 }, shape,
      (collider) => {
        const e = this.byCollider.get(collider.handle);
        if (e) return cb(e) !== false;
        return true;
      }, undefined, filterGroups,
    );
  }

  onContact(entry, cb) { entry.onContact = cb; }

  // ---------------------------------------------------------------- stepping
  step(dt) {
    if (!this.enabled) return;
    this._flushRemovals();
    this.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxSubsteps) {
      this.world.timestep = this.fixedDt;
      this.world.step(this.eventQueue);
      this.accumulator -= this.fixedDt;
      steps++;
      this.stepCount++;
      this._drainEvents();
    }
    // If we fell far behind, drop the backlog rather than spiral.
    if (this.accumulator > this.fixedDt * this.maxSubsteps) this.accumulator = 0;
    this.syncToThree();
  }

  _drainEvents() {
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      const a = this.byCollider.get(h1), b = this.byCollider.get(h2);
      if (!a && !b) return;
      if (a?.onContact) { try { a.onContact(b, started, this); } catch (e) { console.error(e); } }
      if (b?.onContact) { try { b.onContact(a, started, this); } catch (e) { console.error(e); } }
      if (started && a && b) bus.emit('phys:contact', { a, b });
    });
    this.eventQueue.drainContactForceEvents((ev) => {
      const mag = ev.totalForceMagnitude();
      if (mag < 60) return;
      const a = this.byCollider.get(ev.collider1()), b = this.byCollider.get(ev.collider2());
      if (a || b) bus.emit('phys:impact', { a, b, force: mag });
    });
  }

  syncToThree() {
    for (let i = 0; i < this._syncList.length; i++) {
      const e = this._syncList[i];
      if (e.removed || !e.object3d) continue;
      const t = e.body.translation();
      const r = e.body.rotation();
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) {
        console.warn('[Physics] NaN transform on', e.tag, '- resetting');
        e.body.setTranslation({ x: 0, y: 20, z: 0 }, true);
        e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        e.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        continue;
      }
      e.object3d.position.set(t.x, t.y, t.z);
      e.object3d.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  get bodyCount() { return this.entries.size; }
  get activeCount() {
    let n = 0;
    for (const e of this.entries.values()) if (!e.body.isSleeping() && !e.body.isFixed()) n++;
    return n;
  }

  dispose() {
    this.entries.clear();
    this.byCollider.clear();
    this._syncList.length = 0;
    this.eventQueue.free();
    this.world.free();
  }
}

/**
 * Applies buoyancy + drag at a set of sample points on a body.
 * Called every frame by systems that own floating objects.
 */
export function applyBuoyancy(phys, entry, samplePoints, opts) {
  const {
    waterHeightAt, volume = 1, dragLinear = 1.2, dragAngular = 0.9,
    density = 1000, submergedOut = null, waveVelAt = null,
  } = opts;
  // Archimedes must use the SAME gravity the solver does, or a world with
  // non-Earth gravity floats or sinks everything.
  const G = opts.gravity ?? Math.abs(phys.gravity?.y ?? phys.world.gravity.y) ?? 9.81;
  const body = entry.body;
  const t = body.translation();
  const rot = body.rotation();
  _q.set(rot.x, rot.y, rot.z, rot.w);
  const n = samplePoints.length;
  const perSampleVolume = volume / n;
  let submergedTotal = 0;
  let anySubmerged = false;

  for (let i = 0; i < n; i++) {
    _v.copy(samplePoints[i]).applyQuaternion(_q);
    const px = t.x + _v.x, py = t.y + _v.y, pz = t.z + _v.z;
    const wh = waterHeightAt(px, pz);
    const depth = wh - py;
    if (depth <= 0) continue;
    anySubmerged = true;
    const sub = clamp(depth / (opts.sampleHeight || 0.6), 0, 1);
    submergedTotal += sub / n;
    // Archimedes: rho * g * displaced volume, opposing gravity.
    const f = density * G * perSampleVolume * sub;
    body.applyImpulseAtPoint(
      { x: 0, y: f * (opts.dt || 1 / 60), z: 0 },
      { x: px, y: py, z: pz }, true,
    );
  }

  if (anySubmerged) {
    const lv = body.linvel();
    const av = body.angvel();
    const s = clamp(submergedTotal, 0, 1);
    const dt = opts.dt || 1 / 60;
    let rvx = lv.x, rvy = lv.y, rvz = lv.z;
    if (waveVelAt) {
      const wv = waveVelAt(t.x, t.z);
      rvx -= wv.x; rvy -= wv.y; rvz -= wv.z;
    }
    const k = dragLinear * s * body.mass() * dt;
    body.applyImpulse({ x: -rvx * k, y: -rvy * k * 1.6, z: -rvz * k }, true);
    const ka = dragAngular * s * dt;
    body.applyTorqueImpulse({ x: -av.x * ka, y: -av.y * ka, z: -av.z * ka }, true);
  }
  if (submergedOut) submergedOut.value = submergedTotal;
  return submergedTotal;
}
