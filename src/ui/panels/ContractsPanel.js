import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { CONTRACT_CLIENTS, requirementTarget } from '../../data/contracts.js';
import { formatMoneyExact, clamp01 } from '../../util/math.js';

const CLIENT_BY_ID = Object.fromEntries(CONTRACT_CLIENTS.map((c) => [c.id, c]));

/**
 * The contract board. Offers on the left tab, signed work on the right.
 * Everything is read live from the Contracts system; actions go back out over
 * the event bus (`contracts:accept` / `contracts:abandon` / `contracts:refresh`)
 * so this panel never mutates the simulation directly.
 */
export class ContractsPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'contracts', title: '📄 Contracts', width: 'wide',
      tabs: [
        { id: 'board', name: 'Offer Board', icon: '📋' },
        { id: 'active', name: 'Signed', icon: '✍' },
        { id: 'record', name: 'Record', icon: '📊' },
      ],
    });
    this.live = true;
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const c = g.get('contracts');
    const eco = g.get('economy');

    this.setHeadRight(`<span style="font-family:var(--mono);color:var(--gold);font-weight:800;font-size:17px">${formatMoneyExact(eco?.money || 0)}</span>`);

    if (!c) {
      this.setSubtitle('');
      this.bodyEl.innerHTML = empty('📄', 'The contract board is closed.',
        'Delivery contracts arrive once the harbour trade office is running.');
      this.setFoot('');
      this.bind();
      return;
    }

    this.setSubtitle(`Day ${eco?.day ?? 1} · ${c.accepted.length}/${c.maxAccepted} slots used`);

    if (this.activeTab === 'board') this.renderBoard(c, eco);
    else if (this.activeTab === 'active') this.renderActive(c, eco);
    else this.renderRecord(c);

    this.bind();
  }

  bind() {
    this.onAction((act, ds) => {
      const c = this.game.get('contracts');
      if (act === 'accept') bus.emit('contracts:accept', { id: ds.id });
      else if (act === 'abandon') {
        const con = c?.accepted.find((x) => x.id === ds.id);
        const fee = Math.round((con?.penalty || 0) * 0.5);
        if (con && !confirm(`Abandon "${con.name}"?\n\nA ${formatMoneyExact(fee)} break fee is charged immediately.`)) return;
        bus.emit('contracts:abandon', { id: ds.id });
      } else if (act === 'refresh') bus.emit('contracts:refresh');
      setTimeout(() => { if (this.open) this.render(); }, 30);
    });
  }

  // ------------------------------------------------------------------ board
  renderBoard(c, eco) {
    const full = c.accepted.length >= c.maxAccepted;
    if (!c.available.length) {
      this.bodyEl.innerHTML = empty('📭', 'No offers on the board right now.',
        'A fresh set is posted every morning — or refresh the board yourself.');
    } else {
      this.bodyEl.innerHTML = `<div class="grid auto" style="grid-template-columns:repeat(auto-fill,minmax(288px,1fr))">
        ${c.available.map((k) => this.offerCard(k, full)).join('')}</div>`;
    }
    this.setFoot(`<button class="btn" data-action="refresh">🔄 Refresh board</button>
      <div style="flex:1"></div>
      <span style="color:${full ? 'var(--danger)' : 'var(--ink-faint)'};font-size:12.5px">
        ${c.accepted.length} / ${c.maxAccepted} contract slots${full ? ' — full' : ''}</span>`);
  }

  offerCard(k, full) {
    const client = CLIENT_BY_ID[k.client];
    return `<div class="card hover ct-card">
      <div class="card-title">${k.icon || '📄'} ${k.name}</div>
      <div class="ct-client">${client?.name || 'Private buyer'} <span class="chip">Tier ${k.tier}</span></div>
      <div class="card-desc" style="margin-top:5px">${stripClient(k.desc, client?.name)}</div>
      <div class="ct-reqs">${k.requirements.map((r) => `<div class="ct-req">
          <span class="ct-req-dot"></span><span>${r.label}</span></div>`).join('')}</div>
      <div class="ct-terms">
        <div><span class="ct-term-k">Reward</span><span class="ct-term-v gold">${formatMoneyExact(k.reward)}</span></div>
        <div><span class="ct-term-k">Deadline</span><span class="ct-term-v">${k.deadlineDays} days</span></div>
        <div><span class="ct-term-k">Penalty</span><span class="ct-term-v bad">${formatMoneyExact(k.penalty)}</span></div>
      </div>
      <div class="card-row">
        <span style="font-size:11.5px;color:var(--ink-faint)">${formatMoneyExact(Math.round(k.reward / Math.max(1, k.deadlineDays)))}/day if you deliver on time</span>
        ${full ? '<span class="chip bad">Slots full</span>'
          : `<button class="btn sm gold" data-action="accept" data-id="${k.id}">Accept</button>`}
      </div>
    </div>`;
  }

  // ----------------------------------------------------------------- signed
  renderActive(c, eco) {
    if (!c.accepted.length) {
      this.bodyEl.innerHTML = empty('✍', 'You have not signed anything.',
        'Take a contract from the offer board — progress is credited automatically every time you sell a matching fish.');
      this.setFoot(`<button class="btn primary" data-action="refresh">🔄 Refresh board</button>`);
      return;
    }
    const day = eco?.day ?? 1;
    this.bodyEl.innerHTML = `<div class="grid c2">${c.accepted.map((k) => {
      const left = Math.max(0, (k.dueDay || 0) - day);
      const urgency = left <= 0 ? 'crit' : left === 1 ? 'warn' : '';
      const pct = clamp01(c.progressOf(k)) * 100;
      const client = CLIENT_BY_ID[k.client];
      return `<div class="card ct-card ${urgency ? `ct-${urgency}` : ''}">
        <div class="card-title">${k.icon || '📄'} ${k.name}
          <div style="flex:1"></div>
          <span class="ct-deadline ${urgency}">${left <= 0 ? 'DUE TODAY' : left === 1 ? '1 DAY LEFT' : `${left} DAYS LEFT`}</span>
        </div>
        <div class="ct-client">${client?.name || 'Private buyer'} · signed day ${k.acceptedDay} · due day ${k.dueDay}</div>
        <div class="progress gold" style="margin:9px 0 4px"><i style="width:${pct}%"></i></div>
        <div class="lr-sub" style="margin-bottom:7px">${pct.toFixed(0)}% delivered</div>
        ${k.requirements.map((r, i) => {
          const p = clamp01(k.progress[i] / requirementTarget(r)) * 100;
          const done = p >= 99.99;
          return `<div class="ct-line ${done ? 'done' : ''}">
            <div class="ct-line-head"><span>${done ? '✅' : '▫'} ${r.label}</span>
              <span class="ct-line-val">${c.lineLabel(k, i)}</span></div>
            <div class="progress" style="margin-top:4px"><i style="width:${p}%"></i></div>
          </div>`;
        }).join('')}
        <div class="ct-terms" style="margin-top:9px">
          <div><span class="ct-term-k">Pays</span><span class="ct-term-v gold">${formatMoneyExact(k.reward)}</span></div>
          <div><span class="ct-term-k">Miss it</span><span class="ct-term-v bad">−${formatMoneyExact(k.penalty)}</span></div>
          <div><span class="ct-term-k">Break fee</span><span class="ct-term-v">−${formatMoneyExact(Math.round(k.penalty * 0.5))}</span></div>
        </div>
        <div class="card-row">
          <span style="font-size:11.5px;color:var(--ink-faint)">Sell a matching fish anywhere to credit this</span>
          <button class="btn sm danger" data-action="abandon" data-id="${k.id}">Abandon</button>
        </div>
      </div>`;
    }).join('')}</div>`;

    const soon = c.accepted.filter((k) => (k.dueDay || 0) - day <= 1).length;
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px">
      ${c.accepted.length} / ${c.maxAccepted} slots · ${formatMoneyExact(c.accepted.reduce((a, k) => a + k.reward, 0))} outstanding</span>
      <div style="flex:1"></div>
      ${soon ? `<span class="chip bad">${soon} due within a day</span>` : ''}`);
  }

  // ----------------------------------------------------------------- record
  renderRecord(c) {
    const line = (k, v, cls = '') => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v ${cls}">${v}</span></div>`;
    const company = this.game.get('company');
    const total = c.completed + c.failed;
    this.bodyEl.innerHTML = `<div class="grid c2">
      <div class="card"><div class="card-title">📊 Delivery record</div>
        ${line('Completed', c.completed, 'good')}
        ${line('Failed', c.failed, c.failed ? 'bad' : '')}
        ${line('Success rate', total ? `${Math.round((c.completed / total) * 100)}%` : '—')}
        ${line('Lifetime rewards', formatMoneyExact(c.lifetimeReward), 'gold')}
        ${line('Average reward', c.completed ? formatMoneyExact(c.lifetimeReward / c.completed) : '—')}
      </div>
      <div class="card"><div class="card-title">🏢 Standing</div>
        ${line('Contract slots', c.maxAccepted)}
        ${line('Currently signed', c.accepted.length)}
        ${line('Offers on the board', c.available.length)}
        ${company ? line('Company reputation', Math.round(company.reputation)) : ''}
        ${line('Board refreshed', `day ${c._lastRefreshDay || 1}`)}
      </div>
      <div class="card" style="grid-column:span 2"><div class="card-title">How contracts pay</div>
        <div class="card-desc" style="line-height:1.6">
          A contract's reward is anchored to what the requested fish are actually worth on the market, with a premium for
          the short deadlines. Selling a matching fish — by your own hand, by a worker, or out of a fleet's hold — credits
          every signed contract it satisfies at once. Complete it and the reward lands immediately; run past the due day
          and the penalty is taken out of the account. Reputation moves either way.
        </div>
      </div>
    </div>`;
    this.setFoot('');
  }
}

function stripClient(desc, name) {
  if (!desc) return '';
  return name && desc.startsWith(`${name} — `) ? desc.slice(name.length + 3) : desc;
}

function empty(icon, text, hint) {
  return `<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${text}
    ${hint ? `<div style="margin-top:8px;opacity:.7;font-size:12.5px">${hint}</div>` : ''}</div></div>`;
}
