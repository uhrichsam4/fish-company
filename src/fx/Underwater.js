import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp, clamp01, lerp, damp, rrange } from '../util/math.js';
import { waterHeightAt } from '../world/waves.js';

/**
 * Underwater look: colour shift, close fog, and bubbles.
 *
 * Sky already writes scene fog every frame from weather and time of day, so
 * this cannot simply set fog and walk away -- it re-applies after Sky each
 * frame (order 94 against Sky's) and blends by submersion. Fighting for the
 * same property is why this runs late rather than reacting to an event.
 *
 * Bubbles are a single pooled Points cloud. Spawning meshes per bubble would
 * cost draw calls for something on screen for two seconds at a time.
 */

const MAX_BUBBLES = 120;
/** Fog density underwater; visibility should be tens of metres, not hundreds. */
const DEEP_FOG = 0.055;
const SHALLOW_FOG = 0.022;
const DEEP_COLOR = new THREE.Color(0x0b3a52);
const SHALLOW_COLOR = new THREE.Color(0x2f8ba8);

export class Underwater {
  constructor(game) {
    this.game = game;
    this.name = 'underwater';
    this.order = 94;                // after Sky, which also writes scene fog
    this.amount = 0;                // 0..1 submersion blend
    this.points = null;
    this._spawnAcc = 0;
    this._savedFog = null;
  }

  async init(game) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_BUBBLES * 3);
    const size = new Float32Array(MAX_BUBBLES);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(size, 1));
    geo.setDrawRange(0, 0);

    const mat = new THREE.PointsMaterial({
      color: 0xdff4ff, size: 0.06, transparent: true, opacity: 0.55,
      depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
    this.points.visible = false;
    game.scene.add(this.points);

    /** @type {Array<{x:number,y:number,z:number,vy:number,life:number,max:number}>} */
    this.bubbles = [];

    bus.on('player:swimming', (on) => {
      if (!on) return;
      // A burst on entry, so breaking the surface actually reads as entry.
      const p = game.get('player');
      if (p) for (let i = 0; i < 18; i++) this._spawn(p.position, 1.2);
    });
    return this;
  }

  _spawn(around, spread = 0.5) {
    if (this.bubbles.length >= MAX_BUBBLES) return;
    this.bubbles.push({
      x: around.x + rrange(-spread, spread),
      y: around.y + rrange(-0.4, 0.5),
      z: around.z + rrange(-spread, spread),
      vy: rrange(0.5, 1.4),
      life: 0, max: rrange(1.2, 2.6),
    });
  }

  update(dt, game) {
    const player = game.get('player');
    if (!player) return;

    // Submersion measured at the eye, so the transition happens when the view
    // actually goes under rather than when the feet do.
    const eye = player.eyePosition;
    const surf = waterHeightAt(eye.x, eye.z);
    const depth = surf - eye.y;
    const target = clamp01(depth / 0.6);
    this.amount = damp(this.amount, target, 0.001, dt);

    const fog = game.scene.fog;
    if (fog?.isFogExp2) {
      if (this.amount > 0.002) {
        // Sky wrote fog for the sky this frame; blend ours over the top.
        if (!this._savedFog) this._savedFog = { color: new THREE.Color(), density: fog.density };
        const deep = clamp01((depth - 2) / 18);
        const wantColor = SHALLOW_COLOR.clone().lerp(DEEP_COLOR, deep);
        const wantDensity = lerp(SHALLOW_FOG, DEEP_FOG, deep);
        fog.color.lerp(wantColor, this.amount);
        fog.density = lerp(fog.density, wantDensity, this.amount);
      } else {
        this._savedFog = null;
      }
    }

    // ---- bubbles ----
    const under = this.amount > 0.15;
    this.points.visible = under || this.bubbles.length > 0;
    if (under) {
      this._spawnAcc += dt;
      // Faster when moving: exertion makes bubbles, stillness does not.
      const speed = Math.hypot(player.velocity?.x || 0, player.velocity?.z || 0);
      const rate = 3 + speed * 2.5;
      while (this._spawnAcc > 1 / rate) { this._spawnAcc -= 1 / rate; this._spawn(eye, 0.35); }
    }

    const pos = this.points.geometry.attributes.position;
    let n = 0;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.life += dt;
      b.vy = Math.min(2.4, b.vy + dt * 0.8);       // accelerate as they rise
      b.y += b.vy * dt;
      b.x += Math.sin(b.life * 5 + i) * dt * 0.12; // wobble
      const bsurf = waterHeightAt(b.x, b.z);
      if (b.life > b.max || b.y > bsurf) { this.bubbles.splice(i, 1); continue; }
      pos.array[n * 3] = b.x; pos.array[n * 3 + 1] = b.y; pos.array[n * 3 + 2] = b.z;
      n++;
    }
    pos.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
  }

  dispose() {
    if (this.points) {
      this.game.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
    }
  }
}
