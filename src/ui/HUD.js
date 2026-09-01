import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp01, formatMoney, formatMoneyExact, formatWeight, formatDistance, formatTime, lerp, damp } from '../util/math.js';

/** Event rows drawn before the strip collapses into a "+n more" line. */
const MAX_EVENT_ROWS = 5;
/** Seconds a freshly started event shows its summary without being asked. */
const EVENT_REVEAL = 9;

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

/** Root HUD: money, objective, hotbar, bars, prompts, toasts, popups. */
export class HUD {
  constructor(game) {
    this.game = game;
    this.name = 'hud';
    this.order = 900;
    this.root = null;
    this.visible = true;
    this._money = 0;
    this._moneyShown = 0;
    this._toasts = [];
    this._floats = [];
    this._catchTimer = 0;
    this._bannerTimer = 0;
  }

  async init(game) {
    const r = document.getElementById('ui-root');
    this.root = el('div', 'hud');
    r.appendChild(this.root);

    this.crosshair = el('div', '');
    this.crosshair.id = 'crosshair';
    this.root.appendChild(this.crosshair);

    // top-left objective
    const tl = el('div', 'hud-corner hud-tl');
    this.objective = el('div', '');
    this.objective.id = 'objective';
    this.objective.innerHTML = `<div class="obj-label">Objective</div><div class="obj-text">…</div><div class="obj-progress"></div>`;
    tl.appendChild(this.objective);
    this.objText = this.objective.querySelector('.obj-text');
    this.objProg = this.objective.querySelector('.obj-progress');

    // Active world events. Laid out *inside* the top-left corner, below the
    // objective card, so it can never overlap it however tall the card gets.
    this.eventStrip = el('div', '');
    this.eventStrip.id = 'event-strip';
    this.eventStrip.classList.add('hidden');
    tl.appendChild(this.eventStrip);
    this._eventRows = [];
    this._eventSig = '';
    this.root.appendChild(tl);

    // top-right money
    const tr = el('div', 'hud-corner hud-tr');
    this.moneyEl = el('div', '');
    this.moneyEl.id = 'money';
    this.moneyEl.textContent = '$0';
    this.moneySub = el('div', '');
    this.moneySub.id = 'money-sub';
    tr.appendChild(this.moneyEl);
    tr.appendChild(this.moneySub);
    this.root.appendChild(tr);

    // bottom-left bars
    const bl = el('div', 'hud-corner hud-bl');
    this.bars = el('div', '');
    this.bars.innerHTML = `
      <div class="bar-row"><span class="bar-label">HP</span><div class="bar health"><i style="width:100%"></i></div></div>
      <div class="bar-row"><span class="bar-label">STA</span><div class="bar stamina"><i style="width:100%"></i></div></div>
      <div class="bar-row hidden" data-oxy><span class="bar-label">O2</span><div class="bar oxygen"><i style="width:100%"></i></div></div>`;
    bl.appendChild(this.bars);
    this.root.appendChild(bl);
    this.hpFill = this.bars.querySelector('.health > i');
    this.staFill = this.bars.querySelector('.stamina > i');
    this.oxyRow = this.bars.querySelector('[data-oxy]');
    this.oxyFill = this.bars.querySelector('.oxygen > i');

    // bottom-center hotbar
    const bc = el('div', 'hud-corner hud-bc');
    this.hotbar = el('div', '');
    this.hotbar.id = 'hotbar';
    bc.appendChild(this.hotbar);
    this.root.appendChild(bc);

    // bottom-right storage
    const br = el('div', 'hud-corner hud-br');
    this.storageEl = el('div', '', '');
    this.storageEl.style.cssText = 'font-family:var(--mono);font-size:12px;color:var(--ink-dim);text-align:right';
    br.appendChild(this.storageEl);
    this.root.appendChild(br);

    // interaction prompt
    this.interact = el('div', '');
    this.interact.id = 'interact';
    this.root.appendChild(this.interact);

    // fishing hud
    this.fishHud = el('div', '');
    this.fishHud.id = 'fishing-hud';
    this.fishHud.innerHTML = `
      <div class="fish-name-row"><span class="fish-name">—</span><span class="fish-weight"></span></div>
      <div class="tension-wrap">
        <div class="tension-bar"><i></i></div>
        <div class="tension-marks"><i style="left:60%"></i><i style="left:80%"></i></div>
      </div>
      <div class="fish-dist"></div>`;
    this.hookPrompt = el('div', '');
    this.hookPrompt.id = 'hook-prompt';
    this.hookPrompt.innerHTML = `<div class="hp-text">STRIKE!</div><div class="hp-bar"><i></i></div>`;
    this.root.appendChild(this.hookPrompt);
    this.hookBar = this.hookPrompt.querySelector('.hp-bar > i');
    this.root.appendChild(this.fishHud);
    this.fishName = this.fishHud.querySelector('.fish-name');
    this.fishWeight = this.fishHud.querySelector('.fish-weight');
    this.tensionBar = this.fishHud.querySelector('.tension-bar');
    this.tensionFill = this.fishHud.querySelector('.tension-bar > i');
    this.fishDist = this.fishHud.querySelector('.fish-dist');

    // cast power
    this.castPower = el('div', '');
    this.castPower.id = 'cast-power';
    this.castPower.innerHTML = `<div class="cp-bar"><i></i></div><div class="cp-label">Cast Power</div>`;
    this.root.appendChild(this.castPower);
    this.castFill = this.castPower.querySelector('.cp-bar > i');

    // toasts
    this.toastBox = el('div', '');
    this.toastBox.id = 'toasts';
    this.root.appendChild(this.toastBox);

    // catch popup
    this.catchPopup = el('div', '');
    this.catchPopup.id = 'catch-popup';
    this.root.appendChild(this.catchPopup);

    // style meter
    this.styleMeter = el('div', '');
    this.styleMeter.id = 'style-meter';
    this.styleMeter.innerHTML = `<div class="sm-mult">1.0x</div><div class="sm-tricks"></div><div class="sm-bar"><i></i></div>`;
    this.root.appendChild(this.styleMeter);
    this.smMult = this.styleMeter.querySelector('.sm-mult');
    this.smTricks = this.styleMeter.querySelector('.sm-tricks');
    this.smBar = this.styleMeter.querySelector('.sm-bar > i');

    // region banner
    this.banner = el('div', '');
    this.banner.id = 'region-banner';
    this.banner.innerHTML = `<div class="rb-name"></div><div class="rb-sub"></div>`;
    this.root.appendChild(this.banner);

    // overlays
    this.root.appendChild(Object.assign(el('div'), { id: 'vignette' }));
    this.waterOverlay = Object.assign(el('div'), { id: 'water-overlay' });
    this.root.appendChild(this.waterOverlay);
    this.depthVignette = Object.assign(el('div'), { id: 'depth-vignette' });
    this.root.appendChild(this.depthVignette);
    this.damageFlash = Object.assign(el('div'), { id: 'damage-flash' });
    this.root.appendChild(this.damageFlash);

    // compass
    this.compass = el('div', '');
    this.compass.id = 'compass';
    this.compass.innerHTML = `<div class="cmp-strip"></div>`;
    this.compassStrip = this.compass.querySelector('.cmp-strip');
    this.root.appendChild(this.compass);
    this._buildCompass();

    // float text layer
    this.floatLayer = el('div', '');
    this.floatLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    this.root.appendChild(this.floatLayer);

    // perf
    this.perfEl = el('div', '');
    this.perfEl.id = 'perf-overlay';
    this.perfEl.classList.add('hidden');
    this.root.appendChild(this.perfEl);

    this._wire();
    return this;
  }

  _wire() {
    bus.on('toast', (t) => this.toast(t.text, t.kind, t.duration));
    bus.on('money:changed', ({ total, delta }) => this.setMoney(total, delta));
    bus.on('objective:changed', (o) => this.setObjective(o));
    bus.on('fx:floatText', (f) => this.floatText(f));
    bus.on('catch:popup', (c) => this.showCatch(c));
    bus.on('region:entered', (r) => this.showBanner(r.name, r.desc ? '' : '', r));
    bus.on('player:hurt', () => this.flashDamage());
    bus.on('perf', (p) => { if (this.game.settings.showFps) this._updatePerf(p); });
    bus.on('settings:applied', (s) => {
      this.perfEl.classList.toggle('hidden', !s.showFps);
      document.documentElement.style.setProperty('--ui-scale', s.uiScale ?? 1);
    });
    bus.on('hud:visible', (v) => { this.visible = v; this.root.style.display = v ? '' : 'none'; });
  }

  _buildCompass() {
    const marks = [];
    for (let a = 0; a < 360; a += 15) {
      const card = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[a];
      marks.push({ a, label: card || '·', card: !!card });
    }
    this._compassMarks = marks;
    this.compassStrip.innerHTML = marks.map((m, i) =>
      `<span class="cmp-tick ${m.card ? 'card' : ''}" data-i="${i}">${m.label}</span>`).join('');
    this._compassEls = [...this.compassStrip.querySelectorAll('.cmp-tick')];
  }

  setMoney(total, delta) {
    this._money = total;
    if (delta && Math.abs(delta) > 0.5) {
      this.moneyEl.classList.remove('pop');
      void this.moneyEl.offsetWidth;
      this.moneyEl.classList.add('pop');
    }
  }

  setObjective(o) {
    if (!o) { this.objective.style.display = 'none'; return; }
    this.objective.style.display = '';
    this.objText.textContent = o.text || '';
    this.objProg.textContent = o.progress || '';
    this.objProg.style.display = o.progress ? '' : 'none';
    this.objective.classList.remove('flash');
    void this.objective.offsetWidth;
    this.objective.classList.add('flash');
  }

  setInteract(text, key = 'E') {
    if (!text) { this.interact.classList.remove('show'); return; }
    this.interact.innerHTML = `<kbd>${key}</kbd>${text}`;
    this.interact.classList.add('show');
  }

  setCrosshair(state) {
    this.crosshair.className = state || '';
  }

  setHotbar(slots, activeIndex) {
    const sig = slots.map((s) => `${s?.id || ''}:${s?.count || 0}:${(s?.durability ?? 1).toFixed(2)}`).join('|') + '#' + activeIndex;
    if (sig === this._hotbarSig) return;
    this._hotbarSig = sig;
    this.hotbar.innerHTML = slots.map((s, i) => {
      if (!s) return `<div class="slot empty"><span class="slot-num">${i + 1}</span></div>`;
      const dur = s.durability != null && s.durability < 1
        ? `<div class="slot-dur" style="width:${Math.round(s.durability * 100)}%"></div>` : '';
      return `<div class="slot ${i === activeIndex ? 'active' : ''}">
        <span class="slot-num">${i + 1}</span>
        <span class="slot-icon">${s.icon || '❔'}</span>
        ${s.count > 1 ? `<span class="slot-count">${s.count}</span>` : ''}
        <span class="slot-name">${s.name || ''}</span>${dur}</div>`;
    }).join('');
  }

  setFishing(state) {
    if (!state) { this.fishHud.classList.remove('show'); return; }
    this.fishHud.classList.add('show');
    this.fishName.textContent = state.name || 'Something';
    if (state.rarityColor) this.fishName.style.color = state.rarityColor;
    this.fishWeight.textContent = state.weight ? formatWeight(state.weight) : '';
    const t = clamp01(state.tension || 0);
    this.tensionFill.style.width = `${t * 100}%`;
    this.tensionBar.classList.toggle('danger', t > 0.8);
    this.fishDist.textContent = state.distance != null ? `${state.distance.toFixed(1)} m` : '';
  }

  /** The hook-set timing window — the one thing a new player can't see. */
  setHookWindow(frac, label) {
    if (frac == null) { this.hookPrompt.classList.remove('show'); return; }
    this.hookPrompt.classList.add('show');
    this.hookBar.style.width = `${clamp01(frac) * 100}%`;
    this.hookBar.style.background = frac > 0.5 ? 'var(--good)' : frac > 0.25 ? 'var(--warn)' : 'var(--danger)';
    if (label) this.hookPrompt.querySelector('.hp-text').textContent = label;
  }

  setCastPower(p) {
    if (p == null) { this.castPower.classList.remove('show'); return; }
    this.castPower.classList.add('show');
    this.castFill.style.width = `${clamp01(p) * 100}%`;
  }

  setStyle(mult, tricks, timeLeft) {
    if (!mult || mult <= 1.001) { this.styleMeter.classList.remove('show'); return; }
    this.styleMeter.classList.add('show');
    this.smMult.textContent = `${mult.toFixed(1)}x`;
    this.smTricks.textContent = tricks || '';
    this.smBar.style.width = `${clamp01(timeLeft) * 100}%`;
  }

  /**
   * Bucket readout. Deliberately terse -- count, load, and only the alive
   * tally when there is something still flopping to deal with.
   */
  setBucket(b) {
    if (!this._bucketEl) {
      const el = document.createElement('div');
      el.className = 'hud-bucket';
      (document.getElementById('ui-root') || document.body).appendChild(el);
      this._bucketEl = el;
    }
    const el = this._bucketEl;
    if (!b || !b.count) { el.classList.remove('show'); return; }
    el.classList.add('show');
    const full = b.weight / Math.max(1, b.capacity);
    const sig = `${b.count}|${b.alive}|${b.weight.toFixed(1)}|${b.capacity}|${b.value}`;
    if (sig === this._bucketSig) return;      // rebuilding every frame throws away the transition
    this._bucketSig = sig;
    el.innerHTML = `
      <div class="hb-head">🪣 <b>Bucket</b>${b.carried ? '<i>carried</i>' : ''}</div>
      <div class="hb-row"><span>${b.count} fish</span>${b.alive ? `<em>${b.alive} alive</em>` : ''}</div>
      <div class="hb-bar ${full > 0.92 ? 'full' : full > 0.7 ? 'warn' : ''}"><i style="width:${Math.min(100, full * 100)}%"></i></div>
      <div class="hb-row sub"><span>${formatWeight(b.weight)} / ${formatWeight(b.capacity)}</span><b>${formatMoneyExact(b.value)}</b></div>`;
  }

  /**
   * Superseded by the bucket widget, which shows the same load plus what is
   * still alive. Kept as a no-op because Inventory calls it every frame, and
   * two readouts of one number is how they end up disagreeing.
   */
  setStorage() { if (this.storageEl) this.storageEl.textContent = ''; }

  /**
   * Mirror the live world events into the strip. Rows are rebuilt only when the
   * set of events changes (title/icon/summary are final by the time an event
   * reaches `activeEvents` — `apply()` runs before it is pushed), so the
   * per-frame cost is one text write per row per whole second.
   */
  _updateEvents(game) {
    const list = game.get('events')?.activeEvents;
    const ui = game.get('ui');
    const blocked = !!(ui?.anyOpen?.() || game.get('debug')?.open);
    const n = list?.length || 0;

    let sig = '';
    for (let i = 0; i < n; i++) sig += `${list[i].uid},`;
    if (sig !== this._eventSig) { this._eventSig = sig; this._buildEventRows(list, n); }

    this.eventStrip.classList.toggle('hidden', blocked || n === 0);
    if (blocked || !this._eventRows.length) return;

    for (const r of this._eventRows) {
      const t = Math.max(0, Math.ceil(r.ev.remaining));
      if (t === r.lastT) continue;
      r.lastT = t;
      r.timeEl.textContent = formatTime(t);
      r.el.classList.toggle('urgent', t <= 30);
      // Auto-reveal the summary for a beat: hovering only works when the
      // pointer is free, and it is locked for most of the game.
      r.el.classList.toggle('open', r.ev.elapsed < EVENT_REVEAL);
    }
  }

  _buildEventRows(list, n) {
    const shown = Math.min(n, MAX_EVENT_ROWS);
    let html = '';
    for (let i = 0; i < shown; i++) {
      const ev = list[i];
      html += `<div class="ev-row">
        <span class="ev-icon">${ev.icon || '❗'}</span>
        <span class="ev-title">${ev.title || ev.id}</span>
        <span class="ev-time">—</span>
        <span class="ev-sum">${ev.summary || ev.def?.desc || ''}</span>
      </div>`;
    }
    if (n > shown) html += `<div class="ev-more">+${n - shown} more</div>`;
    this.eventStrip.innerHTML = html;
    const els = this.eventStrip.querySelectorAll('.ev-row');
    this._eventRows.length = 0;
    for (let i = 0; i < els.length; i++) {
      this._eventRows.push({ el: els[i], timeEl: els[i].querySelector('.ev-time'), ev: list[i], lastT: -1 });
    }
  }

  toast(text, kind = '', duration = 3200) {
    const t = el('div', `toast ${kind}`, text);
    this.toastBox.appendChild(t);
    const rec = { el: t, until: performance.now() + duration };
    this._toasts.push(rec);
    if (this._toasts.length > 7) {
      const old = this._toasts.shift();
      old.el.remove();
    }
  }

  floatText({ position, text, color = '#fff', size = 20, worldSpace = true }) {
    const e = el('div', 'float-text', text);
    e.style.color = color;
    e.style.fontSize = `${size}px`;
    this.floatLayer.appendChild(e);
    this._floats.push({ el: e, position: position ? position.clone() : null, born: performance.now(), worldSpace });
    setTimeout(() => { e.remove(); this._floats = this._floats.filter((f) => f.el !== e); }, 1550);
  }

  showCatch({ name, rarity, rarityColor, weight, length, value, badges = [], species }) {
    this.catchPopup.innerHTML = `
      <div class="cp-rarity" style="color:${rarityColor}">${rarity || ''}</div>
      <div class="cp-name">${name}</div>
      <div class="cp-stats">${formatWeight(weight)}${length ? ` · ${length.toFixed(2)} m` : ''}</div>
      ${value != null ? `<div class="cp-value">${formatMoneyExact(value)}</div>` : ''}
      ${badges.map((b) => `<span class="cp-badge">${b}</span>`).join(' ')}`;
    this.catchPopup.classList.remove('out');
    this.catchPopup.classList.remove('show');
    void this.catchPopup.offsetWidth;
    this.catchPopup.classList.add('show');
    this._catchTimer = 2.6;
  }

  showBanner(name, sub, region) {
    this.banner.querySelector('.rb-name').textContent = name;
    this.banner.querySelector('.rb-sub').textContent = sub || (region?.short ? `Region ${region.tier}` : '');
    this.banner.classList.add('show');
    this._bannerTimer = 3.0;
  }

  flashDamage() {
    this.damageFlash.classList.add('show');
    setTimeout(() => this.damageFlash.classList.remove('show'), 90);
  }

  setUnderwater(on, depth = 0) {
    this.waterOverlay.classList.toggle('show', on);
    this.oxyRow.classList.toggle('hidden', !on);
    this.depthVignette.style.opacity = on ? String(clamp01((depth - 8) / 60) * 0.9) : '0';
  }

  _updatePerf(p) {
    this.perfEl.textContent =
      `${p.fps.toFixed(0)} fps  ${p.ms.toFixed(1)}ms\n` +
      `draw ${p.drawCalls}  tri ${(p.tris / 1000).toFixed(0)}k\n` +
      `phys ${p.physMs.toFixed(1)}ms  rnd ${p.renderMs.toFixed(1)}ms\n` +
      `bodies ${this.game.physics.bodyCount}`;
  }

  update(dt, game) {
    if (!this.visible) return;
    // money counter roll-up
    if (Math.abs(this._moneyShown - this._money) > 0.5) {
      this._moneyShown = damp(this._moneyShown, this._money, 0.0005, dt);
      if (Math.abs(this._moneyShown - this._money) < 1) this._moneyShown = this._money;
      this.moneyEl.textContent = formatMoneyExact(this._moneyShown);
    }

    const p = game.get('player');
    if (p) {
      const hpFrac = clamp01(p.health / p.maxHealth);
      const staFrac = clamp01(p.stamina / 100);
      this.hpFill.style.width = `${hpFrac * 100}%`;
      this.staFill.style.width = `${staFrac * 100}%`;
      // Context only. A permanently visible full health bar is decoration --
      // it appears when it has something to say and fades when it does not.
      const barsMatter = hpFrac < 0.995 || staFrac < 0.9 || p.underwater;
      if (barsMatter !== this._barsShown) {
        this._barsShown = barsMatter;
        this.bars.classList.toggle('idle', !barsMatter);
      }
      this.oxyFill.style.width = `${clamp01(p.oxygen / p.maxOxygen) * 100}%`;
      const ocean = game.get('ocean');
      const depth = ocean ? Math.max(0, ocean.heightAt(p.position.x, p.position.z) - p.position.y) : 0;
      this.setUnderwater(p.underwater, depth);
      // compass
      const yawDeg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
      for (let i = 0; i < this._compassEls.length; i++) {
        let d = this._compassMarks[i].a - yawDeg;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        const x = 150 + d * 2.6;
        const e = this._compassEls[i];
        if (x < -20 || x > 320) { e.style.display = 'none'; continue; }
        e.style.display = '';
        e.style.left = `${x}px`;
        e.style.opacity = String(1 - Math.abs(d) / 75);
      }
    }

    this._updateEvents(game);

    // toasts
    const now = performance.now();
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      if (now > t.until) {
        t.el.classList.add('out');
        setTimeout(() => t.el.remove(), 320);
        this._toasts.splice(i, 1);
      }
    }

    // world-space float text projection
    if (this._floats.length) {
      const cam = game.camera;
      const w = window.innerWidth, h = window.innerHeight;
      for (const f of this._floats) {
        if (!f.worldSpace || !f.position) continue;
        _v.copy(f.position).project(cam);
        if (_v.z > 1) { f.el.style.display = 'none'; continue; }
        f.el.style.display = '';
        f.el.style.left = `${(_v.x * 0.5 + 0.5) * w}px`;
        f.el.style.top = `${(-_v.y * 0.5 + 0.5) * h}px`;
      }
    }

    if (this._catchTimer > 0) {
      this._catchTimer -= dt;
      if (this._catchTimer <= 0) {
        this.catchPopup.classList.remove('show');
        this.catchPopup.classList.add('out');
      }
    }
    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0) this.banner.classList.remove('show');
    }
  }
}

const _v = new THREE.Vector3();
