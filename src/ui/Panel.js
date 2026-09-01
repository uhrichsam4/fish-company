import { bus } from '../core/EventBus.js';

/**
 * Base class for modal panels. Handles the backdrop, tabs, Esc, focus and
 * pointer-lock hand-off so individual panels only render content.
 */
export class Panel {
  constructor(game, opts = {}) {
    this.game = game;
    this.id = opts.id || 'panel';
    this.title = opts.title || '';
    this.subtitle = opts.subtitle || '';
    this.width = opts.width || '';
    this.tabs = opts.tabs || null;
    this.activeTab = this.tabs?.[0]?.id || null;
    this.el = null;
    this.open = false;
    this._onClose = opts.onClose || null;
  }

  mount() {
    if (this.el) return;
    const back = document.createElement('div');
    back.className = 'panel-backdrop';
    back.dataset.panel = this.id;
    back.innerHTML = `
      <div class="panel ${this.width}">
        <div class="panel-head">
          <h2>${this.title}</h2>
          <span class="ph-sub">${this.subtitle}</span>
          <div class="spacer"></div>
          <div class="ph-right"></div>
          <button class="panel-close" title="Close (Esc)">✕</button>
        </div>
        ${this.tabs ? `<div class="tabs">${this.tabs.map((t) =>
          `<button class="tab ${t.id === this.activeTab ? 'active' : ''}" data-tab="${t.id}">${t.icon || ''} ${t.name}</button>`).join('')}</div>` : ''}
        <div class="panel-body"></div>
        <div class="panel-foot"></div>
      </div>`;
    document.getElementById('ui-root').appendChild(back);
    this.el = back;
    this.bodyEl = back.querySelector('.panel-body');
    this.footEl = back.querySelector('.panel-foot');
    this.headRight = back.querySelector('.ph-right');

    back.querySelector('.panel-close').addEventListener('click', () => this.close());
    back.addEventListener('click', (e) => { if (e.target === back) this.close(); });
    back.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      this.activeTab = t.dataset.tab;
      back.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === this.activeTab));
      this.game.audio.play('ui_click', { volume: 0.3 });
      this.render();
    }));
    back.addEventListener('mouseover', (e) => {
      if (e.target.classList?.contains('btn') || e.target.classList?.contains('card')) {
        this.game.audio.play('ui_hover', { volume: 0.18, throttle: 40 });
      }
    });
  }

  show() {
    this.mount();
    this.open = true;
    this.el.style.display = '';
    this.render();
    this.game.input.uiCapture = true;
    this.game.input.exitLock();
    this.game.audio.play('ui_open', { volume: 0.4 });
    bus.emit('ui:opened', this.id);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    if (this.el) this.el.style.display = 'none';
    this.game.audio.play('ui_close', { volume: 0.35 });
    this._onClose?.();
    bus.emit('ui:closed', this.id);
  }

  setSubtitle(t) { if (this.el) this.el.querySelector('.ph-sub').textContent = t; }
  setHeadRight(html) { if (this.headRight) this.headRight.innerHTML = html; }
  setFoot(html) { if (this.footEl) this.footEl.innerHTML = html; }

  /** Override. */
  render() {}

  /** Convenience: delegate clicks inside the body by data-action. */
  onAction(handler) {
    if (this._actionBound) return;
    this._actionBound = true;
    this.el.addEventListener('click', (e) => {
      const node = e.target.closest('[data-action]');
      if (!node) return;
      handler(node.dataset.action, node.dataset, node, e);
    });
  }

  destroy() { this.el?.remove(); this.el = null; }
}
