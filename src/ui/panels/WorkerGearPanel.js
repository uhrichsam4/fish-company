import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { ROD_TIERS, TOOLS, STORAGE_TIERS, getItem } from '../../data/equipment.js';
import { formatMoneyExact, formatWeight, clamp01 } from '../../util/math.js';

/** The three slots a Worker actually carries (`worker.equipment`). */
const SLOTS = [
  { key: 'rod', name: 'Rod', icon: '🎣', list: ROD_TIERS, desc: 'What they fish with.' },
  { key: 'tool', name: 'Tool', icon: '🔱', list: TOOLS, desc: 'Held kit — nets, knives, harpoons.' },
  { key: 'armor', name: 'Harness', icon: '🦺', list: STORAGE_TIERS, desc: 'Worn kit for hauling and heavy weather.' },
];

/** Human labels + formatting for a worker's derived multipliers (`worker.d`). */
const DERIVED = [
  ['biteSpeed', 'Bite rate', 'mult'],
  ['reelSpeed', 'Reel speed', 'mult'],
  ['catchQuality', 'Rare-fish quality', 'mult'],
  ['maxWeight', 'Heaviest fish', 'kg'],
  ['speedMult', 'Work speed', 'mult'],
  ['freshness', 'Catch freshness', 'mult'],
  ['xpMult', 'XP gain', 'mult'],
  ['wageMult', 'Wage multiplier', 'mult'],
  ['junkChance', 'Junk catches', 'pct'],
  ['dropChance', 'Drops things', 'pct'],
  ['danger', 'Risk taken', 'mult'],
];

/** What a single skill-tree point buys, per effect key. */
const EFFECT = {
  castRange: ['Cast range', 'pct'], hookChance: ['Bite rate', 'pct'], reelSpeed: ['Reel speed', 'pct'],
  rareBonus: ['Rare-fish chance', 'pct'], maxWeight: ['Max fish weight', 'pct'],
  accuracy: ['Accuracy', 'pct'], reload: ['Reload speed', 'pct'], damage: ['Damage', 'pct'],
  crit: ['Critical chance', 'pct'], bossDamage: ['Boss damage', 'pct'],
  boatSpeed: ['Boat speed', 'pct'], fuelEff: ['Fuel efficiency', 'pct'], stormHandling: ['Storm handling', 'pct'],
  travelSpeed: ['Travel speed', 'pct'], autonomy: ['Autonomy', 'pct'],
  carry: ['Carry capacity', 'pct'], haulSpeed: ['Haul speed', 'pct'], freshness: ['Catch freshness', 'pct'],
  stamina: ['Stamina', 'pct'], sonarRange: ['Sonar range', 'pct'], sonarDetail: ['Signal detail', 'flat'],
  catchRate: ['Catch rate', 'pct'], diveDepth: ['Dive depth', 'm'], air: ['Air efficiency', 'pct'],
  salvage: ['Salvage yield', 'pct'], danger: ['Risk taken', 'pct'], repairSpeed: ['Repair speed', 'pct'],
  wearReduction: ['Wear reduction', 'pct'], repairCost: ['Repair cost', 'pct'],
  processSpeed: ['Processing speed', 'pct'], processQuality: ['Processing quality', 'pct'],
  yieldBonus: ['Yield', 'pct'], processLevels: ['Processing tier', 'flat'],
  crushDepth: ['Crush depth', 'm'], power: ['Power efficiency', 'pct'], subSpeed: ['Sub handling', 'pct'],
  teamMorale: ['Team morale', 'pct'], teamEfficiency: ['Team efficiency', 'pct'],
  teamCatchRate: ['Team catch rate', 'pct'], priceMult: ['Sale price', 'pct'],
};

const RESPEC_BASE = 750;

/**
 * Kit out one employee: their gear, their derived numbers, and where their
 * level-up points went. Every price is charged through Economy.spend and every
 * change ends in `worker.recomputeDerived()`.
 */
export class WorkerGearPanel extends Panel {
  constructor(game) {
    super(game, { id: 'workerGear', title: '🦺 Crew Equipment', width: 'wide' });
    this.live = true;
    this.selected = null;
    this.slotTab = 'rod';
  }

  show() {
    if (this.data?.id) this.selected = this.data.id;
    super.show();
  }

  currentWorker() {
    const ws = this.game.get('workers');
    if (!ws?.workers.length) return null;
    return ws.workers.find((w) => w.id === this.selected) || ws.workers[0];
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const ws = g.get('workers');
    const eco = g.get('economy');
    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800;font-size:17px">${formatMoneyExact(eco?.money || 0)}</span>`);

    if (!ws || !ws.workers.length) {
      this.setSubtitle('');
      this.bodyEl.innerHTML = empty('🦺', 'You have no crew to equip.',
        'Hire someone at the employment office first — the Company panel’s Hire tab lists applicants.');
      this.setFoot('<button class="btn" data-action="hire">Open hiring</button>');
      this.bind();
      return;
    }

    const w = this.currentWorker();
    this.selected = w.id;
    this.setSubtitle(`${ws.workers.length} on the payroll`);

    this.bodyEl.innerHTML = `<div class="wg-cols">
      <div class="scroll-y wg-list">${ws.workers.map((x) => `
        <div class="list-row ${x.id === w.id ? 'selected' : ''}" data-action="select" data-id="${x.id}" style="cursor:pointer">
          <span class="lr-icon">${x.icon || '👷'}</span>
          <div class="lr-main"><div class="lr-title">${x.name} <span class="chip">Lv ${x.level}</span></div>
            <div class="lr-sub">${x.roleName} · ${gearCount(x)}/3 slots filled</div></div>
          <div class="lr-right">${pointsOf(x).available ? `<span class="chip good">${pointsOf(x).available} pt</span>` : ''}</div>
        </div>`).join('')}
      </div>
      <div class="wg-detail">
        ${this.detailHead(w)}
        ${this.gearSection(w, eco)}
        ${this.treeSection(w, eco)}
      </div>
    </div>`;

    const p = pointsOf(w);
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">
        ${w.name} · ${formatMoneyExact(w.wage)}/day · ${p.spent}/${p.total} tree points spent</span>
      <div style="flex:1"></div>
      <button class="btn sm" data-action="company">Back to Company</button>`);

    this.bind();
  }

  bind() {
    this.onAction((act, ds) => {
      const g = this.game;
      const eco = g.get('economy');
      const ws = g.get('workers');
      const w = this.currentWorker();

      if (act === 'select') { this.selected = ds.id; }
      else if (act === 'slotTab') { this.slotTab = ds.id; }
      else if (act === 'hire') { bus.emit('ui:show', { id: 'company', data: { tab: 'hire' } }); return; }
      else if (act === 'company') { bus.emit('ui:show', { id: 'company', data: { tab: 'workers' } }); return; }
      else if (act === 'fit' && w) {
        const item = getItem(ds.id);
        if (!item) return;
        if (item.price > 0 && !eco?.spend(item.price, 'worker_equipment')) {
          g.audio?.play('ui_error', { volume: 0.4 });
          bus.emit('toast', { text: `Not enough money for ${item.name}`, kind: 'error' });
          return;
        }
        if (!w.equipment) w.equipment = { rod: null, tool: null, armor: null };
        w.equipment[ds.slot] = item.id;
        w.recomputeDerived();
        g.audio?.play('purchase', { volume: 0.5 });
        bus.emit('toast', { text: `${w.name} fitted with <b>${item.name}</b>`, kind: 'success' });
        bus.emit('workers:changed', { count: ws?.workers.length || 0 });
      } else if (act === 'unfit' && w) {
        if (!w.equipment) w.equipment = { rod: null, tool: null, armor: null };
        w.equipment[ds.slot] = null;
        w.recomputeDerived();
        g.audio?.play('ui_click', { volume: 0.4 });
      } else if (act === 'point' && w) {
        const node = w.roleDef.tree.find((n) => n.id === ds.id);
        const p = pointsOf(w);
        if (!node || !p.available) return;
        const cur = w.treePoints[node.id] || 0;
        if (cur >= node.max) { bus.emit('toast', { text: `${node.name} is maxed`, kind: 'warn', duration: 1600 }); return; }
        w.treePoints[node.id] = cur + 1;
        w.recomputeDerived();
        g.audio?.play('levelup', { volume: 0.32 });
      } else if (act === 'respec' && w) {
        const cost = respecCost(w);
        if (!confirm(`Refund every skill point ${w.name} has spent for ${formatMoneyExact(cost)}?`)) return;
        if (!eco?.spend(cost, 'worker_respec')) {
          g.audio?.play('ui_error', { volume: 0.4 });
          bus.emit('toast', { text: 'Not enough money to retrain', kind: 'error' });
          return;
        }
        w.treePoints = {};
        w.recomputeDerived();
        bus.emit('toast', { text: `${w.name} retrained — ${pointsOf(w).available} points to spend`, kind: 'gold' });
      }
      setTimeout(() => { if (this.open) this.render(); }, 20);
    });
  }

  // ------------------------------------------------------------------ head
  detailHead(w) {
    const xpPct = clamp01(w.xp / w.xpToNext) * 100;
    const d = w.d || {};
    return `<div class="card">
      <div class="card-title" style="font-size:18px">${w.icon || '👷'} ${w.name}
        <div style="flex:1"></div>
        <span class="chip">Lv ${w.level}</span>
        <span class="chip ${w.morale > 0.6 ? 'good' : w.morale > 0.3 ? '' : 'bad'}">${Math.round(w.morale * 100)}% morale</span>
      </div>
      <div class="card-desc">${w.roleName} — ${w.roleDef.desc} · ${w.assignmentLabel}</div>
      <div class="progress xp" style="margin:8px 0 3px"><i style="width:${xpPct}%"></i></div>
      <div class="lr-sub">${Math.floor(w.xp)} / ${w.xpToNext} XP to level ${w.level + 1}</div>
      <div class="wg-two" style="margin-top:10px">
        <div>
          <div class="wg-sub">Skills</div>
          ${Object.entries(w.skills).filter(([k]) => w.roleDef.skills.includes(k))
            .map(([k, v]) => `<div class="wg-skill"><span>${cap(k)}</span>
              <span class="wg-pips">${pips(v, 10)}</span><b>${v}</b></div>`).join('')}
        </div>
        <div>
          <div class="wg-sub">Derived right now</div>
          ${DERIVED.filter(([k]) => d[k] != null).map(([k, label, kind]) =>
            `<div class="stat-line"><span class="sl-k">${label}</span>
              <span class="sl-v ${tone(k, d[k])}">${fmtDerived(kind, d[k])}</span></div>`).join('')}
        </div>
      </div>
      <div style="margin-top:9px">${(w.traits || []).map((t) =>
        `<span class="chip ${t.good ? 'good' : t.good === false ? 'bad' : ''}" title="${t.desc}">${t.name}</span>`).join(' ') || '<span class="lr-sub">No notable traits</span>'}</div>
    </div>`;
  }

  // ------------------------------------------------------------------ gear
  gearSection(w, eco) {
    const slot = SLOTS.find((s) => s.key === this.slotTab) || SLOTS[0];
    const fittedId = w.equipment?.[slot.key] || null;
    const fitted = getItem(fittedId);

    return `<div class="card" style="margin-top:11px">
      <div class="card-title">🧰 Equipment</div>
      <div class="wg-slots">${SLOTS.map((s) => {
        const it = getItem(w.equipment?.[s.key]);
        return `<div class="wg-slot ${s.key === this.slotTab ? 'active' : ''}" data-action="slotTab" data-id="${s.key}">
          <div class="wg-slot-icon">${it?.icon || s.icon}</div>
          <div class="wg-slot-body">
            <div class="wg-slot-name">${s.name}</div>
            <div class="wg-slot-item">${it ? it.name : '<span style="opacity:.5">empty</span>'}</div>
          </div>
        </div>`;
      }).join('')}</div>

      <div class="card-desc" style="margin:9px 0 6px">${slot.desc}
        ${fitted ? ` Fitted: <b style="color:var(--accent)">${fitted.name}</b>
          <button class="btn sm ghost" data-action="unfit" data-slot="${slot.key}" style="margin-left:8px">Remove</button>` : ''}</div>

      <div class="grid auto-sm wg-catalogue">${slot.list.map((item) => {
        const isOn = fittedId === item.id;
        const afford = (eco?.money || 0) >= item.price;
        const stats = Object.entries(item.stats || {})
          .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
          .slice(0, 4)
          .map(([k, v]) => `${cap(k.replace(/([A-Z])/g, ' $1'))}: <b>${typeof v === 'number' ? (v % 1 ? v.toFixed(2) : v) : v}</b>`)
          .join('<br>');
        return `<div class="card ${isOn ? 'owned' : 'hover'}" style="padding:9px">
          <div class="card-title" style="font-size:13px">${item.icon} ${item.name}</div>
          <div class="card-stats">${stats}</div>
          <div class="card-row">
            <span class="card-price ${afford || item.price === 0 ? '' : 'cant'}" style="font-size:13px">${item.price ? formatMoneyExact(item.price) : 'Free'}</span>
            ${isOn ? '<span class="chip good">Fitted</span>'
              : `<button class="btn sm ${afford && item.price ? 'gold' : ''}" data-action="fit" data-slot="${slot.key}" data-id="${item.id}"
                  ${afford || item.price === 0 ? '' : 'disabled'}>Fit</button>`}
          </div>
        </div>`;
      }).join('')}</div>
      <div class="lr-sub" style="margin-top:7px">Gear is bought outright and stays with the worker across saves.</div>
    </div>`;
  }

  // ------------------------------------------------------------------ tree
  treeSection(w, eco) {
    const p = pointsOf(w);
    const cost = respecCost(w);
    return `<div class="card" style="margin-top:11px">
      <div class="card-title">🌳 ${w.roleName} specialisation
        <div style="flex:1"></div>
        <span class="chip ${p.available ? 'good' : ''}">${p.available} point${p.available === 1 ? '' : 's'} to spend</span>
      </div>
      <div class="card-desc">One point per level. Levelling up spends a point automatically on whatever is least
        invested — retrain to take them all back and place them yourself.</div>
      <div class="wg-tree">${w.roleDef.tree.map((n) => {
        const cur = w.treePoints[n.id] || 0;
        const maxed = cur >= n.max;
        return `<div class="tree-node ${maxed ? 'maxed' : ''}">
          <div class="tree-head">
            <span class="tree-name">${n.name}</span>
            <span class="tree-pips">${pips(cur, n.max)}</span>
            <span class="tree-count">${cur}/${n.max}</span>
            <button class="btn sm ${p.available && !maxed ? 'primary' : ''}" data-action="point" data-id="${n.id}"
              ${p.available && !maxed ? '' : 'disabled'}>+</button>
          </div>
          <div class="tree-effect">${effectText(n.effect)}
            ${cur ? `<span class="tree-now">now ${effectTotal(n.effect, cur)}</span>` : ''}</div>
        </div>`;
      }).join('')}</div>
      <div class="card-row">
        <span style="font-size:11.5px;color:var(--ink-faint)">${p.spent} of ${p.total} points placed</span>
        <button class="btn sm danger" data-action="respec" ${p.spent ? '' : 'disabled'}>Retrain (${formatMoneyExact(cost)})</button>
      </div>
    </div>`;
  }
}

// -------------------------------------------------------------------- utils
function pointsOf(w) {
  const tree = w.roleDef?.tree || [];
  const cap = tree.reduce((a, n) => a + n.max, 0);
  let spent = 0;
  for (const n of tree) spent += Math.min(n.max, w.treePoints?.[n.id] || 0);
  const earned = Math.min(cap, Math.max(0, w.level - 1));
  return { spent, total: cap, earned, available: Math.max(0, earned - spent) };
}

function respecCost(w) { return Math.round(RESPEC_BASE * Math.pow(1.35, Math.max(0, w.level - 1))); }

function gearCount(w) {
  let n = 0;
  for (const s of SLOTS) if (w.equipment?.[s.key]) n++;
  return n;
}

function pips(cur, max) {
  let out = '';
  for (let i = 0; i < max; i++) out += `<i class="pip ${i < cur ? 'on' : ''}"></i>`;
  return out;
}

function effectText(effect) {
  return Object.entries(effect || {}).map(([k, v]) => {
    const [label, kind] = EFFECT[k] || [cap(k.replace(/([A-Z])/g, ' $1')), 'pct'];
    return `${label} ${fmtEffect(kind, v)} per point`;
  }).join(' · ');
}
function effectTotal(effect, pts) {
  return Object.entries(effect || {}).map(([k, v]) => {
    const [, kind] = EFFECT[k] || [null, 'pct'];
    return fmtEffect(kind, v * pts);
  }).join(' · ');
}
function fmtEffect(kind, v) {
  const sign = v >= 0 ? '+' : '−';
  const a = Math.abs(v);
  if (kind === 'pct') return `${sign}${(a * 100).toFixed(a * 100 % 1 ? 1 : 0)}%`;
  if (kind === 'm') return `${sign}${a} m`;
  return `${sign}${a}`;
}

function fmtDerived(kind, v) {
  if (kind === 'kg') return formatWeight(v);
  if (kind === 'pct') return `${(v * 100).toFixed(0)}%`;
  return `×${v.toFixed(2)}`;
}
function tone(key, v) {
  if (key === 'junkChance' || key === 'dropChance') return v > 0.12 ? 'bad' : '';
  if (key === 'wageMult') return v > 1.05 ? 'bad' : v < 0.98 ? 'good' : '';
  if (key === 'maxWeight') return '';
  return v > 1.05 ? 'good' : v < 0.95 ? 'bad' : '';
}

function cap(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

function empty(icon, text, hint) {
  return `<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${text}
    ${hint ? `<div style="margin-top:8px;opacity:.7;font-size:12.5px">${hint}</div>` : ''}</div></div>`;
}
