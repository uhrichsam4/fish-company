import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { REGION_BY_ID } from '../../data/regions.js';
import { NPC_BY_ID, npcLine, npcState, npcResponses, npcTopicLine } from '../../data/npcs.js';
import { QUEST_BY_ID } from '../../data/quests.js';

/**
 * Conversation UI.
 *
 * Portrait approach: a large glyph in a tinted disc rather than a live 3D
 * render. Rendering the NPC head to an offscreen target would mean a second
 * render pass, a second camera, a duplicated rig and a render-target lifecycle
 * for something the player looks at for four seconds — the disc costs nothing
 * and reads better against the panel chrome.
 *
 * Text reveals with a typewriter; clicking anywhere in the panel completes the
 * reveal instantly. Responses appear once the line is fully out.
 */
export class DialoguePanel extends Panel {
  constructor(game) {
    super(game, { id: 'dialogue', title: '', subtitle: '', width: 'narrow' });
    this.npc = null;
    this.node = 'root';
    this.lineIdx = 0;
    this._full = '';
    this._shown = 0;
    this._timer = 0;
    this._responses = [];
  }

  show() {
    const id = this.data?.npcId;
    this.npc = NPC_BY_ID[id] || null;
    this.node = 'root';
    this.lineIdx = 0;
    this.title = this.npc?.name || 'Someone';
    super.show();
    if (this.el) this.el.querySelector('.panel-head h2').textContent = this.npc?.name || 'Someone';
    this._say(this._lineForNode());
  }

  close() {
    this._stopReveal();
    super.close();
  }

  // -------------------------------------------------------------- content

  _ctx() {
    const sys = this.game.get('npcs');
    return sys ? sys.ctx() : { met: new Set() };
  }

  _lineForNode() {
    const npc = this.npc;
    if (!npc) return '...';
    const ctx = this._ctx();
    if (this.node === 'root') {
      const state = this.data?.first ? 'first' : npcState(npc, ctx);
      return npcLine(npc, ctx, state, this.lineIdx);
    }
    return npcTopicLine(npc, ctx, this.node, this.lineIdx);
  }

  _linesInNode() {
    const npc = this.npc;
    if (!npc) return 1;
    const ctx = this._ctx();
    if (this.node === 'root') {
      const state = this.data?.first ? 'first' : npcState(npc, ctx);
      return (npc.lines?.[state] || npc.lines?.default || ['']).length;
    }
    if (this.node === 'gossip') {
      const n = (npc.gossip || []).filter((g) => { try { return !!g.when(ctx); } catch { return false; } }).length;
      return Math.max(1, n);
    }
    if (this.node === 'about') return (npc.lines.about || npc.lines.default || ['']).length;
    return 1;
  }

  // --------------------------------------------------------------- render

  render() {
    if (!this.el || !this.npc) return;
    const npc = this.npc;
    const hex = `#${(npc.accent >>> 0).toString(16).padStart(6, '0')}`;
    const region = REGION_BY_ID[npc.region];

    if (!this._built) {
      this.bodyEl.innerHTML = `
        <div class="dlg-wrap" style="display:flex;gap:16px;align-items:flex-start;min-height:186px">
          <div class="dlg-portrait" style="flex:0 0 96px;width:96px;height:96px;border-radius:50%;
               display:flex;align-items:center;justify-content:center;font-size:50px;line-height:1;
               background:radial-gradient(circle at 34% 28%, rgba(255,255,255,.14), rgba(0,0,0,.42));
               border:2px solid ${hex};box-shadow:0 0 24px ${hex}44, inset 0 0 22px rgba(0,0,0,.55)">
            <span class="dlg-emoji"></span>
          </div>
          <div style="flex:1;min-width:0">
            <div class="dlg-name" style="font-size:19px;font-weight:900;letter-spacing:-.01em"></div>
            <div class="dlg-title" style="font-size:11.5px;color:var(--ink-faint);text-transform:uppercase;
                 letter-spacing:.14em;font-weight:800;margin-bottom:10px"></div>
            <div class="dlg-text" style="font-size:15px;line-height:1.55;min-height:74px;color:var(--ink)"></div>
            <div class="dlg-skip" style="font-size:10.5px;color:var(--ink-faint);letter-spacing:.12em;
                 text-transform:uppercase;margin-top:6px;height:14px"></div>
          </div>
        </div>
        <div class="dlg-responses" style="display:flex;flex-direction:column;gap:7px;margin-top:14px"></div>`;
      this._built = true;
      this.textEl = this.bodyEl.querySelector('.dlg-text');
      this.skipEl = this.bodyEl.querySelector('.dlg-skip');
      this.respEl = this.bodyEl.querySelector('.dlg-responses');

      // Capture-phase so a click lands on "skip the reveal" before it can
      // reach a response button (which is hidden while revealing anyway).
      this.el.addEventListener('click', (e) => {
        if (this._revealing()) { this._completeReveal(); e.stopPropagation(); }
      }, true);

      this.onAction((act, ds) => this._onAction(act, ds));
    }

    this.bodyEl.querySelector('.dlg-emoji').textContent = npc.emoji || '🙂';
    this.bodyEl.querySelector('.dlg-name').textContent = npc.name;
    this.bodyEl.querySelector('.dlg-title').textContent = `${npc.title} · ${region?.name || npc.region}`;
    this.setSubtitle('');
  }

  _say(text) {
    this.render();
    this._full = String(text || '');
    this._shown = 0;
    this._stopReveal();
    this.respEl.innerHTML = '';
    this.skipEl.textContent = 'click to skip';
    this.textEl.textContent = '';
    // Time-based rather than tick-based: a throttled timer in a background
    // tab would otherwise stretch a two-line remark into ten seconds.
    const CPS = 78;
    const t0 = performance.now();
    this._timer = setInterval(() => {
      this._shown = Math.min(this._full.length, Math.ceil((performance.now() - t0) / 1000 * CPS));
      this.textEl.innerHTML = this._full.slice(0, this._shown);
      if (this._shown >= this._full.length) this._completeReveal();
    }, 16);
    this.game.audio?.play('ui_hover', { volume: 0.14, throttle: 90 });
  }

  _revealing() { return !!this._timer; }

  _stopReveal() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _completeReveal() {
    this._stopReveal();
    this._shown = this._full.length;
    if (this.textEl) this.textEl.innerHTML = this._full;
    if (this.skipEl) this.skipEl.textContent = '';
    this._renderResponses();
  }

  _renderResponses() {
    if (!this.respEl || !this.npc) return;
    const ctx = this._ctx();
    const list = npcResponses(this.npc, ctx, this.node);

    // At most four buttons, so they are picked by priority rather than by
    // whatever order the data happened to produce: the things that DO
    // something (take a job, open the shop, sit at the table) outrank chat.
    const more = this.lineIdx + 1 < this._linesInNode();
    const RANK = ['accept', 'remind', 'shop', 'gamble', 'gossip', 'about', 'back'];
    const ranked = [...list].filter((r) => r.id !== 'leave')
      .sort((a, b) => RANK.indexOf(a.id) - RANK.indexOf(b.id));
    const rows = [];
    if (more) rows.push({ id: 'more', text: 'Go on…', action: 'continue' });
    for (const r of ranked) { if (rows.length < 3) rows.push(r); }
    const leave = list.find((r) => r.id === 'leave');
    if (leave) rows.push(leave);

    this._responses = rows;
    this.respEl.innerHTML = rows.map((r, i) =>
      `<button class="btn ${r.kind || ''} block" data-action="resp" data-idx="${i}"
         style="justify-content:flex-start;text-align:left;animation:fadeUp .18s ease ${i * 0.03}s both">
         <span style="opacity:.45;font-family:var(--mono);margin-right:8px">${i + 1}</span>${r.text}</button>`).join('');
  }

  _onAction(act, ds) {
    if (act !== 'resp') return;
    const r = this._responses[+ds.idx];
    if (!r) return;
    this.game.audio?.play('ui_click', { volume: 0.4 });

    switch (r.action) {
      case 'continue':
        this.lineIdx++;
        this._say(this._lineForNode());
        break;

      case 'topic':
        this.node = r.topic === 'root' ? 'root' : r.topic;
        this.lineIdx = 0;
        if (this.node === 'root') this.data.first = false;
        this._say(this._lineForNode());
        break;

      case 'quest': {
        const quests = this.game.get('quests');
        const def = QUEST_BY_ID[r.questId];
        const ok = quests?.start(r.questId);
        if (ok) {
          this.game.audio?.play('quest_complete', { volume: 0.4 });
          bus.emit('npc:questGiven', { npc: this.npc.id, quest: r.questId });
        }
        this.node = 'root';
        this.lineIdx = 0;
        this.data.first = false;
        this._say(ok
          ? `Good. ${def?.desc || ''}`
          : npcLine(this.npc, this._ctx(), 'questActive', 0));
        break;
      }

      case 'shop': {
        const region = REGION_BY_ID[this.npc.region];
        this.close();
        bus.emit('interact:shop', { tier: region?.shopTier || 1, region: this.npc.region, npc: this.npc.id });
        break;
      }

      case 'gambling':
        this.close();
        bus.emit('interact:gambling', { npc: this.npc.id, region: this.npc.region });
        break;

      case 'leave':
      default:
        this.close();
        break;
    }
  }

  /** Number keys pick a response — the panel is modal, so this is safe. */
  handleKey(code) {
    const m = /^Digit([1-9])$/.exec(code);
    if (!m) return false;
    const i = +m[1] - 1;
    if (this._revealing()) { this._completeReveal(); return true; }
    const btn = this.respEl?.querySelector(`[data-idx="${i}"]`);
    if (btn) { btn.click(); return true; }
    return false;
  }
}
