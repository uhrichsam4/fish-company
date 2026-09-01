import { Panel } from '../Panel.js';
import { bus } from '../../core/EventBus.js';
import { REGIONS, REGION_BY_ID } from '../../data/regions.js';
import { formatMoneyExact, formatWeight, formatDistance } from '../../util/math.js';

/** Build or edit a boat crew: pick a boat, assign workers, choose a region. */
export class FleetEditorPanel extends Panel {
  constructor(game) {
    super(game, { id: 'fleetEditor', title: '⚓ Fleet', width: '' });
    this.live = false;
    this.sel = { boatId: null, crew: new Set(), region: null, name: '' };
    this.editing = null;
  }

  show() {
    const fleets = this.game.get('fleets');
    this.editing = this.data?.id ? fleets?.byId(this.data.id) : null;
    if (this.editing) {
      this.sel.boatId = this.editing.boatId;
      this.sel.crew = new Set(this.editing.crew.map((w) => w.id));
      this.sel.region = this.editing.targetRegion;
      this.sel.name = this.editing.name;
    } else {
      this.sel = { boatId: null, crew: new Set(), region: null, name: '' };
    }
    this.title = this.editing ? `⚓ Edit ${this.editing.name}` : '⚓ Create Fleet';
    super.show();
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const boats = g.get('boats');
    const workers = g.get('workers');
    const fleets = g.get('fleets');
    const quests = g.get('quests');
    this.el.querySelector('.panel-head h2').textContent = this.title;

    const freeBoats = (boats?.owned || []).filter((b) => !b.fleet || b === this.editing?.boat);
    const boat = boats?.byId(this.sel.boatId);
    const freeWorkers = (workers?.workers || []).filter((w) => !w.fleet || w.fleet === this.editing);
    const crew = [...this.sel.crew].map((id) => workers?.byId(id)).filter(Boolean);
    const hasCaptain = crew.some((w) => w.role === 'captain');
    const hasFisher = crew.some((w) => w.role === 'fisherman' || w.role === 'hunter');
    const overCap = boat ? crew.length > boat.stats.crew : false;

    const regions = REGIONS.filter((r) => !r.trench && (!quests || quests.isRegionUnlocked(r.id)));
    const home = boat?.region || 'crash';
    const homeR = REGION_BY_ID[home];

    this.bodyEl.innerHTML = `
      <div class="grid c3">
        <div class="card"><div class="card-title">1 · Boat</div>
          ${freeBoats.length ? freeBoats.map((b) => `
            <div class="list-row ${b.id === this.sel.boatId ? 'selected' : ''}" data-action="pickBoat" data-id="${b.id}" style="cursor:pointer">
              <span class="lr-icon">${b.icon}</span>
              <div class="lr-main"><div class="lr-title">${b.name}</div>
                <div class="lr-sub">${b.def.name} · ${b.stats.crew} crew · ${formatWeight(b.stats.storage)}</div></div>
              <div class="lr-right">${Math.round(b.health)}%</div>
            </div>`).join('')
            : `<div class="lr-sub">No free boats. Buy one in the Boats tab.</div>`}
        </div>
        <div class="card"><div class="card-title">2 · Crew ${boat ? `<span class="chip ${overCap ? 'bad' : ''}">${crew.length}/${boat.stats.crew}</span>` : ''}</div>
          ${freeWorkers.length ? freeWorkers.map((w) => `
            <div class="list-row ${this.sel.crew.has(w.id) ? 'selected' : ''}" data-action="toggleCrew" data-id="${w.id}" style="cursor:pointer">
              <span class="lr-icon">${w.icon}</span>
              <div class="lr-main"><div class="lr-title">${w.name}</div>
                <div class="lr-sub">${w.roleName} · Lv ${w.level} · ${formatMoneyExact(w.wage)}/d</div></div>
              ${this.sel.crew.has(w.id) ? '<span class="chip good">On</span>' : ''}
            </div>`).join('')
            : `<div class="lr-sub">No available workers. Hire some first.</div>`}
        </div>
        <div class="card"><div class="card-title">3 · Fishing ground</div>
          ${regions.map((r) => {
            const d = homeR ? Math.hypot(r.x - homeR.x, r.z - homeR.z) : 0;
            const tooFar = boat ? d > boat.stats.range : false;
            return `<div class="list-row ${r.id === this.sel.region ? 'selected' : ''} ${tooFar ? '' : ''}"
              data-action="pickRegion" data-id="${r.id}" style="cursor:pointer;${tooFar ? 'opacity:.45' : ''}">
              <span class="lr-icon">🏝</span>
              <div class="lr-main"><div class="lr-title">${r.name}</div>
                <div class="lr-sub">Tier ${r.tier} · ${formatDistance(d)}${tooFar ? ' · out of range' : ''}</div></div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-title">Summary</div>
        <div class="grid c4">
          <div class="stat-line"><span class="sl-k">Boat</span><span class="sl-v">${boat?.name || '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Crew</span><span class="sl-v ${overCap ? 'bad' : ''}">${crew.length}</span></div>
          <div class="stat-line"><span class="sl-k">Captain</span><span class="sl-v ${hasCaptain ? 'good' : 'bad'}">${hasCaptain ? 'Yes' : 'Required'}</span></div>
          <div class="stat-line"><span class="sl-k">Fisher</span><span class="sl-v ${hasFisher ? 'good' : 'bad'}">${hasFisher ? 'Yes' : 'Required'}</span></div>
          <div class="stat-line"><span class="sl-k">Target</span><span class="sl-v">${REGION_BY_ID[this.sel.region]?.name || '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Hold</span><span class="sl-v">${boat ? formatWeight(boat.stats.storage) : '—'}</span></div>
          <div class="stat-line"><span class="sl-k">Daily wages</span><span class="sl-v bad">${formatMoneyExact(crew.reduce((a, w) => a + w.wage, 0))}</span></div>
          <div class="stat-line"><span class="sl-k">Range</span><span class="sl-v">${boat ? formatDistance(boat.stats.range) : '—'}</span></div>
        </div>
      </div>`;

    const ready = boat && hasCaptain && hasFisher && !overCap && this.sel.region;
    this.setFoot(`
      <span style="color:var(--ink-faint);font-size:12.5px">${ready ? 'Ready to sail.' : 'Pick a boat, a captain, at least one fisherman and a destination.'}</span>
      <div style="flex:1"></div>
      ${this.editing ? `<button class="btn danger" data-action="disband">Disband</button>` : ''}
      <button class="btn primary" data-action="confirm" ${ready ? '' : 'disabled'}>${this.editing ? 'Save' : 'Create Fleet'}</button>`);

    this.onAction((act, ds) => {
      if (act === 'pickBoat') { this.sel.boatId = ds.id; this.render(); }
      else if (act === 'toggleCrew') {
        if (this.sel.crew.has(ds.id)) this.sel.crew.delete(ds.id); else this.sel.crew.add(ds.id);
        this.render();
      } else if (act === 'pickRegion') { this.sel.region = ds.id; this.render(); }
      else if (act === 'disband') { bus.emit('company:disbandFleet', { id: this.editing.id }); this.close(); }
      else if (act === 'confirm') {
        if (this.editing) {
          // Rebuild the fleet with the new selection.
          bus.emit('company:disbandFleet', { id: this.editing.id });
        }
        bus.emit('fleet:create', {
          boatId: this.sel.boatId,
          crewIds: [...this.sel.crew],
          targetRegion: this.sel.region,
          homeRegion: this.game.get('boats')?.byId(this.sel.boatId)?.region,
        });
        this.close();
        setTimeout(() => bus.emit('ui:show', { id: 'company', data: { tab: 'fleets' } }), 120);
      }
    });
  }
}
