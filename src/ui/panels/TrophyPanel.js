import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { FISH_SPECIES, RARITY, getSpecies, VARIANT_BY_ID } from '../../data/fishData.js';
import { formatWeight, formatMoneyExact } from '../../util/math.js';

/**
 * The trophy wall in the Trophy Room.
 *
 * Reads the Atlas rather than keeping its own records. The Atlas already
 * tracks best weight, best value and which variants have been seen per
 * species; duplicating that into a second store would give two answers to
 * "what is my biggest cod" and they would drift the first time one of them
 * missed an event.
 *
 * Only species actually caught are mounted. A wall of empty plaques for fish
 * you have never seen is a checklist, not a trophy room.
 */
export class TrophyPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'trophies', title: '🏆 Trophy Room', subtitle: '',
      tabs: [
        { id: 'wall', name: 'The Wall', icon: '🏆' },
        { id: 'records', name: 'Records', icon: '📏' },
      ],
      width: 'wide',
    });
    this.live = false;
  }

  get atlas() { return this.game.get('ui')?.panels?.get?.('atlas'); }

  /** Caught species, heaviest first. */
  _trophies() {
    const atlas = this.atlas;
    if (!atlas?.entries) return [];
    const out = [];
    for (const [speciesId, e] of atlas.entries) {
      const sp = getSpecies(speciesId);
      if (!sp) continue;
      out.push({
        sp, speciesId, best: e.best, bestValue: e.bestValue,
        count: e.count, variants: [...(e.variants || [])],
        // How close the personal best is to the species maximum: the number a
        // trophy hunter actually cares about.
        ratio: sp.weight?.[1] ? e.best / sp.weight[1] : 0,
      });
    }
    return out.sort((a, b) => b.best - a.best);
  }

  render() {
    if (!this.el) return;
    const eco = this.game.get('economy');
    const list = this._trophies();
    const total = FISH_SPECIES.filter((s) => !s.boss).length;

    this.setSubtitle(`${list.length} of ${total} species mounted`);
    this.setHeadRight(`<span style="font-family:var(--mono);font-weight:800;color:var(--gold)">${
      list.length ? formatWeight(list[0].best) : '—'}</span>`);

    if (!list.length) {
      this.bodyEl.innerHTML = `<div class="empty-state"><div class="es-icon">🏆</div><div class="es-text">
        Nothing mounted yet.
        <div style="margin-top:8px;opacity:.7;font-size:12.5px">Catch something and your best of each species is displayed here.</div>
      </div></div>`;
      this.setFoot('');
      return;
    }

    if (this.activeTab === 'records') { this._renderRecords(list, eco); return; }

    this.bodyEl.innerHTML = `<div class="grid auto">${list.map((t) => {
      const rar = RARITY[t.sp.rarity] || RARITY.common;
      const pct = Math.round(t.ratio * 100);
      const grade = pct >= 90 ? 'Record class' : pct >= 70 ? 'Exceptional' : pct >= 45 ? 'Respectable' : 'Modest';
      return `<div class="card trophy" style="border-color:${rar.color}44">
        <div class="card-title" style="color:${rar.color}">${t.sp.icon || '🐟'} ${t.sp.name}</div>
        <div class="trophy-weight">${formatWeight(t.best)}</div>
        <div class="progress" style="margin:7px 0 5px"><i style="width:${Math.min(100, pct)}%;background:${rar.color}"></i></div>
        <div class="lr-sub">${grade} · ${pct}% of species max</div>
        <div class="card-stats" style="margin-top:7px">
          Best value: <b style="color:var(--gold)">${formatMoneyExact(t.bestValue)}</b><br>
          Caught: <b>${t.count}</b>${t.variants.length > 1 ? `<br>Variants: <b>${t.variants.length}</b>` : ''}
        </div>
      </div>`;
    }).join('')}</div>`;

    const heaviest = list[0];
    this.setFoot(`<span style="color:var(--ink-faint)">Heaviest overall: <b style="color:var(--ink)">${
      heaviest.sp.name}</b> at ${formatWeight(heaviest.best)}</span>`);
  }

  _renderRecords(list, eco) {
    const st = eco?.stats || {};
    const row = (k, v) => `<div class="stat-line"><span class="sl-k">${k}</span><span class="sl-v">${v}</span></div>`;
    this.bodyEl.innerHTML = `<div class="grid c2">
      <div class="card"><div class="card-title">📏 Personal bests</div>
        ${row('Heaviest fish', st.biggestFish ? `${st.biggestFish.name} — ${formatWeight(st.biggestFish.weight)}` : '—')}
        ${row('Most valuable', st.mostValuable ? `${st.mostValuable.name} — ${formatMoneyExact(st.mostValuable.value)}` : '—')}
        ${row('Longest cast', `${(st.longestCast || 0).toFixed(1)} m`)}
        ${row('Deepest dive', `${Math.round(st.deepestDive || 0)} m`)}
        ${row('Best combo', st.bestCombo || 0)}
      </div>
      <div class="card"><div class="card-title">📊 Lifetime</div>
        ${row('Fish caught', st.totalCaught || 0)}
        ${row('Fish sold', st.totalSold || 0)}
        ${row('Species mounted', list.length)}
        ${row('Tricks landed', st.tricksLanded || 0)}
        ${row('Lines snapped', st.linesSnapped || 0)}
      </div>
    </div>`;
    this.setFoot('');
  }
}
