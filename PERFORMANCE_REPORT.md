# Performance Report

Machine: MacBook Pro M4 Pro, Chromium/WebKit, `devicePixelRatio` 2.
Scene: Crash Island, standing at the spawn, ordinary daytime gameplay.
Window: 1280×720 CSS.

## How these numbers were measured

Three things had to be fixed before any measurement meant anything:

1. **`requestAnimationFrame` FPS is unusable in a non-compositing window.**
   A first attempt measured ~1.9 FPS across every configuration, including
   ones that were obviously cheaper. That was rAF throttling, not the game.
   All GPU numbers below come from `EXT_disjoint_timer_query_webgl2`, which
   measures the work the GPU actually did and is unaffected by the
   compositor or vsync.

2. **`renderer.info.autoReset` is `false` in this project.** Draw-call and
   triangle counts therefore accumulate across frames. An early run reported
   "9539 draws / 24.8M triangles", which was 40 frames of accumulation, not
   a frame. The harness now calls `info.reset()` before every timed render.

3. **The scene streams while you measure.** Region activation changed the
   geometry between samples, so an "ablation" showed shadows-off as *slower*
   than shadows-on. Measurements are now taken with `game.running = false`
   and a fixed camera; identical draw/triangle counts across a sweep confirm
   only the tested variable changed.

Everything below is measured with the sim frozen, geometry verified
identical (232 draws / 604,878 triangles at every step), each configuration
sampled 4× interleaved with the baseline so drift affects all configs equally,
and the median reported.

## Baseline

| Metric | Value |
| --- | --- |
| GPU frame | **5.30 ms** |
| CPU frame | 1.82 ms |
| Render (CPU) | 1.26 ms |
| Physics | 0.02 ms |
| Draw calls | 232 |
| Triangles | 605k |
| Canvas | 2560×1440 (3.69 Mpx) |
| Pixel ratio | 2.0 |
| Meshes | 348 |
| Unique materials | 168 |
| Shadow casters | 158 |
| Lights | 17 |
| Double-sided materials | 119 |
| Physics bodies | 165 (0 awake) |
| Textures | 11 |

CPU frame time was 1.82 ms against a GPU frame of 5.30 ms. The game is
**GPU-bound, and specifically fill-rate bound** — not draw-call bound, not
geometry bound, not physics bound.

## Bottleneck isolation

### Resolution — dominant

Geometry identical at every step; only the render target changed.

| Pixel ratio | Pixels | GPU ms | vs baseline |
| --- | --- | --- | --- |
| 2.00 | 3.69 Mpx | 5.30 | — |
| 1.50 | 2.07 Mpx | 3.17 | **−40%** |
| 1.25 | 1.44 Mpx | 3.02 | −43% |
| 1.00 | 0.92 Mpx | 2.04 | −61% |

GPU time scales close to linearly with pixel count. Rendering at
unrestricted Retina was costing roughly 40% of the frame for detail that is
not visible at normal viewing distance.

This also explains the reported 52 FPS on a full-size window: at ~1900×1100
CSS the pixel count is about 2.3× this test, putting GPU frame time near
12 ms before anything else is counted.

### Shadows — not significant

| Config | Base | Test | Delta |
| --- | --- | --- | --- |
| Shadows off | 5.93 ms | 6.09 ms | within noise |
| Shadow map 4096 → 1024 | 5.48 ms | 5.84 ms | within noise |

Both land inside the run-to-run noise floor (±0.4 ms). Worth noting the
directional light still allocates a **4096² shadow map** (~64 MB), and at
night `castShadow` is gated off entirely, so the 158 meshes flagged as
shadow casters currently have no light casting them.

### Ocean — not significant

Hiding the ocean saved 0.15 ms (2.8%), inside noise.

## Changes made

**Per-quality pixel-ratio cap** (`Game.targetPixelRatio()`):

| Quality | Cap |
| --- | --- |
| low | 1.00 |
| medium | 1.25 |
| high | 1.50 |
| ultra | 2.00 |

Replaces `Math.min(devicePixelRatio, 2)` at both call sites, and is
re-applied when auto-quality changes tier. Ultra deliberately keeps native
Retina for anyone who wants it.

**F8 / F3 performance panel** (`src/util/PerfPanel.js`) reporting FPS, CPU
frame, GPU frame (real timer query, bracketing the presented frame), render
and physics splits, draw calls, triangles, megapixels, pixel ratio, quality,
shader programs, meshes, materials, geometries, shadow casters, lights and
how many cast, transparent and double-sided counts, GPU textures and
geometries, physics bodies and how many are awake, fish, physical fish,
build pieces and debris, trees, sea level and storm intensity.

## After

Measured live in the running frame loop, quality `high`:

| Metric | Before | After |
| --- | --- | --- |
| Pixel ratio | 2.00 | 1.50 |
| Canvas | 2560×1440 | 1920×1080 |
| Pixels | 3.69 Mpx | 2.07 Mpx |
| GPU frame | 5.30 ms | **4.52 ms** |
| CPU frame | 1.82 ms | 1.50 ms |
| Draw calls | 232 | 268 |
| Triangles | 605k | 606k |
| FPS (in-engine counter) | — | 115 |

The live GPU figure (4.52 ms) is higher than the frozen-scene measurement at
PR 1.5 (3.17 ms) because the running game is also animating fish, waves and
AI. The relative saving is what the frozen test establishes.

## Remaining expensive systems

Ranked by what the profile actually points at:

1. **168 unique materials across 362 meshes.** Roughly one material per
   object. Every distinct material is a potential shader/uniform switch.
   Consolidating shared prop materials is the next real win and would cut
   draw calls too.
2. **133 double-sided materials.** Double-sided doubles fragment work on
   overdrawn surfaces. Most props do not need it.
3. **4096² directional shadow map.** Not measurable in GPU time here but it
   is ~64 MB of VRAM, and the shadow camera bounds have not been profiled.
4. **158 meshes flagged `castShadow`** including small props. Restricting
   casting to large nearby geometry would cut the shadow pass.
5. **Trees are `noBatch`.** Required so they can be felled, but it costs
   draw calls. `InstancedMesh` with per-instance removal is the correct fix.

## Not done

Named explicitly so this is not mistaken for a finished optimisation pass:

- **Spector.js capture** — not run. No frame captures of normal play,
  fishing, storm or destruction were taken.
- **glTF-Transform / meshoptimizer / Draco / KTX2** — not applicable yet;
  the game has no imported GLB/GLTF assets, all geometry is procedural.
- **three-mesh-bvh** — not integrated. Raycasting has not been profiled and
  did not surface as a bottleneck at this scene size.
- **Comlink / Web Workers** — not integrated. CPU frame time is 1.5 ms;
  there is nothing on the main thread worth moving yet.
- **InstancedMesh for trees/rocks/grass** — not done.
- **Dynamic resolution scaling** — auto-quality switches tiers, which
  changes pixel ratio in steps; there is no continuous scaler.
- **Destruction stress test** — a 200-piece house collapsing has not been
  profiled, so the debris budget is unvalidated at scale.
- **postprocessing library** — not added. The game currently has no post
  chain, so there was nothing to profile or remove.

---

## Addendum — resolution upscaler

The report above concluded the renderer is fill-rate bound. A later session
briefly concluded the opposite from a run whose GPU timer queries were only
partly resolving: the average was taken over whatever came back (24–40 of 60
per cell), which flattened the curve and made pixel count look irrelevant.
Harvest every query before quoting the number, or discard the cell.

Re-measured with all 40 queries per cell resolving, frozen scene, identical
geometry, 1.39 Mpx drawing buffer:

| Configuration | Pixels | GPU ms | vs native |
|---|---|---|---|
| Native canvas (MSAA 4×) | 1.39 Mpx | 23.4 | — |
| Render target 1.00, MSAA 0 | 1.39 Mpx | 22.8 | −3% |
| Render target 1.00, MSAA 4 | 1.39 Mpx | 22.0 | −6% |
| Render target 0.75, MSAA 4 | 0.78 Mpx | 13.6 | **−42%** |
| Render target 0.50, MSAA 4 | 0.35 Mpx | 6.9 | **−71%** |

MSAA is not the variable — at full resolution 0× and 4× are inside the noise.
Pixel count is, which confirms the original finding rather than overturning it.

`fx/Upscaler.js` renders the scene to a target at `settings.upscaleScale` and
blits it with an RCAS-style contrast-adaptive sharpen. Default on at 0.75.
End-to-end with the shipped implementation: **18.8→9.2 ms and 20.7→8.7 ms**
across two interleaved rounds.

Two things that cost real time to find, both of which look like a working
build until you compare pixels:

- The render target must not carry the output colour space. Letting it do so
  means three.js encodes on the way in and decodes on the way out of the blit,
  and the image lands a full sRGB transfer too dark (measured: mid grey 117 →
  44). The target is linear and the blit shader encodes once, explicitly.
- Without `samples: 4` the target has no MSAA while the canvas has 4×, so the
  comparison flatters the upscaler and ships visible aliasing that the sharpen
  pass then amplifies. It measured free at 0.75, so there is no reason to.
