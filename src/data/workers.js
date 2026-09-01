/**
 * Worker roles, traits, name pools and progression curves.
 * Everything a worker "is" comes from here so new roles are data only.
 */

export const ROLES = {
  fisherman: {
    id: 'fisherman', name: 'Fisherman', icon: '🎣',
    desc: 'Catches fish from shore, dock or deck.',
    primary: ['fishing', 'luck'], baseWage: 38, hireMult: 12,
    skills: ['fishing', 'strength', 'luck', 'stamina'],
    tree: [
      { id: 'cast_distance', name: 'Cast Distance', max: 5, effect: { castRange: 0.12 } },
      { id: 'hook_chance', name: 'Hook Chance', max: 5, effect: { hookChance: 0.05 } },
      { id: 'reel_speed', name: 'Reel Speed', max: 5, effect: { reelSpeed: 0.1 } },
      { id: 'rare_finder', name: 'Rare Fish Chance', max: 4, effect: { rareBonus: 0.18 } },
      { id: 'heavy_fish', name: 'Heavy Fish', max: 4, effect: { maxWeight: 0.35 } },
    ],
    unlock: null,
  },
  hunter: {
    id: 'hunter', name: 'Hunter', icon: '🔱',
    desc: 'Handles dangerous fish with harpoons.',
    primary: ['accuracy', 'strength'], baseWage: 62, hireMult: 16,
    skills: ['accuracy', 'strength', 'nerve', 'stamina'],
    tree: [
      { id: 'accuracy', name: 'Accuracy', max: 5, effect: { accuracy: 0.08 } },
      { id: 'reload', name: 'Reload Speed', max: 5, effect: { reload: 0.1 } },
      { id: 'damage', name: 'Damage', max: 5, effect: { damage: 0.15 } },
      { id: 'crit', name: 'Critical Hits', max: 4, effect: { crit: 0.05 } },
      { id: 'boss_dmg', name: 'Boss Damage', max: 3, effect: { bossDamage: 0.25 } },
    ],
    unlock: 'harbor',
  },
  captain: {
    id: 'captain', name: 'Captain', icon: '🧭',
    desc: 'Drives boats and leads a crew.',
    primary: ['navigation', 'leadership'], baseWage: 95, hireMult: 22,
    skills: ['navigation', 'leadership', 'nerve', 'mechanics'],
    tree: [
      { id: 'boat_speed', name: 'Boat Speed', max: 5, effect: { boatSpeed: 0.08 } },
      { id: 'fuel_eff', name: 'Fuel Efficiency', max: 5, effect: { fuelEff: 0.1 } },
      { id: 'storm_handling', name: 'Storm Handling', max: 4, effect: { stormHandling: 0.2 } },
      { id: 'navigation', name: 'Navigation', max: 5, effect: { travelSpeed: 0.09 } },
      { id: 'automation', name: 'Automation', max: 3, effect: { autonomy: 0.25 } },
    ],
    unlock: 'boats',
  },
  deckhand: {
    id: 'deckhand', name: 'Deckhand', icon: '📦',
    desc: 'Moves cargo, hauls nets, keeps the deck clear.',
    primary: ['strength', 'stamina'], baseWage: 30, hireMult: 9,
    skills: ['strength', 'stamina', 'mechanics', 'luck'],
    tree: [
      { id: 'carry', name: 'Carry Capacity', max: 5, effect: { carry: 0.2 } },
      { id: 'speed', name: 'Haul Speed', max: 5, effect: { haulSpeed: 0.12 } },
      { id: 'sorting', name: 'Sorting', max: 4, effect: { freshness: 0.04 } },
      { id: 'tireless', name: 'Tireless', max: 3, effect: { stamina: 0.25 } },
    ],
    unlock: 'boats',
  },
  sonar: {
    id: 'sonar', name: 'Sonar Operator', icon: '📡',
    desc: 'Finds fish before anyone else does.',
    primary: ['perception', 'navigation'], baseWage: 78, hireMult: 18,
    skills: ['perception', 'navigation', 'luck', 'mechanics'],
    tree: [
      { id: 'range', name: 'Sonar Range', max: 5, effect: { sonarRange: 0.16 } },
      { id: 'detail', name: 'Signal Detail', max: 4, effect: { sonarDetail: 1 } },
      { id: 'shoal', name: 'Shoal Finder', max: 4, effect: { catchRate: 0.12 } },
      { id: 'rare_ping', name: 'Rare Ping', max: 3, effect: { rareBonus: 0.22 } },
    ],
    unlock: 'harbor',
  },
  diver: {
    id: 'diver', name: 'Diver', icon: '🤿',
    desc: 'Works underwater, salvages wrecks.',
    primary: ['diving', 'nerve'], baseWage: 84, hireMult: 20,
    skills: ['diving', 'nerve', 'stamina', 'perception'],
    tree: [
      { id: 'depth', name: 'Dive Depth', max: 5, effect: { diveDepth: 30 } },
      { id: 'air', name: 'Air Efficiency', max: 4, effect: { air: 0.15 } },
      { id: 'salvage', name: 'Salvage', max: 4, effect: { salvage: 0.2 } },
      { id: 'calm', name: 'Nerves of Steel', max: 3, effect: { danger: -0.2 } },
    ],
    unlock: 'submarines',
  },
  mechanic: {
    id: 'mechanic', name: 'Mechanic', icon: '🔧',
    desc: 'Repairs boats and keeps engines alive.',
    primary: ['mechanics'], baseWage: 68, hireMult: 15,
    skills: ['mechanics', 'strength', 'perception', 'stamina'],
    tree: [
      { id: 'repair', name: 'Repair Speed', max: 5, effect: { repairSpeed: 0.16 } },
      { id: 'preventive', name: 'Preventive Maintenance', max: 4, effect: { wearReduction: 0.12 } },
      { id: 'tuning', name: 'Engine Tuning', max: 4, effect: { boatSpeed: 0.05 } },
      { id: 'salvage_parts', name: 'Parts Salvage', max: 3, effect: { repairCost: -0.15 } },
    ],
    unlock: 'harbor',
  },
  processor: {
    id: 'processor', name: 'Processor', icon: '🔪',
    desc: 'Cleans, fillets and packs the catch for more money.',
    primary: ['processing'], baseWage: 52, hireMult: 13,
    skills: ['processing', 'stamina', 'perception', 'strength'],
    tree: [
      { id: 'speed', name: 'Processing Speed', max: 5, effect: { processSpeed: 0.16 } },
      { id: 'quality', name: 'Quality', max: 5, effect: { processQuality: 0.08 } },
      { id: 'yield', name: 'Yield', max: 4, effect: { yieldBonus: 0.06 } },
      { id: 'premium', name: 'Premium Packing', max: 3, effect: { processLevels: 1 } },
    ],
    unlock: 'processing',
  },
  subpilot: {
    id: 'subpilot', name: 'Sub Pilot', icon: '🛸',
    desc: 'Takes submarines places submarines should not go.',
    primary: ['diving', 'navigation'], baseWage: 160, hireMult: 34,
    skills: ['diving', 'navigation', 'nerve', 'mechanics'],
    tree: [
      { id: 'depth', name: 'Crush Tolerance', max: 5, effect: { crushDepth: 120 } },
      { id: 'power', name: 'Power Efficiency', max: 4, effect: { power: 0.14 } },
      { id: 'handling', name: 'Handling', max: 4, effect: { subSpeed: 0.1 } },
      { id: 'discovery', name: 'Discovery', max: 3, effect: { rareBonus: 0.3 } },
    ],
    unlock: 'submarines',
  },
  manager: {
    id: 'manager', name: 'Manager', icon: '📋',
    desc: 'Makes everyone else slightly better at their job.',
    primary: ['leadership'], baseWage: 130, hireMult: 26,
    skills: ['leadership', 'perception', 'luck', 'processing'],
    tree: [
      { id: 'morale', name: 'Morale', max: 5, effect: { teamMorale: 0.06 } },
      { id: 'efficiency', name: 'Efficiency', max: 5, effect: { teamEfficiency: 0.05 } },
      { id: 'logistics', name: 'Logistics', max: 4, effect: { teamCatchRate: 0.05 } },
      { id: 'negotiation', name: 'Negotiation', max: 4, effect: { priceMult: 0.02 } },
    ],
    unlock: 'harbor',
  },
};

export const ROLE_LIST = Object.values(ROLES);

export const SKILLS = ['fishing', 'strength', 'navigation', 'luck', 'accuracy', 'nerve',
  'mechanics', 'perception', 'diving', 'processing', 'leadership', 'stamina'];

export const TRAITS = [
  { id: 'lucky', name: 'Lucky', good: true, desc: 'Finds rare fish more often.', effect: { rareBonus: 0.35, luck: 2 }, weight: 40 },
  { id: 'unlucky', name: 'Unlucky', good: false, desc: 'Somehow catches boots.', effect: { rareBonus: -0.3, junkChance: 0.25 }, weight: 30 },
  { id: 'fast_learner', name: 'Fast Learner', good: true, desc: 'Gains XP 40% faster.', effect: { xpMult: 0.4 }, weight: 42 },
  { id: 'slow', name: 'Slow Learner', good: false, desc: 'Gains XP 30% slower.', effect: { xpMult: -0.3 }, weight: 28 },
  { id: 'strong', name: 'Strong', good: true, desc: 'Handles much heavier fish.', effect: { maxWeight: 0.6, strength: 2 }, weight: 38 },
  { id: 'lazy', name: 'Lazy', good: false, desc: 'Works 25% slower and rests often.', effect: { speed: -0.25, restBias: 0.4 }, weight: 34 },
  { id: 'fearless', name: 'Fearless', good: true, desc: 'Will fight anything with teeth.', effect: { danger: -0.5, nerve: 3 }, weight: 26 },
  { id: 'seasick', name: 'Sea Sick', good: false, desc: 'Loses morale fast at sea.', effect: { boatMorale: -0.5 }, weight: 30 },
  { id: 'sea_legs', name: 'Sea Legs', good: true, desc: 'Unbothered by any weather.', effect: { boatMorale: 0.4, stormHandling: 0.3 }, weight: 30 },
  { id: 'fish_whisperer', name: 'Fish Whisperer', good: true, desc: 'Fish bite noticeably faster.', effect: { biteSpeed: 0.45, fishing: 2 }, weight: 20 },
  { id: 'mechanic_trait', name: 'Tinkerer', good: true, desc: 'Repairs faster, breaks less.', effect: { repairSpeed: 0.4, mechanics: 2 }, weight: 30 },
  { id: 'deep_diver', name: 'Deep Diver', good: true, desc: 'Comfortable far below the light.', effect: { diveDepth: 120, diving: 2 }, weight: 22 },
  { id: 'sharpshooter', name: 'Sharpshooter', good: true, desc: 'Rarely misses a harpoon shot.', effect: { accuracy: 0.35 }, weight: 24 },
  { id: 'efficient', name: 'Efficient', good: true, desc: 'Does everything 20% faster.', effect: { speed: 0.2 }, weight: 26 },
  { id: 'greedy', name: 'Greedy', good: false, desc: 'Demands 35% higher wages.', effect: { wageMult: 0.35 }, weight: 34 },
  { id: 'cheap', name: 'Modest', good: true, desc: 'Works for 20% less.', effect: { wageMult: -0.2 }, weight: 30 },
  { id: 'veteran', name: 'Veteran', good: true, desc: 'Starts several levels ahead.', effect: { startLevel: 4 }, weight: 16 },
  { id: 'night_owl', name: 'Night Owl', good: true, desc: 'Works much better at night.', effect: { nightBonus: 0.5 }, weight: 28 },
  { id: 'early_bird', name: 'Early Bird', good: true, desc: 'Works much better by day.', effect: { dayBonus: 0.4 }, weight: 28 },
  { id: 'chatty', name: 'Chatty', good: null, desc: 'Never stops talking.', effect: { talkRate: 3 }, weight: 32 },
  { id: 'quiet', name: 'Quiet', good: null, desc: 'Says roughly nothing.', effect: { talkRate: -0.8 }, weight: 32 },
  { id: 'clumsy', name: 'Clumsy', good: false, desc: 'Drops things. Often.', effect: { dropChance: 0.15 }, weight: 26 },
  { id: 'meticulous', name: 'Meticulous', good: true, desc: 'The catch stays fresher.', effect: { freshness: 0.12 }, weight: 24 },
  { id: 'ironstomach', name: 'Iron Stomach', good: true, desc: 'Immune to seasickness and bad soup.', effect: { boatMorale: 0.6 }, weight: 18 },
];

export const FIRST_NAMES = [
  'Jack', 'Marcus', 'Ben', 'Ryan', 'Cole', 'Dmitri', 'Ines', 'Tomas', 'Priya', 'Kofi',
  'Sven', 'Maya', 'Otto', 'Rosa', 'Hank', 'Yuki', 'Bram', 'Nia', 'Erik', 'Lila',
  'Gus', 'Fen', 'Ada', 'Kai', 'Miles', 'Rin', 'Bo', 'Sasha', 'Tariq', 'Nadia',
  'Duke', 'Wren', 'Ivo', 'Clara', 'Ozzy', 'Sol', 'Vera', 'Nils', 'June', 'Rex',
  'Mo', 'Zeb', 'Nell', 'Ari', 'Pip', 'Cass', 'Tove', 'Ren', 'Boone', 'Ilya',
];
export const LAST_NAMES = [
  'Miller', 'Kovak', 'Ashby', 'Nakamura', 'Oduya', 'Lindqvist', 'Barros', 'Whelan',
  'Petrov', 'Okonjo', 'Vance', 'Halloran', 'Reyes', 'Dunbar', 'Sorensen', 'Malick',
  'Trent', 'Osei', 'Bright', 'Kessler', 'Marlow', 'Quill', 'Fenwick', 'Drummond',
  'Salter', 'Bexley', 'Crowe', 'Nadeau', 'Iverson', 'Tam', 'Rask', 'Bellweather',
  'Pike', 'Gale', 'Stoat', 'Harker', 'Vos', 'Ledger', 'Mowbray', 'Skarsgard',
];
export const NICKNAMES = [
  'Two-Boots', 'The Net', 'Chum', 'Barnacle', 'Wetsock', 'Lucky', 'Tuna', 'Slack',
  'Anchor', 'Squid', 'Gutter', 'Bait', 'Hook', 'Drift', 'Salt', 'Gaff',
];

/** XP required to reach `level` from level-1. */
export function xpForLevel(level) {
  return Math.round(85 * Math.pow(1.28, level - 1));
}

/** Base daily wage for a role at a level, before traits. */
export function baseWage(roleId, level, skills) {
  const r = ROLES[roleId];
  if (!r) return 30;
  const skillAvg = r.primary.reduce((a, k) => a + (skills?.[k] ?? 3), 0) / r.primary.length;
  return Math.round(r.baseWage * (1 + (level - 1) * 0.22) * (0.7 + skillAvg * 0.09));
}

export const WORKER_LINES = {
  catch: ['Got one!', 'Ha! Gotcha.', 'On the line!', "That's a keeper.", 'Fish on!'],
  bigCatch: ["That thing's huge.", 'Did you SEE that?', "That fish is worth a fortune.", 'My arms. My arms.'],
  rare: ["I've never seen one like this.", "Boss — you'll want to see this.", 'This one glows. Is that normal?'],
  full: ['Storage is full.', "Can't carry any more.", "Where do you want all this?"],
  gear: ['I need better gear.', 'This rod is held together with hope.', 'Any chance of an upgrade?'],
  fuel: ["Boat's almost out of fuel.", 'Running on fumes out here.'],
  sonar: ["Something's on the sonar.", 'Big contact, bearing ahead.', 'Whatever that is, it is large.'],
  idle: ['Nice day for it.', 'Quiet out here.', 'Any orders, boss?', 'Just waiting on you.'],
  tired: ['I need a break.', "I've been at this for hours.", 'Morale is... a concept.'],
  arrive: ['Right, where do you want me?', 'Reporting for duty.', "Let's get to work."],
  storm: ['This weather is a problem.', "I don't love this.", 'Should we head back?'],
  boss: ["That's not a fish. That's a building.", 'Nope. Nope nope nope.', "I'm not paid enough."],
};
