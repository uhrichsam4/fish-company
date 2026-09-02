import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp } from '../util/math.js';
import { worldHeight } from '../world/Terrain.js';

/**
 * Modular player building.
 *
 * Pieces snap to a grid and record what holds them up, so a structure is a
 * graph rather than a pile of props. That graph is what makes storm damage
 * mean anything: knock out a post and the wall above it loses support, and
 * the roof above that follows.
 *
 * Performance shape, which matters because a house is 100+ pieces:
 *
 *  - An intact piece is a static collider and a plain mesh. No rigid body.
 *  - Only a piece that has actually detached becomes dynamic, and only until
 *    it settles.
 *  - Support is recalculated on placement/removal/destruction, never per
 *    frame, and only walks the pieces connected to the change.
 */

const GRID = 2;            // metres; walls are one grid unit wide
const WALL_H = 2.6;

export const MATERIALS = {
  wood: { name: 'Wood', color: 0xa97443, health: 100, windResist: 0.3, waveResist: 0.25, floats: true },
  reinforced: { name: 'Reinforced Wood', color: 0x8b6239, health: 190, windResist: 0.55, waveResist: 0.5, floats: true },
  stone: { name: 'Stone', color: 0xb8b1a0, health: 340, windResist: 0.9, waveResist: 0.8, floats: false },
  metal: { name: 'Metal', color: 0x8d949a, health: 520, windResist: 0.95, waveResist: 0.92, floats: false },
};

/**
 * `supports` is what this piece can hold up; `needs` is what must be beneath
 * it. A foundation needs nothing, which is what terminates the support walk.
 */
export const PIECES = [
  { id: 'foundation', name: 'Foundation', icon: '⬜', cost: { wood: 4 }, size: [GRID, 0.4, GRID], needs: null, base: true,
    desc: 'Legs driven into the ground. Everything else needs one of these under it.' },
  { id: 'floor', name: 'Floor', icon: '▫️', cost: { wood: 3 }, size: [GRID, 0.2, GRID], needs: 'any' },
  { id: 'wall', name: 'Wall', icon: '🧱', cost: { wood: 4 }, size: [GRID, WALL_H, 0.25], needs: 'floor', vertical: true },
  { id: 'wall_window', name: 'Window Wall', icon: '🪟', cost: { wood: 5 }, size: [GRID, WALL_H, 0.25], needs: 'floor', vertical: true },
  { id: 'wall_door', name: 'Doorway', icon: '🚪', cost: { wood: 5 }, size: [GRID, WALL_H, 0.25], needs: 'floor', vertical: true },
  { id: 'post', name: 'Support Post', icon: '🪵', cost: { wood: 2 }, size: [0.3, WALL_H, 0.3], needs: 'floor', vertical: true },
  { id: 'roof', name: 'Roof', icon: '🔺', cost: { wood: 4 }, size: [GRID, 0.25, GRID], needs: 'wall' },

  // ---- ground works ----
  // These sit on terrain rather than stacking, so they can bridge the gaps
  // and slopes that make the shop and sell station awkward to reach.
  {
    id: 'walkway', name: 'Walkway', icon: '🛤️', cost: { wood: 2 },
    size: [GRID, 0.18, GRID], base: true, ground: true,
    desc: 'Boardwalk decking. Lays flat on whatever is under it.',
  },
  {
    id: 'ramp', name: 'Ramp', icon: '📐', cost: { wood: 3 },
    size: [GRID, 0.9, GRID], base: true, ground: true, ramp: true,
    desc: 'Gets you up a bank without a ladder.',
  },
  {
    id: 'seawall', name: 'Sea Wall', icon: '🧱', cost: { wood: 6, stone: 2 },
    size: [GRID, 2.4, 0.6], base: true, ground: true, defends: true,
    material: 'stone',
    desc: 'Holds the sea off what is behind it. Takes the hit so your house does not.',
  },
];
export const PIECE_BY_ID = Object.fromEntries(PIECES.map((p) => [p.id, p]));

/** Damage stages, worst last. */
export const STAGES = ['healthy', 'damaged', 'cracked', 'loose', 'detached'];

let _nextId = 1;

export class BuildSystem {
  constructor(game) {
    this.game = game;
    this.name = 'build';
    this.order = 52;
    /** @type {Map<string, object>} */
    this.pieces = new Map();
    this.root = null;
    this.mode = false;
    this.selected = 'foundation';
    this.material = 'wood';
    this.rotation = 0;
    /**
     * Snap on: pieces land on the 2 m grid and a foundation next to another
     * takes its neighbour's height, so a platform on a slope stays level
     * instead of stair-stepping down the hill. Snap off: free placement.
     */
    this.snapGrid = true;
    this.ghost = null;
    /** Pieces currently falling as debris. */
    this.debris = [];
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'player-build';
    game.scene.add(this.root);

    this._ghostMat = new THREE.MeshBasicMaterial({ color: 0x5ddb6a, transparent: true, opacity: 0.45, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this._ghostMat);
    this.ghost.visible = false;
    game.scene.add(this.ghost);

    bus.on('build:toggle', () => this.setMode(!this.mode));
    bus.on('build:select', ({ id }) => { if (PIECE_BY_ID[id]) this.selected = id; });
    bus.on('build:material', ({ id }) => { if (MATERIALS[id]) this.material = id; });
    bus.on('game:newgame', () => this.clearAll());

    // ---- authoritative multiplayer state ----
    bus.on('net:pieceDamaged', ({ id, health, detached }) => {
      const p = this.pieces.get(id);
      if (!p) return;
      this._applyingRemote = true;
      // Apply the server's number rather than re-deriving it, then let the
      // local damage path handle staging and detachment consistently.
      const delta = p.health - health;
      if (delta > 0) this.damage(p, delta);
      if (detached && !p.detached) this.detach(p);
      this._applyingRemote = false;
    });
    bus.on('net:pieceBuilt', ({ piece }) => this._applyRemoteBuild(piece));
    bus.on('net:worldPieces', ({ pieces }) => { for (const p of pieces) this._applyRemoteBuild(p); });
    bus.on('net:worldDamage', ({ damaged }) => {
      for (const d of damaged) {
        const p = this.pieces.get(d.id);
        if (!p) continue;
        this._applyingRemote = true;
        if (d.detached) this.detach(p);
        else if (d.health != null && d.health < p.health) this.damage(p, p.health - d.health);
        this._applyingRemote = false;
      }
    });
    bus.on('net:pieceRemoved', ({ id }) => {
      const p = this.pieces.get(id);
      if (p) this.remove(p, false);
    });
    return this;
  }

  setMode(on) {
    this.mode = on;
    this.ghost.visible = false;
    bus.emit('build:mode', { on });
    // The palette shows the controls now, so this only needs to mark the
    // transition rather than be the documentation.
    bus.emit('toast', {
      text: on ? '🔨 Build mode' : 'Build mode off',
      kind: on ? 'gold' : '', duration: 1600,
    });
  }

  clearAll() {
    for (const p of this.pieces.values()) this._removeMesh(p);
    this.pieces.clear();
    this.debris.length = 0;
  }

  // ---------------------------------------------------------------- geometry

  _sizeOf(def) { return def.size; }

  /**
   * Build the geometry for one piece.
   *
   * Every piece is boxes merged into a single BufferGeometry, so a finished
   * house costs one draw call per piece exactly as a bare cube did -- the
   * detail here is free at render time and paid for once at placement.
   *
   * The shapes matter more than they look like they should. A flat-shaded grey
   * box reads as a missing asset; the same box with plank gaps and corner
   * posts reads as a thing somebody built. Players judge a building system on
   * whether the first wall they place looks deliberate.
   */
  _makeMesh(def, material) {
    const m = MATERIALS[material] || MATERIALS.wood;
    const [w, h, d] = def.size;
    const parts = [];
    const box = (sx, sy, sz, px, py, pz, ry = 0) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      if (ry) g.rotateY(ry);
      g.translate(px, py, pz);
      parts.push(g);
    };

    switch (def.id) {
      case 'foundation':
      case 'walkway':
      case 'floor': {
        // Foundations get legs; see below.
        // Decking: planks with a groove between them, on a slab, with a rim.
        const thick = h * (def.id === 'foundation' ? 0.55 : 0.7);
        box(w, thick, d, 0, -h / 2 + thick / 2, 0);
        const planks = 5, pw = (w - 0.12) / planks;
        for (let i = 0; i < planks; i++) {
          box(pw - 0.055, h * 0.42, d - 0.12,
            -w / 2 + 0.06 + pw * (i + 0.5), h / 2 - h * 0.21, 0);
        }
        // Legs, long enough to read as driven into the ground on a slope.
        // A foundation that floats on a dune looks like a bug; one on stilts
        // looks like the support the player was told to place.
        if (def.id === 'foundation') for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          box(0.26, h * 4.2, 0.26, sx * (w / 2 - 0.13), -h * 1.6, sz * (d / 2 - 0.13));
        }
        break;
      }
      case 'wall':
      case 'wall_window':
      case 'wall_door': {
        // Frame first: posts, sill, head. Then infill, which is what changes
        // between the three wall types.
        for (const sx of [-1, 1]) box(0.2, h, d * 1.05, sx * (w / 2 - 0.1), 0, 0);
        box(w, 0.18, d * 1.05, 0, h / 2 - 0.09, 0);
        box(w, 0.18, d * 1.05, 0, -h / 2 + 0.09, 0);

        if (def.id === 'wall') {
          const rows = 6, rh = (h - 0.36) / rows;
          for (let i = 0; i < rows; i++) {
            box(w - 0.4, rh - 0.04, d * 0.8, 0, -h / 2 + 0.18 + rh * (i + 0.5), 0);
          }
        } else if (def.id === 'wall_window') {
          // Solid below the sill, solid above the head, open in between.
          box(w - 0.4, h * 0.3, d * 0.8, 0, -h / 2 + 0.18 + h * 0.15, 0);
          box(w - 0.4, h * 0.16, d * 0.8, 0, h / 2 - 0.18 - h * 0.08, 0);
          box(0.12, h * 0.36, d * 0.85, 0, h * 0.04, 0);           // mullion
          box(w - 0.4, 0.12, d * 0.85, 0, h * 0.04, 0);            // transom
        } else {
          // Doorway: jambs and a lintel, nothing across the opening.
          for (const sx of [-1, 1]) box(0.22, h - 0.36, d * 0.9, sx * (w / 2 - 0.42), -0.09, 0);
          box(w - 0.4, 0.22, d * 0.9, 0, h / 2 - 0.29, 0);
        }
        break;
      }
      case 'post': {
        box(w, h, d, 0, 0, 0);
        for (const s2 of [-1, 1]) {                                // corner braces
          box(0.16, 0.5, 0.5, 0, h / 2 - 0.3, s2 * 0.22);
          box(0.5, 0.5, 0.16, s2 * 0.22, h / 2 - 0.3, 0);
        }
        break;
      }
      case 'roof': {
        // A shallow gable out of stepped slats, rather than a flat lid.
        const steps = 4;
        for (let i = 0; i < steps; i++) {
          const t = i / steps;
          box(w - t * w * 0.34, h * 0.7, d, 0, h * 0.55 * t, 0);
        }
        box(w + 0.2, h * 0.6, d + 0.2, 0, -h * 0.2, 0);            // eaves
        break;
      }
      case 'ramp': {
        // Stepped, so it reads as climbable and matches how the controller
        // actually gets up it (autostep, not a slope).
        const steps = 4, sh = h / steps, sd = d / steps;
        for (let i = 0; i < steps; i++) {
          box(w, sh * (i + 1), sd, 0, -h / 2 + sh * (i + 1) / 2, d / 2 - sd * (i + 0.5));
        }
        break;
      }
      case 'seawall': {
        box(w, h, d, 0, 0, 0);
        // Battered face and a capstone: it should look like it holds water back.
        box(w, h * 0.22, d + 0.35, 0, -h / 2 + h * 0.11, 0);
        box(w + 0.12, 0.24, d + 0.18, 0, h / 2 - 0.12, 0);
        for (let i = -1; i <= 1; i++) box(0.18, h * 0.8, d + 0.14, i * (w / 3), -h * 0.05, 0);
        break;
      }
      default:
        box(w, h, d, 0, 0, 0);
    }

    const geo = parts.length === 1 ? parts[0] : (mergeGeometries(parts, false) || parts[0]);
    if (parts.length > 1) for (const g of parts) if (g !== geo) g.dispose();

    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: m.color, roughness: 0.86, flatShading: true,
    }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.noBatch = true;
    return mesh;
  }

  /** Snap a world point to the build grid. */
  snap(x, y, z, def) {
    const sx = this.snapGrid ? Math.round(x / GRID) * GRID : x;
    const sz = this.snapGrid ? Math.round(z / GRID) * GRID : z;
    let sy = y;
    if (def.ground) sy = worldHeight(sx, sz) + def.size[1] / 2 - 0.05;
    else if (def.base) {
      sy = worldHeight(sx, sz) + def.size[1] / 2;
      if (this.snapGrid) {
        // Match the neighbour up or down: a platform is one level, and which
        // side you started building from should not decide its shape.
        const n = this._neighbourBaseY(sx, sz, def);
        if (n != null) sy = n;
      }
    } else {
      // Stack on whatever is directly below at this cell.
      const below = this._topAt(sx, sz);
      if (below) sy = below.y + below.def.size[1] / 2 + def.size[1] / 2;
      else sy = worldHeight(sx, sz) + def.size[1] / 2;
    }
    return { x: sx, y: sy, z: sz };
  }

  _cellKey(x, z) { return `${Math.round(x / GRID)},${Math.round(z / GRID)}`; }

  /** Height of the highest same-kind base piece in the four adjacent cells, or null. */
  _neighbourBaseY(sx, sz, def) {
    let best = null;
    for (const p of this.pieces.values()) {
      if (p.detached || !p.def.base || p.def.ground || p.def.size[1] !== def.size[1]) continue;
      const dx = Math.abs(p.x - sx), dz = Math.abs(p.z - sz);
      const adjacent = (dx < GRID + 0.1 && dz < 0.1) || (dz < GRID + 0.1 && dx < 0.1);
      if (!adjacent) continue;
      if (best == null || p.y > best) best = p.y;
    }
    return best;
  }

  /** Highest piece occupying a grid cell. */
  _topAt(x, z) {
    let best = null;
    const key = this._cellKey(x, z);
    for (const p of this.pieces.values()) {
      if (p.detached) continue;
      if (this._cellKey(p.x, p.z) !== key) continue;
      if (!best || p.y > best.y) best = p;
    }
    return best;
  }

  canPlace(def, pos) {
    if (def.base) {
      const h = worldHeight(pos.x, pos.z);
      // Ground works are exactly the things you need at the waterline, so they
      // skip the dry-land rule that keeps houses off the beach.
      if (def.ground) {
        if (def.defends) {
          // A sea wall belongs at the water's edge or it defends nothing.
          if (h > 3.5) return { ok: false, why: 'Sea walls go at the shoreline.' };
        } else if (h < -1.5) return { ok: false, why: 'Too deep.' };
        for (const p of this.pieces.values()) {
          if (Math.abs(p.x - pos.x) < 0.1 && Math.abs(p.z - pos.z) < 0.1 && Math.abs(p.y - pos.y) < 0.6) {
            return { ok: false, why: 'Something is already there.' };
          }
        }
        return { ok: true };
      }
      // Foundations drive legs into whatever they stand on, so they only need
      // to be out of the sea and not on a cliff. The old rule wanted ground
      // above 0.6 m, which is most of the way up the beach -- in a fishing
      // game, the entire shoreline a player wants to build on was refused.
      if (h < -0.35) return { ok: false, why: 'Too deep — build back from the water.' };
      const spread = Math.max(
        Math.abs(worldHeight(pos.x + 1, pos.z) - h),
        Math.abs(worldHeight(pos.x, pos.z + 1) - h),
      );
      if (spread > 1.7) return { ok: false, why: 'Ground is too steep here.' };
      // Levelled to a neighbour: the legs reach about two metres down, and a
      // deck more than a metre into the hillside is a buried deck.
      if (pos.y - def.size[1] / 2 - h > 2.4) return { ok: false, why: 'Too high off the ground here.' };
      if (h - (pos.y + def.size[1] / 2) > 1.0) return { ok: false, why: 'Too far into the hill here.' };
    } else {
      const below = this._topAt(pos.x, pos.z);
      // Naming the fix rather than the problem. "Needs something underneath"
      // is true and useless; the player has to be told the two-step -- put a
      // foundation down first, then build on it.
      if (!below) return { ok: false, why: 'Put a Foundation here first' };
    }
    // One piece per cell per level.
    for (const p of this.pieces.values()) {
      if (Math.abs(p.x - pos.x) < 0.1 && Math.abs(p.z - pos.z) < 0.1 && Math.abs(p.y - pos.y) < 0.1) {
        return { ok: false, why: 'Something is already there.' };
      }
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------ place

  place(defId, pos, rotation = 0, material = this.material) {
    const def = PIECE_BY_ID[defId];
    if (!def) return null;
    const check = this.canPlace(def, pos);
    if (!check.ok) { bus.emit('toast', { text: check.why, kind: 'error', duration: 2200 }); return null; }

    const res = this.game.get('resources');
    if (res && !res.spend(def.cost)) return null;

    // A piece can pin its own material (a sea wall is masonry, not planks).
    const useMat = def.material || material;
    const mat = MATERIALS[useMat] || MATERIALS.wood;
    const mesh = this._makeMesh(def, useMat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.y = rotation;
    this.root.add(mesh);

    const piece = {
      id: `b${_nextId++}`, type: defId, def, material: useMat,
      x: pos.x, y: pos.y, z: pos.z, rotation,
      mesh, health: mat.health, maxHealth: mat.health,
      stage: 'healthy', detached: false, supported: true,
    };
    this.pieces.set(piece.id, piece);

    this.game.audio?.play('crate_break', { volume: 0.3, rate: 0.75, position: mesh.position.clone() });
    bus.emit('build:placed', { piece });
    if (!this._applyingRemote) {
      this.net?._send('build', {
        piece: {
          id: piece.id, type: defId, material: useMat,
          x: pos.x, y: pos.y, z: pos.z, r: rotation, maxHealth: piece.maxHealth,
        },
      });
    }
    this._recalcFrom(piece);
    return piece;
  }

  remove(piece, refund = true) {
    if (!piece || !this.pieces.has(piece.id)) return false;
    if (refund) {
      const res = this.game.get('resources');
      // Half back, rounded down: dismantling is not a free undo.
      if (res) for (const [id, n] of Object.entries(piece.def.cost)) res.add(id, Math.floor(n * 0.5));
    }
    this._removeMesh(piece);
    this.pieces.delete(piece.id);
    this.game.audio?.play('crate_break', { volume: 0.35, rate: 1.1 });
    if (!this._applyingRemote) this.net?._send('unbuild', { id: piece.id });
    this._recalcAll();
    return true;
  }

  /** Rebuild a piece someone else placed, without re-broadcasting it. */
  _applyRemoteBuild(s) {
    if (!s?.id || this.pieces.has(s.id)) return;
    const def = PIECE_BY_ID[s.type];
    if (!def) return;
    this._applyingRemote = true;
    const mat = MATERIALS[s.material] || MATERIALS.wood;
    const mesh = this._makeMesh(def, s.material);
    mesh.position.set(s.x, s.y, s.z);
    mesh.rotation.y = s.r || 0;
    this.root.add(mesh);
    this.pieces.set(s.id, {
      id: s.id, type: s.type, def, material: s.material || 'wood',
      x: s.x, y: s.y, z: s.z, rotation: s.r || 0,
      mesh, health: mat.health, maxHealth: mat.health,
      stage: 'healthy', detached: false, supported: true,
    });
    this._recalcAll();
    this._applyingRemote = false;
  }

  _removeMesh(p) {
    if (!p.mesh) return;
    this.root.remove(p.mesh);
    p.mesh.geometry?.dispose();
    p.mesh.material?.dispose();
    p.mesh = null;
  }

  // -------------------------------------------------------------- structure

  /**
   * A piece is supported if it sits on a base, or on another supported piece.
   * Walked iteratively from the foundations rather than recursively per piece,
   * so the cost is one pass over the structure and not a graph search each.
   */
  _recalcAll() {
    const byCell = new Map();
    for (const p of this.pieces.values()) {
      if (p.detached) continue;
      const k = this._cellKey(p.x, p.z);
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(p);
    }
    for (const list of byCell.values()) {
      list.sort((a, b) => a.y - b.y);
      let supported = false;
      for (const p of list) {
        if (p.def.base) supported = true;
        else if (!supported) {
          // Nothing under it in this column any more.
          if (p.supported) this._onLostSupport(p);
          continue;
        }
        p.supported = supported;
      }
    }
  }

  _recalcFrom(piece) { this._recalcAll(); }

  _onLostSupport(p) {
    p.supported = false;
    // Short delay so a collapse cascades visibly instead of the whole
    // structure vanishing on the same frame.
    p.collapseAt = this.game.time + 0.25 + Math.random() * 0.4;
  }

  // ----------------------------------------------------------------- damage

  /**
   * @param {object} piece
   * @param {number} amount
   * @param {{x,y,z}} [dir] impulse direction for the debris
   */
  /** The net system, when one is loaded and connected. */
  get net() {
    const n = this.game.get('net');
    return n?.online ? n : null;
  }

  damage(piece, amount, dir = null) {
    if (!piece || piece.detached) return;
    // Online, the server owns the ledger. Every client runs the same storm,
    // so each would independently decide a wall broke at a slightly different
    // moment and they would disagree about what is still standing. Report the
    // impact and wait to be told the result.
    const net = this.net;
    if (net && !this._applyingRemote) {
      net._send('impact', { id: piece.id, amount });
      return;
    }
    const mat = MATERIALS[piece.material] || MATERIALS.wood;
    piece.health -= amount;
    const frac = clamp01(piece.health / piece.maxHealth);
    const stage = frac > 0.75 ? 'healthy' : frac > 0.5 ? 'damaged' : frac > 0.25 ? 'cracked' : frac > 0 ? 'loose' : 'detached';
    if (stage !== piece.stage) {
      piece.stage = stage;
      // Darken as it fails, so damage is visible without extra geometry.
      if (piece.mesh) piece.mesh.material.color.setHex(mat.color).multiplyScalar(lerp(0.45, 1, frac));
      bus.emit('build:damaged', { piece, stage });
    }
    if (piece.health <= 0) this.detach(piece, dir);
  }

  /** Turn a piece into falling debris rather than deleting it. */
  detach(piece, dir = null) {
    if (piece.detached) return;
    piece.detached = true;
    piece.supported = false;
    this.debris.push({
      piece, t: 0,
      vx: (dir?.x || 0) * 3 + (Math.random() - 0.5) * 1.4,
      vy: 1.2 + Math.random(),
      vz: (dir?.z || 0) * 3 + (Math.random() - 0.5) * 1.4,
      spin: (Math.random() - 0.5) * 3,
    });
    this.game.audio?.play('crate_break', { volume: 0.5, rate: 0.8, position: piece.mesh?.position.clone() });
    bus.emit('build:detached', { piece });
    this._recalcAll();
  }

  /** Repair using resources, look-at driven from Interaction. */
  repair(piece, wood = 3) {
    if (!piece || piece.detached) return false;
    if (piece.health >= piece.maxHealth) return false;
    const res = this.game.get('resources');
    if (res && !res.spend({ wood })) return false;
    piece.health = Math.min(piece.maxHealth, piece.health + piece.maxHealth * 0.4);
    const mat = MATERIALS[piece.material] || MATERIALS.wood;
    const frac = clamp01(piece.health / piece.maxHealth);
    if (piece.mesh) piece.mesh.material.color.setHex(mat.color).multiplyScalar(lerp(0.45, 1, frac));
    piece.stage = frac > 0.75 ? 'healthy' : frac > 0.5 ? 'damaged' : 'cracked';
    this.game.audio?.play('crate_break', { volume: 0.35, rate: 1.25 });
    bus.emit('build:repaired', { piece });
    return true;
  }

  // ----------------------------------------------------------------- update

  /**
   * Storm damage. Runs at 2 Hz, not per frame, and only touches pieces the
   * water actually reaches -- a house on high ground costs nothing to check
   * because the depth test fails immediately.
   */
  _stormPass(dt, game) {
    const storm = game.get('storm');
    if (!storm) return;
    const gust = storm.windSpeed;
    const seaEvent = storm.eventActive;
    if (!seaEvent && gust < 1.8 && storm.intensity < 0.55) return;

    // Sea walls shelter what is behind them. Collected once per pass rather
    // than per piece, because the wall list is tiny and the piece list is not.
    const walls = [];
    for (const p of this.pieces.values()) if (p.def.defends && !p.detached) walls.push(p);

    for (const p of this.pieces.values()) {
      if (p.detached || !p.mesh) continue;
      const mat = MATERIALS[p.material] || MATERIALS.wood;
      const ground = worldHeight(p.x, p.z);

      // A standing sea wall within range takes the hit instead. Shelter falls
      // off with distance so one wall does not protect the whole island, and a
      // damaged wall protects proportionally less.
      let shelter = 0;
      if (!p.def.defends) {
        for (const w of walls) {
          const d = Math.hypot(w.x - p.x, w.z - p.z);
          if (d > 14) continue;
          const strength = clamp01(w.health / w.maxHealth);
          shelter = Math.max(shelter, (1 - d / 14) * strength * 0.85);
        }
      }

      // ---- wave impact ----
      const energy = storm.waveEnergyAt(p.x, p.z, p.y - p.def.size[1] / 2) * (1 - shelter);
      if (energy > 0.15) {
        // Face area matters: a wall broadside to a wave takes far more than a
        // floor slab lying flat under it.
        const area = p.def.vertical ? p.def.size[0] * p.def.size[1] : p.def.size[0] * p.def.size[2] * 0.25;
        const dmg = energy * area * (1 - mat.waveResist) * dt * 2.2;
        if (dmg > 0.01) this.damage(p, dmg);
      }

      // ---- wind ----
      // Only what is exposed: a piece with something directly above it is
      // sheltered, and roofs are what actually get taken off a house.
      if (gust > 1.8) {
        const exposed = !this._topAt(p.x, p.z) || this._topAt(p.x, p.z) === p;
        if (exposed && (p.type === 'roof' || p.def.vertical)) {
          const dmg = (gust - 1.8) * (1 - mat.windResist) * (1 - shelter * 0.5) * dt * 1.6;
          if (dmg > 0.01) this.damage(p, dmg);
        }
      }
    }
  }

  update(dt, game) {
    // Storm damage on its own slow clock.
    this._stormT = (this._stormT || 0) + dt;
    if (this._stormT >= 0.5) { this._stormPass(this._stormT, game); this._stormT = 0; }

    // Unsupported pieces come down after their stagger.
    for (const p of this.pieces.values()) {
      if (!p.detached && p.collapseAt != null && game.time >= p.collapseAt) {
        p.collapseAt = null;
        this.detach(p);
      }
    }

    // Debris. Deliberately not rigid bodies: ballistic arcs with a ground
    // stop are indistinguishable at this scale and cost nothing, which is
    // what keeps a whole house collapsing from tanking the frame rate.
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      const p = d.piece;
      if (!p.mesh) { this.debris.splice(i, 1); continue; }
      d.t += dt;
      d.vy -= 9.8 * dt;
      p.mesh.position.x += d.vx * dt;
      p.mesh.position.y += d.vy * dt;
      p.mesh.position.z += d.vz * dt;
      p.mesh.rotation.z += d.spin * dt;
      const ground = worldHeight(p.mesh.position.x, p.mesh.position.z);
      if (p.mesh.position.y <= ground + 0.15) {
        p.mesh.position.y = ground + 0.15;
        d.vy = 0; d.vx *= 0.4; d.vz *= 0.4; d.spin *= 0.4;
        if (d.t > 1.2) {
          // Settled: leave it as static wreckage.
          this.debris.splice(i, 1);
          this.pieces.delete(p.id);
        }
      }
      if (d.t > 12) { this._removeMesh(p); this.debris.splice(i, 1); this.pieces.delete(p.id); }
    }

    if (this.mode) { this._updateGhost(game); this._handleInput(game); }
    else if (this.ghost.visible) this.ghost.visible = false;
  }

  /**
   * Build-mode controls. Read through rawPressed because build mode sets
   * uiCapture -- the same mechanism that stops these keys reaching the hotbar
   * and swapping the held item mid-placement.
   */
  _handleInput(game) {
    const input = game.input;
    const player = game.get('player');
    if (!input || !player) return;

    for (let i = 0; i < PIECES.length; i++) {
      if (input.rawPressed(`Digit${i + 1}`)) {
        this.selected = PIECES[i].id;
        bus.emit('toast', { text: `${PIECES[i].icon} ${PIECES[i].name}`, kind: '', duration: 1400 });
      }
    }
    if (input.rawPressed('KeyR')) this.rotation += Math.PI / 2;
    if (input.rawPressed('KeyT')) {
      this.snapGrid = !this.snapGrid;
      bus.emit('build:snap', { on: this.snapGrid });
      bus.emit('toast', { text: this.snapGrid ? '📐 Snap to grid: on' : '📐 Snap to grid: off — free placement', kind: '', duration: 1600 });
      this._ghostWhy = null;                          // force the readout to refresh
    }

    // In cursor mode the mouse belongs to the palette. Without this, clicking
    // a tile also places whatever was already selected behind the menu.
    if (this.game.get('ui')?.cursorMode) return;

    if (input.rawMousePressed(0)) this.placeAtGhost();
    if (input.rawMousePressed(1)) {
      const target = this.targetPiece(player);
      if (target) this.remove(target);
    }
  }

  _updateGhost(game) {
    const player = game.get('player');
    if (!player) return;
    const def = PIECE_BY_ID[this.selected];
    const fwd = new THREE.Vector3();
    player.forward(fwd);
    const aim = player.eyePosition.clone().addScaledVector(fwd, 4.5);
    const pos = this.snap(aim.x, aim.y, aim.z, def);
    const check = this.canPlace(def, pos);

    const [w, h, d] = def.size;
    this.ghost.scale.set(w, h, d);
    this.ghost.position.set(pos.x, pos.y, pos.z);
    this.ghost.rotation.y = this.rotation;
    this.ghost.visible = true;
    this._ghostMat.color.setHex(check.ok ? 0x5ddb6a : 0xff5470);
    this._ghostPos = pos;
    this._ghostOk = check.ok;
    // Live, on screen, next to the ghost. A red box with the reason only
    // arriving as a toast after you click is a puzzle; the player has already
    // decided the game is broken by then.
    const sig = `${check.ok}|${check.why || ''}|${def.id}|${this.snapGrid}`;
    if (sig !== this._ghostWhy) {
      this._ghostWhy = sig;
      bus.emit('build:ghost', { ok: check.ok, why: check.why || '', piece: def.name, icon: def.icon, cost: def.cost, snap: this.snapGrid });
    }
  }

  /** Called by input handling while in build mode. */
  placeAtGhost() {
    if (!this.mode || !this._ghostOk || !this._ghostPos) return null;
    return this.place(this.selected, this._ghostPos, this.rotation);
  }

  /** Nearest placed piece the player is looking at, for removal and repair. */
  targetPiece(player, maxDist = 5) {
    const fwd = new THREE.Vector3();
    player.forward(fwd);
    let best = null, bestScore = -Infinity;
    for (const p of this.pieces.values()) {
      if (!p.mesh) continue;
      const dx = p.x - player.position.x, dy = p.y - player.eyePosition.y, dz = p.z - player.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > maxDist) continue;
      const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / (dist || 1);
      if (dot < 0.6) continue;
      const score = dot * 2 - dist * 0.1;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  save() {
    return {
      pieces: [...this.pieces.values()].filter((p) => !p.detached).map((p) => ({
        id: p.id, type: p.type, material: p.material,
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
        r: +p.rotation.toFixed(3), health: Math.round(p.health),
      })),
      nextId: _nextId,
    };
  }

  load(d) {
    this.clearAll();
    if (!d?.pieces) return;
    _nextId = d.nextId || 1;
    for (const s of d.pieces) {
      const def = PIECE_BY_ID[s.type];
      if (!def) continue;
      const mat = MATERIALS[s.material] || MATERIALS.wood;
      const mesh = this._makeMesh(def, s.material);
      mesh.position.set(s.x, s.y, s.z);
      mesh.rotation.y = s.r || 0;
      this.root.add(mesh);
      const frac = clamp01((s.health ?? mat.health) / mat.health);
      mesh.material.color.setHex(mat.color).multiplyScalar(lerp(0.45, 1, frac));
      this.pieces.set(s.id, {
        id: s.id, type: s.type, def, material: s.material || 'wood',
        x: s.x, y: s.y, z: s.z, rotation: s.r || 0,
        mesh, health: s.health ?? mat.health, maxHealth: mat.health,
        stage: frac > 0.75 ? 'healthy' : frac > 0.5 ? 'damaged' : 'cracked',
        detached: false, supported: true,
      });
    }
    this._recalcAll();
  }
}
