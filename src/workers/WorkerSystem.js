import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { Worker, WS } from './Worker.js';
import {
  ROLES, ROLE_LIST, TRAITS, SKILLS, FIRST_NAMES, LAST_NAMES, NICKNAMES,
  baseWage, xpForLevel,
} from '../data/workers.js';
import { REGIONS, REGION_BY_ID } from '../data/regions.js';
import { worldHeight } from '../world/Terrain.js';
import {
  clamp, clamp01, lerp, rrange, rint, rpick, rchance, makeRNG, weightedPick,
  formatMoneyExact, dist2DSq,
} from '../util/math.js';

const NEAR_RADIUS = 110;     // full physical simulation inside this
const FAR_RADIUS = 150;      // despawn the mesh beyond this
let _nextId = 1;

/**
 * Employment: hiring, assignment, payroll, and the near/far split.
 *
 * Near the player, workers run the full physical FSM with meshes and
 * animation. Far away, the SAME FSM runs at a low tick rate with no mesh, so
 * a distant crew still produces real catches and real revenue.
 */
export class WorkerSystem {
  constructor(game) {
    this.game = game;
    this.name = 'workers';
    this.order = 74;
    /** @type {Worker[]} */
    this.workers = [];
    this.candidates = [];
    this.hiringUnlocked = false;
    this.unlockHint = 'Reach Port Grimsby and complete "Your First Employee".';
    this.maxWorkers = 4;
    this.refreshCost = 100;
    this.rng = makeRNG(777001);
    this.managerBonus = { morale: 0, efficiency: 0, catchRate: 0, price: 0 };
    this.root = null;
    this._farAccum = 0;
    this._payTimer = 0;
    this.speechEl = null;
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'workers';
    game.scene.add(this.root);

    this.refreshCandidates(true);

    bus.on('feature:unlocked', ({ id }) => {
      if (id === 'workers' || id === 'hiring') { this.hiringUnlocked = true; this.refreshCandidates(true); }
    });
    bus.on('harbor:built', ({ id }) => {
      if (id === 'employment_office') { this.hiringUnlocked = true; this.refreshCandidates(true); }
    });
    bus.on('company:hire', ({ id }) => this.hire(id));
    bus.on('company:fireWorker', ({ id }) => this.fire(id));
    bus.on('company:trainWorker', ({ id }) => this.train(id));
    bus.on('company:refreshCandidates', () => {
      const eco = game.get('economy');
      if (eco?.spend(this.refreshCost, 'hiring')) this.refreshCandidates(true);
    });
    bus.on('company:assign', ({ id, value }) => this.assign(id, value));
    bus.on('debug:hireWorker', ({ count = 1 }) => {
      this.hiringUnlocked = true;
      for (let i = 0; i < count; i++) {
        if (!this.candidates.length) this.refreshCandidates(true);
        const c = this.candidates[0];
        if (c) this.hire(c.id, true);
      }
    });
    bus.on('debug:clearWorkers', () => { for (const w of [...this.workers]) this.fire(w.id, true); });
    bus.on('economy:newDay', () => this.onNewDay());
    bus.on('worker:speech', (d) => this.showSpeech(d));

    // Assignment dropdown in the company panel is a <select>, not a button.
    document.addEventListener('change', (e) => {
      const node = e.target?.closest?.('[data-action="assign"]');
      if (node) this.assign(node.dataset.id, node.value);
    });

    return this;
  }

  // ------------------------------------------------------------- hiring
  generateCandidate(tierHint = 1) {
    const rng = this.rng;
    const research = this.game.get('research');
    const quests = this.game.get('quests');
    const availableRoles = ROLE_LIST.filter((r) => {
      if (!r.unlock) return true;
      if (r.unlock === 'harbor') return quests?.isRegionUnlocked('harbor');
      return quests?.unlockedFeatures.has(r.unlock) || research?.features?.has(r.unlock);
    });
    const role = rpick(availableRoles.length ? availableRoles : [ROLES.fisherman]);

    const skills = {};
    for (const k of SKILLS) skills[k] = rint(1, 5);
    // Primary skills skew high so a "Fisherman" is actually good at fishing.
    for (const k of role.primary) skills[k] = clamp(skills[k] + rint(2, 5), 1, 10);
    for (const k of role.skills) skills[k] = clamp(skills[k] + rint(0, 2), 1, 10);

    // 1-3 traits, no duplicates, at most one clearly-bad one.
    const traits = [];
    const pool = [...TRAITS];
    const n = weightedPick([{ n: 1, weight: 45 }, { n: 2, weight: 40 }, { n: 3, weight: 15 }], rng).n;
    let badCount = 0;
    for (let i = 0; i < n && pool.length; i++) {
      const pick = weightedPick(pool, rng);
      if (!pick) break;
      pool.splice(pool.indexOf(pick), 1);
      if (pick.good === false) { if (badCount >= 1) continue; badCount++; }
      traits.push(pick);
    }

    let level = 1 + Math.max(0, Math.floor(rng.gauss(tierHint - 1, 1.2)));
    if (traits.some((t) => t.id === 'veteran')) level += 4;
    level = clamp(level, 1, 25);

    const name = `${rpick(FIRST_NAMES)} ${rpick(LAST_NAMES)}`;
    const seed = (rng() * 1e9) | 0;
    const wageMult = 1 + traits.reduce((a, t) => a + (t.effect?.wageMult ?? 0), 0);
    const wage = Math.round(baseWage(role.id, level, skills) * wageMult);

    return {
      id: `c${_nextId++}`, seed, name, role: role.id, roleName: role.name, icon: role.icon,
      level, xp: 0, skills, traits, morale: 0.85, wage,
      hireCost: Math.round(wage * role.hireMult * (0.85 + rng() * 0.4)),
    };
  }

  refreshCandidates(force = false) {
    const quests = this.game.get('quests');
    const tier = quests ? Math.max(1, [...quests.unlockedRegions].length) : 1;
    const n = clamp(3 + Math.floor(tier / 2), 3, 6);
    this.candidates = [];
    for (let i = 0; i < n; i++) this.candidates.push(this.generateCandidate(tier));
    bus.emit('candidates:refreshed', { count: n });
  }

  hire(candidateId, free = false) {
    const idx = this.candidates.findIndex((c) => c.id === candidateId);
    if (idx < 0) return null;
    const c = this.candidates[idx];
    if (this.workers.length >= this.maxWorkers) {
      bus.emit('toast', { text: `Employee limit reached (${this.maxWorkers}). Expand the harbour.`, kind: 'error' });
      return null;
    }
    const eco = this.game.get('economy');
    if (!free && !eco.spend(c.hireCost, 'hiring')) return null;
    this.candidates.splice(idx, 1);

    const world = this.game.get('world');
    const region = world?.activeRegion || REGION_BY_ID.crash;
    const anchors = world?.getAnchors(region.id);
    const spawn = anchors?.hire || anchors?.spawn || { x: region.x, y: 5, z: region.z };

    const w = new Worker(this.game, {
      ...c, id: `w${_nextId++}`,
      x: spawn.x + rrange(-2, 2), y: worldHeight(spawn.x, spawn.z), z: spawn.z + rrange(-2, 2),
      hiredDay: eco?.day ?? 1,
    });
    w.homeAnchor = { x: spawn.x, z: spawn.z };
    // Sensible default job so a new hire starts producing immediately.
    w.assignment = defaultAssignment(w, region.id);
    this.workers.push(w);
    this.recomputeManagerBonus();

    this.game.audio.play('purchase', { volume: 0.6 });
    bus.emit('toast', {
      text: `👷 Hired <b>${w.name}</b> — ${w.roleName}, ${formatMoneyExact(w.wage)}/day`,
      kind: 'success', duration: 5000,
    });
    bus.emit('workers:changed', { count: this.workers.length, hired: w });
    return w;
  }

  fire(id, silent = false) {
    const i = this.workers.findIndex((w) => w.id === id);
    if (i < 0) return;
    const w = this.workers[i];
    if (w.physical) w.despawnPhysical(this.root);
    w.clearFishingLine();
    this.workers.splice(i, 1);
    this.recomputeManagerBonus();
    if (!silent) {
      bus.emit('toast', { text: `Let go of ${w.name}.`, kind: 'warn' });
      this.game.audio.play('ui_close', { volume: 0.5 });
    }
    bus.emit('workers:changed', { count: this.workers.length, fired: w });
  }

  train(id) {
    const w = this.byId(id);
    if (!w) return;
    const eco = this.game.get('economy');
    if (!eco.spend(w.trainCost, 'training')) return;
    w.addXP(w.xpToNext * 0.85, this.game);
    w.morale = clamp01(w.morale + 0.1);
    this.game.audio.play('levelup', { volume: 0.5 });
    bus.emit('toast', { text: `${w.name} trained.`, kind: 'success' });
  }

  assign(id, value) {
    const w = this.byId(id);
    if (!w) return;
    if (w.assignment === value) return;
    w.assignment = value === 'none' ? null : value;
    w.fishingSpot = null;
    w.navTarget = null;
    w.setState(WS.IDLE);
    bus.emit('worker:assigned', { worker: w, assignment: w.assignment });
  }

  /** Options shown in the company panel's assignment dropdown. */
  assignmentOptions(w) {
    const quests = this.game.get('quests');
    const out = [{ id: 'none', label: 'Idle' }];
    for (const r of REGIONS) {
      if (r.trench) continue;
      if (quests && !quests.isRegionUnlocked(r.id)) continue;
      out.push({ id: `fish:${r.id}`, label: `Fish at ${r.name}` });
    }
    if (w.role === 'processor' || w.role === 'deckhand') out.push({ id: 'process', label: 'Processing plant' });
    if (w.role === 'mechanic' || w.role === 'deckhand') out.push({ id: 'repair', label: 'Repair shop' });
    const fleets = this.game.get('fleets');
    for (const f of fleets?.fleets || []) out.push({ id: `fleet:${f.id}`, label: `Crew: ${f.name}` });
    out.push({ id: 'rest', label: 'Rest' });
    return out;
  }

  byId(id) { return this.workers.find((w) => w.id === id) || null; }
  countRole(role) { return this.workers.filter((w) => w.role === role).length; }
  dailyWages() {
    return this.workers.reduce((a, w) => a + w.wage, 0);
  }

  recomputeManagerBonus() {
    const b = { morale: 0, efficiency: 0, catchRate: 0, price: 0 };
    for (const w of this.workers) {
      if (w.role !== 'manager') continue;
      b.morale += w.treeBonus('teamMorale') + 0.03;
      b.efficiency += w.treeBonus('teamEfficiency') + 0.02;
      b.catchRate += w.treeBonus('teamCatchRate') + 0.02;
      b.price += w.treeBonus('priceMult');
    }
    // Diminishing returns so stacking managers isn't degenerate.
    for (const k of Object.keys(b)) b[k] = Math.min(b[k], 0.45);
    this.managerBonus = b;
    const harbor = this.game.get('harbor');
    const research = this.game.get('research');
    this.maxWorkers = 4 + (harbor?.workerSlots || 0) + (research?.workerSlots || 0);
  }

  onNewDay() {
    this.payWages();
    this.refreshCandidates();
    for (const w of this.workers) {
      w.stats.daysWorked++;
      w.fatigue = Math.max(0, w.fatigue - 0.6);
    }
  }

  payWages() {
    const eco = this.game.get('economy');
    if (!eco || !this.workers.length) return 0;
    const total = this.dailyWages();
    eco.add(-total, 'wages');
    eco.today.wages += total;
    if (eco.money < 0) {
      // Unpaid crew lose morale fast and eventually quit.
      for (const w of this.workers) w.morale = clamp01(w.morale - 0.25);
      bus.emit('toast', { text: `Payroll missed! Morale is falling.`, kind: 'error', duration: 6000 });
      const quitters = this.workers.filter((w) => w.morale < 0.12);
      for (const q of quitters) {
        bus.emit('toast', { text: `${q.name} quit.`, kind: 'error' });
        this.fire(q.id, true);
      }
    } else {
      bus.emit('toast', { text: `Payroll: −${formatMoneyExact(total)} for ${this.workers.length} staff`, kind: 'muted', duration: 3500 });
    }
    return total;
  }

  // ------------------------------------------------------------- update
  update(dt, game) {
    if (dt <= 0) return;
    const player = game.get('player');
    if (!player) return;
    const px = player.position.x, pz = player.position.z;

    this._farAccum += dt;
    const farTick = this._farAccum >= 0.5;
    const farDt = this._farAccum;
    if (farTick) this._farAccum = 0;

    for (const w of this.workers) {
      const d2 = dist2DSq(w.position.x, w.position.z, px, pz);
      const near = d2 < NEAR_RADIUS * NEAR_RADIUS;

      if (near && !w.physical) {
        w.spawnPhysical(this.root);
        bus.emit('worker:spawned', { worker: w });
      } else if (!near && w.physical && d2 > FAR_RADIUS * FAR_RADIUS) {
        w.despawnPhysical(this.root);
      }

      if (near) {
        w.update(dt, game);
      } else if (farTick) {
        // Same FSM, coarse steps. Movement is instant-ish so distant crews
        // still progress through their loop rather than freezing.
        w.update(Math.min(farDt, 0.5), game);
        if (w.navTarget) {
          // Teleport-glide toward the target when nobody can see it.
          const step = 3.2 * farDt * w.d.speedMult;
          _v.copy(w.navTarget).sub(w.position).setY(0);
          const dist = _v.length();
          if (dist <= step) { w.position.copy(w.navTarget); w.navTarget = null; }
          else { w.position.addScaledVector(_v.multiplyScalar(1 / dist), step); }
          w.position.y = worldHeight(w.position.x, w.position.z);
        }
      }
    }

    this.updateSpeech(dt);
  }

  // ------------------------------------------------------------- speech UI
  showSpeech({ worker, line }) {
    if (!this.game.settings.subtitles) return;
    if (!worker.physical) return;
    const player = this.game.get('player');
    if (!player || worker.position.distanceToSquared(player.position) > 900) return;
    if (!this.speechEl) {
      this.speechEl = document.createElement('div');
      this.speechEl.style.cssText = 'position:absolute;pointer-events:none;background:rgba(8,16,24,.82);border:1px solid rgba(90,140,175,.35);padding:4px 10px;border-radius:12px;font-size:13px;white-space:nowrap;transform:translate(-50%,-100%);transition:opacity .3s';
      document.getElementById('ui-root').appendChild(this.speechEl);
    }
    this.speechEl.innerHTML = `<b style="color:var(--accent)">${worker.name}:</b> ${line}`;
    this.speechEl.style.opacity = '1';
    this._speechWorker = worker;
    this._speechTimer = 3.4;
  }

  updateSpeech(dt) {
    if (!this.speechEl || this._speechTimer <= 0) return;
    this._speechTimer -= dt;
    if (this._speechTimer <= 0) { this.speechEl.style.opacity = '0'; return; }
    const w = this._speechWorker;
    if (!w?.physical) { this.speechEl.style.opacity = '0'; return; }
    _v.set(w.position.x, w.position.y + 2.15, w.position.z).project(this.game.camera);
    if (_v.z > 1) { this.speechEl.style.opacity = '0'; return; }
    this.speechEl.style.left = `${(_v.x * 0.5 + 0.5) * window.innerWidth}px`;
    this.speechEl.style.top = `${(-_v.y * 0.5 + 0.5) * window.innerHeight}px`;
  }

  // ------------------------------------------------------------- persistence
  save() {
    return {
      workers: this.workers.map((w) => w.serialize()),
      candidates: this.candidates,
      hiringUnlocked: this.hiringUnlocked,
      nextId: _nextId,
    };
  }

  load(d) {
    for (const w of [...this.workers]) this.fire(w.id, true);
    if (!d) return;
    _nextId = d.nextId || _nextId;
    this.hiringUnlocked = !!d.hiringUnlocked;
    this.candidates = d.candidates || [];
    for (const wd of d.workers || []) {
      const w = new Worker(this.game, wd);
      w.homeAnchor = { x: wd.x, z: wd.z };
      this.workers.push(w);
    }
    this.recomputeManagerBonus();
    bus.emit('workers:changed', { count: this.workers.length });
  }
}

function defaultAssignment(w, regionId) {
  switch (w.role) {
    case 'fisherman': return `fish:${regionId}`;
    case 'processor': return 'process';
    case 'mechanic': return 'repair';
    default: return null;
  }
}

const _v = new THREE.Vector3();
