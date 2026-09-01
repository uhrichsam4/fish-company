# Polish Board

## Visual
- [ ] **Island density** — interiors read sparse from a distance; add mid-scale rocks, grass patches, height variation, and cluster vegetation instead of scattering it evenly.
- [ ] **Beach transition** — the sand/water line is clean but flat; add wet-sand darkening, tidal debris and foam that reacts to the actual wave phase.
- [ ] **Ocean at distance** — detail normals fade correctly but the mid-field still shows faint tiling. Consider a third normal layer at a prime-ratio scale.
- [ ] **Underwater** — no distinct underwater look yet outside the deep-sea system. Needs caustics on the underside of the surface, god rays near it, particulate, and a proper colour ramp.
- [x] Terrain colour banding.
- [x] Streaks and a hard seam across half of every island (overlapping region terrain z-fighting).
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
- [ ] **Fleet fuel readout** — a captain now turns back on the reserve, but nothing on the fleet card shows how much range is left.
- [ ] Fleet editor is functional but has no live profit estimate.

## Content
- [x] Per-region set dressing — all eight regions, the Abyss included.
- [x] NPC characters with dialogue.
- [x] Gambling minigames (fictional in-game currency only).
- [x] Random world events.
- [ ] **Island interiors** — the larger islands are dressed at the shoreline and the peak; the ground
      between them is still the generic decorator.
- [ ] **Quests beyond the main chain** — no side quests, no per-region contracts of their own, no boss
      rematches.
