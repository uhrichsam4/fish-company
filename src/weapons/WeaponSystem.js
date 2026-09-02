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
 * Projectiles are simulated by hand — position/velocity integrated per frame
 * and swept against the world with one raycast along each frame's travel
 * segment — rather than as Rapier dynamic bodies. That keeps 24 live
 * projectiles essentially free, makes water drag / tethering / sticking
 * trivial to author, and stops the solver fighting a 60 m/s body.
 *
 * AI fish carry no colliders, so every step also runs a capsule test of the
 * travel segment against `fish.active`.
 *
 * Everything is pooled: projectiles, their meshes and the verlet tether ropes.
 */

const MAX_PROJECTILES = 24;
const MAX_LINES = 4;
const MAX_SWEEP_HITS = 8;
/** Ray membership PROJECTILE — the player capsule filters us out explicitly. */
const HIT_MASK = groups(
  CG.PROJECTILE,
  CG.TERRAIN | CG.PROP | CG.BOAT | CG.DEBRIS | CG.FISH | CG.WORKER,
);
const FWD_Z = new THREE.Vector3(0, 0, 1);
const SUCTION_COS = Math.cos(35 * Math.PI / 180);

// Scratch vectors. `_eye`/`_fwd`/`_rgt`/`_muzzle` are owned by the aiming
// helpers; `_a.._g` are free for local use inside a single method.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _pos = new THREE.Vector3();
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
    this.swingT = 0;
    this.item = null;

    /** @type {Array<object>} live projectiles (a subset of `_pool`) */
    this.projectiles = [];
    this._pool = [];
    this._lines = [];
    this._meshPool = new Map();
    this._knocked = [];
    this._hits = [];
    this._batch = [];
    this._boom = [];

    this._crossT = 0;
    this._crossShown = false;
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
    for (let i = 0; i < MAX_SWEEP_HITS; i++) this._hits.push({ f: null, t: 0 });

    this.suctionCone = buildSuctionCone();
    this.suctionCone.visible = false;
    this.root.add(this.suctionCone);

    bus.on('equipment:changed', ({ slot }) => { if (slot === 'weapon' || slot === 'tool') this._resetWeapon(); });
    bus.on('hotbar:changed', () => { this.firing = false; this._stopSuction(); });
    bus.on('game:newgame', () => this.clearAll());
    return this;
  }

  // ------------------------------------------------------------------ state
  _resetWeapon() {
    this.cooldown = 0;
    this.reloadT = 0;
    this._weaponId = null;
    this.firing = false;
    this._stopSuction();
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

    if (weapon && canAct) {
      this._updateWeapon(dt, game, weapon, weapon.stats || {}, input, player);
    } else {
      this._setAiming(false, player);
      this.firing = false;
      this._stopSuction();
    }
    if (melee && canAct) this._updateMelee(dt, game, melee, melee.stats || {}, input, player);

    // Aim readout at 12 Hz. Resolved whether or not a tool is held, because
    // the case worth teaching is a player standing at a tree holding a fishing
    // rod and wondering why nothing happens.
    this._aimT = (this._aimT || 0) + dt;
    if (this._aimT >= 1 / 12) { this._aimT = 0; this._updateAimTarget(game, melee, player); }

    this.loaded = this.reloadT <= 0 && this.cooldown <= 0 && this.ammoInMag > 0;

    this._updateKnockback(dt, game);
    this._updateProjectiles(dt, game, input, player);
  }

  /** Crosshair is written late so Interaction (order 65) can't clobber it. */
  lateUpdate(dt, game) {
    if (this._crossT > 0) { game.get('hud')?.setCrosshair('hit'); this._crossShown = true; }
    else if (this._crossShown) { this._crossShown = false; game.get('hud')?.setCrosshair(''); }
  }

  // ---------------------------------------------------------------- weapons
  _updateWeapon(dt, game, item, stats, input, player) {
    this._setAiming(input.mouseDown(1), player);

    if (stats.continuous) {
      const on = input.mouseDown(0);
      this.firing = on;
      if (on) this._updateSuction(dt, game, stats, player);
      else this._stopSuction();
      return;
    }

    if (input.justPressed('KeyR') && this.reloadT <= 0 && this.ammoInMag < this.magSize) {
      this._startReload(game, stats);
      return;
    }
    if (this.reloadT > 0) return;

    // High rate-of-fire weapons are full auto; everything else is semi.
    const wants = (stats.rate ?? 1) >= 3 ? input.mouseDown(0) : input.mousePressed(0);
    if (!wants || this.cooldown > 0) return;

    // Processing a fish is a strike the player aims and throws, not something
    // the game does for them on pickup: look down into your own bucket with a
    // spear or knife in hand and hit it. Consumes the click so the same swing
    // does not also launch a spear into the sand.
    if (this._tryProcessCatch(game, item, stats, player)) return;
    if (this.ammoInMag <= 0) { this._startReload(game, stats); return; }
    this._fire(game, item, stats, player);
  }

  /**
   * @returns {boolean} true if the swing was spent on the bucket.
   */
  _tryProcessCatch(game, item, stats, player) {
    const bucket = game.get('bucket');
    if (!bucket) return false;
    // Only close-quarters tools; a harpoon gun is not a filleting implement.
    const melee = (stats.range ?? 99) <= 40 && /spear|knife|harpoon/i.test(`${item.id} ${stats.projectile || ''}`);
    if (!melee) return false;
    if (player.pitch > -0.5) return false;              // must actually be looking down at it
    const target = bucket.firstAlive();
    if (!target) return false;

    bucket.process(target.index);
    this.swingT = 0.22;
    this.cooldown = Math.max(this.cooldown, 0.35);
    const pos = player.position.clone();
    game.audio?.play('spear_thrust', { volume: 0.5, rate: 1.0, position: pos });
    game.audio?.play('spear_fish_hit', { volume: 0.6, rate: 0.98, position: pos });
    bus.emit('player:shake', 0.06);
    bus.emit('fx:sparkle', { position: pos, count: 5, color: '#9fb7c4' });
    const left = bucket.aliveCount;
    bus.emit('toast', {
      text: left ? `Processed — ${left} still flopping.` : 'Whole catch processed.',
      kind: left ? '' : 'success', duration: 2200,
    });
    return true;
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
    this.cooldown = 1 / Math.max(0.05, stats.rate ?? 1);
    this.ammoInMag--;
    this.shotsFired++;

    this._muzzleOf(player, _muzzle);
    player.forward(_fwd);

    // Converge on whatever the crosshair is actually over — a fish if one is
    // under the reticle, otherwise the world behind it. Without this the
    // muzzle's lateral offset throws every shot wide, and a lobbed spear arcs
    // over the fish to land on the seabed behind it.
    this._aimPoint(game, stats, _g);
    // Solve the launch angle so the arc actually passes through the reticle.
    // Flat weapons barely move; a lobbed spear gets the elevation a player
    // would instinctively add, so the crosshair never lies.
    this._solveLaunch(_muzzle, _g, stats, _d);
    if (!Number.isFinite(_d.x) || _d.lengthSq() < 1e-6) _d.copy(_fwd);

    // Hip fire wanders a little; aiming down the weapon is dead accurate.
    const spread = this.aiming ? 0 : lerp(0.0015, 0.009, clamp01(Math.hypot(player.velocity.x, player.velocity.z) / 8));
    if (spread > 0) {
      _d.x += rrange(-spread, spread); _d.y += rrange(-spread, spread); _d.z += rrange(-spread, spread);
      _d.normalize();
    }

    this._recoil(game, stats, player, _muzzle, _d);

    const kind = stats.projectile || 'spear';
    if (kind === 'beam') this._fireBeam(game, item, stats, _muzzle, _d);
    else this._spawnProjectile(game, item, stats, kind, _muzzle, _d, player);

    if (this.ammoInMag <= 0) this._startReload(game, stats);
    bus.emit('weapon:fired', { id: item.id, kind, ammo: this.ammoInMag });
  }

  /**
   * Where the crosshair is pointing: the nearest of the world surface and any
   * AI fish under the reticle (fish carry no colliders, so they need their own
   * sweep). `_eye` / `_fwd` must already be current.
   */
  _aimPoint(game, stats, out) {
    const reach = Math.max(6, stats.range ?? 40);
    let dist = reach;
    const hit = game.physics.raycast(_eye, _fwd, reach, HIT_MASK, null);
    if (hit) dist = Math.max(1.5, hit.distance);
    const fishSys = game.get('fish');
    let target = null;
    if (fishSys) {
      for (const fish of fishSys.active) {
        if (!fish.active || fish.state === FISH_STATE.HOOKED) continue;
        const dx = fish.position.x - _eye.x, dy = fish.position.y - _eye.y, dz = fish.position.z - _eye.z;
        const along = dx * _fwd.x + dy * _fwd.y + dz * _fwd.z;
        if (along < 0.6 || along > dist) continue;
        const cx = dx - _fwd.x * along, cy = dy - _fwd.y * along, cz = dz - _fwd.z * along;
        const rad = Math.max(0.6, fish.scale * 0.8) + along * 0.02;
        if (cx * cx + cy * cy + cz * cz > rad * rad) continue;
        dist = along;
        target = fish;
      }
    }
    out.copy(_eye).addScaledVector(_fwd, dist);
    if (target) {
      // Lead a moving fish by most of its travel during the shot's flight.
      // A full lead would be an aimbot; none at all means a fish that is
      // simply swimming dodges every shot you place perfectly on it.
      const speed = Math.max(6, stats.speed ?? 30);
      const under = target.position.y < waterHeightAt(target.position.x, target.position.z);
      const flight = Math.min(1.2, dist / (speed * (under ? 0.5 : 0.9)));
      out.addScaledVector(target.velocity, flight * 0.7);
    }
    return out;
  }

  /**
   * Launch direction that actually lands on `to`, drag included.
   *
   * The closed-form ballistic angle ignores drag, which is fine for a flat
   * 62 m/s harpoon and badly wrong for a thrown spear that loses most of its
   * speed the moment it touches water. Seed with the closed form, then run a
   * few cheap forward simulations of the real integrator and correct the
   * elevation. Only runs on the trigger pull.
   */
  _solveLaunch(from, to, stats, out) {
    const speed = stats.speed ?? 30;
    const gravity = stats.gravity ?? 0;
    this._ballisticDir(from, to, speed, gravity, out);
    if (gravity <= 0.01) return out;
    let fx = to.x - from.x, fz = to.z - from.z;
    const X = Math.hypot(fx, fz);
    if (X < 0.5) return out;
    fx /= X; fz /= X;
    let tan = out.y / Math.max(1e-4, Math.hypot(out.x, out.z));
    // The surface barely moves over one shot, so one sample is plenty here.
    const waterY = waterHeightAt(to.x, to.z);
    const airK = stats.projectile === 'net' ? 0.45 : 0.86;
    const spent2 = Math.pow(Math.max(3, speed * 0.22), 2);
    for (let i = 0; i < 4; i++) {
      const y = this._simDrop(from, fx, fz, tan, speed, gravity, airK, spent2, waterY, X);
      if (y === null) { tan += 0.3; continue; }
      const err = to.y - y;
      if (Math.abs(err) < 0.1) break;
      tan += err / X;
    }
    tan = clamp(tan, -6, 6);
    const inv = 1 / Math.sqrt(1 + tan * tan);
    return out.set(fx * inv, tan * inv, fz * inv);
  }

  /** Height of the simulated arc after `targetX` metres of ground track. */
  _simDrop(from, fx, fz, tan, speed, gravity, airK, spent2, waterY, targetX) {
    const inv = 1 / Math.sqrt(1 + tan * tan);
    let vx = fx * speed * inv, vy = tan * speed * inv, vz = fz * speed * inv;
    let px = from.x, py = from.y, pz = from.z, ground = 0;
    const dt = 1 / 40;
    for (let i = 0; i < 170; i++) {
      const uw = py <= waterY;
      vy -= gravity * (uw ? 0.3 : 1) * dt;
      const k = uw ? ((vx * vx + vy * vy + vz * vz) > spent2 ? 0.14 : 0.55) : airK;
      const m = Math.pow(k, dt);
      vx *= m; vy *= m; vz *= m;
      const nx = px + vx * dt, ny = py + vy * dt, nz = pz + vz * dt;
      const step = Math.hypot(nx - px, nz - pz);
      if (ground + step >= targetX) {
        return py + (ny - py) * ((targetX - ground) / Math.max(1e-5, step));
      }
      ground += step;
      px = nx; py = ny; pz = nz;
      if (py < waterY - 400) break;
    }
    return null;
  }

  /**
   * Low-arc ballistic launch direction from `from` to `to` at `speed` under
   * `gravity`. Falls back to a 45-degree lob when the target is out of range.
   */
  _ballisticDir(from, to, speed, gravity, out) {
    out.copy(to).sub(from);
    if (gravity <= 0.01) return out.normalize();
    const y = out.y;
    out.y = 0;
    const x = out.length();
    if (x < 0.05) { out.set(0, y >= 0 ? 1 : -1, 0); return out; }
    out.multiplyScalar(1 / x);
    const v2 = speed * speed;
    const disc = v2 * v2 - gravity * (gravity * x * x + 2 * y * v2);
    if (disc < 0) { out.y = 1; return out.normalize(); }
    out.y = (v2 - Math.sqrt(disc)) / (gravity * x);
    return out.normalize();
  }

  _recoil(game, stats, player, origin, dir) {
    const r = stats.recoil ?? 2;
    bus.emit('weapon:recoil', stats.recoil ? stats.recoil / 10 : 0.25);
    // Real camera kick — Player damps `recoil` back to zero every frame.
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
    // Startle only what is right on top of you. A wide scare on the trigger
    // pull makes every fish dodge the shot before it has left the muzzle.
    game.get('fish')?.scare(origin, stats.recoil ? 4.5 : 2.5, 0.8);
  }

  // ------------------------------------------------------------ projectiles
  _acquire() {
    for (const p of this._pool) if (!p.active) return p;
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
    const launchSpeed = stats.speed ?? 30;
    p.vel.copy(dir).multiplyScalar(launchSpeed);
    p.spentSpeed = Math.max(3, launchSpeed * 0.22);
    // Inherit the shooter's motion so running shots stay connected to you.
    if (player) p.vel.addScaledVector(player.velocity, 0.15);
    p.dir.copy(dir);
    p.shotDir.copy(dir);
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
    p.fightTime = 0;
    p.lastFish = null;
    p.hitIds.length = 0;
    p.spin = rrange(-2.4, 2.4);
    p.radius = kind === 'heavy_harpoon' ? 0.26 : kind === 'net' ? 0.3 : 0.16;
    p.underwater = p.pos.y < waterHeightAt(p.pos.x, p.pos.z);

    p.mesh = this._acquireMesh(kind);
    p.mesh.position.copy(p.pos);
    p.mesh.quaternion.setFromUnitVectors(FWD_Z, _a.copy(p.vel).normalize());
    if (kind === 'net') {
      // The mesh is authored at unit radius; scale it to the net it actually
      // casts so the visual matches the capture disc.
      p.mesh.scale.setScalar(Math.max(1.2, p.netRadius || 5));
      p.mesh.userData.setOpen?.(0);
    } else {
      p.mesh.scale.setScalar(1);
    }

    if (p.tethered) {
      p.line = this._acquireLine();
      if (p.line) { p.line.reset(origin, p.pos); p.line.setVisible(true); p.line.setTension(0.2); }
    }
    this.projectiles.push(p);
    return p;
  }

  _despawn(p) {
    if (!p.active) return;
    p.active = false;
    const f = p.attached;
    p.attached = null;
    if (f && f.active && f.state === FISH_STATE.HOOKED) {
      f.state = FISH_STATE.FLEE; f.stateTime = 0; f.spooked = 2;
    }
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

      // ---------------------------------------------------- hitscan beam fx
      if (p.state === 'beam') {
        const t = clamp01(p.life / p.maxLife);
        if (p.mesh) {
          const w = p.beamWidth * lerp(1, 3.4, t * t) * (1 - t * 0.9);
          p.mesh.scale.set(w, w, p.beamLen);
        }
        if (p.life >= p.maxLife) this._despawn(p);
        continue;
      }

      // ------------------------------------------------------------- stuck
      if (p.state === 'stuck') {
        p.stuckT -= dt;
        if (p.line) p.line.update(dt, _muzzle, p.pos, 0.6);
        if (p.stuckT <= 0) this._despawn(p);
        continue;
      }

      // ---------------------------------------------------------- tethered
      if (p.state === 'attached') {
        this._updateTether(dt, game, p, player, holding);
        if (p.active && p.line) p.line.update(dt, _muzzle, p.pos, p.slackT > 0 ? 0.5 : 0.04);
        continue;
      }

      // ------------------------------------------------- integrate & sweep
      p.prev.copy(p.pos);
      p.vel.y -= p.gravity * (p.underwater ? 0.3 : 1) * dt;
      // Underwater drag is brutal on purpose: a harpoon that flies 80 m
      // through air should die within ~20 m of water.
      // Water costs roughly two-thirds of the weapon's reach. Once a shot is
      // spent it stops crawling and simply sinks.
      const spent = p.spentSpeed * p.spentSpeed;
      const dragK = p.underwater
        ? (p.vel.lengthSq() > spent ? 0.14 : 0.55)
        : (p.kind === 'net' ? 0.45 : 0.86);
      p.vel.multiplyScalar(Math.pow(dragK, dt));
      p.pos.addScaledVector(p.vel, dt);

      const segLen = p.pos.distanceTo(p.prev);
      p.travelled += segLen;
      if (segLen > 1e-5) _c.copy(p.pos).sub(p.prev).multiplyScalar(1 / segLen);
      else _c.copy(p.dir);
      p.dir.copy(_c);

      this._checkWater(p, game, dt);
      if (!p.active) continue;

      // Nets bloom open shortly after launch.
      if (p.kind === 'net') {
        p.open = clamp01(p.open + dt * 3.2);
        p.mesh?.userData.setOpen?.(p.open);
        if (p.open >= 1) { this._netCatch(p, game, false); if (!p.active) continue; }
      }

      // ---- world sweep + fish sweep; nearest wins ----
      let hitDist = Infinity;
      let worldHit = null;
      if (segLen > 1e-5) {
        worldHit = phys.raycast(p.prev, _c, segLen + p.radius, HIT_MASK, null);
        if (worldHit) hitDist = worldHit.distance;
      }
      let fishHit = null;
      if (fishSys && this._sweepFish(p, fishSys, _c, segLen) > 0 && this._hits[0].t < hitDist) {
        hitDist = this._hits[0].t;
        fishHit = this._hits[0].f;
      }

      if (fishHit) {
        _e.copy(p.prev).addScaledVector(_c, hitDist);
        this._hitFish(game, fishHit, p, _c, _e);
        if (!p.active || p.state !== 'fly') continue;
      } else if (worldHit) {
        this._impact(game, p, worldHit, _c);
        continue;
      }

      // ---- mesh transform ----
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
        if (p.vel.lengthSq() > 0.01) {
          _q.setFromUnitVectors(FWD_Z, _a.copy(p.vel).normalize());
          if (p.kind === 'net') { p.mesh.quaternion.copy(_q); p.mesh.rotateZ(p.life * p.spin); }
          else p.mesh.quaternion.slerp(_q, 1 - Math.pow(0.0001, dt));
        }
      }
      if (p.line) p.line.update(dt, _muzzle, p.pos, clamp01(0.55 - p.travelled * 0.012));

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
      const above = p.prev.y - waterHeightAt(p.prev.x, p.prev.z);
      const below = p.pos.y - wNow;
      const t = clamp01(above / Math.max(1e-4, above - below));
      _b.lerpVectors(p.prev, p.pos, t);
      _b.y = wNow;
      const sc = clamp(0.5 + p.radius * 3 + p.vel.length() * 0.012, 0.4, 2.4);
      bus.emit('fx:splash', { position: _b.clone(), scale: sc });
      bus.emit('ocean:ripple', { x: _b.x, z: _b.z, strength: clamp01(sc * 0.5) });
      game.audio?.play('splash_medium', {
        volume: clamp(0.35 + sc * 0.25, 0.3, 0.9), position: _b.clone(), throttle: 40,
      });
      // Entering water costs a big chunk of speed immediately.
      p.vel.multiplyScalar(0.55);
      if (p.kind === 'net') this._netCatch(p, game, true);
      return;
    }
    if (p.underwater && p.pos.y > wNow + 0.05) { p.underwater = false; return; }
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
   * Results land in `this._hits`, sorted by distance along the segment.
   * @returns {number} hit count
   */
  _sweepFish(p, fishSys, segDir, segLen) {
    const list = fishSys.active;
    let n = 0;
    const reach = segLen + 2.5;
    const reach2 = reach * reach;
    const range2 = p.range * p.range;
    for (let i = 0; i < list.length; i++) {
      const fish = list[i];
      if (!fish.active || fish.state === FISH_STATE.HOOKED || fish === p.lastFish) continue;
      const dx = fish.position.x - p.prev.x, dy = fish.position.y - p.prev.y, dz = fish.position.z - p.prev.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // Cheap rejections: past the weapon's range, or nowhere near this
      // frame's travel segment.
      if (d2 > range2 || d2 > reach2) continue;
      const along = clamp(dx * segDir.x + dy * segDir.y + dz * segDir.z, 0, segLen);
      const cx = dx - segDir.x * along, cy = dy - segDir.y * along, cz = dz - segDir.z * along;
      const rad = Math.max(0.6, fish.scale * 0.8) + p.radius + Math.min(p.travelled * 0.02, 1.2);
      if (cx * cx + cy * cy + cz * cz > rad * rad) continue;
      if (p.hitIds.length && p.hitIds.includes(fish.id)) continue;
      const slot = this._hits[n];
      slot.f = fish; slot.t = along;
      if (++n >= MAX_SWEEP_HITS) break;
    }
    for (let i = 1; i < n; i++) {
      const cur = this._hits[i];
      let j = i - 1;
      while (j >= 0 && this._hits[j].t > cur.t) { this._hits[j + 1] = this._hits[j]; j--; }
      this._hits[j + 1] = cur;
    }
    return n;
  }

  // ----------------------------------------------------------------- damage
  /** Lazily derived, and re-derived when a pooled fish is recycled. */
  fishHP(fish) {
    if (fish.hp == null || fish.hpFor !== fish.instance) {
      fish.hp = Math.max(1, fish.instance.weight * 6 + fish.species.strength * 40);
      fish.hpFor = fish.instance;
    }
    return fish.hp;
  }

  _hitFish(game, fish, p, dir, point) {
    this.fishHP(fish);
    fish.hp -= p.damage;
    this.flashCrosshair();
    bus.emit('fx:impact', { position: point.clone(), normal: _a.copy(dir).negate().clone(), kind: 'flesh', scale: 1.1 });
    bus.emit('fx:hitMarker', { position: point.clone(), scale: 1.1, color: 0xff6b6b });
    game.audio?.play('harpoon_impact', {
      volume: 0.7, rate: rrange(0.9, 1.1), position: point.clone(), throttle: 30,
    });
    if (p.hitIds) p.hitIds.push(fish.id);
    if (p.explosive > 0) this._explode(game, point, p);
    // Where the shot actually landed. BossSystem reads this for weak-point and
    // crit detection; without it there is nothing to do but guess from the aim ray.
    bus.emit('weapon:hit', { target: fish, damage: p.damage, point, direction: dir });

    if (fish.hp > 0) {
      // Survived: violent flight, plus a knockback you can actually see.
      const knock = clamp(p.damage / Math.max(0.4, fish.instance.weight * 2.5), 0.6, 9);
      this._knock(fish, dir, knock);
      fish.state = FISH_STATE.FLEE;
      fish.stateTime = 0;
      fish.spooked = 2.5;
      fish.interest = 0;
      fish.baitRef = null;
      fish.energy = 1;
      fish.heading.set(dir.x, dir.y * 0.4 + 0.05, dir.z);
      if (fish.heading.lengthSq() < 1e-5) fish.heading.set(1, 0, 0);
      fish.heading.normalize();
      fish.velocity.addScaledVector(dir, knock * 0.8);
      game.get('fish')?.scare(fish.position, 7, 1.4);
      bus.emit('fx:floatText', { position: point.clone(), text: `${Math.round(p.damage)}`, color: '#ff8f6b', size: 17 });

      if (p.tethered && !p.attached) { this._attach(p, fish, game); return; }
      // A non-tethered shot punches through but loses most of its energy.
      p.vel.multiplyScalar(0.35);
      p.lastFish = fish;
      return;
    }

    this.killFish(game, fish, dir, { shotDistance: p.travelled });
    p.vel.multiplyScalar(0.5);
    p.lastFish = null;
    if (p.tethered) { p.state = 'stuck'; p.stuckT = 5; }
  }

  _knock(fish, dir, power) {
    if (!fish.knockV) fish.knockV = new THREE.Vector3();
    fish.knockV.addScaledVector(dir, power * 3.2);
    fish.knockV.y += power * 0.5;
    if (!this._knocked.includes(fish)) this._knocked.push(fish);
  }

  _updateKnockback(dt, game) {
    if (!this._knocked.length) return;
    const fishSys = game.get('fish');
    for (let i = this._knocked.length - 1; i >= 0; i--) {
      const fish = this._knocked[i];
      if (!fish.active || !fish.knockV) { this._knocked.splice(i, 1); continue; }
      fish.position.addScaledVector(fish.knockV, dt);
      fish.knockV.multiplyScalar(Math.pow(0.0025, dt));
      fishSys?.keepInWater(fish, waterHeightAt(fish.position.x, fish.position.z), worldHeight(fish.position.x, fish.position.z));
      if (fish.knockV.lengthSq() < 0.04) { fish.knockV.set(0, 0, 0); this._knocked.splice(i, 1); }
    }
  }

  /**
   * Convert a live AI fish into a physical fish, credit the catch and score
   * the trick. Every weapon kind funnels through here.
   */
  killFish(game, fish, dir, ctx = {}) {
    if (!fish.active || !fish.instance) return null;
    // A boss owns its own death: its HP pool is authoritative and BossSystem
    // decides when the fight ends. Nets, melee and a tethered harpoon reeling
    // one in all land a fish unconditionally, which recycled the entry out from
    // under BossSystem and paid the defeat reward for free.
    if (fish.isBoss) return null;
    const fishSys = game.get('fish');
    const inst = fish.instance;
    const eco = game.get('economy');
    const tricks = game.get('tricks');
    const mgr = game.get('physfish');

    const waterY = waterHeightAt(fish.position.x, fish.position.z);
    const midAir = fish.position.y > waterY;
    const headOn = dir ? dir.dot(fish.heading) < -0.6 : false;

    // Hand the AI fish's mesh over so the physical fish looks identical.
    const mesh = fish.mesh;
    if (mesh) { fish.group.remove(mesh); fish.mesh = null; fish.meshKey = ''; }

    const heft = clamp01(inst.weight / 55);
    const launch = lerp(11, 2.6, heft) * (ctx.launchScale ?? 1);
    _f.copy(dir || _a.set(0, 1, 0)).multiplyScalar(launch);
    _f.y += lerp(4.5, 1.2, heft);
    const spin = lerp(9, 2.5, heft);

    const pf = mgr?.spawn({
      instance: inst,
      position: { x: fish.position.x, y: fish.position.y, z: fish.position.z },
      velocity: { x: _f.x, y: _f.y, z: _f.z },
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
      depth: Math.max(0, waterY - fish.position.y),
    });

    const rarity = RARITY[inst.rarity] || RARITY.common;
    const badges = [];
    if (record === 'weight') badges.push('New Record');
    if (inst.variantId && inst.variantId !== 'normal') badges.push(VARIANT_BY_ID[inst.variantId]?.name || '');
    if (trickResult?.tricks?.length) badges.push(...trickResult.tricks.map((t) => t.name));

    const price = eco ? eco.priceFor(inst) : inst.value;
    bus.emit('catch:popup', {
      name: inst.name, rarity: rarity.name, rarityColor: rarity.color,
      weight: inst.weight, length: inst.length,
      value: Math.round(price * (trickResult?.mult || 1)),
      badges: badges.filter(Boolean),
    });
    game.audio?.play(inst.rarity === 'legendary' || inst.rarity === 'mythic' ? 'legendary'
      : inst.rarity === 'epic' || inst.rarity === 'rare' ? 'rare_fish' : 'record', { volume: 0.5 });

    if (pf) { pf.styleMult = trickResult?.mult || 1; pf.tricks = trickResult?.tricks || []; }

    if (!midAir) {
      bus.emit('fx:bigSplash', {
        position: _g.set(fish.position.x, waterY, fish.position.z).clone(),
        scale: clamp(0.6 + inst.weight * 0.03, 0.6, 3),
      });
      game.audio?.play('splash_big', {
        volume: clamp(0.35 + inst.weight * 0.02, 0.4, 1), position: fish.position.clone(),
      });
    }
    if (inst.weight > 12 || inst.rarity === 'legendary' || inst.rarity === 'mythic') bus.emit('fx:hitStop', 0.06);
    bus.emit('player:shake', clamp01(inst.weight / 90) * 0.4 + 0.08);
    this.flashCrosshair();
    this.kills++;

    bus.emit('weapon:caught', { instance: inst, pf, tricks: trickResult, method: 'harpoon' });

    fish.state = FISH_STATE.DEAD;
    fish.hp = null;
    fish.hpFor = null;
    if (fish.knockV) fish.knockV.set(0, 0, 0);
    fishSys?.despawn(fish);
    return pf;
  }

  // ---------------------------------------------------------------- impacts
  _impact(game, p, hit, dir) {
    const entry = hit.entry;
    const tag = entry?.tag || '';
    // A caught fish floating in the world gets punched, not pinned.
    if (tag === 'fish' && entry && !entry.removed) {
      const k = clamp(p.damage * 0.35, 4, 260);
      game.physics.addImpulse(entry, dir.x * k, dir.y * k + k * 0.25, dir.z * k);
      game.physics.addTorqueImpulse(entry, rrange(-k, k) * 0.05, rrange(-k, k) * 0.05, rrange(-k, k) * 0.05);
    }
    const kind = tag === 'boat' || tag === 'dock' ? 'wood' : p.underwater ? 'water' : 'stone';
    bus.emit('fx:impact', {
      position: hit.point.clone(), normal: hit.normal.clone(), kind, scale: 0.8 + p.radius * 2,
    });
    game.audio?.play('harpoon_impact', {
      volume: 0.75, rate: rrange(0.9, 1.08), position: hit.point.clone(), throttle: 40,
    });
    if (p.explosive > 0) this._explode(game, hit.point, p);
    game.get('fish')?.scare(hit.point, 6, 0.8);

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
  }

  _explode(game, point, p) {
    const radius = 3 + p.explosive * 1.4;
    const force = 60 + p.explosive * 90;
    game.physics.explode(point.x, point.y, point.z, radius, force);
    bus.emit('fx:explosion', { position: point.clone(), scale: clamp(0.8 + p.explosive * 0.35, 0.8, 4) });
    game.audio?.play('explosion', { volume: 0.9, position: point.clone() });
    bus.emit('player:shake', clamp01(p.explosive / 8) * 0.8);

    const fishSys = game.get('fish');
    if (!fishSys) return;
    fishSys.scare(point, radius * 2.5, 2);
    this._boom.length = 0;
    const r2 = radius * radius;
    for (const fish of fishSys.active) {
      if (fish.active && fish.position.distanceToSquared(point) < r2) this._boom.push(fish);
    }
    const multi = this._boom.length > 1;
    for (const fish of this._boom) {
      this.fishHP(fish);
      fish.hp -= p.damage * 0.6;
      _a.copy(fish.position).sub(point);
      if (_a.lengthSq() < 1e-4) _a.set(0, 1, 0);
      _a.normalize();
      if (fish.hp <= 0) this.killFish(game, fish, _a, { shotDistance: p.travelled ?? 0, doubleCatch: multi });
      else this._knock(fish, _a, 4);
    }
    this._boom.length = 0;
  }

  // -------------------------------------------------------------------- net
  /** @returns {boolean} true when the net was consumed */
  _netCatch(p, game, force) {
    const fishSys = game.get('fish');
    if (!fishSys) { if (force) this._despawn(p); return !!force; }
    const r = Math.max(1.5, p.netRadius || 5);
    const r2 = r * r;
    this._batch.length = 0;
    for (const fish of fishSys.active) {
      if (!fish.active || fish.state === FISH_STATE.HOOKED) continue;
      if (fish.position.distanceToSquared(p.pos) < r2) this._batch.push(fish);
    }
    if (!this._batch.length && !force) return false;

    if (this._batch.length) {
      // Biggest last, so its catch popup is the one left on screen.
      this._batch.sort((x, y) => x.instance.weight - y.instance.weight);
      const multi = this._batch.length >= 2;
      bus.emit('fx:ripple', { position: p.pos.clone(), radius: r });
      game.audio?.play('net_throw', { volume: 0.7, position: p.pos.clone(), rate: 0.85 });
      for (const fish of this._batch) {
        _a.copy(fish.position).sub(p.pos);
        _a.y = Math.abs(_a.y) + 0.4;
        if (_a.lengthSq() < 1e-4) _a.set(0, 1, 0);
        _a.normalize();
        this.killFish(game, fish, _a, { shotDistance: p.travelled, doubleCatch: multi, launchScale: 0.35 });
      }
      if (multi) {
        bus.emit('toast', { text: `Net haul — ${this._batch.length} fish`, kind: 'gold' });
        bus.emit('fx:hitStop', 0.06);
      }
      this._batch.length = 0;
    }
    this._despawn(p);
    return true;
  }

  // ------------------------------------------------------------------- beam
  _fireBeam(game, item, stats, origin, dir) {
    const range = stats.range ?? 120;
    const hit = game.physics.raycast(origin, dir, range, HIT_MASK, null);
    const end = hit ? hit.distance : range;
    const fishSys = game.get('fish');

    // Pierce every fish standing in the beam.
    if (fishSys) {
      this._batch.length = 0;
      for (const fish of fishSys.active) {
        if (!fish.active || fish.state === FISH_STATE.HOOKED) continue;
        const dx = fish.position.x - origin.x, dy = fish.position.y - origin.y, dz = fish.position.z - origin.z;
        const along = dx * dir.x + dy * dir.y + dz * dir.z;
        if (along < 0 || along > end) continue;
        const cx = dx - dir.x * along, cy = dy - dir.y * along, cz = dz - dir.z * along;
        const rad = Math.max(0.8, fish.scale * 0.7) + along * 0.01;
        if (cx * cx + cy * cy + cz * cz > rad * rad) continue;
        this._batch.push(fish);
      }
      this._batch.sort((x, y) => x.instance.weight - y.instance.weight);
      const multi = this._batch.length >= 2;
      for (const fish of this._batch) {
        this.fishHP(fish);
        fish.hp -= stats.damage ?? 100;
        if (fish.hp <= 0) {
          this.killFish(game, fish, dir, { shotDistance: origin.distanceTo(fish.position), doubleCatch: multi });
        } else {
          this._knock(fish, dir, 6);
          fish.state = FISH_STATE.FLEE; fish.stateTime = 0; fish.spooked = 3;
        }
      }
      if (this._batch.length) this.flashCrosshair();
      this._batch.length = 0;
    }

    if (hit) {
      bus.emit('fx:impact', { position: hit.point.clone(), normal: hit.normal.clone(), kind: 'metal', scale: 1.4 });
    }
    if ((stats.explosive ?? 0) > 0) {
      _b.copy(origin).addScaledVector(dir, end);
      this._explode(game, _b, { explosive: stats.explosive, damage: stats.damage ?? 100, travelled: end });
    }

    // Beam visual: a pooled projectile parked in the 'beam' state.
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
    p.tethered = false;
    p.attached = null;
    p.line = null;
    p.pos.copy(origin);
    p.mesh = this._acquireMesh('beam');
    p.mesh.position.copy(origin);
    p.mesh.quaternion.setFromUnitVectors(FWD_Z, dir);
    p.mesh.scale.set(p.beamWidth, p.beamWidth, end);
    this.projectiles.push(p);
  }

  // ---------------------------------------------------------------- tethers
  _attach(p, fish, game) {
    p.attached = fish;
    p.state = 'attached';
    p.vel.set(0, 0, 0);
    p.fightTime = 0;
    p.slackT = 0;
    fish.state = FISH_STATE.HOOKED;
    fish.stateTime = 0;
    fish.spooked = 2;
    game.audio?.play('fish_thrash', { volume: 0.6, position: fish.position.clone() });
    bus.emit('weapon:tethered', { instance: fish.instance });
  }

  _updateTether(dt, game, p, player, holding) {
    const fish = p.attached;
    if (!fish || !fish.active) { this._despawn(p); return; }
    const inst = fish.instance;
    p.fightTime += dt;

    _eye.copy(player.eyePosition);
    _b.copy(_eye).sub(fish.position);
    const dist = _b.length();
    if (dist > 1e-4) _b.multiplyScalar(1 / dist); else _b.set(0, 1, 0);

    if (holding) {
      p.slackT = 0;
      // Reel: heavier fish come in slower and fight harder.
      const pull = lerp(9, 1.4, clamp01(inst.weight / 120)) * lerp(0.55, 1, clamp01(p.damage / 400));
      fish.position.addScaledVector(_b, pull * dt);
      const thrash = lerp(0.6, 2.6, clamp01(fish.species.speed));
      fish.position.x += Math.sin(p.fightTime * 8.5) * thrash * dt;
      fish.position.z += Math.cos(p.fightTime * 7.3) * thrash * dt;
      // Dragged in head-first.
      fish.heading.copy(_b);
      p.line?.setTension(clamp01(0.35 + inst.weight / 150));
      if (rchance(dt * 3)) bus.emit('ocean:ripple', { x: fish.position.x, z: fish.position.z, strength: 0.4 });
      game.audio?.play('reel_click', { volume: 0.25, rate: rrange(0.9, 1.2), throttle: 110 });

      // Huge fish drag the player, exactly like a hooked fish on the rod.
      if (inst.weight > 25 && player.grounded) {
        const dragK = clamp01((inst.weight - 25) / 130);
        player.velocity.addScaledVector(_b, -dragK * 9 * dt);
        if (dragK > 0.35) player.shake = Math.max(player.shake, dragK * 0.3);
      }
    } else {
      // Slack line: the fish runs, and eventually tears the barb out.
      p.slackT += dt;
      fish.position.addScaledVector(fish.heading, lerp(1, 4.5, clamp01(fish.species.speed)) * dt);
      p.line?.setTension(0.05);
      if (p.slackT > 4.5) {
        game.audio?.play('line_snap', { volume: 0.6 });
        bus.emit('toast', { text: 'The harpoon tore free', kind: 'warn' });
        this._despawn(p);
        return;
      }
    }

    const surf = waterHeightAt(fish.position.x, fish.position.z);
    const bed = worldHeight(fish.position.x, fish.position.z);
    fish.position.y = clamp(fish.position.y, bed + 0.25, surf + 0.4);
    fish.group.position.copy(fish.position);
    fish.group.updateMatrix();

    // The harpoon rides the fish.
    _a.copy(fish.heading).multiplyScalar(-inst.length * 0.35);
    p.pos.copy(fish.position).add(_a);
    if (p.mesh) {
      p.mesh.position.copy(p.pos);
      if (fish.heading.lengthSq() > 1e-6) {
        _q.setFromUnitVectors(FWD_Z, _c.copy(fish.heading).normalize());
        p.mesh.quaternion.slerp(_q, 1 - Math.pow(0.002, dt));
      }
    }

    // Landed — yank it clean out of the water.
    if (dist < 2.4) {
      const attached = p.attached;
      p.attached = null;
      this.killFish(game, attached, p.shotDir, {
        shotDistance: p.travelled, fightTime: p.fightTime, launchScale: 0.5,
      });
      this._despawn(p);
    }
  }

  // ---------------------------------------------------------------- suction
  _updateSuction(dt, game, stats, player) {
    const fishSys = game.get('fish');
    const R = stats.suction ?? 20;
    _eye.copy(player.eyePosition);
    player.forward(_fwd);

    this.suctionCone.visible = true;
    this.suctionCone.position.copy(_eye).addScaledVector(_fwd, 0.4);
    this.suctionCone.quaternion.setFromUnitVectors(FWD_Z, _fwd);
    const wob = 1 + Math.sin(game.time * 26) * 0.05;
    this.suctionCone.scale.set(R * 0.7 * wob, R * 0.7 * wob, R);

    this._startSuction(game);
    this._suctionT += dt;
    if (this._suctionT > 0.09) {
      this._suctionT = 0;
      bus.emit('weapon:recoil', 0.08);
      player.recoil.x += 0.0016;
      _a.copy(_eye).addScaledVector(_fwd, R * 0.3);
      bus.emit('fx:bubbles', { position: _a.clone(), count: 3, rise: -0.4, spread: R * 0.1 });
    }

    if (!fishSys) return;
    for (let i = fishSys.active.length - 1; i >= 0; i--) {
      const fish = fishSys.active[i];
      if (!fish.active) continue;
      _a.copy(fish.position).sub(_eye);
      const d = _a.length();
      if (d > R || d < 1e-4) continue;
      _a.multiplyScalar(1 / d);
      if (_a.dot(_fwd) < SUCTION_COS) continue;

      // Drag toward the muzzle; heavy fish resist.
      const pull = lerp(26, 6, clamp01(d / R)) / (1 + fish.instance.weight * 0.12);
      fish.position.addScaledVector(_a, -pull * dt);
      fish.spooked = 2;
      fish.heading.copy(_a).negate();
      fish.state = FISH_STATE.FLEE;
      fish.stateTime = 0;
      const surf = waterHeightAt(fish.position.x, fish.position.z);
      const bed = worldHeight(fish.position.x, fish.position.z);
      fish.position.y = clamp(fish.position.y, bed + 0.2, surf + 0.5);
      fish.group.position.copy(fish.position);
      fish.group.updateMatrix();
      this.fishHP(fish);
      fish.hp -= (stats.damage ?? 100) * dt * 0.5;

      if (d < 2.2 || fish.hp <= 0) {
        _b.copy(_a).negate();
        this.killFish(game, fish, _b, { shotDistance: d, launchScale: 0.3 });
        this.flashCrosshair();
      }
    }
    _a.copy(_eye).addScaledVector(_fwd, R * 0.5);
    fishSys.scare(_a, R * 0.5, 0.8);
  }

  _startSuction(game) {
    if (this._suckLoopOn) return;
    this._suckLoopOn = true;
    const h = game.audio?.loop('underwater_whoosh', { volume: 0.55, fadeIn: 0.12 });
    h?.setVolume?.(0.55, 0.12);
  }

  _stopSuction() {
    if (this.suctionCone) this.suctionCone.visible = false;
    if (!this._suckLoopOn) return;
    this._suckLoopOn = false;
    this.game.audio?.stopLoop('underwater_whoosh', 0.18);
  }

  /**
   * Resolve what a swing would hit right now and hand it to the HUD.
   *
   * Same order and reach as the swing itself, so the readout can never
   * disagree with what actually happens -- a prompt that says "Palm" while the
   * blow lands on a crate is worse than no prompt.
   */
  _updateAimTarget(game, melee, player) {
    const hud = game.get('hud');
    if (!hud?.setHitTarget) return;
    const stats = melee?.stats || {};
    const reach = (stats.range ?? 3) + 0.6;
    player.forward(_fwd);

    const tree = game.get('trees')?.targetAt(player.position, _fwd, reach);
    if (tree) {
      hud.setHitTarget({
        icon: '🌴', name: 'Tree', health: tree.health, maxHealth: tree.maxHealth,
        hint: stats.chop ? '' : 'Needs a tool',
      });
      return;
    }
    const node = game.get('harvest')?.targetAt(player.position, _fwd, reach);
    if (node) {
      const want = node.def.tool;
      hud.setHitTarget({
        icon: node.def.icon, name: node.def.name, health: node.health, maxHealth: node.maxHealth,
        hint: (stats.chop || stats.mine) ? '' : 'Needs a tool',
      });
      return;
    }
    const piece = game.get('build')?.targetPiece?.(player, reach);
    if (piece && (stats.chop || stats.mine)) {
      hud.setHitTarget({
        icon: piece.def?.icon || '🔨', name: piece.def?.name || 'Piece',
        health: piece.health, maxHealth: piece.maxHealth, hint: 'Dismantle — half back',
      });
      return;
    }
    hud.setHitTarget(null);
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

    // Tools hit the world before they hit anything alive, so a swing at a
    // trunk is never eaten by a fish that happens to be behind it. Order is
    // trees, then breakable scenery, then your own buildings -- most specific
    // first, and buildings last so you cannot dismantle your house by
    // swinging at a crate leaning on it.
    const reach = (stats.range ?? 3) + 0.6;

    // A fish in your hand comes first. The world sweep skips held fish on
    // purpose, so without this the one thing you are looking at is the one
    // thing the axe cannot touch.
    const heldPf = game.get('interaction')?.held?.pf;
    if (heldPf?.alive && (stats.chop || stats.freshness || stats.damage)) {
      this._dispatchHeld(game, stats, heldPf);
      return;
    }

    if (stats.chop) {
      const trees = game.get('trees');
      const target = trees?.targetAt(player.position, _fwd, reach);
      if (target) {
        trees.chop(target, stats.chop, game);
        bus.emit('fx:impact', {
          position: new THREE.Vector3(target.x, player.eyePosition.y - 0.4, target.z),
          normal: _fwd.clone().negate(), kind: 'wood', scale: 0.9,
        });
        return;
      }
    }

    // Rocks, crates, barrels, driftwood. Any tool works; the matching one is
    // just faster, because a swing that does nothing is indistinguishable
    // from a broken game.
    if (stats.chop || stats.mine) {
      const harvest = game.get('harvest');
      const node = harvest?.targetAt(player.position, _fwd, reach);
      if (node) {
        harvest.hit(node, stats, game);
        bus.emit('fx:impact', {
          position: new THREE.Vector3(node.x, player.eyePosition.y - 0.4, node.z),
          normal: _fwd.clone().negate(),
          kind: node.kind === 'rock' || node.kind === 'boulder' ? 'stone' : 'wood', scale: 0.9,
        });
        return;
      }
    }

    // Your own build pieces. Dismantling with the tool you built with is the
    // obvious gesture, and it refunds -- the right-click path did too, but
    // nothing told anyone it existed.
    if (stats.chop || stats.mine) {
      const build = game.get('build');
      const piece = build?.targetPiece?.(player, reach);
      if (piece) {
        build.remove(piece);
        bus.emit('fx:impact', {
          position: new THREE.Vector3(piece.x, piece.y, piece.z),
          normal: _fwd.clone().negate(), kind: 'wood', scale: 1.0,
        });
        return;
      }
    }
    const range = (stats.range ?? 2.4) + 0.4;
    _centre.copy(_eye).addScaledVector(_fwd, range * 0.55);
    const hitR = range * 0.62;
    let connected = false;

    // ---- already-caught physical fish ----
    const mgr = game.get('physfish');
    if (mgr) {
      for (let i = mgr.list.length - 1; i >= 0; i--) {
        const pf = mgr.list[i];
        if (pf.held) continue;
        game.physics.getPosition(pf.entry, _pos);
        if (_pos.distanceTo(_centre) > hitR + pf.len * 0.5) continue;
        connected = true;
        this._meleeHitPhysical(game, stats, pf, _pos);
      }
    }

    // ---- live AI fish ----
    const fishSys = game.get('fish');
    if (fishSys && (stats.damage ?? 0) > 0) {
      this._batch.length = 0;
      for (const fish of fishSys.active) {
        if (!fish.active || fish.state === FISH_STATE.HOOKED) continue;
        if (fish.position.distanceTo(_centre) > hitR + fish.scale * 0.5) continue;
        this._batch.push(fish);
      }
      for (const fish of this._batch) {
        connected = true;
        this.fishHP(fish);
        fish.hp -= stats.damage;
        _a.copy(fish.position).sub(_eye);
        if (_a.lengthSq() < 1e-4) _a.copy(_fwd);
        _a.normalize();
        game.audio?.play('club_hit', {
          volume: 0.6, rate: rrange(0.92, 1.1), position: fish.position.clone(), throttle: 40,
        });
        bus.emit('fx:impact', {
          position: fish.position.clone(), normal: _b.copy(_a).negate().clone(), kind: 'flesh', scale: 0.9,
        });
        if (fish.hp <= 0) this.killFish(game, fish, _a, { launchScale: 0.6 });
        else {
          this._knock(fish, _a, clamp(stats.knockback ?? 3, 1, 10));
          fish.state = FISH_STATE.FLEE; fish.stateTime = 0; fish.spooked = 2;
        }
      }
      this._batch.length = 0;
    }

    if (connected) {
      this.flashCrosshair();
      bus.emit('player:shake', 0.12);
    }
  }

  /** Kill the fish being carried. Same freshness bookkeeping as a club blow on the ground. */
  _dispatchHeld(game, stats, pf) {
    const pos = game.physics.getPosition(pf.entry, _pos).clone();
    pf.alive = false;
    pf.energy = 0;
    pf.freshnessBonus = (pf.freshnessBonus || 1) * (stats.freshness || 1.1);
    _e.copy(pos).add(_d.set(0, 0.35, 0));
    bus.emit('fx:floatText', { position: _e.clone(), text: '+FRESH', color: '#ffc22e', size: 20 });
    bus.emit('fx:impact', { position: pos, normal: _fwd.clone().negate(), kind: 'flesh', scale: 0.9 });
    bus.emit('fx:hitStop', 0.06);
    bus.emit('player:shake', 0.18);
    game.audio?.play('club_hit', { volume: 0.85, rate: rrange(0.85, 1.0), position: pos.clone() });
    bus.emit('fish:killed', { pf, held: true });
  }

  _meleeHitPhysical(game, stats, pf, pos) {
    const phys = game.physics;
    _a.copy(pos).sub(_eye);
    if (_a.lengthSq() < 1e-4) _a.copy(_fwd);
    _a.normalize();
    _e.copy(pos).add(_d.set(0, 0.5, 0));   // float-text anchor

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
        bus.emit('fx:floatText', { position: _e.clone(), text: '+CLEANED', color: '#5ddb6a', size: 20 });
        game.audio?.play('club_hit', { volume: 0.4, rate: 1.5, position: pos.clone() });
        bus.emit('fx:impact', { position: pos.clone(), normal: _b.copy(_a).negate().clone(), kind: 'flesh', scale: 0.6 });
      } else {
        bus.emit('fx:floatText', { position: _e.clone(), text: 'already cleaned', color: '#b8c0c8', size: 15 });
      }
    }

    if (stats.freshness) {
      // Club: dispatch it cleanly — a fresh fish is worth more.
      if (pf.alive) {
        pf.alive = false;
        pf.energy = 0;
        pf.freshnessBonus = (pf.freshnessBonus || 1) * stats.freshness;
        bus.emit('fx:floatText', { position: _e.clone(), text: '+FRESH', color: '#ffc22e', size: 20 });
        bus.emit('fx:hitStop', 0.05);
      }
      game.audio?.play('club_hit', { volume: 0.85, rate: rrange(0.9, 1.06), position: pos.clone() });
      bus.emit('fx:impact', { position: pos.clone(), normal: _b.copy(_a).negate().clone(), kind: 'flesh', scale: 1.2 });
    }

    if (stats.scoop) {
      // Landing net: scoop it straight into storage.
      const inv = game.get('inventory');
      const limit = stats.scoopWeight ?? 25;
      if (pf.instance.weight <= limit) {
        if (inv?.storeFish(pf.instance, {
          styleMult: pf.styleMult || 1, processLevel: pf.processLevel || 0, freshness: pf.freshnessBonus || 1,
        })) {
          game.audio?.play('pickup', { volume: 0.6, rate: 1.15 });
          bus.emit('fx:sparkle', { position: pos.clone(), count: 8, color: '#5ddb6a' });
          game.get('physfish').despawn(pf);
          return;
        }
      } else {
        bus.emit('fx:floatText', {
          position: _e.clone(), text: `too heavy — ${formatWeight(pf.instance.weight)}`, color: '#ff6b6b', size: 15,
        });
      }
    }

    // A gaff drags the fish in; its knockback would just cancel the pull.
    const knock = stats.pull ? 0 : (stats.knockback ?? 0) * clamp(pf.mass, 0.4, 30) * 0.6;
    if (knock > 0) {
      phys.addImpulse(pf.entry, _a.x * knock, _a.y * knock + knock * 0.5, _a.z * knock);
      phys.addTorqueImpulse(pf.entry,
        rrange(-1, 1) * knock * 0.1, rrange(-1, 1) * knock * 0.14, rrange(-1, 1) * knock * 0.1);
    }
    if ((stats.damage ?? 0) > 0 && !stats.freshness && !stats.process && !stats.pull) {
      game.audio?.play('club_hit', { volume: 0.5, rate: rrange(1.05, 1.25), position: pos.clone(), throttle: 40 });
    }
  }

  // ------------------------------------------------------------------- misc
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
    dir: new THREE.Vector3(0, 0, 1), shotDir: new THREE.Vector3(0, 0, 1),
    gravity: 9, damage: 10, range: 40, travelled: 0, life: 0, maxLife: 10,
    tethered: false, explosive: 0, netRadius: 0, open: 0, radius: 0.16,
    state: 'idle', stuckT: 0, underwater: false, attached: null, slackT: 0,
    fightTime: 0, spin: 0, hitIds: [], lastFish: null, spentSpeed: 3,
    beamLen: 0, beamWidth: 0.16,
  };
}
