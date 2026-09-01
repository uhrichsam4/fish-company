import * as THREE from 'three';
import { PARTICLES } from '../data/textureManifest.js';

/**
 * ONE 4x4 sprite atlas for every particle in the game.
 *
 * Why an atlas: each THREE material binds a single map, so a per-texture
 * particle system would mean ~10 draw calls and 10 sorted transparent passes.
 * With an atlas the whole VFX layer collapses to two draw calls (one additive,
 * one alpha-blended) plus weather.
 *
 * The atlas is a CanvasTexture that is drawn *procedurally first* so the very
 * first frame already has punchy, correctly-shaped sprites, then each authored
 * PNG from PARTICLES is blitted over its tile as it arrives. A 404 therefore
 * degrades to a hand-drawn shape rather than AssetManager's flat grey square
 * (grey squares are what makes particles read as "fuzz").
 *
 * Tiles are drawn white-on-transparent so per-particle vertex colour is the
 * only thing that tints them.
 */

export const ATLAS_COLS = 4;
const TILE_PX = 128;
/** Sprites are drawn inside this inset so linear filtering can never bleed
 *  across a tile edge (there are no mipmaps, so a 6 px gutter is plenty). */
const PAD = 6;

/** Tile index === position in the atlas, row-major. */
export const TILE = {
  smoke: 0, splash: 1, droplet: 2, bubble: 3,
  spark: 4, star: 5, ring: 6, flare: 7,
  foam: 8, dust: 9, coin: 10, chip: 11,
  cross: 12, streak: 13, blob: 14, flake: 15,
};

/** Which manifest key (if any) overrides each procedural tile. */
const PNG_FOR_TILE = {
  [TILE.smoke]: 'smoke', [TILE.splash]: 'splash', [TILE.droplet]: 'droplet',
  [TILE.bubble]: 'bubble', [TILE.spark]: 'spark', [TILE.star]: 'star',
  [TILE.ring]: 'ring', [TILE.flare]: 'flare', [TILE.foam]: 'foam_puff',
  [TILE.dust]: 'dust',
};

/**
 * Stylised VFX palette. Everything is authored in sRGB hex; THREE.Color
 * converts to the linear working space on assignment, and the particle shader
 * converts back on output, so these read exactly as picked.
 */
export const PAL = {
  foam: 0xffffff,
  foamCool: 0xd6f7ff,
  aqua: 0x7ef0ff,
  teal: 0x2fd4c4,
  sea: 0x2f9bd8,
  deep: 0x1b5f9e,
  sky: 0xbfe9ff,
  sun: 0xfff0c0,
  fire: 0xffd24a,
  fireHot: 0xfff6d8,
  ember: 0xff6a22,
  ash: 0x4a4a52,
  smoke: 0xb9bcc4,
  dustTan: 0xd8c39a,
  wood: 0xb07a44,
  woodDark: 0x6f4a24,
  stone: 0xa9a7a0,
  metal: 0xd8dee6,
  ice: 0xbdf0ff,
  flesh: 0xffd9c2,
  gold: 0xffc93c,
  goldHot: 0xfff3b0,
  bill: 0x8fe08a,
  magic: 0xc48cff,
  green: 0x7ef07a,
  volt: 0xa9d8ff,
};

// ---------------------------------------------------------------------------
// procedural tile painters — all white, alpha carries the shape
// ---------------------------------------------------------------------------

function radial(g, cx, cy, r, stops) {
  const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (const [o, a] of stops) grd.addColorStop(o, `rgba(255,255,255,${a})`);
  g.fillStyle = grd;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
}

function puff(g, cx, cy, r, blobs, seed) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 + rnd() * 0.9;
    const d = r * (0.14 + rnd() * 0.46);
    const rr = r * (0.34 + rnd() * 0.3);
    radial(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, rr, [[0, 0.95], [0.55, 0.72], [1, 0]]);
  }
  radial(g, cx, cy, r * 0.6, [[0, 1], [0.6, 0.8], [1, 0]]);
}

function starburst(g, cx, cy, r, arms, thin, len) {
  g.save();
  g.translate(cx, cy);
  for (let i = 0; i < arms; i++) {
    g.save();
    g.rotate((i / arms) * Math.PI * 2);
    const L = r * len * (i % 2 ? 0.62 : 1);
    const grd = g.createLinearGradient(0, 0, L, 0);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -r * thin); g.lineTo(L, 0); g.lineTo(0, r * thin);
    g.closePath(); g.fill();
    g.restore();
  }
  g.restore();
}

const PAINT = {
  [TILE.smoke]: (g, S) => { puff(g, S / 2, S / 2, S * 0.42, 7, 7); },
  [TILE.splash]: (g, S) => {
    const c = S / 2;
    starburst(g, c, c, S * 0.46, 10, 0.075, 1);
    radial(g, c, c, S * 0.2, [[0, 1], [0.4, 0.85], [1, 0]]);
    // flung droplets around the rim
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.31;
      const d = S * (0.3 + (i % 3) * 0.05);
      radial(g, c + Math.cos(a) * d, c + Math.sin(a) * d, S * 0.035, [[0, 1], [0.6, 0.9], [1, 0]]);
    }
  },
  [TILE.droplet]: (g, S) => {
    const c = S / 2;
    g.fillStyle = 'rgba(255,255,255,0.98)';
    g.beginPath();
    g.moveTo(c, S * 0.06);
    g.bezierCurveTo(c + S * 0.30, S * 0.48, c + S * 0.30, S * 0.90, c, S * 0.94);
    g.bezierCurveTo(c - S * 0.30, S * 0.90, c - S * 0.30, S * 0.48, c, S * 0.06);
    g.fill();
    radial(g, c - S * 0.07, S * 0.66, S * 0.13, [[0, 0.85], [1, 0]]);
  },
  [TILE.bubble]: (g, S) => {
    const c = S / 2, r = S * 0.44;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = S * 0.075;
    g.beginPath(); g.arc(c, c, r * 0.9, 0, Math.PI * 2); g.stroke();
    radial(g, c, c, r, [[0, 0.06], [0.72, 0.16], [0.92, 0.5], [1, 0]]);
    radial(g, c - r * 0.36, c - r * 0.38, r * 0.24, [[0, 1], [1, 0]]);
  },
  [TILE.spark]: (g, S) => {
    const c = S / 2;
    starburst(g, c, c, S * 0.48, 4, 0.045, 1);
    radial(g, c, c, S * 0.13, [[0, 1], [0.5, 0.9], [1, 0]]);
  },
  [TILE.star]: (g, S) => {
    const c = S / 2, R = S * 0.46, r = R * 0.4;
    g.fillStyle = 'rgba(255,255,255,0.98)';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const rad = i % 2 ? r : R;
      i ? g.lineTo(c + Math.cos(a) * rad, c + Math.sin(a) * rad)
        : g.moveTo(c + Math.cos(a) * rad, c + Math.sin(a) * rad);
    }
    g.closePath(); g.fill();
    radial(g, c, c, S * 0.22, [[0, 0.9], [1, 0]]);
  },
  [TILE.ring]: (g, S) => {
    const c = S / 2;
    const grd = g.createRadialGradient(c, c, S * 0.22, c, c, S * 0.48);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.42, 'rgba(255,255,255,0.28)');
    grd.addColorStop(0.72, 'rgba(255,255,255,1)');
    grd.addColorStop(0.92, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(c, c, S * 0.48, 0, Math.PI * 2); g.fill();
  },
  [TILE.flare]: (g, S) => {
    const c = S / 2;
    radial(g, c, c, S * 0.48, [[0, 1], [0.13, 0.95], [0.34, 0.42], [0.68, 0.09], [1, 0]]);
    starburst(g, c, c, S * 0.48, 6, 0.03, 1);
  },
  [TILE.foam]: (g, S) => { puff(g, S / 2, S / 2, S * 0.44, 9, 99); },
  [TILE.dust]: (g, S) => { puff(g, S / 2, S / 2, S * 0.4, 5, 4242); },
  [TILE.coin]: (g, S) => {
    const c = S / 2, r = S * 0.4;
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = S * 0.05;
    g.beginPath(); g.arc(c, c, r * 0.74, 0, Math.PI * 2); g.stroke();
    g.font = `bold ${Math.round(S * 0.5)}px sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillText('$', c, c + S * 0.02);
    g.globalCompositeOperation = 'source-over';
  },
  [TILE.chip]: (g, S) => {
    const c = S / 2, r = S * 0.4;
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath();
    const pts = [[-1, -0.55], [0.15, -1], [1, -0.2], [0.55, 0.85], [-0.6, 1], [-1, 0.2]];
    pts.forEach(([x, y], i) => (i ? g.lineTo(c + x * r, c + y * r) : g.moveTo(c + x * r, c + y * r)));
    g.closePath(); g.fill();
  },
  [TILE.cross]: (g, S) => {
    const c = S / 2;
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineCap = 'round';
    g.lineWidth = S * 0.13;
    const d = S * 0.3;
    g.beginPath();
    g.moveTo(c - d, c - d); g.lineTo(c + d, c + d);
    g.moveTo(c + d, c - d); g.lineTo(c - d, c + d);
    g.stroke();
  },
  [TILE.streak]: (g, S) => {
    const c = S / 2;
    const grd = g.createLinearGradient(0, 0, 0, S);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.3, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.62, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(c - S * 0.055, 0); g.lineTo(c + S * 0.055, 0);
    g.lineTo(c + S * 0.085, S); g.lineTo(c - S * 0.085, S);
    g.closePath(); g.fill();
  },
  [TILE.blob]: (g, S) => {
    // Chunky: near-solid core with a tight soft rim. This is the workhorse for
    // stylised droplets/gunk so they read as SHAPES, not as haze.
    const c = S / 2;
    radial(g, c, c, S * 0.46, [[0, 1], [0.62, 1], [0.78, 0.85], [0.94, 0.14], [1, 0]]);
  },
  [TILE.flake]: (g, S) => {
    const c = S / 2, r = S * 0.42;
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineCap = 'round';
    g.lineWidth = S * 0.055;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const ex = c + Math.cos(a) * r, ey = c + Math.sin(a) * r;
      g.beginPath(); g.moveTo(c, c); g.lineTo(ex, ey); g.stroke();
      for (const s of [-1, 1]) {
        const bx = c + Math.cos(a) * r * 0.58, by = c + Math.sin(a) * r * 0.58;
        g.beginPath(); g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(a + s * 0.85) * r * 0.3, by + Math.sin(a + s * 0.85) * r * 0.3);
        g.stroke();
      }
    }
    radial(g, c, c, r * 0.3, [[0, 0.9], [1, 0]]);
  },
};

/**
 * @returns {{texture: THREE.CanvasTexture, canvas: HTMLCanvasElement, dispose:Function}}
 * Usable immediately; authored PNGs upgrade their tile in place when they load.
 */
export function buildParticleAtlas() {
  const size = TILE_PX * ATLAS_COLS;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');

  const drawTile = (tile, painter) => {
    const cx = (tile % ATLAS_COLS) * TILE_PX, cy = Math.floor(tile / ATLAS_COLS) * TILE_PX;
    g.save();
    g.beginPath();
    g.rect(cx + PAD, cy + PAD, TILE_PX - PAD * 2, TILE_PX - PAD * 2);
    g.clip();
    g.translate(cx + PAD, cy + PAD);
    g.scale((TILE_PX - PAD * 2) / TILE_PX, (TILE_PX - PAD * 2) / TILE_PX);
    painter(g, TILE_PX);
    g.restore();
  };

  for (const key of Object.keys(PAINT)) drawTile(Number(key), PAINT[key]);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'fx-atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.premultiplyAlpha = false;
  texture.needsUpdate = true;

  const imgs = [];
  let disposed = false;
  for (const [tileStr, key] of Object.entries(PNG_FOR_TILE)) {
    const url = PARTICLES[key];
    if (!url) continue;
    const tile = Number(tileStr);
    const img = new Image();
    imgs.push(img);
    img.onload = () => {
      if (disposed) return;
      const cx = (tile % ATLAS_COLS) * TILE_PX, cy = Math.floor(tile / ATLAS_COLS) * TILE_PX;
      g.clearRect(cx, cy, TILE_PX, TILE_PX);
      try {
        g.drawImage(img, cx + PAD, cy + PAD, TILE_PX - PAD * 2, TILE_PX - PAD * 2);
      } catch { drawTile(tile, PAINT[tile]); }
      texture.needsUpdate = true;
    };
    img.onerror = () => { /* keep the procedural tile */ };
    img.src = url;
  }

  return {
    texture,
    canvas,
    dispose() {
      disposed = true;
      for (const i of imgs) { i.onload = null; i.onerror = null; i.src = ''; }
      texture.dispose();
    },
  };
}
