import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { REGIONS } from '../data/regions.js';
import { clamp, clamp01, damp, rrange, rchance, TAU } from '../util/math.js';
import { waterHeightAt } from './waves.js';

/**
 * Birds — a small flock of low-poly gulls that circles the nearest island,
 * dives at the water, scatters when you make noise and roosts on the dock
 * after dark. Also the world's source of positional `seagull` calls.
 *
 * Each gull is ONE Group with three meshes (body+beak, left wing, right wing)
 * sharing geometry and one material, so a full flock is ~42 draw calls at the
 * top density and the whole thing costs a few hundred triangles.
 */

const ACTIVE_RANGE = 200;       // metres beyond an island's radius
const CHECK_INTERVAL = 0.5;
const FAR_LOD = 90;             // beyond this a bird ticks every 3rd frame
const QUALITY_SCALE = { low: 0.4, medium: 0.72, high: 1 };

const WHITE = new THREE.Color(0xf4f6f7);
const MANTLE = new THREE.Color(0xb9c4cc);
const TIP = new THREE.Color(0x555f68);
const BEAK = new THREE.Color(0xff9a2e);

// ---- scratch ----
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export class Birds {
  name = 'birds';
  order = 560;

  constructor(game) {
    this.game = game;
    /** @type {Array<object>} */
    this.birds = [];
    this.active = false;
    this.island = null;

    this.group = null;
    this.material = null;
    this.bodyGeo = null;
    this.wingGeoL = null;
    this.wingGeoR = null;

    this._checkT = 0;
    this._callT = rrange(3, 8);
    this._center = new THREE.Vector3();
    this._roosts = [];
    this._offs = [];
    this._tick = 0;
  }

  async init(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'birds';
    game.scene.add(this.group);

    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    });
    this.bodyGeo = buildBodyGeometry();
    this.wingGeoL = buildWingGeometry(false);
    this.wingGeoR = buildWingGeometry(true);

    const on = (e, fn) => this._offs.push(bus.on(e, fn));
    on('weapon:fired', () => this.scatterAll());
    on('fx:bigSplash', (d) => { if (d?.position) this.scatterNear(d.position, 60); });
    on('quality:changed', () => { this._checkT = CHECK_INTERVAL; this._resize(); });
    on('settings:applied', () => { this._checkT = CHECK_INTERVAL; this._resize(); });

    return this;
  }

  // ---------------------------------------------------------------- density

  get density() {
    const q = QUALITY_SCALE[this.game?.quality] ?? 1;
    return clamp01(this.game?.settings?.particles ?? 1) * q;
  }

  get wantCount() {
    return clamp(Math.round(6 + 8 * this.density), 6, 14);
  }

  // ---------------------------------------------------------------- flock

  update(dt, game) {
    if (dt <= 0) return;
    this._tick++;

    this._checkT += dt;
    if (this._checkT >= CHECK_INTERVAL) {
      this._checkT = 0;
      this._checkIsland(game);
    }
    if (!this.active || !this.birds.length) return;

    const player = game.get('player');
    const sky = game.get('sky');
    const cam = game.camera;
    const night = sky ? sky.isNight : false;
    const roosting = night && this._roosts.length > 0;

    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      const dSq = b.pos.distanceToSquared(cam.position);
      let step = dt;
      if (dSq > FAR_LOD * FAR_LOD) {
        b.acc += dt;
        if ((this._tick + i) % 3 !== 0) continue;
        step = b.acc; b.acc = 0;
      }
      this._updateBird(b, step, game, player, roosting);
    }

    this._calls(dt, game, cam);
  }

  /** Pick / drop the island the flock belongs to. */
  _checkIsland(game) {
    const player = game.get('player');
    if (!player) return;
    const px = player.position.x, pz = player.position.z;

    let best = null, bestD = Infinity;
    for (const r of REGIONS) {
      if (r.trench || r.biome === 'abyss') continue;      // nothing lives out there
      const d = Math.hypot(px - r.x, pz - r.z) - r.radius;
      if (d < bestD) { bestD = d; best = r; }
    }

    if (!best || bestD > ACTIVE_RANGE) { this.despawn(); return; }
    if (this.island !== best) this._spawn(best, game);
    else this._resize();
  }

  _spawn(region, game) {
    this.despawn();
    this.island = region;
    this._center.set(region.x, 0, region.z);
    this._buildRoosts(game, region);

    const n = this.wantCount;
    for (let i = 0; i < n; i++) this.birds.push(this._makeBird(i, n, region));
    this.active = true;
  }

  /** Grow / shrink the flock in place when quality or the particle slider moves. */
  _resize() {
    if (!this.active || !this.island) return;
    const want = this.wantCount;
    while (this.birds.length > want) {
      const b = this.birds.pop();
      this.group.remove(b.group);
    }
    while (this.birds.length < want) {
      this.birds.push(this._makeBird(this.birds.length, want, this.island));
    }
  }

  despawn() {
    for (const b of this.birds) this.group.remove(b.group);
    this.birds.length = 0;
    this._roosts.length = 0;
    this.island = null;
    this.active = false;
  }

  /** Dock rail posts double as perches. */
  _buildRoosts(game, region) {
    this._roosts.length = 0;
    let a = null;
    try { a = game.get('world')?.getAnchors(region.id); } catch { a = null; }
    const d = a?.dock;
    if (!d) return;
    const ca = Math.cos(d.angle), sa = Math.sin(d.angle);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const along = ((i + 0.5) / n - 0.5) * d.length;
      const side = (i % 2 === 0 ? 1 : -1) * (d.width * 0.5 - 0.15);
      this._roosts.push(new THREE.Vector3(
        d.x + ca * along - sa * side,
        d.y + 0.62,
        d.z + sa * along + ca * side,
      ));
    }
  }

  _makeBird(i, n, region) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.material);
    const wingL = new THREE.Mesh(this.wingGeoL, this.material);
    const wingR = new THREE.Mesh(this.wingGeoR, this.material);
    wingL.position.set(0.05, 0.035, 0.02);
    wingR.position.set(-0.05, 0.035, 0.02);
    body.castShadow = false; wingL.castShadow = false; wingR.castShadow = false;
    g.add(body, wingL, wingR);
    g.scale.setScalar(rrange(0.85, 1.25));
    this.group.add(g);

    const ang = (i / n) * TAU + rrange(-0.3, 0.3);
    const radius = region.radius * rrange(0.55, 1.2);
    const height = Math.max(12, region.peak * 0.7) + rrange(4, 26);

    const b = {
      index: i, group: g, wingL, wingR,
      pos: new THREE.Vector3(
        region.x + Math.cos(ang) * radius,
        height,
        region.z + Math.sin(ang) * radius,
      ),
      vel: new THREE.Vector3(0, 0, 0),
      target: new THREE.Vector3(),
      dive: new THREE.Vector3(),
      angle: ang,
      omega: (rchance(0.5) ? 1 : -1) * rrange(0.055, 0.115),
      radius, baseY: height,
      speed: rrange(7, 11),
      phase: Math.random() * TAU,
      flapSpeed: rrange(6.5, 9.5),
      flapAmp: 1,
      state: 'circle',
      stateT: 0,
      scatterT: 0,
      landed: false,
      roost: null,
      roostOffset: new THREE.Vector3(rrange(-0.4, 0.4), 0, rrange(-0.4, 0.4)),
      acc: 0,
      bank: 0,
    };
    b.group.position.copy(b.pos);
    return b;
  }

  // ---------------------------------------------------------------- steering

  _updateBird(b, dt, game, player, roosting) {
    const island = this.island;
    b.stateT += dt;
    if (b.scatterT > 0) b.scatterT = Math.max(0, b.scatterT - dt);

    // ---- pick a target ----
    if (roosting && b.scatterT <= 0) {
      if (!b.roost) b.roost = this._roosts[b.index % this._roosts.length];
      b.state = 'roost';
      b.target.copy(b.roost).add(b.roostOffset);
    } else {
      if (b.state === 'roost') { b.state = 'circle'; b.landed = false; b.stateT = 0; }

      if (b.state === 'dive') {
        b.target.copy(b.dive);
        if (b.pos.distanceToSquared(b.dive) < 9 || b.stateT > 7) {
          b.state = 'circle'; b.stateT = 0;
          this.game.audio?.play('splash_small', {
            position: b.pos, volume: rrange(0.18, 0.34), rate: rrange(1.05, 1.35),
            throttle: 1400, refDist: 14, rolloff: 0.85, maxDist: 90,
          });
        }
      } else {
        // Lazy orbit above the island, drifting up and down.
        b.angle += b.omega * dt * (b.scatterT > 0 ? 2.1 : 1);
        const r = b.radius + (b.scatterT > 0 ? 34 : 0);
        const y = b.baseY + Math.sin(this.game.time * 0.35 + b.phase) * 2.4
          + (b.scatterT > 0 ? 18 : 0);
        b.target.set(
          island.x + Math.cos(b.angle) * r,
          y,
          island.z + Math.sin(b.angle) * r,
        );
        // Occasionally drop on something shiny in the water.
        if (b.scatterT <= 0 && b.stateT > 4 && rchance(dt * 0.05)) {
          const a = Math.random() * TAU;
          const rr = island.radius * rrange(1.02, 1.4);
          const x = island.x + Math.cos(a) * rr, z = island.z + Math.sin(a) * rr;
          b.dive.set(x, waterHeightAt(x, z) + rrange(0.6, 1.6), z);
          b.state = 'dive'; b.stateT = 0;
        }
      }
    }

    // ---- keep clear of the player ----
    if (player) {
      const dx = b.pos.x - player.position.x, dz = b.pos.z - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 16) {
        const push = (16 - d) * 1.4;
        const inv = d > 0.01 ? 1 / d : 0;
        b.target.x += dx * inv * push;
        b.target.z += dz * inv * push;
        b.target.y += (16 - d) * 0.55;
        if (b.state === 'roost') { b.state = 'circle'; b.landed = false; b.scatterT = Math.max(b.scatterT, 1.5); }
      }
    }

    // ---- move ----
    const landing = b.state === 'roost';
    const distSq = b.pos.distanceToSquared(b.target);
    if (landing && distSq < 0.6) {
      b.landed = true;
      b.pos.lerp(b.target, 1 - Math.pow(0.001, dt));
      b.vel.multiplyScalar(Math.pow(0.02, dt));
    } else {
      b.landed = false;
      const speed = b.speed * (b.scatterT > 0 ? 1.8 : 1) * (landing ? 0.55 : 1);
      _a.copy(b.target).sub(b.pos);
      const len = _a.length();
      if (len > 0.001) _a.multiplyScalar(speed / len);
      b.vel.x = damp(b.vel.x, _a.x, 0.02, dt);
      b.vel.y = damp(b.vel.y, _a.y, 0.05, dt);
      b.vel.z = damp(b.vel.z, _a.z, 0.02, dt);
      b.pos.addScaledVector(b.vel, dt);
    }

    // Never clip through the sea or the hill.
    const floor = waterHeightAt(b.pos.x, b.pos.z) + 0.35;
    if (!b.landed && b.pos.y < floor) { b.pos.y = floor; if (b.vel.y < 0) b.vel.y *= -0.3; }

    // ---- orient + flap ----
    b.group.position.copy(b.pos);
    if (b.vel.lengthSq() > 0.04) {
      _b.copy(b.pos).add(b.vel);
      b.group.lookAt(_b);
      // Bank into the turn: cross(vel, desired) tells us which way we're pulling.
      _c.copy(b.target).sub(b.pos).normalize();
      _a.copy(b.vel).normalize();
      const turn = _a.x * _c.z - _a.z * _c.x;
      b.bank = damp(b.bank, clamp(turn * 1.6, -0.7, 0.7), 0.02, dt);
      b.group.rotateZ(b.bank);
    }

    const wantFlap = b.landed ? 0 : 1;
    b.flapAmp = damp(b.flapAmp, wantFlap, 0.001, dt);
    if (b.flapAmp > 0.01) {
      const f = Math.sin(this.game.time * b.flapSpeed * (b.scatterT > 0 ? 1.5 : 1) + b.phase);
      const s = 0.12 + f * 0.78 * b.flapAmp;      // held with a slight dihedral
      b.wingL.rotation.z = s;
      b.wingR.rotation.z = -s;
      b.wingL.rotation.x = f * 0.2 * b.flapAmp;
      b.wingR.rotation.x = f * 0.2 * b.flapAmp;
    } else {
      b.wingL.rotation.set(0, 0, 0.12);
      b.wingR.rotation.set(0, 0, -0.12);
    }
  }

  // ---------------------------------------------------------------- reactions

  scatterAll() {
    if (!this.active) return;
    for (const b of this.birds) { b.scatterT = rrange(3.5, 7); b.landed = false; b.roost = null; }
    this._callT = Math.min(this._callT, 0.15);
  }

  scatterNear(position, radius = 60) {
    if (!this.active) return;
    const r2 = radius * radius;
    let any = false;
    for (const b of this.birds) {
      if (b.pos.distanceToSquared(position) > r2) continue;
      b.scatterT = rrange(2.5, 5.5); b.landed = false; b.roost = null; any = true;
    }
    if (any) this._callT = Math.min(this._callT, 0.2);
  }

  // ---------------------------------------------------------------- audio

  _calls(dt, game, cam) {
    this._callT -= dt;
    if (this._callT > 0) return;

    let alarmed = false;
    for (const b of this.birds) if (b.scatterT > 0) { alarmed = true; break; }
    this._callT = alarmed ? rrange(0.45, 1.5) : rrange(2.5, 11);

    // Call from a bird the listener can actually hear.
    let pick = null, tries = 0;
    while (tries++ < 5) {
      const b = this.birds[(Math.random() * this.birds.length) | 0];
      if (!b) break;
      if (b.landed && !alarmed && !rchance(0.25)) continue;
      if (b.pos.distanceToSquared(cam.position) < 130 * 130) { pick = b; break; }
    }
    if (!pick) return;

    game.audio?.play('seagull', {
      position: pick.pos,
      volume: (alarmed ? rrange(0.6, 1.0) : rrange(0.32, 0.7)),
      rate: rrange(0.86, 1.2),
      throttle: alarmed ? 260 : 700,
      refDist: 14, rolloff: 0.85, maxDist: 140,
    });
  }

  // ---------------------------------------------------------------- teardown

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* */ } }
    this._offs.length = 0;
    this.despawn();
    this.game?.scene.remove(this.group);
    this.bodyGeo?.dispose();
    this.wingGeoL?.dispose();
    this.wingGeoR?.dispose();
    this.material?.dispose();
  }

  save() { return {}; }
  load() { /* flock is ambient, nothing to restore */ }
}

// ---------------------------------------------------------------------------
// Geometry — built once, shared by every gull.
// ---------------------------------------------------------------------------

/** Body capsule + orange beak, merged into one non-indexed buffer. */
function buildBodyGeometry() {
  // 1 cap segment x 6 radial = 36 tris, tapered at both ends -- the right
  // silhouette for a gull, and it keeps the whole bird under ~50 tris.
  const body = new THREE.CapsuleGeometry(0.075, 0.34, 1, 6).toNonIndexed();
  body.rotateX(Math.PI / 2);                       // lie along Z
  paint(body, (x, y) => (y > 0.02 ? MANTLE : WHITE));

  const beak = new THREE.ConeGeometry(0.03, 0.1, 3, 1, true).toNonIndexed();
  // Object3D.lookAt() aims an object's +Z at its target (only cameras look
  // down -Z), so the bird's nose belongs on +Z.
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.01, 0.26);
  paint(beak, () => BEAK);

  return mergeNonIndexed([body, beak]);
}

/**
 * A wing quad-strip: horizontal, pivoting at the shoulder, tapered and swept
 * back toward the tip so the silhouette reads as a wing rather than a plank.
 * White at the shoulder, dark grey at the last third.
 */
function buildWingGeometry(mirror) {
  const g = new THREE.PlaneGeometry(0.46, 0.26, 2, 1).toNonIndexed();
  g.rotateX(-Math.PI / 2);                         // span on X, chord on Z
  g.translate(0.23, 0, 0);                         // pivot at the shoulder
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) / 0.46;                    // 0 at the root, 1 at the tip
    p.setZ(i, p.getZ(i) * (1 - t * 0.62) - t * 0.13);  // narrow + swept back
    p.setY(i, -t * 0.025);                         // a touch of droop
  }
  g.computeVertexNormals();
  if (mirror) g.scale(-1, 1, 1);
  paint(g, (x) => _mix(WHITE, TIP, clamp01((Math.abs(x) - 0.3) / 0.16)));
  return g;
}

const _tmpCol = new THREE.Color();
function _mix(a, b, t) { return _tmpCol.copy(a).lerp(b, t); }

/** Add a per-vertex colour attribute from a position -> Color function. */
function paint(geo, fn) {
  const p = geo.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Concatenate non-indexed geometries that all carry position/normal/colour. */
function mergeNonIndexed(list) {
  let n = 0;
  for (const g of list) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    pos.set(p.array, o * 3);
    const nm = g.getAttribute('normal');
    if (nm) nor.set(nm.array, o * 3);
    const c = g.getAttribute('color');
    if (c) col.set(c.array, o * 3);
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

export default Birds;
