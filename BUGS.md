# Known Bugs

## Open
| # | Severity | Area | Issue | Notes |
|---|---|---|---|---|
| B-12 | med | Economy | `computeFishValue` multiplies rarity mult × mass, so a Golden Abyssal Leviathan prices at ~$34 B — the late game overflows into meaninglessness. | Needs a soft cap / logarithmic tail above ~$10 M. |
| B-13 | med | Render | 679 draw calls and 458 k tris under stress. Props are individual meshes; the ocean clipmap alone is ~100 k tris. | Instance/merge static props per region; drop ocean ring levels by distance. |
| B-14 | low | Workers | Crew occasionally pick fishing spots close together despite the 6.5 m dedup, when few spots pass the water test. | Generate more shoreline candidates per region. |
| B-15 | low | UI | Company panel has no Contracts or Processing tab; those systems are only reachable over the event bus. | Add tabs. |
| B-16 | low | Boats | Hull takes a little damage from wave-driven contacts even in open water. | Filter contacts by relative normal velocity rather than body speed. |

## Fixed
| # | Area | Issue | Fix |
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
