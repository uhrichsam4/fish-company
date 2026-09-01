import * as THREE from 'three';
import { clamp, clamp01, lerp } from '../util/math.js';

/**
 * Verlet rope between the rod tip and the hook.
 * Cheap (14 points, 4 relaxation passes) but gives real sag, snap-taut
 * behaviour and whip when the fish runs.
 */
export class FishingLine {
  constructor(scene, opts = {}) {
    this.count = opts.count ?? 14;
    this.points = [];
    this.prev = [];
    for (let i = 0; i < this.count; i++) {
      this.points.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
    }
    this.restLength = 1;
    this.gravity = new THREE.Vector3(0, -9.5, 0);
    this.damping = 0.986;
    this.tension = 0;

    const positions = new Float32Array(this.count * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setDrawRange(0, this.count);
    this.material = new THREE.LineBasicMaterial({
      color: opts.color ?? 0xf0f7ff, transparent: true, opacity: 0.85,
      depthWrite: false, fog: true,
    });
    this.mesh = new THREE.Line(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);

    // A slightly thicker "core" line drawn behind for visibility at distance.
    this.material2 = new THREE.LineBasicMaterial({ color: 0x203040, transparent: true, opacity: 0.35, depthWrite: false });
    this.mesh2 = new THREE.Line(this.geometry, this.material2);
    this.mesh2.frustumCulled = false;
    this.mesh2.renderOrder = 19;
    this.mesh2.visible = false;
    scene.add(this.mesh2);
  }

  reset(from, to) {
    for (let i = 0; i < this.count; i++) {
      const t = i / (this.count - 1);
      this.points[i].lerpVectors(from, to, t);
      this.prev[i].copy(this.points[i]);
    }
    this.restLength = from.distanceTo(to) / (this.count - 1);
  }

  setVisible(v) { this.mesh.visible = v; this.mesh2.visible = v; }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} anchorA rod tip
   * @param {THREE.Vector3} anchorB hook
   * @param {number} slack 1 = fully slack, 0 = taut
   */
  update(dt, anchorA, anchorB, slack = 0.3) {
    if (dt <= 0) return;
    const dist = anchorA.distanceTo(anchorB);
    // Rest length tracks distance so the rope is taut when reeled in.
    const target = (dist / (this.count - 1)) * (1 + slack * 0.22);
    this.restLength = lerp(this.restLength, target, 0.35);

    const dt2 = Math.min(dt, 1 / 40);
    for (let i = 1; i < this.count - 1; i++) {
      const p = this.points[i], pr = this.prev[i];
      const vx = (p.x - pr.x) * this.damping;
      const vy = (p.y - pr.y) * this.damping;
      const vz = (p.z - pr.z) * this.damping;
      pr.copy(p);
      p.x += vx + this.gravity.x * dt2 * dt2;
      p.y += vy + this.gravity.y * dt2 * dt2;
      p.z += vz + this.gravity.z * dt2 * dt2;
    }
    this.points[0].copy(anchorA);
    this.points[this.count - 1].copy(anchorB);

    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < this.count - 1; i++) {
        const a = this.points[i], b = this.points[i + 1];
        _d.subVectors(b, a);
        const d = _d.length();
        if (d < 1e-5) continue;
        const diff = (d - this.restLength) / d * 0.5;
        _d.multiplyScalar(diff);
        if (i !== 0) a.add(_d);
        if (i + 1 !== this.count - 1) b.sub(_d);
      }
      this.points[0].copy(anchorA);
      this.points[this.count - 1].copy(anchorB);
    }

    const arr = this.geometry.attributes.position.array;
    for (let i = 0; i < this.count; i++) {
      arr[i * 3] = this.points[i].x;
      arr[i * 3 + 1] = this.points[i].y;
      arr[i * 3 + 2] = this.points[i].z;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  setTension(t) {
    this.tension = clamp01(t);
    // Line brightens and reddens as it approaches breaking.
    this.material.color.setRGB(1, 1 - this.tension * 0.55, 1 - this.tension * 0.75);
    this.material.opacity = 0.7 + this.tension * 0.3;
  }

  dispose(scene) {
    scene.remove(this.mesh); scene.remove(this.mesh2);
    this.geometry.dispose(); this.material.dispose(); this.material2.dispose();
  }
}

const _d = new THREE.Vector3();
