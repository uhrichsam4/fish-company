import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { CG, groups, applyBuoyancy } from '../physics/PhysicsWorld.js';
import { getSpecies, VARIANT_BY_ID, RARITY } from '../data/fishData.js';
import { clamp, clamp01, lerp, rrange, rchance, rpick, damp } from '../util/math.js';
import { waterHeightAt, waterVelocityAt } from '../world/waves.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Caught fish that exist as real physics bodies in the world: they flop,
 * get thrown, knock crates over, and can be picked up, sold or stored.
 * Bodies auto-calm after a while and despawn after a long timeout.
 */
export class PhysicalFishManager {
  constructor(game) {
    this.game = game;
    this.name = 'physfish';
    this.order = 45;
    /** @type {Array<object>} */
    this.list = [];
    this.maxPhysical = 26;
    this.root = null;
  }

  async init(game) {
    this.root = new THREE.Group();
    this.root.name = 'physical-fish';
    game.scene.add(this.root);
    bus.on('physfish:spawn', (o) => this.spawn(o));
    return this;
  }

  /**
   * @param {object} o {instance, position, velocity, mesh?, angularVelocity?, alive?}
   */
  spawn({ instance, position, velocity, mesh, angularVelocity, alive = true, ownerless = false }) {
    if (!instance) return null;
    const species = getSpecies(instance.speciesId);
    if (!species) return null;

    // Retire the oldest to keep the body count bounded.
    while (this.list.length >= this.maxPhysical) this.despawn(this.list[0], true);

    const fishSys = this.game.get('fish');
    const group = mesh || fishSys?.buildMesh(species, instance) || new THREE.Group();
    group.scale.setScalar(instance.length);
    group.visible = true;
    group.matrixAutoUpdate = true;
    this.root.add(group);

    const len = Math.max(0.12, instance.length);
    const halfLen = len * 0.46;
    const radius = Math.max(0.045, len * 0.16);
    const mass = Math.max(0.05, instance.weight);

    const entry = this.game.physics.addBody({
      type: 'dynamic',
      position,
      shape: {
        kind: 'capsule', hh: Math.max(0.03, halfLen - radius), r: radius,
        rotationOffset: { x: 0, y: 0, z: 0.7071068, w: 0.7071068 }, // capsule Y -> X
        friction: 0.62, restitution: 0.28,
        groups: groups(CG.FISH, 0xffff),
      },
      object3d: group,
      tag: 'fish',
      linearDamping: 0.28,
      angularDamping: 0.5,
      ccd: len > 1.2,
      additionalMass: mass,
      userData: { instance, species },
    });
    if (velocity) entry.body.setLinvel({ x: velocity.x, y: velocity.y, z: velocity.z }, true);
    if (angularVelocity) entry.body.setAngvel(angularVelocity, true);

    const pf = {
      entry, group, instance, species, alive,
      life: 0, maxLife: 300, flopTimer: rrange(0.1, 0.5),
      energy: 1, mass, len, calm: false, held: false,
      submerged: 0, lastImpact: 0, sold: false,
      samples: buoyancySamples(len, radius),
      volume: Math.max(0.0004, mass / 1020), // fish are ~neutrally buoyant
    };
    this.list.push(pf);

    entry.onContact = (other, started) => {
      if (!started) return;
      const now = performance.now();
      if (now - pf.lastImpact < 90) return;
      pf.lastImpact = now;
      const speed = _v.copy(this.game.physics.getVelocity(entry)).length();
      if (speed > 1.6) {
        const vol = clamp01(speed / 12) * clamp01(0.25 + pf.mass / 40);
        this.game.audio.play(pf.mass > 25 ? 'fish_impact' : 'fish_flop', {
          volume: 0.3 + vol * 0.7, rate: rrange(0.85, 1.15),
          position: this.game.physics.getPosition(entry).clone(), throttle: 60,
        });
        if (speed > 5 && pf.mass > 8) bus.emit('player:shake', clamp01(pf.mass / 200) * 0.4);
      }
    };

    bus.emit('physfish:spawned', { pf });
    return pf;
  }

  despawn(pf, silent = false) {
    const i = this.list.indexOf(pf);
    if (i >= 0) this.list.splice(i, 1);
    this.game.physics.remove(pf.entry);
    this.root.remove(pf.group);
    const fishSys = this.game.get('fish');
    if (fishSys) fishSys._release(fishSys.meshKeyFor(pf.species, pf.instance.variantId, 0), pf.group);
    if (!silent) bus.emit('physfish:despawned', { pf });
  }

  despawnAll() { for (const pf of [...this.list]) this.despawn(pf, true); }

  /** Nearest physical fish within `radius` of a point. */
  nearest(position, radius = 3) {
    let best = null, bd = radius * radius;
    for (const pf of this.list) {
      if (pf.held) continue;
      const p = this.game.physics.getPosition(pf.entry, _v);
      const d = p.distanceToSquared(position);
      if (d < bd) { bd = d; best = pf; }
    }
    return best;
  }

  /** Convert a physical fish to inventory data (used by sell zones/storage). */
  absorb(pf, into = 'inventory') {
    const inv = this.game.get('inventory');
    if (into === 'inventory' && inv) {
      if (!inv.storeFish(pf.instance)) return false;
    }
    this.despawn(pf);
    return true;
  }

  update(dt, game) {
    if (dt <= 0) return;
    const phys = game.physics;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const pf = this.list[i];
      pf.life += dt;
      if (pf.life > pf.maxLife) { this.despawn(pf); continue; }
      if (pf.held) continue;

      const p = phys.getPosition(pf.entry, _v);
      if (p.y < -300) { this.despawn(pf); continue; }

      const waterY = waterHeightAt(p.x, p.z);
      const submerged = clamp01((waterY - p.y + pf.len * 0.25) / Math.max(0.2, pf.len * 0.5));
      pf.submerged = submerged;

      if (submerged > 0.05) {
        applyBuoyancy(phys, pf.entry, pf.samples, {
          waterHeightAt, volume: pf.volume, dragLinear: 2.2, dragAngular: 1.6,
          density: 1030, dt, sampleHeight: Math.max(0.12, pf.len * 0.35),
          waveVelAt: (x, z) => waterVelocityAt(x, z),
        });
      }

      // ---- flopping ----
      if (pf.alive && pf.energy > 0.02) {
        pf.flopTimer -= dt;
        // Fish out of water thrash harder and tire faster.
        const outOfWater = submerged < 0.35;
        pf.energy -= dt * (outOfWater ? 0.05 : 0.012);
        if (pf.flopTimer <= 0) {
          const bodyIsResting = pf.entry.body.isSleeping();
          if (bodyIsResting) pf.entry.body.wakeUp();
          const power = pf.energy * (outOfWater ? 1.0 : 0.45);
          // Impulse scales with mass so big fish genuinely launch things.
          const mag = pf.mass * lerp(1.6, 4.2, clamp01(pf.mass / 60)) * power;
          const ang = Math.random() * Math.PI * 2;
          phys.addImpulse(pf.entry,
            Math.cos(ang) * mag * 0.55,
            mag * rrange(0.55, 1.15),
            Math.sin(ang) * mag * 0.55);
          phys.addTorqueImpulse(pf.entry,
            rrange(-1, 1) * mag * 0.13 * pf.len,
            rrange(-1, 1) * mag * 0.2 * pf.len,
            rrange(-1, 1) * mag * 0.13 * pf.len);
          pf.flopTimer = lerp(0.16, 1.5, clamp01(pf.mass / 90)) * rrange(0.7, 1.6) / Math.max(0.15, power);
          if (outOfWater) {
            game.audio.play(pf.mass > 20 ? 'fish_impact' : 'fish_flop', {
              volume: clamp(0.18 + pf.mass * 0.02, 0.15, 0.9),
              rate: rrange(0.9, 1.2), position: p.clone(), throttle: 55,
            });
          } else {
            bus.emit('ocean:ripple', { x: p.x, z: p.z, strength: clamp01(pf.mass / 30) * 0.7 });
          }
          // Fish mesh wriggle.
          if (pf.group.userData?.deform) {
            try { pf.group.userData.deform(pf.life * 14, 1.3 * power, 1.2); } catch { /* optional */ }
          }
        }
      } else if (!pf.calm) {
        pf.calm = true;
        pf.entry.body.setLinearDamping(1.4);
        pf.entry.body.setAngularDamping(1.6);
      }

      // Idle mesh wriggle for near fish, so calm fish still look organic.
      if (pf.alive && pf.group.userData?.deform && pf.life < 30) {
        const camD = p.distanceToSquared(game.camera.position);
        if (camD < 400) {
          try { pf.group.userData.deform(pf.life * 6, 0.18 * pf.energy, 1.4); } catch { /* optional */ }
        }
      }
    }
  }

  save() {
    return {
      fish: this.list.filter((p) => !p.held).slice(0, 20).map((pf) => {
        const p = this.game.physics.getPosition(pf.entry, _v);
        return { i: pf.instance, x: p.x, y: p.y, z: p.z, alive: pf.alive, energy: pf.energy };
      }),
    };
  }
  load(d) {
    this.despawnAll();
    if (!d?.fish) return;
    for (const f of d.fish) {
      const pf = this.spawn({ instance: f.i, position: { x: f.x, y: f.y + 0.2, z: f.z }, alive: f.alive });
      if (pf) pf.energy = f.energy ?? 1;
    }
  }
}

/** Sample points along the fish's long axis for buoyancy. */
function buoyancySamples(len, radius) {
  const n = 4;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * 2 - 1;
    out.push(new THREE.Vector3(t * len * 0.4, 0, 0));
  }
  return out;
}
