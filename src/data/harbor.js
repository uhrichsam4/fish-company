/**
 * Harbour buildings for Port Grimsby.
 *
 * Each building is a purchase that (a) folds numeric effects into the Harbor
 * system's aggregates and (b) spawns real geometry on the quay.
 *
 * Layout frame
 *   `offset: [x, z]` is metres from the harbour's `dockStart` anchor, where
 *   +x follows the dock's `side` vector and +z follows `inward` (away from the
 *   water). Negative z is seaward — used by the piers.
 *   `size: [w, d]` is the footprint (w along +x, d along +z) and drives the
 *   fixed physics collider. `wallH` is the collider height.
 *
 * Parts
 *   `parts[]` composes the mesh from `src/world/props/index.js` builders.
 *   `{prop, opts, at:[x,y,z], ry}` — `at` is local to the building origin,
 *   `ry` an extra local yaw. `seed` keeps every build deterministic.
 *
 * Effect keys
 *   workerSlots, boatSlots, contractSlots  int, summed
 *   storageBonus  kg, summed
 *   freshness, priceMult, repairSpeed      multiplicative
 *   wageMult, fuelMult, repairMult         multiplicative
 *   processLevels, sonarLevel              int, max wins
 *   researchDiscount                       0..1, summed (clamped to 0.6)
 *   unlock                                 feature id string
 */

export const HARBOR_BUILDINGS = [
  {
    id: 'employment_office', icon: '📋', name: 'Employment Office',
    desc: 'A desk, a kettle and a queue of people who can already tie a bowline.',
    cost: 6000, requires: [], reqResearch: 'job_postings', reqRegion: 'harbor',
    effects: { workerSlots: 3, unlock: 'hiring' },
    size: [10, 8], wallH: 3.2, offset: [-34, 30],
    interact: { kind: 'hire', label: 'Hire Crew', at: [0, 1.4, -5] },
    parts: [
      { prop: 'shack', opts: { width: 6.4, depth: 5.2, height: 3.0, roof: 'corrugated' }, at: [0, 0, 0] },
      { prop: 'signpost', opts: { height: 2.3, arrows: 2 }, at: [3.6, 0, -3.2] },
      { prop: 'lampPost', opts: { height: 3.6 }, at: [-4.2, 0, -3.4] },
      { prop: 'crate', opts: { size: 0.85 }, at: [4.0, 0, 1.6] },
    ],
  },
  {
    id: 'warehouse', icon: '📦', name: 'Warehouse',
    desc: 'Somewhere to put the fish that is not the floor. Adds 60 kg of cold store.',
    cost: 12000, requires: [], reqResearch: null, reqRegion: 'harbor',
    effects: { storageBonus: 60 },
    size: [14, 11], wallH: 5.5, offset: [34, 30],
    parts: [
      { prop: 'warehouse', opts: { width: 13, depth: 9.5, height: 5.2 }, at: [0, 0, 0] },
      { prop: 'crate', opts: { size: 0.9 }, at: [-6.4, 0, -5.2] },
      { prop: 'crate', opts: { size: 0.8 }, at: [-5.4, 0, -5.6] },
      { prop: 'barrel', opts: {}, at: [6.2, 0, -4.9] },
    ],
  },
  {
    id: 'freezer', icon: '❄️', name: 'Freezer',
    desc: 'Minus thirty, day and night. Catch keeps 35% of its value longer.',
    cost: 22000, requires: ['warehouse'], reqResearch: null, reqRegion: 'harbor',
    effects: { freshness: 1.35, storageBonus: 25, unlock: 'freezer' },
    size: [12, 10], wallH: 5.2, offset: [30, 48],
    parts: [
      { prop: 'warehouse', opts: { width: 11, depth: 8.6, height: 4.8, color: 0xd6e4ea, trim: 0x2f7fa8 }, at: [0, 0, 0] },
      { prop: 'container', opts: { color: 0x2f6f9e, length: 6.06 }, at: [-7.4, 0, 1.2], ry: 1.5708 },
    ],
  },
  {
    id: 'repair_shop', icon: '🔧', name: 'Repair Shop',
    desc: 'Welding bay and a slipway. Hulls come back 60% faster and 20% cheaper.',
    cost: 18000, requires: [], reqResearch: null, reqRegion: 'harbor',
    effects: { repairSpeed: 1.6, repairMult: 0.8 },
    size: [11, 9], wallH: 4.6, offset: [-52, 30],
    parts: [
      { prop: 'warehouse', opts: { width: 10, depth: 7.6, height: 4.2, color: 0xb0a08a, trim: 0xd4552f }, at: [0, 0, 0] },
      { prop: 'barrel', opts: { color: 0xd4552f }, at: [5.6, 0, -4.4] },
      { prop: 'barrel', opts: {}, at: [6.2, 0, -3.6] },
      { prop: 'ropeCoil', opts: {}, at: [-5.2, 0, -4.2] },
    ],
  },
  {
    id: 'processing_plant', icon: '🏭', name: 'Processing Plant',
    desc: 'Gutting line, chiller and a loading bay. Unlocks on-site processing to tier 2.',
    cost: 45000, requires: ['warehouse'], reqResearch: 'gutting_line', reqRegion: 'harbor',
    effects: { processLevels: 2, unlock: 'processing', storageBonus: 30 },
    size: [18, 13], wallH: 6.0, offset: [0, 50],
    interact: { kind: 'processing', label: 'Processing Floor', at: [0, 1.5, -7] },
    parts: [
      { prop: 'warehouse', opts: { width: 16, depth: 11, height: 5.8, color: 0xa8b4b8, trim: 0x3f8a5c }, at: [0, 0, 0] },
      { prop: 'container', opts: { color: 0x3f8a5c }, at: [-9.6, 0, 2.2], ry: 1.5708 },
      { prop: 'container', opts: { color: 0xd08a2c }, at: [-9.6, 2.6, 2.2], ry: 1.5708 },
      { prop: 'crane', opts: { height: 8, reach: 7, color: 0xe0a233 }, at: [9.8, 0, 1.0] },
      { prop: 'fishCrate', opts: {}, at: [3.0, 0, -6.4] },
      { prop: 'fishCrate', opts: {}, at: [3.9, 0, -6.6] },
    ],
  },
  {
    id: 'research_lab', icon: '🔬', name: 'Research Lab',
    desc: 'White coats on the quay. Every technology costs 15% less to develop.',
    cost: 60000, requires: [], reqResearch: null, reqRegion: 'harbor',
    effects: { researchDiscount: 0.15 },
    size: [13, 11], wallH: 5.0, offset: [-30, 50],
    parts: [
      { prop: 'warehouse', opts: { width: 12, depth: 9, height: 4.6, color: 0xe2e6e8, trim: 0x2fd4c4 }, at: [0, 0, 0] },
      { prop: 'antenna', opts: { height: 7.5 }, at: [-5.6, 0, 4.4] },
      { prop: 'lampPost', opts: { height: 4.0 }, at: [6.0, 0, -5.0] },
    ],
  },
  {
    id: 'second_pier', icon: '🪵', name: 'Second Pier',
    desc: 'One more berth on the water. Room for a second hull.',
    cost: 9000, requires: [], reqResearch: null, reqRegion: 'harbor',
    effects: { boatSlots: 1 },
    size: [5, 22], wallH: 0.4, water: true, offset: [-18, -10],
    parts: [
      { prop: 'pier', opts: { length: 22, width: 5, height: 1.8 }, at: [0, 0, 0], ry: 1.5708 },
      { prop: 'lampPost', opts: { height: 3.4 }, at: [1.8, 0, -9.0] },
    ],
  },
  {
    id: 'commercial_pier', icon: '⚓', name: 'Commercial Pier',
    desc: 'Deep-water quay with a gantry. Three more berths and a licence for fleets.',
    cost: 85000, requires: ['second_pier'], reqResearch: 'commercial_fleet', reqRegion: 'harbor',
    effects: { boatSlots: 3, unlock: 'fleets' },
    size: [8, 30], wallH: 0.4, water: true, offset: [-36, -16],
    parts: [
      { prop: 'pier', opts: { length: 30, width: 8, height: 1.8 }, at: [0, 0, 0], ry: 1.5708 },
      { prop: 'crane', opts: { height: 11, reach: 9, color: 0xd4552f }, at: [0, 1.8, -5.0] },
      { prop: 'container', opts: { color: 0xc4483c }, at: [0, 1.8, 7.5], ry: 1.5708 },
      { prop: 'lampPost', opts: { height: 3.8 }, at: [3.0, 1.8, 12.0] },
    ],
  },
  {
    id: 'submarine_bay', icon: '🤿', name: 'Submarine Bay',
    desc: 'Covered dock with cradles and a charging loop. Submarines can be berthed here.',
    cost: 250000, requires: ['commercial_pier'], reqResearch: 'deep_hull', reqRegion: 'harbor',
    effects: { boatSlots: 2, unlock: 'submarines' },
    size: [13, 18], wallH: 0.4, water: true, offset: [26, -13],
    extraColliders: [{ at: [0, 4.5, 3.4], hx: 5.6, hy: 2.7, hz: 4.6 }],
    parts: [
      { prop: 'pier', opts: { length: 18, width: 13, height: 1.8 }, at: [0, 0, 0], ry: 1.5708 },
      { prop: 'warehouse', opts: { width: 11, depth: 9, height: 5.4, color: 0x8fa0aa, trim: 0x2f6f9e }, at: [0, 1.8, 3.4] },
      { prop: 'crane', opts: { height: 9, reach: 7, color: 0x3f7fa8 }, at: [4.4, 1.8, -6.0] },
      { prop: 'antenna', opts: { height: 6 }, at: [-4.8, 1.8, -6.4] },
    ],
  },
  {
    id: 'fuel_depot', icon: '⛽', name: 'Fuel Depot',
    desc: 'Buy diesel by the tanker instead of the drum. Fuel costs 15% less.',
    cost: 30000, requires: ['second_pier'], reqResearch: null, reqRegion: 'harbor',
    effects: { fuelMult: 0.85 },
    size: [10, 9], wallH: 3.4, offset: [52, 30],
    parts: [
      { prop: 'container', opts: { color: 0xd08a2c }, at: [0, 0, 1.6], ry: 1.5708 },
      { prop: 'container', opts: { color: 0x5a6169 }, at: [0, 2.6, 1.6], ry: 1.5708 },
      { prop: 'barrel', opts: { color: 0xd4552f }, at: [3.4, 0, -2.6] },
      { prop: 'barrel', opts: { color: 0xd4552f }, at: [4.1, 0, -1.9] },
      { prop: 'barrel', opts: { color: 0xd4552f }, at: [3.6, 0, -1.4] },
      { prop: 'signpost', opts: { height: 2.4, arrows: 1 }, at: [-3.8, 0, -3.0] },
    ],
  },
  {
    id: 'crane', icon: '🏗', name: 'Crane',
    desc: 'Forty tonnes of lift over the quay. Unloading is quicker and holds get bigger.',
    cost: 26000, requires: [], reqResearch: null, reqRegion: 'harbor',
    effects: { storageBonus: 40, repairSpeed: 1.2 },
    size: [6, 6], wallH: 2.0, offset: [-54, 50],
    parts: [
      { prop: 'crane', opts: { height: 13, reach: 11, color: 0xe0a233 }, at: [0, 0, 0] },
      { prop: 'crate', opts: { size: 0.9 }, at: [3.4, 0, -2.6] },
    ],
  },
  {
    id: 'fish_market', icon: '🐟', name: 'Fish Market',
    desc: 'Sell straight to the restaurants instead of the wholesaler. +10% on every fish.',
    cost: 70000, requires: ['warehouse'], reqResearch: null, reqRegion: 'harbor',
    effects: { priceMult: 1.1 },
    size: [13, 10], wallH: 4.0, offset: [14, 66],
    parts: [
      { prop: 'shack', opts: { width: 9.5, depth: 6.5, height: 3.4, roof: 'corrugated', accent: 0x2fd4c4 }, at: [0, 0, 0] },
      { prop: 'fishCrate', opts: {}, at: [-4.0, 0, -4.2] },
      { prop: 'fishCrate', opts: {}, at: [-3.1, 0, -4.4] },
      { prop: 'fishCrate', opts: {}, at: [-3.6, 0.28, -4.3] },
      { prop: 'lampPost', opts: { height: 3.6 }, at: [5.2, 0, -4.4] },
      { prop: 'signpost', opts: { height: 2.5, arrows: 2 }, at: [-5.6, 0, -4.0] },
    ],
  },
  {
    id: 'crew_quarters', icon: '🛏', name: 'Crew Quarters',
    desc: 'Bunks, showers and a canteen. Four more berths on the payroll and happier wages.',
    cost: 40000, requires: ['employment_office'], reqResearch: null, reqRegion: 'harbor',
    effects: { workerSlots: 4, wageMult: 0.92 },
    size: [12, 10], wallH: 3.6, offset: [52, 50],
    parts: [
      { prop: 'shack', opts: { width: 6.0, depth: 5.0, height: 3.0, roof: 'corrugated' }, at: [-2.8, 0, 0] },
      { prop: 'shack', opts: { width: 5.4, depth: 4.6, height: 2.8, roof: 'corrugated', accent: 0x4a6fa8 }, at: [3.4, 0, 1.0] },
      { prop: 'tent', opts: { width: 2.4, length: 3.0 }, at: [0.3, 0, -4.2] },
      { prop: 'lampPost', opts: { height: 3.5 }, at: [-5.4, 0, -4.0] },
    ],
  },
  {
    id: 'radio_tower', icon: '📡', name: 'Radio Tower',
    desc: 'Long-range comms and a weather feed. Better sonar coverage and one more contract slot.',
    cost: 55000, requires: [], reqResearch: null, reqRegion: 'harbor',
    effects: { sonarLevel: 2, contractSlots: 1 },
    size: [5, 5], wallH: 2.5, offset: [-14, 66],
    parts: [
      { prop: 'antenna', opts: { height: 14, color: 0xc9d0d4 }, at: [0, 0, 0] },
      { prop: 'container', opts: { color: 0x5a6169, length: 4.2 }, at: [0, 0, 3.4] },
      { prop: 'lampPost', opts: { height: 3.4 }, at: [3.0, 0, -2.6] },
    ],
  },
];

export const HARBOR_BY_ID = Object.freeze(
  Object.fromEntries(HARBOR_BUILDINGS.map((b) => [b.id, b])),
);

export function getBuilding(id) { return HARBOR_BY_ID[id] || null; }
