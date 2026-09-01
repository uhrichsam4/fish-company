import { bus } from '../core/EventBus.js';
import { ShopPanel } from './panels/ShopPanel.js';
import { InventoryPanel } from './panels/InventoryPanel.js';
import { AtlasPanel } from './panels/AtlasPanel.js';
import { CompanyPanel } from './panels/CompanyPanel.js';
import { PausePanel } from './panels/PausePanel.js';
import { MapPanel } from './panels/MapPanel.js';
import { FleetEditorPanel } from './panels/FleetEditorPanel.js';
import { BoatUpgradePanel } from './panels/BoatUpgradePanel.js';
import { SubUpgradePanel } from './panels/SubUpgradePanel.js';
import { SubExpeditionPanel } from './panels/SubExpeditionPanel.js';
import { ContractsPanel } from './panels/ContractsPanel.js';
import { ProcessingPanel } from './panels/ProcessingPanel.js';
import { QuestPanel } from './panels/QuestPanel.js';
import { WorkerGearPanel } from './panels/WorkerGearPanel.js';
import { Tutorial } from './Tutorial.js';
import { Waypoints } from './Waypoints.js';

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
    this.register('fleetEditor', new FleetEditorPanel(game));
    this.register('boatUpgrade', new BoatUpgradePanel(game));
    this.register('subUpgrade', new SubUpgradePanel(game));
    this.register('subExpedition', new SubExpeditionPanel(game));
    this.register('contracts', new ContractsPanel(game));
    this.register('processing', new ProcessingPanel(game));
    this.register('quests', new QuestPanel(game));
    this.register('workerGear', new WorkerGearPanel(game));

    // Panels may be stateful systems in their own right (Atlas tracks discovery).
    for (const [id, p] of this.panels) {
      if (typeof p.init === 'function') { try { await p.init(game); } catch (e) { console.error(`[UI] panel ${id} init failed`, e); } }
      if (p.name) game.systemsByName.set(p.name, p);
    }

    // Tutorial + waypoints are HUD-layer systems. If the boot list already
    // registered them they run as first-class systems and we leave them alone;
    // otherwise the UI owns them. They are never pushed onto game.systems from
    // here — init runs inside Game.initSystems' own loop over that array, and
    // mutating it mid-iteration would re-enter a system — so the fallback
    // copies are driven from update() and registered for the save by hand.
    this.extras = [];
    for (const [name, Cls] of [['tutorial', Tutorial], ['waypoints', Waypoints]]) {
      if (game.systemsByName.has(name)) continue;
      try {
        const sys = new Cls(game);
        await sys.init?.(game);
        game.systemsByName.set(name, sys);
        if (typeof sys.save === 'function') game.save.register(name, () => sys.save(), (d) => sys.load(d));
        this.extras.push(sys);
      } catch (e) { console.error(`[UI] ${name} failed to start`, e); }
    }

    bus.on('interact:shop', (d) => this.show('shop', d));
    bus.on('interact:sell', (d) => this.sellHere(d));
    bus.on('interact:hire', (d) => this.show('company', { tab: 'hire', ...d }));
    bus.on('ui:show', ({ id, data }) => this.show(id, data));

    // Used by the live-refresh guard above.
    window.addEventListener('pointerdown', (e) => { this._pointerDown = true; this._pointerTarget = e.target; }, true);
    window.addEventListener('pointerup', () => { this._pointerDown = false; this._pointerTarget = null; }, true);
    window.addEventListener('pointercancel', () => { this._pointerDown = false; this._pointerTarget = null; }, true);
    bus.on('ui:close', () => this.closeAll());

    // Company-panel link-outs. CompanyPanel forwards every data-action as
    // `company:<action>`, so these route its buttons at the right panel
    // without that file needing to know these panels exist.
    bus.on('company:equipWorker', ({ id }) => this.show('workerGear', { id }));
    bus.on('company:contracts', (d) => this.show('contracts', d));
    bus.on('company:processing', (d) => this.show('processing', d));
    bus.on('company:quests', (d) => this.show('quests', d));
    bus.on('company:subExpedition', (d) => this.show('subExpedition', d));
    bus.on('interact:contracts', (d) => this.show('contracts', d));
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
    // The lobby pad panel is a real modal even though it is not a Panel: it
    // must capture input too, or the number keys meant for choosing a party
    // size fall through to the hotbar.
    const lobbyOpen = !!game.get('lobby')?.panelOpen;
    // Build mode owns the number keys and both mouse buttons while it is on,
    // so it captures input the same way a panel does -- otherwise placing a
    // wall also swaps your hotbar slot and swings whatever you are holding.
    const building = !!game.get('build')?.mode;
    input.uiCapture = anyOpen || !!debugOpen || lobbyOpen || building;

    if (input.rawPressed('Escape')) {
      if (anyOpen) this.closeAll();
      else if (lobbyOpen) game.get('lobby')?.leave();
      else if (debugOpen) game.get('debug').toggle();
      else this.show('pause');
    }
    if (input.rawPressed('Tab') && !anyOpen) this.show('inventory');
    else if (input.rawPressed('Tab') && anyOpen) this.closeAll();
    if (!input.uiCapture) {
      if (input.rawPressed('KeyB')) {
        // Shift+B is the atlas; plain B is build mode, which is used far more.
        if (input.down('ShiftLeft') || input.down('ShiftRight')) this.toggle('atlas');
        else bus.emit('build:toggle', {});
      }
      if (input.rawPressed('KeyM')) this.toggle('map');
      if (input.rawPressed('KeyC')) { /* reserved for crouch */ }
      if (input.rawPressed('KeyO')) this.toggle('company');
      if (input.rawPressed('KeyJ')) this.toggle('quests');
      if (input.rawPressed('KeyK')) this.toggle('contracts');
      if (input.rawPressed('KeyP')) this.toggle('processing');
    }

    // HUD-layer systems the UI owns (see init).
    if (this.extras) {
      for (const s of this.extras) {
        if (!s.update) continue;
        try { s.update(dt, game); }
        catch (e) { console.error(`[UI] "${s.name}" update threw:`, e); }
      }
    }

    // Panels that need live data refresh at 4 Hz while open.
    //
    // render() replaces the panel's innerHTML wholesale, so refreshing on top
    // of someone who is mid-interaction destroys the element under their
    // cursor: :hover resets every 250 ms (a visible flicker) and a click never
    // completes, because mousedown's target is gone before mouseup. Hold the
    // refresh while a control is hovered or the button is down, and catch up
    // as soon as they move off. Actions re-render explicitly anyway.
    this._t = (this._t || 0) + dt;
    if (this._t > 0.25) {
      this._t = 0;
      for (const p of this.panels.values()) {
        if (!p.open || !p.live || !p.el) continue;
        if (this._pointerDown && p.el.contains(this._pointerTarget)) continue;
        let busy = false;
        try { busy = !!p.el.querySelector('[data-action]:hover, button:hover, input:focus'); }
        catch { busy = false; }
        if (busy) continue;
        p.render();
      }
    }
  }
}
