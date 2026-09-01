import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import {
  HOUSE_EDGE, ROULETTE_BANDS, ROULETTE_WHEEL, ROULETTE_POCKETS,
  CRATE_TABLE, RISK_TABLE, rouletteOdds,
} from '../../economy/Gambling.js';
import { RARITY } from '../../data/fishData.js';
import { clamp, clamp01, lerp, formatMoneyExact, formatWeight, TAU } from '../../util/math.js';

const TAU_ = TAU;
const ease = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Doubloon Dee's five games.
 *
 * Every screen prints the real probability next to the real payout, and the
 * numbers come from the Gambling module rather than being typed in here — if
 * the maths changes, the sign changes with it. Fish money only; the daily loss
 * cap is shown at the top of every tab.
 */
export class GamblingPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'gambling',
      title: '🎲 Doubloon Dee’s',
      subtitle: 'dockside amusements · fish money only',
      width: '',
      tabs: [
        { id: 'roulette', name: 'Fish Roulette', icon: '🎡' },
        { id: 'race', name: 'Fish Race', icon: '🏁' },
        { id: 'coin', name: 'Coin Flip', icon: '🪙' },
        { id: 'crate', name: 'Crates', icon: '📦' },
        { id: 'risk', name: 'Risk Your Catch', icon: '🎣' },
      ],
    });
    this.stake = 100;
    this.betBand = 'common';
    this.betRunner = null;
    this.riskIndex = -1;
    this._raf = 0;
    this._wheelAngle = 0;
    this._busy = false;
  }

  get sys() { return this.game.get('gambling'); }

  show() {
    this.stake = this._defaultStake();
    super.show();
  }

  close() {
    this._stopAnim();
    super.close();
  }

  _stopAnim() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this._busy = false;
  }

  _defaultStake() {
    const g = this.sys;
    const max = g ? g.maxStake() : 0;
    return Math.max(0, Math.min(100, max));
  }

  // ---------------------------------------------------------------- render

  render() {
    if (!this.el) return;
    this._stopAnim();
    const g = this.sys;
    const eco = this.game.get('economy');
    if (!g || !eco) { this.bodyEl.innerHTML = '<div class="empty-state">Table closed.</div>'; return; }

    this.setHeadRight(`<span style="font-family:var(--mono);font-weight:800;color:var(--gold);font-size:17px">${formatMoneyExact(eco.money)}</span>`);
    this.setSubtitle(`house edge ${(HOUSE_EDGE * 100).toFixed(0)}% · in-game money only`);

    const capPct = clamp01(g.lostToday / Math.max(1, g.lossCap));
    const capBar = `
      <div class="card" style="margin-bottom:14px">
        <div class="card-row" style="margin-top:0">
          <div>
            <div class="card-title" style="margin-bottom:2px">🛟 Daily loss cap</div>
            <div class="card-desc">The table closes for the day once you are down this much. It is not a suggestion.</div>
          </div>
          <div style="text-align:right;font-family:var(--mono)">
            <div style="font-weight:800;color:${capPct > 0.75 ? 'var(--danger)' : 'var(--ink)'}">
              ${formatMoneyExact(g.lostToday)} / ${formatMoneyExact(g.lossCap)}</div>
            <div style="font-size:11px;color:var(--ink-faint)">${formatMoneyExact(g.remainingToday)} left today</div>
          </div>
        </div>
        <div class="progress ${capPct > 0.75 ? 'gold' : ''}" style="margin-top:8px">
          <i style="width:${(capPct * 100).toFixed(1)}%;background:${capPct > 0.75 ? 'var(--danger)' : 'var(--warn)'}"></i>
        </div>
      </div>`;

    let body = '';
    if (this.activeTab === 'roulette') body = this._roulette(g);
    else if (this.activeTab === 'race') body = this._race(g);
    else if (this.activeTab === 'coin') body = this._coin(g);
    else if (this.activeTab === 'crate') body = this._crate(g);
    else body = this._risk(g);

    this.bodyEl.innerHTML = capBar + body;
    this._afterRender(g);

    const r = g.report();
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px;font-family:var(--mono)">
      lifetime: wagered ${formatMoneyExact(r.wagered)} · returned ${formatMoneyExact(r.won)} ·
      ${r.plays} plays · your return ${r.rtp == null ? '—' : `${Math.round(r.rtp * 100)}%`}
      (advertised ${Math.round(r.advertisedRTP * 100)}%)</span>`);

    this.onAction((act, ds) => this._action(act, ds));
  }

  /** Stake widget shared by the money games. */
  _stakeRow(g, cap = null) {
    const max = Math.min(g.maxStake(), cap ?? Infinity);
    const presets = [100, 500, 2500, 10000].filter((v) => v <= max);
    return `<div class="card" style="margin-bottom:12px">
      <div class="card-title">Stake</div>
      <div class="card-row" style="margin-top:8px;flex-wrap:wrap">
        <input type="number" id="gb-stake" value="${Math.min(this.stake, max) || 0}" min="1" max="${Math.floor(max)}"
          style="flex:1;min-width:120px;background:var(--bg-1);border:1px solid var(--line);border-radius:6px;
                 padding:8px 10px;color:var(--ink);font-family:var(--mono);font-size:15px;font-weight:700">
        ${presets.map((v) => `<button class="btn sm" data-action="stake" data-v="${v}">${formatMoneyExact(v)}</button>`).join('')}
        <button class="btn sm" data-action="stake" data-v="max">Max ${formatMoneyExact(max)}</button>
      </div>
      ${cap != null ? `<div class="card-stats">This game is capped at ${formatMoneyExact(cap)} per bet.</div>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------- roulette

  _roulette(g) {
    const odds = rouletteOdds();
    return `
      ${this._stakeRow(g)}
      <div class="grid" style="grid-template-columns:300px 1fr;align-items:start">
        <div style="text-align:center">
          <canvas id="gb-wheel" width="280" height="280" style="max-width:100%"></canvas>
          <div id="gb-wheel-msg" style="min-height:26px;margin-top:8px;font-weight:800;font-size:15px"></div>
        </div>
        <div>
          <div class="card-title" style="margin-bottom:8px">Bet on a colour — ${ROULETTE_POCKETS} pockets</div>
          ${odds.map((o) => `
            <div class="list-row ${this.betBand === o.key ? 'selected' : ''}" data-action="band" data-k="${o.key}"
                 style="cursor:pointer;margin-bottom:6px">
              <div class="lr-icon" style="color:${o.color}">●</div>
              <div class="lr-main">
                <div class="lr-title" style="color:${o.color}">${o.name}</div>
                <div class="lr-sub">${o.pockets} of ${ROULETTE_POCKETS} pockets · ${(o.p * 100).toFixed(2)}% chance</div>
              </div>
              <div class="lr-right">
                <div style="font-weight:800;color:var(--gold)">${o.payout.toFixed(2)}×</div>
                <div style="font-size:10.5px;color:var(--ink-faint)">return ${(o.rtp * 100).toFixed(1)}%</div>
              </div>
            </div>`).join('')}
          <button class="btn gold block" data-action="spin" style="margin-top:10px">Spin the wheel</button>
        </div>
      </div>`;
  }

  _drawWheel(angle, highlight = -1) {
    const c = this.bodyEl?.querySelector('#gb-wheel');
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = w / 2 - 12;
    ctx.clearRect(0, 0, w, h);
    const seg = TAU_ / ROULETTE_POCKETS;
    for (let i = 0; i < ROULETTE_POCKETS; i++) {
      const band = ROULETTE_BANDS.find((b) => b.key === ROULETTE_WHEEL[i]);
      const a0 = angle + i * seg - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = band?.color || '#888';
      ctx.globalAlpha = highlight === i ? 1 : 0.82;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(4,10,16,.65)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.28, 0, TAU_);
    ctx.fillStyle = '#0d1721';
    ctx.fill();
    ctx.strokeStyle = '#2b455e';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#6f8ba1';
    ctx.font = '700 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('24', cx, cy + 4);
    // pointer
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 10);
    ctx.lineTo(cx - 9, cy - R + 6);
    ctx.lineTo(cx + 9, cy - R + 6);
    ctx.closePath();
    ctx.fillStyle = '#ffc22e';
    ctx.fill();
  }

  _spin() {
    const g = this.sys;
    if (this._busy) return;
    const res = g.spinRoulette(this.betBand, this.stake);
    if (!res.ok) { this._deny(res.reason); return; }
    this._busy = true;
    const msg = this.bodyEl.querySelector('#gb-wheel-msg');
    if (msg) msg.textContent = '';

    // Land the pointer (top, -90°) on the drawn pocket, after 5 full turns.
    const seg = TAU_ / ROULETTE_POCKETS;
    const target = TAU_ * 5 - (res.pocket * seg + seg / 2);
    const from = this._wheelAngle % TAU_;
    const dur = 2800;
    const t0 = performance.now();
    const step = () => {
      const t = clamp01((performance.now() - t0) / dur);
      this._wheelAngle = from + (target - from) * ease(t);
      this._drawWheel(this._wheelAngle, t >= 1 ? res.pocket : -1);
      if (t < 1) { this._raf = requestAnimationFrame(step); return; }
      this._raf = 0;
      this._busy = false;
      const band = ROULETTE_BANDS.find((b) => b.key === res.landed);
      if (msg) {
        msg.innerHTML = res.win
          ? `<span style="color:var(--good)">${band.name} — you win ${formatMoneyExact(res.payout * res.stake)}</span>`
          : `<span style="color:var(--danger)">${band.name}. Not yours.</span>`;
      }
      this._refreshHeader();
    };
    this._raf = requestAnimationFrame(step);
  }

  // ----------------------------------------------------------------- race

  _race(g) {
    const race = g.race || g.newRace();
    if (!this.betRunner) this.betRunner = race.runners[0].id;
    return `
      ${this._stakeRow(g)}
      <canvas id="gb-race" width="920" height="230" style="width:100%;border-radius:8px;background:linear-gradient(180deg,#0a2233,#061420);border:1px solid var(--line)"></canvas>
      <div id="gb-race-msg" style="min-height:24px;margin:8px 0;font-weight:800;font-size:15px"></div>
      <div class="grid auto-sm">
        ${race.runners.map((r) => `
          <div class="card hover ${this.betRunner === r.id ? 'owned' : ''}" data-action="runner" data-k="${r.id}" style="cursor:pointer">
            <div class="card-title"><span class="card-icon">${r.emoji}</span>${r.name}</div>
            <div class="card-stats">win chance ${(r.p * 100).toFixed(1)}%</div>
            <div class="card-row">
              <span class="card-price">${r.payout.toFixed(2)}×</span>
              <span class="chip" style="background:${r.color}22;color:${r.color}">
                return ${(r.p * r.payout * 100).toFixed(1)}%</span>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn gold block" data-action="startrace" style="margin-top:12px">Run the race</button>`;
  }

  _drawRace(runners, progress, winnerId = null) {
    const c = this.bodyEl?.querySelector('#gb-race');
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const laneH = h / runners.length;
    const startX = 92, endX = w - 40;

    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= runners.length; i++) {
      ctx.beginPath(); ctx.moveTo(0, i * laneH); ctx.lineTo(w, i * laneH); ctx.stroke();
    }
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,194,46,.6)';
    ctx.beginPath(); ctx.moveTo(endX, 0); ctx.lineTo(endX, h); ctx.stroke();
    ctx.setLineDash([]);

    ctx.textBaseline = 'middle';
    for (let i = 0; i < runners.length; i++) {
      const r = runners[i];
      const y = i * laneH + laneH / 2;
      ctx.fillStyle = '#a5bccd';
      ctx.font = '700 12px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(r.name, 8, y);
      const p = clamp01(progress[r.id] ?? 0);
      const x = lerp(startX, endX, p);
      ctx.strokeStyle = `${r.color}55`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(startX, y); ctx.lineTo(x, y); ctx.stroke();
      ctx.font = '22px system-ui';
      ctx.textAlign = 'center';
      ctx.globalAlpha = winnerId && winnerId !== r.id ? 0.55 : 1;
      ctx.fillText(r.emoji, x, y);
      ctx.globalAlpha = 1;
    }
  }

  _startRace() {
    const g = this.sys;
    if (this._busy) return;
    const res = g.runRace(this.betRunner, this.stake);
    if (!res.ok) { this._deny(res.reason); return; }
    this._busy = true;
    const card = res.card;
    const runners = card.runners;
    const msg = this.bodyEl.querySelector('#gb-race-msg');
    if (msg) msg.textContent = '';

    // Rescale the drawn finishing times so the winner crosses at `dur`.
    const dur = 4600;
    const wt = card.times[card.winner];
    const finish = {};
    for (const r of runners) finish[r.id] = dur * (card.times[r.id] / wt);

    const prog = {};
    const t0 = performance.now();
    const step = () => {
      const t = performance.now() - t0;
      for (const r of runners) {
        const base = clamp01(t / finish[r.id]);
        // Wobble fades out completely before the line so the order never lies.
        const wob = Math.sin(t / 260 + r.p * 9) * 0.035 * (1 - base);
        prog[r.id] = clamp01(base + wob);
      }
      const done = t >= dur + 900;
      this._drawRace(runners, prog, done ? card.winner : null);
      if (!done) { this._raf = requestAnimationFrame(step); return; }
      this._raf = 0;
      this._busy = false;
      if (msg) {
        msg.innerHTML = res.win
          ? `<span style="color:var(--good)">${res.winner.emoji} ${res.winner.name} wins — you take ${formatMoneyExact(res.payout * res.stake)}</span>`
          : `<span style="color:var(--danger)">${res.winner.emoji} ${res.winner.name} wins. You backed ${res.bet.name}.</span>`;
      }
      this._refreshHeader();
      // A new card is already waiting; show its odds.
      setTimeout(() => { if (this.open && this.activeTab === 'race') this.render(); }, 2200);
    };
    this._raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------- coin flip

  _coin(g) {
    const cap = g.flipCap();
    return `
      ${this._stakeRow(g, cap)}
      <div class="card" style="text-align:center;padding:22px">
        <canvas id="gb-coin" width="180" height="180" style="max-width:100%"></canvas>
        <div id="gb-coin-msg" style="min-height:26px;margin-top:10px;font-weight:800;font-size:16px"></div>
        <button class="btn gold" data-action="flip" style="margin-top:10px">Flip · pays ${g.flipPayout.toFixed(2)}×</button>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-title">How this one is honest</div>
        <div class="card-desc">
          The payout is a clean <b>${g.flipPayout.toFixed(2)}×</b>, so the ${(HOUSE_EDGE * 100).toFixed(0)}% edge lives in the
          coin instead: it comes up yours <b>${(g.flipChance * 100).toFixed(0)}%</b> of the time, not 50%.
          Expected return ${(g.flipChance * g.flipPayout * 100).toFixed(1)}%. Stake capped at ${formatMoneyExact(cap)}
          so this cannot become your whole evening.
        </div>
      </div>`;
  }

  _drawCoin(phase, face = null) {
    const c = this.bodyEl?.querySelector('#gb-coin');
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const squash = Math.abs(Math.cos(phase));
    const R = 62;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(1, Math.max(0.06, squash));
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU_);
    const grad = ctx.createLinearGradient(-R, -R, R, R);
    grad.addColorStop(0, '#ffd35c');
    grad.addColorStop(1, '#c98b12');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#8a5f08';
    ctx.stroke();
    if (face && squash > 0.7) {
      ctx.fillStyle = '#4a3205';
      ctx.font = '900 46px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(face === 'heads' ? '🐟' : '💀', 0, 2);
    }
    ctx.restore();
  }

  _flip() {
    const g = this.sys;
    if (this._busy) return;
    const res = g.flip(this.stake);
    if (!res.ok) { this._deny(res.reason); return; }
    this._busy = true;
    const msg = this.bodyEl.querySelector('#gb-coin-msg');
    if (msg) msg.textContent = '';
    const dur = 1700;
    const t0 = performance.now();
    const step = () => {
      const t = clamp01((performance.now() - t0) / dur);
      const spins = 7 * Math.PI * ease(t);
      this._drawCoin(spins, t >= 1 ? res.face : null);
      if (t < 1) { this._raf = requestAnimationFrame(step); return; }
      this._raf = 0;
      this._busy = false;
      if (msg) {
        msg.innerHTML = res.win
          ? `<span style="color:var(--good)">Fish side. ${formatMoneyExact(res.payout)} back.</span>`
          : `<span style="color:var(--danger)">Skull side. ${formatMoneyExact(res.stake)} gone.</span>`;
      }
      this._refreshHeader();
    };
    this._raf = requestAnimationFrame(step);
  }

  // --------------------------------------------------------------- crates

  _crate(g) {
    const fees = g.crateFees();
    const last = this._lastCrate;
    return `
      <div class="grid c3">
        ${fees.map((f) => `
          <div class="card hover" style="text-align:center">
            <div style="font-size:40px;line-height:1.2">${f.emoji}</div>
            <div class="card-title" style="justify-content:center">${f.name}</div>
            <div class="card-price" style="margin:6px 0">${formatMoneyExact(f.fee)}</div>
            <button class="btn gold block" data-action="crate" data-k="${f.id}">Open</button>
          </div>`).join('')}
      </div>
      ${last ? `
      <div class="card" style="margin-top:14px;border-color:${last.row.color}">
        <div class="card-title" style="color:${last.row.color}">${last.row.label} — ×${last.row.mult}</div>
        <div style="margin-top:8px">
          ${last.contents.map((c) => `<div class="list-row" style="margin-bottom:5px">
            <div class="lr-icon">${c.icon}</div>
            <div class="lr-main"><div class="lr-title">${c.label}</div>
              <div class="lr-sub">${c.kind === 'fish' ? (c.stored ? 'in your storage' : 'no room — sold on the spot') : c.kind}</div></div>
            <div class="lr-right" style="color:var(--gold)">${formatMoneyExact(c.value)}</div>
          </div>`).join('')}
        </div>
        <div class="card-stats">Paid ${formatMoneyExact(last.stake)} · received ${formatMoneyExact(last.delivered)} ·
          net <b style="color:${last.net >= 0 ? 'var(--good)' : 'var(--danger)'}">${formatMoneyExact(last.net)}</b></div>
      </div>` : ''}
      <div class="card" style="margin-top:14px">
        <div class="card-title">The whole table, printed</div>
        <div class="card-desc">Multiplier is of the fee you paid. These are the numbers the code rolls.</div>
        <div style="margin-top:8px">
          ${CRATE_TABLE.map((r) => `<div class="stat-line">
            <span class="sl-k" style="color:${r.color}">${r.label}</span>
            <span class="sl-v">${(r.weight * 100).toFixed(0)}% → ×${r.mult}</span></div>`).join('')}
          <div class="stat-line"><span class="sl-k">Expected return</span>
            <span class="sl-v gold">${(CRATE_TABLE.reduce((a, r) => a + r.weight * r.mult, 0) * 100).toFixed(0)}%</span></div>
        </div>
      </div>`;
  }

  // ----------------------------------------------------------- risk a fish

  _risk(g) {
    const inv = this.game.get('inventory');
    const eco = this.game.get('economy');
    const fish = inv?.fish || [];
    const last = this._lastRisk;

    return `
      <div class="card" style="margin-bottom:12px">
        <div class="card-title">🎣 Risk Your Catch</div>
        <div class="card-desc">Put a stored fish on the table. Nearly half the time it goes over the side and it is
          not coming back. The rest of the time it comes back worth more. No cash changes hands — the fish does.</div>
        <div style="margin-top:8px">
          ${RISK_TABLE.map((r) => `<div class="stat-line">
            <span class="sl-k" style="color:${r.color}">${r.label}</span>
            <span class="sl-v">${(r.weight * 100).toFixed(0)}% → ${r.mult === 0 ? 'lost' : `×${r.mult}`}</span></div>`).join('')}
          <div class="stat-line"><span class="sl-k">Expected return</span>
            <span class="sl-v gold">${(RISK_TABLE.reduce((a, r) => a + r.weight * r.mult, 0) * 100).toFixed(0)}%</span></div>
        </div>
      </div>
      ${last ? `<div class="card" style="margin-bottom:12px;border-color:${last.row.color}">
        <div class="card-title" style="color:${last.row.color}">${last.row.label}</div>
        <div class="card-stats">${last.lost
    ? `Lost a fish worth ${formatMoneyExact(last.stake)}.`
    : `${formatMoneyExact(last.stake)} → <b style="color:var(--gold)">${formatMoneyExact(last.payout)}</b>`}</div>
      </div>` : ''}
      ${fish.length ? `<div>${fish.map((f, i) => {
    const rar = RARITY[f.instance.rarity] || RARITY.common;
    const val = Math.round(eco.priceFor(f.instance, { freshness: f.freshness, processLevel: f.processLevel }) * (f.styleMult || 1));
    return `<div class="list-row" style="margin-bottom:6px">
          <div class="lr-icon">🐟</div>
          <div class="lr-main">
            <div class="lr-title" style="color:${rar.color}">${f.instance.name}</div>
            <div class="lr-sub">${formatWeight(f.instance.weight)} · ${rar.name}</div>
          </div>
          <div class="lr-right" style="color:var(--gold)">${formatMoneyExact(val)}</div>
          <button class="btn sm danger" data-action="risk" data-k="${i}">Risk it</button>
        </div>`;
  }).join('')}</div>`
    : `<div class="empty-state"><div class="es-icon">🎣</div>
         <div class="es-text">No fish in storage. Dee only takes fish for this one.</div></div>`}`;
  }

  // -------------------------------------------------------------- plumbing

  _afterRender(g) {
    if (this.activeTab === 'roulette') this._drawWheel(this._wheelAngle);
    else if (this.activeTab === 'race') {
      const race = g.race;
      const zero = {};
      for (const r of race.runners) zero[r.id] = 0;
      this._drawRace(race.runners, zero);
    } else if (this.activeTab === 'coin') this._drawCoin(0, 'heads');

    const input = this.bodyEl.querySelector('#gb-stake');
    if (input) {
      input.addEventListener('input', () => {
        const v = Math.floor(+input.value || 0);
        this.stake = clamp(v, 0, Math.floor(g.maxStake()));
      });
    }
  }

  _refreshHeader() {
    const eco = this.game.get('economy');
    const g = this.sys;
    if (!eco || !g) return;
    this.setHeadRight(`<span style="font-family:var(--mono);font-weight:800;color:var(--gold);font-size:17px">${formatMoneyExact(eco.money)}</span>`);
    const r = g.report();
    this.setFoot(`<span style="color:var(--ink-faint);font-size:12.5px;font-family:var(--mono)">
      lifetime: wagered ${formatMoneyExact(r.wagered)} · returned ${formatMoneyExact(r.won)} ·
      ${r.plays} plays · your return ${r.rtp == null ? '—' : `${Math.round(r.rtp * 100)}%`}
      (advertised ${Math.round(r.advertisedRTP * 100)}%)</span>`);
  }

  _deny(reason) {
    bus.emit('toast', { text: reason || 'No.', kind: 'error', duration: 4000 });
    this.game.audio?.play('ui_error', { volume: 0.4 });
  }

  _action(act, ds) {
    const g = this.sys;
    if (!g) return;
    switch (act) {
      case 'stake': {
        const max = Math.floor(this.activeTab === 'coin' ? Math.min(g.maxStake(), g.flipCap()) : g.maxStake());
        this.stake = ds.v === 'max' ? max : clamp(+ds.v, 0, max);
        const input = this.bodyEl.querySelector('#gb-stake');
        if (input) input.value = String(this.stake);
        break;
      }
      case 'band':
        this.betBand = ds.k;
        this.bodyEl.querySelectorAll('[data-action="band"]').forEach((n) => n.classList.toggle('selected', n.dataset.k === ds.k));
        break;
      case 'spin': this._spin(); break;
      case 'runner':
        this.betRunner = ds.k;
        this.bodyEl.querySelectorAll('[data-action="runner"]').forEach((n) => n.classList.toggle('owned', n.dataset.k === ds.k));
        break;
      case 'startrace': this._startRace(); break;
      case 'flip': this._flip(); break;
      case 'crate': {
        const res = g.openCrate(ds.k);
        if (!res.ok) { this._deny(res.reason); return; }
        this._lastCrate = res;
        this.render();
        break;
      }
      case 'risk': {
        const res = g.riskFish(+ds.k);
        if (!res.ok) { this._deny(res.reason); return; }
        this._lastRisk = res;
        this.render();
        break;
      }
      default: break;
    }
  }
}
