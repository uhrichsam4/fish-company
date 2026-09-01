/**
 * NPCS — the twelve people who live in this ocean.
 *
 * Placement is expressed against the anchors World already computes for every
 * region (`world.getAnchors(id)`), so nobody is hard-coded to a coordinate and
 * everyone still stands somewhere sensible when the terrain reshuffles.
 *
 * Dialogue is state-driven, not scripted: `npcState()` looks at the live game
 * (quests, money, boats, fleets, weather, active world events) and picks the
 * bucket, then `npcLine()` picks a line from it. Gossip lines are predicates
 * over the real simulation — the harbour master genuinely counts your boats.
 *
 * Data only. No THREE, no EventBus.
 */

import { REGION_BY_ID } from './regions.js';
import { QUEST_BY_ID } from './quests.js';
import { formatMoneyExact } from '../util/math.js';

/**
 * @typedef {object} NpcDef
 * @property {string} id
 * @property {string} name       display name
 * @property {string} title      shown under the name
 * @property {string} region     region id they live in
 * @property {string} emoji      portrait glyph
 * @property {number} accent     portrait/label colour
 * @property {number} seed       WorkerMesh seed — fixes their whole look
 * @property {string|null} prop  buildWorkerTool() kind
 * @property {object} at         {anchor, fwd, side, face} placement
 * @property {string} role       merchant|quest|harbourmaster|chief|gambler|flavour
 * @property {boolean} [shop]    E opens the shop from the conversation
 * @property {boolean} [gamble]  E opens the gambling table
 * @property {string[]} [quests] quest ids this character hands out / tracks
 */

/** @type {NpcDef[]} */
export const NPCS = [

  // ------------------------------------------------------------ Crash Island
  {
    id: 'pete', name: 'Salt Pete', title: 'Beach Merchant', region: 'crash',
    emoji: '🧔', accent: 0xffc22e, seed: 118820117, prop: 'crate',
    at: { anchor: 'shop', fwd: 3.1, side: -1.4, face: 'dock' },
    role: 'merchant', shop: true, quests: ['s_golden'],
    lines: {
      first: [
        'You are the one off the boat. The three-pieces-of-boat. I watched the whole thing from up here with a drink.',
        'Welcome to Crash Island. Population: me, you, and a rat I have named after my brother.',
      ],
      default: [
        'Everything is for sale. Everything has always been for sale.',
        'You look like a man who needs a rod that is not a stick.',
        'I do not take credit, barter, promises, or eye contact.',
      ],
      questAvailable: [
        'Here is a thing worth doing, if you like doing things.',
      ],
      questActive: [
        'Still working on it? No rush. The ocean is not going anywhere. Probably.',
      ],
      questDone: [
        'Done it, did you. Good. Now buy something.',
      ],
    },
    gossip: [
      { when: (c) => c.eco && c.eco.money < 50, text: 'You have {money}. I have seen wetter wallets on a drowned man.' },
      { when: (c) => c.eco && c.eco.money > 50000, text: 'You have {money}. Funny how quickly a shipwreck becomes a career.' },
      { when: (c) => c.events?.isActive?.('market_boom'), text: 'Prices are up everywhere. Sell now, thank me never.' },
      { when: (c) => c.events?.isActive?.('market_crash'), text: 'Market has fallen through the floor. I am not buying. I am barely breathing.' },
      { when: (c) => c.inv && c.inv.fish.length > 8, text: 'That is {fishCount} fish you are carrying about. You do know the bin pays, yes?' },
    ],
    ambient: [
      'Fresh stock. Same stock. Fresh label.',
      'Buy something.',
      'This is a shop, not a bench.',
    ],
  },

  {
    id: 'marla', name: 'Marla Vex', title: 'Castaway, Fourth Year', region: 'crash',
    emoji: '👩‍🦰', accent: 0x5ddb6a, seed: 771204431, prop: 'clipboard',
    at: { anchor: 'campfire', fwd: 1.4, side: 1.6, face: 'campfire' },
    role: 'quest', quests: ['s_junk'],
    lines: {
      first: [
        'Do not sit on that log. That is not a log. That is Gerald.',
        'Another one washes up. The island collects us. I am not being poetic, I have a chart.',
      ],
      default: [
        'I have been here four years. Or one very slow year. The tides are unreliable narrators.',
        'I do not need rescuing. I need someone to confirm the number of moons.',
        'If you catch a boot, keep it. Boots are the ocean writing to us.',
      ],
      questAvailable: [
        'The tide keeps bringing back the same rubbish. I think it is trying to tell me something. Help me read it.',
      ],
      questActive: [
        'Three pieces. That is the ritual. Two is an accident and four is showing off.',
      ],
      questDone: [
        'The beach is clean and I feel strange about it.',
      ],
    },
    gossip: [
      { when: (c) => c.weather?.current?.id === 'storm' || c.weather?.current?.id === 'heavy_storm', text: 'The storm is early this year. Or late. Or the same storm, still going.' },
      { when: (c) => c.events?.isActive?.('golden_migration'), text: 'The gold ones came through last night. They only come when something is about to be decided.' },
      { when: (c) => c.quests && c.quests.completed.size >= 6, text: 'You have been busy. Busy is how they get you.' },
      { when: (c) => c.eco?.stats?.totalCaught > 40, text: '{caught} fish. You are keeping count and so is the sea.' },
    ],
    ambient: [
      'Gerald says hello.',
      'Day one thousand four hundred and something.',
      'That gull owes me money.',
    ],
  },

  // -------------------------------------------------------------- Rocky Isle
  {
    id: 'gil', name: 'Gil Hask', title: 'Chandler', region: 'rocky',
    emoji: '🧓', accent: 0xffc22e, seed: 330991552, prop: 'crate',
    at: { anchor: 'shop', fwd: 3.0, side: 1.5, face: 'dock' },
    role: 'merchant', shop: true, quests: ['s_heavy'],
    lines: {
      first: [
        'You made it across. Most do not bother. Rocky prices are Rocky prices for a reason.',
      ],
      default: [
        'Rod, line, reel. Bait if you insist. I do not sell hope.',
        'Everything on Rocky costs more because everything on Rocky is heavier.',
      ],
      questAvailable: ['You want a real job? Bring me something that breaks a scale.'],
      questActive: ['A hundred kilos. Not ninety-nine. I own a scale and a grudge.'],
      questDone: ['That thing nearly took the pier with it. Well done.'],
    },
    gossip: [
      { when: (c) => c.boats && c.boats.owned.length > 0, text: 'Nice hull. Keep it off my rocks and we will stay friends.' },
      { when: (c) => c.events?.isActive?.('species_demand'), text: 'There is a buyer on the docks paying stupid money for one species. Word travels.' },
      { when: (c) => c.eco && c.eco.money > 5000, text: '{money}. You can afford the good line now. I checked.' },
    ],
    ambient: ['Mind the rocks.', 'Prices are on the board.', 'No, I will not go lower.'],
  },

  {
    id: 'ada', name: 'Ada Grim', title: 'Pier Watch', region: 'rocky',
    emoji: '🧝‍♀️', accent: 0xff5470, seed: 90210771, prop: 'harpoon',
    at: { anchor: 'dockEnd', fwd: -2.4, side: 1.1, face: 'sea' },
    role: 'quest', quests: ['q_dock_eater', 's_combo'],
    lines: {
      first: [
        'Stay behind the second plank. Everything past the second plank belongs to it.',
      ],
      default: [
        'I have stood on this pier for eleven years and it has eaten three of them.',
        'When the water goes flat and quiet, that is not calm. That is attention.',
      ],
      questAvailable: [
        'There is something under this pier. It has taken two dogs and a harbourmaster. Kill it.',
      ],
      questActive: [
        'It comes up when the tide turns. Do not fight it from the planks — it eats the planks.',
      ],
      questDone: [
        'The pier is quiet. I do not know what to do with my hands.',
      ],
    },
    gossip: [
      { when: (c) => c.events?.isActive?.('boss_sighting'), text: 'Something big is circling right now. I can feel it through the boards.' },
      { when: (c) => c.eco?.stats?.bossesKilled?.length > 0, text: 'You have put down {bosses} of them. That is either courage or a diagnosis.' },
      { when: (c) => c.weather && c.weather.intensity > 0.5, text: 'Rough water. It hunts in rough water. So do I.' },
    ],
    ambient: ['Behind the second plank.', 'It is down there.', 'Quiet. Listen.'],
  },

  // ------------------------------------------------------------ Port Grimsby
  {
    id: 'mccrae', name: 'Harbourmaster McCrae', title: 'Port Grimsby Authority', region: 'harbor',
    emoji: '👮', accent: 0x43a9ff, seed: 551200983, prop: 'clipboard',
    at: { anchor: 'dockStart', fwd: 1.8, side: -2.0, face: 'dock' },
    role: 'harbourmaster', quests: ['q_buy_boat', 's_fleet5'],
    lines: {
      first: [
        'New registration. Name, tonnage, and whether you intend to sink in my harbour.',
      ],
      default: [
        'Berth fees are theoretical. Enforcement is not.',
        'Everything that floats in this harbour is my problem eventually.',
      ],
      questAvailable: ['You cannot run a company off a dock and a bad attitude. Get a hull under you.'],
      questActive: ['Paperwork is filed. Now go and buy the boat, before I file more of it.'],
      questDone: ['Registered, berthed and legal. Do not make me regret the stamp.'],
    },
    gossip: [
      { when: (c) => c.boats && c.boats.owned.length === 0, text: 'You own no boats. In a harbour. Extraordinary.' },
      { when: (c) => c.boats && c.boats.owned.length === 1, text: 'One hull registered to you. A fleet of one is called a boat, by the way.' },
      { when: (c) => c.boats && c.boats.owned.length >= 2, text: '{boats} hulls under your name. That is a fleet. Fleets attract inspectors.' },
      { when: (c) => c.boats?.owned?.some((b) => b.health < 55), text: 'One of yours is limping — hull under 55%. Repair it before it becomes a wreck report.' },
      { when: (c) => c.fleets && c.fleets.fleets.length > 0, text: '{fleetsOut} of your {fleets} crews are out on the water. I log every one.' },
      { when: (c) => c.workers && c.workers.workers.length >= 3, text: 'You employ {staff} people now. That is {staff} more than most who come through here.' },
      { when: (c) => c.events?.isActive?.('storm_front'), text: 'Front coming through. I would keep the small hulls tied up if they were mine.' },
    ],
    ambient: ['Move that crate.', 'Berth eleven, again.', 'Log it or lose it.'],
  },

  {
    id: 'vance', name: 'Vance Odell', title: 'Grimsby Outfitters', region: 'harbor',
    emoji: '🕴', accent: 0xffc22e, seed: 220118844, prop: 'crate',
    at: { anchor: 'shop', fwd: 3.2, side: -1.6, face: 'dock' },
    role: 'merchant', shop: true, quests: ['s_atlas25'],
    lines: {
      first: ['Industrial grade, industrial prices. You will need both.'],
      default: [
        'Harpoon guns, deck launchers, coolers the size of a car. All legal. Most legal.',
        'I supply half this port and the other half owes me.',
      ],
      questAvailable: ['Collectors pay for knowledge. Fill out that atlas and I will fill out a cheque.'],
      questActive: ['Twenty-five species. Junk does not count. I checked, and then I checked again.'],
      questDone: ['A proper catalogue. You are a scientist with a hook.'],
    },
    gossip: [
      { when: (c) => c.eco && c.eco.money > 250000, text: '{money}. You are officially the sort of client I lie about knowing.' },
      { when: (c) => c.events?.isActive?.('market_crash'), text: 'Market is in the floor. Everyone is selling. That is precisely when I buy.' },
      { when: (c) => c.inv && c.inv.usedWeight > c.inv.capacity * 0.85, text: 'Your storage is nearly full. Bigger cooler. Right there. Obviously.' },
    ],
    ambient: ['Trade in, trade up.', 'Everything is negotiable except the price.'],
  },

  {
    id: 'dice', name: 'Doubloon Dee', title: 'Fish Roulette', region: 'harbor',
    emoji: '🎲', accent: 0xb96bff, seed: 660044231, prop: null,
    at: { anchor: 'dock', fwd: 2.0, side: -2.6, face: 'shore' },
    role: 'gambler', gamble: true,
    lines: {
      first: [
        'Table is open. Odds are painted on the wheel, house edge is painted next to them, and I have never once painted a lie.',
      ],
      default: [
        'Five games. All of them beatable. None of them fair — I told you the edge, that is the deal.',
        'Fish money only. I do not want your house, your boat, or your feelings.',
        'There is a daily loss cap. When you hit it I close the table and buy you a drink.',
      ],
    },
    gossip: [
      { when: (c) => (c.eco?.stats?.gambling?.plays || 0) > 12, text: 'You have played {plays} times. Lifetime return: {rtp}. The maths does not blink.' },
      { when: (c) => c.gambling?.lostToday > 0, text: 'You are down {lostToday} today. Cap is {cap}. I will tell you when to stop.' },
      { when: (c) => c.inv && c.inv.fish.length > 0, text: 'You are carrying fish. There is a game for that, and it is the cruel one.' },
    ],
    ambient: ['Place your bets.', 'Wheel is loaded. Honestly loaded.', 'Six fish, one winner.'],
  },

  {
    id: 'tuck', name: 'Tuck', title: 'Has a Net', region: 'harbor',
    emoji: '🧒', accent: 0x5ddb6a, seed: 992817263, prop: 'rod',
    at: { anchor: 'dock', fwd: 0, side: 2.4, face: 'sea' },
    role: 'flavour',
    lines: {
      first: ['I caught a crab once. It was THIS big. It was not this big.'],
      default: [
        'My net has a hole in it but only on the bottom, which is the important bit apparently.',
        'Are you the one with the boat? Can I come on the boat? I will be quiet. I will not be quiet.',
        'Dad says the deep station is full of scientists. I think it is full of something else.',
      ],
    },
    gossip: [
      { when: (c) => c.boats && c.boats.owned.length > 0, text: 'You have {boats} boats! I only have a net and a bucket and the bucket leaks.' },
      { when: (c) => c.eco?.stats?.biggestFish, text: 'Is it true you caught a {biggest}? Was it bigger than a dog?' },
      { when: (c) => c.events?.isActive?.('tuna_school'), text: 'THE TUNA ARE IN. Everyone is going out. Take me. Do not take me. Take me.' },
    ],
    ambient: ['Got one! ...no.', 'This bucket leaks.', 'Are you going out?'],
  },

  // ---------------------------------------------------------- Tropical Wilds
  {
    id: 'koa', name: 'Koa Mailani', title: 'Reef Trader', region: 'wilds',
    emoji: '🧑‍🌾', accent: 0x2fd4c4, seed: 448120075, prop: 'knife',
    at: { anchor: 'shop', fwd: 2.9, side: 1.3, face: 'dock' },
    role: 'merchant', shop: true, quests: ['q_rare_three', 'q_hammer'],
    lines: {
      first: [
        'Careful where you put your feet. Half of this reef is alive and the other half is offended.',
      ],
      default: [
        'The reef gives, the reef takes, and the reef keeps a running total.',
        'Everything colourful out there is either delicious or lethal. Sometimes on the same fish.',
      ],
      questAvailable: ['You want the good stuff? Bring me rare fish. Three of them. I will know if you cheat.'],
      questActive: ['Rare means rare. Blue label and up. Not a big common one.'],
      questDone: ['Three rares. The reef likes you, which is worrying.'],
    },
    gossip: [
      { when: (c) => c.events?.isActive?.('golden_migration'), text: 'The gold run is on. Everything is rolling strange colours out there right now.' },
      { when: (c) => c.eco?.stats?.byRarity?.legendary > 0, text: 'You have landed a legendary. That is not luck any more, that is a habit.' },
      { when: (c) => c.weather?.current?.id === 'sunny', text: 'Flat and bright. The big ones go deep in this. Go deeper.' },
    ],
    ambient: ['Mind the coral.', 'That one stings.', 'Fresh off the reef.'],
  },

  // ------------------------------------------------------------- Storm Shelf
  {
    id: 'sparks', name: 'Sparks Mulvaney', title: 'Lighthouse Keeper (Retired, Allegedly)', region: 'storm',
    emoji: '🧙', accent: 0xffa23a, seed: 137755902, prop: 'crate',
    at: { anchor: 'campfire', fwd: 1.2, side: -1.5, face: 'campfire' },
    role: 'flavour', quests: ['q_stormfin'],
    lines: {
      first: [
        'Ha! A visitor. Sit down, do not sit down, sit down. It has been raining here since nineteen — since a while.',
      ],
      default: [
        'The lightning and I have an understanding. It hits the tower, I do not go up the tower.',
        'I have been struck four times. Or once, four times slowly. Hard to say.',
        'Drink? No? More for the — well. More for the fire.',
      ],
      questAvailable: ['There is a fish out there made of the same stuff as the sky. Go and have a word with it.'],
      questActive: ['Stormfin. Rides the front. If the hair on your arms stands up, that is not romance.'],
      questDone: ['You killed the weather. Sort of. I am going to need a new hobby.'],
    },
    gossip: [
      { when: (c) => c.events?.isActive?.('storm_front'), text: 'THERE it is. Front is in. Everything with teeth comes up in this.' },
      { when: (c) => c.eco && c.eco.money < 200, text: 'You are skint. Skint is fine. Skint and wet is a lifestyle.' },
      { when: (c) => c.player && c.player.position.y > 20, text: 'You have been up high. Do not go up the tower. I mean it about the tower.' },
    ],
    ambient: ['Weather!', 'Not up the tower.', 'Ha!'],
  },

  // ------------------------------------------------------------- Frozen Sea
  {
    id: 'brin', name: 'Brin Kolm', title: 'Ice Station Trader', region: 'frozen',
    emoji: '🧑‍🚀', accent: 0x9fe8ff, seed: 774411238, prop: 'wrench',
    at: { anchor: 'shop', fwd: 3.0, side: -1.2, face: 'dock' },
    role: 'merchant', shop: true, quests: ['q_frostjaw'],
    lines: {
      first: ['Close the door. There is no door. Close it anyway.'],
      default: [
        'Cold gear, cold prices, cold everything. I have not felt my thumbs since the spring.',
        'The ice moves at night. That is normal. The tracks on it are not.',
      ],
      questAvailable: ['Something has been coming up through the ice. It has a name because it earned one.'],
      questActive: ['Frostjaw hunts under the bergs. Do not fight it from a small boat.'],
      questDone: ['Quietest winter in years. Thank you. Now buy a coat.'],
    },
    gossip: [
      { when: (c) => c.weather?.current?.id === 'snow', text: 'Snow again. Good. Snow means the deep ones come up to the shelf.' },
      { when: (c) => c.eco?.stats?.deepestDive > 100, text: 'You have been down past a hundred metres. In this water. On purpose.' },
    ],
    ambient: ['Cold enough for you?', 'Do not touch the metal.', 'It moved again.'],
  },

  // -------------------------------------------------------- Deep Sea Station
  {
    id: 'hobb', name: 'Chief Hobb Tallow', title: 'Station Command', region: 'station',
    emoji: '👨‍🔬', accent: 0xb96bff, seed: 220044117, prop: 'clipboard',
    at: { anchor: 'shop', fwd: 3.2, side: 1.4, face: 'dock' },
    role: 'chief', shop: true, quests: ['q_abyss_scan', 'q_abyss_mouth'],
    lines: {
      first: [
        'Chief Tallow. I run this platform. Officially it is a research station. Officially.',
      ],
      default: [
        'We are bolted over a hole. Nobody likes to phrase it that way. It is the correct phrasing.',
        'The trench has a floor. I have seen the sonar. The floor answers back.',
        'Every instrument on this platform agrees on the depth. That is what worries me — nothing agrees on anything.',
        'They tell the crew it is thermal noise. It is not thermal noise. Thermal noise does not repeat.',
      ],
      questAvailable: ['Before you go down there, we scan. Nobody goes into the Abyss unscanned. Not again.'],
      questActive: ['Scanner first. The last three who skipped that step are a footnote and two names.'],
      questDone: ['The scan came back. I have not slept. Ask me about the eighth return sometime.'],
    },
    gossip: [
      { when: (c) => c.events?.isActive?.('abyss_anomaly'), text: 'Anomaly is live right now. Pressure readings are wrong in a way I can prove and cannot explain.' },
      { when: (c) => c.subs?.owned?.length > 0, text: 'You have a submarine on the rack. Check the seals. Check them again.' },
      { when: (c) => c.quests?.isRegionUnlocked?.('abyss'), text: 'You have been into the trench. Then you know I am not being dramatic.' },
      { when: (c) => c.eco?.stats?.deepestDive > 400, text: 'Four hundred metres and change. Down there the noise is not noise, it is spacing.' },
    ],
    ambient: ['Log every reading.', 'It repeated again.', 'Check the seals.'],
  },
];

export const NPC_BY_ID = Object.fromEntries(NPCS.map((n) => [n.id, n]));

export function npcsInRegion(regionId) {
  return NPCS.filter((n) => n.region === regionId);
}

// ---------------------------------------------------------------------------
// Dialogue selection
// ---------------------------------------------------------------------------

/** Which quest of theirs is the interesting one right now. */
export function activeQuestFor(npc, ctx) {
  const q = ctx.quests;
  if (!q || !npc.quests?.length) return null;
  for (const id of npc.quests) {
    if (q.active.has(id)) return { id, state: 'questActive' };
  }
  for (const id of npc.quests) {
    if (canOffer(q, id)) return { id, state: 'questAvailable' };
  }
  for (const id of npc.quests) {
    if (q.completed.has(id)) return { id, state: 'questDone' };
  }
  return null;
}

/** Mirrors QuestSystem.start()'s guard without mutating anything. */
function canOffer(quests, id) {
  const q = QUEST_BY_ID[id];
  if (!q) return false;
  if (quests.active.has(id)) return false;
  if (quests.completed.has(id) && !q.repeatable) return false;
  if (q.requires && !q.requires.every((r) => quests.completed.has(r))) return false;
  return true;
}

/**
 * Bucket key for this NPC right now.
 * @returns {'first'|'default'|'questAvailable'|'questActive'|'questDone'}
 */
export function npcState(npc, ctx) {
  if (!ctx.met?.has?.(npc.id)) return 'first';
  const q = activeQuestFor(npc, ctx);
  if (q && npc.lines[q.state]?.length) return q.state;
  return 'default';
}

/** One line of dialogue, already interpolated. */
export function npcLine(npc, ctx, state = null, index = 0) {
  const key = state || npcState(npc, ctx);
  const pool = npc.lines?.[key] || npc.lines?.default || ['...'];
  return interpolate(pool[index % pool.length], ctx);
}

/** Gossip that is actually true of the current save, or null. */
export function npcGossip(npc, ctx, index = 0) {
  const rows = (npc.gossip || []).filter((g) => {
    try { return !!g.when(ctx); } catch { return false; }
  });
  if (!rows.length) return null;
  return interpolate(rows[index % rows.length].text, ctx);
}

export function npcGossipCount(npc, ctx) {
  return (npc.gossip || []).filter((g) => {
    try { return !!g.when(ctx); } catch { return false; }
  }).length;
}

export function npcAmbient(npc, rnd = Math.random()) {
  const pool = npc.ambient || npc.lines?.default || [];
  if (!pool.length) return null;
  return pool[(rnd * pool.length) | 0];
}

/** Fill {tokens} from live game state. Unknown tokens are left as-is. */
export function interpolate(text, ctx) {
  if (!text) return '';
  return text.replace(/\{(\w+)\}/g, (m, key) => {
    const v = TOKENS[key]?.(ctx);
    return v === undefined || v === null ? m : String(v);
  });
}

const TOKENS = {
  money: (c) => formatMoneyExact(c.eco?.money ?? 0),
  boats: (c) => c.boats?.owned?.length ?? 0,
  fleets: (c) => c.fleets?.fleets?.length ?? 0,
  fleetsOut: (c) => (c.fleets?.fleets || []).filter((f) => f.state && f.state !== 'docked').length,
  staff: (c) => c.workers?.workers?.length ?? 0,
  caught: (c) => c.eco?.stats?.totalCaught ?? 0,
  fishCount: (c) => c.inv?.fish?.length ?? 0,
  bosses: (c) => c.eco?.stats?.bossesKilled?.length ?? 0,
  biggest: (c) => c.eco?.stats?.biggestFish?.name || 'fish',
  region: (c) => REGION_BY_ID[c.regionId]?.name || 'here',
  day: (c) => c.eco?.day ?? 1,
  plays: (c) => c.eco?.stats?.gambling?.plays ?? 0,
  rtp: (c) => {
    const g = c.eco?.stats?.gambling;
    if (!g || !g.wagered) return 'n/a';
    return `${Math.round((g.won / g.wagered) * 100)}%`;
  },
  lostToday: (c) => formatMoneyExact(c.gambling?.lostToday ?? 0),
  cap: (c) => formatMoneyExact(c.gambling?.lossCap ?? 0),
};

/**
 * Response buttons for the current conversation node.
 * @returns {Array<{id:string,text:string,action:string,questId?:string}>}
 */
export function npcResponses(npc, ctx, node = 'root') {
  const out = [];
  const q = activeQuestFor(npc, ctx);

  if (node === 'root') {
    if (q?.state === 'questAvailable') {
      out.push({ id: 'accept', text: `Take the job: ${questName(ctx, q.id)}`, action: 'quest', questId: q.id, kind: 'gold' });
    } else if (q?.state === 'questActive') {
      out.push({ id: 'remind', text: 'Remind me what I am doing.', action: 'topic', topic: 'quest' });
    }
    if (npcGossipCount(npc, ctx) > 0) {
      out.push({ id: 'gossip', text: 'Anything going on?', action: 'topic', topic: 'gossip' });
    }
    out.push({ id: 'about', text: 'Tell me about yourself.', action: 'topic', topic: 'about' });
    if (npc.shop) out.push({ id: 'shop', text: 'Show me your stock.', action: 'shop', kind: 'primary' });
    if (npc.gamble) out.push({ id: 'gamble', text: 'What are the games?', action: 'gambling', kind: 'primary' });
    out.push({ id: 'leave', text: 'Later.', action: 'leave' });
    return out.slice(0, 5);
  }

  // Sub-topics all return to the root.
  out.push({ id: 'back', text: 'Something else.', action: 'topic', topic: 'root' });
  if (npc.shop) out.push({ id: 'shop', text: 'Show me your stock.', action: 'shop', kind: 'primary' });
  if (npc.gamble) out.push({ id: 'gamble', text: 'Deal me in.', action: 'gambling', kind: 'primary' });
  out.push({ id: 'leave', text: 'Later.', action: 'leave' });
  return out.slice(0, 4);
}

function questName(ctx, id) {
  return QUEST_BY_ID[id]?.name || id;
}

/** Text for a sub-topic node. */
export function npcTopicLine(npc, ctx, topic, index = 0) {
  if (topic === 'gossip') return npcGossip(npc, ctx, index) || npcLine(npc, ctx, 'default', index);
  if (topic === 'quest') {
    const q = activeQuestFor(npc, ctx);
    const def = q ? QUEST_BY_ID[q.id] : null;
    if (def) return interpolate(`<b>${def.name}</b> — ${def.desc}`, ctx);
    return npcLine(npc, ctx, 'questActive', index);
  }
  if (topic === 'about') {
    const pool = npc.lines.about || npc.lines.default;
    return interpolate(pool[index % pool.length], ctx);
  }
  return npcLine(npc, ctx, null, index);
}
