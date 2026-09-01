import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { FishingLine } from './FishingLine.js';
import { FISH_STATE } from '../fish/FishSystem.js';
import { RARITY, VARIANT_BY_ID, getSpecies } from '../data/fishData.js';
import { CG, groups } from '../physics/PhysicsWorld.js';
import { waterHeightAt, waterNormalAt, waterVelocityAt } from '../world/waves.js';
import { worldHeight } from '../world/Terrain.js';
import {
  clamp, clamp01, lerp, damp, smoothstep, rrange, rchance, rpick, formatWeight, formatMoneyExact,
} from '../util/math.js';

export const CAST_STATE = {
  IDLE: 'idle', CHARGING: 'charging', FLYING: 'flying', IN_WATER: 'inwater',
  NIBBLE: 'nibble', HOOKED: 'hooked', LANDING: 'landing', SNAPPED: 'snapped', REELING_EMPTY: 'reeling',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

/**
 * The core mechanic: charge, cast, wait, hook, fight, land.
 * Owns the hook/bobber simulation, the line, the fight solver and all the
 * feedback (rod bend, tension audio, camera pull, splash cues).
 */
export class FishingSystem {
  constructor(game) {
    this.game = game;
    this.name = 'fishing';
    this.order = 50;

    this.state = CAST_STATE.IDLE;
    this.stateTime = 0;
    this.equipped = false;

    // hook / bobber
    this.hook = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), inWater: false, depth: 0, sinking: 0, restingOnBed: false };
    this.activeBait = null;
    this.castPower = 0;
    this.castCharge = 0;
    this.castOrigin = new THREE.Vector3();
    this.castDistance = 0;
    this.castStartPos = new THREE.Vector3();
    this.castApex = 0;
    this.castBounces = 0;
    this.castSpin = 0;
    this.castFromBoat = false;
    this.castWasAirborne = false;

    // fight
    this.hookedFish = null;
    this.fishStamina = 1;
    this.tension = 0;
    this.lineOut = 0;
    this.reeling = false;
    this.fightTime = 0;
    this.fightPhase = 'run';
    this.phaseTimer = 0;
    this.jumpCooldown = 2;
    this.hookSetWindow = 0;
    this.nibbleFish = null;

    // presentation
    this.rodBend = 0;
    this.rodTip = new THREE.Vector3();
    this.line = null;
    this.bobber = null;
    this._reelLoop = null;
    this._tensionLoop = null;
    this._reelClickAccum = 0;
    this.lastCatch = null;
    this.autoReelHold = 0;
  }

  async init(game) {
    this.line = new FishingLine(game.scene, { count: 16 });

    // bobber: a little float with a bright top so it reads at distance
    const bg = new THREE.Group();
    const top = new THREE.Mesh(
      new THREE.SphereGeometry(0.062, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.4, emissive: 0x330000, emissiveIntensity: 0.4 }),
    );
    const bot = new THREE.Mesh(
      new THREE.SphereGeometry(0.062, 10, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.5 }),
    );
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.14, 5),
      new THREE.MeshStandardMaterial({ color: 0x30363c }),
    );
    stick.position.y = 0.1;
    bg.add(top, bot, stick);
    bg.visible = false;
    game.scene.add(bg);
    this.bobber = bg;

    bus.on('equipment:changed', ({ slot }) => { if (slot === 'rod' || slot === 'line') this.cancel(); });
    bus.on('fish:nibble', ({ fish, bait }) => { if (bait === this.activeBait) this.onNibble(fish); });
    bus.on('fish:nibbleEnd', ({ fish }) => { if (fish === this.nibbleFish) this.onNibbleEnd(); });
    bus.on('hotbar:changed', () => this.onHotbarChanged());
    return this;
  }

  onHotbarChanged() {
    const inv = this.game.get('inventory');
    const active = inv?.activeKind === 'rod';
    if (!active && this.state !== CAST_STATE.IDLE) this.cancel();
    this.equipped = active;
  }

  get stats() { return this.game.get('inventory')?.fishingStats() || {}; }

  // -------------------------------------------------------------- input
  update(dt, game) {
    if (dt <= 0) return;
    this.stateTime += dt;
    const inv = game.get('inventory');
    const player = game.get('player');
    if (!inv || !player) return;

    this.equipped = inv.activeKind === 'rod';
    const input = game.input;
    const canAct = this.equipped && player.canMove && !input.uiCapture;

    // Rod tip position: in front of and slightly right of the eye.
    const held = game.get('held');
    if (!(held && held.getRodTipWorld?.(this.rodTip))) {
      player.forward(_v);
      player.right(_v2);
      this.rodTip.copy(player.eyePosition).addScaledVector(_v, 1.15).addScaledVector(_v2, 0.34).add(_v3.set(0, 0.16, 0));
    }

    switch (this.state) {
      case CAST_STATE.IDLE: this.updateIdle(dt, canAct, input); break;
      case CAST_STATE.CHARGING: this.updateCharging(dt, canAct, input, player); break;
      case CAST_STATE.FLYING: this.updateFlying(dt, game); break;
      case CAST_STATE.IN_WATER:
      case CAST_STATE.NIBBLE: this.updateInWater(dt, game, canAct, input); break;
      case CAST_STATE.HOOKED: this.updateFight(dt, game, canAct, input, player); break;
      case CAST_STATE.LANDING: this.updateLanding(dt, game); break;
      case CAST_STATE.SNAPPED:
      case CAST_STATE.REELING_EMPTY: this.updateRetract(dt, game); break;
    }

    this.updatePresentation(dt, game);
  }

  updateIdle(dt, canAct, input) {
    this.line.setVisible(false);
    this.bobber.visible = false;
    this.activeBait = null;
    if (canAct && input.mousePressed(0)) {
      this.state = CAST_STATE.CHARGING;
      this.stateTime = 0;
      this.castCharge = 0;
      this.game.audio.play('cast_charge', { volume: 0.3 });
      bus.emit('fishing:charging');
    }
  }

  updateCharging(dt, canAct, input, player) {
    if (!canAct) { this.state = CAST_STATE.IDLE; return; }
    this.castCharge = clamp01(this.castCharge + dt * 1.35);
    this.game.get('hud')?.setCastPower(this.castCharge);
    // Track spin for the 360 trick bonus.
    if (this._lastYaw == null) this._lastYaw = player.yaw;
    let dy = player.yaw - this._lastYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.castSpin += dy;
    this._lastYaw = player.yaw;

    if (!input.mouseDown(0) || this.castCharge >= 1) {
      this.release(player);
    }
  }

  release(player) {
    const s = this.stats;
    const inv = this.game.get('inventory');
    this.game.get('hud')?.setCastPower(null);
    this.castPower = lerp(0.28, 1, this.castCharge);
    const speed = s.castPower * this.castPower;

    player.forward(_v);
    // Aim slightly above the crosshair so a full-power cast arcs nicely.
    const lift = lerp(0.06, 0.30, this.castCharge);
    _v.y += lift;
    _v.normalize();

    this.hook.position.copy(this.rodTip);
    this.hook.velocity.copy(_v).multiplyScalar(speed);
    // Casting from a moving platform inherits its velocity.
    if (player.ridingBody) {
      const bv = this.game.physics.getVelocity(player.ridingBody, _v4);
      this.hook.velocity.add(bv);
      this.castFromBoat = true;
    } else this.castFromBoat = false;
    this.hook.inWater = false;
    this.hook.sinking = 0;
    this.hook.restingOnBed = false;
    this.castStartPos.copy(this.rodTip);
    this.castApex = this.rodTip.y;
    this.castBounces = 0;
    this.castWasAirborne = !player.grounded;
    this.castDistance = 0;
    this.state = CAST_STATE.FLYING;
    this.stateTime = 0;
    this.line.reset(this.rodTip, this.hook.position);
    this.line.setVisible(true);
    this.bobber.visible = true;

    this.game.audio.stopLoop('cast_charge', 0.05);
    this.game.audio.play('cast_whoosh', { volume: 0.4 + this.castCharge * 0.45, rate: rrange(0.92, 1.1) });
    bus.emit('fishing:cast', { power: this.castCharge, speed });
    this._lastYaw = null;
  }

  updateFlying(dt, game) {
    const h = this.hook;
    const s = this.stats;
    const prev = _v4.copy(h.position);
    h.velocity.y -= 19 * dt;
    // Light air drag so max range is bounded and feels weighty.
    h.velocity.multiplyScalar(1 - 0.42 * dt);
    h.position.addScaledVector(h.velocity, dt);
    if (h.position.y > this.castApex) this.castApex = h.position.y;

    // Line length limit — the cast snaps taut at max range.
    const maxLen = s.lineLength || 30;
    const dist = h.position.distanceTo(this.rodTip);
    if (dist > maxLen) {
      _v.copy(h.position).sub(this.rodTip).normalize().multiplyScalar(maxLen);
      h.position.copy(this.rodTip).add(_v);
      h.velocity.multiplyScalar(0.18);
      game.audio.play('line_tension', { volume: 0.3, duration: 0.3 });
    }

    // Collide against the world along the travel segment.
    _v.copy(h.position).sub(prev);
    const step = _v.length();
    if (step > 0.001) {
      const hit = game.physics.raycast(prev, _v2.copy(_v).normalize(), step + 0.12,
        groups(CG.HOOK, CG.TERRAIN | CG.PROP | CG.BOAT));
      if (hit) {
        this.castBounces++;
        h.position.copy(hit.point).addScaledVector(hit.normal, 0.06);
        // Reflect with damping — bounce shots are a real trick.
        const vn = h.velocity.dot(hit.normal);
        h.velocity.addScaledVector(hit.normal, -2 * vn).multiplyScalar(0.42);
        game.audio.play('harpoon_impact', { volume: 0.28, position: hit.point.clone(), throttle: 80 });
        bus.emit('fx:impact', { position: hit.point.clone(), normal: hit.normal.clone(), kind: 'stone' });
        if (this.castBounces > 4 || h.velocity.lengthSq() < 0.6) {
          this.state = CAST_STATE.REELING_EMPTY;
          this.stateTime = 0;
        }
      }
    }

    // Water entry.
    const waterY = waterHeightAt(h.position.x, h.position.z);
    const bed = worldHeight(h.position.x, h.position.z);
    if (h.position.y <= waterY && bed < waterY - 0.35) {
      this.enterWater(waterY, game);
      return;
    }
    // Landed on dry ground.
    if (h.position.y <= bed + 0.05) {
      h.position.y = bed + 0.05;
      h.velocity.set(0, 0, 0);
      this.state = CAST_STATE.REELING_EMPTY;
      this.stateTime = 0;
      bus.emit('fx:dustPuff', { position: h.position.clone(), scale: 0.4 });
    }
    if (this.stateTime > 9) { this.state = CAST_STATE.REELING_EMPTY; this.stateTime = 0; }
  }

  enterWater(waterY, game) {
    const h = this.hook;
    const impactSpeed = h.velocity.length();
    h.position.y = waterY;
    h.velocity.multiplyScalar(0.12);
    h.inWater = true;
    h.sinking = 0;
    this.castDistance = _v.set(h.position.x - this.castStartPos.x, 0, h.position.z - this.castStartPos.z).length();
    this.state = CAST_STATE.IN_WATER;
    this.stateTime = 0;

    const s = this.stats;
    const inv = game.get('inventory');
    this.activeBait = {
      position: h.position,
      inWater: true,
      attractMult: s.attract * (s.lureRange || 1),
      rareBonus: s.rareBonus,
      bigBonus: s.bigBonus,
      deepBonus: s.deepBonus,
      danger: s.danger,
      castDistance: this.castDistance,
    };

    const vol = clamp(0.25 + impactSpeed * 0.035, 0.25, 0.95);
    game.audio.play(impactSpeed > 16 ? 'splash_medium' : 'splash_small', {
      volume: vol, position: h.position.clone(), rate: rrange(0.9, 1.12),
    });
    bus.emit('fx:splash', { position: h.position.clone(), scale: clamp(0.35 + impactSpeed * 0.03, 0.3, 1.3) });
    bus.emit('ocean:ripple', { x: h.position.x, z: h.position.z, strength: clamp01(impactSpeed / 22) });
    // A hard cast scares nearby fish briefly.
    if (impactSpeed > 18) bus.emit('fish:scare', { position: h.position.clone(), radius: 5, strength: 0.5 });

    const eco = game.get('economy');
    if (eco && this.castDistance > (eco.stats.longestCast || 0)) eco.stats.longestCast = this.castDistance;
    bus.emit('fishing:landedInWater', { distance: this.castDistance, apex: this.castApex, bounces: this.castBounces });
    bus.emit('quest:flag', { flag: 'cast_in_water' });
  }

  updateInWater(dt, game, canAct, input) {
    const h = this.hook;
    const s = this.stats;
    const waterY = waterHeightAt(h.position.x, h.position.z);
    const bed = worldHeight(h.position.x, h.position.z);

    // Sink slowly to the bait's working depth, then bob with the surface.
    const targetDepth = clamp(lerp(0.35, 3.2, s.deepBonus > 1 ? 0.9 : 0.45), 0.2, Math.max(0.25, waterY - bed - 0.25));
    h.sinking = damp(h.sinking, targetDepth, 0.12, dt);
    h.position.y = waterY - h.sinking;
    h.depth = h.sinking;

    // Drift with the wave orbital velocity.
    const wv = waterVelocityAt(h.position.x, h.position.z, undefined, _v);
    h.position.x += wv.x * dt * 0.35;
    h.position.z += wv.z * dt * 0.35;

    if (this.activeBait) this.activeBait.position = h.position;

    // Reeling in without a bite.
    this.reeling = canAct && input.mouseDown(0);
    if (this.reeling) this.reelIn(dt, game, s.reelSpeed * 3.4);
    if (canAct && input.mousePressed(1)) { this.cancel(); return; }

    // Line snaps taut if the player walks away.
    const dist = h.position.distanceTo(this.rodTip);
    if (dist > (s.lineLength || 30) * 1.08) {
      this.reelIn(dt, game, 6);
    }
    if (dist < 1.4) { this.finishRetract(game); return; }

    // Nibble: FishSystem sets state, we get the event.
    if (this.state === CAST_STATE.NIBBLE) {
      this.hookSetWindow -= dt;
      game.get('hud')?.setHookWindow(clamp01(this.hookSetWindow / Math.max(0.01, this.hookSetTotal || 1)));
      // Bobber dips and twitches.
      h.position.y -= 0.06 + Math.sin(this.stateTime * 26) * 0.045;
      if (canAct && (input.mousePressed(0) || input.mousePressed(1))) {
        this.attemptHookSet(game);
      } else if (this.hookSetWindow <= 0) {
        this.onNibbleEnd();
      }
    }
  }

  onNibble(fish) {
    if (this.state !== CAST_STATE.IN_WATER) return;
    this.nibbleFish = fish;
    this.state = CAST_STATE.NIBBLE;
    this.stateTime = 0;
    const sp = fish.species;
    const inst = fish.instance;
    // Bigger/rarer fish give a shorter window.
    this.hookSetWindow = lerp(2.2, 0.75, clamp01(sp.speed * 0.6 + sp.escape * 0.4));
    this.hookSetTotal = this.hookSetWindow;

    // The bite is the moment the player has to react to, so telegraph it hard:
    // the bobber plunges, the water bursts, the audio pitch tracks the fish's
    // size, and the view flinches.
    const heavy = clamp01(inst.weight / 30);
    this.game.audio.play('fish_bite', {
      volume: 0.55 + heavy * 0.35, position: this.hook.position.clone(),
      rate: lerp(1.3, 0.62, heavy),
    });
    if (inst.weight > 8) {
      this.game.audio.play('splash_medium', { volume: 0.3 + heavy * 0.4, position: this.hook.position.clone() });
    }
    bus.emit('fx:splash', { position: this.hook.position.clone(), scale: 0.3 + heavy * 0.9 });
    bus.emit('fx:ripple', { position: this.hook.position.clone(), radius: 0.6 + heavy });
    bus.emit('ocean:ripple', { x: this.hook.position.x, z: this.hook.position.z, strength: 0.4 + heavy * 0.5 });
    bus.emit('player:shake', 0.08 + heavy * 0.22);
    // Yank the view a few degrees toward the bite.
    const player = this.game.get('player');
    if (player) {
      _v.copy(this.hook.position).sub(player.eyePosition);
      const yawTo = Math.atan2(-_v.x, -_v.z);
      let d = yawTo - player.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      player.recoil.y += clamp(d, -0.18, 0.18) * (0.25 + heavy * 0.35);
      player.recoil.x -= 0.03 + heavy * 0.05;
    }
    this.bobberDip = 1;
    bus.emit('fishing:nibble', { fish, window: this.hookSetWindow, weight: inst.weight });
  }

  onNibbleEnd() {
    if (this.state !== CAST_STATE.NIBBLE) return;
    this.nibbleFish = null;
    this.state = CAST_STATE.IN_WATER;
    this.stateTime = 0;
    this.game.get('hud')?.setFishing(null);
    this.game.get('hud')?.setHookWindow(null);
  }

  attemptHookSet(game) {
    game.get('hud')?.setHookWindow(null);
    const f = this.nibbleFish;
    if (!f) { this.onNibbleEnd(); return; }
    const s = this.stats;
    const sp = f.species;
    // Timing matters: hooking early in the window is easier.
    const windowFrac = clamp01(this.hookSetWindow / lerp(2.2, 0.75, clamp01(sp.speed * 0.6 + sp.escape * 0.4)));
    const timingBonus = lerp(0.55, 1.15, windowFrac);
    const chance = clamp01(s.hookChance * timingBonus * (1 - sp.escape * 0.3));
    if (Math.random() < chance) {
      this.startFight(f, game);
    } else {
      game.audio.play('splash_small', { volume: 0.4, position: this.hook.position.clone() });
      bus.emit('toast', { text: 'It got away!', kind: 'warn', duration: 1400 });
      f.state = FISH_STATE.FLEE; f.stateTime = 0; f.spooked = 1.5; f.baitRef = null;
      const eco = game.get('economy');
      if (eco) eco.stats.fishLost++;
      this.nibbleFish = null;
      this.state = CAST_STATE.IN_WATER;
    }
  }

  startFight(f, game) {
    this.hookedFish = f;
    f.state = FISH_STATE.HOOKED;
    f.stateTime = 0;
    this.fishStamina = 1;
    this.tension = 0.25;
    this.fightTime = 0;
    this.fightPhase = 'run';
    this.phaseTimer = rrange(0.6, 1.4);
    this.jumpCooldown = 1.2;
    this.state = CAST_STATE.HOOKED;
    this.stateTime = 0;
    this.nibbleFish = null;
    this.lineOut = this.hook.position.distanceTo(this.rodTip);

    const inv = game.get('inventory');
    inv?.consumeBait();

    const inst = f.instance;
    const rarity = RARITY[inst.rarity] || RARITY.common;
    game.audio.play(inst.weight > 30 ? 'fish_thrash' : 'fish_bite', { volume: 0.7, position: f.position.clone() });
    if (inst.variantId !== 'normal' || inst.rarity === 'legendary' || inst.rarity === 'mythic') {
      game.audio.play(inst.rarity === 'mythic' || inst.rarity === 'legendary' ? 'legendary' : 'rare_fish', { volume: 0.7 });
    }
    bus.emit('player:shake', clamp01(inst.weight / 60) * 0.5 + 0.12);
    bus.emit('fx:splash', { position: f.position.clone(), scale: clamp(0.5 + inst.weight * 0.03, 0.5, 2.2) });
    bus.emit('fishing:hooked', { fish: f, instance: inst });
  }

  updateFight(dt, game, canAct, input, player) {
    const f = this.hookedFish;
    if (!f || !f.active) { this.cancel(); return; }
    const s = this.stats;
    const inst = f.instance;
    const sp = f.species;
    this.fightTime += dt;

    // ---- reel input ----
    this.reeling = canAct && input.mouseDown(0);
    if (s.autoReel > 0 && !this.reeling) {
      this.autoReelHold += dt;
      if (this.autoReelHold > 0.6) this.reeling = true;
    } else this.autoReelHold = 0;

    // ---- fish behaviour phases ----
    this.phaseTimer -= dt;
    if (this.phaseTimer <= 0) this.pickFightPhase(sp, inst);

    _v.copy(f.position).sub(this.rodTip);
    this.lineOut = _v.length();
    const dir = _v2.copy(_v).normalize();

    // Base pull scales with weight and strength, tempered by stamina.
    const weightFactor = Math.pow(clamp(inst.weight, 0.05, 40000), 0.62);
    const basePull = weightFactor * lerp(0.55, 2.6, sp.strength) * lerp(0.35, 1, this.fishStamina);
    let pull = basePull;
    let lateral = 0, vertical = 0;

    switch (this.fightPhase) {
      case 'run': pull *= 2.7; break;
      case 'dive': pull *= 1.25; vertical = -1; break;
      case 'surface': pull *= 0.7; vertical = 0.7; break;
      case 'sideways': pull *= 1.1; lateral = Math.sin(this.fightTime * 2.4) * 1.4; break;
      case 'thrash': pull *= 1.35; lateral = Math.sin(this.fightTime * 11) * 1.1; vertical = Math.sin(this.fightTime * 7) * 0.6; break;
      case 'tire': pull *= 0.35; break;
      case 'jump': pull *= 0.5; vertical = 1.6; break;
    }

    // ---- reel force ----
    const rodPower = s.maxWeight;
    const reelForce = this.reeling
      ? lerp(6, 22, clamp01(rodPower / Math.max(1, inst.weight))) * s.reelSpeed
      : 0;

    // ---- tension ----
    const lineStrength = s.lineStrength;
    const rawTension = (pull * 9 + reelForce * 2.2) / Math.max(1, lineStrength);
    const targetTension = clamp01(rawTension);
    // Slack builds slower than tension so releasing gives instant relief.
    this.tension = damp(this.tension, targetTension, targetTension > this.tension ? 0.06 : 0.0015, dt);

    if (this.tension > 0.985) {
      this._overTension = (this._overTension || 0) + dt;
      if (this._overTension > lerp(1.5, 0.35, s.dragControl ? 1 - s.dragControl : 0.5)) { this.snapLine(game); return; }
    } else this._overTension = Math.max(0, (this._overTension || 0) - dt * 1.6);

    // ---- move the fish ----
    const stamDrain = dt * lerp(0.22, 0.05, sp.stamina) * (this.reeling ? 1.9 : 0.7);
    this.fishStamina = clamp01(this.fishStamina - stamDrain + (this.reeling ? 0 : dt * 0.02));

    // Reel rate scales with how outclassed the fish is. Without this a
    // sardine on a heavy rod took ten seconds to travel four metres, which
    // made every fight feel identical and slow.
    const overkill = clamp01(1 - inst.weight / Math.max(0.5, rodPower));
    const reelGain = 0.09 * (1 + 4.2 * overkill * overkill);
    const netPull = (reelForce - pull * 4.2) * dt * reelGain;
    // Positive netPull pulls the fish toward the player.
    _v3.copy(dir).multiplyScalar(-netPull);
    // Lateral + vertical fish motion.
    _v4.set(-dir.z, 0, dir.x).multiplyScalar(lateral * dt * lerp(1.2, 5, sp.speed));
    _v3.add(_v4);
    _v3.y += vertical * dt * lerp(0.8, 3.4, sp.speed);
    f.position.add(_v3);

    const waterY = waterHeightAt(f.position.x, f.position.z);
    const bed = worldHeight(f.position.x, f.position.z);
    // Jumping fish breach the surface.
    if (this.fightPhase === 'jump' && f.position.y > waterY - 0.4) {
      if (!this._jumped) {
        this._jumped = true;
        game.audio.play('splash_big', { volume: 0.75, position: f.position.clone() });
        bus.emit('fx:bigSplash', { position: _v.set(f.position.x, waterY, f.position.z).clone(), scale: clamp(0.8 + inst.weight * 0.02, 0.8, 2.6) });
        bus.emit('player:shake', 0.2);
      }
      f.position.y = Math.min(f.position.y, waterY + lerp(0.3, 2.4, clamp01(sp.speed)));
    } else {
      this._jumped = false;
      // Tired fish near the boat ride the surface rather than hiding at depth.
      const surfaceHold = clamp01((1 - this.fishStamina) * 1.2) * clamp01(1 - this.lineOut / 8);
      const minY = lerp(bed + 0.25, waterY - 0.35, surfaceHold);
      f.position.y = clamp(f.position.y, minY, waterY - 0.1);
      if (surfaceHold > 0.4 && rchance(dt * 6 * surfaceHold)) {
        bus.emit('fx:splash', { position: _v4.set(f.position.x, waterY, f.position.z).clone(), scale: 0.25 + clamp01(inst.weight / 40) * 0.6 });
        game.audio.play('splash_small', { volume: 0.18, position: f.position.clone(), throttle: 180, rate: rrange(0.9, 1.2) });
      }
    }
    // Keep the fish inside the line's reach.
    const maxLen = (s.lineLength || 30) * 1.15;
    if (this.lineOut > maxLen) {
      _v.copy(f.position).sub(this.rodTip).normalize().multiplyScalar(maxLen);
      f.position.copy(this.rodTip).add(_v);
    }
    f.heading.copy(dir).negate().normalize();
    f.velocity.copy(_v3).multiplyScalar(1 / Math.max(dt, 1e-4));

    this.hook.position.copy(f.position).addScaledVector(dir, -inst.length * 0.35);
    this.hook.inWater = f.position.y < waterY;
    if (this.activeBait) this.activeBait.inWater = false;

    // ---- feel: the line pulls the view toward the fish and tugs on runs ----
    if (player) {
      _v.copy(f.position).sub(player.eyePosition);
      const yawTo = Math.atan2(-_v.x, -_v.z);
      let dy = yawTo - player.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const pullK = this.tension * clamp01(inst.weight / Math.max(2, s.maxWeight * 0.5)) * 0.55;
      player.recoil.y += clamp(dy, -1, 1) * pullK * dt * 2.4;
      player.recoil.x += (Math.atan2(f.position.y - player.eyePosition.y, Math.hypot(_v.x, _v.z)) - player.pitch) * pullK * dt * 1.6;
      // Rhythmic tug while the fish is running, so a fight has texture.
      if (this.fightPhase === 'run' || this.fightPhase === 'thrash') {
        const tug = Math.sin(this.fightTime * (this.fightPhase === 'thrash' ? 15 : 7)) * this.tension * 0.02;
        player.recoil.x += tug * dt * 26;
        player.shake = Math.max(player.shake, this.tension * 0.12);
      }
    }

    // ---- huge fish drag the player ----
    if (inst.weight > s.maxWeight * 0.5 && this.tension > 0.6 && player.grounded) {
      const dragK = clamp01((inst.weight / Math.max(1, s.maxWeight)) - 0.5) * this.tension;
      player.velocity.addScaledVector(dir, dragK * 7 * dt);
      if (dragK > 0.5) player.shake = Math.max(player.shake, dragK * 0.25);
    }

    // ---- landing ----
    // Measured horizontally: fishing from a dock or a boat puts the rod tip
    // several metres above the water, so straight-line distance can never
    // reach the threshold no matter how long you reel.
    const landDist = lerp(1.9, 3.6, clamp01(inst.length / 3));
    const horiz = Math.hypot(f.position.x - this.rodTip.x, f.position.z - this.rodTip.z);
    const atSurface = (waterHeightAt(f.position.x, f.position.z) - f.position.y) < 0.9;
    if ((horiz < landDist && atSurface) || this.lineOut < landDist
        || (this.fightTime > 100 && horiz < landDist * 2.2)) {
      this.landFish(game, player);
      return;
    }

    // ---- escape ----
    if (!this.reeling && this.fishStamina > 0.5 && rchance(sp.escape * dt * 0.35)) {
      this.loseFish(game, 'threw the hook');
      return;
    }

    // ---- audio ----
    this.updateFightAudio(game, dt);

    const hud = game.get('hud');
    if (hud) {
      const rarity = RARITY[inst.rarity] || RARITY.common;
      hud.setFishing({
        name: inst.name, weight: inst.weight, tension: this.tension,
        distance: this.lineOut, rarityColor: rarity.color,
      });
    }
  }

  pickFightPhase(sp, inst) {
    const tired = this.fishStamina < 0.35;
    const style = sp.fight || 'runner';
    let options;
    if (tired) options = ['tire', 'tire', 'sideways', 'surface'];
    else {
      switch (style) {
        case 'weak': options = ['tire', 'sideways', 'run']; break;
        case 'jumper': options = ['run', 'jump', 'sideways', 'thrash']; break;
        case 'diver': options = ['dive', 'dive', 'run', 'tire']; break;
        case 'brawler': options = ['thrash', 'sideways', 'run', 'dive']; break;
        case 'thrasher': options = ['thrash', 'thrash', 'run', 'sideways']; break;
        case 'titan': options = ['run', 'dive', 'thrash', 'run', 'tire']; break;
        default: options = ['run', 'sideways', 'dive', 'tire'];
      }
    }
    if (this.jumpCooldown > 0) options = options.filter((o) => o !== 'jump');
    if (!options.length) options = ['run'];
    this.fightPhase = rpick(options);
    this.phaseTimer = this.fightPhase === 'jump' ? rrange(0.5, 0.9) : rrange(0.8, 2.2);
    this.jumpCooldown = Math.max(0, this.jumpCooldown - 1);
    if (this.fightPhase === 'jump') this.jumpCooldown = 3;
  }

  updateFightAudio(game, dt) {
    // reel loop, pitch tracks reel speed
    if (this.reeling) {
      if (!this._reelLoop) this._reelLoop = game.audio.loop('reel_loop', { volume: 0.5 });
      this._reelLoop?.setRate(lerp(0.75, 1.35, 1 - this.tension), 0.08);
      this._reelClickAccum += dt * lerp(14, 26, 1 - this.tension);
      while (this._reelClickAccum > 1) {
        this._reelClickAccum -= 1;
        game.audio.play('reel_click', { volume: 0.11, rate: rrange(0.9, 1.15) });
      }
    } else if (this._reelLoop) { this._reelLoop.stop(0.12); this._reelLoop = null; }

    // tension creak
    if (this.tension > 0.5) {
      if (!this._tensionLoop) this._tensionLoop = game.audio.loop('line_tension', { volume: 0.2 });
      this._tensionLoop?.setVolume(clamp01((this.tension - 0.5) / 0.5) * 0.9, 0.1);
      this._tensionLoop?.setRate(lerp(0.85, 1.5, this.tension), 0.1);
    } else if (this._tensionLoop) { this._tensionLoop.stop(0.2); this._tensionLoop = null; }
  }

  landFish(game, player) {
    const f = this.hookedFish;
    if (!f) return;
    const inst = f.instance;
    const eco = game.get('economy');
    const inv = game.get('inventory');
    const tricks = game.get('tricks');

    // Yank the fish out of the water toward (and slightly past) the player.
    _v.copy(player.eyePosition).sub(f.position);
    const d = _v.length();
    _v.normalize();
    const launchSpeed = clamp(lerp(9, 3.2, clamp01(inst.weight / Math.max(1, this.stats.maxWeight))), 2.5, 11);
    const vel = _v3.copy(_v).multiplyScalar(launchSpeed);
    vel.y += clamp(5.5 - inst.weight * 0.05, 1.2, 6.5);

    const waterY = waterHeightAt(f.position.x, f.position.z);
    game.audio.play('splash_big', { volume: clamp(0.4 + inst.weight * 0.02, 0.45, 1), position: f.position.clone() });
    bus.emit('fx:bigSplash', { position: _v4.set(f.position.x, waterY, f.position.z).clone(), scale: clamp(0.6 + inst.weight * 0.03, 0.6, 3) });
    bus.emit('player:shake', clamp01(inst.weight / 90) * 0.4 + 0.1);

    const mgr = game.get('physfish');
    const spawnPos = { x: f.position.x, y: Math.max(f.position.y, waterY) + 0.2, z: f.position.z };
    const mesh = f.mesh;
    // Hand the AI fish's mesh over so the physical fish looks identical.
    if (mesh) { f.group.remove(mesh); f.mesh = null; f.meshKey = ''; }
    const pf = mgr?.spawn({
      instance: inst, position: spawnPos, velocity: vel, mesh,
      angularVelocity: { x: rrange(-3, 3), y: rrange(-4, 4), z: rrange(-3, 3) },
    });

    // A landed fish should land: brief hit-stop scaled by size, plus a shove.
    bus.emit('fx:hitStop', clamp(0.02 + inst.weight * 0.0015, 0.02, 0.1));
    bus.emit('fx:screenFlash', { color: 'rgba(255,255,255,0.10)', duration: 90 });

    const record = eco?.recordCatch(inst, 'player');
    const trickResult = tricks?.evaluateCatch({
      castDistance: this.castDistance, apex: this.castApex, bounces: this.castBounces,
      spin: this.castSpin, fromBoat: this.castFromBoat, airborne: this.castWasAirborne,
      fightTime: this.fightTime, instance: inst, method: 'rod',
    });

    const rarity = RARITY[inst.rarity] || RARITY.common;
    const badges = [];
    if (record === 'weight') badges.push('New Record');
    if (inst.variantId !== 'normal') badges.push(VARIANT_BY_ID[inst.variantId]?.name || '');
    if (trickResult?.tricks?.length) badges.push(...trickResult.tricks.map((t) => t.name));

    const price = eco ? eco.priceFor(inst) : inst.value;
    bus.emit('catch:popup', {
      name: inst.name, rarity: rarity.name, rarityColor: rarity.color,
      weight: inst.weight, length: inst.length, value: Math.round(price * (trickResult?.mult || 1)),
      badges: badges.filter(Boolean),
    });
    game.audio.play(inst.rarity === 'legendary' || inst.rarity === 'mythic' ? 'legendary'
      : inst.rarity === 'epic' || inst.rarity === 'rare' ? 'rare_fish' : 'record', { volume: 0.55 });

    this.lastCatch = { instance: inst, styleMult: trickResult?.mult || 1 };
    if (pf) { pf.styleMult = trickResult?.mult || 1; pf.tricks = trickResult?.tricks || []; }

    bus.emit('fishing:caught', { instance: inst, pf, tricks: trickResult, method: 'rod' });

    f.state = FISH_STATE.DEAD;
    game.get('fish')?.despawn(f);
    this.hookedFish = null;
    this.state = CAST_STATE.LANDING;
    this.stateTime = 0;
    this.castSpin = 0;
    game.get('hud')?.setFishing(null);
  }

  updateLanding(dt, game) {
    // Brief beat with the line still visible, then retract.
    this.line.setVisible(this.stateTime < 0.35);
    this.bobber.visible = false;
    if (this.stateTime > 0.4) this.finishRetract(game);
  }

  loseFish(game, reason) {
    const f = this.hookedFish;
    if (f) {
      f.state = FISH_STATE.FLEE;
      f.stateTime = 0;
      f.spooked = 2;
      f.baitRef = null;
    }
    this.hookedFish = null;
    const eco = game.get('economy');
    if (eco) eco.stats.fishLost++;
    game.audio.play('splash_medium', { volume: 0.5, position: this.hook.position.clone() });
    bus.emit('toast', { text: `It ${reason}!`, kind: 'warn' });
    bus.emit('fishing:lost', { reason });
    this.state = CAST_STATE.REELING_EMPTY;
    this.stateTime = 0;
    game.get('hud')?.setFishing(null);
  }

  snapLine(game) {
    const f = this.hookedFish;
    const inst = f?.instance;
    if (f) { f.state = FISH_STATE.FLEE; f.stateTime = 0; f.spooked = 2.5; f.baitRef = null; }
    this.hookedFish = null;
    this._overTension = 0;
    game.audio.play('line_snap', { volume: 0.8 });
    bus.emit('player:shake', 0.5);
    bus.emit('toast', { text: `Line snapped! ${inst ? inst.name + ' escaped.' : ''}`, kind: 'error' });
    const eco = game.get('economy');
    if (eco) { eco.stats.linesSnapped++; eco.stats.fishLost++; }
    bus.emit('fishing:snapped', { instance: inst });
    this.state = CAST_STATE.SNAPPED;
    this.stateTime = 0;
    game.get('hud')?.setFishing(null);
  }

  reelIn(dt, game, speed) {
    _v.copy(this.rodTip).sub(this.hook.position);
    const d = _v.length();
    if (d < 0.05) return;
    _v.multiplyScalar(1 / d);
    this.hook.position.addScaledVector(_v, Math.min(d, speed * dt));
    this._reelClickAccum += dt * 16;
    while (this._reelClickAccum > 1) {
      this._reelClickAccum -= 1;
      game.audio.play('reel_click', { volume: 0.07, rate: rrange(0.95, 1.15) });
    }
    if (!this._reelLoop) this._reelLoop = game.audio.loop('reel_loop', { volume: 0.28 });
  }

  updateRetract(dt, game) {
    this.reelIn(dt, game, 14);
    this.bobber.visible = true;
    if (this.hook.position.distanceTo(this.rodTip) < 1.0 || this.stateTime > 4) this.finishRetract(game);
  }

  finishRetract(game) {
    this.state = CAST_STATE.IDLE;
    this.stateTime = 0;
    this.activeBait = null;
    this.nibbleFish = null;
    this.hookedFish = null;
    this.tension = 0;
    this.castSpin = 0;
    this.line.setVisible(false);
    this.bobber.visible = false;
    this.bobberDip = 0;
    if (this._reelLoop) { this._reelLoop.stop(0.15); this._reelLoop = null; }
    if (this._tensionLoop) { this._tensionLoop.stop(0.2); this._tensionLoop = null; }
    game.get('hud')?.setFishing(null);
    game.get('hud')?.setCastPower(null);
    game.get('hud')?.setHookWindow(null);
  }

  cancel() {
    if (this.hookedFish) {
      this.hookedFish.state = FISH_STATE.FLEE;
      this.hookedFish.baitRef = null;
      this.hookedFish = null;
    }
    this.finishRetract(this.game);
  }

  updatePresentation(dt, game) {
    const active = this.state !== CAST_STATE.IDLE && this.state !== CAST_STATE.CHARGING;
    this.line.setVisible(active);
    if (active) {
      const slack = this.state === CAST_STATE.HOOKED ? (1 - this.tension) * 0.5 : 0.4;
      this.line.update(dt, this.rodTip, this.hook.position, slack);
      this.line.setTension(this.tension);
      this.bobber.visible = this.state === CAST_STATE.IN_WATER || this.state === CAST_STATE.NIBBLE || this.state === CAST_STATE.REELING_EMPTY;
      if (this.bobber.visible) {
        this.bobber.position.copy(this.hook.position);
        // Punchy dip on the bite, decaying over the hook-set window.
        if (this.bobberDip > 0) {
          this.bobberDip = Math.max(0, this.bobberDip - dt * 2.2);
          this.bobber.position.y -= this.bobberDip * 0.22;
          const sc = 1 + this.bobberDip * 0.25;
          this.bobber.scale.setScalar(sc);
        } else if (this.bobber.scale.x !== 1) this.bobber.scale.setScalar(1);
        const n = waterNormalAt(this.hook.position.x, this.hook.position.z, undefined, _n);
        this.bobber.quaternion.setFromUnitVectors(UP, _v.set(n.x, n.y, n.z).normalize());
      }
    } else {
      this.bobber.visible = false;
    }
    // Rod bend target for the held-item renderer.
    const targetBend = this.state === CAST_STATE.HOOKED ? this.tension
      : this.state === CAST_STATE.CHARGING ? -this.castCharge * 0.6
      : this.state === CAST_STATE.IN_WATER || this.state === CAST_STATE.NIBBLE ? 0.08 : 0;
    this.rodBend = damp(this.rodBend, targetBend, 0.002, dt);
  }

  save() { return {}; }
  load() { this.finishRetract(this.game); }
}

const UP = new THREE.Vector3(0, 1, 0);
const _n = { x: 0, y: 1, z: 0 };
