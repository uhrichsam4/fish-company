/**
 * Tiny synchronous pub/sub used to decouple gameplay systems.
 * Handlers are copied before dispatch so a handler may safely (un)subscribe.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.map = new Map();
    this.debug = false;
  }

  on(event, fn) {
    let set = this.map.get(event);
    if (!set) { set = new Set(); this.map.set(event, set); }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (...a) => { off(); fn(...a); });
    return off;
  }

  off(event, fn) {
    const set = this.map.get(event);
    if (set) { set.delete(fn); if (!set.size) this.map.delete(event); }
  }

  emit(event, payload) {
    const set = this.map.get(event);
    if (this.debug) console.debug('[event]', event, payload);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (err) { console.error(`[EventBus] handler for "${event}" threw:`, err); }
    }
  }

  clear() { this.map.clear(); }
}

export const bus = new EventBus();
