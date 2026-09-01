import { Panel } from '../Panel.js';
import { REGIONS, REGION_BY_ID } from '../../data/regions.js';
import { formatMoneyExact, formatDistance, clamp } from '../../util/math.js';
import { bus } from '../../core/EventBus.js';

const MAP_EXTENT = 1750;

/** World map: islands, the player, fleets, bosses, quests and hotspots. */
export class MapPanel extends Panel {
  constructor(game) {
    super(game, { id: 'map', title: '🗺 World Map', width: '' });
    this.live = true;
  }

  render() {
    if (!this.el) return;
    const g = this.game;
    const player = g.get('player');
    const quests = g.get('quests');
    const fleets = g.get('fleets');
    const size = 640;
    const toPx = (x, z) => [
      ((x + MAP_EXTENT) / (MAP_EXTENT * 2)) * size,
      ((z + MAP_EXTENT) / (MAP_EXTENT * 2)) * size,
    ];

    const islands = REGIONS.map((r) => {
      const unlocked = quests ? quests.isRegionUnlocked(r.id) : r.unlocked;
      const [px, py] = toPx(r.x, r.z);
      const rad = (r.radius / (MAP_EXTENT * 2)) * size * 1.35;
      if (!unlocked) {
        return `<g><circle cx="${px}" cy="${py}" r="${rad}" fill="#1b2a38" stroke="#2b455e" stroke-dasharray="4 4"/>
          <text x="${px}" y="${py + 5}" text-anchor="middle" font-size="15" fill="#55708a">?</text></g>`;
      }
      const col = r.trench ? '#101c26' : '#c9b483';
      return `<g class="map-island" data-action="waypoint" data-id="${r.id}" style="cursor:pointer">
        <circle cx="${px}" cy="${py}" r="${rad}" fill="${col}" stroke="#e8dcbb" stroke-width="1.2" opacity="0.92"/>
        <circle cx="${px}" cy="${py}" r="${rad * 1.9}" fill="none" stroke="#2fd4c4" stroke-width="0.6" opacity="0.22"/>
        <text x="${px}" y="${py - rad - 6}" text-anchor="middle" font-size="12" font-weight="800" fill="#eaf4fb">${r.name}</text>
        <text x="${px}" y="${py + rad + 14}" text-anchor="middle" font-size="10" fill="#8fa8ba">Tier ${r.tier}</text>
        ${r.boss ? `<text x="${px + rad * 0.8}" y="${py - rad * 0.5}" font-size="13">💀</text>` : ''}
      </g>`;
    }).join('');

    const [ppx, ppy] = player ? toPx(player.position.x, player.position.z) : [size / 2, size / 2];
    const yawDeg = player ? (-player.yaw * 180 / Math.PI) : 0;

    const fleetMarks = (fleets?.fleets || []).map((f) => {
      if (!f.position) return '';
      const [fx, fy] = toPx(f.position.x, f.position.z);
      return `<g><circle cx="${fx}" cy="${fy}" r="4" fill="#43a9ff" stroke="#eaf4fb"/>
        <text x="${fx}" y="${fy - 8}" text-anchor="middle" font-size="9" fill="#9fd6ff">${f.name}</text></g>`;
    }).join('');

    this.bodyEl.innerHTML = `
      <div style="display:flex;gap:16px;align-items:flex-start">
        <svg viewBox="0 0 ${size} ${size}" style="width:${size}px;max-width:60vw;background:linear-gradient(180deg,#0b2a44,#061726);border-radius:8px;border:1px solid var(--line)">
          <defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0 L0 0 0 40" fill="none" stroke="#123049" stroke-width="0.6"/></pattern></defs>
          <rect width="${size}" height="${size}" fill="url(#grid)"/>
          ${islands}
          ${fleetMarks}
          <g transform="translate(${ppx},${ppy}) rotate(${yawDeg})">
            <path d="M0,-8 L6,7 L0,3 L-6,7 Z" fill="#2fd4c4" stroke="#04231f" stroke-width="1"/>
          </g>
        </svg>
        <div style="flex:1;min-width:220px">
          ${REGIONS.map((r) => {
            const unlocked = quests ? quests.isRegionUnlocked(r.id) : r.unlocked;
            const d = player ? Math.hypot(player.position.x - r.x, player.position.z - r.z) : 0;
            return `<div class="list-row">
              <span class="lr-icon">${unlocked ? '🏝' : '🔒'}</span>
              <div class="lr-main"><div class="lr-title">${unlocked ? r.name : '???'}</div>
                <div class="lr-sub">${unlocked ? `${formatDistance(d)} away · Tier ${r.tier}` : (r.unlockReq ? unlockHint(r) : `${formatMoneyExact(r.unlockCost)}`)}</div></div>
              ${unlocked ? '' : `<button class="btn sm" data-action="unlock" data-id="${r.id}">Unlock</button>`}
            </div>`;
          }).join('')}
        </div>
      </div>`;
    this.setFoot(`<span style="color:var(--ink-faint)">Position ${player ? `${player.position.x.toFixed(0)}, ${player.position.z.toFixed(0)}` : '—'}</span>`);

    this.onAction((act, ds) => {
      if (act === 'unlock') bus.emit('region:tryUnlock', { id: ds.id });
      if (act === 'waypoint') bus.emit('map:waypoint', { id: ds.id });
      setTimeout(() => { if (this.open) this.render(); }, 40);
    });
  }
}

function unlockHint(r) {
  const q = r.unlockReq || {};
  if (q.boss) return `Defeat ${q.boss}`;
  if (q.quest) return 'Complete a quest chain';
  if (q.research) return `Research: ${q.research}`;
  return 'Locked';
}
