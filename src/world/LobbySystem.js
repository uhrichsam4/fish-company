import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp01 } from '../util/math.js';
import { REGION_BY_ID } from '../data/regions.js';
import { worldHeight } from './Terrain.js';

/**
 * The multiplayer lobby: four start pads on Lobby Island.
 *
 * Step into a pad, choose how many players the party seats (1-4), and a 22 s
 * countdown starts. Anyone else may step into the same pad until it is full or
 * the clock runs out, then everyone in it is sent to the play area together.
 *
 * There is no networking yet, so the only member is the local player. The
 * shape of the state is the point: a pad is {hostId, size, members[], timer},
 * which is exactly what a server would own and broadcast. When the transport
 * lands it drives these same fields and the UI does not change.
 */

const COUNTDOWN = 22;
const PAD_RADIUS = 3.6;
const PAD_COUNT = 4;
/** Distance from the island centre the pads sit at. */
const PAD_RING = 21;

const PAD_COLORS = [0x2fd4c4, 0xffc22e, 0x43a9ff, 0xb96bff];

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export class LobbySystem {
  constructor(game) {
    this.game = game;
    this.name = 'lobby';
    this.order = 46;
    /** @type {Array<object>} */
    this.pads = [];
    this.root = null;
    this.el = null;
    /** Pad the local player is standing in, if any. */
    this.current = null;
    this._lastPromptPad = null;
    this._suppressed = false;
    this._cursorFree = false;
    this._insidePad = null;
    this._remotePadId = null;
  }

  async init(game) {
    const def = REGION_BY_ID.lobby;
    if (!def) return this;                     // no lobby island in this build

    this.root = new THREE.Group();
    this.root.name = 'lobby-pads';
    game.scene.add(this.root);

    for (let i = 0; i < PAD_COUNT; i++) {
      const ang = (i / PAD_COUNT) * Math.PI * 2 + Math.PI / 4;
      const x = def.x + Math.cos(ang) * PAD_RING;
      const z = def.z + Math.sin(ang) * PAD_RING;
      const y = worldHeight(x, z);
      this.pads.push(this._makePad(i, x, y, z));
    }

    this._buildUI();
    bus.on('game:newgame', () => this.leave());

    // When a server is present it owns pad state; mirror its snapshots onto
    // the local pads so the visuals and UI have one source either way.
    bus.on('net:pads', ({ pads }) => this._applyServerPads(pads));
    bus.on('net:launch', ({ pad }) => {
      const p = this.pads[pad | 0];
      if (p) this.launch(p);
    });
    bus.on('net:joined', ({ pad }) => {
      const p = this.pads[pad | 0];
      if (!p) return;
      this.current = p;
      this._remotePadId = p.id;
      this._render();
    });
    return this;
  }

  /** The net system, when one is loaded and actually connected. */
  get net() {
    const n = this.game.get('net');
    return n?.online ? n : null;
  }

  _applyServerPads(list) {
    for (const snap of list || []) {
      const pad = this.pads[snap.id];
      if (!pad) continue;
      pad.size = snap.size;
      pad.timer = snap.timer;
      pad.members = snap.members || [];
    }
    if (this._remotePadId != null) {
      const remotePad = this.pads[this._remotePadId];
      const me = this.net?.id;
      if (remotePad && me && remotePad.members.some((m) => m.id === me)) this.current = remotePad;
      else { this.current = null; this._remotePadId = null; }
    }
    // A pad the local player was standing in may have been emptied by the
    // server (host left, party launched); drop the panel rather than showing
    // a countdown nobody is in.
    if (this.current && !this._insidePad) {
      const me = this.net?.id;
      if (this.current.size == null || (me && !this.current.members.some((m) => m.id === me))) {
        this.current = null;
        this._remotePadId = null;
      }
    }
    this._render();
  }

  // ------------------------------------------------------------------ visuals

  _makePad(i, x, y, z) {
    const color = PAD_COLORS[i % PAD_COLORS.length];
    const group = new THREE.Group();
    group.position.set(x, y + 0.04, z);

    // Flat disc, slightly proud of the sand so it reads from across the island.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(PAD_RADIUS, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false }),
    );
    disc.rotation.x = -Math.PI / 2;
    group.add(disc);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(PAD_RADIUS - 0.45, PAD_RADIUS, 56),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, toneMapped: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    // A soft column so a pad is visible from ground level, not just from above.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(PAD_RADIUS * 0.92, PAD_RADIUS * 0.92, 5, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    beam.position.y = 2.5;
    group.add(beam);

    this.root.add(group);
    return {
      id: i, x, y, z, color, group, ring, disc, beam,
      /** null until someone picks a size. */
      size: null,
      members: [],
      timer: 0,
      hostIsLocal: false,
    };
  }

  // ----------------------------------------------------------------------- UI

  _buildUI() {
    const el = document.createElement('div');
    el.className = 'lobby-overlay';
    el.style.cssText = `
      position:fixed; left:50%; bottom:11%; transform:translateX(-50%);
      width:min(440px,92vw); padding:16px 18px; z-index:60;
      background:var(--bg-1,#0d1721); border:1px solid var(--line,#2b455e);
      border-radius:14px; box-shadow:0 18px 48px rgba(0,0,0,.55);
      font-family:var(--font,system-ui); color:var(--ink,#eaf4fb);
      display:none; text-align:center;`;
    document.body.appendChild(el);
    this.el = el;

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      e.preventDefault();
      const act = b.dataset.act;
      if (act === 'size') this.choose(parseInt(b.dataset.n, 10));
      else if (act === 'leave') this.leave();
    });
  }

  /** True while the pad panel is showing and should own the cursor. */
  get panelOpen() { return !!this.current && !this._suppressed; }

  /**
   * Release the mouse when the panel appears and take it back when it goes,
   * matching what Panel.show()/close() do. Without this the pointer is still
   * locked to the camera and the buttons cannot be clicked at all.
   */
  _syncCursor() {
    const want = this.panelOpen;
    if (want === this._cursorFree) return;
    this._cursorFree = want;
    const input = this.game.input;
    if (want) input.exitLock();
    else if (!this.game.get('ui')?.anyOpen?.()) input.requestLock();
  }

  _render() {
    if (!this.el) return;
    // A real panel (pause, inventory) outranks the pad prompt; showing both at
    // once puts two dialogs on screen fighting over the same click.
    this._suppressed = !!this.game.get('ui')?.anyOpen?.();
    const pad = this._suppressed ? null : this.current;
    this._syncCursor();
    if (!pad) { this.el.style.display = 'none'; return; }
    this.el.style.display = 'block';
    const hex = `#${pad.color.toString(16).padStart(6, '0')}`;

    if (pad.size == null) {
      if (this._remotePadId === pad.id) {
        this.el.innerHTML = `
          <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${hex};font-weight:800">
            Start pad ${pad.id + 1}</div>
          <div style="font-size:19px;font-weight:900;margin:7px 0 5px">Waiting for the host</div>
          <div style="font-size:12.5px;color:var(--ink-faint,#6f8ba1);margin-bottom:12px">
            The party will open as soon as they choose its size.</div>
          <button data-act="leave" style="
            padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;
            background:transparent;color:var(--ink-dim,#a5bccd);
            border:1px solid var(--line,#2b455e);border-radius:9px;font-family:inherit">Leave party</button>`;
        return;
      }
      this.el.innerHTML = `
        <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${hex};font-weight:800">
          Start pad ${pad.id + 1}</div>
        <div style="font-size:19px;font-weight:900;margin:6px 0 14px">How many players?</div>
        <div style="display:flex;gap:9px;justify-content:center">
          ${[1, 2, 3, 4].map((n) => `
            <button data-act="size" data-n="${n}" style="
              flex:1;padding:14px 0;font-size:22px;font-weight:900;cursor:pointer;
              background:var(--bg-2,#142333);color:var(--ink,#eaf4fb);
              border:1px solid var(--line,#2b455e);border-radius:10px;font-family:inherit">${n}</button>`).join('')}
        </div>
        <div style="margin-top:11px;font-size:12.5px;color:var(--ink-faint,#6f8ba1)">
          Click, or press <b style="color:var(--ink,#eaf4fb)">1</b>-<b style="color:var(--ink,#eaf4fb)">4</b>.
          Esc to step off.</div>`;
      return;
    }

    const secs = Math.max(0, Math.ceil(pad.timer));
    const frac = clamp01(pad.timer / COUNTDOWN);
    const slots = Array.from({ length: pad.size }, (_, i) => {
      const m = pad.members[i];
      return `<div style="
        flex:1;padding:9px 0;border-radius:9px;font-size:12.5px;font-weight:700;
        background:${m ? hex : 'var(--bg-2,#142333)'};
        color:${m ? '#08131b' : 'var(--ink-faint,#6f8ba1)'};
        border:1px solid ${m ? hex : 'var(--line,#2b455e)'}">${m ? escapeHtml(m.name) : 'open'}</div>`;
    }).join('');

    this.el.innerHTML = `
      <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${hex};font-weight:800">
        Start pad ${pad.id + 1}</div>
      <div style="font-size:34px;font-weight:900;margin:2px 0 8px;font-variant-numeric:tabular-nums">${secs}</div>
      <div style="height:5px;border-radius:3px;background:var(--bg-3,#1d3145);overflow:hidden;margin-bottom:12px">
        <i style="display:block;height:100%;width:${frac * 100}%;background:${hex}"></i></div>
      <div style="display:flex;gap:7px;margin-bottom:12px">${slots}</div>
      <div style="font-size:12.5px;color:var(--ink-faint,#6f8ba1);margin-bottom:10px">
        ${pad.members.length} of ${pad.size} aboard · heading out when the clock runs down</div>
      <button data-act="leave" style="
        padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;
        background:transparent;color:var(--ink-dim,#a5bccd);
        border:1px solid var(--line,#2b455e);border-radius:9px;font-family:inherit">Leave pad</button>`;
  }

  // -------------------------------------------------------------------- state

  /** Local player picks how many the party seats and starts the clock. */
  choose(n) {
    const pad = this.current;
    if (!pad || pad.size != null) return;
    if (this.net) {
      // Server owns the clock; it will echo the pad back to everyone.
      this.net._send('padSize', { pad: pad.id, size: n | 0 });
      return;
    }
    pad.size = Math.max(1, Math.min(PAD_COUNT, n | 0));
    pad.timer = COUNTDOWN;
    pad.hostIsLocal = true;
    if (!pad.members.length) pad.members.push({ id: 'local', name: 'You', local: true });
    this.game.audio?.play('levelup', { volume: 0.5 });
    bus.emit('lobby:opened', { pad: pad.id, size: pad.size });
    this._render();
  }

  /** Step out of the pad, cancelling it if the local player opened it. */
  leave() {
    const pad = this.current;
    this.current = null;
    this._remotePadId = null;
    if (this.net) { this.net._send('padLeave', {}); this._render(); return; }
    if (!pad) { this._render(); return; }
    pad.members = pad.members.filter((m) => !m.local);
    if (pad.hostIsLocal && !pad.members.length) { pad.size = null; pad.timer = 0; pad.hostIsLocal = false; }
    bus.emit('lobby:left', { pad: pad.id });
    this._render();
  }

  /** Countdown finished: send everyone in the pad to the play area. */
  launch(pad) {
    const world = this.game.get('world');
    const spawn = world?.getAnchors?.('crash')?.spawn;
    bus.emit('lobby:launch', { pad: pad.id, members: pad.members.map((m) => m.id) });
    pad.size = null; pad.timer = 0; pad.members = []; pad.hostIsLocal = false;
    this.current = null;
    this._remotePadId = null;
    this._render();
    if (spawn) this.game.get('player')?.teleport(spawn.x, spawn.y + 1.5, spawn.z);
    this.game.audio?.play('levelup', { volume: 0.7 });
    bus.emit('toast', { text: '🎣 Heading out — good luck!', kind: 'gold', duration: 3600 });
  }

  // ------------------------------------------------------------------- update

  update(dt, game) {
    if (!this.pads.length) return;
    const player = game.get('player');
    if (!player) return;
    const px = player.position.x, pz = player.position.z;
    const t = performance.now() / 1000;
    const net = this.net;
    const online = !!net;

    let inside = null;
    for (const pad of this.pads) {
      const d = Math.hypot(px - pad.x, pz - pad.z);
      if (d < PAD_RADIUS) inside = pad;

      // Idle pads breathe; a running one pulses on the second.
      const live = pad.size != null;
      const pulse = live ? 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI)) : 0.55 + 0.2 * Math.sin(t * 1.6 + pad.id);
      pad.ring.material.opacity = pulse;
      pad.disc.material.opacity = live ? 0.5 : 0.34;
      pad.beam.material.opacity = live ? 0.28 : 0.16;

      // Offline, this client runs the clock. Online, the server does and its
      // snapshots overwrite pad.timer -- ticking here too would race it and
      // make the countdown stutter between two sources of truth.
      if (live && !online) {
        pad.timer -= dt;
        if (pad.timer <= 0) { this.launch(pad); return; }
        // Full parties do not wait out the clock.
        if (pad.members.length >= pad.size && pad.timer > 2) pad.timer = Math.min(pad.timer, 2);
      }
    }

    // Entering a pad selects it; walking out of one you have not committed to
    // drops it, so brushing past a pad does not trap you in a menu.
    this._insidePad = inside;
    if (inside && this._remotePadId != null && inside.id !== this._remotePadId) this._remotePadId = null;
    if (inside !== this.current) {
      // Joining with an invite code intentionally keeps the player in a party
      // without requiring them to stand on the host's physical pad.
      if (!inside && this._remotePadId === this.current?.id) {
        if (this.current?.size != null) this._render();
        return;
      }
      const wasIn = this.current;
      if (inside) {
        this.current = inside;
        if (inside !== this._lastPromptPad) {
          this._lastPromptPad = inside;
          game.audio?.play('pickup', { volume: 0.35, rate: 1.4 });
          if (online) net._send('padJoin', { pad: inside.id });
        }
      } else {
        // Stepping out of a pad leaves the party. Offline that only matters
        // for the panel; online the server has to be told or you occupy a
        // slot from across the island.
        this.current = null;
        if (online && wasIn) net._send('padLeave', {});
      }
      this._render();
    }
    if (!inside) this._lastPromptPad = null;

    // 1-4 choose the party size. rawPressed, because uiCapture is set while
    // the panel is open -- which is exactly what stops these same keys
    // reaching the hotbar and swapping the held item underneath the dialog.
    if (this.panelOpen && this.current && this.current.size == null) {
      for (let n = 1; n <= PAD_COUNT; n++) {
        if (game.input.rawPressed(`Digit${n}`)) { this.choose(n); break; }
      }
    }

    // A panel opening over the top has to re-run the render (which drops the
    // prompt and hands the cursor back); otherwise just keep the cursor state
    // honest without rebuilding the DOM every frame.
    const suppressed = !!game.get('ui')?.anyOpen?.();
    if (suppressed !== this._suppressed) this._render();
    else this._syncCursor();

    if (this.current?.size != null && !suppressed) this._render();
  }

  dispose() {
    this.el?.remove();
    if (this.root) this.game.scene.remove(this.root);
  }
}
