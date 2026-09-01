import { bus } from '../core/EventBus.js';
import { ShopPanel } from './panels/ShopPanel.js';
import { InventoryPanel } from './panels/InventoryPanel.js';
import { AtlasPanel } from './panels/AtlasPanel.js';
import { CompanyPanel } from './panels/CompanyPanel.js';
import { PausePanel } from './panels/PausePanel.js';
import { MapPanel } from './panels/MapPanel.js';

/** Owns every modal panel and the global keybinds that open them. */
export class UIManager {
  constructor(game) {
    this.game = game;
    this.name = 'ui';
    this.order = 910;
    this.panels = new Map();
  }

  async init(game) {
    this.register('shop', new ShopPanel(game));
    this.register('inventory', new InventoryPanel(game));
    this.register('atlas', new AtlasPanel(game));
    this.register('company', new CompanyPanel(game));
    this.register('pause', new PausePanel(game));
    this.register('map', new MapPanel(game));

    // Panels may be stateful systems in their own right (Atlas tracks discovery).
    for (const [id, p] of this.panels) {
      if (typeof p.init === 'function') { try { await p.init(game); } catch (e) { console.error(`[UI] panel ${id} init failed`, e); } }
      if (p.name) game.systemsByName.set(p.name, p);
    }

    bus.on('interact:shop', (d) => this.show('shop', d));
    bus.on('interact:sell', (d) => this.sellHere(d));
    bus.on('interact:hire', (d) => this.show('company', { tab: 'hire', ...d }));
    bus.on('ui:show', ({ id, data }) => this.show(id, data));
    bus.on('ui:close', () => this.closeAll());
    return this;
  }

  register(id, panel) { this.panels.set(id, panel); }
  get(id) { return this.panels.get(id); }

  anyOpen() { for (const p of this.panels.values()) if (p.open) return true; return false; }

  show(id, data) {
    const p = this.panels.get(id);
    if (!p) { console.warn('[UI] no panel', id); return; }
    for (const [k, other] of this.panels) if (k !== id && other.open) other.close();
    p.data = data || {};
    if (data?.tab && p.tabs?.some((t) => t.id === data.tab)) p.activeTab = data.tab;
    p.show();
  }

  toggle(id, data) {
    const p = this.panels.get(id);
    if (p?.open) p.close(); else this.show(id, data);
  }

  closeAll() { for (const p of this.panels.values()) p.close(); }

  /** [E] on a sell station: sell everything stored, with feedback. */
  sellHere(d) {
    const inv = this.game.get('inventory');
    const eco = this.game.get('economy');
    if (!inv || !eco) return;
    if (!inv.fish.length) {
      bus.emit('toast', { text: 'Nothing to sell — go catch something', kind: 'warn' });
      this.game.audio.play('ui_error', { volume: 0.4 });
      return;
    }
    const res = inv.sellAll();
    this.game.audio.play('cash_register', { volume: 0.8 });
    const player = this.game.get('player');
    const pos = d?.interactable?.position || player?.eyePosition;
    bus.emit('fx:moneyBurst', { position: pos?.clone(), amount: res.total });
    bus.emit('fx:floatText', { position: pos?.clone(), text: `+$${res.total.toLocaleString()}`, color: '#ffc22e', size: 30 });
    bus.emit('toast', {
      text: `Sold ${res.count} fish for <b style="color:var(--gold)">$${res.total.toLocaleString()}</b>`,
      kind: 'gold', duration: 4000,
    });
  }

  save() {
    const out = {};
    for (const [id, p] of this.panels) if (typeof p.save === 'function') out[id] = p.save();
    return out;
  }
  load(d) {
    if (!d) return;
    for (const [id, p] of this.panels) if (typeof p.load === 'function' && d[id] !== undefined) {
      try { p.load(d[id]); } catch (e) { console.error(`[UI] panel ${id} load failed`, e); }
    }
  }

  update(dt, game) {
    const input = game.input;
    const anyOpen = this.anyOpen();
    const debugOpen = game.get('debug')?.open;
    input.uiCapture = anyOpen || !!debugOpen;

    if (input.rawPressed('Escape')) {
      if (anyOpen) this.closeAll();
      else if (debugOpen) game.get('debug').toggle();
      else this.show('pause');
    }
    if (input.rawPressed('Tab') && !anyOpen) this.show('inventory');
    else if (input.rawPressed('Tab') && anyOpen) this.closeAll();
    if (!input.uiCapture) {
      if (input.rawPressed('KeyB')) this.toggle('atlas');
      if (input.rawPressed('KeyM')) this.toggle('map');
      if (input.rawPressed('KeyC')) { /* reserved for crouch */ }
      if (input.rawPressed('KeyO')) this.toggle('company');
    }

    // Panels that need live data refresh at 4 Hz while open.
    this._t = (this._t || 0) + dt;
    if (this._t > 0.25) {
      this._t = 0;
      for (const p of this.panels.values()) if (p.open && p.live) p.render();
    }
  }
}
