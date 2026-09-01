import * as THREE from 'three';
import { bus } from '../core/EventBus.js';

/**
 * Performance panel (F8 -> Perf, or F3).
 *
 * The numbers that matter are measured, not inferred:
 *
 *  - GPU time comes from EXT_disjoint_timer_query_webgl2, not from frame
 *    deltas. Frame delta measures whatever the compositor felt like doing;
 *    a timer query measures the work the GPU actually did, which is the only
 *    thing that tells you whether you are fill-rate bound.
 *  - Draw calls and triangles are read after an explicit info.reset(), because
 *    the renderer runs with autoReset off and the counters otherwise
 *    accumulate across frames and read as tens of thousands.
 *  - Scene composition (materials, shadow casters, lights) is counted on a
 *    slow timer, since traversing the graph every frame would itself show up
 *    in the measurement.
 */

const KEY = 'fishcompany.perf.open';

export class PerfPanel {
  constructor(game) {
    this.game = game;
    this.name = 'perfpanel';
    this.order = 99;
    this.open = false;
    this.el = null;

    this.gpuMs = 0;
    this._queries = [];
    this._ext = null;
    this._sceneStats = null;
    this._sceneT = 0;
    this._histFps = [];
    this._histGpu = [];
  }

  async init(game) {
    const gl = game.renderer.getContext();
    this._ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    const el = document.createElement('div');
    el.className = 'perf-panel';
    document.body.appendChild(el);
    this.el = el;

    try { if (localStorage.getItem(KEY) === '1') this.toggle(true); } catch { /* private mode */ }
    bus.on('perf:toggle', () => this.toggle());
    return this;
  }

  toggle(force) {
    this.open = force != null ? force : !this.open;
    this.el.classList.toggle('show', this.open);
    try { localStorage.setItem(KEY, this.open ? '1' : '0'); } catch { /* ignore */ }
  }

  /**
   * Wrap one render in a GPU timer query. Called by Game around its render so
   * the measurement covers exactly the frame that was presented.
   */
  beginGPU() {
    if (!this.open || !this._ext) return null;
    const gl = this.game.renderer.getContext();
    const q = gl.createQuery();
    gl.beginQuery(this._ext.TIME_ELAPSED_EXT, q);
    return q;
  }

  endGPU(q) {
    if (!q || !this._ext) return;
    const gl = this.game.renderer.getContext();
    gl.endQuery(this._ext.TIME_ELAPSED_EXT);
    this._queries.push(q);
    // Results land a frame or two later; drain whatever is ready.
    for (let i = this._queries.length - 1; i >= 0; i--) {
      const query = this._queries[i];
      const disjoint = gl.getParameter(this._ext.GPU_DISJOINT_EXT);
      if (disjoint) { gl.deleteQuery(query); this._queries.splice(i, 1); continue; }
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
      this.gpuMs = this.gpuMs * 0.85 + (ns / 1e6) * 0.15;
      gl.deleteQuery(query);
      this._queries.splice(i, 1);
    }
    if (this._queries.length > 6) { gl.deleteQuery(this._queries.shift()); }
  }

  _countScene() {
    const g = this.game;
    let meshes = 0, casters = 0, lights = 0, shadowLights = 0, transparent = 0, doubleSided = 0, skinned = 0;
    const mats = new Set(), geos = new Set();
    g.scene.traverse((o) => {
      if (o.isLight) { lights++; if (o.castShadow) shadowLights++; return; }
      if (!o.isMesh) return;
      meshes++;
      if (o.castShadow) casters++;
      if (o.isSkinnedMesh) skinned++;
      if (o.geometry) geos.add(o.geometry.uuid);
      const m = o.material;
      if (!m) return;
      for (const mm of (Array.isArray(m) ? m : [m])) {
        mats.add(mm.uuid);
        if (mm.transparent) transparent++;
        if (mm.side === THREE.DoubleSide) doubleSided++;
      }
    });
    const info = g.renderer.info;
    return {
      meshes, casters, lights, shadowLights, transparent, doubleSided, skinned,
      materials: mats.size, geometries: geos.size,
      texturesGPU: info.memory.textures, geometriesGPU: info.memory.geometries,
      programs: info.programs?.length ?? 0,
    };
  }

  update(dt, game) {
    if (!this.open) return;
    this._sceneT += dt;
    if (!this._sceneStats || this._sceneT > 2) { this._sceneT = 0; this._sceneStats = this._countScene(); }

    const p = game.perf;
    this._histFps.push(p.fps); if (this._histFps.length > 90) this._histFps.shift();
    this._histGpu.push(this.gpuMs); if (this._histGpu.length > 90) this._histGpu.shift();

    const s = this._sceneStats;
    const r = game.renderer;
    const px = r.domElement.width * r.domElement.height;
    const fish = game.get('fish');
    const build = game.get('build');
    const trees = game.get('trees');
    const storm = game.get('storm');

    const bar = (v, max) => {
      const n = Math.round(Math.min(1, v / max) * 14);
      return `<i class="${v / max > 0.85 ? 'bad' : v / max > 0.6 ? 'warn' : ''}">${'▇'.repeat(n)}${'·'.repeat(14 - n)}</i>`;
    };
    const row = (k, v, extra = '') => `<div class="pp-row"><span>${k}</span><b>${v}</b>${extra}</div>`;

    this.el.innerHTML = `
      <div class="pp-head">PERFORMANCE <span>F3 / F8</span></div>
      ${row('FPS', p.fps.toFixed(0), bar(60 - Math.min(60, p.fps), 60))}
      ${row('CPU frame', `${p.ms.toFixed(2)} ms`, bar(p.ms, 16.7))}
      ${row('GPU frame', `${this.gpuMs.toFixed(2)} ms`, bar(this.gpuMs, 16.7))}
      ${row('  ├ render', `${p.renderMs.toFixed(2)} ms`)}
      ${row('  └ physics', `${p.physMs.toFixed(2)} ms`)}
      <div class="pp-sep">RENDER</div>
      ${row('draw calls', p.drawCalls)}
      ${row('triangles', (p.tris / 1000).toFixed(0) + 'k')}
      ${row('pixels', (px / 1e6).toFixed(2) + ' Mpx')}
      ${row('pixel ratio', r.getPixelRatio().toFixed(2) + ` / dpr ${window.devicePixelRatio}`)}
      ${(() => { const u = game.get('upscaler')?.stats();
        return row('upscaler', u ? `${u.mpx.toFixed(2)} Mpx  (${Math.round((u.mpx / (px / 1e6)) * 100)}%)` : 'off'); })()}
      ${row('quality', game.quality)}
      ${row('programs', s.programs)}
      <div class="pp-sep">SCENE</div>
      ${row('meshes', s.meshes)}
      ${row('materials', s.materials)}
      ${row('geometries', s.geometries)}
      ${row('shadow casters', s.casters)}
      ${row('lights', `${s.lights} (${s.shadowLights} casting)`)}
      ${row('transparent', s.transparent)}
      ${row('double-sided', s.doubleSided)}
      <div class="pp-sep">MEMORY</div>
      ${row('textures', s.texturesGPU)}
      ${row('geometries', s.geometriesGPU)}
      <div class="pp-sep">SIMULATION</div>
      ${row('physics bodies', `${game.physics.bodyCount} (${game.physics.activeCount} awake)`)}
      ${row('fish alive', fish?.active.length ?? 0)}
      ${row('physical fish', game.get('physfish')?.list.length ?? 0)}
      ${row('build pieces', build ? `${build.pieces.size} (${build.debris.length} debris)` : '—')}
      ${row('trees', trees ? trees.trees.size : '—')}
      ${row('sea level', storm ? `${(storm.surge + storm.event).toFixed(2)} m` : '—')}
      ${row('storm', storm ? `${(storm.intensity * 100).toFixed(0)}%${storm.eventActive ? ' EVENT' : ''}` : '—')}`;
  }

  dispose() { this.el?.remove(); }
}
