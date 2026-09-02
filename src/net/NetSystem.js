import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { damp, dampAngle } from '../util/math.js';
import { buildWorkerMesh } from '../workers/WorkerMesh.js';

/**
 * Multiplayer transport and remote-player rendering.
 *
 * Connects to the game server, publishes the local player's position, and
 * draws everyone else. The server owns lobby pads and identity; positions are
 * relayed rather than validated (see server/index.js for why).
 *
 * The whole system is optional: if the socket never opens the game carries on
 * exactly as single-player, because every call site checks `online`. That
 * matters on Render's free tier, where the first connection after an idle
 * spell can take the better part of a minute to wake the service.
 */

const SEND_HZ = 12;
const HEARTBEAT_MS = 5000;
/** Remote positions arrive at 15 Hz; interpolate between them or they stutter. */
const SMOOTH = 0.06;
const SNAP_DISTANCE = 18;

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function devServerUrl() {
  const { protocol, hostname, port } = window.location;
  // Vite dev ports serve the client only, so the socket lives elsewhere.
  const isDev = port && port !== '' && !['80', '443'].includes(port) && Number(port) >= 5170 && Number(port) <= 5199;
  if (isDev) return `ws://${hostname}:8787/ws`;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
}

/** Small canvas label so you can tell who is who across the island. */
function nameSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = 'rgba(0,0,0,.72)';
  g.strokeText(text, 128, 34);
  g.fillStyle = '#eaf4fb';
  g.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.9, 0.48, 1);
  return s;
}

export class NetSystem {
  constructor(game) {
    this.game = game;
    this.name = 'net';
    this.order = 47;

    this.ws = null;
    this.online = false;
    this.id = null;
    this.code = null;
    this.status = 'offline';
    /** @type {Map<string, object>} */
    this.remotes = new Map();
    this.root = null;
    this._sendAcc = 0;
    this._retry = 0;
    this._retryAt = 0;
    this._heartbeat = 0;
    this.ui = null;
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'remote-players';
    game.scene.add(this.root);
    this._buildUI();
    this.connect();

    bus.on('net:setName', ({ name }) => this.setName(name));
    bus.on('net:join', ({ code }) => this.join(code));
    this._heartbeat = window.setInterval(() => this._send('ping'), HEARTBEAT_MS);
    return this;
  }

  // ----------------------------------------------------------------------- UI

  _buildUI() {
    // Prefer the menu's dedicated slot; fall back to the overlay body so the
    // card still appears if the menu markup is ever simplified.
    const host = document.querySelector('#click-to-play [data-menu-panel="multiplayer"]')
      || document.querySelector('#click-to-play .ctp-inner');
    const root = document.getElementById('ui-root');
    if (!host || !root) return;

    const pill = document.createElement('div');
    pill.className = 'net-pill offline';
    pill.dataset.netPill = '';
    pill.innerHTML = '<i></i><span data-net-pill-text>Multiplayer offline</span>';
    root.appendChild(pill);

    const card = document.createElement('section');
    card.className = 'net-card';
    card.dataset.multiplayer = '';
    card.innerHTML = `
      <div class="net-card-head"><b>Multiplayer</b><span data-net-state>Connecting…</span></div>
      <label>Display name
        <input data-net-name maxlength="16" autocomplete="nickname" placeholder="Angler">
      </label>
      <div class="net-invite"><span>Your invite code</span><b data-net-code>— — — —</b>
        <button type="button" data-net-copy disabled>Copy</button></div>
      <div class="net-join"><input data-net-join maxlength="4" autocomplete="off" spellcheck="false" placeholder="FRIEND CODE">
        <button type="button" data-net-join-button disabled>Join</button></div>
      <p data-net-help>Friends appear when they are in the same region.</p>`;
    // The click-to-play overlay starts the game when its empty area is clicked.
    // Controls inside this card must remain editable instead.
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      card.addEventListener(type, (e) => e.stopPropagation());
    }
    host.appendChild(card);

    const name = card.querySelector('[data-net-name]');
    const join = card.querySelector('[data-net-join]');
    name.value = this.playerName();
    name.addEventListener('change', () => {
      name.value = cleanName(name.value);
      this.setName(name.value);
      this._setHelp(name.value ? 'Name saved.' : 'The server will assign an Angler name.', false);
    });
    join.addEventListener('input', () => {
      join.value = cleanCode(join.value);
      card.querySelector('[data-net-join-button]').disabled = !this.online || join.value.length !== 4;
    });
    join.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && join.value.length === 4 && this.online) this.join(join.value);
    });
    card.querySelector('[data-net-join-button]').addEventListener('click', () => this.join(join.value));
    card.querySelector('[data-net-copy]').addEventListener('click', async () => {
      if (!this.code) return;
      try {
        await navigator.clipboard.writeText(this.code);
        this._setHelp('Invite code copied.', false);
      } catch {
        this._setHelp(`Invite code: ${this.code}`, false);
      }
    });
    this.ui = { card, pill, name, join };
    this._renderUI();
  }

  _setHelp(text, error = false) {
    const el = this.ui?.card.querySelector('[data-net-help]');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', error);
  }

  _renderUI() {
    if (!this.ui) return;
    const state = this.ui.card.querySelector('[data-net-state]');
    const code = this.ui.card.querySelector('[data-net-code]');
    const copy = this.ui.card.querySelector('[data-net-copy]');
    const joinButton = this.ui.card.querySelector('[data-net-join-button]');
    const count = this.remotes.size;
    state.textContent = this.online ? `Online · ${count + 1} player${count ? 's' : ''}`
      : this.status === 'connecting' ? 'Connecting…' : 'Offline · retrying';
    state.classList.toggle('online', this.online);
    code.textContent = this.code ? this.code.split('').join(' ') : '— — — —';
    copy.disabled = !this.online || !this.code;
    joinButton.disabled = !this.online || this.ui.join.value.length !== 4;
    this.ui.pill.classList.toggle('offline', !this.online);
    this.ui.pill.querySelector('[data-net-pill-text]').textContent = this.online
      ? `Online · ${count + 1}` : 'Multiplayer offline';
  }

  // ------------------------------------------------------------------- socket

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let url;
    try { url = devServerUrl(); } catch { return; }
    this.status = 'connecting';
    let ws;
    try { ws = new WebSocket(url); } catch { this._scheduleRetry(); return; }
    this.ws = ws;
    this._renderUI();

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.online = true;
      this.status = 'online';
      this._retry = 0;
      this._send('hello', { name: this.playerName() });
      bus.emit('net:status', { online: true });
      this._renderUI();
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.online = false;
      this.status = 'offline';
      this._clearRemotes();
      bus.emit('net:status', { online: false });
      this._scheduleRetry();
      this._renderUI();
    };

    // onerror always precedes onclose; letting close do the work keeps the
    // retry in one place.
    ws.onerror = () => { if (this.ws === ws) this.status = 'offline'; };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this._handle(m);
    };
  }

  _scheduleRetry() {
    // Back off to 15 s: Render's free tier sleeps, and hammering a waking
    // service just makes it slower to come up.
    this._retry = Math.min(this._retry + 1, 6);
    this._retryAt = performance.now() + Math.min(15000, 800 * 2 ** this._retry);
  }

  _send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify({ type, ...data })); return true; } catch { return false; }
  }

  playerName() {
    try { return localStorage.getItem('fishcompany.name') || ''; } catch { return ''; }
  }

  setName(name) {
    name = cleanName(name);
    try { if (name) localStorage.setItem('fishcompany.name', name); else localStorage.removeItem('fishcompany.name'); } catch { /* private mode */ }
    this._send('hello', { name });
  }

  join(code) {
    code = cleanCode(code);
    if (code.length !== 4) { this._setHelp('Enter a four-character invite code.', true); return false; }
    if (!this._send('join', { code })) { this._setHelp('Still connecting — try again in a moment.', true); return false; }
    this._setHelp('Looking for that player…', false);
    return true;
  }

  // ----------------------------------------------------------------- messages

  _handle(m) {
    switch (m.type) {
      case 'welcome':
        this.id = m.id;
        this.code = m.code;
        this.stormSeed = m.stormSeed;
        bus.emit('net:welcome', { id: m.id, code: m.code, stormSeed: m.stormSeed });
        if (m.pads) bus.emit('net:pads', { pads: m.pads });
        // Catch up on structures built and broken before this client joined.
        if (m.pieces?.length) bus.emit('net:worldPieces', { pieces: m.pieces });
        if (m.damaged?.length) bus.emit('net:worldDamage', { damaged: m.damaged });
        this._renderUI();
        break;

      case 'build':
        if (m.by !== this.id) bus.emit('net:pieceBuilt', { piece: m.piece });
        break;

      case 'unbuild':
        if (m.by !== this.id) bus.emit('net:pieceRemoved', { id: m.id });
        break;

      case 'damage':
        // Applies to everyone including the reporter: the server's number is
        // the number, so whoever reported the impact does not end up a step
        // ahead of the rest.
        bus.emit('net:pieceDamaged', m);
        break;

      case 'players':
        this._syncPlayers(m.players || []);
        break;

      case 'left':
        this._removeRemote(m.id);
        break;

      case 'pads':
        bus.emit('net:pads', { pads: m.pads || [] });
        break;

      case 'launch':
        // Only act on a launch this client is actually part of.
        if ((m.members || []).includes(this.id)) bus.emit('net:launch', { pad: m.pad });
        break;

      case 'padFull':
        bus.emit('toast', { text: 'That pad is full.', kind: 'error', duration: 2600 });
        break;

      case 'joined':
        bus.emit('net:joined', { pad: m.pad });
        bus.emit('toast', { text: `Joined ${escapeHtml(m.host)}'s party.`, kind: 'gold', duration: 3200 });
        this._setHelp(`Joined ${m.host}'s party.`, false);
        break;

      case 'joinFailed':
        bus.emit('toast', { text: escapeHtml(m.reason || 'Could not join.'), kind: 'error', duration: 3600 });
        this._setHelp(m.reason || 'Could not join.', true);
        break;

      case 'code':
        this.code = m.code;
        this._renderUI();
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------------------ remotes

  _syncPlayers(list) {
    const seen = new Set();
    const localRegion = this.game.get('world')?.activeRegion?.id || '';
    for (const p of list) {
      if (p.id === this.id) continue;              // never draw yourself
      if (p.region !== localRegion) continue;       // never draw people on another island
      seen.add(p.id);
      let r = this.remotes.get(p.id);
      if (!r) r = this._addRemote(p);
      const regionChanged = r.region !== p.region;
      r.target.set(p.x, p.y, p.z);
      r.targetYaw = p.yaw;
      r.moving = p.moving;
      r.region = p.region;
      if (regionChanged || r.group.position.distanceToSquared(r.target) > SNAP_DISTANCE * SNAP_DISTANCE) {
        r.group.position.copy(r.target);
      }
      if (r.name !== p.name) { r.name = p.name; this._relabel(r); }
    }
    for (const id of [...this.remotes.keys()]) if (!seen.has(id)) this._removeRemote(id);
    this._renderUI();
  }

  _addRemote(p) {
    const group = new THREE.Group();
    group.name = `remote:${p.id}`;
    let body = null;
    try {
      // Seed off the id so a given player looks the same to everyone.
      const seed = [...p.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
      const chars = this.game.get('characters');
      body = chars?.available() ? chars.build() : buildWorkerMesh(seed, { role: 'fisherman', level: 1 });
    } catch { /* fall through to the placeholder */ }
    if (!body) {
      body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.32, 1.1, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0x43a9ff, roughness: 0.7 }),
      );
      body.position.y = 0.9;
    }
    group.add(body);

    const label = nameSprite(p.name || '???');
    label.position.y = 2.15;
    group.add(label);

    group.position.set(p.x, p.y, p.z);
    this.root.add(group);

    const r = {
      id: p.id, name: p.name, group, body, label,
      target: new THREE.Vector3(p.x, p.y, p.z),
      targetYaw: p.yaw || 0, yaw: p.yaw || 0, moving: false, region: p.region, bob: 0,
    };
    this.remotes.set(p.id, r);
    return r;
  }

  _relabel(r) {
    r.group.remove(r.label);
    r.label.material.map?.dispose();
    r.label.material.dispose();
    r.label = nameSprite(r.name || '???');
    r.label.position.y = 2.15;
    r.group.add(r.label);
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.root.remove(r.group);
    r.label.material.map?.dispose();
    r.label.material.dispose();
    this.remotes.delete(id);
  }

  _clearRemotes() { for (const id of [...this.remotes.keys()]) this._removeRemote(id); }

  // ------------------------------------------------------------------- update

  update(dt, game) {
    if (!this.online && performance.now() > this._retryAt) this.connect();

    const player = game.get('player');
    if (this.online && player) {
      this._sendAcc += dt;
      if (this._sendAcc >= 1 / SEND_HZ) {
        this._sendAcc = 0;
        const v = player.velocity;
        this._send('state', {
          x: +player.position.x.toFixed(2),
          y: +player.position.y.toFixed(2),
          z: +player.position.z.toFixed(2),
          yaw: +player.yaw.toFixed(3),
          region: game.get('world')?.activeRegion?.id || '',
          moving: !!v && Math.hypot(v.x, v.z) > 0.6,
        });
      }
    }

    // Interpolate toward the last known position rather than snapping, and
    // take the short way round on yaw so a remote never spins through 360.
    for (const r of this.remotes.values()) {
      r.group.position.x = damp(r.group.position.x, r.target.x, SMOOTH, dt);
      r.group.position.y = damp(r.group.position.y, r.target.y, SMOOTH, dt);
      r.group.position.z = damp(r.group.position.z, r.target.z, SMOOTH, dt);
      r.yaw = dampAngle(r.yaw, r.targetYaw, 0.001, dt);
      r.group.rotation.y = r.yaw;
      // Walk cycle on the rig when there is one; the old bob otherwise.
      r.bob = r.moving ? r.bob + dt * 9 : 0;
      const rig = r.body.userData?.rig;
      if (rig) {
        const stride = r.moving ? 1 : 0;
        const ph = r.bob;
        const swing = Math.sin(ph) * 0.6 * stride, swing2 = Math.sin(ph + Math.PI) * 0.6 * stride;
        rig.legs.L.hip.rotation.x = swing;
        rig.legs.R.hip.rotation.x = swing2;
        rig.legs.L.knee.rotation.x = Math.max(0, -Math.sin(ph) * 0.7) * stride;
        rig.legs.R.knee.rotation.x = Math.max(0, -Math.sin(ph + Math.PI) * 0.7) * stride;
        rig.arms.L.shoulder.rotation.x = swing2 * 0.7;
        rig.arms.R.shoulder.rotation.x = swing * 0.7;
        rig.hips.position.y = rig.legLen + 0.06 + Math.abs(Math.sin(ph)) * 0.035 * stride;
      } else {
        r.body.position.y = (r.body.userData?.baseY ?? 0) + (r.moving ? Math.abs(Math.sin(r.bob)) * 0.07 : 0);
      }
    }
  }

  dispose() {
    clearInterval(this._heartbeat);
    this._clearRemotes();
    try { this.ws?.close(); } catch { /* already closed */ }
    if (this.root) this.game.scene.remove(this.root);
    this.ui?.card.remove();
    this.ui?.pill.remove();
  }
}
