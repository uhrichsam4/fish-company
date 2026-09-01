import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp01 } from '../util/math.js';
import { REGION_BY_ID } from '../data/regions.js';
import { worldHeight } from './Terrain.js';
import * as Props from './props/index.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeRNG } from '../util/math.js';
import { hashStr } from './World.js';

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

    this._buildScene(def);
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
    group.position.set(x, y, z);

    // Dressed stone apron, so the pad reads as built rather than painted on.
    const apron = new THREE.Mesh(
      new THREE.CylinderGeometry(PAD_RADIUS + 1.1, PAD_RADIUS + 1.25, 0.26, 30),
      new THREE.MeshStandardMaterial({ color: 0xd9d3c2, roughness: 0.95 }),
    );
    apron.position.y = 0.13;
    apron.receiveShadow = true;
    group.add(apron);

    const kerb = new THREE.Mesh(
      new THREE.TorusGeometry(PAD_RADIUS + 0.5, 0.16, 6, 32),
      new THREE.MeshStandardMaterial({ color: 0xb8b1a0, roughness: 0.9 }),
    );
    kerb.rotation.x = -Math.PI / 2;
    kerb.position.y = 0.28;
    group.add(kerb);

    const glowMat = (o) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: o, depthWrite: false, toneMapped: false,
    });

    const disc = new THREE.Mesh(new THREE.CircleGeometry(PAD_RADIUS, 40), glowMat(0.55));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.28;
    group.add(disc);

    // Concentric rings: the bullseye is what makes it read as "stand here".
    const rings = [];
    for (const [r0, r1, op] of [[PAD_RADIUS - 0.3, PAD_RADIUS, 1], [PAD_RADIUS * 0.62, PAD_RADIUS * 0.74, 0.8]]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 48), glowMat(op));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.3;
      group.add(ring);
      rings.push(ring);
    }

    // Light column. Tapered rather than a straight cylinder: a cylinder ends
    // in a hard disc edge against the sky and reads as a frosted pillar, and
    // additive blending across a doubled surface blows the colour out to
    // white. Narrowing towards the top fades it out on its own.
    const beams = [];
    for (const [rad, h, op] of [[PAD_RADIUS * 0.92, 13, 0.055], [PAD_RADIUS * 0.5, 11, 0.085]]) {
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(rad * 0.22, rad, h, 26, 1, true),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: op, depthWrite: false,
          side: THREE.DoubleSide, toneMapped: false,
        }),
      );
      beam.position.y = h / 2 + 0.3;
      group.add(beam);
      beams.push(beam);
    }

    this.root.add(group);
    return {
      id: i, x, y, z, color, group, disc, rings, beams,
      ring: rings[0], beam: beams[0],
      size: null, members: [], timer: 0, hostIsLocal: false,
    };
  }

  /**
   * A wooden noticeboard with real text on it.
   *
   * The face is a canvas texture rather than geometry: the lobby's whole job
   * is explaining the game to someone who has just arrived, and that needs
   * actual sentences, not an icon they have to guess at.
   */
  _makeSign(x, z, rot, title, lines, accent = '#2fd4c4') {
    const W = 3.4, H = 2.0, POST = 1.5;
    const group = new THREE.Group();

    const wood = new THREE.MeshStandardMaterial({ color: 0x8b6239, roughness: 0.92 });
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, POST + H * 0.5, 7), wood);
      post.position.set(sx * (W / 2 - 0.25), (POST + H * 0.5) / 2, 0);
      post.castShadow = true;
      group.add(post);
    }
    const board = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.14), wood);
    board.position.y = POST + H / 2 - 0.1;
    board.castShadow = true;
    group.add(board);

    const c = document.createElement('canvas');
    c.width = 1024; c.height = Math.round(1024 * (H / W));
    const g2 = c.getContext('2d');
    g2.fillStyle = '#f2e6cf';
    g2.fillRect(0, 0, c.width, c.height);
    g2.strokeStyle = accent; g2.lineWidth = 14;
    g2.strokeRect(18, 18, c.width - 36, c.height - 36);

    g2.textAlign = 'center';
    g2.fillStyle = '#2c3038';
    g2.font = 'bold 76px Outfit, system-ui, sans-serif';
    g2.fillText(title, c.width / 2, 116);
    g2.strokeStyle = accent; g2.lineWidth = 6;
    g2.beginPath(); g2.moveTo(c.width * 0.22, 148); g2.lineTo(c.width * 0.78, 148); g2.stroke();

    g2.font = '44px Outfit, system-ui, sans-serif';
    g2.fillStyle = '#4a4f58';
    lines.forEach((ln, i) => g2.fillText(ln, c.width / 2, 218 + i * 58));

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    // Both faces. Signs sit in open ground and players walk round the back of
    // them; a blank brown board is indistinguishable from a bug.
    const faceMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    const faceGeo = new THREE.PlaneGeometry(W - 0.16, H - 0.16);
    for (const side of [1, -1]) {
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.set(0, POST + H / 2 - 0.1, side * 0.076);
      if (side < 0) face.rotation.y = Math.PI;
      group.add(face);
    }

    group.position.set(x, worldHeight(x, z), z);
    group.rotation.y = rot;
    this.root.add(group);
    return group;
  }

  /**
   * Everything on the plaza that is not a pad: the statue players orient by,
   * the paths between the pads, and enough dressing that the island reads as a
   * built gathering place rather than an empty field with markers on it.
   */
  _buildScene(def) {
    const rng = makeRNG(hashStr('lobby-dressing'));
    const cx = def.x, cz = def.z;
    const cy = worldHeight(cx, cz);
    const place = (obj, x, z, o = {}) => {
      if (!obj) return null;
      obj.position.set(x, o.y != null ? o.y : worldHeight(x, z), z);
      if (o.rot != null) obj.rotation.y = o.rot;
      if (o.scale) obj.scale.setScalar(o.scale);
      obj.traverse?.((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
      this.root.add(obj);
      return obj;
    };

    // ---- paths from the centre out to each pad ----
    const tileMat = new THREE.MeshStandardMaterial({ color: 0xcfc8b6, roughness: 0.95 });
    const tiles = [];
    for (const pad of this.pads) {
      const dx = pad.x - cx, dz = pad.z - cz;
      const len = Math.hypot(dx, dz);
      const ux = dx / len, uz = dz / len;
      const steps = Math.floor(len / 1.5);
      for (let i = 2; i < steps; i++) {
        const t = i * 1.5;
        // Wander slightly so it looks laid by hand, not extruded.
        const off = (rng() - 0.5) * 0.7;
        const px = cx + ux * t - uz * off;
        const pz = cz + uz * t + ux * off;
        const g = new THREE.BoxGeometry(1.25 + rng() * 0.3, 0.12, 1.25 + rng() * 0.3);
        g.rotateY(Math.atan2(uz, ux) + (rng() - 0.5) * 0.3);
        g.translate(px, worldHeight(px, pz) + 0.06, pz);
        tiles.push(g);
      }
    }
    if (tiles.length) {
      const merged = mergeGeometries(tiles, false);
      if (merged) {
        const mesh = new THREE.Mesh(merged, tileMat);
        mesh.receiveShadow = true;
        this.root.add(mesh);
      }
      for (const g of tiles) g.dispose();
    }

    // ---- centrepiece ----
    place(Props.buildFishStatue?.(rng, {}), cx, cz, { y: cy, scale: 1.7 });
    // Off to one side and scaled down: at its default size it stands directly
    // in front of the statue from the spawn point and hides the landmark.
    place(Props.buildSignpost?.(rng, {}), cx + 9.5, cz + 7.5, { rot: -0.9, scale: 0.55 });

    // ---- banners between the pads, marking the plaza edge ----
    const bannerColors = [0x3d7fa6, 0xe0b23f, 0x3d7fa6, 0xe0b23f];
    // Ringing the plaza edge, not standing in it: at PAD_RING one lands square
    // on the sightline from the spawn point and hides the statue behind a pole.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bx = cx + Math.cos(a) * (PAD_RING + 9);
      const bz = cz + Math.sin(a) * (PAD_RING + 9);
      if (worldHeight(bx, bz) < 1.5) continue;
      place(Props.buildBanner?.(rng, { color: bannerColors[i] }), bx, bz, { rot: -a + Math.PI / 2 });
    }

    // ---- dressing ring: crates, barrels, nets and fencing ----
    const dressing = [
      ['buildCrate', 1], ['buildBarrel', 1], ['buildFishCrate', 1],
      ['buildRopeCoil', 1], ['buildCrate', 1], ['buildBarrel', 1],
    ];
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const r = PAD_RING + 6 + rng() * 9;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (worldHeight(x, z) < 1.2) continue;
      const [name] = dressing[i % dressing.length];
      place(Props[name]?.(rng, {}), x, z, { rot: rng() * Math.PI * 2 });
    }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const r = PAD_RING + 12;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (worldHeight(x, z) < 1.4) continue;
      place(Props.buildRopeFence?.(rng, { span: 5 }), x, z, { rot: -a });
    }

    // A stall by the plaza so arrivals have somewhere to walk towards.
    place(Props.buildTent?.(rng, {}), cx - PAD_RING - 3, cz + 4, { rot: 1.1 });

    // ---- noticeboards ----
    // Placed facing the spawn point, because a sign nobody walks past teaches
    // nobody anything.
    this._makeSign(cx - 7.5, cz + 12, 0.35, 'HOW TO START', [
      'Step onto a glowing pad.',
      'Choose how many players.',
      'Everyone on the pad goes together.',
    ], '#2fd4c4');

    this._makeSign(cx + 7.5, cz + 12, -0.35, 'HOW TO FISH', [
      'Hold LEFT MOUSE to charge a cast.',
      'Release to throw the line.',
      'Click again when the float dips.',
    ], '#ffc22e');

    this._makeSign(cx - 15, cz - 8, 1.25, 'YOUR COMPANY', [
      'Sell your catch at the shop.',
      'Buy better rods, boats and crew.',
      'Press O for the company panel.',
    ], '#43a9ff');

    this._makeSign(cx + 15, cz - 8, -1.25, 'CONTROLS', [
      'WASD move  ·  SPACE jump',
      'E interact  ·  TAB bag  ·  M map',
      'ESC for the menu.',
    ], '#b96bff');
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
      pad.disc.material.opacity = live ? 0.72 : 0.55;
      for (const [k, beam] of pad.beams.entries()) {
        const base = k === 0 ? 0.055 : 0.085;
        beam.material.opacity = base * (live ? 1.8 : 1) * (0.85 + 0.15 * Math.sin(t * 1.4 + pad.id));
      }
      for (const r of pad.rings) r.material.opacity = pulse;

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
