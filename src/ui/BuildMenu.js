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

/**
 * Categories down the side, contents on the right.
 *
 * Ten tiles in one flat grid is a list you read; four categories of two or
 * three is a thing you navigate. The split is by the job you are doing --
 * putting up a building, laying ground, keeping the sea out -- not by material
 * or cost, because "what am I trying to do" is the question you actually have
 * when you open a build menu.
 */
const GROUPS = [
  { id: 'base', name: 'Base', icon: '⬜', ids: ['foundation', 'floor', 'post'] },
  { id: 'walls', name: 'Walls', icon: '🧱', ids: ['wall', 'wall_window', 'wall_door', 'roof'] },
  { id: 'ground', name: 'Paths', icon: '🛤️', ids: ['walkway', 'ramp'] },
  { id: 'defence', name: 'Defence', icon: '🌊', ids: ['seawall'] },
];

export class BuildMenu {
  constructor(game) {
    this.game = game;
    this.name = 'buildmenu';
    this.order = 907;
    this.el = null;
    this.open = false;
    this.group = 'base';
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

    // A button on screen as well as a key. A keybind you have to be told about
    // is not discoverable, and building is the half of the game players were
    // not finding.
    this.fab = document.createElement('div');
    this.fab.className = 'build-fab';
    this.fab.innerHTML = `<span class="bf-ico">🔨</span>Build<kbd>Q</kbd>`;
    this.fab.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.fab.addEventListener('click', () => bus.emit('build:toggle', {}));
    root.appendChild(this.fab);

    this._offs.push(bus.on('build:mode', ({ on }) => this.setOpen(on)));
    this._offs.push(bus.on('resources:changed', () => { if (this.open) this.render(); }));
    this._offs.push(bus.on('build:selected', () => { if (this.open) this.render(); }));
    this._offs.push(bus.on('ui:cursorMode', ({ on }) => {
      this.el?.classList.toggle('cursor-on', on);
      if (this.open) this.render();
    }));
    return this;
  }

  setOpen(on) {
    this.open = !!on;
    this.el?.classList.toggle('show', this.open);
    this.fab?.classList.toggle('on', this.open);
    if (this.open) this.render();
  }

  _onClick(e) {
    const cat = e.target.closest?.('.bm-cat');
    if (cat) { this.group = cat.dataset.id; this.render(); return; }

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

    // Keep the selected piece's category open, so selecting from the hotbar
    // digits does not leave the menu showing a different tab than the ghost.
    const owning = GROUPS.find((g) => g.ids.includes(b.selected));
    if (owning && !GROUPS.find((g) => g.id === this.group)) this.group = owning.id;

    const cats = GROUPS.map((g) => {
      const affordable = g.ids.some((id) => {
        const p = PIECES.find((x) => x.id === id);
        return p && (!res || res.canAfford(p.cost));
      });
      return `<div class="bm-cat ${this.group === g.id ? 'sel' : ''} ${affordable ? '' : 'poor'}" data-id="${g.id}">
        <div class="bm-cat-ico">${g.icon}</div><div class="bm-cat-name">${g.name}</div>
      </div>`;
    }).join('');

    const active = GROUPS.find((g) => g.id === this.group) || GROUPS[0];
    const items = active.ids.map((id) => PIECES.find((p) => p.id === id)).filter(Boolean);
    const grid = `<div class="bm-grid">${items.map((p) => {
      const poor = res && !res.canAfford(p.cost);
      return `<div class="bm-item ${b.selected === p.id ? 'sel' : ''} ${poor ? 'poor' : ''}" data-id="${p.id}"
                   title="${(p.desc || '').replace(/"/g, '&quot;')}">
        <div class="bm-ico">${p.icon}</div>
        <div class="bm-name">${p.name}</div>
        <div class="bm-cost">${cost(p.cost)}</div>
      </div>`;
    }).join('')}</div>`;

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
        <div class="bm-hint"><kbd>Alt</kbd>cursor <kbd>LMB</kbd>place <kbd>R</kbd>rotate <kbd>RMB</kbd>remove <kbd>Q</kbd>close</div>
      </div>
      ${this.game.get('ui')?.cursorMode ? ''
        : '<div class="bm-locked">Press <kbd>Alt</kbd> to free the mouse and click these</div>'}
      <div class="bm-body">
        <div class="bm-cats">${cats}</div>
        <div class="bm-panel">
          ${grid}
          <div class="bm-mats">${mats}</div>
        </div>
      </div>`;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this.el?.remove();
    this.fab?.remove();
  }
}
