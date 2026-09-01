import { bus } from './EventBus.js';

const KEY = 'fishcompany.save.v1';
const SETTINGS_KEY = 'fishcompany.settings.v1';
export const SAVE_VERSION = 7;

/**
 * localStorage-backed versioned save with migrations and slot support.
 * Systems register serializers; the manager owns format + migration only.
 */
export class SaveManager {
  constructor() {
    /** @type {Map<string,{save:Function,load:Function}>} */
    this.providers = new Map();
    this.lastSaveAt = 0;
    this.autosaveInterval = 45;
    this._timer = 0;
    this.enabled = true;
    this.slot = 0;
    this.dirty = false;
  }

  register(key, save, load) { this.providers.set(key, { save, load }); }

  key(slot = this.slot) { return slot === 0 ? KEY : `${KEY}.slot${slot}`; }

  serialize() {
    const data = { version: SAVE_VERSION, savedAt: Date.now(), systems: {} };
    for (const [k, p] of this.providers) {
      try { data.systems[k] = p.save(); }
      catch (e) { console.error(`[Save] "${k}" serializer threw:`, e); }
    }
    return data;
  }

  save(slot = this.slot) {
    if (!this.enabled) return false;
    try {
      const data = this.serialize();
      const json = JSON.stringify(data);
      localStorage.setItem(this.key(slot), json);
      this.lastSaveAt = Date.now();
      this.dirty = false;
      bus.emit('save:written', { bytes: json.length, slot });
      return true;
    } catch (e) {
      console.error('[Save] write failed', e);
      bus.emit('save:error', e);
      if (e?.name === 'QuotaExceededError') bus.emit('toast', { text: 'Save failed: storage full', kind: 'error' });
      return false;
    }
  }

  read(slot = this.slot) {
    try {
      const raw = localStorage.getItem(this.key(slot));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { console.error('[Save] read failed', e); return null; }
  }

  load(slot = this.slot) {
    const data = this.read(slot);
    if (!data) return false;
    const migrated = migrate(data);
    if (!migrated) { console.warn('[Save] incompatible, ignoring'); return false; }
    // Load order matters: economy/world before things that reference them.
    const order = ['settings', 'time', 'weather', 'economy', 'progress', 'world', 'player',
      'inventory', 'atlas', 'quests', 'research', 'harbor', 'workers', 'boats', 'fleets', 'subs', 'stats'];
    const keys = [...this.providers.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const k of keys) {
      const p = this.providers.get(k);
      if (!p || migrated.systems?.[k] === undefined) continue;
      try { p.load(migrated.systems[k]); }
      catch (e) { console.error(`[Save] "${k}" loader threw:`, e); }
    }
    bus.emit('save:loaded', migrated);
    return true;
  }

  hasSave(slot = this.slot) { return !!localStorage.getItem(this.key(slot)); }

  wipe(slot = this.slot) {
    localStorage.removeItem(this.key(slot));
    bus.emit('save:wiped', slot);
  }

  slots() {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const d = this.read(i);
      out.push(d ? {
        slot: i, savedAt: d.savedAt, version: d.version,
        money: d.systems?.economy?.money ?? 0,
        playtime: d.systems?.stats?.playtime ?? 0,
        caught: d.systems?.stats?.totalCaught ?? 0,
      } : { slot: i, empty: true });
    }
    return out;
  }

  exportString() {
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(this.serialize())))); }
    catch (e) { console.error(e); return ''; }
  }

  importString(s) {
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
      localStorage.setItem(this.key(), JSON.stringify(data));
      return true;
    } catch (e) { console.error('[Save] import failed', e); return false; }
  }

  update(dt) {
    if (!this.enabled) return;
    this._timer += dt;
    if (this._timer >= this.autosaveInterval) {
      this._timer = 0;
      if (this.save()) bus.emit('toast', { text: 'Autosaved', kind: 'muted', short: true });
    }
  }

  // Settings live outside the save so they persist across new games.
  saveSettings(obj) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch { /* */ }
  }
  loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { return null; }
  }
}

/** Forward-migrate an old save blob. Returns null if unrecoverable. */
function migrate(data) {
  if (!data || typeof data !== 'object') return null;
  let v = data.version || 1;
  const s = data.systems || (data.systems = {});

  if (v < 2) {
    // v1 stored money at the root.
    if (data.money !== undefined) { s.economy = { ...(s.economy || {}), money: data.money }; }
    v = 2;
  }
  if (v < 3) {
    s.research = s.research || { unlocked: [], points: 0 };
    v = 3;
  }
  if (v < 4) {
    s.harbor = s.harbor || { buildings: [] };
    s.fleets = s.fleets || { fleets: [] };
    v = 4;
  }
  if (v < 5) {
    if (s.workers?.workers) {
      for (const w of s.workers.workers) { if (w.morale === undefined) w.morale = 0.8; }
    }
    v = 5;
  }
  if (v < 6) {
    s.subs = s.subs || { owned: [] };
    if (s.stats) s.stats.playtime = s.stats.playtime || 0;
    v = 6;
  }
  if (v < 7) {
    // Region ids became slugs.
    if (s.progress?.islands) {
      s.progress.islands = s.progress.islands.map((x) => (typeof x === 'number' ? ['crash', 'rocky', 'harbor', 'wilds', 'storm', 'frozen', 'station', 'abyss'][x] || 'crash' : x));
    }
    v = 7;
  }
  data.version = v;
  return data;
}
