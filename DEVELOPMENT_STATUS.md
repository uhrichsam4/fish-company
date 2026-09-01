# Fish Company — Development Status

Legend: ✅ done · 🟡 partial · 🔴 broken · ⬜ unstarted · 🧪 needs testing · 💅 needs polish

## Running it
```bash
npm run dev          # http://localhost:5178  (HMR on)
npx vite --config vite.test.config.js   # http://localhost:5180 (HMR off — use for automated tests)
npm run build
```
In the browser console (dev builds expose a harness):
```js
TEST.state()                                   // live snapshot
const S = await import('/tools/scenarios.js'); console.log(S.summary(await S.run()))
const F = await import('/tools/fleetScenario.js'); console.log(F.summary(await F.run()))
```
`F8` opens the developer menu (money, spawn fish/bosses, unlock regions, weather, time, teleport).

## Architecture
- `src/core/` — Game loop + system registry, Input, AssetManager (procedural fallbacks), AudioManager (WebAudio buses + synth fallback), SaveManager (versioned, migrating), EventBus.
- `src/physics/` — Rapier wrapper: bodies, raycasts, collision groups, shared buoyancy solver.
- `src/world/` — Terrain (one authoritative height function), Ocean (Gerstner clipmap + heightmap-driven foam), Sky (procedural, day/night), Weather, props library, Ambience, Birds.
- `src/player/`, `src/fishing/`, `src/fish/`, `src/weapons/`, `src/workers/`, `src/boats/`, `src/submarines/`, `src/economy/`, `src/quests/`, `src/ui/`, `src/fx/`, `src/data/`.
- Systems are `{name, order, init, update, lateUpdate?, postRender?, save?, load?}`; anything with `save`+`load` is auto-registered with the save system.

## Systems

### Engine
| System | State | Notes |
|---|---|---|
| Game loop / system registry | ✅ | Fixed-step physics, auto quality scaling, stalled-rAF fallback for headless testing |
| Input | ✅ | Pointer lock, edge-triggered keys, UI capture |
| AssetManager | ✅ | Procedural fallback for every missing texture — never a black material |
| AudioManager | ✅ | Buses, 3D panning, underwater low-pass, reverb, full synth fallback |
| SaveManager | ✅ | v7 format, forward migrations, 3 slots, export/import |
| Physics (Rapier) | ✅ | Buoyancy now uses the world's gravity (was 9.81 vs −22 — everything sank) |

### World
| System | State | Notes |
|---|---|---|
| Terrain | ✅ 💅 | 8 regions, domain-warped islands, shelf + trench, streaming by proximity |
| Ocean | ✅ 💅 | Gerstner clipmap ±3 km, depth colouring from a baked heightmap, shoreline foam, ripples, night response |
| Sky / day-night | ✅ | Procedural dome, sun/moon/stars/clouds, drives all scene lighting |
| Weather | ✅ | 8 states, blended wave sets, lightning, region overrides |
| Props | ✅ | 35 seeded builders (trees, rocks, docks, shacks, cranes, wrecks…) |
| Ambience / music / birds | ✅ 🧪 | Positional beds, contextual music, flocking gulls |
| Deep sea | 🟡 | In progress |

### Gameplay
| System | State | Notes |
|---|---|---|
| First-person controller | ✅ | Rapier character controller, swimming, moving platforms, knockback |
| Viewmodel (hands + items) | ✅ 💅 | Two-bone IK arms, per-item grips, POS_K depth knob |
| Fishing | ✅ | Charge/cast/bite/hook-set/fight/land; verlet line, tension, rod bend |
| Fish AI | ✅ | 71 species, schooling, bait attraction, depth/time/weather preference, tiered updates |
| Physical caught fish | ✅ | Real bodies that flop, get thrown, knock things over, sell on contact with a bin |
| Trick shots / style | ✅ | 25 tricks, combo meter, multipliers feed the sale price |
| Weapons | ✅ 🧪 | Spear/harpoon/net/suction/beam + melee tools |
| Economy / inventory / shop | ✅ | 45 items, storage tiers, market drift, ledger |
| Quests | ✅ | 37 quests, event-driven objectives, region gating |
| Fish atlas | ✅ | Discovery, records, variants, region completion bonus |
| Workers | ✅ 💅 | 10 roles, 24 traits, skill trees, physical FSM (walk→cast→wait→reel→carry→sell) |
| Boats | ✅ 💅 | 8 hulls, buoyancy, thrust, speed cap, self-righting, walkable decks, driving |
| Fleets | ✅ 🧪 | Crews, autonomous trips, near/far simulation, fuel/wear/breakdowns |
| Research / harbour / contracts / processing | ✅ 🧪 | 55 nodes, 14 buildings, generated contracts, 4 processing tiers |
| Bosses | 🟡 | In progress |
| Submarines | 🟡 | In progress |
| VFX | ✅ | 28 GPU-simulated effects, wake ribbons, water decals |
| UI | ✅ 💅 | HUD, shop, inventory, atlas, company, map, pause, fleet editor, boat upgrades |
| Debug menu (F8) | ✅ | Money, fish, bosses, regions, weather, time, overlays, save tools |

## Verified end-to-end
- **Core loop** — rod pickup → cast → bite → hook → fight → land → carry → store → sell → buy upgrade. Automated, zero console errors.
- **Physics** — flopping, throwing, sell-bin trick shot, no NaN transforms.
- **Save/load** — money, equipment, stored fish, quest flags all round-trip.
- **Workers** — hired workers physically walk to the dock, cast, catch and bank money.
- **Stress** — 34 AI fish + 24 physical fish + 99 bodies held frame budget.

## Next priorities
1. Finish bosses + submarines (agents in flight).
2. Draw-call reduction: 679 draws / 458k tris under load is too high — instance props, merge static geometry, cut ocean tri count at distance.
3. Contracts + Processing tabs in the company panel.
4. Economy balance pass: the value formula multiplies rarity × mass, so a Golden Abyssal Leviathan prices at ~$34 B. Needs a soft cap.
5. Onboarding polish: the first five minutes must teach cast → bite → hook-set without a wall of text.
6. Second visual pass on islands (density, silhouette variety, prop placement rules).
