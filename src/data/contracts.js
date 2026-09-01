import { FISH_SPECIES, RARITY, getSpecies } from './fishData.js';
import { REGION_BY_ID } from './regions.js';

/**
 * Delivery contract generation.
 *
 * Contracts are produced from live fish data, so a reward is always anchored
 * to what the requested fish is actually worth on the market:
 *
 *   marketValue = kg × species.value × RARITY.mult
 *   reward      = marketValue × premium(tier, deadline)
 *   penalty     = reward × 0.25
 *
 * Contract schema
 *   {id, name, desc, requirements:[{speciesId?|rarity?|any, kg?, count?, label}],
 *    reward, deadlineDays, penalty, tier, client, icon}
 */

export const CONTRACT_CLIENTS = [
  { id: 'grimsby_market', name: 'Grimsby Fish Market', icon: '🏪' },
  { id: 'cannery', name: 'Northwind Cannery', icon: '🥫' },
  { id: 'restaurant', name: 'The Salt Room', icon: '🍽' },
  { id: 'exporter', name: 'Tidewater Exports', icon: '📦' },
  { id: 'aquarium', name: 'Municipal Aquarium', icon: '🐠' },
  { id: 'research', name: 'Marine Institute', icon: '🔬' },
  { id: 'hotel', name: 'Harbour Grand Hotel', icon: '🏨' },
  { id: 'wholesaler', name: 'Bluewater Wholesale', icon: '🚚' },
  { id: 'collector', name: 'A Private Collector', icon: '🎩' },
  { id: 'navy', name: 'Coastal Authority', icon: '⚓' },
];

/** Flavour lines keyed by template, picked at random. */
const FLAVOUR = {
  bulk_species: [
    'They have a menu to print and a supplier who let them down.',
    'Standing order. They do not care how you get it, only when.',
    'The buyer has already sold it on. Do not be late.',
  ],
  species_count: [
    'Specific fish, specific count, no substitutions.',
    'For a display case. They want them whole and they want them soon.',
    'Someone upstairs asked for these by name.',
  ],
  rarity_haul: [
    'They pay for the unusual and they pay well.',
    'The collector is bored of common fish. Bring something with a story.',
    'Quality over quantity, but the quantity still matters.',
  ],
  any_bulk: [
    'Volume order. Anything with fins counts.',
    'The cannery does not ask questions. It asks for tonnage.',
    'Fill the truck. That is the whole brief.',
  ],
  mixed: [
    'Two lines on one invoice. Both have to clear.',
    'A split order for a split kitchen.',
    'They want the bulk and the showpiece in the same delivery.',
  ],
};

const RARITY_TARGETS = ['uncommon', 'rare', 'epic'];

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function round(n, step) { return Math.max(step, Math.round(n / step) * step); }

/** Species that are legitimate contract targets in the unlocked world. */
export function contractSpecies(unlockedRegions) {
  const set = unlockedRegions instanceof Set ? unlockedRegions : new Set(unlockedRegions || ['crash']);
  return FISH_SPECIES.filter((s) => !s.boss && s.edible !== false && !s.body.startsWith('junk_')
    && s.regions.some((r) => set.has(r)));
}

/** Average sale value of one specimen of a species, using the mid-weight. */
export function typicalValue(s) {
  const w = (s.weight[0] + s.weight[1]) / 2;
  const rar = RARITY[s.rarity] || RARITY.common;
  return Math.max(1, s.value * w * rar.mult);
}

/** Average $/kg across a candidate pool — used to price "any fish" hauls. */
export function averagePerKg(pool) {
  if (!pool.length) return 8;
  let t = 0;
  for (const s of pool) t += s.value * (RARITY[s.rarity] || RARITY.common).mult;
  return t / pool.length;
}

export const CONTRACT_TEMPLATES = [
  {
    id: 'bulk_species', weight: 34,
    build(rng, pool, tierBias) {
      const s = pick(poolForTier(pool, tierBias, rng), rng);
      const avgW = (s.weight[0] + s.weight[1]) / 2;
      const count = Math.max(2, Math.round((4 + rng() * 12) * sizeFactor(avgW)));
      const cap = 30 + tierBias * 20;
      let kg = Math.min(Math.max(avgW * count, Math.max(2, avgW)), cap);
      kg = round(kg, kg > 150 ? 25 : kg > 60 ? 10 : kg > 15 ? 5 : 1);
      const rar = RARITY[s.rarity] || RARITY.common;
      const market = kg * s.value * rar.mult;
      return {
        key: 'bulk_species', tier: s.tier,
        name: `${kg} kg of ${s.name}`,
        requirements: [{ speciesId: s.id, kg, label: `${kg} kg of ${s.name}` }],
        market,
      };
    },
  },
  {
    id: 'species_count', weight: 20,
    build(rng, pool, tierBias) {
      const s = pick(poolForTier(pool, tierBias, rng), rng);
      const avgW = (s.weight[0] + s.weight[1]) / 2;
      const count = Math.max(2, Math.round((3 + rng() * 7) * sizeFactor(avgW)));
      const market = typicalValue(s) * count;
      return {
        key: 'species_count', tier: s.tier,
        name: `${count} × ${s.name}`,
        requirements: [{ speciesId: s.id, count, label: `${count} × ${s.name}` }],
        market,
      };
    },
  },
  {
    id: 'rarity_haul', weight: 18,
    build(rng, pool, tierBias) {
      const rarity = pick(RARITY_TARGETS.slice(0, Math.min(3, 1 + Math.floor(tierBias / 3))), rng);
      const matching = pool.filter((s) => s.rarity === rarity);
      const count = rarity === 'epic' ? 1 + Math.floor(rng() * 2) : rarity === 'rare' ? 2 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 5);
      const each = matching.length
        ? matching.reduce((a, s) => a + typicalValue(s), 0) / matching.length
        : 60 * (RARITY[rarity]?.mult || 1);
      return {
        key: 'rarity_haul', tier: Math.max(2, Math.min(8, 2 + RARITY_TARGETS.indexOf(rarity) * 2)),
        name: `${count} ${RARITY[rarity].name} fish`,
        requirements: [{ rarity, count, label: `${count} ${RARITY[rarity].name} fish` }],
        market: each * count,
      };
    },
  },
  {
    id: 'any_bulk', weight: 18,
    build(rng, pool, tierBias) {
      const kg = round(40 + rng() * 120 * (0.5 + tierBias / 8), 10);
      return {
        key: 'any_bulk', tier: Math.max(1, Math.min(8, Math.round(tierBias))),
        name: `${kg} kg of any fish`,
        requirements: [{ any: true, kg, label: `${kg} kg of any fish` }],
        market: kg * averagePerKg(pool) * 0.9,
      };
    },
  },
  {
    id: 'mixed', weight: 10,
    build(rng, pool, tierBias) {
      const s = pick(poolForTier(pool, tierBias, rng), rng);
      const avgW = (s.weight[0] + s.weight[1]) / 2;
      let kg = Math.min(avgW * Math.max(2, Math.round((3 + rng() * 6) * sizeFactor(avgW))), 25 + tierBias * 12);
      kg = round(Math.max(kg, Math.max(2, avgW)), kg > 60 ? 10 : kg > 15 ? 5 : 1);
      const rarity = pick(RARITY_TARGETS.slice(0, 2), rng);
      const count = 1 + Math.floor(rng() * 3);
      const matching = pool.filter((x) => x.rarity === rarity);
      const each = matching.length
        ? matching.reduce((a, x) => a + typicalValue(x), 0) / matching.length
        : 60 * (RARITY[rarity]?.mult || 1);
      return {
        key: 'mixed', tier: Math.max(2, s.tier),
        name: `${kg} kg ${s.short || s.name} + ${count} ${RARITY[rarity].name}`,
        requirements: [
          { speciesId: s.id, kg, label: `${kg} kg of ${s.name}` },
          { rarity, count, label: `${count} ${RARITY[rarity].name} fish` },
        ],
        market: kg * s.value * (RARITY[s.rarity]?.mult || 1) + each * count,
      };
    },
  },
];

/** Heavy species get proportionally smaller order counts. */
function sizeFactor(avgW) { return avgW > 60 ? 0.14 : avgW > 25 ? 0.28 : avgW > 8 ? 0.5 : avgW > 2 ? 0.8 : 1; }

function poolForTier(pool, tierBias, rng) {
  const lo = Math.max(1, Math.floor(tierBias) - 1);
  const hi = Math.floor(tierBias) + 1;
  const band = pool.filter((s) => s.tier >= lo && s.tier <= hi);
  return band.length ? band : pool;
}

/**
 * Produce one contract.
 * @param {Function} rng seeded RNG
 * @param {object} opts {regions:Set<string>, day:number, tierBias:number}
 */
export function generateContract(rng, opts = {}) {
  const pool = contractSpecies(opts.regions);
  if (!pool.length) return null;
  const tierBias = Math.max(1, Math.min(8, opts.tierBias ?? highestTier(opts.regions)));

  let total = 0;
  for (const t of CONTRACT_TEMPLATES) total += t.weight;
  let r = rng() * total;
  let tpl = CONTRACT_TEMPLATES[0];
  for (const t of CONTRACT_TEMPLATES) { r -= t.weight; if (r <= 0) { tpl = t; break; } }

  const built = tpl.build(rng, pool, tierBias);
  if (!built || !built.requirements.length) return null;

  // Short deadlines pay more; long ones pay less.
  const deadlineDays = 2 + Math.floor(rng() * 4);
  const urgency = 1.48 - (deadlineDays - 2) * 0.07;
  const premium = urgency * (1 + built.tier * 0.02);
  const reward = Math.max(50, Math.round(built.market * premium));
  const client = pick(CONTRACT_CLIENTS, rng);

  return {
    id: `ct_${(opts.day ?? 1)}_${Math.floor(rng() * 1e9).toString(36)}`,
    name: built.name,
    desc: `${client.name} — ${pick(FLAVOUR[built.key] || ['A straightforward delivery.'], rng)}`,
    requirements: built.requirements,
    reward,
    penalty: Math.round(reward * 0.25),
    deadlineDays,
    tier: built.tier,
    client: client.id,
    icon: client.icon,
  };
}

/** Highest region tier the player can reach — drives contract difficulty. */
export function highestTier(unlockedRegions) {
  const set = unlockedRegions instanceof Set ? unlockedRegions : new Set(unlockedRegions || ['crash']);
  let t = 1;
  for (const id of set) t = Math.max(t, REGION_BY_ID[id]?.tier || 1);
  return t;
}

/** Does a caught specimen satisfy this requirement line? */
export function requirementMatches(req, instance) {
  if (!req || !instance) return false;
  if (req.any) return true;
  if (req.speciesId && instance.speciesId !== req.speciesId) return false;
  if (req.rarity && instance.rarity !== req.rarity) return false;
  if (req.minWeight && instance.weight < req.minWeight) return false;
  if (!req.speciesId && !req.rarity && !req.any) return false;
  return true;
}

/** Target amount for a requirement line (kg or count). */
export function requirementTarget(req) { return req.kg ?? req.count ?? 1; }

/** How much one specimen contributes to a requirement line. */
export function requirementIncrement(req, instance) {
  return req.kg ? (instance.weight || 0) : 1;
}

export { getSpecies };
