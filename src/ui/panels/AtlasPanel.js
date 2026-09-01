import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { FISH_SPECIES, RARITY, VARIANTS, VARIANT_BY_ID, getSpecies } from '../../data/fishData.js';
import { REGIONS, REGION_BY_ID } from '../../data/regions.js';
import { formatMoneyExact, formatWeight } from '../../util/math.js';

/**
 * The Fish Atlas: discovery log, records, variants and completion bonuses.
 * Discovery data lives here and is saved under the `atlas` key.
 */
export class AtlasPanel extends Panel {
  constructor(game) {
    super(game, {
      id: 'atlas', title: '📖 Fish Atlas', width: 'wide',
      tabs: [{ id: 'all', name: 'All', icon: '🌊' },
        ...REGIONS.map((r) => ({ id: r.id, name: r.short, icon: '🏝' }))],
    });
    this.name = 'atlas';
    this.order = 915;
    this.live = false;
    /** speciesId -> {count, best, bestValue, variants:Set, firstAt} */
    this.entries = new Map();
    this.selected = null;
  }

  async init() {
    bus.on('fishing:caught', ({ instance }) => this.record(instance));
    bus.on('worker:caught', ({ instance }) => this.record(instance));
    bus.on('economy:caught', ({ instance }) => this.record(instance));
    return this;
  }

  record(instance) {
    if (!instance) return;
    let e = this.entries.get(instance.speciesId);
    const isNew = !e;
    if (!e) {
      e = { count: 0, best: 0, bestValue: 0, variants: new Set(), firstAt: Date.now() };
      this.entries.set(instance.speciesId, e);
    }
    e.count++;
    const newRecord = instance.weight > e.best;
    e.best = Math.max(e.best, instance.weight);
    e.bestValue = Math.max(e.bestValue, instance.value);
    const hadVariant = e.variants.has(instance.variantId);
    e.variants.add(instance.variantId);

    if (isNew) {
      const sp = getSpecies(instance.speciesId);
      bus.emit('toast', { text: `📖 New species discovered: <b>${sp?.name || instance.speciesId}</b>`, kind: 'gold', duration: 4200 });
      this.game.audio.play('quest_complete', { volume: 0.5 });
      bus.emit('atlas:discovered', { speciesId: instance.speciesId, total: this.entries.size });
      this.checkCompletion();
    } else if (!hadVariant && instance.variantId !== 'normal') {
      bus.emit('toast', { text: `📖 New variant: <b>${VARIANT_BY_ID[instance.variantId]?.name}</b>`, kind: 'gold' });
    }
  }

  discovered(id) { return this.entries.has(id); }
  get completion() { return this.entries.size / FISH_SPECIES.length; }

  checkCompletion() {
    // Region completion grants a permanent price bonus.
    for (const r of REGIONS) {
      const list = FISH_SPECIES.filter((s) => s.regions.includes(r.id) && !s.boss);
      if (!list.length) continue;
      const done = list.every((s) => this.entries.has(s.id));
      if (done && !this._bonuses?.has(r.id)) {
        (this._bonuses ||= new Set()).add(r.id);
        const company = this.game.get('company');
        if (company) company.priceMult = (company.priceMult || 1) * 1.05;
        bus.emit('toast', { text: `🏆 ${r.name} atlas complete! +5% fish prices`, kind: 'gold', duration: 6000 });
        this.game.audio.play('levelup', { volume: 0.7 });
      }
    }
  }

  render() {
    if (!this.el) return;
    const list = this.activeTab === 'all'
      ? FISH_SPECIES
      : FISH_SPECIES.filter((s) => s.regions.includes(this.activeTab));

    this.setSubtitle(`${this.entries.size} / ${FISH_SPECIES.length} discovered (${Math.round(this.completion * 100)}%)`);
    this.setHeadRight(`<div class="progress" style="width:180px"><i style="width:${this.completion * 100}%"></i></div>`);

    const cards = list.map((sp) => {
      const e = this.entries.get(sp.id);
      const r = RARITY[sp.rarity] || RARITY.common;
      if (!e) {
        return `<div class="card locked" style="text-align:center">
          <div style="font-size:34px;filter:brightness(0) opacity(.35)">🐟</div>
          <div class="card-title" style="justify-content:center;color:var(--ink-faint)">???</div>
          <div class="card-desc">Tier ${sp.tier} · ${sp.habitat[0]}</div>
        </div>`;
      }
      const variantChips = [...e.variants].filter((v) => v !== 'normal')
        .map((v) => `<span class="chip">${VARIANT_BY_ID[v]?.name || v}</span>`).join(' ');
      return `<div class="card hover" data-action="select" data-id="${sp.id}">
        <div class="card-title"><span style="color:${r.color}">${sp.name}</span></div>
        <div class="card-desc">${sp.desc}</div>
        <div class="card-stats">
          Caught: <b>${e.count}</b><br>
          Record: <b>${formatWeight(e.best)}</b><br>
          Best value: <b style="color:var(--gold)">${formatMoneyExact(e.bestValue)}</b><br>
          Habitat: ${sp.habitat.join(', ')}<br>
          Depth: ${sp.depth[0]}–${sp.depth[1]} m
        </div>
        <div style="margin-top:7px">
          <span class="chip ${sp.rarity}">${r.name}</span>
          ${sp.dangerous ? '<span class="chip bad">Dangerous</span>' : ''}
          ${sp.boss ? '<span class="chip gold">Boss</span>' : ''}
          ${variantChips}
        </div>
        <div class="card-desc" style="margin-top:6px;opacity:.75;font-style:italic">${sp.atlasHint || ''}</div>
      </div>`;
    }).join('');

    this.bodyEl.innerHTML = `<div class="grid auto">${cards}</div>`;
    const found = list.filter((s) => this.entries.has(s.id)).length;
    this.setFoot(`<span style="color:var(--ink-faint)">${found} / ${list.length} in this region · complete a region for +5% fish prices</span>`);
  }

  save() {
    return {
      entries: [...this.entries.entries()].map(([k, v]) => [k, { c: v.count, b: v.best, bv: v.bestValue, v: [...v.variants] }]),
      bonuses: [...(this._bonuses || [])],
    };
  }
  load(d) {
    this.entries.clear();
    if (!d?.entries) return;
    for (const [k, v] of d.entries) {
      this.entries.set(k, { count: v.c, best: v.b, bestValue: v.bv, variants: new Set(v.v || []), firstAt: 0 });
    }
    this._bonuses = new Set(d.bonuses || []);
  }
}
