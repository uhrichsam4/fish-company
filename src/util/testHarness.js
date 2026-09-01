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
  // Wait n simulated frames, counted off the game's own frame number rather
  // than requestAnimationFrame. A browser pane that isn't compositing stops
  // rAF entirely while the game keeps running on its fallback ticker, so an
  // rAF-based wait hangs for ever — which silently turned every cast in an
  // automated run into a timeout and looked like a gameplay regression.
  const frames = (n = 1) => new Promise((resolve) => {
    const target = game.frame + Math.max(1, n);
    const deadline = performance.now() + 4000;
    const check = () => {
      if (game.frame >= target || performance.now() > deadline) resolve();
      else setTimeout(check, 8);
    };
    check();
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
      // cancel() winds the line back in rather than snapping to idle, so a cast
      // issued right after it fails on a state the system is still leaving.
      if (f.state !== 'idle') {
        f.cancel();
        await T.waitFor(() => f.state === 'idle', 4000, 'rod back to idle');
      }
      T.aimAtWater();
      await frames(2);
      await T.holdMouse(0, chargeMs);
      const inWater = await T.waitFor(() => f.state === 'inwater' || f.state === 'nibble', 6000, 'hook in water');
      if (!inWater) { log.push(`cast failed, state=${f.state}`); return null; }

      // Wait for a bite, then strike. A failed hook-set leaves the bait in the
      // water, so keep waiting rather than giving up on the whole cast.
      let hooked = false;
      const castDeadline = performance.now() + timeout * 0.7;
      while (!hooked && performance.now() < castDeadline) {
        const bit = await T.waitFor(() => f.state === 'nibble', 12000, 'nibble');
        if (!bit) break;
        await sleep(90);
        await T.click(0, 40);
        hooked = await T.waitFor(() => f.state === 'hooked', 1800, 'hooked');
        if (!hooked && f.state !== 'inwater' && f.state !== 'nibble') break;
      }
      if (!hooked) { log.push(`no hook (state=${f.state})`); f.cancel(); return null; }

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

    /**
     * Force every material to relink and report any shader compile errors.
     * A failed ShaderMaterial renders as nothing, which is easy to miss in a
     * screenshot and impossible to miss here.
     */
    async checkShaders() {
      const before = errors.length;
      const seen = new Set();
      game.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) {
          if (seen.has(mm.uuid)) continue;
          seen.add(mm.uuid);
          mm.needsUpdate = true;
        }
      });
      game.renderer.render(game.scene, game.camera);
      await sleep(120);
      const shaderErrors = errors.slice(before).filter((e) => /Shader Error|not compiled|ERROR: 0:/.test(e));
      return { materials: seen.size, shaderErrors };
    },

    /**
     * Is this element actually clickable? `elementFromPoint` honours
     * pointer-events and z-order, so this catches the class of bug that
     * calling a handler directly never will.
     */
    hitTest(selOrEl) {
      const el = typeof selOrEl === 'string' ? document.querySelector(selOrEl) : selOrEl;
      if (!el) return { ok: false, why: 'not found' };
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { ok: false, why: 'zero size', rect: r.toJSON?.() };
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
      return { ok, why: ok ? '' : `blocked by <${hit?.tagName?.toLowerCase()} class="${hit?.className}">`, x, y };
    },

    /** Dispatch a real pointer+mouse click sequence at an element's centre. */
    realClick(selOrEl) {
      const el = typeof selOrEl === 'string' ? document.querySelector(selOrEl) : selOrEl;
      if (!el) return { ok: false, why: 'not found' };
      const test = T.hitTest(el);
      if (!test.ok) return test;
      const target = document.elementFromPoint(test.x, test.y);
      const opts = { bubbles: true, cancelable: true, clientX: test.x, clientY: test.y, button: 0 };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        target.dispatchEvent(new Ctor(type, opts));
      }
      return { ok: true, target: `${target.tagName.toLowerCase()}.${target.className}` };
    },

    /** Run a named debug-menu action. */
    debug(action) { game.get('debug')?.run(action); },

    /**
     * Park the camera at a survey pose and HOLD it there. Gravity and the
     * world-floor safety net pull a frozen player back down within a frame,
     * so re-apply the pose every frame until `survey(null)` releases it.
     */
    survey(x, y, z, yaw, pitch) {
      const p = game.get('player');
      if (x == null) {
        T._surveyPose = null;
        p.canMove = true; p.mode = 'walk';
        if (T._surveyOff) { T._surveyOff(); T._surveyOff = null; }
        return 'released';
      }
      // The caller means "put the CAMERA here"; the player's eye sits
      // `eyeHeight` above their feet, so every underwater survey was actually
      // taken 1.6 m higher than requested — i.e. at the surface.
      T._surveyPose = { x, y: y - (game.get('player')?.eyeHeight ?? 1.62), z, yaw, pitch };
      p.canMove = false;
      p.mode = 'frozen';
      const hold = () => {
        const pose = T._surveyPose;
        if (!pose) return;
        p.position.set(pose.x, pose.y, pose.z);
        p.velocity.set(0, 0, 0);
        p.yaw = pose.yaw; p.pitch = pose.pitch;
        p.entry.body.setNextKinematicTranslation(p.position);
        p.updateCamera(0.016, game);
      };
      hold();
      if (!T._surveyOff) T._surveyOff = bus.on('perf', hold);
      // Also hold every frame via a lightweight system.
      if (!T._surveySystem) {
        T._surveySystem = { name: 'testSurvey', order: 999, lateUpdate: hold };
        game.add(T._surveySystem);
      } else T._surveySystem.lateUpdate = hold;
      return 'held';
    },
    freeCam(on = true) {
      const p = game.get('player');
      p.canMove = !on;
      if (on) { game.physics.enabled = false; } else { game.physics.enabled = true; }
    },
    hideUI(v = true) { bus.emit('hud:visible', !v); document.getElementById('click-to-play')?.classList.add('hidden'); },

    /**
     * Grab the framebuffer and POST it to tools/shotserver.mjs, which writes a
     * PNG under tools/shots/. The read has to happen inside the same task as
     * the draw call because the context isn't created with
     * preserveDrawingBuffer, so we re-render explicitly and read immediately.
     *
     * Long edge is capped at opts.max (default 1280) at 1x; pass explicit
     * width/height to override. tools/shots/ is gitignored -- these are
     * regenerable, and committing them at full res filled the disk.
     */
    async capture(name = 'shot', opts = {}) {
      const r = game.renderer;
      // setSize takes logical pixels; domElement.width is the backing buffer,
      // already scaled by the pixel ratio. Restoring from the latter grew the
      // canvas by one factor of dpr on every capture.
      const dpr = r.getPixelRatio();
      const prev = { w: r.domElement.width / dpr, h: r.domElement.height / dpr };
      // These are for eyeballing, and a full-res retina grab is a ~3.5MB PNG.
      // Cap the long edge and drop to 1x unless a caller asks for a size.
      let w = opts.width, h = opts.height;
      if (!w || !h) {
        const scale = Math.min(1, (opts.max ?? 1280) / Math.max(prev.w, prev.h));
        w = Math.round(prev.w * scale); h = Math.round(prev.h * scale);
      }
      r.setPixelRatio(1);
      r.setSize(w, h, false);
      game.camera.aspect = w / h;
      game.camera.updateProjectionMatrix();
      // Draw and read back in one go. Render twice: the first pass warms
      // shadow maps and any lazily-compiled program, and on a canvas without
      // preserveDrawingBuffer a single forced render can read back partially
      // composited content from the previous frame.
      r.render(game.scene, game.camera);
      r.render(game.scene, game.camera);
      for (const s of game.systems) { try { s.postRender?.(game); } catch { /* */ } }
      const url = r.domElement.toDataURL('image/png');
      r.setPixelRatio(dpr);
      r.setSize(prev.w, prev.h, false);
      game.camera.aspect = prev.w / prev.h;
      game.camera.updateProjectionMatrix();
      try {
        const res = await fetch('http://localhost:5181/', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, data: url }),
        });
        const j = await res.json();
        return j.file;
      } catch (e) { return `capture failed: ${e.message}`; }
    },

    /** Pose the camera, wait a beat, and capture. */
    async shot(name, x, y, z, yaw, pitch, settleMs = 700) {
      T.survey(x, y, z, yaw, pitch);
      await sleep(settleMs);
      const out = await T.capture(name);
      // Hand the player back. A held survey pose leaves them frozen and unable
      // to move, which silently fails every gameplay test run afterwards.
      T.survey(null);
      return out;
    },
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
