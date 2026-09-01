/**
 * Fish Company multiplayer server.
 *
 * One process serves both the built client and the WebSocket game socket, so
 * there is a single origin, a single Render service, and no CORS or mixed
 * ws/wss to get wrong.
 *
 * The server is authoritative over exactly two things:
 *
 *   1. Lobby pads -- who is standing in one, how many it seats, and the
 *      countdown. These have to be authoritative or two clients disagree
 *      about when a party launches and players end up in different worlds.
 *   2. Player identity.
 *
 * Everything else (physics, fish, economy) is still client-owned and merely
 * relayed. That is deliberate: relaying a position that turns out to be wrong
 * costs a visual glitch, whereas an authoritative world needs the whole
 * simulation moved server-side. Presence first, world state later.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = process.env.PORT || 8787;

const TICK_HZ = 15;
const COUNTDOWN = 22;
const PAD_COUNT = 4;
/** Drop a client we have not heard from in this long. */
const TIMEOUT_MS = 15000;
const WORLD_LIMIT = 2500;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.hdr': 'application/octet-stream',
};

// --------------------------------------------------------------- static files

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }

  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // Contain the path: a request for /../../etc/passwd must not escape dist.
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end('forbidden'); return; }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    // Only fall back for navigations. Serving index.html in place of a missing
    // .js turns a plain 404 into "expected a module, got text/html", which
    // reads like a server misconfiguration rather than a missing build file.
    if (path.extname(file)) { res.writeHead(404); res.end('not found'); return; }
    // SPA fallback so a deep link still boots the game.
    if (existsSync(path.join(DIST, 'index.html'))) {
      const body = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end('not built yet — run `npm run build`');
    }
  }
});

// ------------------------------------------------------------------ game state

/** @type {Map<string, object>} id -> client */
const clients = new Map();
const pads = Array.from({ length: PAD_COUNT }, (_, id) => ({
  id, size: null, members: [], timer: 0, hostId: null,
}));

let nextId = 1;
const newId = () => `p${nextId++}`;

/** Four-character room codes, avoiding letters that misread aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  for (let attempt = 0; attempt < 64; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    if (![...clients.values()].some((client) => client.code === c)) return c;
  }
  return `${Date.now().toString(36).toUpperCase()}XXXX`.slice(-4);
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const cleanName = (value) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);

function send(ws, type, data) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type, ...data })); } catch { /* socket dying */ }
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const c of clients.values()) {
    if (c.ws.readyState === c.ws.OPEN) { try { c.ws.send(msg); } catch { /* ignore */ } }
  }
}

const padView = () => pads.map((p) => ({
  id: p.id,
  size: p.size,
  timer: Math.max(0, Math.round(p.timer * 10) / 10),
  members: p.members.map((id) => ({ id, name: clients.get(id)?.name || '???' })),
}));

const broadcastPads = () => broadcast('pads', { pads: padView() });

function removeFromPads(id, { silent = false } = {}) {
  let touched = false;
  for (const pad of pads) {
    const i = pad.members.indexOf(id);
    if (i < 0) continue;
    pad.members.splice(i, 1);
    touched = true;
    // The host leaving does not strand the others: the pad keeps running and
    // the next member inherits it.
    if (pad.hostId === id) pad.hostId = pad.members[0] || null;
    if (!pad.members.length) { pad.size = null; pad.timer = 0; pad.hostId = null; }
  }
  if (touched && !silent) broadcastPads();
  return touched;
}

// --------------------------------------------------------------------- sockets

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

wss.on('connection', (ws) => {
  const id = newId();
  // Protocol-level liveness. A socket whose peer vanished without a close
  // frame -- a killed tab, a dropped phone, a proxy timing out -- otherwise
  // sits in `clients` forever as a player standing motionless in the lobby.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; const c = clients.get(id); if (c) c.lastSeen = Date.now(); });
  const client = {
    id, ws, name: `Angler ${id.slice(1)}`, code: makeCode(),
    x: 0, y: 3, z: 0, yaw: 0, region: 'lobby', moving: false,
    lastSeen: Date.now(), friends: new Set(),
  };
  clients.set(id, client);

  send(ws, 'welcome', { id, code: client.code, pads: padView(), countdown: COUNTDOWN });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    client.lastSeen = Date.now();

    switch (m.type) {
      case 'hello':
        if (typeof m.name === 'string' && cleanName(m.name)) client.name = cleanName(m.name);
        break;

      case 'state':
        // Trusted from the client on purpose; see the header note.
        if (Number.isFinite(m.x)) client.x = clamp(m.x, -WORLD_LIMIT, WORLD_LIMIT);
        if (Number.isFinite(m.y)) client.y = clamp(m.y, -1600, 300);
        if (Number.isFinite(m.z)) client.z = clamp(m.z, -WORLD_LIMIT, WORLD_LIMIT);
        if (Number.isFinite(m.yaw)) client.yaw = m.yaw;
        if (typeof m.region === 'string') client.region = m.region.slice(0, 24);
        client.moving = !!m.moving;
        break;

      case 'ping':
        send(ws, 'pong', { now: Date.now() });
        break;

      case 'padJoin': {
        const pad = pads[m.pad | 0];
        if (!pad) break;
        removeFromPads(id, { silent: true });
        // A pad that has already been sized is joinable only while it has room.
        if (pad.size != null && pad.members.length >= pad.size) { send(ws, 'padFull', { pad: pad.id }); broadcastPads(); break; }
        pad.members.push(id);
        if (!pad.hostId) pad.hostId = id;
        broadcastPads();
        break;
      }

      case 'padSize': {
        const pad = pads[m.pad | 0];
        // Only the host sizes the pad, and only once, so a late joiner cannot
        // resize a party out from under the people already waiting in it.
        if (!pad || pad.hostId !== id || pad.size != null) break;
        pad.size = Math.max(1, Math.min(PAD_COUNT, m.size | 0));
        pad.timer = COUNTDOWN;
        broadcastPads();
        break;
      }

      case 'padLeave':
        removeFromPads(id);
        break;

      case 'code':
        send(ws, 'code', { code: client.code });
        break;

      case 'join': {
        // Join a friend by their code: drop into whichever pad they are in.
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
        const target = [...clients.values()].find((c) => c.code === code);
        if (!target) { send(ws, 'joinFailed', { reason: 'No player with that code is online.' }); break; }
        const pad = pads.find((p) => p.members.includes(target.id));
        if (!pad) { send(ws, 'joinFailed', { reason: `${target.name} is not waiting on a pad.` }); break; }
        if (pad.size != null && pad.members.length >= pad.size) { send(ws, 'joinFailed', { reason: 'That party is full.' }); break; }
        removeFromPads(id, { silent: true });
        pad.members.push(id);
        send(ws, 'joined', { pad: pad.id, host: target.name });
        broadcastPads();
        break;
      }

      default:
        break;
    }
  });

  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    clients.delete(id);
    removeFromPads(id);
    broadcast('left', { id });
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

// ----------------------------------------------------------------------- ticks

// Ping every client; anything that has not ponged since the last sweep is gone.
setInterval(() => {
  for (const c of [...clients.values()]) {
    const { ws } = c;
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* already gone */ }
      clients.delete(c.id);
      removeFromPads(c.id);
      broadcast('left', { id: c.id });
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* socket dying */ }
  }
}, 8000);

setInterval(() => {
  const now = Date.now();

  for (const c of [...clients.values()]) {
    if (now - c.lastSeen > TIMEOUT_MS) {
      try { c.ws.terminate(); } catch { /* already gone */ }
      clients.delete(c.id);
      removeFromPads(c.id);
      broadcast('left', { id: c.id });
    }
  }

  broadcast('players', {
    players: [...clients.values()].map((c) => ({
      id: c.id, name: c.name, x: c.x, y: c.y, z: c.z, yaw: c.yaw, region: c.region, moving: c.moving,
    })),
  });
}, 1000 / TICK_HZ);

// Countdowns run on their own slower clock; pads only change once a second.
setInterval(() => {
  let dirty = false;
  for (const pad of pads) {
    if (pad.size == null) continue;
    pad.timer -= 0.25;
    // A full party stops waiting out the clock.
    if (pad.members.length >= pad.size && pad.timer > 2) { pad.timer = 2; dirty = true; }
    if (pad.timer <= 0) {
      broadcast('launch', { pad: pad.id, members: [...pad.members] });
      pad.size = null; pad.timer = 0; pad.members = []; pad.hostId = null;
    }
    dirty = true;
  }
  if (dirty) broadcastPads();
}, 250);

server.listen(PORT, () => {
  console.log(`[server] http + ws on :${PORT}  (ws path /ws)`);
});
