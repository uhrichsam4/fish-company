/**
 * Dev-only automation harness. Exposes `window.TEST` so the game can be
 * driven and asserted from the console / an automated browser session.
 * Never loaded in a production build (guarded in main.js).
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus.js';

export function installTestHarness(game) {
  const log = [];
  const errors = [];
  const events = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); origWarn(...a); };

  // Record a rolling window of gameplay events for assertions.
  const WATCH = [
    'fishing:cast', 'fishing:nibble', 'fishing:hooked', 'fishing:caught', 'fishing:lost',
    'fishing:snapped', 'sell:completed', 'sell:physical', 'quest:completed', 'quest:started',
    'money:changed', 'toast', 'region:entered', 'boss:defeated', 'worker:caught',
    'fleet:tripComplete', 'atlas:discovered', 'tricks:landed', 'physfish:spawned',
    'workers:changed', 'boats:changed', 'fleets:changed', 'research:unlocked', 'feature:unlocked',
  ];
  for (const e of WATCH) bus.on(e, (d) => {
    events.push({ e, t: game.time, d: safe(d) });
    if (events.length > 800) events.shift();
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frames = (n = 1) => new Promise((r) => {
    let k = 0;
    const tick = () => { if (++k >= n) r(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  const input = game.input;
  const T = {
    game, bus, THREE,
    log, errors, warnings, events,
    sleep, frames,

    // ---- input injection ----
    key(code, down = true) {
      if (down) { input.keys.add(code); input.pressed.add(code); }
      else { input.keys.delete(code); input.released.add(code); }
    },
    async tap(code, ms = 60) { T.key(code, true); await sleep(ms); T.key(code, false); },
    async hold(code, ms) { T.key(code, true); await sleep(ms); T.key(code, false); },
    mouse(btn = 0, down = true) {
      if (down) { input.buttons[btn] = true; input.buttonsPressed[btn] = true; }
      else { input.buttons[btn] = false; input.buttonsReleased[btn] = true; }
    },
    async click(btn = 0, ms = 50) { T.mouse(btn, true); await sleep(ms); T.mouse(btn, false); },
    async holdMouse(btn, ms) { T.mouse(btn, true); await sleep(ms); T.mouse(btn, false); },
    look(dYaw, dPitch = 0) {
      const p = game.get('player');
      p.yaw += dYaw; p.pitch = Math.max(-1.5, Math.min(1.5, p.pitch + dPitch));
    },
    faceTowards(x, z) {
      const p = game.get('player');
      p.yaw = Math.atan2(-(x - p.position.x), -(z - p.position.z));
    },
    setPitch(v) { game.get('player').pitch = v; },
    tp(x, y, z) { game.get('player').teleport(x, y, z); },

    // ---- queries ----
    get player() { return game.get('player'); },
    get money() { return game.get('economy')?.money ?? 0; },
    get inv() { return game.get('inventory'); },
    get fishing() { return game.get('fishing'); },
    get fishSys() { return game.get('fish'); },
    state() {
      const p = game.get('player'); const f = game.get('fishing');
      const inv = game.get('inventory'); const eco = game.get('economy');
      const q = game.get('quests');
      return {
        fps: +game.perf.fps.toFixed(1),
        drawCalls: game.perf.drawCalls,
        tris: game.perf.tris,
        bodies: game.physics.bodyCount,
        pos: p ? [+p.position.x.toFixed(1), +p.position.y.toFixed(1), +p.position.z.toFixed(1)] : null,
        grounded: p?.grounded, swimming: p?.swimming, mode: p?.mode,
        money: eco?.money,
        fishAlive: game.get('fish')?.active.length,
        physFish: game.get('physfish')?.list.length,
        castState: f?.state, tension: f ? +f.tension.toFixed(2) : 0,
        hooked: f?.hookedFish?.instance?.name || null,
        stored: inv?.fish.length, storedWeight: inv ? +inv.usedWeight.toFixed(2) : 0,
        rod: inv?.equipped.rod, bait: inv?.equipped.bait,
        quest: q?.tracked, questsDone: q?.completed.size,
        region: game.get('world')?.activeRegion?.id,
        errors: errors.length, warnings: warnings.length,
      };
    },
    lastEvents(n = 20) { return events.slice(-n); },
    eventsOf(name) { return events.filter((e) => e.e === name); },
    countEvents(name) { return events.filter((e) => e.e === name).length; },
    clearEvents() { events.length = 0; },
    clearErrors() { errors.length = 0; warnings.length = 0; },

    // ---- flow helpers ----
    async waitFor(pred, timeoutMs = 15000, label = 'condition') {
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) {
        try { if (pred()) return true; } catch (e) { /* keep polling */ }
        await sleep(60);
      }
      log.push(`TIMEOUT waiting for ${label}`);
      return false;
    },
    async waitEvent(name, timeoutMs = 15000) {
      const start = events.length;
      const ok = await T.waitFor(() => events.slice(start).some((e) => e.e === name), timeoutMs, name);
      return ok ? events.slice(start).find((e) => e.e === name) : null;
    },

    /** Find water in front of the player and aim at it. */
    aimAtWater(maxScan = 60) {
      const p = game.get('player');
      const world = game.get('world');
      const ocean = game.get('ocean');
      let best = null, bestScore = -Infinity;
      for (let a = 0; a < 64; a++) {
        const yaw = (a / 64) * Math.PI * 2;
        const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
        for (let d = 8; d < maxScan; d += 2.5) {
          const x = p.position.x + dx * d, z = p.position.z + dz * d;
          const bed = world.heightAt(x, z);
          const surf = ocean.heightAt(x, z);
          if (surf - bed > 2.2) {
            const score = -d;
            if (score > bestScore) { bestScore = score; best = { yaw, d, x, z }; }
            break;
          }
        }
      }
      if (best) { p.yaw = best.yaw; p.pitch = -0.06; }
      return best;
    },

    /** Full cast → hook → reel → land cycle. Returns the caught instance or null. */
    async fishOnce({ chargeMs = 700, timeout = 40000 } = {}) {
      const f = game.get('fishing');
      const inv = game.get('inventory');
      inv.setHotbarIndex(0);
      await frames(2);
      if (f.state !== 'idle') { f.cancel(); await frames(3); }
      T.aimAtWater();
      await frames(2);
      await T.holdMouse(0, chargeMs);
      const inWater = await T.waitFor(() => f.state === 'inwater' || f.state === 'nibble', 6000, 'hook in water');
      if (!inWater) { log.push(`cast failed, state=${f.state}`); return null; }

      const bit = await T.waitFor(() => f.state === 'nibble', timeout * 0.6, 'nibble');
      if (!bit) { log.push('no bite'); f.cancel(); return null; }
      await sleep(120);
      await T.click(0, 40);
      const hooked = await T.waitFor(() => f.state === 'hooked', 2500, 'hooked');
      if (!hooked) { log.push('hook set failed'); return null; }

      // Reel with tension management: back off when the line is close to snapping.
      const t0 = performance.now();
      let caught = null;
      const off = bus.on('fishing:caught', (d) => { caught = d.instance; });
      while (performance.now() - t0 < timeout) {
        if (f.state !== 'hooked') break;
        if (f.tension < 0.78) { T.mouse(0, true); } else { T.mouse(0, false); }
        await sleep(70);
      }
      T.mouse(0, false);
      off();
      await sleep(300);
      return caught;
    },

    /** Sell everything in storage at the nearest sell station. */
    async sellAll() {
      const inv = game.get('inventory');
      const before = T.money;
      const res = inv.sellAll();
      await sleep(120);
      return { ...res, moneyDelta: T.money - before };
    },

    /** Carry the nearest physical fish and store it. */
    async grabNearestFish() {
      const mgr = game.get('physfish');
      const p = game.get('player');
      const inter = game.get('interaction');
      if (!mgr?.list.length) return false;
      let best = null, bd = Infinity;
      for (const pf of mgr.list) {
        const pos = game.physics.getPosition(pf.entry);
        const d = pos.distanceTo(p.position);
        if (d < bd) { bd = d; best = pf; }
      }
      if (!best) return false;
      const pos = game.physics.getPosition(best.entry);
      p.teleport(pos.x, pos.y + 1.2, pos.z + 1.4);
      p.yaw = Math.atan2(-(pos.x - p.position.x), -(pos.z - p.position.z));
      p.pitch = -0.5;
      await frames(4);
      inter.grab(best.entry, game);
      await frames(3);
      return true;
    },

    /** Run a named debug-menu action. */
    debug(action) { game.get('debug')?.run(action); },

    /** Screenshot-friendly: park the camera at a survey pose. */
    survey(x, y, z, yaw, pitch) {
      const p = game.get('player');
      p.teleport(x, y, z); p.yaw = yaw; p.pitch = pitch;
      p.canMove = false;
      p.updateCamera(0.016, game);
    },
    freeCam(on = true) {
      const p = game.get('player');
      p.canMove = !on;
      if (on) { game.physics.enabled = false; } else { game.physics.enabled = true; }
    },
    hideUI(v = true) { bus.emit('hud:visible', !v); document.getElementById('click-to-play')?.classList.add('hidden'); },
  };

  // Keep simulating while the automation tab is backgrounded.
  game.allowHiddenTick = true;

  window.TEST = T;
  document.getElementById('click-to-play')?.classList.add('hidden');
  console.info('%c[TEST] harness installed — window.TEST', 'color:#ffc22e');
  return T;
}

function safe(d) {
  if (d == null) return d;
  if (typeof d !== 'object') return d;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.length;
    else if (v.name) out[k] = v.name;
    else if (v.id) out[k] = v.id;
  }
  return out;
}
