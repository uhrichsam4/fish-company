import { Game, setStatus } from './core/Game.js';
import { bus } from './core/EventBus.js';
import { Sky } from './world/Sky.js';
import { Ocean } from './world/Ocean.js';
import { World } from './world/World.js';
import { Player } from './player/Player.js';
import { HUD } from './ui/HUD.js';
import { REGION_BY_ID } from './data/regions.js';
import { worldHeight } from './world/Terrain.js';

/** Every module the optional-system list can name, bundled at build time. */
const SYSTEM_MODULES = import.meta.glob('./**/*.js');

const bootEl = document.getElementById('boot');
const fillEl = document.getElementById('boot-fill');
const errEl = document.getElementById('boot-error');
const ctp = document.getElementById('click-to-play');

let progress = 0;
function setProgress(p) {
  progress = Math.max(progress, p);
  if (fillEl) fillEl.style.width = `${Math.round(progress * 100)}%`;
}

function fatal(err) {
  console.error(err);
  if (errEl) {
    errEl.textContent = `FAILED TO START\n${err?.stack || err?.message || String(err)}`;
  }
  setStatus('failed');
}

window.addEventListener('error', (e) => {
  if (!bootEl.classList.contains('done')) fatal(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason);
});

async function boot() {
  const canvas = document.getElementById('game-canvas');
  const game = new Game(canvas);
  window.GAME = game; // debugging handle

  setProgress(0.04);
  await game.init();
  setProgress(0.14);

  setStatus('waking the audio engine…');
  const { AUDIO_MANIFEST } = await import('./data/audioManifest.js').catch(() => ({ AUDIO_MANIFEST: null }));
  await game.audio.init(AUDIO_MANIFEST);
  setProgress(0.18);

  // ---- systems ----
  game.add(new Sky(game));
  game.add(new Ocean(game, { seaLevel: 0 }));
  game.add(new World(game));
  game.add(new Player(game));
  game.add(new HUD(game));

  // Optional systems load defensively so a single broken module can't brick boot.
  const optional = [
    ['./fx/Effects.js', 'Effects'],
    ['./economy/Economy.js', 'Economy'],
    ['./economy/Inventory.js', 'Inventory'],
    ['./economy/Resources.js', 'ResourceSystem'],
    ['./world/TreeSystem.js', 'TreeSystem'],
    ['./world/TrapSystem.js', 'TrapSystem'],
    ['./world/FloodSystem.js', 'FloodSystem'],
    ['./build/BuildSystem.js', 'BuildSystem'],
    ['./world/Weather.js', 'Weather'],
    ['./world/StormSystem.js', 'StormSystem'],
    ['./fish/FishSystem.js', 'FishSystem'],
    ['./fish/PhysicalFish.js', 'PhysicalFishManager'],
    ['./fish/BossSystem.js', 'BossSystem'],
    ['./fishing/TrickSystem.js', 'TrickSystem'],
    ['./fishing/FishingSystem.js', 'FishingSystem'],
    ['./weapons/WeaponSystem.js', 'WeaponSystem'],
    ['./player/HeldItems.js', 'HeldItems'],
    ['./player/Interaction.js', 'Interaction'],
    ['./quests/QuestSystem.js', 'QuestSystem'],
    ['./quests/DailyChallenges.js', 'DailyChallenges'],
    ['./economy/Research.js', 'Research'],
    ['./economy/Harbor.js', 'Harbor'],
    ['./economy/Company.js', 'Company'],
    ['./economy/Contracts.js', 'Contracts'],
    ['./economy/Processing.js', 'Processing'],
    ['./economy/Gambling.js', 'Gambling'],
    ['./workers/WorkerSystem.js', 'WorkerSystem'],
    ['./boats/BoatSystem.js', 'BoatSystem'],
    ['./boats/FleetSystem.js', 'FleetSystem'],
    ['./submarines/SubSystem.js', 'SubSystem'],
    ['./submarines/DeepSea.js', 'DeepSea'],
    ['./net/NetSystem.js', 'NetSystem'],
    ['./characters/CharacterModel.js', 'CharacterModel'],
    ['./world/LobbySystem.js', 'LobbySystem'],
    ['./world/EventSystem.js', 'EventSystem'],
    ['./world/NPCSystem.js', 'NPCSystem'],
    ['./world/Ambience.js', 'Ambience'],
    ['./core/MusicDirector.js', 'MusicDirector'],
    ['./world/Birds.js', 'Birds'],
    ['./ui/Tutorial.js', 'Tutorial'],
    ['./ui/Waypoints.js', 'Waypoints'],
    ['./ui/Minimap.js', 'Minimap'],
    ['./world/Harvestables.js', 'HarvestSystem'],
    ['./fx/Upscaler.js', 'Upscaler'],
    ['./ui/BuildMenu.js', 'BuildMenu'],
    ['./quests/Journey.js', 'Journey'],
    ['./fx/Underwater.js', 'Underwater'],
    ['./ui/UIManager.js', 'UIManager'],
    ['./util/PerfPanel.js', 'PerfPanel'],
    ['./ui/DebugMenu.js', 'DebugMenu'],
  ];
  // Resolved through import.meta.glob, not a bare dynamic import. A runtime
  // string path cannot be analysed by the bundler, so `import(path)` works in
  // dev -- where the dev server happens to serve the source tree at those
  // paths -- and 404s in a build. That silently reduced the shipped game to
  // the five statically imported systems: no fishing, no fish, no economy.
  // Globbing gives the bundler a set it can actually include.
  for (const [path, name] of optional) {
    try {
      const loader = SYSTEM_MODULES[path];
      if (!loader) { console.warn(`[boot] system ${name} not found at ${path}`); continue; }
      const mod = await loader();
      const Cls = mod[name] || mod.default;
      if (Cls) game.add(new Cls(game));
      else console.warn(`[boot] ${path} has no export "${name}"`);
    } catch (e) {
      console.warn(`[boot] optional system ${name} unavailable:`, e.message);
    }
  }
  setProgress(0.24);

  setStatus('building the world…');
  await game.initSystems();
  setProgress(0.86);

  // Every system exposing save/load participates in the versioned save.
  for (const s of game.systems) {
    if (typeof s.save === 'function' && typeof s.load === 'function' && s.name) {
      game.save.register(s.name, () => s.save(), (d) => s.load(d));
    }
  }
  game.save.register('settings', () => game.settings, (d) => { Object.assign(game.settings, d || {}); game.applySettings(); });

  setStatus('loading sounds…');
  game.audio.preload((p) => {
    setProgress(0.86 + p * 0.13);
    setStatus(`loading sounds… ${Math.round(p * 100)}%`);
  }).then((res) => {
    if (res) console.info(`[Audio] ${res.total - res.missing}/${res.total} sounds loaded`);
  });

  // ---- spawn ----
  const world = game.get('world');
  const player = game.get('player');
  // A new game starts on Lobby Island, where the start pads are; a restored
  // save is put back wherever it left off, so returning players are not
  // dropped somewhere they did not expect.
  const lobbyDef = REGION_BY_ID.lobby;
  if (lobbyDef && !game.save.hasSave()) {
    setStatus('raising Lobby Island…');
    await world.activateRegion('lobby');
    player.spawnAt({ x: lobbyDef.x, y: worldHeight(lobbyDef.x, lobbyDef.z) + 1.5, z: lobbyDef.z }, 0);
  } else {
    const anchors = world.getAnchors('crash');
    const spawn = anchors.spawn;
    const toShore = Math.atan2(anchors.shore.z - spawn.z, anchors.shore.x - spawn.x);
    player.spawnAt(spawn, -toShore + Math.PI / 2);
  }

  // Try to restore a save.
  if (game.save.hasSave()) {
    setStatus('restoring your empire…');
    try { game.save.load(); } catch (e) { console.error('[boot] load failed', e); }
  } else {
    bus.emit('game:newgame');
  }

  setProgress(1);
  setStatus('ready');
  game.start();

  setTimeout(() => {
    bootEl.classList.add('done');
    ctp.classList.remove('hidden');
  }, 260);

  const enter = () => {
    ctp.classList.add('hidden');
    game.input.requestLock();
    if (game.audio.ctx?.state === 'suspended') game.audio.ctx.resume();
    bus.emit('game:entered');
  };
  // Menu buttons act instead of the old "click anywhere to play" behaviour,
  // so a click on the multiplayer fields no longer drops you into the game.
  ctp.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.menu;
      if (act === 'play') enter();
      else if (act === 'settings') {
        const ui = game.get('ui');
        const pause = ui?.panels?.get?.('pause');
        if (pause) pause.activeTab = 'settings';
        ui?.show('pause');
      } else if (act === 'multiplayer') {
        const slot = ctp.querySelector('[data-menu-panel="multiplayer"]');
        if (!slot) return;
        const show = slot.hasAttribute('hidden');
        slot.toggleAttribute('hidden', !show);
        btn.setAttribute('aria-expanded', String(show));
      }
      return;
    }
    // Clicks on the card itself (inputs, labels) must not start the game.
    if (e.target.closest('.menu-card')) return;
    enter();
  });
  bus.on('pointer:unlocked', () => {
    // Cursor mode releases the pointer on purpose so the player can click the
    // build palette. Treating that as "they tabbed away" put the click-to-play
    // card, at z-index 900, straight over the thing they released the pointer
    // to reach.
    const ui = game.get('ui');
    if (!ui?.anyOpen?.() && !ui?.cursorMode) ctp.classList.remove('hidden');
  });
  bus.on('pointer:locked', () => ctp.classList.add('hidden'));
  bus.on('ui:opened', () => ctp.classList.add('hidden'));
  bus.on('ui:cursorMode', ({ on }) => { if (on) ctp.classList.add('hidden'); });
  bus.on('ui:closed', () => { if (!game.input.locked) game.input.requestLock(); });

  if (import.meta.env?.DEV || location.search.includes('test')) {
    try {
      const { installTestHarness } = await import('./util/testHarness.js');
      installTestHarness(game);
    } catch (e) { console.warn('[boot] test harness unavailable', e.message); }
  }

  console.info('%c🐟 Fish Company booted', 'color:#2fd4c4;font-weight:bold', {
    systems: game.systems.map((s) => s.name),
  });
}

boot().catch(fatal);
