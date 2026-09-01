/**
 * Audio asset manifest for Fish Company.
 *
 * Consumed by src/core/AudioManager.js (see `preload()` / `_entry()`):
 *   - `url` is the full asset path (including extension) when `variants`
 *     is 1 or omitted, or the *prefix* (no number, no extension) when
 *     `variants` > 1 -- the manager appends `${i}${ext}` for i in 1..variants
 *     and picks a random variant at play time (e.g. `footstep_sand` ->
 *     footstep_sand1.ogg .. footstep_sand4.ogg).
 *   - `volume` is a per-cue multiplier (0..1) applied on top of the bus
 *     volume (master/sfx/ui/ambience/music in AudioManager.volumes).
 *   - Every file referenced here lives in public/assets/audio/ and is
 *     credited in public/assets/audio/CREDITS.md.
 *
 * Regenerating audio: see tools/gen_audio.py (procedural synthesis) --
 * sourced recordings (Kenney / Freesound CC0) are not reproducible by
 * script and are committed as-is.
 */

const A = 'assets/audio/';

export const AUDIO_MANIFEST = {
  sfx: {
    // -- casting / line ------------------------------------------------
    cast_whoosh: { url: `${A}cast_whoosh.ogg`, volume: 0.8 },
    splash_small: { url: `${A}splash_small.ogg`, volume: 0.55 },
    splash_medium: { url: `${A}splash_medium.ogg`, volume: 0.75 },
    splash_big: { url: `${A}splash_big.ogg`, volume: 0.95 },
    reel_click: { url: `${A}reel_click.ogg`, volume: 0.45 },
    line_snap: { url: `${A}line_snap.ogg`, volume: 0.8 },

    // -- fish -------------------------------------------------------------
    fish_bite: { url: `${A}fish_bite.ogg`, volume: 0.75 },
    fish_flop: { url: `${A}fish_flop`, ext: '.ogg', variants: 3, volume: 0.6 },
    fish_impact: { url: `${A}fish_impact.ogg`, volume: 0.75 },
    fish_thrash: { url: `${A}fish_thrash.ogg`, volume: 0.7 },

    // -- footsteps ----------------------------------------------------
    footstep_sand: { url: `${A}footstep_sand`, ext: '.ogg', variants: 4, volume: 0.4 },
    footstep_wood: { url: `${A}footstep_wood`, ext: '.ogg', variants: 4, volume: 0.45 },
    footstep_metal: { url: `${A}footstep_metal`, ext: '.ogg', variants: 4, volume: 0.4 },
    jump: { url: `${A}jump.ogg`, volume: 0.5 },
    land: { url: `${A}land.ogg`, volume: 0.6 },

    // -- UI -------------------------------------------------------------
    ui_click: { url: `${A}ui_click.ogg`, volume: 0.5 },
    ui_hover: { url: `${A}ui_hover.ogg`, volume: 0.35 },
    ui_open: { url: `${A}ui_open.ogg`, volume: 0.5 },
    ui_close: { url: `${A}ui_close.ogg`, volume: 0.5 },
    ui_error: { url: `${A}ui_error.ogg`, volume: 0.55 },
    notification: { url: `${A}notification.ogg`, volume: 0.5 },

    // -- economy / progression ------------------------------------------
    purchase: { url: `${A}purchase.ogg`, volume: 0.65 },
    cash_register: { url: `${A}cash_register.ogg`, volume: 0.7 },
    coin: { url: `${A}coin`, ext: '.ogg', variants: 3, volume: 0.55 },
    quest_complete: { url: `${A}quest_complete.ogg`, volume: 0.75 },
    levelup: { url: `${A}levelup.ogg`, volume: 0.8 },
    rare_fish: { url: `${A}rare_fish.ogg`, volume: 0.85 },
    legendary: { url: `${A}legendary.ogg`, volume: 0.95 },
    record: { url: `${A}record.ogg`, volume: 0.8 },
    combo: { url: `${A}combo`, ext: '.ogg', variants: 5, volume: 0.5 },

    // -- weapons / tools --------------------------------------------------
    harpoon_fire: { url: `${A}harpoon_fire.ogg`, volume: 0.85 },
    harpoon_impact: { url: `${A}harpoon_impact.ogg`, volume: 0.85 },
    harpoon_reload: { url: `${A}harpoon_reload.ogg`, volume: 0.55 },
    spear_throw: { url: `${A}spear_throw.ogg`, volume: 0.7 },
    net_throw: { url: `${A}net_throw.ogg`, volume: 0.6 },
    club_hit: { url: `${A}club_hit.ogg`, volume: 0.8 },
    gun_shot: { url: `${A}gun_shot.ogg`, volume: 0.9 },
    gun_reload: { url: `${A}gun_reload.ogg`, volume: 0.55 },
    explosion: { url: `${A}explosion.ogg`, volume: 1.0 },

    // -- boat -------------------------------------------------------------
    boat_engine_start: { url: `${A}boat_engine_start.ogg`, volume: 0.7 },
    boat_engine_stop: { url: `${A}boat_engine_stop.ogg`, volume: 0.65 },
    boat_impact: { url: `${A}boat_impact.ogg`, volume: 0.85 },

    // -- submarine --------------------------------------------------------
    sub_dive: { url: `${A}sub_dive.ogg`, volume: 0.75 },
    sub_creak: { url: `${A}sub_creak`, ext: '.ogg', variants: 3, volume: 0.5 },
    sonar_ping: { url: `${A}sonar_ping.ogg`, volume: 0.55 },
    bubbles: { url: `${A}bubbles.ogg`, volume: 0.45 },
    underwater_whoosh: { url: `${A}underwater_whoosh.ogg`, volume: 0.6 },

    // -- weather / wildlife one-shots -------------------------------------
    thunder: { url: `${A}thunder`, ext: '.ogg', variants: 3, volume: 0.8 },
    seagull: { url: `${A}seagull`, ext: '.ogg', variants: 3, volume: 0.45 },

    // -- misc world ---------------------------------------------------
    pickup: { url: `${A}pickup.ogg`, volume: 0.45 },
    drop: { url: `${A}drop.ogg`, volume: 0.45 },
    crate_break: { url: `${A}crate_break.ogg`, volume: 0.8 },
    door_open: { url: `${A}door_open.ogg`, volume: 0.55 },
    boss_roar: { url: `${A}boss_roar.ogg`, volume: 1.0 },
    boss_slam: { url: `${A}boss_slam.ogg`, volume: 1.0 },
    radio_static: { url: `${A}radio_static.ogg`, volume: 0.4 },
  },

  loops: {
    cast_charge: { url: `${A}cast_charge.ogg`, volume: 0.5 },
    reel_loop: { url: `${A}reel_loop.ogg`, volume: 0.6 },
    line_tension: { url: `${A}line_tension.ogg`, volume: 0.45 },
    boat_engine_loop: { url: `${A}boat_engine_loop.ogg`, volume: 0.55 },
    boat_wake: { url: `${A}boat_wake.ogg`, volume: 0.4 },
    sub_ambient_loop: { url: `${A}sub_ambient_loop.ogg`, volume: 0.45 },
  },

  ambience: {
    amb_beach: { url: `${A}amb_beach.ogg`, volume: 0.4 },
    amb_ocean: { url: `${A}amb_ocean.ogg`, volume: 0.4 },
    amb_wind: { url: `${A}amb_wind.ogg`, volume: 0.3 },
    amb_rain: { url: `${A}amb_rain.ogg`, volume: 0.45 },
    amb_storm: { url: `${A}amb_storm.ogg`, volume: 0.55 },
    amb_underwater: { url: `${A}amb_underwater.ogg`, volume: 0.45 },
    amb_deep: { url: `${A}amb_deep.ogg`, volume: 0.5 },
    amb_harbor: { url: `${A}amb_harbor.ogg`, volume: 0.4 },
    amb_night: { url: `${A}amb_night.ogg`, volume: 0.35 },
  },

  music: {
    music_calm: { url: `${A}music_calm.ogg`, volume: 0.55 },
    music_boss: { url: `${A}music_boss.ogg`, volume: 0.6 },
    music_deep: { url: `${A}music_deep.ogg`, volume: 0.5 },
    music_menu: { url: `${A}music_menu.ogg`, volume: 0.5 },
  },
};

export default AUDIO_MANIFEST;
