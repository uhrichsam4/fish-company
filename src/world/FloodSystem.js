import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, damp } from '../util/math.js';
import { worldHeight } from './Terrain.js';

/**
 * Surface water: rain accumulation, downhill flow and flash floods.
 *
 * A coarse height-field solver, not a fluid simulation. Each cell holds a
 * depth of standing water; every step, water moves from a cell to its lower
 * neighbours in proportion to the head difference. That is enough to make
 * water pool in hollows, run down valleys and reach the sea, which is the
 * gameplay — nobody can see whether the advection term is right.
 *
 * Cost control, because this is the system most able to wreck the frame rate:
 *
 *  - The grid follows the player and covers a fixed area, so cost is constant
 *    regardless of world size.
 *  - It steps at 5 Hz, not per frame.
 *  - Terrain height per cell is sampled once when the grid moves, not per
 *    step; worldHeight is the expensive call here, not the arithmetic.
 *  - The mesh is one geometry whose vertex heights and alpha are rewritten in
 *    place. No per-puddle objects.
 */

const N = 48;                 // cells per side
const CELL = 3.2;             // metres per cell -> ~154 m of coverage
const STEP_HZ = 5;
/** Below this the cell is treated as dry, which keeps the mesh sparse. */
const DRY = 0.012;
/** How much of the head difference moves per step. Above ~0.25 it oscillates. */
const FLOW = 0.22;
/** Drains constantly: rain that fell an hour ago should not still be sitting there. */
const SOAK = 0.06;

export class FloodSystem {
  constructor(game) {
    this.game = game;
    this.name = 'flood';
    this.order = 44;

    this.depth = new Float32Array(N * N);
    this.ground = new Float32Array(N * N);
    this.originX = 0;
    this.originZ = 0;
    this._acc = 0;
    this._sampled = false;
    this.mesh = null;
    /** Peak depth seen this session, for the debug panel. */
    this.peak = 0;
  }

  async init(game) {
    const geo = new THREE.PlaneGeometry(N * CELL, N * CELL, N - 1, N - 1);
    geo.rotateX(-Math.PI / 2);
    const col = new Float32Array(N * N * 4);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, opacity: 1,
      roughness: 0.16, metalness: 0.0, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'flood-water';
    this.mesh.renderOrder = 6;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    game.scene.add(this.mesh);

    bus.on('game:newgame', () => { this.depth.fill(0); this.peak = 0; });
    bus.on('flood:burst', ({ x, z, amount }) => this.addWater(x, z, amount ?? 1.2, 4));
    return this;
  }

  idx(cx, cz) { return cz * N + cx; }

  /** Re-centre the grid on the player and resample terrain. */
  _recentre(px, pz) {
    const ox = Math.round(px / CELL) * CELL - (N / 2) * CELL;
    const oz = Math.round(pz / CELL) * CELL - (N / 2) * CELL;
    if (this._sampled && ox === this.originX && oz === this.originZ) return false;

    // Shift existing water so a moving player does not drag puddles along.
    if (this._sampled) {
      const shiftX = Math.round((ox - this.originX) / CELL);
      const shiftZ = Math.round((oz - this.originZ) / CELL);
      if (shiftX || shiftZ) {
        const next = new Float32Array(N * N);
        for (let z = 0; z < N; z++) {
          for (let x = 0; x < N; x++) {
            const sx = x + shiftX, sz = z + shiftZ;
            if (sx < 0 || sx >= N || sz < 0 || sz >= N) continue;
            next[this.idx(x, z)] = this.depth[this.idx(sx, sz)];
          }
        }
        this.depth = next;
      }
    }

    this.originX = ox;
    this.originZ = oz;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        this.ground[this.idx(x, z)] = worldHeight(ox + x * CELL, oz + z * CELL);
      }
    }
    this._sampled = true;
    return true;
  }

  /** Standing water depth at a world point, for gameplay queries. */
  depthAt(x, z) {
    if (!this._sampled) return 0;
    const cx = Math.round((x - this.originX) / CELL);
    const cz = Math.round((z - this.originZ) / CELL);
    if (cx < 0 || cx >= N || cz < 0 || cz >= N) return 0;
    return this.depth[this.idx(cx, cz)];
  }

  addWater(x, z, amount, radius = 2) {
    if (!this._sampled) return;
    const cx = Math.round((x - this.originX) / CELL);
    const cz = Math.round((z - this.originZ) / CELL);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || ax >= N || az < 0 || az >= N) continue;
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        this.depth[this.idx(ax, az)] += amount * (1 - d / (radius + 1));
      }
    }
  }

  /**
   * One solver step. Water leaves a cell toward lower neighbours, split by how
   * much lower each is, capped so a cell can never give away more than it has.
   */
  _step(dt, rain) {
    const depth = this.depth;
    const ground = this.ground;
    const delta = this._delta || (this._delta = new Float32Array(N * N));
    delta.fill(0);

    if (rain > 0) {
      const add = rain * dt * 0.11;
      for (let i = 0; i < depth.length; i++) depth[i] += add;
    }

    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = this.idx(x, z);
        const d = depth[i];
        if (d <= DRY) continue;
        const head = ground[i] + d;

        let total = 0;
        const drops = this._drops || (this._drops = new Float32Array(4));
        const nbr = this._nbr || (this._nbr = new Int32Array(4));
        let n = 0;
        if (x > 0) { const j = i - 1; const dh = head - (ground[j] + depth[j]); if (dh > 0) { nbr[n] = j; drops[n] = dh; total += dh; n++; } }
        if (x < N - 1) { const j = i + 1; const dh = head - (ground[j] + depth[j]); if (dh > 0) { nbr[n] = j; drops[n] = dh; total += dh; n++; } }
        if (z > 0) { const j = i - N; const dh = head - (ground[j] + depth[j]); if (dh > 0) { nbr[n] = j; drops[n] = dh; total += dh; n++; } }
        if (z < N - 1) { const j = i + N; const dh = head - (ground[j] + depth[j]); if (dh > 0) { nbr[n] = j; drops[n] = dh; total += dh; n++; } }
        if (!n) continue;

        // Never move more than half the column, or the solver rings.
        const move = Math.min(d * 0.5, total * FLOW * dt * STEP_HZ);
        for (let k = 0; k < n; k++) {
          const share = move * (drops[k] / total);
          delta[i] -= share;
          delta[nbr[k]] += share;
        }
      }
    }

    let peak = 0;
    for (let i = 0; i < depth.length; i++) {
      let v = depth[i] + delta[i];
      // Soak away, and let anything below sea level drain to the ocean.
      v -= SOAK * dt;
      if (ground[i] < 0.15) v *= 0.82;
      depth[i] = v > 0 ? v : 0;
      if (depth[i] > peak) peak = depth[i];
    }
    this.peak = peak;
    return peak;
  }

  _updateMesh() {
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    let any = false;
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = this.idx(x, z);
        const v = i;                       // plane vertices are in the same order
        const d = this.depth[i];
        pos.array[v * 3 + 1] = this.ground[i] + Math.max(0, d) + 0.02;
        const a = d <= DRY ? 0 : clamp01(d / 0.55) * 0.72;
        if (a > 0) any = true;
        // Shallow water is browner (silt), deep is bluer.
        const deep = clamp01(d / 1.2);
        col.array[v * 4] = lerp(0.42, 0.22, deep);
        col.array[v * 4 + 1] = lerp(0.40, 0.44, deep);
        col.array[v * 4 + 2] = lerp(0.30, 0.58, deep);
        col.array[v * 4 + 3] = a;
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.position.set(this.originX + (N / 2) * CELL - CELL / 2, 0, this.originZ + (N / 2) * CELL - CELL / 2);
    this.mesh.visible = any;
  }

  update(dt, game) {
    const player = game.get('player');
    if (!player) return;
    const weather = game.get('weather');
    const rain = weather?.current?.rain ?? 0;

    this._acc += dt;
    if (this._acc < 1 / STEP_HZ) return;
    const step = this._acc;
    this._acc = 0;

    this._recentre(player.position.x, player.position.z);
    const peak = this._step(step, rain);

    // Nothing standing and no rain: skip the mesh rewrite entirely.
    if (peak <= DRY && !this.mesh.visible) return;
    this._updateMesh();

    this._applyToPlayer(player, game);
  }

  /**
   * Wading slows you, and deep enough water sweeps you along. Flow direction
   * comes from the local head gradient, so a flash flood pushes downhill
   * rather than in an arbitrary direction.
   */
  _applyToPlayer(player, game) {
    const d = this.depthAt(player.position.x, player.position.z);
    player.floodDepth = d;
    if (d <= 0.08) { player.floodDrag = 0; return; }

    // Ankle -> knee -> waist, matching the brief's bands.
    player.floodDrag = clamp01(d / 1.3) * 0.55;

    if (d > 0.45) {
      const cx = Math.round((player.position.x - this.originX) / CELL);
      const cz = Math.round((player.position.z - this.originZ) / CELL);
      if (cx > 0 && cx < N - 1 && cz > 0 && cz < N - 1) {
        const h = (x, z) => this.ground[this.idx(x, z)] + this.depth[this.idx(x, z)];
        const gx = h(cx - 1, cz) - h(cx + 1, cz);
        const gz = h(cx, cz - 1) - h(cx, cz + 1);
        const mag = Math.hypot(gx, gz);
        if (mag > 0.02) {
          const push = clamp((d - 0.45) * 2.4, 0, 3.4);
          player.position.x += (gx / mag) * push * 0.02;
          player.position.z += (gz / mag) * push * 0.02;
        }
      }
    }
  }

  save() { return { peak: +this.peak.toFixed(2) }; }
  load() { /* standing water is transient; it re-forms from weather */ }
}
