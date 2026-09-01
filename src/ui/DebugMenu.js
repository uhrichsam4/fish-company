import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { FISH_SPECIES, VARIANTS, BOSS_IDS, getSpecies, rollFishInstance } from '../data/fishData.js';
import { REGIONS } from '../data/regions.js';
import { ROD_TIERS, LINE_TIERS, REEL_TIERS, TOOLS, BAIT_TYPES, STORAGE_TIERS, ITEM_BY_ID } from '../data/equipment.js';
import { formatMoneyExact } from '../util/math.js';

/**
 * F8 developer menu. Exists so every late-game system can actually be
 * exercised without grinding to it.
 */
export class DebugMenu {
  constructor(game) {
    this.game = game;
    this.name = 'debug';
    this.order = 990;
    this.open = false;
    this.el = null;
    this.overlays = { ai: false, physics: false, spawns: false, nav: false, fleet: false };
  }

  async init(game) {
    this.el = document.createElement('div');
    this.el.id = 'debug-menu';
    this.el.classList.add('hidden');
    this.el.style.pointerEvents = 'auto';
    document.getElementById('ui-root').appendChild(this.el);
    this.build();

    this.helperRoot = new THREE.Group();
    this.helperRoot.name = 'debug-helpers';
    game.scene.add(this.helperRoot);
    return this;
  }

  build() {
    const g = this.game;
    const sec = (title, body) => `<div class="dbg-sec"><div class="dbg-title">${title}</div>${body}</div>`;
    const btn = (label, act) => `<button data-act="${act}">${label}</button>`;

    this.el.innerHTML = `
      <h3>🐟 DEV MENU <span style="float:right;opacity:.5">F8</span></h3>
      ${sec('Money', [10000, 100000, 1000000, 100000000].map((n) => btn(`+${formatMoneyExact(n)}`, `money:${n}`)).join('')
        + btn('Reset $0', 'money:reset'))}
      ${sec('Fish', `
        <select data-sel="species">${FISH_SPECIES.map((s) => `<option value="${s.id}">${s.name} (T${s.tier})</option>`).join('')}</select>
        <select data-sel="variant">${VARIANTS.map((v) => `<option value="${v.id}">${v.name || 'Normal'}</option>`).join('')}</select>
        ${btn('Spawn 1', 'fish:spawn:1')}${btn('Spawn 5', 'fish:spawn:5')}
        ${btn('Spawn Physical', 'fish:physical')}
        ${btn('Random Rare', 'fish:rare')}${btn('Clear Fish', 'fish:clear')}
        ${btn('Fill Storage', 'fish:fillstorage')}`)}
      ${sec('Bosses', BOSS_IDS.map((b) => btn(b, `boss:${b}`)).join(''))}
      ${sec('Equipment', `
        <select data-sel="item">${Object.values(ITEM_BY_ID).map((i) => `<option value="${i.id}">${i.name}</option>`).join('')}</select>
        ${btn('Give + Equip', 'item:give')}${btn('Give ALL', 'item:all')}
        ${btn('Max Tier Gear', 'item:max')}`)}
      ${sec('Regions', `
        <select data-sel="region">${REGIONS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('')}</select>
        ${btn('Teleport', 'region:tp')}${btn('Unlock', 'region:unlock')}${btn('Unlock All', 'region:all')}`)}
      ${sec('World', `
        ${btn('☀ Clear', 'weather:clear')}${btn('☁ Cloudy', 'weather:cloudy')}${btn('🌧 Rain', 'weather:rain')}
        ${btn('🌫 Fog', 'weather:fog')}${btn('⛈ Storm', 'weather:storm')}${btn('🌊 Heavy', 'weather:heavy_storm')}
        <br>${btn('🌅 Dawn', 'time:0.25')}${btn('☀ Noon', 'time:0.5')}${btn('🌇 Dusk', 'time:0.75')}${btn('🌙 Night', 'time:0.0')}
        <br>${btn('Time x1', 'timescale:1')}${btn('x0.25', 'timescale:0.25')}${btn('x3', 'timescale:3')}${btn('Pause TOD', 'sky:pause')}`)}
      ${sec('Company', `
        ${btn('Hire Worker', 'worker:hire')}${btn('Hire x5', 'worker:hire5')}${btn('Clear Workers', 'worker:clear')}
        <br>${btn('Give Boat', 'boat:give')}${btn('Give All Boats', 'boat:all')}
        <br>${btn('Give Sub', 'sub:give')}${btn('Unlock Research', 'research:all')}
        <br>${btn('Complete Quest', 'quest:complete')}${btn('Unlock All Quests', 'quest:all')}`)}
      ${sec('Player', `
        ${btn('Heal', 'player:heal')}${btn('God Mode', 'player:god')}${btn('Noclip', 'player:noclip')}
        <br>${btn('Speed x3', 'player:fast')}${btn('Normal Speed', 'player:normal')}
        <br>${btn('Teleport to Water', 'player:water')}${btn('Respawn', 'player:respawn')}`)}
      ${sec('Debug Overlays', `
        ${btn('AI States', 'overlay:ai')}${btn('Physics', 'overlay:physics')}
        ${btn('Spawn Zones', 'overlay:spawns')}${btn('Nav Targets', 'overlay:nav')}
        ${btn('Fleet Routes', 'overlay:fleet')}<br>${btn('FPS', 'overlay:fps')}${btn('Wireframe', 'overlay:wire')}`)}
      ${sec('Save', `${btn('Save', 'save:now')}${btn('Load', 'save:load')}${btn('Wipe + Reload', 'save:wipe')}
        <br>${btn('Export', 'save:export')}${btn('Log Stats', 'save:stats')}`)}
      ${sec('Perf', `${btn('Stress 200 Fish', 'perf:fish')}${btn('Stress Physics', 'perf:phys')}${btn('Quality High', 'perf:high')}${btn('Quality Low', 'perf:low')}`)}
      <div style="opacity:.5;font-size:10px;margin-top:6px">F3 perf · F4 hud · F8 menu</div>`;

    this.el.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act) { e.stopPropagation(); this.run(act); }
    });
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  sel(name) { return this.el.querySelector(`[data-sel="${name}"]`)?.value; }

  run(act) {
    const g = this.game;
    const [cmd, arg, arg2] = act.split(':');
    const eco = g.get('economy');
    const inv = g.get('inventory');
    const player = g.get('player');
    const fish = g.get('fish');
    const toast = (t, k = 'success') => bus.emit('toast', { text: t, kind: k });

    try {
      switch (cmd) {
        case 'money':
          if (arg === 'reset') { eco.money = 0; bus.emit('money:changed', { total: 0, delta: 0 }); }
          else eco.add(+arg, 'debug');
          break;
        case 'fish': {
          if (arg === 'spawn') {
            fish?.spawnSpecific({ speciesId: this.sel('species'), variantId: this.sel('variant'), count: +arg2 });
            toast(`Spawned ${arg2}x ${this.sel('species')}`);
          } else if (arg === 'physical') {
            const sp = getSpecies(this.sel('species'));
            const inst = rollFishInstance(sp, Math.random, { forceVariant: this.sel('variant') });
            const p = player.eyePosition.clone();
            player.forward(_v); p.addScaledVector(_v, 2.5);
            g.get('physfish')?.spawn({ instance: inst, position: p, velocity: { x: _v.x * 3, y: 3, z: _v.z * 3 } });
          } else if (arg === 'rare') {
            const rare = FISH_SPECIES.filter((s) => ['rare', 'epic', 'legendary', 'mythic'].includes(s.rarity));
            const sp = rare[(Math.random() * rare.length) | 0];
            fish?.spawnSpecific({ speciesId: sp.id, variantId: 'golden', count: 1 });
            toast(`Spawned golden ${sp.name}`);
          } else if (arg === 'clear') { fish?.despawnAll(); g.get('physfish')?.despawnAll(); }
          else if (arg === 'fillstorage') {
            for (let i = 0; i < 30 && !inv.isFull; i++) {
              const sp = FISH_SPECIES[(Math.random() * 20) | 0];
              inv.storeFish(rollFishInstance(sp, Math.random, {}));
            }
            toast('Storage filled');
          }
          break;
        }
        case 'boss': bus.emit('boss:spawn', { id: arg }); toast(`Summoning ${arg}`); break;
        case 'item': {
          if (arg === 'give') { inv.acquire(this.sel('item')); inv.equip(this.sel('item')); toast(`Gave ${this.sel('item')}`); }
          else if (arg === 'all') { for (const id of Object.keys(ITEM_BY_ID)) inv.acquire(id); toast('Gave all equipment'); }
          else if (arg === 'max') {
            const best = [ROD_TIERS, LINE_TIERS, REEL_TIERS, STORAGE_TIERS].map((l) => l[l.length - 1].id);
            best.push(TOOLS[TOOLS.length - 1].id, BAIT_TYPES[BAIT_TYPES.length - 1].id);
            for (const id of best) { inv.acquire(id); inv.equip(id); }
            toast('Max gear equipped');
          }
          break;
        }
        case 'region': {
          const prog = g.get('quests');
          if (arg === 'tp') {
            const r = REGIONS.find((x) => x.id === this.sel('region'));
            g.get('world')?.activateRegion(r.id).then(() => {
              const a = g.get('world').getAnchors(r.id);
              player.spawnAt(a.spawn || { x: r.x, y: 6, z: r.z });
            });
            toast(`Teleporting to ${r.name}`);
          } else if (arg === 'unlock') { bus.emit('region:unlock', { id: this.sel('region') }); }
          else if (arg === 'all') { for (const r of REGIONS) bus.emit('region:unlock', { id: r.id }); toast('All regions unlocked'); }
          break;
        }
        case 'weather': bus.emit('weather:set', { id: arg }); toast(`Weather: ${arg}`); break;
        case 'time': g.get('sky')?.setTimeOfDay(+arg); break;
        case 'timescale': g.timeScale = +arg; toast(`Time scale ${arg}x`); break;
        case 'sky': { const s = g.get('sky'); s.paused = !s.paused; toast(`TOD ${s.paused ? 'paused' : 'running'}`); break; }
        case 'worker':
          if (arg === 'hire') bus.emit('debug:hireWorker', { count: 1 });
          else if (arg === 'hire5') bus.emit('debug:hireWorker', { count: 5 });
          else if (arg === 'clear') bus.emit('debug:clearWorkers');
          break;
        case 'boat': bus.emit('debug:giveBoat', { all: arg === 'all' }); break;
        case 'sub': bus.emit('debug:giveSub', {}); break;
        case 'research': bus.emit('debug:unlockResearch', {}); break;
        case 'quest':
          if (arg === 'complete') bus.emit('debug:completeQuest', {});
          else bus.emit('debug:unlockAllQuests', {});
          break;
        case 'player':
          if (arg === 'heal') { player.health = player.maxHealth; player.oxygen = player.maxOxygen; player.stamina = 100; }
          else if (arg === 'god') { player.invulnerable = !player.invulnerable; toast(`God mode ${player.invulnerable ? 'ON' : 'OFF'}`); }
          else if (arg === 'noclip') { g.physics.enabled = !g.physics.enabled; toast(`Physics ${g.physics.enabled ? 'ON' : 'OFF'}`); }
          else if (arg === 'fast') { player.walkSpeed = 16; player.sprintSpeed = 34; }
          else if (arg === 'normal') { player.walkSpeed = 4.6; player.sprintSpeed = 7.6; }
          else if (arg === 'water') {
            const w = g.get('world');
            const r = w.activeRegion || REGIONS[0];
            player.teleport(r.x + r.radius * 1.5, 1.5, r.z);
          } else if (arg === 'respawn') {
            const w = g.get('world');
            const a = w.getAnchors(w.activeRegion?.id || 'crash');
            player.spawnAt(a.spawn);
          }
          break;
        case 'overlay':
          if (arg === 'fps') { g.settings.showFps = !g.settings.showFps; bus.emit('settings:changed'); }
          else if (arg === 'wire') {
            g.scene.traverse((o) => { if (o.isMesh && o.material && 'wireframe' in o.material) o.material.wireframe = !o.material.wireframe; });
          } else { this.overlays[arg] = !this.overlays[arg]; bus.emit('debug:overlay', { name: arg, on: this.overlays[arg] }); toast(`${arg} overlay ${this.overlays[arg] ? 'ON' : 'OFF'}`); }
          break;
        case 'save':
          if (arg === 'now') { g.save.save(); toast('Saved'); }
          else if (arg === 'load') { g.save.load(); toast('Loaded'); }
          else if (arg === 'wipe') { g.save.wipe(); location.reload(); }
          else if (arg === 'export') { console.log(g.save.exportString()); toast('Save string logged to console'); }
          else if (arg === 'stats') { console.table(eco.stats); toast('Stats logged'); }
          break;
        case 'perf':
          if (arg === 'fish') { g.settings.maxFish = 400; fish.maxFish = 400; for (let i = fish.pool.length; i < 400; i++) { const F = fish.pool[0].constructor; const f = new F(i); fish.root.add(f.group); fish.pool.push(f); } toast('Fish cap 400'); }
          else if (arg === 'phys') { bus.emit('debug:stressPhysics'); }
          else if (arg === 'high') { g.quality = 'high'; bus.emit('quality:changed', 'high'); }
          else if (arg === 'low') { g.quality = 'low'; bus.emit('quality:changed', 'low'); }
          break;
      }
    } catch (e) {
      console.error('[Debug] action failed:', act, e);
      bus.emit('toast', { text: `Debug action failed: ${e.message}`, kind: 'error' });
    }
  }

  toggle() {
    this.open = !this.open;
    this.el.classList.toggle('hidden', !this.open);
    this.game.input.uiCapture = this.open || !!this.game.get('ui')?.anyOpen?.();
    if (this.open) this.game.input.exitLock();
  }

  update(dt, game) {
    const input = game.input;
    if (input.rawPressed('F8')) this.toggle();
    if (input.rawPressed('F3')) { game.settings.showFps = !game.settings.showFps; bus.emit('settings:changed'); }
    if (input.rawPressed('F4')) { this._hud = !this._hud; bus.emit('hud:visible', !this._hud); }

    if (this.overlays.ai || this.overlays.nav) this.drawAIOverlay(game);
    else if (this.helperRoot.children.length) this.clearHelpers();
  }

  clearHelpers() {
    for (const c of [...this.helperRoot.children]) {
      this.helperRoot.remove(c);
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
  }

  drawAIOverlay(game) {
    this.clearHelpers();
    const workers = game.get('workers');
    if (!workers?.workers) return;
    const pts = [];
    for (const w of workers.workers) {
      if (!w.physical || !w.object) continue;
      if (w.navTarget) {
        pts.push(w.object.position.x, w.object.position.y + 1, w.object.position.z);
        pts.push(w.navTarget.x, w.navTarget.y + 0.4, w.navTarget.z);
      }
    }
    if (!pts.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2fd4c4, depthTest: false }));
    line.renderOrder = 999;
    this.helperRoot.add(line);
  }
}

const _v = new THREE.Vector3();
