import { bus } from '../core/EventBus.js';

/**
 * Raw materials, kept separate from Inventory.
 *
 * Inventory is slot-and-weight based because it models what the player is
 * carrying and wearing. Wood and stone are neither -- they are a running
 * count spent at a build menu, and forcing them through a weight budget
 * would mean a house costs you your fishing capacity.
 */

export const RESOURCES = [
  { id: 'wood', name: 'Wood', icon: '🪵', desc: 'Cut from trees. The whole island runs on it.' },
  { id: 'plank', name: 'Planks', icon: '🪚', desc: 'Milled wood. Stronger, and needed for finer pieces.' },
  { id: 'stone', name: 'Stone', icon: '🪨', desc: 'Heavy, slow to gather, survives weather that wood does not.' },
  { id: 'rope', name: 'Rope', icon: '🪢', desc: 'Lashings, rigging, and holding a roof on in a gale.' },
  { id: 'metal', name: 'Metal', icon: '⚙️', desc: 'Salvaged and refined. The strong stuff.' },
];
export const RESOURCE_BY_ID = Object.fromEntries(RESOURCES.map((r) => [r.id, r]));

export class ResourceSystem {
  constructor(game) {
    this.game = game;
    this.name = 'resources';
    this.order = 33;
    /** @type {Record<string, number>} */
    this.amounts = { wood: 0, plank: 0, stone: 0, rope: 0, metal: 0 };
  }

  async init() {
    bus.on('game:newgame', () => { for (const k of Object.keys(this.amounts)) this.amounts[k] = 0; });
    return this;
  }

  get(id) { return this.amounts[id] || 0; }
  has(id, n) { return this.get(id) >= n; }

  /** @param {Record<string, number>} cost */
  canAfford(cost) {
    for (const [id, n] of Object.entries(cost || {})) if (this.get(id) < n) return false;
    return true;
  }

  add(id, n) {
    if (!RESOURCE_BY_ID[id] || !(n > 0)) return 0;
    this.amounts[id] = this.get(id) + n;
    bus.emit('resources:changed', { id, amount: this.amounts[id], delta: n });
    return n;
  }

  /** @returns {boolean} false and no change if anything is short. */
  spend(cost) {
    if (!this.canAfford(cost)) {
      const missing = Object.entries(cost)
        .filter(([id, n]) => this.get(id) < n)
        .map(([id, n]) => `${n - this.get(id)} more ${RESOURCE_BY_ID[id]?.name || id}`)
        .join(', ');
      bus.emit('toast', { text: `Not enough — need ${missing}.`, kind: 'error', duration: 3200 });
      return false;
    }
    for (const [id, n] of Object.entries(cost)) {
      this.amounts[id] -= n;
      bus.emit('resources:changed', { id, amount: this.amounts[id], delta: -n });
    }
    return true;
  }

  /** Compact summary for the HUD/build menu. */
  summary() {
    return RESOURCES.filter((r) => this.get(r.id) > 0)
      .map((r) => ({ ...r, amount: this.get(r.id) }));
  }

  save() { return { ...this.amounts }; }

  load(d) {
    if (!d) return;
    for (const k of Object.keys(this.amounts)) {
      if (Number.isFinite(d[k])) this.amounts[k] = d[k];
    }
  }
}
