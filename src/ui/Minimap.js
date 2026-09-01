import { bus } from '../core/EventBus.js';
import { clamp, clamp01 } from '../util/math.js';
import { REGIONS } from '../data/regions.js';
import { worldHeight } from '../world/Terrain.js';
import { waterHeightAt } from '../world/waves.js';

/**
 * Rounded minimap, drawn to a 2D canvas.
 *
 * The land/water background is baked once per region into an offscreen canvas
 * and then blitted with a rotation each frame. Sampling terrain height per
 * pixel per frame would be thousands of `worldHeight` calls at 60 Hz for a
 * picture that only changes when you change island; baking makes it one pass.
 *
 * Markers are drawn live on top, because those do move.
 */

const SIZE = 168;          // on-screen diameter, CSS px
const BAKE = 384;          // baked terrain texture resolution
const RANGE = 190;         // world metres visible edge to edge
/**
 * How much world the bake covers. Must be wide enough that the view never
 * runs off it as the player moves away from the region centre -- baking only
 * the view width left a hard diagonal edge with flat blue past it.
 */
const BAKE_SPAN = 900;

const MARKERS = {
  shop: { icon: '🏪', color: '#ffc22e', label: 'Shop' },
  sell: { icon: '💰', color: '#5ddb6a', label: 'Sell' },
  dock: { icon: '⚓', color: '#a5bccd', label: 'Dock' },
  trap: { icon: '🪤', color: '#43a9ff', label: 'Trap' },
  npc: { icon: '💬', color: '#b96bff', label: 'NPC' },
  build: { icon: '🏠', color: '#ff9f43', label: 'Base' },
  boat: { icon: '🚤', color: '#2fd4c4', label: 'Boat' },
  quest: { icon: '❗', color: '#ffc22e', label: 'Objective' },
};

export class Minimap {
  constructor(game) {
    this.game = game;
    this.name = 'minimap';
    this.order = 96;
    this.visible = true;
    /** Rotate with the player, or keep north up. */
    this.rotate = true;
    this._bakedRegion = null;
    this._t = 0;
  }

  async init(game) {
    const wrap = document.createElement('div');
    wrap.className = 'minimap';
    wrap.innerHTML = `<canvas width="${SIZE * 2}" height="${SIZE * 2}"></canvas><div class="mm-n">N</div>`;
    (document.getElementById('ui-root') || document.body).appendChild(wrap);
    this.el = wrap;
    this.canvas = wrap.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.northEl = wrap.querySelector('.mm-n');

    this.bake = document.createElement('canvas');
    this.bake.width = this.bake.height = BAKE;
    this.bakeCtx = this.bake.getContext('2d');

    bus.on('hud:visible', (v) => { this.visible = v; wrap.classList.toggle('hidden', !v); });
    bus.on('minimap:toggleRotate', () => { this.rotate = !this.rotate; });
    return this;
  }

  /**
   * Paint the island once. Colour comes from terrain height against the local
   * sea level, so beaches, shallows and deep water read as bands.
   */
  _bakeRegion(def) {
    const ctx = this.bakeCtx;
    const img = ctx.createImageData(BAKE, BAKE);
    const d = img.data;
    const half = BAKE_SPAN / 2;
    for (let py = 0; py < BAKE; py++) {
      for (let px = 0; px < BAKE; px++) {
        const wx = def.x + ((px / BAKE) * 2 - 1) * half;
        const wz = def.z + ((py / BAKE) * 2 - 1) * half;
        const h = worldHeight(wx, wz);
        let r, g, b;
        if (h > 12) { r = 122; g = 148; b = 96; }        // high ground
        else if (h > 2.2) { r = 138; g = 168; b = 104; } // grass
        else if (h > 0.2) { r = 214; g = 198; b = 152; } // beach
        else if (h > -4) { r = 78; g = 190; b = 186; }   // shallows
        else if (h > -14) { r = 46; g = 132; b = 158; }  // shelf
        else { r = 26; g = 74; b = 110; }                // deep
        const i = (py * BAKE + px) * 4;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this._bakedRegion = def.id;
    this._bakedCentre = { x: def.x, z: def.z };
  }

  /** World XZ -> canvas XY, honouring the rotate-with-player setting. */
  _project(wx, wz, cx, cz, yaw, R) {
    const dx = wx - cx, dz = wz - cz;
    const s = R / (RANGE / 2);
    let x = dx * s, y = dz * s;
    if (this.rotate) {
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const rx = x * c - y * sn;
      const ry = x * sn + y * c;
      x = rx; y = ry;
    }
    return { x: R + x, y: R + y, dist: Math.hypot(x, y) };
  }

  update(dt, game) {
    if (!this.visible || !this.ctx) return;
    this._t += dt;
    if (this._t < 1 / 20) return;              // 20 Hz is plenty for a map
    this._t = 0;

    const player = game.get('player');
    const world = game.get('world');
    if (!player || !world) return;
    const def = world.activeRegion;
    if (!def) return;
    if (this._bakedRegion !== def.id) this._bakeRegion(def);

    const ctx = this.ctx;
    const R = SIZE;                             // canvas is 2x for retina
    const cx = player.position.x, cz = player.position.z;
    // Screen-up should be the direction the player faces.
    const yaw = this.rotate ? -player.yaw : 0;

    ctx.clearRect(0, 0, R * 2, R * 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 3, 0, Math.PI * 2);
    ctx.clip();

    // Deep water behind everything, so the sea reads as sea past the island.
    ctx.fillStyle = '#1a4a6e';
    ctx.fillRect(0, 0, R * 2, R * 2);

    // Baked island, offset so the player sits at the centre.
    ctx.save();
    ctx.translate(R, R);
    if (this.rotate) ctx.rotate(yaw);
    const pxPerM = R / (RANGE / 2);
    const bakeSpan = BAKE_SPAN * pxPerM;
    const ox = (this._bakedCentre.x - cx) * pxPerM;
    const oz = (this._bakedCentre.z - cz) * pxPerM;
    ctx.drawImage(this.bake, ox - bakeSpan / 2, oz - bakeSpan / 2, bakeSpan, bakeSpan);
    ctx.restore();

    // ---- markers ----
    const marks = [];
    const push = (kind, x, z, extra) => marks.push({ kind, x, z, ...extra });

    for (const it of world.interactables || []) {
      if (it.region !== def.id) continue;
      if (it.kind === 'shop') push('shop', it.position.x, it.position.z);
      else if (it.kind === 'sell') push('sell', it.position.x, it.position.z);
    }
    const anchors = world.anchors?.get?.(def.id);
    if (anchors?.dock) push('dock', anchors.dock.x, anchors.dock.z);
    for (const t of game.get('traps')?.traps.values() || []) push('trap', t.x, t.z);
    for (const n of game.get('npcs')?.npcs || []) {
      if (n.position) push('npc', n.position.x, n.position.z);
    }
    for (const b of game.get('boats')?.owned || []) {
      if (b.position) push('boat', b.position.x, b.position.z);
    }
    // One marker for the whole base rather than one per plank.
    const build = game.get('build');
    if (build?.pieces.size) {
      let sx = 0, sz = 0, n = 0;
      for (const p of build.pieces.values()) { sx += p.x; sz += p.z; n++; }
      if (n) push('build', sx / n, sz / n);
    }

    for (const m of marks) {
      const p = this._project(m.x, m.z, cx, cz, yaw, R);
      if (p.dist > R - 12) continue;             // off-map, skip rather than clamp
      const spec = MARKERS[m.kind] || MARKERS.quest;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = spec.color;
      ctx.globalAlpha = 0.92;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(7,13,20,.8)';
      ctx.stroke();
    }

    // ---- player arrow ----
    ctx.save();
    ctx.translate(R, R);
    if (!this.rotate) ctx.rotate(player.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7.5, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7.5, 8);
    ctx.closePath();
    ctx.fillStyle = '#eaf4fb';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0d1721';
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // North indicator rotates opposite the map so it always points north.
    if (this.northEl) {
      this.northEl.style.transform = this.rotate
        ? `rotate(${(-player.yaw * 180) / Math.PI}deg) translateY(-${SIZE * 0.42}px)`
        : `translateY(-${SIZE * 0.42}px)`;
    }
  }

  dispose() { this.el?.remove(); }
}
