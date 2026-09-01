import { bus } from '../core/EventBus.js';
import { PIECES, MATERIALS } from '../build/BuildSystem.js';
import { RESOURCE_BY_ID } from '../economy/Resources.js';

/**
 * The build palette.
 *
 * Build mode already worked before this existed -- you pressed a number key
 * and a toast told you what you had selected. That is a control scheme you can
 * only use if you already know what the ten pieces are, which means the
 * building half of the game was invisible to anyone who had not read the
 * source. This shows the pieces, what they cost, and which ones you can
 * currently afford.
 *
 * Opens and closes with build mode rather than being a separate toggle. A
 * palette you have to summon is one more thing to know about; a palette that
 * is simply what build mode looks like is not.
 *
 * Affordability is recomputed on resource changes and on open, not per frame:
 * the only things that can change it are gathering and spending, and both fire
 * events.
 */

/** Grouped so the list reads as three jobs rather than ten items. */
const GROUPS = [
  { name: 'Structure', ids: ['foundation', 'floor', 'wall', 'wall_window', 'wall_door', 'post', 'roof'] },
  { name: 'Ground works', ids: ['walkway', 'ramp'] },
  { name: 'Defence', ids: ['seawall'] },
];

export class BuildMenu {
  constructor(game) {
    this.game = game;
    this.name = 'buildmenu';
    this.order = 907;
    this.el = null;
    this.open = false;
    this._offs = [];
  }

  get build() { return this.game.get('build'); }

  async init(game) {
    const root = document.getElementById('ui-root');
    if (!root) return this;

    this.el = document.createElement('div');
    this.el.className = 'build-menu';
    root.appendChild(this.el);

    // Clicks must not fall through to the world, or selecting a piece also
    // places one behind the menu.
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => this._onClick(e));

    this._offs.push(bus.on('build:mode', ({ on }) => this.setOpen(on)));
    this._offs.push(bus.on('resources:changed', () => { if (this.open) this.render(); }));
    this._offs.push(bus.on('build:selected', () => { if (this.open) this.render(); }));
    return this;
  }

  setOpen(on) {
    this.open = !!on;
    this.el?.classList.toggle('show', this.open);
    if (this.open) this.render();
  }

  _onClick(e) {
    const item = e.target.closest?.('.bm-item');
    if (item && !item.classList.contains('poor')) {
      const b = this.build;
      if (b) { b.selected = item.dataset.id; bus.emit('build:selected', { id: item.dataset.id }); }
      this.render();
      return;
    }
    const mat = e.target.closest?.('.bm-mat');
    if (mat && !mat.classList.contains('locked')) {
      bus.emit('build:material', { id: mat.dataset.id });
      this.render();
    }
  }

  render() {
    const b = this.build;
    if (!this.el || !b) return;
    const res = this.game.get('resources');

    const cost = (c) => Object.entries(c || {}).map(([id, n]) => {
      const short = res && res.get(id) < n;
      const icon = RESOURCE_BY_ID[id]?.icon || '';
      return `<span class="${short ? 'short' : ''}">${icon}${n}</span>`;
    }).join('');

    const groups = GROUPS.map((g) => {
      const items = g.ids.map((id) => PIECES.find((p) => p.id === id)).filter(Boolean);
      if (!items.length) return '';
      return `<div class="bm-title" style="margin:10px 0 7px;font-size:11px;opacity:.62">${g.name}</div>
        <div class="bm-grid">${items.map((p) => {
          const poor = res && !res.canAfford(p.cost);
          return `<div class="bm-item ${b.selected === p.id ? 'sel' : ''} ${poor ? 'poor' : ''}" data-id="${p.id}"
                       title="${(p.desc || '').replace(/"/g, '&quot;')}">
            <div class="bm-ico">${p.icon}</div>
            <div class="bm-name">${p.name}</div>
            <div class="bm-cost">${cost(p.cost)}</div>
          </div>`;
        }).join('')}</div>`;
    }).join('');

    // Materials the player has actually unlocked by having some of the stuff.
    const mats = Object.entries(MATERIALS).map(([id, m]) => {
      // Wood is always available; the rest need the matching resource in hand.
      const locked = id !== 'wood' && res && res.get(id === 'reinforced' ? 'plank' : id) <= 0;
      return `<div class="bm-mat ${b.material === id ? 'sel' : ''} ${locked ? 'locked' : ''}" data-id="${id}"
                   title="${m.health} HP">${m.name}</div>`;
    }).join('');

    this.el.innerHTML = `
      <div class="bm-head">
        <div class="bm-title">🔨 Build</div>
        <div class="bm-hint"><kbd>LMB</kbd>place <kbd>R</kbd>rotate <kbd>RMB</kbd>remove <kbd>B</kbd>close</div>
      </div>
      ${groups}
      <div class="bm-mats">${mats}</div>`;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this.el?.remove();
  }
}
