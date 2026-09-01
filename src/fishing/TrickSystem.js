import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, formatMoneyExact } from '../util/math.js';
import * as THREE from 'three';

/**
 * Trick shots + the style combo meter.
 * Tricks are pure functions of the catch context so new ones are one entry.
 */
export const TRICKS = [
  { id: 'long', name: 'LONG SHOT', mult: 0.4, test: (c) => c.castDistance > 22 && c.castDistance <= 40, tip: 'Cast over 22 m' },
  { id: 'extreme', name: 'EXTREME RANGE', mult: 1.1, test: (c) => c.castDistance > 40, tip: 'Cast over 40 m' },
  { id: 'bounce', name: 'BOUNCE SHOT', mult: 0.7, test: (c) => c.bounces >= 1, tip: 'Bounce the cast off something first' },
  { id: 'multibounce', name: 'TRICK BOUNCE', mult: 1.4, test: (c) => c.bounces >= 2 },
  { id: 'spin', name: '360 CAST', mult: 1.0, test: (c) => Math.abs(c.spin || 0) > Math.PI * 1.85, tip: 'Spin a full turn while charging' },
  { id: 'spin720', name: '720 CAST', mult: 2.2, test: (c) => Math.abs(c.spin || 0) > Math.PI * 3.8 },
  { id: 'air', name: 'AIR SHOT', mult: 0.8, test: (c) => c.airborne, tip: 'Cast while jumping' },
  { id: 'boat', name: 'MOVING BOAT SHOT', mult: 0.6, test: (c) => c.fromBoat, tip: 'Cast from a moving boat' },
  { id: 'lob', name: 'HIGH ARC', mult: 0.5, test: (c) => (c.apex || 0) > 14 },
  { id: 'quick', name: 'QUICK LANDING', mult: 0.5, test: (c) => c.fightTime > 0 && c.fightTime < 3 && c.instance.weight > 3 },
  { id: 'marathon', name: 'MARATHON FIGHT', mult: 0.9, test: (c) => c.fightTime > 45 },
  { id: 'heavy', name: 'HEAVYWEIGHT', mult: 0.8, test: (c) => c.instance.weight > 60 },
  { id: 'colossal', name: 'COLOSSAL', mult: 2.0, test: (c) => c.instance.weight > 400 },
  { id: 'rare', name: 'RARE FIND', mult: 0.9, test: (c) => ['rare', 'epic'].includes(c.instance.rarity) },
  { id: 'legendary', name: 'LEGENDARY CATCH', mult: 2.5, test: (c) => ['legendary', 'mythic'].includes(c.instance.rarity) },
  { id: 'variant', name: 'SPECIAL VARIANT', mult: 1.2, test: (c) => c.instance.variantId && c.instance.variantId !== 'normal' },
  { id: 'harpoon', name: 'HARPOON KILL', mult: 0.7, test: (c) => c.method === 'harpoon' },
  { id: 'headon', name: 'HEAD-ON HARPOON', mult: 1.5, test: (c) => c.method === 'harpoon' && c.headOn },
  { id: 'midair', name: 'MID-AIR CATCH', mult: 1.8, test: (c) => c.midAir },
  { id: 'double', name: 'DOUBLE CATCH', mult: 1.6, test: (c) => c.doubleCatch },
  { id: 'sniper', name: 'SNIPER SHOT', mult: 1.3, test: (c) => c.method === 'harpoon' && (c.shotDistance || 0) > 55 },
  { id: 'binshot', name: 'NOTHING BUT BIN', mult: 2.0, test: (c) => c.intoSellBin },
  { id: 'storm', name: 'STORM CATCH', mult: 0.8, test: (c) => c.weather === 'storm' || c.weather === 'heavy_storm' },
  { id: 'night', name: 'NIGHT SHIFT', mult: 0.4, test: (c) => c.night },
  { id: 'deep', name: 'DEEP WATER', mult: 0.7, test: (c) => (c.depth || 0) > 120 },
];

const TRICK_BY_ID = Object.fromEntries(TRICKS.map((t) => [t.id, t]));

export class TrickSystem {
  constructor(game) {
    this.game = game;
    this.name = 'tricks';
    this.order = 55;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboWindow = 14;
    this.styleMult = 1;
    this.recentTricks = [];
    this.discovered = new Set();
    this.bestCombo = 0;
    this.totalTricks = 0;
  }

  async init() { return this; }

  /** @returns {{tricks:Array, mult:number, bonus:number}} */
  evaluateCatch(ctx) {
    const sky = this.game.get('sky');
    const weather = this.game.get('weather');
    const full = {
      castDistance: 0, apex: 0, bounces: 0, spin: 0, fromBoat: false, airborne: false,
      fightTime: 0, method: 'rod', ...ctx,
      night: sky ? sky.isNight : false,
      weather: weather?.current?.id || 'clear',
      depth: ctx.depth ?? 0,
    };
    const hit = [];
    for (const t of TRICKS) {
      try { if (t.test(full)) hit.push(t); } catch { /* a malformed ctx shouldn't kill a catch */ }
    }
    // Keep only the strongest of mutually-exclusive families.
    dedupeFamily(hit, ['long', 'extreme']);
    dedupeFamily(hit, ['bounce', 'multibounce']);
    dedupeFamily(hit, ['spin', 'spin720']);
    dedupeFamily(hit, ['heavy', 'colossal']);
    dedupeFamily(hit, ['rare', 'legendary']);
    dedupeFamily(hit, ['harpoon', 'headon']);

    let mult = 1;
    for (const t of hit) mult += t.mult;

    if (hit.length) {
      this.combo++;
      this.comboTimer = this.comboWindow;
      this.totalTricks += hit.length;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      for (const t of hit) {
        if (!this.discovered.has(t.id)) {
          this.discovered.add(t.id);
          bus.emit('toast', { text: `New trick discovered: ${t.name}`, kind: 'gold' });
        }
      }
      const eco = this.game.get('economy');
      if (eco) { eco.stats.tricksLanded += hit.length; eco.stats.bestCombo = Math.max(eco.stats.bestCombo, this.combo); }
    } else if (this.comboTimer <= 0) {
      this.combo = 0;
    }

    // Combo adds a compounding bonus on top of the trick multipliers.
    const comboBonus = this.combo > 1 ? 1 + (this.combo - 1) * 0.14 : 1;
    mult *= comboBonus;
    this.styleMult = mult;

    if (hit.length) {
      const audio = this.game.audio;
      // No dedicated combo cues in the pack — pitch the coin blip up per step.
      audio.play('coin', { volume: 0.45, rate: 1 + Math.min(this.combo, 9) * 0.085 });
      if (this.combo >= 3) audio.play('record', { volume: 0.22, rate: 1 + Math.min(this.combo, 6) * 0.05 });
      this.recentTricks = hit.map((t) => t.name);
      bus.emit('tricks:landed', { tricks: hit, mult, combo: this.combo });
      const player = this.game.get('player');
      const pos = player ? player.eyePosition.clone().add(new THREE.Vector3(0, 0.6, 0)) : null;
      for (let i = 0; i < hit.length; i++) {
        setTimeout(() => {
          bus.emit('fx:floatText', {
            position: pos, text: hit[i].name, color: '#ffc22e', size: 22,
          });
        }, i * 130);
      }
    }
    return { tricks: hit, mult, combo: this.combo };
  }

  update(dt) {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 0;
        this.styleMult = 1;
        this.recentTricks = [];
      }
    }
    const hud = this.game.get('hud');
    if (hud) {
      hud.setStyle(this.combo > 0 ? this.styleMult : 0, this.recentTricks.slice(0, 2).join(' + '),
        this.comboTimer / this.comboWindow);
    }
  }

  hintsFor() {
    return TRICKS.filter((t) => t.tip && !this.discovered.has(t.id)).slice(0, 3);
  }

  save() { return { discovered: [...this.discovered], bestCombo: this.bestCombo, totalTricks: this.totalTricks }; }
  load(d) {
    if (!d) return;
    this.discovered = new Set(d.discovered || []);
    this.bestCombo = d.bestCombo || 0;
    this.totalTricks = d.totalTricks || 0;
  }
}

function dedupeFamily(list, ids) {
  const found = ids.map((id) => list.findIndex((t) => t.id === id)).filter((i) => i >= 0);
  if (found.length < 2) return;
  // Keep the last (strongest) member of the family.
  const keep = found[found.length - 1];
  for (let i = found.length - 2; i >= 0; i--) list.splice(found[i], 1);
}
