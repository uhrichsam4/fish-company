/**
 * FISH DATA — the whole bestiary.
 *
 * Every catchable thing in the game lives here, junk included. Nothing in this
 * file imports the renderer; `body` is a key into BODY_ARCHETYPES in
 * ../fish/FishMesh.js and that is the only coupling.
 *
 * Units: depth/length metres, weight kilograms, `value` is $ PER KILOGRAM.
 */

import { clamp, clamp01, lerp, weightedPick } from '../util/math.js';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Every habitat tag a species may claim. */
export const HABITATS = [
  'shallow', 'reef', 'coast', 'kelp', 'openocean', 'deep',
  'abyss', 'trench', 'arctic', 'river', 'harbor', 'wreck', 'vent',
];

/** Every region id the world can ask for. */
export const REGIONS = ['crash', 'rocky', 'harbor', 'wilds', 'storm', 'frozen', 'station', 'abyss'];

/** Fight behaviour archetypes, consumed by the fishing minigame. */
export const FIGHT_STYLES = ['weak', 'runner', 'diver', 'jumper', 'brawler', 'thrasher', 'titan'];

export const RARITY = {
  common:    { name: 'Common',    color: '#b8c0c8', mult: 1.0,  weight: 1000, glow: 0 },
  uncommon:  { name: 'Uncommon',  color: '#5ddb6a', mult: 1.6,  weight: 340,  glow: 0 },
  rare:      { name: 'Rare',      color: '#4aa8ff', mult: 3.0,  weight: 95,   glow: 0.15 },
  epic:      { name: 'Epic',      color: '#b96bff', mult: 7.0,  weight: 24,   glow: 0.3 },
  legendary: { name: 'Legendary', color: '#ffb340', mult: 18.0, weight: 5,    glow: 0.55 },
  mythic:    { name: 'Mythic',    color: '#ff4d6d', mult: 50.0, weight: 1,    glow: 0.9 },
};

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** Cosmetic + economic rolls layered on top of a species. */
export const VARIANTS = [
  { id: 'normal',     name: '',           valueMult: 1,    sizeMult: 1.0,  chance: 1000, tint: null,      glow: 0 },
  { id: 'large',      name: 'Large',      valueMult: 1.6,  sizeMult: 1.28, chance: 220,  tint: null,      glow: 0 },
  { id: 'huge',       name: 'Huge',       valueMult: 3.2,  sizeMult: 1.65, chance: 60,   tint: null,      glow: 0 },
  { id: 'giant',      name: 'Giant',      valueMult: 7.0,  sizeMult: 2.15, chance: 12,   tint: null,      glow: 0.1 },
  { id: 'albino',     name: 'Albino',     valueMult: 5.0,  sizeMult: 1.0,  chance: 26,   tint: '#f4f0ea', glow: 0.05 },
  { id: 'golden',     name: 'Golden',     valueMult: 14.0, sizeMult: 1.05, chance: 9,    tint: '#ffc22e', glow: 0.35 },
  { id: 'melanistic', name: 'Melanistic', valueMult: 6.0,  sizeMult: 1.06, chance: 20,   tint: '#1b1d24', glow: 0 },
  { id: 'shiny',      name: 'Shiny',      valueMult: 9.0,  sizeMult: 1.0,  chance: 14,   tint: '#9fe8ff', glow: 0.5 },
  { id: 'ancient',    name: 'Ancient',    valueMult: 22.0, sizeMult: 1.45, chance: 4,    tint: '#6b5b3e', glow: 0.2 },
  { id: 'mutated',    name: 'Mutated',    valueMult: 17.0, sizeMult: 1.3,  chance: 5,    tint: '#7bff4a', glow: 0.45 },
  { id: 'crystal',    name: 'Crystal',    valueMult: 30.0, sizeMult: 1.1,  chance: 2,    tint: '#a8e6ff', glow: 0.7 },
  { id: 'legendary',  name: 'Legendary',  valueMult: 60.0, sizeMult: 1.8,  chance: 1,    tint: '#ff9d2e', glow: 1.0 },
];

export const VARIANT_BY_ID = Object.freeze(
  VARIANTS.reduce((m, v) => { m[v.id] = v; return m; }, Object.create(null)),
);

export const NORMAL_VARIANT = VARIANT_BY_ID.normal;

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

export const FISH_SPECIES = [

  // === TIER 1 — the crash beach. Things you can catch with a stick. ========

  { id: 'sardine', name: 'Sardine', short: 'Sardine', tier: 1, habitat: ['shallow', 'coast'], regions: ['crash', 'rocky', 'harbor'],
    depth: [0.4, 14], weight: [0.05, 0.2], length: [0.09, 0.22], value: 3, rarity: 'common', spawnWeight: 240,
    strength: 0.05, speed: 0.55, stamina: 0.1, aggression: 0.75, escape: 0.08, fight: 'weak',
    body: 'sardine', colors: { main: '#6f9fc0', belly: '#f3f5f1', fin: '#a3c2d6', accent: '#31597a', eye: '#141414' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'A fish-shaped rounding error. Travels in schools so that no single sardine has to be memorable.',
    atlasHint: 'Any shallow water, any time. Smallest hook you own.',
    dangerous: false, boss: false, edible: true, xp: 2 },

  { id: 'anchovy', name: 'Anchovy', short: 'Anchovy', tier: 1, habitat: ['shallow', 'coast'], regions: ['crash', 'rocky', 'harbor'],
    depth: [0.5, 20], weight: [0.02, 0.12], length: [0.07, 0.18], value: 4, rarity: 'common', spawnWeight: 210,
    strength: 0.04, speed: 0.6, stamina: 0.09, aggression: 0.8, escape: 0.09, fight: 'weak',
    body: 'sardine', colors: { main: '#4f7d96', belly: '#ece9d8', fin: '#87a9bd', accent: '#8fd3e8', eye: '#101010' },
    pattern: 'stripes', glow: 0, time: 'any', weather: 'any',
    desc: 'Divisive on pizza, uncontroversial on a hook. Sells by the bucket, never by the fish.',
    atlasHint: 'Surface bait balls near the beach. Cast into the flickering.',
    dangerous: false, boss: false, edible: true, xp: 2 },

  { id: 'perch', name: 'Yellow Perch', short: 'Perch', tier: 1, habitat: ['shallow', 'river', 'kelp'], regions: ['crash', 'rocky'],
    depth: [0.5, 9], weight: [0.1, 1.1], length: [0.14, 0.35], value: 8, rarity: 'common', spawnWeight: 180,
    strength: 0.12, speed: 0.34, stamina: 0.2, aggression: 0.6, escape: 0.14, fight: 'runner',
    body: 'bass', colors: { main: '#d2a52e', belly: '#f6ecc8', fin: '#e06a2a', accent: '#2f4426', eye: '#161616' },
    pattern: 'bands', glow: 0, time: 'day', weather: 'any',
    desc: 'Striped like it is trying to look bigger. It is not working, but you respect the effort.',
    atlasHint: 'Daylight, weed edges and rocks. Bites almost anything.',
    dangerous: false, boss: false, edible: true, xp: 4 },

  { id: 'bass', name: 'Largemouth Bass', short: 'Bass', tier: 1, habitat: ['shallow', 'river', 'kelp'], regions: ['crash', 'rocky'],
    depth: [0.5, 8], weight: [0.6, 4.5], length: [0.25, 0.6], value: 14, rarity: 'common', spawnWeight: 140,
    strength: 0.24, speed: 0.38, stamina: 0.32, aggression: 0.72, escape: 0.26, fight: 'jumper',
    body: 'bass', colors: { main: '#4a7c3f', belly: '#e8e2c4', fin: '#3d6634', accent: '#2a4a22', eye: '#111111' },
    pattern: 'stripes', glow: 0, time: 'any', weather: 'any',
    desc: 'The mouth arrived first and the fish grew in behind it. Will strike anything it can fit, which is most things.',
    atlasHint: 'Shallow cover — logs, weed, dock shade. Loves a noisy lure.',
    dangerous: false, boss: false, edible: true, xp: 8 },

  { id: 'trout', name: 'Rainbow Trout', short: 'Trout', tier: 1, habitat: ['river', 'shallow'], regions: ['crash', 'rocky', 'frozen'],
    depth: [0.3, 12], weight: [0.4, 5.5], length: [0.25, 0.7], value: 16, rarity: 'common', spawnWeight: 130,
    strength: 0.22, speed: 0.52, stamina: 0.4, aggression: 0.5, escape: 0.32, fight: 'jumper',
    body: 'trout', colors: { main: '#6f8a9c', belly: '#f2ede0', fin: '#c46b7e', accent: '#e0577a', eye: '#131313' },
    pattern: 'spots', glow: 0, time: 'dawn', weather: 'any',
    desc: 'Spends the fight in the air on principle. Photographs well, which it seems to know.',
    atlasHint: 'Cold moving water at dawn. Small spinners near the current seams.',
    dangerous: false, boss: false, edible: true, xp: 9 },

  { id: 'carp', name: 'Common Carp', short: 'Carp', tier: 1, habitat: ['river', 'shallow', 'harbor'], regions: ['crash', 'harbor'],
    depth: [0.6, 7], weight: [1.5, 18], length: [0.35, 1.05], value: 9, rarity: 'common', spawnWeight: 110,
    strength: 0.38, speed: 0.2, stamina: 0.55, aggression: 0.35, escape: 0.18, fight: 'brawler',
    body: 'bass', colors: { main: '#9d7a3c', belly: '#e3d3a4', fin: '#6d5225', accent: '#c2a054', eye: '#171717' },
    pattern: 'mottled', glow: 0, time: 'any', weather: 'rain',
    desc: 'A muddy tank with fins. Fights like an argument with a landlord: slow, heavy, eventually resolved.',
    atlasHint: 'Silty margins, best after rain. Bread, corn, low expectations.',
    dangerous: false, boss: false, edible: true, xp: 7 },

  { id: 'mullet', name: 'Grey Mullet', short: 'Mullet', tier: 1, habitat: ['coast', 'harbor', 'shallow'], regions: ['crash', 'harbor'],
    depth: [0.3, 10], weight: [0.3, 3.2], length: [0.22, 0.62], value: 7, rarity: 'common', spawnWeight: 150,
    strength: 0.16, speed: 0.44, stamina: 0.3, aggression: 0.3, escape: 0.24, fight: 'runner',
    body: 'sardine', colors: { main: '#8fa2ab', belly: '#f0f0ea', fin: '#6f8189', accent: '#455860', eye: '#141414' },
    pattern: 'stripes', glow: 0, time: 'day', weather: 'any',
    desc: 'Grazes harbour walls with the air of somebody reading every plaque in a museum. Suspicious of hooks.',
    atlasHint: 'Harbour walls and warm shallows. Tiny bait, long patience.',
    dangerous: false, boss: false, edible: true, xp: 5 },

  { id: 'shore-crab', name: 'Shore Crab', short: 'Crab', tier: 1, habitat: ['shallow', 'coast', 'harbor'], regions: ['crash', 'rocky', 'harbor'],
    depth: [0.2, 6], weight: [0.08, 0.9], length: [0.06, 0.2], value: 11, rarity: 'common', spawnWeight: 120,
    strength: 0.18, speed: 0.12, stamina: 0.45, aggression: 0.55, escape: 0.3, fight: 'brawler',
    body: 'crab', colors: { main: '#b8532e', belly: '#e8c79a', fin: '#8f3a1e', accent: '#f0a05a', eye: '#0d0d0d' },
    pattern: 'mottled', glow: 0, time: 'any', weather: 'any',
    desc: 'Refuses to let go of the bait, the hook, or your finger. A grudge with legs.',
    atlasHint: 'Rocks and pilings. Drop bait to the bottom and wait for the tug that never stops.',
    dangerous: false, boss: false, edible: true, xp: 6 },

  { id: 'small-squid', name: 'Bay Squid', short: 'Sm. Squid', tier: 2, habitat: ['coast', 'shallow', 'harbor'], regions: ['crash', 'rocky', 'harbor'],
    depth: [2, 26], weight: [0.15, 1.4], length: [0.15, 0.45], value: 18, rarity: 'common', spawnWeight: 100,
    strength: 0.14, speed: 0.5, stamina: 0.28, aggression: 0.6, escape: 0.4, fight: 'runner',
    body: 'squid', colors: { main: '#d9788f', belly: '#f7e2e6', fin: '#b9536c', accent: '#ffd0a8', eye: '#0b0b0b' },
    pattern: 'spots', glow: 0.05, time: 'night', weather: 'any',
    desc: 'Arrives at the boat, considers its options, and inks all over the deck anyway.',
    atlasHint: 'Night, under a light. Jigs only — it will not take dead bait.',
    dangerous: false, boss: false, edible: true, xp: 10 },

  { id: 'mackerel', name: 'Atlantic Mackerel', short: 'Mackerel', tier: 2, habitat: ['coast', 'openocean'], regions: ['crash', 'rocky', 'harbor', 'wilds'],
    depth: [1, 45], weight: [0.25, 1.8], length: [0.2, 0.5], value: 12, rarity: 'common', spawnWeight: 165,
    strength: 0.18, speed: 0.68, stamina: 0.35, aggression: 0.82, escape: 0.2, fight: 'runner',
    body: 'tuna', colors: { main: '#2f6d86', belly: '#f1f3ee', fin: '#3f8ba6', accent: '#123d52', eye: '#111111' },
    pattern: 'stripes', glow: 0, time: 'any', weather: 'any',
    desc: 'Tiger-striped and permanently late for something. Hits the lure before it finishes sinking.',
    atlasHint: 'Anywhere the water boils. Six hooks, one cast, six mackerel.',
    dangerous: false, boss: false, edible: true, xp: 6 },

  { id: 'catfish', name: 'Channel Catfish', short: 'Catfish', tier: 2, habitat: ['river', 'harbor', 'shallow'], regions: ['crash', 'harbor'],
    depth: [1, 14], weight: [1.2, 16], length: [0.4, 1.15], value: 15, rarity: 'common', spawnWeight: 95,
    strength: 0.42, speed: 0.22, stamina: 0.6, aggression: 0.45, escape: 0.2, fight: 'brawler',
    body: 'catfish', colors: { main: '#59524a', belly: '#ded4bc', fin: '#3f3a34', accent: '#8a7c66', eye: '#0f0f0f' },
    pattern: 'mottled', glow: 0, time: 'night', weather: 'any',
    desc: 'Tastes the whole river with its face. Whatever you dropped in last week, it knows about it.',
    atlasHint: 'Deep muddy holes after dark. The smellier the bait, the better.',
    dangerous: false, boss: false, edible: true, xp: 12 },

  // --- Junk. Still species. Still counts for the atlas. ---

  { id: 'boot', name: 'Waterlogged Boot', short: 'Boot', tier: 1, habitat: ['shallow', 'harbor', 'river', 'wreck'], regions: ['crash', 'rocky', 'harbor', 'station'],
    depth: [0.2, 40], weight: [1.2, 1.2], length: [0.28, 0.34], value: 1, rarity: 'common', spawnWeight: 70,
    strength: 0.02, speed: 0.0, stamina: 0.05, aggression: 0.0, escape: 0.0, fight: 'weak',
    body: 'junk_boot', colors: { main: '#4a3b30', belly: '#6d5a49', fin: '#2c231c', accent: '#9a8a6b', eye: '#000000' },
    pattern: 'mottled', glow: 0, time: 'any', weather: 'any',
    desc: 'Left foot. Always the left foot. Somewhere out there is an ocean full of right ones.',
    atlasHint: 'Fish badly, anywhere. You will find one eventually. You will find several.',
    dangerous: false, boss: false, edible: false, xp: 1 },

  { id: 'tin-can', name: 'Rusted Tin Can', short: 'Can', tier: 1, habitat: ['shallow', 'harbor', 'wreck'], regions: ['crash', 'rocky', 'harbor', 'station'],
    depth: [0.2, 60], weight: [0.3, 0.55], length: [0.1, 0.15], value: 1, rarity: 'common', spawnWeight: 60,
    strength: 0.01, speed: 0.0, stamina: 0.05, aggression: 0.0, escape: 0.0, fight: 'weak',
    body: 'junk_can', colors: { main: '#8d9096', belly: '#b8bcc2', fin: '#5e6166', accent: '#b06a3a', eye: '#000000' },
    pattern: 'bands', glow: 0, time: 'any', weather: 'any',
    desc: 'The label dissolved decades ago. Whatever was inside has moved on with its life.',
    atlasHint: 'Harbours and wrecks. Comes up sounding disappointed.',
    dangerous: false, boss: false, edible: false, xp: 1 },

  { id: 'seaweed-clump', name: 'Seaweed Clump', short: 'Weed', tier: 1, habitat: ['shallow', 'kelp', 'coast'], regions: ['crash', 'rocky', 'harbor', 'wilds'],
    depth: [0.2, 30], weight: [0.4, 2.6], length: [0.3, 0.9], value: 1, rarity: 'common', spawnWeight: 85,
    strength: 0.03, speed: 0.0, stamina: 0.05, aggression: 0.0, escape: 0.0, fight: 'weak',
    body: 'junk_weed', colors: { main: '#3f6b3a', belly: '#6d9a52', fin: '#2b4c2a', accent: '#9fd07a', eye: '#000000' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'For two glorious seconds you thought it was fighting back. It was just heavy.',
    atlasHint: 'Drag a lure through any kelp bed. Congratulations.',
    dangerous: false, boss: false, edible: false, xp: 1 },

  // === TIER 2 BOSS ==========================================================

  { id: 'dock-eater', name: 'The Dock-Eater', short: 'Dock-Eater', tier: 2, habitat: ['harbor', 'river'], regions: ['harbor', 'crash'],
    depth: [3, 18], weight: [180, 420], length: [3.2, 4.6], value: 130, rarity: 'legendary', spawnWeight: 2,
    strength: 0.78, speed: 0.28, stamina: 0.85, aggression: 0.9, escape: 0.35, fight: 'titan',
    body: 'catfish', colors: { main: '#3a4038', belly: '#8e9a6a', fin: '#22261f', accent: '#a8ff5e', eye: '#d8ff3a' },
    pattern: 'mottled', glow: 0.18, time: 'night', weather: 'any',
    desc: 'Something in the harbour has been eating the mooring lines. It is not a propeller and it is not a rumour.',
    atlasHint: 'Harbour, after midnight, heaviest line you own. Bring a friend and a bat.',
    dangerous: true, boss: true, edible: false, xp: 320,
    bossData: {
      hp: 900,
      phases: [
        { hpPct: 1.0, name: 'Sulking', mechanics: ['ram'] },
        { hpPct: 0.6, name: 'Thrashing', mechanics: ['ram', 'dive'] },
        { hpPct: 0.25, name: 'Under the Dock', mechanics: ['dive', 'shockwave'] },
      ],
      weakPoints: 3, attackInterval: [3, 7],
      reward: { money: 4000, unlocks: ['rod_reinforced', 'harbor_night_license'] },
    } },

  // === TIER 3 — harbour, wilds, the first real coast ========================

  { id: 'salmon', name: 'King Salmon', short: 'Salmon', tier: 3, habitat: ['coast', 'river', 'openocean'], regions: ['rocky', 'harbor', 'wilds', 'frozen'],
    depth: [1, 60], weight: [3, 32], length: [0.6, 1.45], value: 26, rarity: 'common', spawnWeight: 95,
    strength: 0.42, speed: 0.62, stamina: 0.62, aggression: 0.55, escape: 0.4, fight: 'runner',
    body: 'trout', colors: { main: '#5d7f90', belly: '#f4ece2', fin: '#c9576a', accent: '#e8657c', eye: '#121212' },
    pattern: 'spots', glow: 0, time: 'dawn', weather: 'any',
    desc: 'Swims upstream out of sheer stubbornness. You have a lot in common, financially speaking.',
    atlasHint: 'River mouths at dawn and dusk. Troll the tide line.',
    dangerous: false, boss: false, edible: true, xp: 22 },

  { id: 'cod', name: 'Atlantic Cod', short: 'Cod', tier: 3, habitat: ['coast', 'openocean', 'wreck'], regions: ['rocky', 'harbor', 'wilds'],
    depth: [12, 180], weight: [2, 40], length: [0.5, 1.5], value: 22, rarity: 'common', spawnWeight: 105,
    strength: 0.4, speed: 0.24, stamina: 0.45, aggression: 0.6, escape: 0.15, fight: 'diver',
    body: 'trout', colors: { main: '#8a8256', belly: '#efe6cd', fin: '#6b6440', accent: '#c3b678', eye: '#141414' },
    pattern: 'spots', glow: 0, time: 'any', weather: 'any',
    desc: 'Built an entire economy and never got a statue. Comes up looking mildly put out about it.',
    atlasHint: 'Cold bottom over rubble and wrecks. Heavy jigs, straight down.',
    dangerous: false, boss: false, edible: true, xp: 18 },

  { id: 'red-snapper', name: 'Red Snapper', short: 'Snapper', tier: 3, habitat: ['reef', 'wreck', 'coast'], regions: ['harbor', 'wilds'],
    depth: [10, 90], weight: [1.5, 18], length: [0.4, 1.0], value: 34, rarity: 'uncommon', spawnWeight: 80,
    strength: 0.44, speed: 0.4, stamina: 0.4, aggression: 0.65, escape: 0.3, fight: 'diver',
    body: 'bass', colors: { main: '#c8392f', belly: '#f6dcc8', fin: '#e05a3c', accent: '#8f1f1c', eye: '#141414' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'The moment it feels the hook it turns for the reef, because it knows exactly where your line will part.',
    atlasHint: 'Structure, reef and wreck. Lift it fast or lose it.',
    dangerous: false, boss: false, edible: true, xp: 26 },

  { id: 'grouper', name: 'Goliath Grouper', short: 'Grouper', tier: 4, habitat: ['reef', 'wreck'], regions: ['wilds', 'harbor'],
    depth: [8, 70], weight: [15, 320], length: [0.9, 2.5], value: 40, rarity: 'uncommon', spawnWeight: 42,
    strength: 0.72, speed: 0.18, stamina: 0.7, aggression: 0.5, escape: 0.18, fight: 'brawler',
    body: 'bass', colors: { main: '#6d6047', belly: '#ddd0ae', fin: '#4d4433', accent: '#95835c', eye: '#131313' },
    pattern: 'mottled', glow: 0, time: 'any', weather: 'any',
    desc: 'A boulder that learned to hover. Does not run — simply becomes heavier than your resolve.',
    atlasHint: 'Wreck holes and reef caves. Winch, not finesse.',
    dangerous: false, boss: false, edible: true, xp: 48 },

  { id: 'halibut', name: 'Pacific Halibut', short: 'Halibut', tier: 4, habitat: ['coast', 'openocean', 'arctic'], regions: ['wilds', 'frozen', 'rocky'],
    depth: [20, 320], weight: [5, 190], length: [0.7, 2.4], value: 38, rarity: 'uncommon', spawnWeight: 55,
    strength: 0.66, speed: 0.2, stamina: 0.65, aggression: 0.45, escape: 0.22, fight: 'brawler',
    body: 'flatfish', colors: { main: '#5e5b4b', belly: '#f0ece0', fin: '#46443a', accent: '#8f8a70', eye: '#111111' },
    pattern: 'mottled', glow: 0, time: 'any', weather: 'any',
    desc: 'Both eyes migrated to one side, which is a lot of commitment to lying down. Fights like a wet door.',
    atlasHint: 'Flat sand and gravel bottom. Bounce bait on the deck of the seabed.',
    dangerous: false, boss: false, edible: true, xp: 44 },

  { id: 'pufferfish', name: 'Spotted Pufferfish', short: 'Puffer', tier: 3, habitat: ['reef', 'shallow', 'kelp'], regions: ['wilds', 'harbor'],
    depth: [1, 35], weight: [0.4, 3.5], length: [0.16, 0.5], value: 55, rarity: 'uncommon', spawnWeight: 60,
    strength: 0.12, speed: 0.18, stamina: 0.3, aggression: 0.4, escape: 0.35, fight: 'weak',
    body: 'pufferfish', colors: { main: '#c9a13f', belly: '#f5eecf', fin: '#e0c169', accent: '#3b3a34', eye: '#0f0f0f' },
    pattern: 'spots', glow: 0, time: 'any', weather: 'any',
    desc: 'Solves every problem by becoming a ball. Do not eat it unless somebody has certified you, and nobody here has.',
    atlasHint: 'Reef shallows. Comes up inflated and offended.',
    dangerous: true, boss: false, edible: false, xp: 30 },

  { id: 'moray-eel', name: 'Green Moray', short: 'Moray', tier: 3, habitat: ['reef', 'wreck'], regions: ['wilds', 'harbor'],
    depth: [4, 60], weight: [2, 30], length: [0.8, 2.4], value: 42, rarity: 'uncommon', spawnWeight: 52,
    strength: 0.5, speed: 0.3, stamina: 0.55, aggression: 0.85, escape: 0.55, fight: 'thrasher',
    body: 'eel', colors: { main: '#5f7a34', belly: '#c9d18a', fin: '#465c26', accent: '#9fbf4a', eye: '#e8d24a' },
    pattern: 'mottled', glow: 0, time: 'night', weather: 'any',
    desc: 'Two sets of jaws, one bad attitude. Knotted itself around your leader before you noticed the bite.',
    atlasHint: 'Holes in the reef after dark. Wire trace or nothing.',
    dangerous: true, boss: false, edible: true, xp: 34 },

  { id: 'squid', name: 'Humboldt Squid', short: 'Squid', tier: 4, habitat: ['openocean', 'deep'], regions: ['wilds', 'storm', 'station'],
    depth: [30, 500], weight: [4, 55], length: [0.7, 2.0], value: 48, rarity: 'uncommon', spawnWeight: 48,
    strength: 0.46, speed: 0.66, stamina: 0.5, aggression: 0.92, escape: 0.5, fight: 'thrasher',
    body: 'squid', colors: { main: '#b03a54', belly: '#f0d6d0', fin: '#7d2438', accent: '#ff8f6a', eye: '#0a0a0a' },
    pattern: 'gradient', glow: 0.12, time: 'night', weather: 'any',
    desc: 'Hunts in packs and flickers red-white when excited. Everything excites it, including you.',
    atlasHint: 'Deep water at night. Drop a glowing jig and hold on with both hands.',
    dangerous: true, boss: false, edible: true, xp: 52 },

  { id: 'barracuda', name: 'Great Barracuda', short: 'Barracuda', tier: 4, habitat: ['reef', 'coast', 'openocean'], regions: ['wilds', 'harbor'],
    depth: [1, 60], weight: [3, 45], length: [0.7, 1.8], value: 36, rarity: 'uncommon', spawnWeight: 58,
    strength: 0.44, speed: 0.9, stamina: 0.35, aggression: 0.88, escape: 0.45, fight: 'runner',
    body: 'trout', colors: { main: '#8e9aa4', belly: '#f2f4f2', fin: '#4c565e', accent: '#2b3238', eye: '#0f0f0f' },
    pattern: 'bands', glow: 0, time: 'day', weather: 'clear',
    desc: 'A chrome pipe full of teeth. Follows your lure to the boat and stares until you feel judged.',
    atlasHint: 'Fast retrieve over bright reef. Wire leader, unless you enjoy re-tying.',
    dangerous: true, boss: false, edible: true, xp: 38 },

  { id: 'octopus', name: 'Common Octopus', short: 'Octopus', tier: 3, habitat: ['reef', 'wreck', 'coast'], regions: ['rocky', 'harbor', 'wilds'],
    depth: [2, 100], weight: [1, 14], length: [0.3, 1.2], value: 52, rarity: 'uncommon', spawnWeight: 50,
    strength: 0.38, speed: 0.25, stamina: 0.6, aggression: 0.35, escape: 0.7, fight: 'thrasher',
    body: 'octopus', colors: { main: '#9c4f6c', belly: '#e9c3c8', fin: '#6e3049', accent: '#ffb08a', eye: '#0d0d0d' },
    pattern: 'mottled', glow: 0, time: 'night', weather: 'any',
    desc: 'Smarter than the hook and probably smarter than you. Escapes through gaps that should not qualify as gaps.',
    atlasHint: 'Rocks and old bottles at night. Baited pots work better than rods.',
    dangerous: false, boss: false, edible: true, xp: 40 },

  { id: 'stingray', name: 'Southern Stingray', short: 'Stingray', tier: 3, habitat: ['coast', 'shallow', 'reef'], regions: ['harbor', 'wilds'],
    depth: [1, 55], weight: [3, 60], length: [0.5, 1.6], value: 30, rarity: 'uncommon', spawnWeight: 56,
    strength: 0.55, speed: 0.3, stamina: 0.65, aggression: 0.25, escape: 0.2, fight: 'brawler',
    body: 'ray', colors: { main: '#6b6455', belly: '#f4efe2', fin: '#4e4a3e', accent: '#98917a', eye: '#121212' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'Glides off the bottom like a dropped tablecloth, then remembers it owns a barb.',
    atlasHint: 'Sandy flats. Bait on the bottom, hands away from the tail.',
    dangerous: true, boss: false, edible: true, xp: 32 },

  { id: 'tarpon', name: 'Silver Tarpon', short: 'Tarpon', tier: 4, habitat: ['coast', 'harbor', 'shallow'], regions: ['harbor', 'wilds'],
    depth: [1, 30], weight: [12, 130], length: [1.0, 2.4], value: 32, rarity: 'rare', spawnWeight: 34,
    strength: 0.6, speed: 0.7, stamina: 0.72, aggression: 0.55, escape: 0.62, fight: 'jumper',
    body: 'bass', colors: { main: '#bfc7cd', belly: '#fbfaf6', fin: '#8b969e', accent: '#5f6d76', eye: '#101010' },
    pattern: 'gradient', glow: 0, time: 'dusk', weather: 'any',
    desc: 'Armour-plated in loose change. Jumps three metres to spit the hook back at you, personally.',
    atlasHint: 'Harbour channels at dusk. Bow to the jump or lose it.',
    dangerous: false, boss: false, edible: false, xp: 62 },

  { id: 'wahoo', name: 'Wahoo', short: 'Wahoo', tier: 4, habitat: ['openocean', 'coast'], regions: ['wilds', 'storm'],
    depth: [5, 130], weight: [6, 75], length: [0.9, 2.3], value: 44, rarity: 'rare', spawnWeight: 36,
    strength: 0.55, speed: 1.0, stamina: 0.4, aggression: 0.8, escape: 0.35, fight: 'runner',
    body: 'tuna', colors: { main: '#2c5f8c', belly: '#eef4f6', fin: '#1d4468', accent: '#7fc4e8', eye: '#0f0f0f' },
    pattern: 'bands', glow: 0, time: 'day', weather: 'clear',
    desc: 'The first run empties half your spool before the sound of the strike reaches you.',
    atlasHint: 'Troll fast over blue-water drop-offs. Everything must be tied twice.',
    dangerous: false, boss: false, edible: true, xp: 58 },

  // === TIER 3 BOSS ==========================================================

  { id: 'king-crab-boss', name: 'Old Ironshell', short: 'Ironshell', tier: 3, habitat: ['wreck', 'coast', 'harbor'], regions: ['harbor', 'rocky'],
    depth: [15, 90], weight: [90, 260], length: [2.2, 3.4], value: 190, rarity: 'legendary', spawnWeight: 2,
    strength: 0.85, speed: 0.14, stamina: 0.9, aggression: 0.75, escape: 0.12, fight: 'titan',
    body: 'crab', colors: { main: '#8c3b2a', belly: '#d9b184', fin: '#5d2317', accent: '#ffb26b', eye: '#f2e05a' },
    pattern: 'bands', glow: 0.1, time: 'any', weather: 'fog',
    desc: 'Every crab pot in the bay comes up empty and slightly bent. Now you know which direction to point the boat.',
    atlasHint: 'Foggy days over the old wreck field. It will grab the cage, not the bait.',
    dangerous: true, boss: true, edible: true, xp: 460,
    bossData: {
      hp: 1600,
      phases: [
        { hpPct: 1.0, name: 'Dug In', mechanics: ['armor'] },
        { hpPct: 0.65, name: 'Claw Sweep', mechanics: ['ram', 'shockwave'] },
        { hpPct: 0.3, name: 'Brood Call', mechanics: ['summon', 'armor', 'shockwave'] },
      ],
      weakPoints: 3, attackInterval: [4, 8],
      reward: { money: 11000, unlocks: ['crab_pot_mk2', 'harpoon_basic'] },
    } },

  // === TIER 4-5 — open ocean and the storm belt ============================

  { id: 'mahi-mahi', name: 'Mahi-Mahi', short: 'Mahi', tier: 4, habitat: ['openocean'], regions: ['wilds', 'storm'],
    depth: [0.5, 70], weight: [3, 30], length: [0.6, 1.6], value: 42, rarity: 'uncommon', spawnWeight: 62,
    strength: 0.45, speed: 0.82, stamina: 0.5, aggression: 0.85, escape: 0.55, fight: 'jumper',
    body: 'tuna', colors: { main: '#2fa8c8', belly: '#ffe36b', fin: '#1c7f9c', accent: '#7ee06a', eye: '#0f0f0f' },
    pattern: 'spots', glow: 0, time: 'day', weather: 'clear',
    desc: 'Electric blue and gold right up until it is not. Loses the colour on deck, which never stops feeling rude.',
    atlasHint: 'Under floating weed and debris in open water. Anything that moves.',
    dangerous: false, boss: false, edible: true, xp: 46 },

  { id: 'yellowfin-tuna', name: 'Yellowfin Tuna', short: 'Yellowfin', tier: 4, habitat: ['openocean'], regions: ['wilds', 'storm'],
    depth: [3, 240], weight: [15, 130], length: [0.9, 2.1], value: 45, rarity: 'uncommon', spawnWeight: 45,
    strength: 0.68, speed: 0.85, stamina: 0.8, aggression: 0.7, escape: 0.3, fight: 'diver',
    body: 'tuna', colors: { main: '#20517f', belly: '#f0f2ee', fin: '#f2c53a', accent: '#ffd96b', eye: '#0e0e0e' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'Swims down instead of away, which is worse. The fight is you versus gravity, and gravity brought friends.',
    atlasHint: 'Open blue water. Live bait, big reel, comfortable shoes.',
    dangerous: false, boss: false, edible: true, xp: 70 },

  { id: 'bluefin-tuna', name: 'Bluefin Tuna', short: 'Bluefin', tier: 5, habitat: ['openocean', 'deep'], regions: ['storm', 'wilds', 'frozen'],
    depth: [5, 400], weight: [30, 250], length: [1.2, 3.0], value: 78, rarity: 'rare', spawnWeight: 26,
    strength: 0.85, speed: 0.88, stamina: 0.92, aggression: 0.62, escape: 0.28, fight: 'diver',
    body: 'tuna', colors: { main: '#1b3f6e', belly: '#f4f5f0', fin: '#c8cf3a', accent: '#4a7fb8', eye: '#0d0d0d' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'A warm-blooded torpedo worth more than your boat. Try not to think about that while your arms give out.',
    atlasHint: 'Cold open ocean, big schools of bait. Two hours of fight, minimum.',
    dangerous: false, boss: false, edible: true, xp: 130 },

  { id: 'blue-marlin', name: 'Blue Marlin', short: 'Marlin', tier: 5, habitat: ['openocean'], regions: ['storm', 'wilds'],
    depth: [2, 250], weight: [80, 450], length: [2.2, 4.3], value: 90, rarity: 'rare', spawnWeight: 18,
    strength: 0.92, speed: 0.9, stamina: 0.95, aggression: 0.6, escape: 0.5, fight: 'jumper',
    body: 'marlin', colors: { main: '#1d4a80', belly: '#eef2f4', fin: '#12325c', accent: '#4fd2e8', eye: '#0c0c0c' },
    pattern: 'stripes', glow: 0, time: 'day', weather: 'clear',
    desc: 'Lights up in neon stripes when it is hunting. If you can see the stripes, it has already decided.',
    atlasHint: 'Troll big skirted lures across open blue. Clear the deck first.',
    dangerous: true, boss: false, edible: true, xp: 210 },

  { id: 'swordfish', name: 'Swordfish', short: 'Swordfish', tier: 5, habitat: ['openocean', 'deep'], regions: ['storm', 'station'],
    depth: [50, 700], weight: [50, 400], length: [1.8, 4.0], value: 84, rarity: 'rare', spawnWeight: 20,
    strength: 0.88, speed: 0.78, stamina: 0.9, aggression: 0.5, escape: 0.42, fight: 'diver',
    body: 'marlin', colors: { main: '#3a4a5c', belly: '#e8ecec', fin: '#232f3c', accent: '#8fa6bc', eye: '#0b0b0b' },
    pattern: 'gradient', glow: 0, time: 'night', weather: 'any',
    desc: 'Hunts a kilometre down in the cold and comes up furious about the temperature change. Also it has a sword.',
    atlasHint: 'Deep drop at night with a lit bait. Long, dark, expensive hours.',
    dangerous: true, boss: false, edible: true, xp: 200 },

  { id: 'sailfish', name: 'Sailfish', short: 'Sailfish', tier: 5, habitat: ['openocean', 'coast'], regions: ['storm', 'wilds'],
    depth: [1, 120], weight: [25, 90], length: [1.8, 3.2], value: 72, rarity: 'rare', spawnWeight: 24,
    strength: 0.66, speed: 1.0, stamina: 0.7, aggression: 0.72, escape: 0.6, fight: 'jumper',
    body: 'marlin', colors: { main: '#2b5f9e', belly: '#f2f4f0', fin: '#6a3fb0', accent: '#8f6ae0', eye: '#0d0d0d' },
    pattern: 'spots', glow: 0, time: 'day', weather: 'clear',
    desc: 'Unfolds a sail twice its own height to herd bait, then uses the same sail to look enormous in photographs.',
    atlasHint: 'Fast troll on the surface, calm bright days. Drop back on the strike.',
    dangerous: false, boss: false, edible: false, xp: 150 },

  { id: 'reef-shark', name: 'Blacktip Reef Shark', short: 'Reef Shark', tier: 4, habitat: ['reef', 'coast'], regions: ['wilds', 'harbor'],
    depth: [1, 60], weight: [10, 65], length: [1.0, 2.0], value: 40, rarity: 'uncommon', spawnWeight: 44,
    strength: 0.58, speed: 0.65, stamina: 0.6, aggression: 0.7, escape: 0.35, fight: 'runner',
    body: 'shark', colors: { main: '#6e7d88', belly: '#f0efe6', fin: '#2b3238', accent: '#1c2226', eye: '#0a0a0a' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'Turns up the second you hook anything else. Considers your catch to be a delivery service.',
    atlasHint: 'Reef edges. It will find you; you rarely have to find it.',
    dangerous: true, boss: false, edible: true, xp: 55 },

  { id: 'hammerhead', name: 'Scalloped Hammerhead', short: 'Hammerhead', tier: 5, habitat: ['openocean', 'coast', 'reef'], regions: ['wilds', 'storm'],
    depth: [5, 280], weight: [40, 200], length: [1.8, 3.6], value: 60, rarity: 'rare', spawnWeight: 22,
    strength: 0.75, speed: 0.6, stamina: 0.78, aggression: 0.6, escape: 0.3, fight: 'brawler',
    body: 'shark', colors: { main: '#7d8892', belly: '#efeee4', fin: '#3d464e', accent: '#252b31', eye: '#0a0a0a' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'The head is a sensor array with a shark bolted behind it. Circles the boat exactly once before deciding.',
    atlasHint: 'Deep drop-offs and current lines. Heavy tackle, wire trace.',
    dangerous: true, boss: false, edible: true, xp: 120 },

  { id: 'mako-shark', name: 'Shortfin Mako', short: 'Mako', tier: 5, habitat: ['openocean'], regions: ['storm', 'wilds'],
    depth: [3, 350], weight: [50, 320], length: [1.8, 3.8], value: 68, rarity: 'rare', spawnWeight: 19,
    strength: 0.86, speed: 0.98, stamina: 0.75, aggression: 0.9, escape: 0.55, fight: 'jumper',
    body: 'shark', colors: { main: '#2c5c9c', belly: '#f4f4ee', fin: '#1a3b66', accent: '#6fb4e8', eye: '#0a0a0a' },
    pattern: 'gradient', glow: 0, time: 'day', weather: 'any',
    desc: 'The fastest shark there is, and it likes to arrive in the boat with you. Some captains fish for it anyway.',
    atlasHint: 'Open ocean chum slick. Have a plan for when it jumps toward you.',
    dangerous: true, boss: false, edible: true, xp: 175 },

  { id: 'sunfish', name: 'Ocean Sunfish', short: 'Mola', tier: 5, habitat: ['openocean'], regions: ['storm', 'wilds', 'frozen'],
    depth: [1, 300], weight: [80, 900], length: [1.2, 3.0], value: 30, rarity: 'rare', spawnWeight: 16,
    strength: 0.6, speed: 0.1, stamina: 0.5, aggression: 0.1, escape: 0.08, fight: 'brawler',
    body: 'sunfish', colors: { main: '#8b939a', belly: '#e2e4e0', fin: '#6b7278', accent: '#c0c6c8', eye: '#111111' },
    pattern: 'mottled', glow: 0, time: 'day', weather: 'clear',
    desc: 'A head that gave up on having a body. Basks at the surface looking like a dropped manhole cover.',
    atlasHint: 'Flat calm days, sunning at the surface. Please release it, it means no harm.',
    dangerous: false, boss: false, edible: false, xp: 100 },

  { id: 'manta-ray', name: 'Giant Manta Ray', short: 'Manta', tier: 5, habitat: ['openocean', 'reef'], regions: ['wilds', 'storm'],
    depth: [2, 200], weight: [120, 1400], length: [2.5, 6.0], value: 46, rarity: 'rare', spawnWeight: 14,
    strength: 0.8, speed: 0.45, stamina: 0.85, aggression: 0.08, escape: 0.15, fight: 'titan',
    body: 'ray', colors: { main: '#2a3038', belly: '#f3f2ea', fin: '#1a1f25', accent: '#5d6a76', eye: '#0b0b0b' },
    pattern: 'spots', glow: 0, time: 'day', weather: 'any',
    desc: 'Six metres of black kite doing barrel rolls through a bait cloud. Hooking one feels like a mistake, because it is.',
    atlasHint: 'Plankton lines in open water. Foul-hooked only — cut it loose.',
    dangerous: false, boss: false, edible: false, xp: 140 },

  // === TIER 4 BOSS ==========================================================

  { id: 'the-hammer', name: 'The Hammer', short: 'The Hammer', tier: 4, habitat: ['openocean', 'coast'], regions: ['wilds', 'storm'],
    depth: [10, 200], weight: [700, 1600], length: [5.5, 7.5], value: 260, rarity: 'legendary', spawnWeight: 2,
    strength: 0.94, speed: 0.72, stamina: 0.95, aggression: 0.95, escape: 0.4, fight: 'titan',
    body: 'shark', colors: { main: '#4e5a64', belly: '#e6e6dc', fin: '#232a30', accent: '#ff5e4a', eye: '#ffd23a' },
    pattern: 'bands', glow: 0.12, time: 'any', weather: 'any',
    desc: 'Three boats have come back with matching semicircles bitten out of the transom. The bite radius is not a rumour.',
    atlasHint: 'Deep current line off the wilds. Chum, wait, and secure everything on deck.',
    dangerous: true, boss: true, edible: true, xp: 900,
    bossData: {
      hp: 3200,
      phases: [
        { hpPct: 1.0, name: 'Circling', mechanics: ['ram'] },
        { hpPct: 0.7, name: 'Sounding', mechanics: ['dive', 'ram'] },
        { hpPct: 0.35, name: 'Frenzy', mechanics: ['ram', 'summon', 'shockwave'] },
      ],
      weakPoints: 3, attackInterval: [3, 6],
      reward: { money: 34000, unlocks: ['reel_gold', 'shark_cage', 'harpoon_mk2'] },
    } },

  // === TIER 5 BOSS ==========================================================

  { id: 'stormfin', name: 'Stormfin', short: 'Stormfin', tier: 5, habitat: ['openocean'], regions: ['storm'],
    depth: [1, 160], weight: [900, 2400], length: [5.0, 8.0], value: 420, rarity: 'mythic', spawnWeight: 1,
    strength: 0.96, speed: 0.95, stamina: 0.96, aggression: 0.85, escape: 0.6, fight: 'titan',
    body: 'marlin', colors: { main: '#26407a', belly: '#dfe8f2', fin: '#7a4ff0', accent: '#7ee8ff', eye: '#ffe14a' },
    pattern: 'stripes', glow: 0.5, time: 'any', weather: 'storm',
    desc: 'Only surfaces when the barometer collapses, and the lightning seems to prefer its dorsal to your mast.',
    atlasHint: 'Sail INTO the storm cell. Everything about that sentence is a bad idea.',
    dangerous: true, boss: true, edible: false, xp: 1600,
    bossData: {
      hp: 6400,
      phases: [
        { hpPct: 1.0, name: 'Gathering', mechanics: ['ram', 'dive'] },
        { hpPct: 0.66, name: 'Squall', mechanics: ['shockwave', 'dive'] },
        { hpPct: 0.33, name: 'Eyewall', mechanics: ['shockwave', 'summon', 'ram', 'armor'] },
      ],
      weakPoints: 3, attackInterval: [3, 7],
      reward: { money: 95000, unlocks: ['rod_stormglass', 'boat_hull_reinforced', 'weather_radar'] },
    } },

  // === TIER 5-6 — the frozen shelf =========================================

  { id: 'arctic-cod', name: 'Polar Cod', short: 'Arctic Cod', tier: 5, habitat: ['arctic', 'coast'], regions: ['frozen'],
    depth: [5, 300], weight: [0.3, 3.0], length: [0.2, 0.5], value: 34, rarity: 'common', spawnWeight: 90,
    strength: 0.2, speed: 0.35, stamina: 0.35, aggression: 0.55, escape: 0.16, fight: 'runner',
    body: 'trout', colors: { main: '#7d8f9c', belly: '#f2f6f6', fin: '#5b6d7a', accent: '#b8d6e2', eye: '#131313' },
    pattern: 'spots', glow: 0, time: 'any', weather: 'any',
    desc: 'Lives in water that would stop your heart and appears entirely relaxed about it.',
    atlasHint: 'Under the ice shelf. Small bait, cold hands.',
    dangerous: false, boss: false, edible: true, xp: 28 },

  { id: 'greenland-halibut', name: 'Greenland Halibut', short: 'G. Halibut', tier: 6, habitat: ['arctic', 'deep'], regions: ['frozen'],
    depth: [200, 1400], weight: [4, 60], length: [0.6, 1.3], value: 96, rarity: 'uncommon', spawnWeight: 46,
    strength: 0.6, speed: 0.28, stamina: 0.62, aggression: 0.5, escape: 0.22, fight: 'diver',
    body: 'flatfish', colors: { main: '#4a4f55', belly: '#cfd6d6', fin: '#33383d', accent: '#7f8a92', eye: '#101010' },
    pattern: 'gradient', glow: 0, time: 'any', weather: 'any',
    desc: 'A halibut that never quite committed to lying flat. Ambiguity is its whole personality.',
    atlasHint: 'Very deep and very cold. Long drop, longer wind-up.',
    dangerous: false, boss: false, edible: true, xp: 90 },

  { id: 'icefish', name: 'Crocodile Icefish', short: 'Icefish', tier: 6, habitat: ['arctic', 'deep'], regions: ['frozen'],
    depth: [80, 900], weight: [0.3, 4.0], length: [0.25, 0.7], value: 150, rarity: 'rare', spawnWeight: 30,
    strength: 0.2, speed: 0.3, stamina: 0.3, aggression: 0.45, escape: 0.25, fight: 'runner',
    body: 'sardine', colors: { main: '#c8dbe6', belly: '#f7fbfd', fin: '#a2c4d6', accent: '#e6f4ff', eye: '#1a1a1a' },
    pattern: 'gradient', glow: 0.08, time: 'any', weather: 'any',
    desc: 'Colourless blood and translucent skin. You can watch it decide it does not like you.',
    atlasHint: 'The coldest deep water on the shelf. Slow jigs, no hurry.',
    dangerous: false, boss: false, edible: true, xp: 110 },

  { id: 'narwhal-eel', name: 'Narwhal Eel', short: 'Narwhal Eel', tier: 6, habitat: ['arctic', 'deep'], regions: ['frozen'],
    depth: [120, 1100], weight: [8, 95], length: [1.6, 4.2], value: 190, rarity: 'epic', spawnWeight: 12,
    strength: 0.68, speed: 0.55, stamina: 0.7, aggression: 0.7, escape: 0.6, fight: 'thrasher',
    body: 'eel', colors: { main: '#4d6b86', belly: '#dfeaf0', fin: '#33506b', accent: '#c8e8ff', eye: '#8fd6ff' },
    pattern: 'mottled', glow: 0.22, time: 'night', weather: 'any',
    desc: 'A spiral tusk on an eel, which nobody asked for and everybody now has to deal with. Uses it to break ice, and rods.',
    atlasHint: 'Under thick ice, after dark. Steel leader and a firm grip.',
    dangerous: true, boss: false, edible: true, xp: 240 },

  { id: 'king-crab', name: 'Red King Crab', short: 'King Crab', tier: 5, habitat: ['arctic', 'coast', 'deep'], regions: ['frozen'],
    depth: [20, 400], weight: [2, 12], length: [0.3, 1.8], value: 120, rarity: 'uncommon', spawnWeight: 48,
    strength: 0.4, speed: 0.1, stamina: 0.65, aggression: 0.5, escape: 0.2, fight: 'brawler',
    body: 'crab', colors: { main: '#b3402c', belly: '#e8c2a0', fin: '#7c2718', accent: '#ff9d6a', eye: '#111111' },
    pattern: 'bands', glow: 0, time: 'any', weather: 'any',
    desc: 'Two metres across the legs, one solid handful of actual crab. The economics are stupid and it does not care.',
    atlasHint: 'Pots on the cold shelf bottom. Come back in the morning.',
    dangerous: false, boss: false, edible: true, xp: 85 },

  { id: 'wolffish', name: 'Atlantic Wolffish', short: 'Wolffish', tier: 6, habitat: ['arctic', 'coast', 'wreck'], regions: ['frozen', 'rocky'],
    depth: [30, 600], weight: [3, 24], length: [0.6, 1.5], value: 110, rarity: 'uncommon', spawnWeight: 40,
    strength: 0.58, speed: 0.22, stamina: 0.6, aggression: 0.8, escape: 0.3, fight: 'brawler',
    body: 'catfish', colors: { main: '#586570', belly: '#c9cfcc', fin: '#3c464e', accent: '#8e9aa0', eye: '#0f0f0f' },
    pattern: 'bands', glow: 0, time: 'any', weather: 'any',
    desc: 'Face like a punched fist and teeth built for cracking shellfish. Will demonstrate on your pliers.',
    atlasHint: 'Cold rocky bottom. Keep every finger accounted for on release.',
    dangerous: true, boss: false, edible: true, xp: 95 },

  // === TIER 6 BOSS ==========================================================

  { id: 'frostjaw', name: 'Frostjaw', short: 'Frostjaw', tier: 6, habitat: ['arctic', 'deep'], regions: ['frozen'],
    depth: [60, 900], weight: [2200, 6000], length: [8.0, 13.0], value: 640, rarity: 'mythic', spawnWeight: 1,
    strength: 0.97, speed: 0.6, stamina: 0.97, aggression: 0.9, escape: 0.35, fight: 'titan',
    body: 'leviathan', colors: { main: '#5f7f9c', belly: '#e6f2f8', fin: '#3b5a76', accent: '#a8e8ff', eye: '#e8f8ff' },
    pattern: 'bands', glow: 0.32, time: 'any', weather: 'fog',
    desc: 'The ice above the trench keeps splitting from underneath in a shape that is uncomfortably like a smile.',
    atlasHint: 'Break through the shelf over the deep trench. Bring the heated line and a hull you do not love.',
    dangerous: true, boss: true, edible: false, xp: 2800,
    bossData: {
      hp: 11000,
      phases: [
        { hpPct: 1.0, name: 'Beneath the Ice', mechanics: ['dive', 'armor'] },
        { hpPct: 0.7, name: 'Breach', mechanics: ['ram', 'shockwave'] },
        { hpPct: 0.4, name: 'Whiteout', mechanics: ['summon', 'shockwave', 'dive'] },
        { hpPct: 0.15, name: 'Frostjaw Unbound', mechanics: ['ram', 'shockwave', 'armor', 'summon'] },
      ],
      weakPoints: 3, attackInterval: [3, 6],
      reward: { money: 260000, unlocks: ['rod_frostbite', 'sub_hull_ice', 'frozen_depths_chart'] },
    } },

  // === TIER 6-7 — the deep and the station =================================

  { id: 'lanternfish', name: 'Lanternfish', short: 'Lanternfish', tier: 6, habitat: ['deep', 'openocean'], regions: ['station', 'storm', 'abyss'],
    depth: [200, 1200], weight: [0.01, 0.15], length: [0.03, 0.14], value: 200, rarity: 'common', spawnWeight: 130,
    strength: 0.04, speed: 0.4, stamina: 0.12, aggression: 0.6, escape: 0.2, fight: 'weak',
    body: 'sardine', colors: { main: '#2a3a4e', belly: '#4fd8e8', fin: '#1c2836', accent: '#7ef0ff', eye: '#dff8ff' },
    pattern: 'glow', glow: 0.75, time: 'night', weather: 'any',
    desc: 'Studded with tiny lights in a pattern only other lanternfish can read. It is probably not flattering.',
    atlasHint: 'The deep scattering layer at night. Fine mesh or a very small hook.',
    dangerous: false, boss: false, edible: true, xp: 60 },

  { id: 'anglerfish', name: 'Humpback Anglerfish', short: 'Anglerfish', tier: 6, habitat: ['deep', 'abyss'], regions: ['station', 'abyss'],
    depth: [500, 2500], weight: [0.4, 12], length: [0.15, 0.7], value: 280, rarity: 'rare', spawnWeight: 42,
    strength: 0.3, speed: 0.12, stamina: 0.35, aggression: 0.95, escape: 0.3, fight: 'thrasher',
    body: 'anglerfish', colors: { main: '#2e2438', belly: '#4a3a54', fin: '#1b1522', accent: '#8affd8', eye: '#f0ffe8' },
    pattern: 'glow', glow: 0.6, time: 'any', weather: 'any',
    desc: 'Fishes for a living, same as you, and has been at it considerably longer. Professional courtesy is not extended.',
    atlasHint: 'Deep dark water. It will come to your light rather than the other way round.',
    dangerous: true, boss: false, edible: true, xp: 180 },

  { id: 'viperfish', name: 'Sloane Viperfish', short: 'Viperfish', tier: 6, habitat: ['deep'], regions: ['station', 'abyss'],
    depth: [300, 2000], weight: [0.05, 0.9], length: [0.15, 0.42], value: 240, rarity: 'uncommon', spawnWeight: 55,
    strength: 0.14, speed: 0.5, stamina: 0.25, aggression: 0.95, escape: 0.45, fight: 'thrasher',
    body: 'anglerfish', colors: { main: '#1e2a3a', belly: '#33465e', fin: '#141c28', accent: '#6affc8', eye: '#e8fff4' },
    pattern: 'glow', glow: 0.55, time: 'any', weather: 'any',
    desc: 'Teeth too long to fit inside its own mouth, so it simply does not close it. Commitment to a look.',
    atlasHint: 'Mid-deep, on the light line. Small lure, big surprise.',
    dangerous: true, boss: false, edible: false, xp: 130 },

  { id: 'giant-isopod', name: 'Giant Isopod', short: 'Isopod', tier: 6, habitat: ['deep', 'trench'], regions: ['station', 'abyss'],
    depth: [400, 2600], weight: [0.4, 3.5], length: [0.2, 0.55], value: 260, rarity: 'uncommon', spawnWeight: 60,
    strength: 0.22, speed: 0.06, stamina: 0.5, aggression: 0.3, escape: 0.15, fight: 'weak',
    body: 'isopod', colors: { main: '#b9a582', belly: '#e2d3b4', fin: '#8c7a5c', accent: '#6a5c44', eye: '#0d0d0d' },
    pattern: 'bands', glow: 0, time: 'any', weather: 'any',
    desc: 'A woodlouse the size of a cat that eats once a decade. Rolls into a ball at the surface out of embarrassment.',
    atlasHint: 'Baited trap on the deep mud. It arrives slowly and eats everything.',
    dangerous: false, boss: false, edible: false, xp: 120 },

  { id: 'dumbo-octopus', name: 'Dumbo Octopus', short: 'Dumbo', tier: 7, habitat: ['deep', 'trench', 'abyss'], regions: ['station', 'abyss'],
    depth: [1000, 4500], weight: [0.1, 6], length: [0.15, 0.9], value: 360, rarity: 'rare', spawnWeight: 30,
    strength: 0.16, speed: 0.16, stamina: 0.3, aggression: 0.1, escape: 0.4, fight: 'weak',
    body: 'octopus', colors: { main: '#c47a9a', belly: '#f0d0dc', fin: '#95506e', accent: '#ffd0e2', eye: '#0c0c0c' },
    pattern: 'gradient', glow: 0.14, time: 'any', weather: 'any',
    desc: 'Flaps two little ear-fins through four kilometres of freezing black. Nobody has ever had the heart to keep one.',
    atlasHint: 'Very deep, very slow. Soft net, gentle hands, quick release.',
    dangerous: false, boss: false, edible: false, xp: 190 },

  { id: 'vampire-squid', name: 'Vampire Squid', short: 'V. Squid', tier: 7, habitat: ['deep', 'trench'], regions: ['station', 'abyss'],
    depth: [600, 3000], weight: [0.2, 2.5], length: [0.2, 0.6], value: 400, rarity: 'rare', spawnWeight: 28,
    strength: 0.18, speed: 0.28, stamina: 0.35, aggression: 0.15, escape: 0.65, fight: 'runner',
    body: 'squid', colors: { main: '#5a1e33', belly: '#8f3a52', fin: '#380f20', accent: '#5fe8ff', eye: '#a8e0ff' },
    pattern: 'glow', glow: 0.5, time: 'any', weather: 'any',
    desc: 'Turns itself inside out to look spiky, then releases glowing mucus and leaves. An excellent exit strategy.',
    atlasHint: 'The oxygen minimum layer. It only appears in your lights for a second.',
    dangerous: false, boss: false, edible: false, xp: 210 },

  { id: 'goblin-shark', name: 'Goblin Shark', short: 'Goblin', tier: 7, habitat: ['deep', 'trench'], regions: ['station', 'abyss'],
    depth: [300, 1500], weight: [40, 210], length: [2.0, 4.2], value: 340, rarity: 'epic', spawnWeight: 14,
    strength: 0.7, speed: 0.35, stamina: 0.6, aggression: 0.85, escape: 0.4, fight: 'brawler',
    body: 'shark', colors: { main: '#d09fa8', belly: '#f0dfe0', fin: '#9a6a76', accent: '#5f3a48', eye: '#0a0a0a' },
    pattern: 'gradient', glow: 0.05, time: 'any', weather: 'any',
    desc: 'The jaw launches forward out of the face and then goes back in. You will hear about it later, in dreams.',
    atlasHint: 'Deep continental slope. Steel trace and a very steady nerve.',
    dangerous: true, boss: false, edible: false, xp: 420 },

  { id: 'frilled-shark', name: 'Frilled Shark', short: 'Frilled', tier: 7, habitat: ['deep', 'trench'], regions: ['station', 'abyss'],
    depth: [400, 1800], weight: [8, 90], length: [1.2, 2.6], value: 380, rarity: 'epic', spawnWeight: 13,
    strength: 0.55, speed: 0.42, stamina: 0.65, aggression: 0.8, escape: 0.6, fight: 'thrasher',
    body: 'shark', colors: { main: '#6b5f52', belly: '#ab9c88', fin: '#463d34', accent: '#d8c6a4', eye: '#0b0b0b' },
    pattern: 'bands', glow: 0.05, time: 'any', weather: 'any',
    desc: 'Three hundred backward-pointing teeth in twenty-five rows. Strikes like an eel because being a shark was not enough.',
    atlasHint: 'Deep slope water. Once it is on, it does not come off — including your leader.',
    dangerous: true, boss: false, edible: false, xp: 400 },

  { id: 'oarfish', name: 'Giant Oarfish', short: 'Oarfish', tier: 7, habitat: ['deep', 'openocean'], regions: ['station', 'storm', 'abyss'],
    depth: [200, 1000], weight: [40, 270], length: [3.0, 9.0], value: 420, rarity: 'epic', spawnWeight: 10,
    strength: 0.48, speed: 0.3, stamina: 0.55, aggression: 0.2, escape: 0.5, fight: 'runner',
    body: 'oarfish', colors: { main: '#c2c8cf', belly: '#f2f4f6', fin: '#e0453f', accent: '#ff6a5e', eye: '#0e0e0e' },
    pattern: 'spots', glow: 0.1, time: 'night', weather: 'storm',
    desc: 'Nine metres of silver ribbon with a red mohawk, swimming vertically. Sailors call it a bad omen; sailors call everything a bad omen.',
    atlasHint: 'Deep water before heavy weather. Handle it like wet paper.',
    dangerous: false, boss: false, edible: false, xp: 380 },

  { id: 'giant-squid', name: 'Giant Squid', short: 'G. Squid', tier: 7, habitat: ['deep', 'trench'], regions: ['station', 'abyss', 'storm'],
    depth: [300, 2000], weight: [100, 900], length: [4.0, 13.0], value: 460, rarity: 'epic', spawnWeight: 8,
    strength: 0.88, speed: 0.55, stamina: 0.8, aggression: 0.75, escape: 0.68, fight: 'thrasher',
    body: 'squid', colors: { main: '#a4384c', belly: '#e8c8c0', fin: '#6e1f30', accent: '#ffb08a', eye: '#e8e0d0' },
    pattern: 'mottled', glow: 0.1, time: 'night', weather: 'any',
    desc: 'Eyes the size of dinner plates, which is exactly the wrong size for eyes. The suckers leave rings in the paint.',
    atlasHint: 'Very deep, very dark, very large bait. Do not lean over the gunwale.',
    dangerous: true, boss: false, edible: true, xp: 620 },

  { id: 'blobfish', name: 'Blobfish', short: 'Blobfish', tier: 6, habitat: ['deep', 'trench'], regions: ['station', 'abyss'],
    depth: [600, 1800], weight: [1, 9], length: [0.25, 0.7], value: 220, rarity: 'uncommon', spawnWeight: 50,
    strength: 0.1, speed: 0.05, stamina: 0.2, aggression: 0.2, escape: 0.05, fight: 'weak',
    body: 'sunfish', colors: { main: '#d4a2a0', belly: '#efd6cf', fin: '#a97a7c', accent: '#8f5f66', eye: '#1a1a1a' },
    pattern: 'mottled', glow: 0, time: 'any', weather: 'any',
    desc: 'Perfectly reasonable-looking at a hundred atmospheres. Everything wrong with it is your fault for lifting it.',
    atlasHint: 'Deep mud. It does not fight, it simply arrives, sadder.',
    dangerous: false, boss: false, edible: false, xp: 100 },

  // === TIER 7-8 — the abyss. None of this is in any textbook. ==============

  { id: 'ghostfin', name: 'Ghostfin', short: 'Ghostfin', tier: 7, habitat: ['abyss', 'trench'], regions: ['abyss'],
    depth: [1500, 5000], weight: [6, 70], length: [1.2, 3.4], value: 800, rarity: 'rare', spawnWeight: 34,
    strength: 0.4, speed: 0.6, stamina: 0.5, aggression: 0.3, escape: 0.8, fight: 'runner',
    body: 'oarfish', colors: { main: '#b8e4f0', belly: '#eafaff', fin: '#7fc8e0', accent: '#ffffff', eye: '#cfefff' },
    pattern: 'glow', glow: 0.65, time: 'any', weather: 'any',
    desc: 'Sonar registers it. Cameras mostly do not. The crew has stopped arguing about which one is broken.',
    atlasHint: 'Abyssal plain, lights off. Feel for the line going slack in the wrong direction.',
    dangerous: false, boss: false, edible: false, xp: 520 },

  { id: 'glass-nautilus', name: 'Glass Nautilus', short: 'Nautilus', tier: 7, habitat: ['abyss', 'trench', 'vent'], regions: ['abyss'],
    depth: [1200, 4200], weight: [1.5, 22], length: [0.3, 1.1], value: 950, rarity: 'epic', spawnWeight: 24,
    strength: 0.24, speed: 0.2, stamina: 0.45, aggression: 0.15, escape: 0.35, fight: 'weak',
    body: 'nautilus', colors: { main: '#cfe8f2', belly: '#f6fdff', fin: '#8fc0d4', accent: '#6ae0ff', eye: '#0d0d0d' },
    pattern: 'bands', glow: 0.4, time: 'any', weather: 'any',
    desc: 'The shell is transparent and the chambers are lit from inside. Whatever is doing the lighting is not the nautilus.',
    atlasHint: 'Near vent chimneys on the abyssal slope. Do not crack the shell.',
    dangerous: false, boss: false, edible: false, xp: 640 },

  { id: 'gravebloom-jelly', name: 'Gravebloom Jelly', short: 'Gravebloom', tier: 7, habitat: ['abyss', 'trench'], regions: ['abyss'],
    depth: [900, 6000], weight: [2, 40], length: [0.5, 2.6], value: 880, rarity: 'rare', spawnWeight: 30,
    strength: 0.3, speed: 0.08, stamina: 0.7, aggression: 0.4, escape: 0.25, fight: 'weak',
    body: 'jellyfish', colors: { main: '#8f5ad0', belly: '#d8c0f4', fin: '#5f2f9c', accent: '#ff6ad0', eye: '#f0d8ff' },
    pattern: 'glow', glow: 0.8, time: 'any', weather: 'any',
    desc: 'Blooms in fields over the trench floor and pulses in slow unison. The stinging cells go through neoprene.',
    atlasHint: 'Drift through a bloom with the sub lights dimmed. Thick gloves.',
    dangerous: true, boss: false, edible: false, xp: 560 },

  { id: 'hadal-worm', name: 'Hadal Worm', short: 'Hadal Worm', tier: 7, habitat: ['trench', 'vent', 'abyss'], regions: ['abyss'],
    depth: [3000, 9000], weight: [1, 30], length: [0.6, 4.0], value: 1000, rarity: 'uncommon', spawnWeight: 40,
    strength: 0.34, speed: 0.14, stamina: 0.8, aggression: 0.55, escape: 0.3, fight: 'thrasher',
    body: 'worm', colors: { main: '#d84a5a', belly: '#f2a09a', fin: '#8f2434', accent: '#ffd8c0', eye: '#000000' },
    pattern: 'bands', glow: 0.28, time: 'any', weather: 'any',
    desc: 'Lives on chemistry rather than sunlight and is faintly warm to the touch. Comes up in a knot and stays that way.',
    atlasHint: 'Hydrothermal vent fields at the bottom of everything.',
    dangerous: true, boss: false, edible: false, xp: 480 },

  { id: 'crystal-ray', name: 'Crystal Ray', short: 'Crystal Ray', tier: 8, habitat: ['abyss', 'trench'], regions: ['abyss'],
    depth: [2000, 7000], weight: [60, 700], length: [2.0, 6.5], value: 1400, rarity: 'epic', spawnWeight: 16,
    strength: 0.72, speed: 0.5, stamina: 0.8, aggression: 0.25, escape: 0.4, fight: 'titan',
    body: 'ray', colors: { main: '#8fd8f0', belly: '#f4feff', fin: '#4fa8d4', accent: '#c8f4ff', eye: '#eaffff' },
    pattern: 'glow', glow: 0.55, time: 'any', weather: 'any',
    desc: 'Mineral plates grown along the wings that ring like struck glass when it turns. Wonderful. Also very sharp.',
    atlasHint: 'High over the trench, gliding. Net it, never gaff it.',
    dangerous: true, boss: false, edible: false, xp: 900 },

  { id: 'thunder-eel', name: 'Thunder Eel', short: 'Thunder Eel', tier: 8, habitat: ['abyss', 'vent', 'trench'], regions: ['abyss', 'storm'],
    depth: [1500, 6500], weight: [30, 340], length: [2.5, 7.0], value: 1700, rarity: 'epic', spawnWeight: 13,
    strength: 0.8, speed: 0.72, stamina: 0.78, aggression: 0.9, escape: 0.7, fight: 'thrasher',
    body: 'eel', colors: { main: '#2a3f7a', belly: '#7fa8e8', fin: '#16234a', accent: '#ffe14a', eye: '#fff8c0' },
    pattern: 'glow', glow: 0.7, time: 'any', weather: 'storm',
    desc: 'The charge arcs down the wire, through the rod, and into the story you tell afterwards. Rubber grips are not optional.',
    atlasHint: 'Vent fields, and near the surface in bad storms. Insulate everything.',
    dangerous: true, boss: false, edible: false, xp: 1050 },

  { id: 'void-shark', name: 'Void Shark', short: 'Void Shark', tier: 8, habitat: ['abyss', 'trench'], regions: ['abyss'],
    depth: [2500, 9000], weight: [400, 2600], length: [4.5, 9.5], value: 2100, rarity: 'legendary', spawnWeight: 7,
    strength: 0.93, speed: 0.8, stamina: 0.9, aggression: 0.95, escape: 0.55, fight: 'titan',
    body: 'shark', colors: { main: '#141420', belly: '#26263a', fin: '#0a0a12', accent: '#7a4fff', eye: '#b88fff' },
    pattern: 'glow', glow: 0.4, time: 'any', weather: 'any',
    desc: 'Absorbs the floodlights instead of reflecting them, so you track it by the shape of the missing water.',
    atlasHint: 'The deepest trench walls. Sonar only — your lights will not help.',
    dangerous: true, boss: false, edible: false, xp: 1800 },

  { id: 'crown-angler', name: 'Crown Angler', short: 'Crown Angler', tier: 8, habitat: ['abyss', 'trench'], regions: ['abyss'],
    depth: [2000, 8000], weight: [90, 800], length: [1.6, 4.0], value: 2400, rarity: 'legendary', spawnWeight: 6,
    strength: 0.82, speed: 0.2, stamina: 0.75, aggression: 1.0, escape: 0.45, fight: 'brawler',
    body: 'anglerfish', colors: { main: '#3a1f4e', belly: '#5c3a72', fin: '#22102e', accent: '#ffcf4a', eye: '#fff2c0' },
    pattern: 'glow', glow: 0.85, time: 'any', weather: 'any',
    desc: 'Seven lures on seven stalks, arranged like a chandelier. Smaller anglerfish gather beneath it and are not seen again.',
    atlasHint: 'Trench basins. Kill your lights and follow the constellation that moves.',
    dangerous: true, boss: false, edible: false, xp: 2100 },

  { id: 'titanfish', name: 'Titanfish', short: 'Titanfish', tier: 8, habitat: ['abyss', 'trench', 'deep'], regions: ['abyss'],
    depth: [1800, 8000], weight: [1800, 9000], length: [7.0, 16.0], value: 2600, rarity: 'legendary', spawnWeight: 4,
    strength: 0.96, speed: 0.4, stamina: 0.95, aggression: 0.7, escape: 0.3, fight: 'titan',
    body: 'leviathan', colors: { main: '#3f5a4a', belly: '#9fc0a0', fin: '#25382e', accent: '#ffb24a', eye: '#ffe08a' },
    pattern: 'bands', glow: 0.35, time: 'any', weather: 'any',
    desc: 'Scales the size of manhole covers, each one worth more than your first boat. Moves like weather rather than an animal.',
    atlasHint: 'Deep trench, heaviest gear in the game, and a winch bolted to the deck.',
    dangerous: true, boss: false, edible: true, xp: 2600 },

  { id: 'abyss-leviathan', name: 'Abyssal Leviathan', short: 'Leviathan', tier: 8, habitat: ['abyss', 'trench'], regions: ['abyss'],
    depth: [3000, 11000], weight: [4000, 22000], length: [12.0, 30.0], value: 3000, rarity: 'mythic', spawnWeight: 2,
    strength: 1.0, speed: 0.55, stamina: 1.0, aggression: 0.85, escape: 0.35, fight: 'titan',
    body: 'leviathan', colors: { main: '#1c2c48', belly: '#3f5f80', fin: '#0e1728', accent: '#4fe8d0', eye: '#a8fff0' },
    pattern: 'glow', glow: 0.6, time: 'any', weather: 'any',
    desc: 'The sonar returns an object longer than the ship and everybody agrees, quietly, to call it a thermocline.',
    atlasHint: 'The bottom of the trench. Deepest sub, strongest line, and a plan for leaving.',
    dangerous: true, boss: false, edible: false, xp: 4200 },

  // === TIER 8 BOSS ==========================================================

  { id: 'abyss-mouth', name: 'The Abyss Mouth', short: 'Abyss Mouth', tier: 8, habitat: ['trench', 'abyss'], regions: ['abyss'],
    depth: [6000, 11000], weight: [12000, 60000], length: [18.0, 40.0], value: 5200, rarity: 'mythic', spawnWeight: 1,
    strength: 1.0, speed: 0.5, stamina: 1.0, aggression: 1.0, escape: 0.4, fight: 'titan',
    body: 'anglerfish', colors: { main: '#170f22', belly: '#2e1c3c', fin: '#0a0610', accent: '#ff3a6a', eye: '#ffd0dc' },
    pattern: 'glow', glow: 1.0, time: 'any', weather: 'any',
    desc: 'At the very bottom there is a light, and it has been patient for a very long time. It is not a light.',
    atlasHint: 'The final trench floor. Everything you own, and then some.',
    dangerous: true, boss: true, edible: false, xp: 9000,
    bossData: {
      hp: 42000,
      phases: [
        { hpPct: 1.0, name: 'The Lure', mechanics: ['summon'] },
        { hpPct: 0.8, name: 'Opening', mechanics: ['ram', 'summon'] },
        { hpPct: 0.55, name: 'Pressure', mechanics: ['shockwave', 'armor', 'dive'] },
        { hpPct: 0.3, name: 'Swallow', mechanics: ['ram', 'dive', 'shockwave'] },
        { hpPct: 0.1, name: 'All Teeth', mechanics: ['ram', 'shockwave', 'summon', 'armor', 'dive'] },
      ],
      weakPoints: 3, attackInterval: [3, 7],
      reward: { money: 4000000, unlocks: ['rod_abyssal', 'sub_hadal', 'ending_deep', 'trophy_abyss_mouth'] },
    } },
];

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** id -> species. A real Map; `FISH_BY_ID_OBJ` is the plain-object mirror. */
export const FISH_BY_ID = new Map(FISH_SPECIES.map((s) => [s.id, s]));

export const FISH_BY_ID_OBJ = Object.freeze(
  FISH_SPECIES.reduce((m, s) => { m[s.id] = s; return m; }, Object.create(null)),
);

const _byRegion = new Map();
for (const s of FISH_SPECIES) {
  for (const r of s.regions) {
    let list = _byRegion.get(r);
    if (!list) { list = []; _byRegion.set(r, list); }
    list.push(s);
  }
}

const _byHabitat = new Map();
for (const s of FISH_SPECIES) {
  for (const h of s.habitat) {
    let list = _byHabitat.get(h);
    if (!list) { list = []; _byHabitat.set(h, list); }
    list.push(s);
  }
}

/** Junk ids, for "did I catch garbage?" checks in the UI. */
export const JUNK_IDS = FISH_SPECIES.filter((s) => s.body.startsWith('junk_')).map((s) => s.id);
export const BOSS_IDS = FISH_SPECIES.filter((s) => s.boss).map((s) => s.id);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function getSpecies(id) {
  return FISH_BY_ID.get(id) || null;
}

/** All species that can appear in a region (frozen array, do not mutate). */
export function speciesInRegion(regionId) {
  return _byRegion.get(regionId) || [];
}

export function speciesWithHabitat(habitat) {
  return _byHabitat.get(habitat) || [];
}

const TIME_MATCH = {
  day: ['day'], night: ['night'], dawn: ['dawn'], dusk: ['dusk'],
};

function timeOk(species, time) {
  if (!time || species.time === 'any') return true;
  if (species.time === time) return true;
  // Dawn/dusk fish are half-happy in day/night, so they never vanish entirely.
  const t = TIME_MATCH[species.time];
  return !!(t && t.includes(time));
}

function weatherOk(species, weather) {
  if (!weather || species.weather === 'any') return true;
  return species.weather === weather;
}

/**
 * Candidate species for a spot in the world.
 *
 * @param {string|string[]} habitat  habitat tag(s) of the spot
 * @param {number} depth             metres below surface
 * @param {object} [opts]
 * @param {string} [opts.region]     restrict to a region id
 * @param {string} [opts.time]       'day'|'night'|'dawn'|'dusk'
 * @param {string} [opts.weather]    'clear'|'rain'|'storm'|'fog'
 * @param {number} [opts.tierMax]    hide species above this tier (progression gate)
 * @param {number} [opts.tierMin]
 * @param {boolean} [opts.bosses]    include bosses (default false)
 * @param {boolean} [opts.junk]      include junk (default true)
 * @param {number} [opts.depthSlack] metres of tolerance on the depth band (default 0)
 */
export function speciesForHabitat(habitat, depth = 0, opts = {}) {
  const habs = Array.isArray(habitat) ? habitat : [habitat];
  const {
    region = null, time = null, weather = null,
    tierMax = 99, tierMin = 0, bosses = false, junk = true,
    depthSlack = 0,
  } = opts;

  const seen = new Set();
  const out = [];
  for (const h of habs) {
    const list = _byHabitat.get(h);
    if (!list) continue;
    for (const s of list) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      if (s.boss && !bosses) continue;
      if (!junk && s.body.startsWith('junk_')) continue;
      if (s.tier > tierMax || s.tier < tierMin) continue;
      if (region && !s.regions.includes(region)) continue;
      if (depth < s.depth[0] - depthSlack || depth > s.depth[1] + depthSlack) continue;
      if (!timeOk(s, time)) continue;
      if (!weatherOk(s, weather)) continue;
      out.push(s);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rolls
// ---------------------------------------------------------------------------

/**
 * Pick a cosmetic variant. `luckMult` scales the odds of every non-normal
 * variant, so luck 2 doubles the shiny/golden/etc. chances without ever
 * making "normal" impossible.
 */
export function rollVariant(rng = Math.random, luckMult = 1) {
  const luck = Math.max(0, luckMult);
  const v = weightedPick(VARIANTS, rng, (it) => (it.id === 'normal' ? it.chance : it.chance * luck));
  return v || NORMAL_VARIANT;
}

/** Weighted species pick from a candidate list. Returns null for an empty list. */
export function rollSpecies(candidates, rng = Math.random) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return weightedPick(candidates, rng, 'spawnWeight') || candidates[0];
}

/** Rarity-weighted convenience roll, used by loot crates and quest rewards. */
export function rollRarity(rng = Math.random, luckMult = 1) {
  const rows = RARITY_ORDER.map((id) => ({
    id, weight: id === 'common' ? RARITY[id].weight : RARITY[id].weight * Math.max(0, luckMult),
  }));
  return (weightedPick(rows, rng, 'weight') || rows[0]).id;
}

/** Integer dollar value of a specimen. Never less than $1. */
export function computeFishValue(species, variant, weightKg, rarityBonus = 1) {
  if (!species) return 1;
  const v = variant || NORMAL_VARIANT;
  const rar = RARITY[species.rarity] || RARITY.common;
  const raw = species.value * Math.max(0, weightKg) * rar.mult * v.valueMult * rarityBonus;
  return Math.max(1, Math.round(raw));
}

/**
 * Right-skewed 0..1 roll: most specimens sit near the small end of the range,
 * with a thin tail of monsters. `trophyChance` re-rolls into the top slice.
 */
function skewedUnit(rng, trophyChance = 0.035) {
  const u = rng();
  if (u < trophyChance) return 0.72 + rng() * 0.28;        // rare monster
  const t = (u - trophyChance) / (1 - trophyChance);
  return Math.pow(t, 2.35);                                 // fat low end
}

/**
 * Roll a concrete specimen of a species.
 *
 * @param {object} species
 * @param {Function} rng  makeRNG() instance or Math.random
 * @param {object} [opts]
 * @param {object} [opts.variant]      force a variant object
 * @param {number} [opts.luck]         luck multiplier for the variant roll
 * @param {number} [opts.rarityBonus]  extra price multiplier (market, perks)
 * @param {number} [opts.sizeBias]     0..1 nudge toward the big end
 * @param {number} [opts.trophyChance]
 */
export function rollFishInstance(species, rng = Math.random, opts = {}) {
  const s = typeof species === 'string' ? getSpecies(species) : species;
  if (!s) return null;

  const variant = opts.variant || rollVariant(rng, opts.luck ?? 1);
  const bias = clamp01(opts.sizeBias ?? 0);
  let u = skewedUnit(rng, opts.trophyChance ?? 0.035);
  u = clamp01(lerp(u, Math.max(u, 0.55 + rng() * 0.45), bias));

  const [wMin, wMax] = s.weight;
  const [lMin, lMax] = s.length;

  // Bosses do not get a size lottery on top of an already-enormous range.
  const sizeMult = s.boss ? 1 : variant.sizeMult;
  const weight = clamp(lerp(wMin, wMax, u) * sizeMult, wMin * 0.5, wMax * 3.5);

  // Length tracks weight on a cube root so a 2x-mass fish is ~1.26x longer.
  const lenBase = lerp(lMin, lMax, u);
  const length = clamp(lenBase * Math.cbrt(sizeMult), lMin * 0.5, lMax * 2.2);

  const value = computeFishValue(s, variant, weight, opts.rarityBonus ?? 1);
  const name = `${variant.name} ${s.name}`.trim();

  return {
    speciesId: s.id,
    variantId: variant.id,
    weight,
    length,
    value,
    rarity: s.rarity,
    name,
    colors: { ...s.colors },
  };
}

/** Total glow for a specimen — species bioluminescence plus variant sheen. */
export function fishGlow(species, variant) {
  const v = variant || NORMAL_VARIANT;
  const r = RARITY[species?.rarity] || RARITY.common;
  return clamp01((species?.glow ?? 0) + v.glow + r.glow * 0.4);
}

/** Display colour for a rarity chip. */
export function rarityColor(rarity) {
  return (RARITY[rarity] || RARITY.common).color;
}

// ---------------------------------------------------------------------------
// Dev-only integrity check
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = [
  'id', 'name', 'short', 'tier', 'habitat', 'regions', 'depth', 'weight', 'length',
  'value', 'rarity', 'spawnWeight', 'strength', 'speed', 'stamina', 'aggression',
  'escape', 'fight', 'body', 'colors', 'pattern', 'glow', 'time', 'weather',
  'desc', 'atlasHint', 'dangerous', 'boss', 'edible', 'xp',
];
const UNIT_FIELDS = ['strength', 'speed', 'stamina', 'aggression', 'escape', 'glow'];
const COLOR_KEYS = ['main', 'belly', 'fin', 'accent', 'eye'];
const PATTERNS = ['none', 'stripes', 'spots', 'bands', 'gradient', 'mottled', 'glow'];
const TIMES = ['any', 'day', 'night', 'dawn', 'dusk'];
const WEATHERS = ['any', 'clear', 'rain', 'storm', 'fog'];
const HEX = /^#[0-9a-fA-F]{6}$/;

if (import.meta.env?.DEV) {
  const problems = [];
  const ids = new Set();

  for (const s of FISH_SPECIES) {
    const tag = s?.id ?? '<no id>';
    for (const f of REQUIRED_FIELDS) {
      if (s[f] === undefined || s[f] === null) problems.push(`${tag}: missing field "${f}"`);
    }
    if (ids.has(s.id)) problems.push(`duplicate id "${s.id}"`);
    ids.add(s.id);

    if (!RARITY[s.rarity]) problems.push(`${tag}: unknown rarity "${s.rarity}"`);
    if (!FIGHT_STYLES.includes(s.fight)) problems.push(`${tag}: unknown fight "${s.fight}"`);
    if (!PATTERNS.includes(s.pattern)) problems.push(`${tag}: unknown pattern "${s.pattern}"`);
    if (!TIMES.includes(s.time)) problems.push(`${tag}: unknown time "${s.time}"`);
    if (!WEATHERS.includes(s.weather)) problems.push(`${tag}: unknown weather "${s.weather}"`);
    if (!(s.tier >= 1 && s.tier <= 8)) problems.push(`${tag}: tier ${s.tier} out of 1..8`);

    for (const f of UNIT_FIELDS) {
      if (!(s[f] >= 0 && s[f] <= 1)) problems.push(`${tag}: ${f}=${s[f]} outside 0..1`);
    }
    for (const [f, lbl] of [[s.depth, 'depth'], [s.weight, 'weight'], [s.length, 'length']]) {
      if (!Array.isArray(f) || f.length !== 2) problems.push(`${tag}: ${lbl} must be [min,max]`);
      else if (!(f[0] <= f[1])) problems.push(`${tag}: ${lbl} min > max`);
      else if (!(f[0] >= 0)) problems.push(`${tag}: ${lbl} min negative`);
    }
    if (!(s.value > 0)) problems.push(`${tag}: value must be > 0`);
    if (!(s.spawnWeight > 0)) problems.push(`${tag}: spawnWeight must be > 0`);
    if (!(s.xp > 0)) problems.push(`${tag}: xp must be > 0`);

    for (const h of s.habitat) if (!HABITATS.includes(h)) problems.push(`${tag}: unknown habitat "${h}"`);
    for (const r of s.regions) if (!REGIONS.includes(r)) problems.push(`${tag}: unknown region "${r}"`);
    if (!s.habitat.length) problems.push(`${tag}: no habitat`);
    if (!s.regions.length) problems.push(`${tag}: no region`);

    for (const k of COLOR_KEYS) {
      if (!HEX.test(s.colors?.[k] ?? '')) problems.push(`${tag}: colors.${k} is not a #rrggbb hex ("${s.colors?.[k]}")`);
    }

    if (s.boss) {
      const b = s.bossData;
      if (!b) problems.push(`${tag}: boss without bossData`);
      else {
        if (!(b.hp > 0)) problems.push(`${tag}: bossData.hp must be > 0`);
        if (!Array.isArray(b.phases) || !b.phases.length) problems.push(`${tag}: bossData.phases empty`);
        else for (const p of b.phases) {
          if (!(p.hpPct > 0 && p.hpPct <= 1)) problems.push(`${tag}: phase "${p.name}" hpPct out of range`);
          if (!Array.isArray(p.mechanics) || !p.mechanics.length) problems.push(`${tag}: phase "${p.name}" has no mechanics`);
        }
        if (!(b.weakPoints > 0)) problems.push(`${tag}: bossData.weakPoints must be > 0`);
        if (!Array.isArray(b.attackInterval) || b.attackInterval.length !== 2) problems.push(`${tag}: bossData.attackInterval must be [min,max]`);
        if (!b.reward || !(b.reward.money > 0) || !Array.isArray(b.reward.unlocks)) problems.push(`${tag}: bossData.reward malformed`);
      }
    }
  }

  const variantIds = new Set();
  for (const v of VARIANTS) {
    if (variantIds.has(v.id)) problems.push(`duplicate variant id "${v.id}"`);
    variantIds.add(v.id);
    if (!(v.chance > 0)) problems.push(`variant ${v.id}: chance must be > 0`);
    if (!(v.sizeMult > 0)) problems.push(`variant ${v.id}: sizeMult must be > 0`);
  }
  if (!variantIds.has('normal')) problems.push('VARIANTS is missing the "normal" entry');

  if (problems.length) {
    console.warn(`[fishData] ${problems.length} problem(s):\n  ` + problems.join('\n  '));
  } else {
    console.info(`[fishData] ${FISH_SPECIES.length} species OK (${BOSS_IDS.length} bosses, ${JUNK_IDS.length} junk).`);
  }
}
