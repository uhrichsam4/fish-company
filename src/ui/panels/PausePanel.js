import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { formatMoneyExact, formatTime } from '../../util/math.js';

export class PausePanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'pause', title: '⏸ Paused', width: 'narrow',
      tabs: [{ id: 'menu', name: 'Menu', icon: '🎮' }, { id: 'settings', name: 'Settings', icon: '⚙' }, { id: 'controls', name: 'Controls', icon: '⌨' }],
    });
  }

  show() { super.show(); this.game.setPaused(true); }
  close() { super.close(); this.game.setPaused(false); }

  render() {
    if (!this.el) return;
    const g = this.game;
    if (this.activeTab === 'menu') this.renderMenu(g);
    else if (this.activeTab === 'settings') this.renderSettings(g);
    else this.renderControls();

    this.onAction((act, ds) => {
      if (act === 'resume') this.close();
      else if (act === 'save') { g.save.save(); bus.emit('toast', { text: 'Game saved', kind: 'success' }); }
      else if (act === 'load') { g.save.load(); bus.emit('toast', { text: 'Game loaded', kind: 'success' }); this.close(); }
      else if (act === 'newgame') {
        if (confirm('Wipe your save and start over?')) { g.save.wipe(); location.reload(); }
      } else if (act === 'export') {
        const s = g.save.exportString();
        navigator.clipboard?.writeText(s).then(
          () => bus.emit('toast', { text: 'Save copied to clipboard', kind: 'success' }),
          () => { console.log(s); bus.emit('toast', { text: 'Save logged to console', kind: 'warn' }); });
      } else if (act === 'import') {
        const s = prompt('Paste a save string:');
        if (s && g.save.importString(s)) location.reload();
        else if (s) bus.emit('toast', { text: 'Invalid save string', kind: 'error' });
      }
    });

    this.el.querySelectorAll('input[data-setting], select[data-setting]').forEach((inp) => {
      inp.oninput = () => {
        const key = inp.dataset.setting;
        const v = inp.tagName === 'SELECT' ? inp.value
          : inp.type === 'checkbox' ? inp.checked : parseFloat(inp.value);
        g.settings[key] = v;
        const out = inp.parentElement.querySelector('.set-val');
        if (out) out.textContent = inp.type === 'checkbox' || inp.tagName === 'SELECT' ? '' : formatSetting(key, v);
        if (key === 'islandLayout') {
          bus.emit('toast', { text: 'Island layout changes when the island next loads — reload the page to see it', kind: '', duration: 4200 });
        }
        bus.emit('settings:changed');
      };
    });
  }

  renderMenu(g) {
    const eco = g.get('economy');
    const sky = g.get('sky');
    this.bodyEl.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="stat-line"><span class="sl-k">Money</span><span class="sl-v gold">${formatMoneyExact(eco?.money || 0)}</span></div>
        <div class="stat-line"><span class="sl-k">Fish caught</span><span class="sl-v">${eco?.stats.totalCaught || 0}</span></div>
        <div class="stat-line"><span class="sl-k">Day</span><span class="sl-v">${eco?.day || 1} · ${sky?.clockString() || ''}</span></div>
        <div class="stat-line"><span class="sl-k">Playtime</span><span class="sl-v">${formatTime(eco?.stats.playtime || 0)}</span></div>
      </div>
      <button class="btn primary block" data-action="resume" style="margin-bottom:8px">Resume</button>
      <button class="btn block" data-action="save" style="margin-bottom:8px">Save Game</button>
      <button class="btn block" data-action="load" style="margin-bottom:8px">Load Last Save</button>
      <div class="grid c2" style="margin-bottom:8px">
        <button class="btn" data-action="export">Export Save</button>
        <button class="btn" data-action="import">Import Save</button>
      </div>
      <button class="btn danger block" data-action="newgame">New Game (wipes save)</button>`;
    this.setFoot('<span style="color:var(--ink-faint);font-size:12px">Esc to resume · F8 dev menu</span>');
  }

  renderSettings(g) {
    const s = g.settings;
    const row = (key, label, min, max, step) => `
      <div class="stat-line" style="align-items:center">
        <span class="sl-k" style="flex:1">${label}</span>
        <input data-setting="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" style="width:150px">
        <span class="sl-v set-val" style="width:56px;text-align:right">${formatSetting(key, s[key])}</span>
      </div>`;
    const choice = (key, label, options) => `
      <div class="stat-line" style="align-items:center">
        <span class="sl-k" style="flex:1">${label}</span>
        <select data-setting="${key}" style="width:150px">
          ${options.map(([v, name]) => `<option value="${v}" ${s[key] === v ? 'selected' : ''}>${name}</option>`).join('')}
        </select>
        <span class="set-val" style="width:56px"></span>
      </div>`;
    const check = (key, label) => `
      <div class="stat-line" style="align-items:center">
        <span class="sl-k" style="flex:1">${label}</span>
        <input data-setting="${key}" type="checkbox" ${s[key] ? 'checked' : ''}>
        <span class="set-val" style="width:56px"></span>
      </div>`;
    this.bodyEl.innerHTML = `
      <div class="card" style="margin-bottom:11px"><div class="card-title">🎥 Display</div>
        ${row('fov', 'Field of view', 60, 110, 1)}
        ${row('renderScale', 'Render scale', 0.5, 1.5, 0.05)}
        ${check('upscale', 'Upscaler (render low, sharpen up)')}
        ${row('upscaleScale', 'Upscale from', 0.4, 1, 0.05)}
        ${row('upscaleSharpness', 'Upscale sharpness', 0, 1, 0.05)}
        ${row('viewDistance', 'View distance', 0.5, 2, 0.1)}
        ${check('shadows', 'Shadows')}
        ${row('shadowRes', 'Shadow quality', 512, 4096, 512)}
        ${row('particles', 'Particle density', 0, 1.5, 0.1)}
        ${row('uiScale', 'UI scale', 0.8, 1.4, 0.05)}
        ${check('showFps', 'Show performance overlay')}
      </div>
      <div class="card" style="margin-bottom:11px"><div class="card-title">🖱 Controls</div>
        ${row('sensitivity', 'Mouse sensitivity', 0.0005, 0.006, 0.0001)}
        ${check('invertY', 'Invert Y axis')}
        ${row('bobbing', 'View bobbing', 0, 1.5, 0.1)}
      </div>
      <div class="card" style="margin-bottom:11px"><div class="card-title">🔊 Audio</div>
        ${row('volMaster', 'Master', 0, 1, 0.05)}
        ${row('volSfx', 'Effects', 0, 1, 0.05)}
        ${row('volMusic', 'Music', 0, 1, 0.05)}
        ${row('volAmb', 'Ambience', 0, 1, 0.05)}
      </div>
      <div class="card"><div class="card-title">🎮 Gameplay</div>
        ${row('maxFish', 'Fish density', 40, 400, 10)}
        ${choice('islandLayout', 'Crash Island layout', [['reformed', 'Reformed'], ['classic', 'Classic (original)']])}
        ${check('autosave', 'Autosave')}
        ${check('subtitles', 'Worker speech subtitles')}
      </div>`;
    this.setFoot('');
  }

  renderControls() {
    const keys = [
      ['WASD', 'Move'], ['Mouse', 'Look'], ['Shift', 'Sprint'], ['Space', 'Jump / Ascend'],
      ['Ctrl', 'Crouch / Descend'], ['E', 'Interact / Store fish'], ['G', 'Drop held item'],
      ['LMB', 'Cast / Reel / Use'], ['RMB', 'Aim / Throw / Hook set'], ['R', 'Reload'],
      ['F', 'Flashlight'], ['1-9', 'Hotbar'], ['Wheel', 'Cycle hotbar'],
      ['Tab', 'Inventory'], ['B', 'Fish Atlas'], ['M', 'World Map'], ['O', 'Company'],
      ['V', 'Vehicle camera'], ['Esc', 'Pause'], ['F3', 'Performance'], ['F4', 'Hide HUD'], ['F8', 'Dev menu'],
    ];
    this.bodyEl.innerHTML = `<div class="grid c2">${keys.map(([k, v]) =>
      `<div class="stat-line"><span class="sl-k">${v}</span><span class="sl-v">${k}</span></div>`).join('')}</div>`;
    this.setFoot('');
  }
}

function formatSetting(key, v) {
  if (key === 'sensitivity') return (v * 1000).toFixed(1);
  if (key === 'shadowRes' || key === 'maxFish') return String(v);
  if (key === 'fov') return `${v}°`;
  return typeof v === 'number' ? v.toFixed(2) : String(v);
}
