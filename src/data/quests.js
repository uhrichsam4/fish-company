/**
 * Quest definitions. Objectives are matched against gameplay events by type,
 * so a new quest is data only.
 *
 * Objective types:
 *  catch      {species?, rarity?, variant?, minWeight?, region?, count}
 *  catchAny   {count}
 *  sell       {count | value}
 *  money      {amount}          — reach a cash total
 *  buy        {item | category | tier, count}
 *  trick      {trick?, count}
 *  boss       {id}
 *  region     {id}              — visit
 *  worker     {count}           — employ N
 *  boat       {count}
 *  fleetTrip  {count}
 *  research   {id}
 *  depth      {metres}
 *  custom     {flag}
 */
export const QUESTS = [
  // ---------------------------------------------------------------- onboarding
  {
    id: 'q_wake', name: 'Wake Up', giver: 'self', chain: 'intro', order: 0,
    desc: 'You washed up here with a wet rod and no plan. Find the fishing rod by the wreck.',
    objectives: [{ type: 'custom', flag: 'picked_rod', count: 1, text: 'Pick up the fishing rod' }],
    rewards: { money: 0 }, autoStart: true, region: 'crash',
    onComplete: 'q_first_cast',
  },
  {
    id: 'q_first_cast', name: 'Wet a Line', giver: 'self', chain: 'intro', order: 1,
    desc: 'Face the water. Hold left mouse to charge a cast, release to throw.',
    objectives: [{ type: 'custom', flag: 'cast_in_water', count: 1, text: 'Cast into the water' }],
    rewards: { money: 0 }, region: 'crash', onComplete: 'q_first_fish',
  },
  {
    id: 'q_first_fish', name: 'First Blood (Fish)', giver: 'self', chain: 'intro', order: 2,
    desc: 'Wait for a bite, click to set the hook, then hold left mouse to reel it in.',
    objectives: [{ type: 'catchAny', count: 1, text: 'Catch a fish' }],
    rewards: { money: 15, xp: 10 }, region: 'crash', onComplete: 'q_first_sale',
  },
  {
    id: 'q_first_sale', name: 'Cash Flow', giver: 'self', chain: 'intro', order: 3,
    desc: 'Carry the fish to the sell station and drop it in — or press E at the station to sell everything you stored.',
    objectives: [{ type: 'sell', count: 1, text: 'Sell a fish' }],
    rewards: { money: 25 }, region: 'crash', onComplete: 'q_better_rod',
  },
  {
    id: 'q_better_rod', name: 'Upgrade Your Stick', giver: 'shop', chain: 'intro', order: 4,
    desc: 'That bent stick is an insult to fish everywhere. Buy the Old Fishing Rod at the shop.',
    objectives: [{ type: 'buy', item: 'rod_old', count: 1, text: 'Buy the Old Fishing Rod' }],
    rewards: { money: 40, xp: 15 }, region: 'crash', onComplete: 'q_five_fish',
  },
  {
    id: 'q_five_fish', name: 'Getting the Hang of It', giver: 'self', chain: 'intro', order: 5,
    desc: 'Catch five more fish. Any five. Nobody is checking receipts.',
    objectives: [{ type: 'catchAny', count: 5, text: 'Catch fish' }],
    rewards: { money: 80, xp: 25, item: 'bait_worm' }, onComplete: 'q_bass_hunt',
  },
  {
    id: 'q_bass_hunt', name: 'Bass Ackwards', giver: 'shop', chain: 'intro', order: 6,
    desc: 'The merchant wants three bass. He will not say why.',
    objectives: [{ type: 'catch', species: 'bass', count: 3, text: 'Catch bass' }],
    rewards: { money: 220, xp: 40 }, onComplete: 'q_first_boat',
  },
  {
    id: 'q_first_boat', name: 'A Way Off This Rock', giver: 'shop', chain: 'intro', order: 7,
    desc: 'Save up $400. The merchant claims he can arrange passage to Rocky Isle. He is lying about the "arrange" part.',
    objectives: [{ type: 'money', amount: 400, text: 'Save up $400' }],
    rewards: { money: 0, unlockRegion: 'rocky', xp: 60 },
  },

  // ---------------------------------------------------------------- rocky isle
  {
    id: 'q_rocky_arrival', name: 'Sharper Rocks, Sharper Fish', giver: 'shop', chain: 'rocky', order: 0,
    desc: 'Catch five fish around Rocky Isle to prove you can survive the commute.',
    objectives: [{ type: 'catch', region: 'rocky', count: 5, text: 'Catch fish at Rocky Isle' }],
    rewards: { money: 350, xp: 60 }, requires: ['q_first_boat'], onComplete: 'q_big_one',
  },
  {
    id: 'q_big_one', name: 'The Big One', giver: 'shop', chain: 'rocky', order: 1,
    desc: 'Land something over 8 kg. Your stick will not do it. Your wallet knows what to do.',
    objectives: [{ type: 'catch', minWeight: 8, count: 1, text: 'Catch a fish over 8 kg' }],
    rewards: { money: 600, xp: 90 }, requires: ['q_rocky_arrival'], onComplete: 'q_trickshot',
  },
  {
    id: 'q_trickshot', name: 'Show Off', giver: 'npc', chain: 'rocky', order: 2,
    desc: 'Land a fish with a trick shot. Cast further than 22 m, or spin a full turn while charging.',
    objectives: [{ type: 'trick', count: 1, text: 'Land any trick shot' }],
    rewards: { money: 450, xp: 70 }, requires: ['q_rocky_arrival'], onComplete: 'q_dock_eater',
  },
  {
    id: 'q_dock_eater', name: 'Something Under the Pier', giver: 'npc', chain: 'rocky', order: 3,
    desc: 'Something keeps eating the dock. Deal with it. Bring a bigger rod.',
    objectives: [{ type: 'boss', id: 'dock-eater', text: 'Defeat the Dock Eater' }],
    rewards: { money: 2500, xp: 250, unlockRegion: 'harbor', item: 'tool_gaff' },
    requires: ['q_big_one'], boss: true,
  },

  // ---------------------------------------------------------------- harbour / company
  {
    id: 'q_harbor_arrival', name: 'Port Grimsby', giver: 'npc', chain: 'harbor', order: 0,
    desc: 'Register your company at the harbour office. It costs nothing but your dignity.',
    objectives: [{ type: 'region', id: 'harbor', text: 'Arrive at Port Grimsby' }],
    rewards: { money: 500, xp: 80, unlockFeature: 'company' }, requires: ['q_dock_eater'],
    onComplete: 'q_first_worker',
  },
  {
    id: 'q_first_worker', name: 'Your First Employee', giver: 'office', chain: 'harbor', order: 1,
    desc: 'Hire a fisherman. Watch him work. Feel something you cannot name.',
    objectives: [{ type: 'worker', count: 1, text: 'Hire a worker' }],
    rewards: { money: 300, xp: 120, unlockFeature: 'workers' }, requires: ['q_harbor_arrival'],
    onComplete: 'q_worker_catch',
  },
  {
    id: 'q_worker_catch', name: 'Delegation', giver: 'office', chain: 'harbor', order: 2,
    desc: 'Assign your worker to a fishing spot and let him catch ten fish for you.',
    objectives: [{ type: 'workerCatch', count: 10, text: 'Fish caught by workers' }],
    rewards: { money: 900, xp: 160 }, requires: ['q_first_worker'], onComplete: 'q_buy_boat',
  },
  {
    id: 'q_buy_boat', name: 'Seaworthy-ish', giver: 'shipyard', chain: 'harbor', order: 3,
    desc: 'Buy a boat. Any boat. The raft counts, technically.',
    objectives: [{ type: 'boat', count: 1, text: 'Own a boat' }],
    rewards: { money: 400, xp: 200, unlockFeature: 'boats' }, requires: ['q_harbor_arrival'],
    onComplete: 'q_first_fleet',
  },
  {
    id: 'q_first_fleet', name: 'Crew Up', giver: 'office', chain: 'harbor', order: 4,
    desc: 'Hire a captain, put a crew on a boat and send them out on a fishing trip.',
    objectives: [{ type: 'fleetTrip', count: 1, text: 'Complete an automated fishing trip' }],
    rewards: { money: 2000, xp: 350, unlockFeature: 'fleets' }, requires: ['q_buy_boat', 'q_first_worker'],
    onComplete: 'q_king_crab',
  },
  {
    id: 'q_king_crab', name: 'Crab Rangoon', giver: 'npc', chain: 'harbor', order: 5,
    desc: 'A crab the size of a car has claimed the north breakwater. Break its armour.',
    objectives: [{ type: 'boss', id: 'king-crab-boss', text: 'Defeat the King Crab' }],
    rewards: { money: 12000, xp: 600, unlockRegion: 'wilds', item: 'tool_harpoon_gun' },
    requires: ['q_first_fleet'], boss: true,
  },

  // ---------------------------------------------------------------- wilds
  {
    id: 'q_wilds_reef', name: 'Reef Madness', giver: 'shop', chain: 'wilds', order: 0,
    desc: 'The reef is full of colour and teeth. Catch eight fish there.',
    objectives: [{ type: 'catch', region: 'wilds', count: 8, text: 'Catch fish in the Tropical Wilds' }],
    rewards: { money: 4000, xp: 400 }, requires: ['q_king_crab'], onComplete: 'q_rare_three',
  },
  {
    id: 'q_rare_three', name: 'Collector', giver: 'npc', chain: 'wilds', order: 1,
    desc: 'Bring three rare-or-better fish. The buyer has a display case and no shame.',
    objectives: [{ type: 'catch', rarity: ['rare', 'epic', 'legendary', 'mythic'], count: 3, text: 'Catch rare fish' }],
    rewards: { money: 9000, xp: 500 }, requires: ['q_wilds_reef'], onComplete: 'q_hammer',
  },
  {
    id: 'q_hammer', name: 'The Hammer', giver: 'npc', chain: 'wilds', order: 2,
    desc: 'A hammerhead the size of a bus has taken a personal dislike to boats.',
    objectives: [{ type: 'boss', id: 'the-hammer', text: 'Defeat The Hammer' }],
    rewards: { money: 40000, xp: 1200, unlockRegion: 'storm' }, requires: ['q_rare_three'], boss: true,
  },

  // ---------------------------------------------------------------- storm
  {
    id: 'q_storm_catch', name: 'Bad Weather Fishing', giver: 'shop', chain: 'storm', order: 0,
    desc: 'Catch five fish during an active storm. Bring a towel.',
    objectives: [{ type: 'catch', weather: ['storm', 'heavy_storm'], count: 5, text: 'Catch fish in a storm' }],
    rewards: { money: 18000, xp: 700 }, requires: ['q_hammer'], onComplete: 'q_stormfin',
  },
  {
    id: 'q_stormfin', name: 'Stormfin', giver: 'npc', chain: 'storm', order: 1,
    desc: 'It only appears in lightning. It is far too fast. Good luck.',
    objectives: [{ type: 'boss', id: 'stormfin', text: 'Defeat Stormfin' }],
    rewards: { money: 120000, xp: 2000, unlockRegion: 'frozen' }, requires: ['q_storm_catch'], boss: true,
  },

  // ---------------------------------------------------------------- frozen
  {
    id: 'q_frozen_cod', name: 'Cold Comfort', giver: 'shop', chain: 'frozen', order: 0,
    desc: 'Catch ten fish in the Frozen Sea without becoming one.',
    objectives: [{ type: 'catch', region: 'frozen', count: 10, text: 'Catch fish in the Frozen Sea' }],
    rewards: { money: 60000, xp: 1400 }, requires: ['q_stormfin'], onComplete: 'q_frostjaw',
  },
  {
    id: 'q_frostjaw', name: 'Frostjaw', giver: 'npc', chain: 'frozen', order: 1,
    desc: 'Something has been eating the icebergs. From the inside.',
    objectives: [{ type: 'boss', id: 'frostjaw', text: 'Defeat Frostjaw' }],
    rewards: { money: 400000, xp: 4000, unlockRegion: 'station' }, requires: ['q_frozen_cod'], boss: true,
  },

  // ---------------------------------------------------------------- deep
  {
    id: 'q_deep_research', name: 'Pressure Testing', giver: 'station', chain: 'deep', order: 0,
    desc: 'Research the Deep Pressure Hull so a submarine can survive below 500 m.',
    objectives: [{ type: 'research', id: 'deep_hull', text: 'Research Deep Pressure Hull' }],
    rewards: { money: 50000, xp: 2000 }, requires: ['q_frostjaw'], onComplete: 'q_first_sub',
  },
  {
    id: 'q_first_sub', name: 'Down We Go', giver: 'station', chain: 'deep', order: 1,
    desc: 'Buy a submarine and take it below 200 m.',
    objectives: [{ type: 'depth', metres: 200, text: 'Dive to 200 m' }],
    rewards: { money: 100000, xp: 3000, unlockFeature: 'submarines' }, requires: ['q_deep_research'],
    onComplete: 'q_abyss_scan',
  },
  {
    id: 'q_abyss_scan', name: 'What Is Down There', giver: 'station', chain: 'deep', order: 2,
    desc: 'Research the Abyss Scanner, then find the trench.',
    objectives: [
      { type: 'research', id: 'abyss_scanner', text: 'Research Abyss Scanner' },
      { type: 'depth', metres: 900, text: 'Dive to 900 m' },
    ],
    rewards: { money: 500000, xp: 6000, unlockRegion: 'abyss' }, requires: ['q_first_sub'],
    onComplete: 'q_abyss_mouth',
  },
  {
    id: 'q_abyss_mouth', name: 'The Abyss Mouth', giver: 'station', chain: 'deep', order: 3,
    desc: 'The trench has a mouth. The mouth has opinions about your submarine.',
    objectives: [{ type: 'boss', id: 'abyss-mouth', text: 'Defeat the Abyss Mouth' }],
    rewards: { money: 5000000, xp: 20000, unlockFeature: 'endgame' }, requires: ['q_abyss_scan'], boss: true,
  },

  // ---------------------------------------------------------------- side quests
  {
    id: 's_junk', name: 'Beach Cleanup', giver: 'npc', chain: 'side', repeatable: true,
    desc: 'Fish three pieces of garbage out of the sea. It is honest work.',
    objectives: [{ type: 'catch', species: ['boot', 'tin-can', 'seaweed-clump'], count: 3, text: 'Fish out junk' }],
    rewards: { money: 120, xp: 30 }, requires: ['q_first_sale'],
  },
  {
    id: 's_golden', name: 'Gold Rush', giver: 'shop', chain: 'side',
    desc: 'Catch a golden variant of anything. Any species. Good luck.',
    objectives: [{ type: 'catch', variant: 'golden', count: 1, text: 'Catch a golden fish' }],
    rewards: { money: 3000, xp: 200 }, requires: ['q_five_fish'],
  },
  {
    id: 's_heavy', name: 'Heavy Lifting', giver: 'npc', chain: 'side',
    desc: 'Land a single fish over 100 kg.',
    objectives: [{ type: 'catch', minWeight: 100, count: 1, text: 'Catch a 100 kg fish' }],
    rewards: { money: 15000, xp: 600 }, requires: ['q_buy_boat'],
  },
  {
    id: 's_combo', name: 'Style Points', giver: 'npc', chain: 'side',
    desc: 'Chain five trick catches without letting the style meter run out.',
    objectives: [{ type: 'combo', count: 5, text: 'Reach a x5 style combo' }],
    rewards: { money: 8000, xp: 400 }, requires: ['q_trickshot'],
  },
  {
    id: 's_atlas25', name: 'Ichthyologist', giver: 'shop', chain: 'side',
    desc: 'Discover 25 different species.',
    objectives: [{ type: 'atlas', count: 25, text: 'Species discovered' }],
    rewards: { money: 25000, xp: 900 }, requires: ['q_harbor_arrival'],
  },
  {
    id: 's_millionaire', name: 'Fish Money', giver: 'self', chain: 'side',
    desc: 'Accumulate one million dollars.',
    objectives: [{ type: 'money', amount: 1000000, text: 'Reach $1,000,000' }],
    rewards: { money: 100000, xp: 3000 }, requires: ['q_first_fleet'],
  },
  {
    id: 's_fleet5', name: 'Armada', giver: 'office', chain: 'side',
    desc: 'Run five fleets at once.',
    objectives: [{ type: 'fleetCount', count: 5, text: 'Active fleets' }],
    rewards: { money: 250000, xp: 5000 }, requires: ['q_first_fleet'],
  },
  {
    id: 's_staff20', name: 'Payroll Problems', giver: 'office', chain: 'side',
    desc: 'Employ twenty people. Learn their names. Or do not.',
    objectives: [{ type: 'worker', count: 20, text: 'Employees' }],
    rewards: { money: 300000, xp: 6000 }, requires: ['q_worker_catch'],
  },
];

export const QUEST_BY_ID = Object.fromEntries(QUESTS.map((q) => [q.id, q]));
export const START_QUESTS = QUESTS.filter((q) => q.autoStart).map((q) => q.id);
