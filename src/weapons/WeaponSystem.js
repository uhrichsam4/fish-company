import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { CG, groups } from '../physics/PhysicsWorld.js';
import { FISH_STATE } from '../fish/FishSystem.js';
import { FishingLine } from '../fishing/FishingLine.js';
import { waterHeightAt } from '../world/waves.js';
import { worldHeight } from '../world/Terrain.js';
import { RARITY, VARIANT_BY_ID } from '../data/fishData.js';
import { clamp, clamp01, lerp, rrange, rchance, formatWeight } from '../util/math.js';
import { buildProjectileMesh, buildSuctionCone } from './projectileMeshes.js';

/**
 * Harpoons, spears, nets, vacuums and beams.
 *
 * Projectiles are simulated by hand (position/velocity integrated per frame,
 * swept against the physics world with a raycast along each frame's travel
 * segment) rather than as Rapier dynamic bodies. That keeps 24 live
 * projectiles essentially free, makes water drag / tethering / sticking
 * trivial to author, and avoids the solver fighting a 60 m/s body.
 *
 * AI fish have no colliders, so every step also runs a capsule test of the
 * travel segment against `fish.active`.
 */

const MAX_PROJECTILES = 24;
const MAX_LINES = 4;
/** Ray membership PROJECTILE — the player capsule filters us out explicitly. */
const HIT_MASK = groups(
  CG.PROJECTILE,
  CG.TERRAIN | CG.PROP | CG.BOAT | CG.DEBRIS | CG.FISH | CG.WORKER | CG.TRIGGER,
);
const FWD_Z = new THREE.Vector3(0, 0, 1);
const SUCTION_COS = Math.cos(35 * Math.PI / 180);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.name = 'weapons';
    this.order = 52;

    /** Read by HeldItems to hide the chambered spear on the harpoon gun. */
    this.loaded = true;
    this.ammoInMag = 1;
    this.magSize = 1;
    this.reloadT = 0;
    this.cooldown = 0;
    this.aiming = false;
    this.firing = false;
    this.item = null;

    /** @type {Array<object>} live projectiles (subset of the pool) */
    this.projectiles = [];
    this._pool = [];
    this._lines = [];
    this._meshPool = new Map();
    this._knocked = [];
    this._hits = [];
    this._hitCount = 0;
    this._batch = [];

    this._crossT = 0;
    this._weaponId = null;
    this._prevFovKick = null;
    this._suctionT = 0;
    this._suckLoopOn = false;
    this._bubbleT = 0;
    this.shotsFired = 0;
    this.kills = 0;
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'weapons';
    game.scene.add(this.root);

    for (let i = 0; i < MAX_PROJECTILES; i++) this._pool.push(makeProjectile());
    for (let i = 0; i < 8; i++) this._hits.push({ f: null, t: 0 });

    this.suctionCone = buildSuctionCone();
    this.suctionCone.visible = false;
    this.root.add(this.suctionCone);

    bus.on('equipment:changed', ({ slot }) => { if (slot === 'weapon' || slot === 'tool') this._resetWeapon(); });
    bus.on('hotbar:changed', () => { this.firing = false; this._stopSuctionLoop(); });
    bus.on('game:newgame', () => this.clearAll());
    return this;
  }

  // ------------------------------------------------------------------ state
  _resetWeapon() {
    this.cooldown = 0;
    this.reloadT = 0;
    this._weaponId = null;
    this.firing = false;
    this._stopSuctionLoop();
  }

  _armFor(stats) {
    this.magSize = Math.max(1, stats?.magazine ?? 1);
    this.ammoInMag = this.magSize;
    this.cooldown = 0;
    this.reloadT = 0;
  }

  reloadTime(stats) {
    return stats?.reload ?? (1 / Math.max(0.1, stats?.rate ?? 1));
  }

  // ----------------------------------------------------------------- update
  update(dt, game) {
    if (dt <= 0) return;
    const inv = game.get('inventory');
    const player = game.get('player');
    if (!inv || !player) return;
    const input = game.input;

    const kind = inv.activeKind;
    const weapon = kind === 'weapon' ? inv.weapon : null;
    const melee = kind === 'tool' ? inv.tool : null;
    const item = weapon || melee;
    this.item = item;

    if ((item?.id ?? null) !== this._weaponId) {
      this._weaponId = item?.id ?? null;
      this._armFor(item?.stats);
    }

    const canAct = player.canMove && !input.uiCapture && input.enabled;

    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      if (this.reloadT === 0) this.ammoInMag = this.magSize;
    }
    if (this._crossT > 0) this._crossT = Math.max(0, this._crossT - dt);

    if (weapon && canAct) this._updateWeapon(dt, game, weapon, weapon.stats || {}, input, player);
    else {
      this._setAiming(false, player);
      this.firing = false;
      this._stopSuctionLoop();
    }
    if (melee && canAct) this._updateMelee(dt, game, melee, melee.stats || {}, input, player);

    this.loaded = this.reloadT <= 0 && this.cooldown <= 0 && this.ammoInMag > 0;

    this._updateKnockback(dt, game);
    this._updateProjectiles(dt, game, input, player);
  }

  /** Crosshair is written late so Interaction (order 65) can't clobber it. */
  lateUpdate(dt, game) {
    if (this._crossT > 0) game.get('hud')?.setCrosshair('hit');
  }

  // ---------------------------------------------------------------- weapons
  _updateWeapon(dt, game, item, stats, input, player) {
    // ---- aim ----
    this._setAiming(input.mouseDown(1), player);

    if (stats.continuous) {
      const on = input.mouseDown(0);
      this.firing = on;
      if (on) this._updateSuction(dt, game, item, stats, player);
      else { this.suctionCone.visible = false; this._stopSuctionLoop(); }
      return;
    }

    // ---- reload ----
    if (input.justPressed('KeyR') && this.reloadT <= 0 && this.ammoInMag < this.magSize) {
      this._startReload(game, stats);
      return;
    }
    if (this.reloadT > 0) return;

    // High rate-of-fire weapons are full auto; the rest are semi.
    const wants = (stats.rate ?? 1) >= 3 ? input.mouseDown(0) : input.mousePressed(0);
    if (!wants || this.cooldown > 0) return;

    if (this.ammoInMag <= 0) { this._startReload(game, stats); return; }
    this._fire(game, item, stats, player);
  }

  _setAiming(on, player) {
    if (on === this.aiming) return;
    this.aiming = on;
    if (on) {
      this._prevFovKick = player.fovKick;
      player.fovKick = -12;
    } else if (this._prevFovKick !== null) {
      player.fovKick = this._prevFovKick;
      this._prevFovKick = null;
    }
  }

  _startReload(game, stats) {
    if (this.reloadT > 0) return;
    this.reloadT = this.reloadTime(stats);
    this.loaded = false;
    game.audio?.play(stats.magazine ? 'gun_reload' : 'harpoon_reload', { volume: 0.6, rate: rrange(0.95, 1.06) });
    bus.emit('weapon:reload', { time: this.reloadT });
  }

  /** Muzzle in world space: in front of the eye, offset to the gun hand. */
  _muzzleOf(player, out) {
    _eye.copy(player.eyePosition);
    player.forward(_fwd);
    player.right(_rgt);
    return out.copy(_eye).addScaledVector(_fwd, 0.55).addScaledVector(_rgt, 0.17).add(_a.set(0, -0.12, 0));
  }

  _fire(game, item, stats, player) {
    const rate = Math.max(0.05, stats.rate ?? 1);
    this.cooldown = 1 / rate;
    this.ammoInMag--;
    this.shotsFired++;

    this._muzzleOf(player, _muzzle);
    player.forward(_fwd);

    // Hip fire wanders; aiming down the weapon is dead accurate.
    const spread = this.aiming ? 0 : lerp(0.004, 0.02, clamp01(Math.hypot(player.velocity.x, player.velocity.z) / 8));
    _d.copy(_fwd);
    if (spread > 0) {
      _d.x += rrange(-spread, spread); _d.y += rrange(-spread, spread); _d.z += rrange(-spread, spread);
      _d.normalize();
    }

    this._recoil(game, stats, player, _muzzle, _d);

    const kind = stats.projectile || 'spear';
    if (kind === 'beam') this._fireBeam(game, item, stats, player, _muzzle, _d);
    else this._spawnProjectile(game, item, stats, kind, _muzzle, _d, player);

    if (this.ammoInMag <= 0 && this.magSize > 0) this._startReload(game, stats);
    bus.emit('weapon:fired', { id: item.id, kind, ammo: this.ammoInMag });
  }

  _recoil(game, stats, player, origin, dir) {
    const r = stats.recoil ?? 2;
    bus.emit('weapon:recoil', stats.recoil ? stats.recoil / 10 : 0.25);
    // Real camera kick — Player damps `recoil` back to zero.
    player.recoil.x += 0.008 + r * 0.0042;
    player.recoil.y += rrange(-1, 1) * r * 0.0016;
    player.recoil.z += rrange(-1, 1) * r * 0.0012;
    bus.emit('player:shake', clamp01(r / 18) * 0.55 + 0.06);
    bus.emit('fx:muzzle', { position: origin.clone(), direction: dir.clone(), scale: 0.7 + clamp01(r / 12) });

    const proj = stats.projectile;
    const sound = proj === 'beam' ? 'gun_shot'
      : proj === 'net' ? 'net_throw'
        : stats.recoil ? 'harpoon_fire' : 'spear_throw';
    game.audio?.play(sound, { volume: 0.85, rate: rrange(0.94, 1.07) });
    // A loud shot spooks everything nearby.
    game.get('fish')?.scare(origin, proj === 'beam' ? 14 : 9, 0.9);
  }

  // ------------------------------------------------------------ projectiles
  _acquire() {
    for (const p of this._pool) if (!p.active) return p;
    // Pool exhausted: recycle the oldest live projectile.
    const oldest = this.projectiles[0];
    if (oldest) this._despawn(oldest);
    return this._pool.find((p) => !p.active) || null;
  }

  _acquireMesh(kind) {
    let bucket = this._meshPool.get(kind);
    if (!bucket) { bucket = []; this._meshPool.set(kind, bucket); }
    const m = bucket.pop() || buildProjectileMesh(kind);
    m.visible = true;
    this.root.add(m);
    return m;
  }
  _releaseMesh(kind, mesh) {
    if (!mesh) return;
    mesh.visible = false;
    this.root.remove(mesh);
    let bucket = this._meshPool.get(kind);
    if (!bucket) { bucket = []; this._meshPool.set(kind, bucket); }
    if (bucket.length < 6) bucket.push(mesh);
  }

  _acquireLine() {
    for (const l of this._lines) if (!l.busy) { l.busy = true; return l; }
    if (this._lines.length < MAX_LINES) {
      const l = new FishingLine(this.game.scene, { count: 12, color: 0xd8e4ec });
      l.busy = true;
      this._lines.push(l);
      return l;
    }
    return null;
  }
  _releaseLine(l) {
    if (!l) return;
    l.busy = false;
    l.setVisible(false);
  }

  _spawnProjectile(game, item, stats, kind, origin, dir, player) {
    const p = this._acquire();
    if (!p) return null;
    p.active = true;
    p.kind = kind;
    p.weaponId = item.id;
    p.pos.copy(origin);
    p.prev.copy(origin);
    const speed = stats.speed ?? 30;
    p.vel.copy(dir).multiplyScalar(speed);
    // Inherit the shooter's motion so running shots feel connected.
    if (player) p.vel.addScaledVector(player.velocity, 0.35);
    p.dir.copy(dir);
    p.gravity = stats.gravity ?? 9;
    p.damage = stats.damage ?? 10;
    p.range = stats.range ?? 40;
    p.explosive = stats.explosive ?? 0;
    p.tethered = !!stats.tethered;
    p.netRadius = stats.netRadius ?? 0;
    p.travelled = 0;
    p.life = 0;
    p.maxLife = kind === 'net' ? 8 : 10;
    p.state = 'fly';
    p.stuckT = 0;
    p.open = 0;
    p.attached = null;
    p.slackT = 0;
    p.spin = rrange(-2, 2);
    p.radius = kind === 'heavy_harpoon' ? 0.26 : kind === 'net' ? 0.3 : 0.16;
    p.underwater = p.pos.y < waterHeightAt(p.pos.x, p.pos.z);

    p.mesh = this._acquireMesh(kind);
    p.mesh.position.copy(p.pos);
    p.mesh.quaternion.setFromUnitVectors(FWD_Z, _a.copy(p.vel).normalize());
    if (kind === 'net') p.mesh.userData.setOpen?.(0);

    if (p.tethered) {
      p.line = this._acquireLine();
      if (p.line) { p.line.reset(origin, p.pos); p.line.setVisible(true); }
    }
    this.projectiles.push(p);
    return p;
  }

  _despawn(p) {
    if (!p.active) return;
    p.active = false;
    if (p.attached) this._detach(p, false);
    this._releaseMesh(p.kind, p.mesh);
    p.mesh = null;
    this._releaseLine(p.line);
    p.line = null;
    const i = this.projectiles.indexOf(p);
    if (i >= 0) this.projectiles.splice(i, 1);
  }

  clearAll() {
    for (const p of [...this.projectiles]) this._despawn(p);
    this._knocked.length = 0;
  }

  _updateProjectiles(dt, game, input, player) {
    if (!this.projectiles.length) return;
    const phys = game.physics;
    const fishSys = game.get('fish');
    const holding = input.mouseDown(0);
    this._muzzleOf(player, _muzzle);

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life += dt;

      if (p.state === 'beam') {
        // Hitscan beam: hold for a beat, then flare out and vanish.
        const t = clamp01(p.life / p.maxLife);
        if (p.mesh) {
          const w = lerp(0.9, 2.6, t * t) * (1 - t * 0.15);
          p.mesh.scale.set(w * p.beamWidth, w * p.beamWidth, p.beamLen);
          p.mesh.traverse((o) => { if (o.material) o.material.opacity = undefined; });
        }
        if (p.life >= p.maxLife) this._despawn(p);
        continue;
      }

      if (p.state === 'stuck') {
        p.stuckT -= dt;
        if (p.line) p.line.update(dt, _muzzle, p.pos, 0.6);
        if (p.stuckT <= 0) this._despawn(p);
        continue;
      }

      if (p.state === 'attached') {
        this._updateTether(dt, game, p, player, holding);
        if (p.line) p.line.update(dt, _muzzle, p.pos, p.slackT > 0 ? 0.5 : 0.05);
        continue;
      }

      // ------------------------------------------------- integrate & sweep
      p.prev.copy(p.pos);
      const gScale = p.underwater ? 0.3 : 1;
      p.vel.y -= p.gravity * gScale * dt;
      // Underwater drag is brutal on purpose: a harpoon that flies 80 m in
      // air should die within ~20 m of water.
      const dragK = p.underwater ? 0.06 : (p.kind === 'net' ? 0.45 : 0.86);
      p.vel.multiplyScalar(Math.pow(dragK, dt));
      p.pos.addScaledVector(p.vel, dt);

      const segLen = p.pos.distanceTo(p.prev);
      p.travelled += segLen;
      if (segLen > 1e-5) _c.copy(p.pos).sub(p.prev).multiplyScalar(1 / segLen);
      else _c.copy(p.dir);
      p.dir.copy(_c);

      // ---- water surface crossing ----
      this._checkWater(p, game, dt);

      // ---- nets open mid-flight ----
      if (p.kind === 'net') {
        p.open = clamp01(p.open + dt * 3.2);
        p.mesh?.userData.setOpen?.(p.open);
        if (p.open >= 1 && this._netCatch(p, game, false)) continue;
      }

      // ---- fish sweep + world sweep, nearest wins ----
      let hitDist = Infinity;
      let worldHit = null;
      if (segLen > 1e-5) {
        worldHit = phys.raycast(p.prev, _c, segLen + p.radius, HIT_MASK, null);
        if (worldHit) hitDist = worldHit.distance;
      }
      const n = fishSys ? this._sweepFish(p, fishSys, _c, segLen) : 0;
      let fishHit = null;
      for (let k = 0; k < n; k++) {
        const h = this._hits[k];
        if (h.t < hitDist) { hitDist = h.t; fishHit = h.f; }
        if (!p.pierce) break;
      }

      if (fishHit) {
        _e.copy(p.prev).addScaledVector(_c, hitDist);
        const survived = this._hitFish(game, fishHit, p, _c, _e);
        if (!survived || p.tethered) { if (p.active && p.state === 'fly') continue; }
        if (!p.active) continue;
      } else if (worldHit) {
        this._impact(game, p, worldHit, _c);
        continue;
      }

      // ---- mesh transform ----
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
        if (p.kind === 'net') {
          p.mesh.rotateZ(p.spin * dt);
          p.mesh.quaternion.setFromUnitVectors(FWD_Z, _a.copy(p.vel).normalize());
        } else if (p.vel.lengthSq() > 0.01) {
          _q.setFromUnitVectors(FWD_Z, _a.copy(p.vel).normalize());
          p.mesh.quaternion.slerp(_q, 1 - Math.pow(0.0001, dt));
        }
      }
      if (p.line) p.line.update(dt, _muzzle, p.pos, clamp01(0.5 - p.travelled * 0.01));

      // ---- expiry ----
      if (p.travelled > p.range * 1.6 || p.life > p.maxLife || p.pos.y < -260) {
        if (p.kind === 'net') this._netCatch(p, game, true);
        this._despawn(p);
      }
    }
  }

  _checkWater(p, game, dt) {
    const wNow = waterHeightAt(p.pos.x, p.pos.z);
    if (!p.underwater && p.pos.y <= wNow) {
      p.underwater = true;
      const t = clamp01((p.prev.y - waterHeightAt(p.prev.x, p.prev.z))
        / Math.max(1e-4, (p.prev.y - waterHeightAt(p.prev.x, p.prev.z)) - (p.pos.y - wNow)));
      _b.lerpVectors(p.prev, p.pos, t);
      _b.y = wNow;
      const sc = clamp(0.5 + p.radius * 3 + p.vel.length() * 0.012, 0.4, 2.4);
      bus.emit('fx:splash', { position: _b.clone(), scale: sc });
      bus.emit('ocean:ripple', { x: _b.x, z: _b.z, strength: clamp01(sc * 0.5) });
      game.audio?.play('splash_medium', { volume: clamp(0.35 + sc * 0.25, 0.3, 0.9), position: _b.clone(), throttle: 40 });
      // Entering water costs a big chunk of speed immediately.
      p.vel.multiplyScalar(0.55);
      if (p.kind === 'net') this._netCatch(p, game, true);
    } else if (p.underwater && p.pos.y > wNow + 0.05) {
      p.underwater = false;
    }
    if (p.underwater) {
      this._bubbleT -= dt;
      if (this._bubbleT <= 0) {
        this._bubbleT = 0.07;
        bus.emit('fx:bubbles', { position: p.pos.clone(), count: 3, rise: 0.9, spread: 0.14 });
      }
    }
  }

  /**
   * Capsule test of this frame's travel segment against AI fish.
   * Results land in `this._hits` sorted by distance along the segment.
   * @returns {number} hit count
   */
  _sweepFish(p, fishSys, segDir, segLen) {
    const list = fishSys.active;
    let n = 0;
    const reach = segLen + 2.5;
    const maxRange = p.range * p.range;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f.active || f.state === FISH_STATE.HOOKED || f === p.lastFish) continue;
      // Cheap rejections first: outside the weapon's range, or nowhere near
      // this frame's segment.
      const dx = f.position.x - p.prev.x, dy = f.position.y - p.prev.y, dz = f.position.z - p.prev.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > maxRange || d2 > reach * reach) continue;
      const along = clamp(dx * segDir.x + dy * segDir.y + dz * segDir.z, 0, segLen);
      const cx = dx - segDir.x * along, cy = dy - segDir.y * along, cz = dz - segDir.z * along;
      const rad = Math.max(0.24, f.scale * 0.45) + p.radius;
      if (cx * cx + cy * cy + cz * cz > rad * rad) continue;
      if (p.pierce && p.hitIds.includes(f.id)) continue;
      const slot = this._hits[n] || (this._hits[n] = { f: null, t: 0 });
      slot.f = f; slot.t = along;
      n++;
      if (n >= this._hits.length) break;
    }
    // Small n — insertion sort by distance along the segment.
    for (let i = 1; i < n; i++) {
      const cur = this._hits[i];
      let j = i - 1;
      while (j >= 0 && this._hits[j].t > cur.t) { this._hits[j + 1] = this._hits[j]; j--; }
      this._hits[j + 1] = cur;
    }
    return n;
  }

  // ----------------------------------------------------------------- damage
  fishHP(f) {
    if (f.hp == null) f.hp = Math.max(1, f.instance.weight * 6 + f.species.strength * 40);
    return f.hp;
  }

  /** @returns {boolean} true when the fish survived */
  _hitFish(game, f, p, dir, point) {
    this.fishHP(f);
    f.hp -= p.damage;
    this.flashCrosshair();
    bus.emit('fx:impact', { position: point.clone(), normal: _a.copy(dir).negate().clone(), kind: 'flesh', scale: 1.1 });
    bus.emit('fx:hitMarker', { position: point.clone(), scale: 1.1, color: 0xff6b6b });
    game.audio?.play('harpoon_impact', { volume: 0.7, rate: rrange(0.9, 1.1), position: point.clone(), throttle: 30 });

    if (p.pierce) p.hitIds.push(f.id);
    if (p.explosive > 0) this._explode(game, point, p);

    if (f.hp > 0) {
      // Survived — flee violently, with a knockback you can actually see.
      const knock = clamp(p.damage / Math.max(0.4, f.instance.weight * 2.5), 0.6, 9);
      this._knock(f, dir, knock);
      f.state = FISH_STATE.FLEE;
      f.stateTime = 0;
      f.spooked = 2.5;
      f.interest = 0;
      f.baitRef = null;
      f.energy = 1;
      f.heading.copy(dir).setY(dir.y * 0.4 + 0.05);
      if (f.heading.lengthSq() < 1e-5) f.heading.set(1, 0, 0);
      f.heading.normalize();
      f.velocity.addScaledVector(dir, knock * 0.8);
      game.get('fish')?.scare(f.position, 7, 1.4);
      bus.emit('fx:floatText', { position: point.clone(), text: `${Math.round(p.damage)}`, color: '#ff8f6b', size: 17 });

      if (p.tethered && !p.attached) { this._attach(p, f, game); return true; }
      // Non-tethered shots punch through but lose most of their energy.
      p.vel.multiplyScalar(0.35);
      p.lastFish = f;
      return true;
    }

    this.killFish(game, f, dir, {
      shotDistance: p.travelled,
      damage: p.damage,
      doubleCatch: false,
      weaponId: p.weaponId,
    });
    // The shot carries on through a kill, slowed.
    p.vel.multiplyScalar(p.pierce ? 1 : 0.5);
    p.lastFish = null;
    if (p.tethered && !p.pierce) { p.state = 'stuck'; p.stuckT = 5; }
    return false;
  }

  _knock(f, dir, power) {
    if (!f.knockV) f.knockV = new THREE.Vector3();
    f.knockV.addScaledVector(dir, power * 3.2);
    f.knockV.y += power * 0.5;
    if (!this._knocked.includes(f)) this._knocked.push(f);
  }

  _updateKnockback(dt, game) {
    for (let i = this._knocked.length - 1; i >= 0; i--) {
      const f = this._knocked[i];
      if (!f.active || !f.knockV) { this._knocked.splice(i, 1); continue; }
      f.position.addScaledVector(f.knockV, dt);
      f.knockV.multiplyScalar(Math.pow(0.0025, dt));
      const surf = waterHeightAt(f.position.x, f.position.z);
      const bed = worldHeight(f.position.x, f.position.z);
      game.get('fish')?.keepInWater(f, surf, bed);
      if (f.knockV.lengthSq() < 0.04) { f.knockV.set(0, 0, 0); this._knocked.splice(i, 1); }
    }
  }

  /**
   * Convert a live AI fish into a physical fish, credit the catch and score
   * the trick. Shared by every weapon kind.
   */
  killFish(game, f, dir, ctx = {}) {
    const fishSys = game.get('fish');
    if (!f.active || !f.instance) return null;
    const inst = f.instance;
    const eco = game.get('economy');
    const tricks = game.get('tricks');
    const mgr = game.get('physfish');

    const waterY = waterHeightAt(f.position.x, f.position.z);
    const midAir = f.position.y > waterY;
    const headOn = dir ? dir.dot(f.heading) < -0.6 : false;

    // Hand the AI fish's mesh over so the physical fish looks identical.
    const mesh = f.mesh;
    if (mesh) { f.group.remove(mesh); f.mesh = null; f.meshKey = ''; }

    const heft = clamp01(inst.weight / 55);
    const launch = lerp(11, 2.6, heft) * (ctx.launchScale ?? 1);
    _b.copy(dir || _a.set(0, 1, 0)).multiplyScalar(launch);
    _b.y += lerp(4.5, 1.2, heft);
    const spin = lerp(14, 3, heft);

    const pf = mgr?.spawn({
      instance: inst,
      position: { x: f.position.x, y: f.position.y, z: f.position.z },
      velocity: { x: _b.x, y: _b.y, z: _b.z },
      mesh,
      angularVelocity: { x: rrange(-spin, spin), y: rrange(-spin, spin), z: rrange(-spin, spin) },
    });

    const record = eco?.recordCatch(inst, 'player');
    const trickResult = tricks?.evaluateCatch({
      instance: inst,
      method: 'harpoon',
      shotDistance: ctx.shotDistance ?? 0,
      headOn,
      midAir,
      doubleCatch: !!ctx.doubleCatch,
      fightTime: ctx.fightTime ?? 0,
      depth: Math.max(0, waterY - f.position.y),
    });

    const rarity = RARITY[inst.rarity] || RARITY.common;
    const badges = [];
    if (record === 'weight') badges.push('New Record');
    if (inst.variantId && inst.variantId !== 'normal') badges.push(VARIANT_BY_ID[inst.variantId]?.name || '');
    if (trickResult?.tricks?.length) badges.push(...trickResult.tricks.map((t) => t.name));

    const price = eco ? eco.priceFor(inst) : inst.value;
    bus.emit('catch:popup', {
      name: inst.name, rarity: rarity.name, rarityColor: rarity.color,
      weight: inst.weight, length: inst.length, value: Math.round(price * (trickResult?.mult || 1)),
      badges: badges.filter(Boolean),
    });
    game.audio?.play(inst.rarity === 'legendary' || inst.rarity === 'mythic' ? 'legendary'
      : inst.rarity === 'epic' || inst.rarity === 'rare' ? 'rare_fish' : 'record', { volume: 0.5 });

    if (pf) { pf.styleMult = trickResult?.mult || 1; pf.tricks = trickResult?.tricks || []; }

    // Kill feedback: splash if it was in the water, hit-stop on a big one.
    if (!midAir) {
      bus.emit('fx:bigSplash', { position: _a.set(f.position.x, waterY, f.position.z).clone(), scale: clamp(0.6 + inst.weight * 0.03, 0.6, 3) });
      game.audio?.play('splash_big', { volume: clamp(0.35 + inst.weight * 0.02, 0.4, 1), position: f.position.clone() });
    }
    if (inst.weight > 12 || inst.rarity === 'legendary' || inst.rarity === 'mythic') bus.emit('fx:hitStop', 0.06);
    bus.emit('player:shake', clamp01(inst.weight / 90) * 0.4 + 0.08);
    this.flashCrosshair();
    this.kills++;

    bus.emit('weapon:caught', { instance: inst, pf, tricks: trickResult, method: 'harpoon' });

    f.state = FISH_STATE.DEAD;
    f.hp = null;
    if (f.knockV) f.knockV.set(0, 0, 0);
    fishSys?.despawn(f);
    return pf;
  }

  // ---------------------------------------------------------------- impacts
  _impact(game, p, hit, dir) {
    const e = hit.entry;
    const tag = e?.tag || '';
    // Caught fish floating in the world get punched rather than pinned.
    if (tag === 'fish' && e && !e.removed) {
      const k = clamp(p.damage * 0.35, 4, 260);
      game.physics.addImpulse(e, dir.x * k, dir.y * k + k * 0.25, dir.z * k);
      game.physics.addTorqueImpulse(e, rrange(-k, k) * 0.05, rrange(-k, k) * 0.05, rrange(-k, k) * 0.05);
    }
    const kind = tag === 'boat' || tag === 'dock' ? 'wood' : p.underwater ? 'water' : 'stone';
    bus.emit('fx:impact', { position: hit.point.clone(), normal: hit.normal.clone(), kind, scale: 0.8 + p.radius * 2 });
    game.audio?.play('harpoon_impact', { volume: 0.75, rate: rrange(0.9, 1.08), position: hit.point.clone(), throttle: 40 });
    if (p.explosive > 0) this._explode(game, hit.point, p);
    if (p.kind === 'net') { this._netCatch(p, game, true); this._despawn(p); return; }

    // Stick in place, tail out along the incoming direction.
    p.pos.copy(hit.point).addScaledVector(dir, -0.12);
    p.vel.set(0, 0, 0);
    p.state = 'stuck';
    p.stuckT = 8;
    if (p.mesh) {
      p.mesh.position.copy(p.pos);
      p.mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    }
    game.get('fish')?.scare(hit.point, 6, 0.8);
  }

  _explode(game, point, p) {
    const radius = 3 + p.explosive * 1.4;
    const force = 60 + p.explosive * 90;
    game.physics.explode(point.x, point.y, point.z, radius, force);
    bus.emit('fx:explosion', { position: point.clone(), scale: clamp(0.8 + p.explosive * 0.35, 0.8, 4) });
    game.audio?.play('explosion', { volume: 0.9, position: point.clone() });
    bus.emit('player:shake', clamp01(p.explosive / 8) * 0.8);
    const fishSys = game.get('fish');
    if (fishSys) {
      fishSys.scare(point, radius * 2.5, 2);
      this._batch.length = 0;
      for (const f of fishSys.active) {
        if (f.position.distanceToSquared(point) < radius * radius) this._batch.push(f);
      }
      for (const f of this._batch) {
        this.fishHP(f);
        f.hp -= p.damage * 0.6;
        _a.copy(f.position).sub(point);
        if (_a.lengthSq() < 1e-4) _a.set(0, 1, 0);
        _a.normalize();
        if (f.hp <= 0) this.killFish(game, f, _a, { shotDistance: p.travelled, doubleCatch: this._batch.length > 1 });
        else this._knock(f, _a, 4);
      }
      this._batch.length = 0;
    }
  }

  // -------------------------------------------------------------------- net
  /** @returns {boolean} true when the net fired and was consumed */
  _netCatch(p, game, force) {
    const fishSys = game.get('fish');
    if (!fishSys) { if (force) this._despawn(p); return force; }
    const r = Math.max(1.5, p.netRadius || 5);
    const r2 = r * r;
    this._batch.length = 0;
    for (const f of fishSys.active) {
      if (!f.active || f.state === FISH_STATE.HOOKED) continue;
      if (f.position.distanceToSquared(p.pos) < r2) this._batch.push(f);
    }
    if (!this._batch.length && !force) return false;

    if (this._batch.length) {
      // Biggest last so its catch popup is the one left on screen.
      this._batch.sort((a, b) => a.instance.weight - b.instance.weight);
      const multi = this._batch.length >= 2;
      bus.emit('fx:ripple', { position: p.pos.clone(), radius: r });
      game.audio?.play('net_throw', { volume: 0.7, position: p.pos.clone(), rate: 0.85 });
      for (const f of this._batch) {
        _a.copy(f.position).sub(p.pos).setY(0.2);
        if (_a.lengthSq() < 1e-4) _a.set(0, 1, 0);
        _a.normalize();
        this.killFish(game, f, _a, { shotDistance: p.travelled, doubleCatch: multi, launchScale: 0.35 });
      }
      if (multi) {
        bus.emit('toast', { text: `Net haul — ${this._batch.length} fish`, kind: 'gold' });
        bus.emit('fx:hitStop', 0.06);
      }
      this._batch.length = 0;
      this._despawn(p);
      return true;
    }
    this._despawn(p);
    return true;
  }

  // ------------------------------------------------------------------- beam
  _fireBeam(game, item, stats, player, origin, dir) {
    const phys = game.physics;
    const range = stats.range ?? 120;
    const hit = phys.raycast(origin, dir, range, HIT_MASK, null);
    const end = hit ? hit.distance : range;
    const fishSys = game.get('fish');

    // Pierce every fish along the beam.
    if (fishSys) {
      this._batch.length = 0;
      for (const f of fishSys.active) {
        if (!f.active || f.state === FISH_STATE.HOOKED) continue;
        const dx = f.position.x - origin.x, dy = f.position.y - origin.y, dz = f.position.z - origin.z;
        const along = dx * dir.x + dy * dir.y + dz * dir.z;
        if (along < 0 || along > end) continue;
        const cx = dx - dir.x * along, cy = dy - dir.y * along, cz = dz - dir.z * along;
        const rad = Math.max(0.5, f.scale * 0.55);
        if (cx * cx + cy * cy + cz * cz > rad * rad) continue;
        this._batch.push(f);
      }
      this._batch.sort((a, b) => a.instance.weight - b.instance.weight);
      const multi = this._batch.length >= 2;
      for (const f of this._batch) {
        this.fishHP(f);
        f.hp -= stats.damage ?? 100;
        if (f.hp <= 0) {
          this.killFish(game, f, dir, { shotDistance: origin.distanceTo(f.position), doubleCatch: multi });
        } else {
          this._knock(f, dir, 6);
          f.state = FISH_STATE.FLEE; f.stateTime = 0; f.spooked = 3;
        }
      }
      if (this._batch.length) this.flashCrosshair();
      this._batch.length = 0;
    }

    _b.copy(origin).addScaledVector(dir, end);
    if (hit) {
      bus.emit('fx:impact', { position: hit.point.clone(), normal: hit.normal.clone(), kind: 'metal', scale: 1.4 });
    }
    if (stats.explosive > 0) {
      this._explode(game, _b, { explosive: stats.explosive, damage: stats.damage ?? 100, travelled: end });
    }

    // Beam visual — a pooled projectile in 'beam' state.
    const p = this._acquire();
    if (!p) return;
    p.active = true;
    p.kind = 'beam';
    p.weaponId = item.id;
    p.state = 'beam';
    p.life = 0;
    p.maxLife = 0.3;
    p.beamLen = end;
    p.beamWidth = 0.16;
    p.pos.copy(origin);
    p.mesh = this._acquireMesh('beam');
    p.mesh.position.copy(origin);
    p.mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    p.mesh.scale.set(p.beamWidth, p.beamWidth, end);
    p.tethered = false;
    p.line = null;
    this.projectiles.push(p);
  }

  // ---------------------------------------------------------------- tethers
  _attach(p, f, game) {
    p.attached = f;
    p.state = 'attached';
    p.vel.set(0, 0, 0);
    f.state = FISH_STATE.HOOKED;
    f.stateTime = 0;
    f.spooked = 2;
    p.fightTime = 0;
    p.slackT = 0;
    game.audio?.play('fish_thrash', { volume: 0.6, position: f.position.clone() });
    bus.emit('weapon:tethered', { instance: f.instance });
  }

  _detach(p, respawnAI = true) {
    const f = p.attached;
    p.attached = null;
    if (f && f.active && respawnAI) {
      f.state = FISH_STATE.FLEE;
      f.stateTime = 0;
      f.spooked = 2.5;
    }
    p.state = 'fly';
    p.life = p.maxLife;
  }

  _updateTether(dt, game, p, player, holding) {
    const f = p.attached;
    if (!f || !f.active) { this._detach(p, false); this._despawn(p); return; }
    const inst = f.instance;
    p.fightTime += dt;

    // The harpoon rides the fish.
    _a.copy(f.heading).multiplyScalar(-inst.length * 0.35);
    p.pos.copy(f.position).add(_a);
    if (p.mesh) {
      p.mesh.position.copy(p.pos);
      _q.setFromUnitVectors(FWD_Z, _b.copy(f.heading).normalize());
      p.mesh.quaternion.slerp(_q, 1 - Math.pow(0.002, dt));
    }

    _eye.copy(player.eyePosition);
    _b.copy(_eye).sub(f.position);
    const dist = _b.length();
    if (dist > 1e-4) _b.multiplyScalar(1 / dist);

    if (holding) {
      p.slackT = 0;
      // Reel: heavier fish come in slower and fight harder.
      const pull = lerp(9, 1.4, clamp01(inst.weight / 120)) * lerp(0.55, 1, clamp01(p.damage / 400));
      f.position.addScaledVector(_b, pull * dt);
      // Fish thrashes against the rope.
      const thrash = lerp(0.6, 2.6, clamp01(f.species.speed));
      f.position.x += Math.sin(p.fightTime * 8.5) * thrash * dt;
      f.position.z += Math.cos(p.fightTime * 7.3) * thrash * dt;
      f.heading.copy(_b).negate();
      p.line?.setTension?.(clamp01(0.35 + clamp01(inst.weight / 150)));
      if (rchance(dt * 3)) {
        bus.emit('ocean:ripple', { x: f.position.x, z: f.position.z, strength: 0.4 });
      }
      game.audio?.play('reel_click', { volume: 0.25, rate: rrange(0.9, 1.2), throttle: 110 });

      // Huge fish drag the player, exactly like a hooked fish on the rod.
      if (inst.weight > 25 && player.grounded) {
        const dragK = clamp01((inst.weight - 25) / 130);
        player.velocity.addScaledVector(_b.clone().negate(), dragK * 9 * dt);
        if (dragK > 0.35) player.shake = Math.max(player.shake, dragK * 0.3);
      }
    } else {
      // Slack line: the fish runs, and eventually tears the barb out.
      p.slackT += dt;
      f.position.addScaledVector(f.heading, lerp(1, 4.5, clamp01(f.species.speed)) * dt);
      p.line?.setTension?.(0.05);
      if (p.slackT > 4.5) {
        game.audio?.play('line_snap', { volume: 0.6 });
        bus.emit('toast', { text: 'The harpoon tore free', kind: 'warn' });
        this._detach(p, true);
        this._despawn(p);
        return;
      }
    }

    const surf = waterHeightAt(f.position.x, f.position.z);
    const bed = worldHeight(f.position.x, f.position.z);
    f.position.y = clamp(f.position.y, bed + 0.25, surf + 0.4);
    f.group.position.copy(f.position);
    f.group.updateMatrix();

    // Landed — pull it clean out of the water.
    if (dist < 2.4) {
      _c.copy(_b).negate();
      this.killFish(game, f, _c, {
        shotDistance: p.travelled, fightTime: p.fightTime, launchScale: 0.5,
      });
      p.attached = null;
      this._despawn(p);
    }
  }

  // ---------------------------------------------------------------- suction
  _updateSuction(dt, game, item, stats, player) {
    const fishSys = game.get('fish');
    const R = stats.suction ?? 20;
    _eye.copy(player.eyePosition);
    player.forward(_fwd);

    // Cone volume in front of the player.
    this.suctionCone.visible = true;
    this.suctionCone.position.copy(_eye).addScaledVector(_fwd, 0.4);
    this.suctionCone.quaternion.setFromUnitVectors(FWD_Z, _fwd);
    const wob = 1 + Math.sin(game.time * 26) * 0.05;
    this.suctionCone.scale.set(R * 0.7 * wob, R * 0.7 * wob, R);

    this._startSuctionLoop(game);
    this._suctionT += dt;
    if (this._suctionT > 0.09) {
      this._suctionT = 0;
      bus.emit('weapon:recoil', 0.08);
      player.recoil.x += 0.0016;
      _a.copy(_eye).addScaledVector(_fwd, R * 0.35);
      bus.emit('fx:bubbles', { position: _a.clone(), count: 3, rise: -0.4, spread: R * 0.12 });
    }

    if (!fishSys) return;
    const R2 = R * R;
    for (let i = fishSys.active.length - 1; i >= 0; i--) {
      const f = fishSys.active[i];
      if (!f.active || f.state === FISH_STATE.DEAD) continue;
      _a.copy(f.position).sub(_eye);
      const d = _a.length();
      if (d > R || d < 1e-4) continue;
      _a.multiplyScalar(1 / d);
      if (_a.dot(_fwd) < SUCTION_COS) continue;

      // Drag toward the muzzle; heavy fish resist.
      const pull = lerp(26, 6, clamp01(d / R)) / (1 + f.instance.weight * 0.12);
      f.position.addScaledVector(_a, -pull * dt);
      f.state = FISH_STATE.HOOKED;   // suppress AI steering while in the beam
      f.spooked = 2;
      f.heading.copy(_a).negate();
      const surf = waterHeightAt(f.position.x, f.position.z);
      const bed = worldHeight(f.position.x, f.position.z);
      f.position.y = clamp(f.position.y, bed + 0.2, surf + 0.5);
      f.group.position.copy(f.position);
      f.group.updateMatrix();
      this.fishHP(f);
      f.hp -= (stats.damage ?? 100) * dt * 0.5;

      if (d < 2.2 || f.hp <= 0) {
        _b.copy(_a).negate();
        this.killFish(game, f, _b, { shotDistance: d, launchScale: 0.3 });
        this.flashCrosshair();
      }
    }
    // Anything left in the cone is now terrified.
    _a.copy(_eye).addScaledVector(_fwd, R * 0.5);
    fishSys.scare(_a, R * 0.5, 0.8);
  }

  _startSuctionLoop(game) {
    if (this._suckLoopOn) return;
    this._suckLoopOn = true;
    const h = game.audio?.loop('underwater_whoosh', { volume: 0.55, fadeIn: 0.12 });
    h?.setVolume?.(0.55, 0.12);
  }
  _stopSuctionLoop() {
    if (!this._suckLoopOn) return;
    this._suckLoopOn = false;
    this.suctionCone.visible = false;
    this.game.audio?.stopLoop('underwater_whoosh', 0.18);
  }

  // ------------------------------------------------------------------ melee
  _updateMelee(dt, game, item, stats, input, player) {
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt);
    if (this.cooldown > 0 || !input.mousePressed(0)) return;
    this.cooldown = 1 / Math.max(0.15, stats.rate ?? 1);
    this.swingT = 0.22;

    bus.emit('weapon:recoil', 0.55);
    player.recoil.x += 0.006;
    game.audio?.play('cast_whoosh', { volume: 0.3, rate: rrange(1.25, 1.5) });

    _eye.copy(player.eyePosition);
    player.forward(_fwd);
    const range = (stats.range ?? 2.4) + 0.4;
    const centre = _b.copy(_eye).addScaledVector(_fwd, range * 0.55);
    const hitR = range * 0.62;
    let connected = false;

    // ---- physical (already-caught) fish ----
    const mgr = game.get('physfish');
    if (mgr) {
      for (let i = mgr.list.length - 1; i >= 0; i--) {
        const pf = mgr.list[i];
        if (pf.held) continue;
        const pos = game.physics.getPosition(pf.entry, _a);
        if (pos.distanceTo(centre) > hitR + pf.len * 0.5) continue;
        connected = true;
        this._meleeHitPhysical(game, item, stats, pf, pos, player);
      }
    }

    // ---- live AI fish ----
    const fishSys = game.get('fish');
    if (fishSys && (stats.damage ?? 0) > 0) {
      this._batch.length = 0;
      for (const f of fishSys.active) {
        if (!f.active || f.state === FISH_STATE.HOOKED) continue;
        if (f.position.distanceTo(centre) > hitR + f.scale * 0.5) continue;
        this._batch.push(f);
      }
      for (const f of this._batch) {
        connected = true;
        this.fishHP(f);
        f.hp -= stats.damage;
        _a.copy(f.position).sub(_eye);
        if (_a.lengthSq() < 1e-4) _a.copy(_fwd);
        _a.normalize();
        game.audio?.play('club_hit', { volume: 0.6, rate: rrange(0.92, 1.1), position: f.position.clone(), throttle: 40 });
        bus.emit('fx:impact', { position: f.position.clone(), normal: _a.clone().negate(), kind: 'flesh', scale: 0.9 });
        if (f.hp <= 0) this.killFish(game, f, _a, { shotDistance: 0, launchScale: 0.6 });
        else { this._knock(f, _a, clamp(stats.knockback ?? 3, 1, 10)); f.state = FISH_STATE.FLEE; f.stateTime = 0; f.spooked = 2; }
      }
      this._batch.length = 0;
    }

    if (connected) {
      this.flashCrosshair();
      bus.emit('player:shake', 0.12);
    }
  }

  _meleeHitPhysical(game, item, stats, pf, pos, player) {
    const phys = game.physics;
    _a.copy(pos).sub(_eye);
    if (_a.lengthSq() < 1e-4) _a.copy(_fwd);
    _a.normalize();

    if (stats.pull) {
      // Gaff: drag it toward you instead of away.
      _c.copy(_eye).sub(pos);
      const d = _c.length() || 1;
      _c.multiplyScalar(1 / d);
      const k = stats.pull * clamp(pf.mass, 0.5, 40) * 0.35;
      phys.addImpulse(pf.entry, _c.x * k, _c.y * k + k * 0.4, _c.z * k);
      game.audio?.play('club_hit', { volume: 0.45, rate: 0.8, position: pos.clone(), throttle: 60 });
      bus.emit('fx:impact', { position: pos.clone(), normal: _c.clone(), kind: 'flesh', scale: 0.8 });
    }

    if (stats.process) {
      // Filleting knife: clean the fish where it lies, for a better price.
      const lvl = Math.min(2, (pf.processLevel || 0) + 1);
      if (lvl !== pf.processLevel) {
        pf.processLevel = lvl;
        bus.emit('fx:floatText', { position: _b.copy(pos).add(_d.set(0, 0.5, 0)).clone(), text: '+CLEANED', color: '#5ddb6a', size: 20 });
        game.audio?.play('club_hit', { volume: 0.4, rate: 1.5, position: pos.clone() });
        bus.emit('fx:impact', { position: pos.clone(), normal: _a.clone().negate(), kind: 'flesh', scale: 0.6 });
      } else {
        bus.emit('fx:floatText', { position: _b.copy(pos).add(_d.set(0, 0.5, 0)).clone(), text: 'already cleaned', color: '#b8c0c8', size: 15 });
      }
    }

    if (stats.freshness) {
      // Club: dispatch it cleanly — a fresh fish is worth more.
      if (pf.alive) {
        pf.alive = false;
        pf.energy = 0;
        pf.freshnessBonus = (pf.freshnessBonus || 1) * stats.freshness;
        bus.emit('fx:floatText', { position: _b.copy(pos).add(_d.set(0, 0.5, 0)).clone(), text: '+FRESH', color: '#ffc22e', size: 20 });
        bus.emit('fx:hitStop', 0.05);
      }
      game.audio?.play('club_hit', { volume: 0.85, rate: rrange(0.9, 1.06), position: pos.clone() });
      bus.emit('fx:impact', { position: pos.clone(), normal: _a.clone().negate(), kind: 'flesh', scale: 1.2 });
    }

    if (stats.scoop) {
      // Landing net: scoop it straight into storage.
      const inv = game.get('inventory');
      if (pf.instance.weight <= (stats.scoopWeight ?? 25) && inv?.storeFish(pf.instance, {
        styleMult: pf.styleMult || 1, processLevel: pf.processLevel || 0, freshness: pf.freshnessBonus || 1,
      })) {
        game.audio?.play('pickup', { volume: 0.6, rate: 1.15 });
        bus.emit('fx:sparkle', { position: pos.clone(), count: 8, color: '#5ddb6a' });
        game.get('physfish').despawn(pf);
        return;
      }
      if (pf.instance.weight > (stats.scoopWeight ?? 25)) {
        bus.emit('fx:floatText', { position: _b.copy(pos).add(_d.set(0, 0.5, 0)).clone(), text: `too heavy — ${formatWeight(pf.instance.weight)}`, color: '#ff6b6b', size: 15 });
      }
    }

    const knock = (stats.knockback ?? 0) * clamp(pf.mass, 0.4, 30) * 0.6;
    if (knock > 0) {
      phys.addImpulse(pf.entry, _a.x * knock, _a.y * knock + knock * 0.5, _a.z * knock);
      phys.addTorqueImpulse(pf.entry, rrange(-1, 1) * knock * 0.1, rrange(-1, 1) * knock * 0.14, rrange(-1, 1) * knock * 0.1);
    }
    if ((stats.damage ?? 0) > 0 && !stats.freshness && !stats.process && !stats.pull) {
      game.audio?.play('club_hit', { volume: 0.5, rate: rrange(1.05, 1.25), position: pos.clone(), throttle: 40 });
    }
  }

  // ------------------------------------------------------------------ misc
  flashCrosshair() { this._crossT = 0.12; }

  get liveProjectiles() { return this.projectiles.length; }

  dispose() {
    this.clearAll();
    for (const l of this._lines) l.dispose(this.game.scene);
    this._lines.length = 0;
  }

  save() { return {}; }
  load() { /* the equipped weapon lives in Inventory; nothing else persists */ }
}

function makeProjectile() {
  return {
    active: false, kind: '', weaponId: '', mesh: null, line: null,
    pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 0, 1),
    gravity: 9, damage: 10, range: 40, travelled: 0, life: 0, maxLife: 10,
    tethered: false, explosive: 0, netRadius: 0, open: 0, radius: 0.16,
    state: 'idle', stuckT: 0, underwater: false, attached: null, slackT: 0,
    fightTime: 0, spin: 0, pierce: false, hitIds: [], lastFish: null,
    beamLen: 0, beamWidth: 0.16,
  };
}
