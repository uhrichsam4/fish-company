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
    if (pf) {
      pf.held = true; pf.autoStore = false;
      // A fish is carried as a copy in the viewmodel hand (HeldItems). The
      // body is parked out of the way and the world mesh hidden until it is
      // put down: at hand distance the body sits inside the player's own
      // collider and gets shoved back out every frame.
      const at = game.physics.getPosition(entry, _v);
      pf.parkedAt = { x: at.x, y: at.y, z: at.z };
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setTranslation({ x: at.x, y: at.y - 40, z: at.z }, true);
      pf.group.visible = false;
    }
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
    if (h.pf) this._unparkFish(h, game, player);
    h.entry.body.setGravityScale(1, true);
    h.entry.body.setLinearDamping(0.28);
    h.entry.body.setAngularDamping(0.5);
    if (h.pf) h.pf.held = false;
    bus.emit('held:release', {});
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
    let cur;
    if (h.pf) {
      // The fish lives in the viewmodel hand while carried; nothing to spring.
      cur = _v3.copy(player.position);
    } else {
      const targetDist = clamp(this.holdDistance + Math.pow(h.mass, 0.3) * 0.16, 1.2, 3.2);
      const target = _v2.copy(player.eyePosition).addScaledVector(_v, targetDist).add(_v3.set(0, -0.25, 0));
      cur = game.physics.getPosition(h.entry, _v3);
      // Spring toward the carry point; heavy things lag and swing.
      const stiffness = clamp(90 / Math.max(1, Math.pow(h.mass, 0.55)), 6, 90);
      const delta = target.sub(cur);
      const maxSpeed = clamp(26 / Math.max(1, Math.pow(h.mass, 0.4)), 2.5, 26);
      delta.multiplyScalar(stiffness);
      delta.clampLength(0, maxSpeed);
      h.entry.body.setLinvel({ x: delta.x, y: delta.y, z: delta.z }, true);
    }

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

    // E with a fish: straight into the inventory.
    if (input.justPressed('KeyE') && h.pf) {
      const inv = game.get('inventory');
      if (inv?.storeFish(h.pf.instance, { styleMult: h.pf.styleMult || 1 })) {
        game.audio.play('pickup', { volume: 0.6, rate: 1.2 });
        bus.emit('fx:sparkle', { position: player.eyePosition.clone(), count: 8, color: '#5ddb6a' });
        const pf = h.pf;
        pf.group.visible = true;
        this.held = null;
        player.walkSpeed = 4.6; player.sprintSpeed = 7.6;
        hud.setCastPower(null);
        game.get('physfish').despawn(pf);
        bus.emit('held:release', {});
        return;
      }
    }

    // Auto-sell when carried into a sell zone (the fish is wherever you are).
    this.checkSellZones(game, h.pf ? player.position : cur, h);
  }

  /** What the E key will do with what you are carrying, in the prompt. */
  _carryPrompt(game, h) {
    if (!h.pf) return 'Drop  ·  Hold RMB to throw';
    return 'Store  ·  G drop  ·  Hold RMB to throw';
  }

  /** Put the parked body back where the hand is, visible again. */
  _unparkFish(h, game, player) {
    const hand = game.get('held')?.leftHandWorld;
    const at = hand ? _v.copy(hand) : _v.copy(player.eyePosition).addScaledVector(player.forward(_v2), 0.8);
    h.entry.body.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
    h.entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    h.pf.group.visible = true;
    h.pf.parkedAt = null;
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
