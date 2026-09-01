# Polish Board

## Visual
- [ ] **Island density** — interiors read sparse from a distance; add mid-scale rocks, grass patches, height variation, and cluster vegetation instead of scattering it evenly.
- [ ] **Beach transition** — the sand/water line is clean but flat; add wet-sand darkening, tidal debris and foam that reacts to the actual wave phase.
- [ ] **Ocean at distance** — detail normals fade correctly but the mid-field still shows faint tiling. Consider a third normal layer at a prime-ratio scale.
- [ ] **Underwater** — no distinct underwater look yet outside the deep-sea system. Needs caustics, god rays near the surface, particulate, and a proper colour ramp.
- [x] Terrain colour banding.
- [x] Night water (was staying tropical after dark).
- [ ] **Shadows** — a single 90 m cascade; distant terrain has no shadowing at all.
- [ ] **Worker variety** — silhouettes vary, but everyone walks identically. Per-worker gait speed/stride/lean.
- [ ] **Fish schools** — reads well close up; distant schools should become a cheaper shoal impostor rather than vanishing.
- [ ] Boat wake foam is a single ribbon; add a spreading foam decal that persists a few seconds.

## Game feel
- [ ] **Cast** — needs a stronger anticipation pose and a whip on release; the rod bend is there but the hands don't follow through.
- [ ] **Hook-set** — the window is invisible. A brief flash or a bobber dip animation would make the timing learnable.
- [ ] **Reeling** — tension bar works; add controller-style rumble equivalents: camera pull toward the fish, line vibration, reel pitch tracking.
- [x] Landing a fish launches it physically.
- [ ] **Selling** — money burst exists; add a physical scale animation and a per-fish "cha-ching" stagger for multi-sales.
- [ ] **Boats** — acceleration feels right; wants engine pitch variation on wave impacts and a bow-slam camera kick.
- [ ] **Weapons** — verify recoil/impact feel once the weapons pass lands.

## Audio
- [ ] Footsteps only vary by surface, not by pace.
- [ ] No distinct "big fish on the line" cue.
- [ ] Music is intermittent by design; verify it doesn't feel absent.

## UX
- [ ] **Onboarding** — the first cast has no explanation of the hook-set window.
- [ ] **Objective marker** — no world-space waypoint toward the current objective.
- [ ] **Map** — regions render but there's no travel action from it.
- [ ] Company panel needs Contracts and Processing tabs.
- [ ] Fleet editor is functional but has no live profit estimate.

## Content
- [ ] Only Crash Island is decorated with intent; the other seven use the generic decorator.
- [ ] No NPC characters yet — the shop is a building, not a person.
- [ ] Gambling minigames (spec calls for optional in-game-currency ones) unstarted.
- [ ] Random events (migrations, market booms, boss sightings) unstarted.
