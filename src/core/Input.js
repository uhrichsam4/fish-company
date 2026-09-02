import { bus } from './EventBus.js';

/**
 * Keyboard + mouse + pointer-lock input.
 * Keys are tracked by `event.code` (layout independent).
 * `justPressed`/`justReleased` are edge flags cleared by Game at end of frame.
 */
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0, wheel: 0 };
    this.buttons = [false, false, false];
    this.buttonsPressed = [false, false, false];
    this.buttonsReleased = [false, false, false];
    this.locked = false;
    this.enabled = true;
    /** UI panels set this to swallow gameplay input while keeping Esc working. */
    this.uiCapture = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (e.repeat) return;
      // Let the browser handle devtools/refresh combos.
      if (e.ctrlKey || e.metaKey) {
        if (e.code !== 'ControlLeft' && e.code !== 'ControlRight') return;
      }
      this.keys.add(e.code);
      this.pressed.add(e.code);
      bus.emit('key:down', e.code);
      if (PREVENT.has(e.code) && !this.uiCapture) e.preventDefault();
    };
    const ku = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
      bus.emit('key:up', e.code);
    };
    window.addEventListener('keydown', kd, { passive: false });
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => this.releaseAll());

    const mm = (e) => {
      if (this.locked) {
        // Guard against the rare huge movementX spike some browsers emit on lock.
        const dx = Math.abs(e.movementX) > 200 ? 0 : e.movementX;
        const dy = Math.abs(e.movementY) > 200 ? 0 : e.movementY;
        this.mouse.dx += dx; this.mouse.dy += dy;
      }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    };
    window.addEventListener('mousemove', mm);

    window.addEventListener('mousedown', (e) => {
      if (e.button < 3) { this.buttons[e.button] = true; this.buttonsPressed[e.button] = true; }
      bus.emit('mouse:down', e.button);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button < 3) { this.buttons[e.button] = false; this.buttonsReleased[e.button] = true; }
      bus.emit('mouse:up', e.button);
    });
    window.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });

    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.dom;
      if (was !== this.locked) bus.emit(this.locked ? 'pointer:locked' : 'pointer:unlocked');
      if (!this.locked) this.releaseAll();
    });
    document.addEventListener('pointerlockerror', () => {
      console.warn('[Input] pointer lock error');
      this.locked = false;
      bus.emit('pointer:unlocked');
    });
  }

  requestLock() {
    if (this.locked) return;
    // Chrome returns a promise; Safari returns undefined. Pointer lock can also
    // be refused outright (embedded/iframed contexts, or a lock requested too
    // soon after an exit) — none of that should surface as an unhandled
    // rejection, so every path is swallowed.
    try {
      const p = this.dom.requestPointerLock?.({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const p2 = this.dom.requestPointerLock();
            if (p2 && typeof p2.catch === 'function') p2.catch(() => this._lockUnavailable());
          } catch { this._lockUnavailable(); }
        });
      }
    } catch { this._lockUnavailable(); }
  }

  /** Called when the browser refuses pointer lock; the game stays playable. */
  _lockUnavailable() {
    if (this._warnedLock) return;
    this._warnedLock = true;
    console.info('[Input] pointer lock unavailable in this context — mouse look disabled');
    bus.emit('input:noPointerLock');
  }
  exitLock() { if (this.locked) document.exitPointerLock?.(); }

  releaseAll() {
    for (const k of this.keys) this.released.add(k);
    this.keys.clear();
    for (let i = 0; i < 3; i++) { if (this.buttons[i]) this.buttonsReleased[i] = true; this.buttons[i] = false; }
  }

  // --- queries ---
  down(code) { return this.enabled && !this.uiCapture && this.keys.has(code); }
  justPressed(code) { return this.enabled && !this.uiCapture && this.pressed.has(code); }
  /** Held with no gate at all -- for systems that must read a key while a panel owns the rest. */
  rawDown(code) { return this.keys.has(code); }
  justReleased(code) { return this.enabled && this.released.has(code); }
  /** Ignores uiCapture — for Esc/Tab style global bindings. */
  rawPressed(code) { return this.pressed.has(code); }
  rawDown(code) { return this.keys.has(code); }

  /**
   * actionCapture blocks the mouse buttons and nothing else. Build mode sets
   * it: placing a piece must not also cast the rod or swing the axe, but the
   * player still has to be able to walk while they build. uiCapture is the
   * heavier gate for real panels, and it takes movement too.
   */
  actionCapture = false;
  mouseDown(b = 0) { return this.enabled && !this.uiCapture && !this.actionCapture && this.buttons[b]; }
  mousePressed(b = 0) { return this.enabled && !this.uiCapture && !this.actionCapture && this.buttonsPressed[b]; }
  rawMousePressed(b = 0) { return this.enabled && this.buttonsPressed[b]; }
  mouseReleased(b = 0) { return this.enabled && this.buttonsReleased[b]; }

  /** Normalized WASD vector {x: strafe, z: forward}. */
  moveAxis() {
    let x = 0, z = 0;
    if (this.down('KeyW') || this.down('ArrowUp')) z += 1;
    if (this.down('KeyS') || this.down('ArrowDown')) z -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    return { x, z };
  }

  /** Mouse delta in radians, consumed once per frame. */
  consumeLook() {
    const yaw = -this.mouse.dx * this.sensitivity;
    const pitch = (this.invertY ? 1 : -1) * this.mouse.dy * this.sensitivity;
    this.mouse.dx = 0; this.mouse.dy = 0;
    return { yaw, pitch };
  }

  consumeWheel() { const w = this.mouse.wheel; this.mouse.wheel = 0; return w; }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed[0] = this.buttonsPressed[1] = this.buttonsPressed[2] = false;
    this.buttonsReleased[0] = this.buttonsReleased[1] = this.buttonsReleased[2] = false;
    this.mouse.dx = 0; this.mouse.dy = 0;
  }
}

const PREVENT = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'F8', 'Slash', 'Quote',
]);
