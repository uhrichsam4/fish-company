import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CG, groups } from '../physics/PhysicsWorld.js';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, damp, smoothstep, TAU, rrange, rpick } from '../util/math.js';

const EYE_HEIGHT = 1.62;
const CROUCH_EYE = 1.05;
const RADIUS = 0.34;
const STAND_HALF = 0.52;   // capsule half-height (excluding caps)
const CROUCH_HALF = 0.22;

/**
 * First-person character controller.
 * Uses a Rapier kinematic capsule + character controller for solid collision
 * and slope handling; swimming and boat-deck riding are layered on top.
 */
export class Player {
  constructor(game) {
    this.game = game;
    this.name = 'player';
    this.order = 20;

    this.position = new THREE.Vector3(0, 5, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'sand';
    this.crouching = false;
    this.sprinting = false;
    this.swimming = false;
    this.underwater = false;
    this.submergence = 0;
    this.canMove = true;
    this.mode = 'walk';         // walk | swim | boat | sub | frozen
    this.ridingBody = null;     // physics entry of the boat we're standing on
    this._ridingOffset = new THREE.Vector3();

    this.walkSpeed = 4.6;
    this.sprintSpeed = 7.6;
    this.crouchSpeed = 2.2;
    this.swimSpeed = 3.4;
    this.jumpSpeed = 7.4;
    this.airControl = 0.32;
    this.accel = 46;
    this.deaccel = 34;

    this.health = 100;
    this.maxHealth = 100;
    this.stamina = 100;
    this.oxygen = 100;
    this.maxOxygen = 100;
    this.invulnerable = false;

    this.eyeHeight = EYE_HEIGHT;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.viewOffset = new THREE.Vector3();
    this.recoil = new THREE.Vector3();
    this.shake = 0;
    this._shakeSeed = Math.random() * 1000;
    this.tiltZ = 0;
    this.fovKick = 0;

    this._stepDist = 0;
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._lastGroundY = 0;
    this._fallStart = 0;
    this._wasGrounded = true;
  }

  async init(game) {
    const phys = game.physics;
    this.controller = phys.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((40 * Math.PI) / 180);
    this.controller.enableAutostep(0.52, 0.28, true);
    this.controller.enableSnapToGround(0.42);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(82);

    this.entry = phys.addBody({
      type: 'kinematicPosition',
      position: this.position,
      shape: { kind: 'capsule', hh: STAND_HALF, r: RADIUS, groups: groups(CG.PLAYER, 0xffff & ~CG.PROJECTILE) },
      tag: 'player',
      canSleep: false,
      events: false,
      userData: { player: this },
    });
    this.collider = this.entry.colliders[0];

    // Camera holder so held items/hands can parent to the view.
    this.head = new THREE.Object3D();
    this.head.name = 'player-head';
    game.scene.add(this.head);
    this.handSocket = new THREE.Object3D();
    this.handSocket.name = 'hand-socket';
    this.head.add(this.handSocket);

    bus.on('player:knockback', (v) => this.knockback(v.x, v.y, v.z));
    bus.on('player:damage', (n) => this.damage(n));
    bus.on('player:teleport', (p) => this.teleport(p.x, p.y, p.z));
    bus.on('player:shake', (a) => { this.shake = Math.max(this.shake, a); });
    return this;
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.entry.body.setNextKinematicTranslation({ x, y, z });
    this.entry.body.setTranslation({ x, y, z }, true);
    this.ridingBody = null;
  }

  spawnAt(anchor, yaw = 0) {
    this.teleport(anchor.x, anchor.y + 1.4, anchor.z);
    this.yaw = yaw;
    this.pitch = -0.05;
  }

  get eyePosition() {
    return _tmp.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  forward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)).normalize();
  }
  flatForward(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
  right(out = new THREE.Vector3()) {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  update(dt, game) {
    if (dt <= 0) return;
    const input = game.input;

    // ---- look ----
    if (input.locked && this.canMove) {
      const { yaw, pitch } = input.consumeLook();
      this.yaw += yaw;
      this.pitch = clamp(this.pitch + pitch, -1.52, 1.52);
    } else {
      input.consumeLook();
    }

    if (this.mode === 'boat' || this.mode === 'sub') {
      this.updateCamera(dt, game);
      return;
    }

    const ocean = game.get('ocean');
    const world = game.get('world');
    const waterY = ocean ? ocean.heightAt(this.position.x, this.position.z) : -1000;
    const feetDepth = waterY - this.position.y;
    const headDepth = waterY - (this.position.y + this.eyeHeight);
    this.submergence = clamp01(feetDepth / 1.75);
    const wasSwimming = this.swimming;
    this.swimming = feetDepth > 1.15 && world && world.heightAt(this.position.x, this.position.z) < waterY - 0.9;
    this.underwater = headDepth > 0;

    if (this.swimming !== wasSwimming) {
      bus.emit('player:swimming', this.swimming);
      game.audio.play(this.swimming ? 'splash_medium' : 'splash_small', { volume: 0.6, position: this.eyePosition.clone() });
      bus.emit('ocean:ripple', { x: this.position.x, z: this.position.z, strength: 0.7 });
      bus.emit('fx:splash', { position: new THREE.Vector3(this.position.x, waterY, this.position.z), scale: 1.0 });
    }
    game.audio.setUnderwater(this.underwater ? 1 : 0);

    if (this.underwater) {
      this.oxygen = Math.max(0, this.oxygen - dt * 6.5);
      if (this.oxygen <= 0) this.damage(dt * 9, 'drowning');
    } else {
      this.oxygen = Math.min(this.maxOxygen, this.oxygen + dt * 26);
    }

    if (this.swimming) this.updateSwim(dt, game);
    else this.updateWalk(dt, game);

    this.updateCamera(dt, game);
    this.updateFootsteps(dt, game);

    this.stamina = clamp(this.stamina + (this.sprinting && this.velocity.lengthSq() > 4 ? -dt * 13 : dt * 19), 0, 100);
    this.health = Math.min(this.maxHealth, this.health + dt * 1.1);
  }

  updateWalk(dt, game) {
    const input = game.input;
    const wantCrouch = input.down('ControlLeft') || input.down('KeyC');
    if (wantCrouch !== this.crouching) this.setCrouch(wantCrouch);

    this.sprinting = input.down('ShiftLeft') && !this.crouching && this.stamina > 3;

    const axis = this.canMove ? input.moveAxis() : { x: 0, z: 0 };
    const fwd = this.flatForward(_v1);
    const rgt = this.right(_v2);
    const wishDir = _v3.set(0, 0, 0)
      .addScaledVector(fwd, axis.z)
      .addScaledVector(rgt, axis.x);
    const wishLen = wishDir.length();
    if (wishLen > 0.001) wishDir.multiplyScalar(1 / wishLen);

    let speed = this.crouching ? this.crouchSpeed : this.sprinting ? this.sprintSpeed : this.walkSpeed;
    if (this.groundSurface === 'wood') speed *= 1.0;
    if (this.submergence > 0.05) speed *= lerp(1, 0.55, this.submergence);

    const targetX = wishDir.x * speed * wishLen;
    const targetZ = wishDir.z * speed * wishLen;
    const control = this.grounded ? 1 : this.airControl;
    const rate = (wishLen > 0.01 ? this.accel : this.deaccel) * control;
    this.velocity.x = approach(this.velocity.x, targetX, rate * dt);
    this.velocity.z = approach(this.velocity.z, targetZ, rate * dt);

    // ---- gravity & jump ----
    const g = 22;
    this._coyote = this.grounded ? 0.14 : Math.max(0, this._coyote - dt);
    if (input.justPressed('Space')) this._jumpBuffer = 0.16;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    if (this._jumpBuffer > 0 && this._coyote > 0 && this.canMove && !this.crouching) {
      this.velocity.y = this.jumpSpeed;
      this._jumpBuffer = 0; this._coyote = 0;
      this.grounded = false;
      game.audio.play('jump', { volume: 0.45 });
      bus.emit('player:jumped');
    }
    if (!this.grounded) this.velocity.y -= g * dt;
    else if (this.velocity.y < 0) this.velocity.y = -2.5;

    // Buoyant lift when wading deep.
    if (this.submergence > 0.4) this.velocity.y += this.submergence * 9 * dt;

    this.moveAndSlide(dt, game);
  }

  updateSwim(dt, game) {
    const input = game.input;
    this.crouching = false;
    const axis = this.canMove ? input.moveAxis() : { x: 0, z: 0 };
    const look = this.forward(_v1);
    const rgt = this.right(_v2);
    const wish = _v3.set(0, 0, 0).addScaledVector(look, axis.z).addScaledVector(rgt, axis.x);
    if (input.down('Space')) wish.y += 1;
    if (input.down('ControlLeft')) wish.y -= 1;
    if (wish.lengthSq() > 0.001) wish.normalize();

    const speed = this.swimSpeed * (input.down('ShiftLeft') ? 1.55 : 1);
    this.velocity.lerp(_v4.copy(wish).multiplyScalar(speed), 1 - Math.pow(0.004, dt));

    // Slight negative buoyancy so you sink gently when idle, plus surface bob.
    const ocean = game.get('ocean');
    const waterY = ocean ? ocean.heightAt(this.position.x, this.position.z) : 0;
    const headY = this.position.y + this.eyeHeight;
    if (headY < waterY - 0.1 && wish.y >= 0) this.velocity.y += 1.6 * dt;
    else if (headY > waterY + 0.05) this.velocity.y -= 8 * dt;
    this.velocity.y = clamp(this.velocity.y, -6, 6);

    this.grounded = false;
    this.moveAndSlide(dt, game);
  }

  moveAndSlide(dt, game) {
    const phys = game.physics;
    // Ride moving platforms (boat decks): add the platform's delta first.
    let platformDelta = _v4.set(0, 0, 0);
    if (this.ridingBody && !this.ridingBody.removed) {
      const t = this.ridingBody.body.translation();
      const cur = _v1.set(t.x, t.y, t.z);
      if (this._ridingPrev) platformDelta.copy(cur).sub(this._ridingPrev);
      (this._ridingPrev ||= new THREE.Vector3()).copy(cur);
      if (platformDelta.lengthSq() > 4) platformDelta.set(0, 0, 0);
    } else { this._ridingPrev = null; }

    const desired = {
      x: this.velocity.x * dt + platformDelta.x,
      y: this.velocity.y * dt + platformDelta.y,
      z: this.velocity.z * dt + platformDelta.z,
    };

    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const mv = this.controller.computedMovement();
    this.position.x += mv.x; this.position.y += mv.y; this.position.z += mv.z;

    if (!Number.isFinite(this.position.x) || !Number.isFinite(this.position.y)) {
      console.error('[Player] NaN position, resetting');
      const w = game.get('world');
      const a = w?.getAnchors('crash');
      this.teleport(a?.spawn.x ?? 0, (a?.spawn.y ?? 5) + 2, a?.spawn.z ?? 0);
      return;
    }

    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    // Zero out velocity components the controller had to cancel.
    if (Math.abs(mv.x) < Math.abs(desired.x) * 0.35) this.velocity.x *= 0.4;
    if (Math.abs(mv.z) < Math.abs(desired.z) * 0.35) this.velocity.z *= 0.4;
    if (this.grounded && this.velocity.y < 0) {
      if (!wasGrounded) this.onLand(game);
      this.velocity.y = 0;
    }
    if (!this.grounded && wasGrounded) this._fallStart = this.position.y;

    // Detect what we're standing on.
    this.ridingBody = null;
    this.groundSurface = 'sand';
    const n = this.controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const c = this.controller.computedCollision(i);
      if (!c) continue;
      const e = phys.byCollider.get(c.collider?.handle ?? -1);
      if (!e) continue;
      if (c.normal1 && c.normal1.y < -0.5) {
        this.groundNormal.set(-c.normal1.x, -c.normal1.y, -c.normal1.z);
      }
      if (e.tag === 'boat' || e.userData?.rideable) { this.ridingBody = e; this.groundSurface = 'wood'; }
      else if (e.userData?.surface) this.groundSurface = e.userData.surface;
      else if (e.tag === 'dock') this.groundSurface = 'wood';
    }

    // World floor safety net.
    const world = game.get('world');
    if (world) {
      const floor = world.heightAt(this.position.x, this.position.z);
      if (this.position.y < floor - 3) {
        this.position.y = floor + 1.2;
        this.velocity.y = 0;
        this.entry.body.setTranslation(this.position, true);
      }
    }
    if (this.position.y < -60 && this.mode === 'walk') {
      const a = world?.getAnchors(world.activeRegion?.id || 'crash');
      if (a?.spawn) this.spawnAt(a.spawn, this.yaw);
    }

    this.entry.body.setNextKinematicTranslation(this.position);
  }

  onLand(game) {
    const fall = this._fallStart - this.position.y;
    if (fall > 1.2) {
      const v = clamp01((fall - 1.2) / 8);
      game.audio.play('land', { volume: 0.3 + v * 0.6 });
      this.shake = Math.max(this.shake, v * 0.5);
      if (fall > 9 && !this.invulnerable) this.damage((fall - 9) * 5.5, 'fall');
    }
  }

  setCrouch(on) {
    if (on === this.crouching) return;
    if (!on) {
      // Only stand up if there's headroom.
      const phys = this.game.physics;
      const hit = phys.raycast(
        _v1.set(this.position.x, this.position.y + 0.4, this.position.z),
        _v2.set(0, 1, 0), 1.5, undefined, this.collider,
      );
      if (hit && hit.distance < 1.35) return;
    }
    this.crouching = on;
    const half = on ? CROUCH_HALF : STAND_HALF;
    this.collider.setShape(new RAPIER.Capsule(half, RADIUS));
  }

  updateCamera(dt, game) {
    const cam = game.camera;
    const targetEye = this.crouching ? CROUCH_EYE : EYE_HEIGHT;
    this.eyeHeight = damp(this.eyeHeight, targetEye, 0.0005, dt);

    // Head bob driven by actual horizontal speed.
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = this.grounded && hSpeed > 0.6;
    this.bobPhase += dt * (this.swimming ? 3.2 : hSpeed * (this.sprinting ? 1.55 : 1.8));
    const bobTarget = moving ? clamp01(hSpeed / this.sprintSpeed) : 0;
    this.bobAmount = damp(this.bobAmount, bobTarget, 0.002, dt);
    const bobScale = (game.settings.bobbing ?? 1) * this.bobAmount;
    const bobY = Math.sin(this.bobPhase * 2) * 0.048 * bobScale;
    const bobX = Math.cos(this.bobPhase) * 0.036 * bobScale;
    const bobRoll = Math.cos(this.bobPhase) * 0.011 * bobScale;

    // Strafe lean.
    const strafe = this.right(_v1).dot(_v2.copy(this.velocity).setY(0)) / Math.max(1, this.walkSpeed);
    this.tiltZ = damp(this.tiltZ, -strafe * 0.028, 0.002, dt);

    // Screen shake.
    this.shake = damp(this.shake, 0, 0.0008, dt);
    let shX = 0, shY = 0, shR = 0;
    if (this.shake > 0.001) {
      const t = game.time * 34 + this._shakeSeed;
      shX = Math.sin(t * 1.7) * this.shake * 0.09;
      shY = Math.sin(t * 2.3 + 1.7) * this.shake * 0.09;
      shR = Math.sin(t * 1.1 + 0.4) * this.shake * 0.05;
    }

    this.recoil.multiplyScalar(Math.pow(0.0009, dt));

    const eye = this.eyePosition;
    cam.position.set(
      eye.x + bobX * 0.35,
      eye.y + bobY,
      eye.z,
    );
    // Swim tilt: lean into the swim direction.
    const swimTilt = this.swimming ? clamp(this.velocity.y * -0.05, -0.25, 0.25) : 0;
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + shX + this.recoil.y;
    cam.rotation.x = this.pitch + bobY * 0.35 + shY + this.recoil.x + swimTilt;
    cam.rotation.z = this.tiltZ + bobRoll + shR + this.recoil.z;

    this.head.position.copy(cam.position);
    this.head.quaternion.copy(cam.quaternion);

    // FOV kick from sprinting / boats.
    const targetFov = game.settings.fov + (this.sprinting && hSpeed > 4 ? 5 : 0) + this.fovKick;
    if (Math.abs(cam.fov - targetFov) > 0.02) {
      cam.fov = damp(cam.fov, targetFov, 0.002, dt);
      cam.updateProjectionMatrix();
    }
  }

  updateFootsteps(dt, game) {
    if (!this.grounded || this.swimming) { this._stepDist = 0; return; }
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed < 0.5) { this._stepDist = 0; return; }
    this._stepDist += hSpeed * dt;
    const stride = this.crouching ? 1.5 : this.sprinting ? 2.3 : 1.85;
    if (this._stepDist >= stride) {
      this._stepDist = 0;
      const surf = this.submergence > 0.12 ? 'splash_small' : `footstep_${this.groundSurface}`;
      game.audio.play(surf, { volume: this.sprinting ? 0.42 : 0.28, rate: rrange(0.92, 1.1) });
      if (this.submergence > 0.12) {
        bus.emit('fx:splash', { position: new THREE.Vector3(this.position.x, this.position.y + 0.1, this.position.z), scale: 0.35 });
      }
      bus.emit('player:footstep', { surface: this.groundSurface });
    }
  }

  knockback(x, y, z) {
    this.velocity.x += x; this.velocity.y += y; this.velocity.z += z;
    this.velocity.clampLength(0, 26);
    this.grounded = false;
    this.shake = Math.max(this.shake, Math.min(1.2, Math.hypot(x, y, z) * 0.08));
  }

  damage(n, cause = 'unknown') {
    if (this.invulnerable) return;
    this.health -= n;
    if (n > 2) {
      bus.emit('player:hurt', { amount: n, cause });
      this.shake = Math.max(this.shake, clamp01(n / 30));
    }
    if (this.health <= 0) {
      this.health = this.maxHealth * 0.4;
      this.oxygen = this.maxOxygen;
      bus.emit('player:down', { cause });
      const w = this.game.get('world');
      const a = w?.getAnchors(w.activeRegion?.id || 'crash');
      if (a?.spawn) this.spawnAt(a.spawn, this.yaw);
    }
  }

  save() {
    return {
      x: this.position.x, y: this.position.y, z: this.position.z,
      yaw: this.yaw, pitch: this.pitch, health: this.health, oxygen: this.oxygen,
    };
  }
  load(d) {
    if (!d) return;
    this.teleport(d.x, d.y, d.z);
    this.yaw = d.yaw ?? 0; this.pitch = d.pitch ?? 0;
    this.health = d.health ?? 100; this.oxygen = d.oxygen ?? 100;
  }
}

function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

const _tmp = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
