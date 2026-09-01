import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { QUEST_BY_ID } from '../data/quests.js';
import { REGION_BY_ID } from '../data/regions.js';
import { clamp, clamp01, formatDistance } from '../util/math.js';

const MAX_MARKERS = 20;
const MAX_BOAT_MARKERS = 4;   // a full marina shouldn't become a wall of pins
const EDGE = 34;          // px kept clear at the screen edge
const NEAR_FADE = 60;     // full opacity inside this
const FAR_FADE = 900;     // floor opacity beyond this

/* Scratch — nothing in the frame path allocates. */
const _v = new THREE.Vector3();

/**
 * World-space markers projected to screen: the tracked quest objective, the
 * sell station while you are holding fish, your boats and every fleet at sea.
 *
 * Off-screen markers clamp to the edge and grow a direction arrow plus a
 * distance readout. Targets are gathered at 4 Hz into a fixed pool of slot
 * objects; the per-frame path only projects and writes styles.
 */
export class Waypoints {
  constructor(game) {
    this.game = game;
    this.name = 'waypoints';
    this.order = 906;

    this.layer = null;
    /** @type {Array<{el:HTMLElement, iconEl, labelEl, distEl, arrowEl, lastX:number, lastY:number, lastDist:number, lastLabel:string, lastIcon:string, shown:boolean, off:boolean}>} */
    this.pool = [];
    /** Preallocated target slots — reused every gather, never rebuilt. */
    this.slots = [];
    for (let i = 0; i < MAX_MARKERS; i++) {
      this.slots.push({ kind: '', icon: '', label: '', color: '', x: 0, y: 0, z: 0, priority: 0 });
    }
    this.count = 0;
    this.visible = true;
    /** Reused scratch for the boat distance sort (gather runs at 4 Hz). */
    this._boatBuf = [];
    this._t = 99;
    this._offs = [];
    /** Player-placed marker from the world map. */
    this.custom = null;
  }

  async init(game) {
    const root = document.getElementById('ui-root');
    if (root) {
      this.layer = document.createElement('div');
      this.layer.id = 'waypoint-layer';
      this.layer.className = 'wp-layer';
      root.appendChild(this.layer);
      for (let i = 0; i < MAX_MARKERS; i++) this.pool.push(this._makeMarker());
    }
    this._offs.push(bus.on('hud:visible', (v) => { this.visible = v; if (this.layer) this.layer.style.display = v ? '' : 'none'; }));
    this._offs.push(bus.on('map:waypoint', ({ id }) => this.setCustom(id)));
    this._offs.push(bus.on('game:newgame', () => { this.custom = null; }));
    return this;
  }

  _makeMarker() {
    const el = document.createElement('div');
    el.className = 'wp';
    el.innerHTML = `<div class="wp-arrow"></div><div class="wp-pin"><span class="wp-icon"></span><span class="wp-label"></span></div><div class="wp-dist"></div>`;
    el.style.display = 'none';
    this.layer.appendChild(el);
    return {
      el,
      iconEl: el.querySelector('.wp-icon'),
      labelEl: el.querySelector('.wp-label'),
      distEl: el.querySelector('.wp-dist'),
      arrowEl: el.querySelector('.wp-arrow'),
      lastX: -9999, lastY: -9999, lastDist: -1, lastLabel: '', lastIcon: '',
      shown: false, off: false,
    };
  }

  setCustom(id) {
    const r = REGION_BY_ID[id];
    if (!r) return;
    if (this.custom?.id === id) { this.custom = null; bus.emit('toast', { text: 'Waypoint cleared', kind: '', duration: 1600 }); return; }
    this.custom = { id, name: r.name, x: r.x, y: 2, z: r.z };
    bus.emit('toast', { text: `📍 Waypoint set: <b>${r.name}</b>`, kind: 'info', duration: 2600 });
  }

  // ---------------------------------------------------------------- gather
  _push(kind, icon, label, color, x, y, z, priority) {
    if (this.count >= MAX_MARKERS) return;
    const s = this.slots[this.count++];
    s.kind = kind; s.icon = icon; s.label = label; s.color = color;
    s.x = x; s.y = y; s.z = z; s.priority = priority;
  }

  gather(game) {
    this.count = 0;
    const player = game.get('player');
    if (!player) return;

    // --- tracked quest objective -------------------------------------------
    const qt = this._questTarget(game);
    if (qt) this._push('quest', '🎯', qt.label, 'var(--accent)', qt.x, qt.y, qt.z, 100);

    // --- live world events carrying a beacon ---------------------------------
    // Gathered right after the quest so they survive a MAX_MARKERS overflow:
    // an event beacon is the only cue for a thing that expires on a timer.
    const events = game.get('events');
    if (events?.activeEvents?.length) {
      for (const ev of events.activeEvents) {
        const m = ev.marker;
        if (!m) continue;
        this._push('event', ev.icon || '❗', m.label || ev.title, cssHex(m.color),
          m.x, (m.y ?? 0) + 2.2, m.z, 95);
      }
    }

    // --- sell station while carrying / holding fish -------------------------
    const inv = game.get('inventory');
    const carrying = !!game.get('interaction')?.held?.pf;
    const world = game.get('world');
    if (world?.sellZones?.length && (carrying || (inv?.fish.length || 0) > 0)) {
      const z = nearest(world.sellZones, player.position);
      if (z) this._push('sell', '💰', 'Sell Station', 'var(--gold)', z.position.x, z.position.y + 1.2, z.position.z, 90);
    }

    // --- player-placed marker ----------------------------------------------
    if (this.custom) {
      this._push('custom', '📍', this.custom.name, 'var(--accent-2)', this.custom.x, this.custom.y, this.custom.z, 80);
    }

    // --- fleets at sea ------------------------------------------------------
    const fleets = game.get('fleets');
    if (fleets?.fleets?.length) {
      for (const f of fleets.fleets) {
        if (!f.position || f.state === 'docked') continue;
        this._push('fleet', '⚓', f.name, 'var(--accent-2)', f.position.x, f.position.y + 3, f.position.z, 60);
      }
    }

    // --- owned boats: nearest few, so a full marina isn't a wall of pins ------
    const boats = game.get('boats');
    if (boats?.owned?.length) {
      const near = this._boatBuf;
      near.length = 0;
      for (const b of boats.owned) {
        if (!b.position) continue;
        // A boat that is out as part of a fleet is already marked as a fleet.
        if (fleets?.fleets?.some((f) => f.boat === b && f.state !== 'docked')) continue;
        const dx = b.position.x - player.position.x, dz = b.position.z - player.position.z;
        near.push({ b, d: dx * dx + dz * dz });
      }
      near.sort((a, c) => a.d - c.d);
      for (let i = 0; i < Math.min(MAX_BOAT_MARKERS, near.length); i++) {
        const b = near[i].b;
        this._push('boat', '🚤', b.name, '#8fc9e8', b.position.x, b.position.y + 2.2, b.position.z, 40);
      }
    }
  }

  /** Where the tracked quest actually wants the player to be, if anywhere. */
  _questTarget(game) {
    const quests = game.get('quests');
    const world = game.get('world');
    if (!quests?.tracked || !world) return null;
    const q = QUEST_BY_ID[quests.tracked];
    if (!q) return null;
    const player = game.get('player');
    const activeId = world.activeRegion?.id;

    for (const o of q.objectives) {
      if (o.type === 'custom' && o.flag === 'picked_rod') {
        const it = world.interactables.find((x) => x.kind === 'pickupRod');
        if (it) return { label: q.name, x: it.position.x, y: it.position.y, z: it.position.z };
      }
      if (o.type === 'buy') {
        const it = nearest(world.interactables.filter((x) => x.kind === 'shop'), player.position);
        if (it) return { label: 'Shop', x: it.position.x, y: it.position.y, z: it.position.z };
      }
      if (o.type === 'sell' || o.type === 'money') {
        const z = nearest(world.sellZones, player.position);
        if (z) return { label: 'Sell Station', x: z.position.x, y: z.position.y + 1.2, z: z.position.z };
      }
      if (o.type === 'region' && o.id && o.id !== activeId) {
        const r = REGION_BY_ID[o.id];
        if (r) return { label: r.name, x: r.x, y: 6, z: r.z };
      }
      if (o.type === 'worker') {
        const a = world.getAnchors(activeId || 'crash');
        if (a?.hire) return { label: 'Employment Office', x: a.hire.x, y: (a.hire.y || 2) + 1.5, z: a.hire.z };
      }
      if (o.type === 'boat' || o.type === 'fleetTrip' || o.type === 'fleetCount') {
        const a = world.getAnchors(activeId || 'crash');
        if (a?.dockEnd) return { label: 'Dock', x: a.dockEnd.x, y: a.dockEnd.y + 1, z: a.dockEnd.z };
      }
      if (o.region && o.region !== activeId) {
        const r = REGION_BY_ID[o.region];
        if (r) return { label: r.name, x: r.x, y: 6, z: r.z };
      }
    }
    if (q.region && q.region !== activeId) {
      const r = REGION_BY_ID[q.region];
      if (r) return { label: r.name, x: r.x, y: 6, z: r.z };
    }
    return null;
  }

  // ---------------------------------------------------------------- update
  update(dt, game) {
    if (!this.layer || !this.visible) return;

    const ui = game.get('ui');
    if (ui?.anyOpen?.() || game.get('debug')?.open) {
      if (this._anyShown) this._hideAll();
      return;
    }

    this._t += dt;
    if (this._t >= 0.25) { this._t = 0; this.gather(game); }

    const cam = game.camera;
    const player = game.get('player');
    if (!cam || !player) return;
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W * 0.5, cy = H * 0.5;

    for (let i = 0; i < this.pool.length; i++) {
      const m = this.pool[i];
      if (i >= this.count) { this._hide(m); continue; }
      const s = this.slots[i];

      const dist = Math.hypot(s.x - player.position.x, s.y - player.position.y, s.z - player.position.z);
      _v.set(s.x, s.y, s.z).project(cam);

      let sx = (_v.x * 0.5 + 0.5) * W;
      let sy = (-_v.y * 0.5 + 0.5) * H;
      const behind = _v.z > 1;
      if (behind) { sx = W - sx; sy = H - sy; }

      let off = behind;
      if (sx < EDGE) { sx = EDGE; off = true; } else if (sx > W - EDGE) { sx = W - EDGE; off = true; }
      if (sy < EDGE) { sy = EDGE; off = true; } else if (sy > H - EDGE) { sy = H - EDGE; off = true; }
      // A behind-camera marker mirrors onto the far edge rather than the middle.
      if (behind && sx > EDGE && sx < W - EDGE && sy > EDGE && sy < H - EDGE) {
        sy = sy > cy ? H - EDGE : EDGE;
      }

      // Fade with distance; never fully invisible so a far fleet still reads.
      const fade = 1 - clamp01((dist - NEAR_FADE) / (FAR_FADE - NEAR_FADE)) * 0.68;
      const full = s.kind === 'quest' || s.kind === 'sell' || s.kind === 'event';
      const opacity = clamp(fade * (full ? 1 : 0.9), 0.22, 1);

      const ix = sx | 0, iy = sy | 0;
      if (!m.shown) { m.el.style.display = ''; m.shown = true; }
      if (ix !== m.lastX || iy !== m.lastY) {
        m.lastX = ix; m.lastY = iy;
        m.el.style.transform = `translate(${ix}px,${iy}px)`;
      }
      if (m.lastIcon !== s.icon) { m.lastIcon = s.icon; m.iconEl.textContent = s.icon; m.el.style.setProperty('--wp-col', s.color); }
      if (m.lastLabel !== s.label) { m.lastLabel = s.label; m.labelEl.textContent = s.label; }

      const dRound = dist < 100 ? Math.round(dist) : Math.round(dist / 5) * 5;
      if (dRound !== m.lastDist) { m.lastDist = dRound; m.distEl.textContent = formatDistance(dist); }

      if (m.off !== off) { m.off = off; m.el.classList.toggle('off', off); }
      if (off) m.arrowEl.style.transform = `rotate(${Math.atan2(sy - cy, sx - cx) * 57.2957795 + 90}deg)`;
      m.el.style.opacity = opacity.toFixed(2);
    }
    this._anyShown = this.count > 0;
  }

  _hide(m) { if (m.shown) { m.el.style.display = 'none'; m.shown = false; } }
  _hideAll() { for (const m of this.pool) this._hide(m); this._anyShown = false; }

  // ---------------------------------------------------------------- persist
  save() { return { custom: this.custom }; }
  load(d) { this.custom = d?.custom || null; }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.layer?.remove();
    this.layer = null;
  }
}

/** Beacon colours arrive as three.js hex numbers; the pin wants CSS. */
function cssHex(n) {
  return Number.isFinite(n) ? `#${(n >>> 0).toString(16).padStart(6, '0')}` : 'var(--gold)';
}

/** Nearest entry with a `.position` to `p`. No allocation. */
function nearest(list, p) {
  let best = null, bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e?.position) continue;
    const dx = e.position.x - p.x, dz = e.position.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
