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
| Deep sea | ✅ 🧪 | Depth-driven fog/light/colour, vents, wrecks, bioluminescence |

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
| Bosses | ✅ 🧪 | 6 bosses, phases, weak points, ram/dive/summon/shockwave/armour, health bar, rewards. Verified: 3 phases → death → payout → unlock |
| Submarines | ✅ 🧪 | 4 subs, depth/hull/power/oxygen, sonar scope, lights, crush depth, expeditions |
| World events | ✅ 🧪 | 11 events that change real state (spawn tables, weather, prices, fleets) |
| NPCs + dialogue | ✅ 🧪 | 12 characters with idle animation, name labels, gossip driven by live state |
| Gambling | ✅ | 5 minigames, in-game currency only, 6% stated edge verified empirically over 4000 plays |
| Tutorial + waypoints | ✅ | Contextual hints keyed to real state; world-space markers with edge clamping |
| VFX | ✅ | 28 GPU-simulated effects, wake ribbons, water decals |
| UI | ✅ 💅 | HUD, shop, inventory, atlas, company, map, pause, fleet editor, boat upgrades |
| Debug menu (F8) | ✅ | Money, fish, bosses, regions, weather, time, overlays, save tools |

## Verified end-to-end
Run these from the console on the test server:
```js
const P = await import('/tools/progression.js'); console.log(P.summary(await P.run()))  // full game
const S = await import('/tools/scenarios.js');   console.log(S.summary(await S.run()))  // core/physics/save/stress
const U = await import('/tools/uiTest.js');      console.log(U.summary(await U.run()))  // real-pointer UI
const F = await import('/tools/fleetScenario.js'); console.log(F.summary(await F.run()))
```
- **Full progression (26/26)** — fresh save → rod pickup → fishing → selling → shop → tricks → weapons →
  region unlock → research → harbour → hire → worker fishes on their own → boat → captain → fleet →
  autonomous trip returns $24,447 → save/load restores the whole company → no shader or console errors.
- **UI (13 panels)** — every panel opens, its backdrop/close/controls pass a real `elementFromPoint`
  hit test, renders live data, fits 1280×720, and tabs switch on a synthetic pointer click.
- **Core loop / physics / save / stress** — flopping, throwing, sell-bin trick shot, no NaN transforms,
  save round-trip, 34 AI fish + 24 physical + 99 bodies within budget.
- **Fishing timing** — 5/5 catches at 7–12 s cast-to-land.
- **Bosses** — 3 phases → death → $11,000 payout → feature unlock, no errors.

## Measured performance
~1 ms/frame CPU (all 40 systems), ~1 ms render at 2880×1620 with pixelRatio 2, ~210 draw calls,
~700 k triangles. FPS numbers read while the automation pane isn't compositing are meaningless —
the fallback ticker is throttled; measure `perf.renderMs` and per-system update cost instead.

## Next priorities
1. **Play the whole thing by hand.** Everything below is verified by automation; the parts automation
   can't judge (pacing, whether the first five minutes actually teach the game, whether a fight is fun)
   need a human pass.
2. **Underwater** — diving still has no distinct look above the deep-sea system's depth range: no
   caustics, no surface-from-below, no particulate.
3. **Region decoration depth** — Crash, Rocky, Harbour, Wilds, Storm, Frozen and Station have bespoke
   dressing; the Abyss is bare and the inland areas of the larger islands are still generic.
4. **Economy balance** — per-catch value is now monotone with region tier (22 / 226 / 353 / 2,299 /
   8,641 / 10,245 / 13,228 / 37,410) and every region unlock pays back in 2-17 catches. Still untested
   over a long session against fleet and contract income, which scale on their own curves.
5. **Boat/sub crews on deck** — crew board and stand, but they don't work stations while under way.
6. **More content passes** — quests beyond the main chain, per-region contracts, boss rematches.
