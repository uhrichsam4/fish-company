# Known Bugs

## Open
| # | Severity | Area | Issue | Notes |
|---|---|---|---|---|
| B-17 | low | Testing | FPS readings taken while the automation pane isn't compositing are meaningless — the fallback ticker is throttled. Measure `perf.renderMs` / per-system update cost instead. Current real cost: **~1 ms/frame CPU, ~1 ms render at 2880x1620**. | Documented; don't chase it again. |
| B-14 | low | Workers | Crew occasionally pick fishing spots close together despite the 6.5 m dedup, when few spots pass the water test. | Generate more shoreline candidates per region. |
| B-15 | low | UI | Company panel has no Contracts or Processing tab; those systems are only reachable over the event bus. | Add tabs. |
| B-16 | low | Boats | Hull takes a little damage from wave-driven contacts even in open water. | Filter contacts by relative normal velocity rather than body speed. |

## Fixed
| # | Area | Issue | Fix |
| B-19 | Terrain | Dark angular streaks over half of every island, with a razor-straight seam along a world axis. Read as a lighting, shadow or noise-aliasing bug and survived a dozen attempts at all three. | Region footprints overlap (Crash reaches 250 m from the origin, Harbour 400 m from (-400, 400) — eight pairs in all) and every region samples the same `worldHeight`, so overlaps drew two near-identical surfaces that z-fought. Terrain now builds on one global lattice and each cell is emitted only by its owning region. Verified over 1.38 M world samples: every point in any footprint is drawn exactly once, no holes. |
| B-20 | Dressing | `[Dressing] wilds failed: Cannot read properties of undefined (reading 'set')` — the jungle region lost all its set dressing. | `buildShellsAndDebris` returns a `{ pieces, group, material }` descriptor, not an Object3D; `place()` now unwraps it and rejects anything that still isn't one. |
| B-21 | Testing | Every gameplay test run after a screenshot run failed at the first input. | `TEST.shot` left the survey pose held, which freezes the player; it now releases, and `progression.run` clears it defensively. |
| B-22 | Boats | Boarding and leaving a boat could happen in the same frame. | Interaction (order 65) and BoatSystem (order 76) both consumed the same `E`; BoatSystem now swallows it until the key comes back up, matching SubSystem. |
| B-23 | Audio | Boss fight music stuck on after the boss died. | MusicDirector counted both `boss:spawn` (a request) and `boss:spawned` (the fact); it now counts only the latter, and BossSystem's compensating ref-count emits are gone. |
| B-24 | Weapons | A net, a melee swing or a tethered harpoon landed a boss outright, paying the defeat reward for free. | `killFish` refuses a boss entry — its HP pool is authoritative — and `_hitFish` now emits `weapon:hit` so BossSystem reads real impact points instead of guessing from the aim ray. |
| B-12 | Economy | `computeFishValue` priced a Golden Abyssal Leviathan at ~$14 B. | `softCapValue` compresses by sqrt above $20 k (leviathan ~$5.7 M, golden ~$27.5 M). |
| B-13 | Render | 921 draw calls; every prop was its own mesh. | Static batching by material signature + fish LOD + worker mesh merging → ~210 draws. |
| B-18 | Ocean | The whole ocean vanished — a partial edit left a call to a helper I'd deleted, so the fragment shader failed to compile and the material silently rendered nothing. | Rewrote the block; added `TEST.checkShaders()` which relinks every material and surfaces compile errors, so this can't pass a screenshot review again. |
|---|---|---|---|
| B-01 | Terrain | Points outside an island clamped to sea level, so no water existed offshore. | `land` initialises to `-1e9`, not `0`. |
| B-02 | Ocean | Waves were 5.8 m peak-to-trough on a starter beach. | Gerstner amplitude is `steepness/k`, not `steepness` — retuned all four wave sets. |
| B-03 | Ocean | Hard horizon seam: the clipmap ended at ±1536 m, the skirt began at 2900 m. | 6 clipmap levels (±3072 m) and the skirt starts at 2400 m. |
| B-04 | Terrain | Diagonal stripes across every island. | `sin(dot())` hashing aliases on a regular grid — replaced with an integer bit-mix. |
| B-05 | Viewmodel | Hands rendered as two giant floating boxes. | Rebuilt as two-bone IK with non-nested limbs (nested scale was inflating the hands). |
| B-06 | Viewmodel | Arms filled the screen as huge tubes. | The shoulder sat behind the near plane; moved it in front, added the `POS_K` depth knob. |
| B-07 | Inventory | Weapons were assigned to a `weapon` slot the hotbar never read. | Added a dedicated weapon hotbar slot. |
| B-08 | Physics | Everything sank: buoyancy used 9.81 while the world runs at −22. | `applyBuoyancy` now reads the world's gravity. |
| B-09 | Boats | Boats accelerated to 40 m/s. | Rapier's `addForce` persists until `resetForces()`, so per-frame calls compounded — switched to impulses and added a hard speed cap. |
| B-10 | Audio | `InvalidStateError` on every chord cue. | The chord synth starts its own oscillators; `play()` was starting them a second time. |
| B-11 | Testing | Game froze whenever the browser pane wasn't presenting. | Fallback ticker now fires whenever rAF has stalled, not only when `document.hidden`. |
