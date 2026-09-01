import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { QUESTS, QUEST_BY_ID } from '../../data/quests.js';
import { REGION_BY_ID } from '../../data/regions.js';
import { getItem } from '../../data/equipment.js';
import { formatMoneyExact, clamp01 } from '../../util/math.js';

const CHAIN_META = {
  intro: { name: 'Washed Ashore', icon: '🏝' },
  rocky: { name: 'Rocky Isle', icon: '🪨' },
  harbor: { name: 'Port Grimsby', icon: '⚓' },
  wilds: { name: 'The Wilds', icon: '🐠' },
  storm: { name: 'Storm Banks', icon: '⛈' },
  frozen: { name: 'Frozen Shelf', icon: '🧊' },
  deep: { name: 'The Deep', icon: '🕳' },
  side: { name: 'Odd Jobs', icon: '📌' },
};
const CHAIN_ORDER = ['intro', 'rocky', 'harbor', 'wilds', 'storm', 'frozen', 'deep', 'side'];

/** XP required to advance from `level` — mirrors QuestSystem.addXP. */
function xpNeeded(level) { return Math.round(100 * Math.pow(1.35, level - 1)); }

/**
 * The quest log: what you are doing, what it leads to, and what you already did.
 * Clicking any active quest re-points the HUD objective at it.
 */
export class QuestPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'quests', title: '📋 Quest Log', width: 'wide',
      tabs: [
        { id: 'active', name: 'Active', icon: '🎯' },
        { id: 'chains', name: 'Chains', icon: '🔗' },
        { id: 'done', name: 'Completed', icon: '✅' },
      ],
    });
    this.live = true;
    this.openChains = new Set(['intro']);
    this.showDone = false;
  }

  render() {
    if (!this.el) return;
    const q = this.game.get('quests');

    if (!q) {
      this.setHeadRight('');
      this.setSubtitle('');
      this.bodyEl.innerHTML = empty('📋', 'No quest log yet.', 'The story system is not running in this session.');
      this.setFoot('');
      this.bind();
      return;
    }

    const need = xpNeeded(q.level);
    const pct = clamp01(q.xp / need) * 100;
    this.setHeadRight(`<div class="q-level">
      <div class="q-level-num">Lv ${q.level}</div>
      <div class="q-level-bar"><div class="progress xp"><i style="width:${pct}%"></i></div>
        <div class="q-level-xp">${Math.floor(q.xp)} / ${Math.round(need)} XP</div></div>
    </div>`);
    this.setSubtitle(`${q.active.size} active · ${q.completed.size} / ${QUESTS.length} complete`);

    if (this.activeTab === 'active') this.renderActive(q);
    else if (this.activeTab === 'chains') this.renderChains(q);
    else this.renderDone(q);

    this.bind();
  }

  bind() {
    this.onAction((act, ds) => {
      const q = this.game.get('quests');
      if (act === 'track' && q) {
        if (!q.active.has(ds.id)) {
          bus.emit('toast', { text: 'That quest is not active yet', kind: 'warn', duration: 1800 });
        } else {
          q.tracked = ds.id;
          q.refreshObjective();
          this.game.audio?.play('ui_click', { volume: 0.45 });
          bus.emit('toast', { text: `🎯 Tracking <b>${QUEST_BY_ID[ds.id]?.name || ds.id}</b>`, kind: 'info', duration: 2200 });
        }
      } else if (act === 'chain') {
        if (this.openChains.has(ds.id)) this.openChains.delete(ds.id); else this.openChains.add(ds.id);
      } else if (act === 'toggleDone') {
        this.showDone = !this.showDone;
      } else if (act === 'map') bus.emit('ui:show', { id: 'map' });
      setTimeout(() => { if (this.open) this.render(); }, 30);
    });
  }

  // ---------------------------------------------------------------- active
  renderActive(q) {
    const list = q.activeList();
    if (!list.length) {
      this.bodyEl.innerHTML = empty('🎯', 'Nothing on the board.',
        'Finish a chain or unlock a new region and the next job will find you.');
      this.setFoot('');
      return;
    }
    list.sort((a, b) => (a.chain === 'side' ? 1 : 0) - (b.chain === 'side' ? 1 : 0) || (a.order ?? 50) - (b.order ?? 50));

    this.bodyEl.innerHTML = `<div class="grid c2">${list.map((k) => {
      const tracked = q.tracked === k.id;
      const meta = CHAIN_META[k.chain] || { name: k.chain, icon: '📋' };
      const region = k.region ? REGION_BY_ID[k.region] : null;
      return `<div class="card q-card ${tracked ? 'tracked' : 'hover'}" data-action="track" data-id="${k.id}" style="cursor:pointer">
        <div class="card-title">${meta.icon} ${k.name}
          <div style="flex:1"></div>
          ${tracked ? '<span class="chip good">Tracked</span>' : '<span class="chip q-track-hint">Track</span>'}
        </div>
        <div class="card-desc">${k.desc || ''}</div>
        <div class="q-objs">${k.progress.map((p) => {
          const w = clamp01(p.cur / Math.max(1, p.max)) * 100;
          const done = p.cur >= p.max;
          return `<div class="q-obj ${done ? 'done' : ''}">
            <div class="q-obj-head"><span>${done ? '✅' : '◻'} ${p.text}</span>
              <span class="q-obj-val">${p.max > 1 ? `${fmtNum(p.cur)} / ${fmtNum(p.max)}` : (done ? 'done' : '')}</span></div>
            ${p.max > 1 ? `<div class="progress" style="margin-top:4px"><i style="width:${w}%"></i></div>` : ''}
          </div>`;
        }).join('')}</div>
        <div class="card-row">
          <span style="font-size:11.5px;color:var(--ink-faint)">
            ${meta.name}${region ? ` · ${region.name}` : ''}${k.giver && k.giver !== 'self' ? ` · from the ${k.giver}` : ''}</span>
          <span class="q-rewards">${rewardChips(k.rewards)}</span>
        </div>
      </div>`;
    }).join('')}</div>`;

    const tracked = q.tracked ? QUEST_BY_ID[q.tracked] : null;
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">
      Click a quest to point the HUD objective at it${tracked ? ` — currently <b style="color:var(--accent)">${tracked.name}</b>` : ''}</span>
      <div style="flex:1"></div><button class="btn sm" data-action="map">🗺 World map</button>`);
  }

  // ---------------------------------------------------------------- chains
  renderChains(q) {
    const byChain = new Map();
    for (const k of QUESTS) {
      if (!byChain.has(k.chain)) byChain.set(k.chain, []);
      byChain.get(k.chain).push(k);
    }
    const chains = CHAIN_ORDER.filter((c) => byChain.has(c)).concat([...byChain.keys()].filter((c) => !CHAIN_ORDER.includes(c)));

    this.bodyEl.innerHTML = chains.map((cid) => {
      const meta = CHAIN_META[cid] || { name: cid, icon: '📋' };
      const items = byChain.get(cid).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
      const done = items.filter((k) => q.completed.has(k.id)).length;
      const openNow = this.openChains.has(cid);
      const anyActive = items.some((k) => q.active.has(k.id));
      return `<div class="card q-chain ${anyActive ? 'live' : ''}" style="margin-bottom:11px">
        <div class="card-title" data-action="chain" data-id="${cid}" style="cursor:pointer">
          <span>${openNow ? '▾' : '▸'}</span> ${meta.icon} ${meta.name}
          <div style="flex:1"></div>
          ${anyActive ? '<span class="chip good">In progress</span>' : ''}
          <span class="chip">${done} / ${items.length}</span>
        </div>
        <div class="progress" style="margin:6px 0 2px"><i style="width:${(done / items.length) * 100}%"></i></div>
        ${openNow ? `<div class="chain-track">${items.map((k, i) => this.chainNode(q, k, i, items)).join('')}</div>` : ''}
      </div>`;
    }).join('');
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">
      Solid links follow a chain automatically; dashed links wait for every prerequisite listed.</span>`);
  }

  chainNode(q, k, i, items) {
    const isDone = q.completed.has(k.id);
    const isActive = q.active.has(k.id);
    const st = isDone ? 'done' : isActive ? 'active' : 'locked';
    const prev = items[i - 1];
    const linkStyle = prev && prev.onComplete === k.id ? 'solid' : (k.requires?.length ? 'dashed' : 'none');
    const next = k.onComplete ? QUEST_BY_ID[k.onComplete] : null;
    return `${i > 0 ? `<div class="chain-link ${linkStyle}"></div>` : ''}
      <div class="chain-node ${st}" ${isActive ? `data-action="track" data-id="${k.id}"` : ''}
        title="${(k.desc || '').replace(/"/g, '&quot;')}">
        <div class="chain-dot">${isDone ? '✔' : isActive ? '●' : '○'}</div>
        <div class="chain-body">
          <div class="chain-name">${k.name}${q.tracked === k.id ? ' <span class="chip good">Tracked</span>' : ''}</div>
          <div class="chain-sub">${k.objectives.map((o) => o.text).join(' · ')}</div>
          ${isActive ? `<div class="progress" style="margin-top:5px"><i style="width:${activePct(q, k) * 100}%"></i></div>` : ''}
          ${k.requires?.length ? `<div class="chain-req">Needs: ${k.requires.map((r) => QUEST_BY_ID[r]?.name || r).join(', ')}</div>` : ''}
          ${next && !items.some((x) => x.id === next.id) ? `<div class="chain-req">Leads to: ${next.name}</div>` : ''}
        </div>
        <div class="chain-reward">${rewardChips(k.rewards)}</div>
      </div>`;
  }

  // ------------------------------------------------------------------ done
  renderDone(q) {
    const done = QUESTS.filter((k) => q.completed.has(k.id));
    if (!done.length) {
      this.bodyEl.innerHTML = empty('✅', 'Nothing finished yet.', 'Your completed work will collect here.');
      this.setFoot('');
      return;
    }
    const money = done.reduce((a, k) => a + (k.rewards?.money || 0), 0);
    const xp = done.reduce((a, k) => a + (k.rewards?.xp || 0), 0);
    this.bodyEl.innerHTML = `
      <div class="card" style="margin-bottom:11px">
        <div class="card-title">✅ ${done.length} completed
          <div style="flex:1"></div>
          <button class="btn sm" data-action="toggleDone">${this.showDone ? 'Collapse' : 'Expand'}</button>
        </div>
        <div class="grid c3" style="margin-top:6px">
          <div class="stat-line"><span class="sl-k">Rewards banked</span><span class="sl-v gold">${formatMoneyExact(money)}</span></div>
          <div class="stat-line"><span class="sl-k">XP earned</span><span class="sl-v">${xp.toLocaleString()}</span></div>
          <div class="stat-line"><span class="sl-k">Regions opened</span><span class="sl-v">${q.unlockedRegions.size}</span></div>
        </div>
      </div>
      ${this.showDone
        ? done.map((k) => {
          const meta = CHAIN_META[k.chain] || { name: k.chain, icon: '📋' };
          return `<div class="list-row">
            <span class="lr-icon">${meta.icon}</span>
            <div class="lr-main"><div class="lr-title">${k.name}</div>
              <div class="lr-sub">${meta.name} · ${k.desc || ''}</div></div>
            <div class="lr-right">${rewardChips(k.rewards)}</div>
          </div>`;
        }).join('')
        : `<div class="q-done-grid">${done.map((k) => `<span class="chip good" title="${(k.desc || '').replace(/"/g, '&quot;')}">${k.name}</span>`).join('')}</div>`}`;
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">${done.length} of ${QUESTS.length} quests complete</span>`);
  }
}

function activePct(q, k) {
  const st = q.active.get(k.id);
  if (!st) return 0;
  let t = 0;
  for (let i = 0; i < k.objectives.length; i++) {
    const o = k.objectives[i];
    const cap = o.type === 'money' ? o.amount : o.type === 'depth' ? o.metres : (o.count ?? 1);
    t += clamp01(st.progress[i] / cap);
  }
  return t / k.objectives.length;
}

function rewardChips(r) {
  if (!r) return '';
  const out = [];
  if (r.money) out.push(`<span class="chip gold">${formatMoneyExact(r.money)}</span>`);
  if (r.xp) out.push(`<span class="chip">${r.xp} XP</span>`);
  if (r.item) out.push(`<span class="chip good">${getItem(r.item)?.name || r.item}</span>`);
  if (r.unlockRegion) out.push(`<span class="chip good">🏝 ${REGION_BY_ID[r.unlockRegion]?.name || r.unlockRegion}</span>`);
  if (r.unlockFeature) out.push(`<span class="chip good">🔓 ${String(r.unlockFeature).replace(/_/g, ' ')}</span>`);
  return out.join(' ');
}

function fmtNum(n) {
  if (n >= 1000) return Math.floor(n).toLocaleString('en-US');
  return String(Math.floor(n * 10) / 10).replace(/\.0$/, '');
}

function empty(icon, text, hint) {
  return `<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${text}
    ${hint ? `<div style="margin-top:8px;opacity:.7;font-size:12.5px">${hint}</div>` : ''}</div></div>`;
}
