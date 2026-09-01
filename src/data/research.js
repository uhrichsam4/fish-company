/**
 * Research tree data.
 *
 * Nine branches, each a short chain of nodes. A node is bought once and its
 * `effects` are folded into the live aggregates on `Research` (see
 * `src/economy/Research.js`), which every other system reads cheaply.
 *
 * Node schema
 *   id         unique string (quests reference `deep_hull` and `abyss_scanner`)
 *   name/desc  UI text
 *   cost       one-off price in dollars
 *   requires   node ids that must already be unlocked
 *   reqRegion  region id that must be unlocked (null = anywhere)
 *   reqQuest   quest id that must be completed (null = none)
 *   tier       1..8, drives the cost curve and rough ordering
 *   effects    see below
 *
 * Effect keys
 *   fishingBonus {castPower, reelSpeed, maxWeight, hookChance, lineStrength,
 *                 lineLength, attract, rareBonus, autoReel}
 *                multiplicative, except `autoReel` which is additive.
 *   priceMult, wageMult, fuelMult, repairMult, catchRateMult, xpMult  multiplicative
 *   unlock       feature id string ('submarines', 'processing', 'hiring', …)
 *   sonarLevel   int 1..5   (max wins)
 *   crushDepth   metres     (max wins)
 *   storageBonus kg         (sums)
 *   workerSlots  int        (sums)
 *   boatSlots    int        (sums)
 *   processLevels int 0..3  (max wins)
 */

export const RESEARCH_BRANCHES = [
  // ------------------------------------------------------------------ fishing
  {
    id: 'fishing', icon: '🎣', name: 'Fishing',
    desc: 'Rods, lines and the fine art of not losing the fish.',
    nodes: [
      {
        id: 'braided_line', name: 'Braided Line', tier: 1, cost: 800,
        desc: 'Eight-strand braid. Snaps 25% later than the string you found on the beach.',
        requires: [], reqRegion: null, reqQuest: null,
        effects: { fishingBonus: { lineStrength: 1.25 } },
      },
      {
        id: 'better_line', name: 'Long-Spool Line', tier: 1, cost: 1400,
        desc: 'More line on the spool means deeper drops and longer runs before the fish wins.',
        requires: ['braided_line'], reqRegion: null, reqQuest: null,
        effects: { fishingBonus: { lineLength: 1.2, lineStrength: 1.15 } },
      },
      {
        id: 'auto_reel', name: 'Automatic Reel', tier: 2, cost: 4000,
        desc: 'A clutch motor that keeps tension while you panic. Reels 15% faster and takes up slack on its own.',
        requires: ['better_line'], reqRegion: 'harbor', reqQuest: null,
        effects: { fishingBonus: { reelSpeed: 1.15, autoReel: 0.35 } },
      },
      {
        id: 'carbon_rods', name: 'Carbon Composite Rods', tier: 3, cost: 22000,
        desc: 'Lighter, stiffer, throws further and will not fold on a 40 kg fish.',
        requires: ['auto_reel'], reqRegion: 'harbor', reqQuest: null,
        effects: { fishingBonus: { castPower: 1.2, maxWeight: 1.3 } },
      },
      {
        id: 'live_bait_science', name: 'Live Bait Science', tier: 3, cost: 34000,
        desc: 'A laboratory dedicated to smells fish cannot ignore. Bait works harder.',
        requires: ['auto_reel'], reqRegion: 'harbor', reqQuest: null,
        effects: { fishingBonus: { attract: 1.25, hookChance: 1.12 } },
      },
      {
        id: 'deep_drop_rigs', name: 'Deep Drop Rigs', tier: 4, cost: 110000,
        desc: 'Weighted multi-hook rigs for the shelf edge. Far more line, far heavier fish.',
        requires: ['carbon_rods'], reqRegion: 'storm', reqQuest: null,
        effects: { fishingBonus: { maxWeight: 1.5, lineLength: 1.45 } },
      },
      {
        id: 'titan_tackle', name: 'Titan Tackle', tier: 6, cost: 1200000,
        desc: 'Rated for things that should be measured in tonnes. Doubles what you can land.',
        requires: ['deep_drop_rigs'], reqRegion: 'frozen', reqQuest: null,
        effects: { fishingBonus: { maxWeight: 2.0, lineStrength: 1.8, castPower: 1.25 } },
      },
    ],
  },

  // ------------------------------------------------------------------ weapons
  {
    id: 'weapons', icon: '🔱', name: 'Weapons',
    desc: 'Harpoons, spearguns and other conversation enders.',
    nodes: [
      {
        id: 'sharpened_tips', name: 'Sharpened Tips', tier: 1, cost: 1200,
        desc: 'A whetstone and an afternoon. Everything you throw bites 8% better.',
        requires: [], reqRegion: null, reqQuest: null,
        effects: { catchRateMult: 1.08 },
      },
      {
        id: 'spear_ballistics', name: 'Spear Ballistics', tier: 2, cost: 6500,
        desc: 'Someone finally worked out the drag coefficient of a harpoon underwater.',
        requires: ['sharpened_tips'], reqRegion: 'harbor', reqQuest: null,
        effects: { catchRateMult: 1.12, xpMult: 1.05 },
      },
      {
        id: 'pneumatic_launcher', name: 'Pneumatic Launcher', tier: 3, cost: 28000,
        desc: 'Compressed air instead of rubber. Flat trajectory, unpleasant noise.',
        requires: ['spear_ballistics'], reqRegion: 'harbor', reqQuest: null,
        effects: { catchRateMult: 1.18 },
      },
      {
        id: 'explosive_tips', name: 'Explosive Tips', tier: 4, cost: 140000,
        desc: 'Legally a grey area. Practically, a 25% better day at sea.',
        requires: ['pneumatic_launcher'], reqRegion: 'storm', reqQuest: null,
        effects: { catchRateMult: 1.25 },
      },
      {
        id: 'experimental_harpoon', name: 'Experimental Harpoon', tier: 6, cost: 1600000,
        desc: 'A prototype that arrives in a crate marked DO NOT AIM AT THE BOAT.',
        requires: ['explosive_tips'], reqRegion: 'frozen', reqQuest: null,
        effects: { catchRateMult: 1.4, unlock: 'experimental_weapons' },
      },
      {
        id: 'void_lance', name: 'Void Lance', tier: 8, cost: 7500000,
        desc: 'It punctures things that do not have a front. Buyers pay a premium for the trophies.',
        requires: ['experimental_harpoon'], reqRegion: 'abyss', reqQuest: null,
        effects: { catchRateMult: 1.75, priceMult: 1.05 },
      },
    ],
  },

  // -------------------------------------------------------------------- boats
  {
    id: 'boats', icon: '🚤', name: 'Boats',
    desc: 'Hulls, engines and fuel bills you stop having to think about.',
    nodes: [
      {
        id: 'hull_patching', name: 'Hull Patching', tier: 1, cost: 1000,
        desc: 'Marine epoxy and a good sander. Repairs cost 15% less.',
        requires: [], reqRegion: null, reqQuest: null,
        effects: { repairMult: 0.85 },
      },
      {
        id: 'marine_diesel', name: 'Marine Diesel Tuning', tier: 2, cost: 5500,
        desc: 'Rebuilt injectors and a sensible propeller pitch. 15% less fuel burnt.',
        requires: ['hull_patching'], reqRegion: 'harbor', reqQuest: null,
        effects: { fuelMult: 0.85 },
      },
      {
        id: 'second_slip', name: 'Second Slip', tier: 2, cost: 9000,
        desc: 'Dredge and licence one more mooring. Room for another boat.',
        requires: ['hull_patching'], reqRegion: 'harbor', reqQuest: null,
        effects: { boatSlots: 1 },
      },
      {
        id: 'reinforced_hulls', name: 'Reinforced Hulls', tier: 3, cost: 30000,
        desc: 'Double-plated bows. Rocks stop being an emergency and start being a noise.',
        requires: ['marine_diesel'], reqRegion: 'harbor', reqQuest: null,
        effects: { repairMult: 0.7 },
      },
      {
        id: 'commercial_fleet', name: 'Commercial Fleet Licence', tier: 4, cost: 130000,
        desc: 'The paperwork that turns three boats into a fleet, legally speaking.',
        requires: ['second_slip'], reqRegion: 'harbor', reqQuest: null,
        effects: { boatSlots: 2, unlock: 'fleets' },
      },
      {
        id: 'fleet_logistics', name: 'Fleet Logistics', tier: 5, cost: 420000,
        desc: 'Routing, bunkering and cargo planning done centrally. Three more berths, 25% less fuel.',
        requires: ['commercial_fleet'], reqRegion: 'wilds', reqQuest: null,
        effects: { boatSlots: 3, fuelMult: 0.75, unlock: 'fleet_logistics' },
      },
    ],
  },

  // --------------------------------------------------------------------- crew
  {
    id: 'crew', icon: '👷', name: 'Crew',
    desc: 'Hire better people, then stop them from walking out.',
    nodes: [
      {
        id: 'job_postings', name: 'Job Postings', tier: 1, cost: 900,
        desc: 'A card in the harbour window. Somebody always answers.',
        requires: [], reqRegion: null, reqQuest: null,
        effects: { workerSlots: 1, unlock: 'hiring' },
      },
      {
        id: 'payroll_software', name: 'Payroll Software', tier: 2, cost: 5000,
        desc: 'Fewer accounting errors, fewer arguments. Wages cost 8% less.',
        requires: ['job_postings'], reqRegion: 'harbor', reqQuest: null,
        effects: { wageMult: 0.92 },
      },
      {
        id: 'crew_training', name: 'Crew Training Programme', tier: 3, cost: 24000,
        desc: 'Knots, engines, first aid. Everyone levels 20% faster and you can hire two more.',
        requires: ['job_postings'], reqRegion: 'harbor', reqQuest: null,
        effects: { xpMult: 1.2, workerSlots: 2 },
      },
      {
        id: 'union_contracts', name: 'Union Contracts', tier: 4, cost: 95000,
        desc: 'Fixed terms both sides can live with. Cheaper wages, bigger payroll.',
        requires: ['payroll_software'], reqRegion: 'harbor', reqQuest: null,
        effects: { wageMult: 0.85, workerSlots: 3 },
      },
      {
        id: 'veteran_captains', name: 'Veteran Captains', tier: 5, cost: 380000,
        desc: 'People who have already made every mistake. Crews catch 15% more.',
        requires: ['crew_training'], reqRegion: 'wilds', reqQuest: null,
        effects: { catchRateMult: 1.15, workerSlots: 3 },
      },
      {
        id: 'corporate_academy', name: 'Corporate Academy', tier: 6, cost: 1100000,
        desc: 'Your own training school on the quay. Five more berths on the payroll.',
        requires: ['union_contracts', 'veteran_captains'], reqRegion: 'storm', reqQuest: null,
        effects: { xpMult: 1.5, workerSlots: 5, wageMult: 0.8 },
      },
    ],
  },

  // --------------------------------------------------------------- automation
  {
    id: 'automation', icon: '⚙️', name: 'Automation',
    desc: 'Machines that fish while you sleep.',
    nodes: [
      {
        id: 'conveyor_hoppers', name: 'Conveyor Hoppers', tier: 2, cost: 6000,
        desc: 'Fish go in one end and end up in the hold. Adds 25 kg of storage.',
        requires: [], reqRegion: 'harbor', reqQuest: null,
        effects: { storageBonus: 25 },
      },
      {
        id: 'autopilot', name: 'Autopilot', tier: 3, cost: 36000,
        desc: 'Waypoint navigation with collision avoidance. Boats hold a course and sip fuel.',
        requires: ['conveyor_hoppers'], reqRegion: 'harbor', reqQuest: null,
        effects: { unlock: 'autopilot', fuelMult: 0.9 },
      },
      {
        id: 'auto_baiter', name: 'Automatic Baiter', tier: 4, cost: 120000,
        desc: 'Rebaits a thousand hooks an hour without complaining once.',
        requires: ['autopilot'], reqRegion: 'harbor', reqQuest: null,
        effects: { fishingBonus: { attract: 1.15 }, catchRateMult: 1.1 },
      },
      {
        id: 'drone_tenders', name: 'Drone Tenders', tier: 5, cost: 460000,
        desc: 'Unmanned tenders that run catch back to the quay and never sleep.',
        requires: ['autopilot'], reqRegion: 'wilds', reqQuest: null,
        effects: { catchRateMult: 1.2, storageBonus: 60 },
      },
      {
        id: 'remote_operations', name: 'Remote Operations Centre', tier: 6, cost: 1400000,
        desc: 'One room, every hull. Fewer hands needed at sea, more fish landed.',
        requires: ['drone_tenders'], reqRegion: 'frozen', reqQuest: null,
        effects: { catchRateMult: 1.3, wageMult: 0.9, unlock: 'remote_ops' },
      },
      {
        id: 'machine_learning_shoals', name: 'Shoal Prediction Models', tier: 7, cost: 3200000,
        desc: 'Twenty years of sonar logs, one very expensive model. It knows where they will be.',
        requires: ['remote_operations', 'advanced_sonar'], reqRegion: 'station', reqQuest: null,
        effects: { catchRateMult: 1.45, fishingBonus: { rareBonus: 1.25 } },
      },
    ],
  },

  // -------------------------------------------------------------------- sonar
  {
    id: 'sonar', icon: '📡', name: 'Sonar',
    desc: 'See the fish before they see you.',
    nodes: [
      {
        id: 'fish_finder', name: 'Fish Finder', tier: 1, cost: 1500,
        desc: 'A cheap transducer and a green screen. Better than guessing.',
        requires: [], reqRegion: null, reqQuest: null,
        effects: { sonarLevel: 1 },
      },
      {
        id: 'depth_sounder', name: 'Depth Sounder', tier: 2, cost: 7000,
        desc: 'Know the bottom before you find it with the hull. Safe to 40 m.',
        requires: ['fish_finder'], reqRegion: 'harbor', reqQuest: null,
        effects: { crushDepth: 40, sonarLevel: 1 },
      },
      {
        id: 'advanced_sonar', name: 'Advanced Sonar Array', tier: 3, cost: 26000,
        desc: 'Multibeam imaging that paints shoals in colour. Fish come to the boat.',
        requires: ['fish_finder'], reqRegion: 'harbor', reqQuest: null,
        effects: { sonarLevel: 2, fishingBonus: { attract: 1.1 } },
      },
      {
        id: 'rare_scanner', name: 'Rare Species Scanner', tier: 4, cost: 150000,
        desc: 'Tags the unusual returns. Rare fish turn up 35% more often.',
        requires: ['advanced_sonar'], reqRegion: 'wilds', reqQuest: null,
        effects: { sonarLevel: 3, fishingBonus: { rareBonus: 1.35 } },
      },
      {
        id: 'thermal_imaging', name: 'Thermal Imaging', tier: 5, cost: 500000,
        desc: 'Reads thermoclines and the warm bodies sitting under them.',
        requires: ['rare_scanner'], reqRegion: 'storm', reqQuest: null,
        effects: { sonarLevel: 4, catchRateMult: 1.15 },
      },
      {
        id: 'quantum_echo', name: 'Quantum Echo Sounder', tier: 7, cost: 2800000,
        desc: 'Nobody at the company can explain how it works. It maps the whole trench.',
        requires: ['thermal_imaging'], reqRegion: 'station', reqQuest: null,
        effects: { sonarLevel: 5, fishingBonus: { rareBonus: 1.6 }, unlock: 'quantum_sonar' },
      },
    ],
  },

  // --------------------------------------------------------------- processing
  {
    id: 'processing', icon: '🏭', name: 'Processing',
    desc: 'Turn a dead fish into a product with a barcode.',
    nodes: [
      {
        id: 'gutting_line', name: 'Gutting Line', tier: 2, cost: 4500,
        desc: 'Cleaned fish keep longer and sell for 30% more. Opens the processing floor.',
        requires: [], reqRegion: 'harbor', reqQuest: null,
        effects: { processLevels: 1, unlock: 'processing' },
      },
      {
        id: 'filleting_machines', name: 'Filleting Machines', tier: 3, cost: 27000,
        desc: 'Bone-out fillets at eighty a minute. Second processing tier.',
        requires: ['gutting_line'], reqRegion: 'harbor', reqQuest: null,
        effects: { processLevels: 2, priceMult: 1.05 },
      },
      {
        id: 'blast_freezer', name: 'Blast Freezer', tier: 3, cost: 45000,
        desc: 'Minus forty in nine minutes. Freshness stops being a countdown.',
        requires: ['gutting_line'], reqRegion: 'harbor', reqQuest: null,
        effects: { unlock: 'freezer', storageBonus: 40 },
      },
      {
        id: 'vacuum_packing', name: 'Vacuum Packing', tier: 4, cost: 160000,
        desc: 'Premium packed product with a shelf life and a logo. Third processing tier.',
        requires: ['filleting_machines'], reqRegion: 'harbor', reqQuest: null,
        effects: { processLevels: 3, priceMult: 1.08 },
      },
      {
        id: 'automated_processing', name: 'Automated Processing', tier: 5, cost: 520000,
        desc: 'The whole line runs itself. Fish move through the queue twice as fast.',
        requires: ['vacuum_packing', 'autopilot'], reqRegion: 'harbor', reqQuest: null,
        effects: { processLevels: 3, priceMult: 1.12, wageMult: 0.95, unlock: 'automated_processing' },
      },
      {
        id: 'luxury_brand', name: 'Luxury Brand', tier: 7, cost: 2600000,
        desc: 'Same fish, embossed box, restaurants three continents away. +30% on everything.',
        requires: ['automated_processing'], reqRegion: 'storm', reqQuest: null,
        effects: { priceMult: 1.3 },
      },
    ],
  },

  // --------------------------------------------------------------- submarines
  {
    id: 'submarines', icon: '🤿', name: 'Submarines',
    desc: 'Going down where the rod cannot follow.',
    nodes: [
      {
        id: 'pressure_math', name: 'Pressure Mathematics', tier: 3, cost: 32000,
        desc: 'Work out what the sea does to a steel box at 120 m. Then survive it.',
        requires: [], reqRegion: 'harbor', reqQuest: null,
        effects: { crushDepth: 120 },
      },
      {
        id: 'deep_hull', name: 'Deep Pressure Hull', tier: 4, cost: 180000,
        desc: 'A ring-stiffened hull rated to 400 m. Submarines become buildable.',
        requires: ['pressure_math'], reqRegion: 'harbor', reqQuest: null,
        effects: { crushDepth: 400, unlock: 'submarines' },
      },
      {
        id: 'sub_bay', name: 'Submarine Bay Systems', tier: 5, cost: 600000,
        desc: 'Cradles, lifts and a charging loop. One more berth and 600 m of hull rating.',
        requires: ['deep_hull'], reqRegion: 'harbor', reqQuest: null,
        effects: { boatSlots: 1, crushDepth: 600 },
      },
      {
        id: 'titanium_sphere', name: 'Titanium Crew Sphere', tier: 6, cost: 1500000,
        desc: 'A single forged sphere. Expensive, spherical, rated to 1800 m.',
        requires: ['deep_hull'], reqRegion: 'station', reqQuest: null,
        effects: { crushDepth: 1800 },
      },
      {
        id: 'life_support_ii', name: 'Life Support II', tier: 6, cost: 1900000,
        desc: 'Scrubbers, redundancy and cold storage for a long, quiet dive.',
        requires: ['titanium_sphere'], reqRegion: 'station', reqQuest: null,
        effects: { crushDepth: 2600, storageBonus: 80 },
      },
      {
        id: 'abyssal_drive', name: 'Abyssal Drive', tier: 7, cost: 3800000,
        desc: 'Magnetohydrodynamic thrust. Silent, efficient, rated past four kilometres.',
        requires: ['life_support_ii'], reqRegion: 'station', reqQuest: null,
        effects: { crushDepth: 4200, fuelMult: 0.8 },
      },
    ],
  },

  // -------------------------------------------------------------------- abyss
  {
    id: 'abyss', icon: '🌑', name: 'Abyss',
    desc: 'The trench does not want you there. Go anyway.',
    nodes: [
      {
        id: 'abyss_scanner', name: 'Abyss Scanner', tier: 7, cost: 3400000,
        desc: 'Finds the trench mouth and everything sitting in it. Charts the hadal zone.',
        requires: ['deep_hull'], reqRegion: 'station', reqQuest: null,
        effects: { sonarLevel: 4, crushDepth: 3000, unlock: 'abyss_charts' },
      },
      {
        id: 'hadal_alloys', name: 'Hadal Alloys', tier: 8, cost: 6000000,
        desc: 'Metallurgy from the wrong century. Seven kilometres of rating, 40% cheaper repairs.',
        requires: ['abyss_scanner'], reqRegion: 'abyss', reqQuest: null,
        effects: { crushDepth: 7000, repairMult: 0.6 },
      },
      {
        id: 'bioluminescent_lures', name: 'Bioluminescent Lures', tier: 8, cost: 6500000,
        desc: 'Grown, not manufactured. Things in the dark cannot leave them alone.',
        requires: ['abyss_scanner'], reqRegion: 'abyss', reqQuest: null,
        effects: { fishingBonus: { rareBonus: 1.8, attract: 1.3 } },
      },
      {
        id: 'void_refrigeration', name: 'Void Refrigeration', tier: 8, cost: 7000000,
        desc: 'Holds at hadal temperature and pressure. 250 kg more hold, 15% better prices.',
        requires: ['hadal_alloys'], reqRegion: 'abyss', reqQuest: null,
        effects: { storageBonus: 250, priceMult: 1.15 },
      },
      {
        id: 'leviathan_tackle', name: 'Leviathan Tackle', tier: 8, cost: 7800000,
        desc: 'Cable, not line. Triples what you can bring up and rated for a leviathan.',
        requires: ['hadal_alloys'], reqRegion: 'abyss', reqQuest: null,
        effects: { fishingBonus: { maxWeight: 3.0, lineStrength: 2.5 } },
      },
      {
        id: 'abyssal_monopoly', name: 'Abyssal Monopoly', tier: 8, cost: 8000000,
        desc: 'You are the only supplier of things nobody else can reach. Set your own price.',
        requires: ['void_refrigeration', 'leviathan_tackle', 'bioluminescent_lures'],
        reqRegion: 'abyss', reqQuest: null,
        effects: { priceMult: 1.4, catchRateMult: 1.5, xpMult: 2.0 },
      },
    ],
  },
];

/** Flat list of every node, with `branchId` folded in. */
export const RESEARCH_NODES = RESEARCH_BRANCHES.flatMap(
  (b) => b.nodes.map((n) => ({ ...n, branchId: b.id })),
);

/** id -> node lookup. */
export const RESEARCH_BY_ID = Object.freeze(
  Object.fromEntries(RESEARCH_NODES.map((n) => [n.id, n])),
);

export const RESEARCH_TOTAL = RESEARCH_NODES.length;

export function getResearchNode(id) { return RESEARCH_BY_ID[id] || null; }
