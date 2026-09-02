import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { CG, groups } from '../physics/PhysicsWorld.js';
import { clamp, clamp01, lerp, damp, formatWeight, formatMoneyExact, rrange } from '../util/math.js';
import { RARITY } from '../data/fishData.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/**
 * Raycast interaction: [E] prompts, physics grabbing/throwing and the
 * physical sell-bin flow.
 */
export class Interaction {
  constructor(game) {
    this.game = game;
    this.name = 'interaction';
    this.order = 65;
    this.range = 3.4;
    this.hovered = null;
    this.held = null;           // physical fish or prop currently carried
    this.holdDistance = 1.5;
    this.throwCharge = 0;
    this._sellFlash = 0;
  }

  async init(game) {
    bus.on('interaction:register', (i) => game.get('world')?.interactables.push(i));
    return this;
  }

  update(dt, game) {
    const player = game.get('player');
    const input = game.input;
    const hud = game.get('hud');
    if (!player || !hud) return;
    if (input.uiCapture) { hud.setInteract(null); return; }

    // ---- carrying ----
    if (this.held) { this.updateCarry(dt, game, player, input, hud); return; }

    const eye = player.eyePosition.clone();
    const dir = player.forward(_v).clone();

    // 1) World interactables (shop, sell, hire...) by proximity + facing.
    const world = game.get('world');
    let best = null, bestScore = -1;
    if (world) {
      for (const it of world.interactables) {
        const d = eye.distanceTo(it.position);
        if (d > (it.radius ?? 3)) continue;
        _v2.copy(it.position).sub(eye).normalize();
        const facing = _v2.dot(dir);
        if (facing < 0.25) continue;
        const score = facing * 2 - d * 0.1;
        if (score > bestScore) { bestScore = score; best = { kind: 'world', target: it, distance: d }; }
      }
    }

    // 2) Physics ray for pickup-ables.
    const hit = game.physics.raycast(eye, dir, this.range, undefined, player.collider);
    if (hit?.entry) {
      const e = hit.entry;
      if (e.tag === 'fish') {
        const inst = e.userData?.instance;
        best = { kind: 'fish', entry: e, distance: hit.distance, label: `Pick Up ${inst?.name || 'Fish'}` };
      } else if (e.userData?.pickup) {
        best = { kind: 'prop', entry: e, distance: hit.distance, label: e.userData.label || 'Pick Up' };
      } else if (e.userData?.interact) {
        best = { kind: 'custom', entry: e, distance: hit.distance, label: e.userData.label || 'Use' };
      }
    }

    // ---- fish traps and repairable build pieces ----
    // Checked before the generic hover so a trap you are standing over always
    // wins against a distant world interactable behind it.
    const traps = game.get('traps');
    const trap = traps?.nearest(player.position, 3.5);
    if (trap && !best) {
      const held = traps.catchesFor(trap).length;
      hud.setInteract(`Check ${trap.def.name}${held ? ` — ${held} fish` : ' — empty'}  ·  [F] retrieve`, 'E');
      hud.setCrosshair('interact');
      if (input.justPressed('KeyE')) traps.collect(trap);
      if (input.justPressed('KeyF')) traps.retrieve(trap);
      this.hovered = null;
      return;
    }

    const build = game.get('build');
    if (build && !build.mode && !best) {
      const piece = build.targetPiece(player, 4);
      if (piece && piece.health < piece.maxHealth) {
        const pct = Math.round((piece.health / piece.maxHealth) * 100);
        hud.setInteract(`${piece.def.name}  ${Math.round(piece.health)}/${piece.maxHealth} HP  ·  Repair (3 wood)`, 'E');
        hud.setCrosshair('interact');
        if (input.justPressed('KeyE')) build.repair(piece, 3);
        this.hovered = null;
        return;
      }
    }

    this.hovered = best;
    if (best) {
      const label = best.kind === 'world' ? best.target.label : best.label;
      hud.setInteract(label, best.kind === 'world' ? (best.target.key || 'E') : 'E');
      hud.setCrosshair('interact');
      if (input.justPressed('KeyE')) this.activate(best, game, player);
    } else {
      hud.setInteract(null);
      hud.setCrosshair('');
    }
  }

  activate(target, game, player) {
    game.audio.play('ui_click', { volume: 0.4 });
    if (target.kind === 'world') {
      const it = target.target;
      bus.emit(`interact:${it.kind}`, { ...it.data, interactable: it, player });
      return;
    }
    if (target.kind === 'fish' || target.kind === 'prop') {
      this.grab(target.entry, game);
      return;
    }
    if (target.kind === 'custom') {
      bus.emit('interact:custom', { entry: target.entry, player });
    }
  }

  grab(entry, game) {
    const mgr = game.get('physfish');
    const pf = mgr?.list.find((p) => p.entry === entry);
    this.held = { entry, pf, mass: entry.body.mass() };
    if (pf) { pf.held = true; pf.toBucket = false; pf.autoStore = false; }
    // Reach down and rip it up.
    bus.emit('held:grab', { pf, alive: !!pf?.alive });
    entry.body.setGravityScale(0, true);
    entry.body.setLinearDamping(6);
    entry.body.setAngularDamping(6);
    game.audio.play('pickup', { volume: 0.5 });
    const inst = entry.userData?.instance;
    if (inst) {
      const rarity = RARITY[inst.rarity] || RARITY.common;
      bus.emit('toast', {
        text: `<b style="color:${rarity.color}">${inst.name}</b> — ${formatWeight(inst.weight)}`,
        kind: '', duration: 2200,
      });
    }
    // Heavy fish slow you down — comedic but also a real cost.
    const player = game.get('player');
    if (player && this.held.mass > 12) {
      player.walkSpeed = Math.max(1.6, 4.6 - this.held.mass * 0.035);
      player.sprintSpeed = Math.max(2.2, 7.6 - this.held.mass * 0.055);
    }
  }

  release(throwPower = 0) {
    const game = this.game;
    const h = this.held;
    if (!h) return;
    const player = game.get('player');
    h.entry.body.setGravityScale(1, true);
    h.entry.body.setLinearDamping(0.28);
    h.entry.body.setAngularDamping(0.5);
    if (h.pf) h.pf.held = false;
    if (throwPower > 0.02) {
      player.forward(_v);
      const speed = lerp(4, 15, throwPower) / Math.max(1, Math.pow(h.mass, 0.35));
      _v.multiplyScalar(speed);
      _v.y += lerp(1, 4, throwPower);
      _v.add(player.velocity);
      h.entry.body.setLinvel({ x: _v.x, y: _v.y, z: _v.z }, true);
      h.entry.body.setAngvel({ x: rrange(-6, 6), y: rrange(-8, 8), z: rrange(-6, 6) }, true);
      game.audio.play('cast_whoosh', { volume: 0.35 + throwPower * 0.4, rate: 1.3 });
    } else {
      h.entry.body.setLinvel({ x: player.velocity.x * 0.4, y: 0, z: player.velocity.z * 0.4 }, true);
      game.audio.play('drop', { volume: 0.4 });
    }
    if (player) { player.walkSpeed = 4.6; player.sprintSpeed = 7.6; }
    this.held = null;
    this.throwCharge = 0;
    game.get('hud')?.setCastPower(null);
  }

  updateCarry(dt, game, player, input, hud) {
    const h = this.held;
    if (!h || h.entry.removed) { this.held = null; return; }

    player.forward(_v);
    let target;
    if (h.pf) {
      // A fish is carried in the left hand: close, low and to the left, so
      // the viewmodel hand and the physics body agree about where it is.
      const d = clamp(0.58 + Math.pow(h.mass, 0.3) * 0.07, 0.58, 0.95);
      target = _v2.copy(player.eyePosition).addScaledVector(_v, d)
        .add(_v3.set(-_v.z, 0, _v.x).multiplyScalar(-0.17))
        .add(_v3.set(0, -0.30, 0));
      if (h.placing) {
        // Lowering it into the bucket: the hand carries it to the rim.
        h.placing.t += dt;
        const k = clamp01(h.placing.t / h.placing.dur);
        const ease = k * k * (3 - 2 * k);
        const b = h.placing.bucket.placed;
        target.lerp(_v3.set(b.x, b.y + 0.36, b.z), ease);
        if (k >= 1) { this._finishPlace(game, player); return; }
      }
    } else {
      const targetDist = clamp(this.holdDistance + Math.pow(h.mass, 0.3) * 0.16, 1.2, 3.2);
      target = _v2.copy(player.eyePosition).addScaledVector(_v, targetDist).add(_v3.set(0, -0.25, 0));
    }
    // A live fish fights the hand holding it.
    if (h.pf?.alive) {
      const t = game.time;
      target.x += Math.sin(t * 23) * 0.05;
      target.y += Math.sin(t * 31 + 1) * 0.045;
      target.z += Math.sin(t * 19 + 2) * 0.04;
    }
    const cur = game.physics.getPosition(h.entry, _v3);
    // Spring toward the carry point; heavy things lag and swing.
    const stiffness = clamp(90 / Math.max(1, Math.pow(h.mass, 0.55)), 6, 90);
    const delta = target.sub(cur);
    const maxSpeed = clamp(26 / Math.max(1, Math.pow(h.mass, 0.4)), 2.5, 26);
    delta.multiplyScalar(stiffness);
    delta.clampLength(0, maxSpeed);
    h.entry.body.setLinvel({ x: delta.x, y: delta.y, z: delta.z }, true);

    // Charge a throw with RMB, drop with G / release LMB.
    if (input.mouseDown(1)) {
      this.throwCharge = clamp01(this.throwCharge + dt * 1.6);
      hud.setCastPower(this.throwCharge);
      hud.setInteract('Release to throw', 'RMB');
    } else if (this.throwCharge > 0.02) {
      this.release(this.throwCharge);
      return;
    } else {
      hud.setInteract(this._carryPrompt(game, h), h.pf ? 'E' : 'G');
    }
    if (input.justPressed('KeyG')) { this.release(0); return; }
    if (h.placing) return;                             // hands busy lowering it in

    // E with a fish: into the bucket. With the bucket set down that means a
    // throw, and only a dead fish goes in -- kill it with the axe first.
    if (input.justPressed('KeyE') && h.pf) {
      const bucket = game.get('bucket');
      if (bucket?.placed) {
        if (h.pf.alive) {
          bus.emit('toast', { text: 'Still alive — swing your axe at it first', kind: 'error', duration: 2400 });
          game.audio.play('ui_hover', { volume: 0.3, rate: 0.7 });
          return;
        }
        const d = bucket.distanceTo(player.position.x, player.position.z);
        if (d > 1.9) {
          bus.emit('toast', { text: 'Walk up to the bucket', kind: '', duration: 1800 });
          return;
        }
        if (!h.placing) {
          h.placing = { t: 0, dur: 0.8, bucket };
          bus.emit('held:place', { pf: h.pf });
          game.audio.play('ui_hover', { volume: 0.25, rate: 1.4 });
        }
        return;
      }
      const inv = game.get('inventory');
      if (inv?.storeFish(h.pf.instance, { styleMult: h.pf.styleMult || 1 })) {
        game.audio.play('pickup', { volume: 0.6, rate: 1.2 });
        bus.emit('fx:sparkle', { position: game.physics.getPosition(h.entry).clone(), count: 8, color: '#5ddb6a' });
        const pf = h.pf;
        this.held = null;
        player.walkSpeed = 4.6; player.sprintSpeed = 7.6;
        hud.setCastPower(null);
        game.get('physfish').despawn(pf);
        return;
      }
    }

    // Auto-sell when carried into a sell zone.
    this.checkSellZones(game, cur, h);
  }

  /** What the E key will do with what you are carrying, in the prompt. */
  _carryPrompt(game, h) {
    if (!h.pf) return 'Drop  ·  Hold RMB to throw';
    const bucket = game.get('bucket');
    if (!bucket?.placed) return 'Store  ·  G drop  ·  Hold RMB to throw';
    if (h.pf.alive) return 'Kill it — axe (2), swing down on it  ·  G drop';
    if (h.placing) return 'Putting it in…';
    const player = game.get('player');
    return bucket.distanceTo(player.position.x, player.position.z) > 1.9
      ? 'Walk up to the bucket  ·  G drop'
      : 'Put it in the bucket  ·  G drop';
  }

  /** The hand has reached the rim: the fish goes in. */
  _finishPlace(game, player) {
    const h = this.held;
    if (!h?.pf) return;
    const inv = game.get('inventory');
    const pos = game.physics.getPosition(h.entry, _v).clone();
    if (inv?.storeFish(h.pf.instance, { styleMult: h.pf.styleMult || 1 })) {
      game.audio.play('fish_into_bucket', { volume: 0.8, position: pos.clone() });
      bus.emit('fx:sparkle', { position: pos, count: 10, color: '#5ddb6a' });
      bus.emit('bucket:stowed', { instance: h.pf.instance });
      const pf = h.pf;
      this.held = null;
      if (player) { player.walkSpeed = 4.6; player.sprintSpeed = 7.6; }
      game.get('hud')?.setCastPower(null);
      game.get('physfish').despawn(pf);
    } else {
      h.placing = null;
      bus.emit('toast', { text: 'Bucket is full.', kind: 'error', duration: 2600 });
    }
  }

  /**
   * Lob the carried fish at the bucket. A flat-time ballistic solve: pick a
   * flight time, work out the launch velocity that lands on the rim, let
   * physics do the arc. The fish tags itself so PhysicalFish knows to count
   * it when it arrives.
   */
  throwInto(bucket, game, player) {
    const h = this.held;
    if (!h?.pf) return;
    const from = game.physics.getPosition(h.entry, _v).clone();
    const b = bucket.placed;
    const T = 0.62;
    const vx = (b.x - from.x) / T;
    const vz = (b.z - from.z) / T;
    const vy = ((b.y + 0.42) - from.y + 0.5 * 9.8 * T * T) / T;
    h.entry.body.setGravityScale(1, true);
    h.entry.body.setLinearDamping(0.05);
    h.entry.body.setAngularDamping(0.5);
    h.entry.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    h.entry.body.setAngvel({ x: rrange(-4, 4), y: rrange(-6, 6), z: rrange(-4, 4) }, true);
    h.pf.held = false;
    h.pf.toBucket = true;
    h.pf.throwT = 0;
    game.audio.play('cast_whoosh', { volume: 0.45, rate: 1.4 });
    bus.emit('held:throw', { pf: h.pf });
    if (player) { player.walkSpeed = 4.6; player.sprintSpeed = 7.6; }
    this.held = null;
    this.throwCharge = 0;
    game.get('hud')?.setCastPower(null);
  }

  checkSellZones(game, position, held) {
    const world = game.get('world');
    if (!world || !held?.pf) return;
    for (const z of world.sellZones) {
      if (position.distanceTo(z.position) < z.radius) {
        this.sellPhysical(held.pf, game);
        this.held = null;
        const player = game.get('player');
        if (player) { player.walkSpeed = 4.6; player.sprintSpeed = 7.6; }
        game.get('hud')?.setCastPower(null);
        return;
      }
    }
  }

  sellPhysical(pf, game) {
    const eco = game.get('economy');
    if (!eco) return;
    const base = eco.priceFor(pf.instance);
    const styleMult = pf.styleMult || 1;
    const total = Math.round(base * styleMult);
    eco.add(total, 'fish_sales');
    eco.recordSale(pf.instance, total, 'player');
    const pos = game.physics.getPosition(pf.entry).clone();
    game.get('physfish').despawn(pf);
    bus.emit('sell:physical', { instance: pf.instance, price: total, styleMult, position: pos });
    bus.emit('fx:moneyBurst', { position: pos, amount: total });
    game.audio.play('cash_register', { volume: 0.7 });
    const rarity = RARITY[pf.instance.rarity] || RARITY.common;
    bus.emit('fx:floatText', { position: pos, text: `+${formatMoneyExact(total)}`, color: '#ffc22e', size: 26 });
    bus.emit('catch:popup', {
      name: pf.instance.name, rarity: rarity.name, rarityColor: rarity.color,
      weight: pf.instance.weight, length: pf.instance.length, value: total,
      badges: styleMult > 1.05 ? [`Style x${styleMult.toFixed(1)}`] : [],
    });
  }

  lateUpdate(dt, game) {
    // Physical fish that land in a sell bin sell themselves — a real trick shot.
    const world = game.get('world');
    const mgr = game.get('physfish');
    if (!world || !mgr || !world.sellZones.length) return;
    for (let i = mgr.list.length - 1; i >= 0; i--) {
      const pf = mgr.list[i];
      if (pf.held || pf.sold) continue;
      const p = game.physics.getPosition(pf.entry, _v);
      for (const z of world.sellZones) {
        if (p.distanceTo(z.position) < z.radius) {
          pf.sold = true;
          const tricks = game.get('tricks');
          const res = tricks?.evaluateCatch({ instance: pf.instance, method: 'throw', intoSellBin: true });
          pf.styleMult = Math.max(pf.styleMult || 1, res?.mult || 1);
          this.sellPhysical(pf, game);
          break;
        }
      }
    }
  }
}
