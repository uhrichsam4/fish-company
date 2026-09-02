import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { clamp01, formatWeight, formatMoneyExact } from '../util/math.js';
import { worldHeight } from '../world/Terrain.js';

const _THREE = THREE;
const BUCKET_URL = 'assets/models/bucket.glb';

/** Modelled bucket if it loaded, the procedural one otherwise. */
function bucketMeshFrom(model) {
  if (model) {
    const g = model.clone(true);
    g.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      // A metallic map with no environment to reflect renders near-black in
      // the world scene; dial the metal back so it reads as galvanised steel.
      const mat = o.material;
      if (mat && !mat.userData.tuned) { mat.metalness = 0.35; mat.roughness = 0.62; mat.userData.tuned = true; }
    });
    g.userData.noBatch = true;
    g.name = 'bucket-placed';
    return g;
  }
  return buildBucketMesh();
}

/** The bucket as it stands in the world -- same shape as the viewmodel. */
function buildBucketMesh() {
  const g = new THREE.Group();
  const pail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.23, 0.175, 0.33, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.55, metalness: 0.35, side: THREE.DoubleSide }),
  );
  pail.position.y = 0.165;
  const base = new THREE.Mesh(
    new THREE.CircleGeometry(0.175, 14).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x767f87, roughness: 0.7, metalness: 0.3 }),
  );
  base.position.y = 0.002;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.23, 0.016, 6, 18).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xb6c0c8, roughness: 0.4, metalness: 0.5 }),
  );
  rim.position.y = 0.33;
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.224, 0.012, 5, 16, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0x8d949a, roughness: 0.45, metalness: 0.5 }),
  );
  handle.position.y = 0.34;
  g.add(pail, base, rim, handle);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.noBatch = true;
  g.name = 'bucket-placed';
  return g;
}

/**
 * The fish bucket.
 *
 * Deliberately layered on top of Inventory rather than replacing it: the
 * inventory's fish list is already what workers, the gambling den, spearfishing
 * and the sell zones all read, and forking that into a second store would give
 * two sources of truth for the same fish. The bucket owns the things the
 * inventory has no concept of -- whether a fish is still alive, how heavy the
 * carry is, and which tier of container the player owns.
 *
 * A caught fish goes in alive. It stays alive, flopping, until the player
 * processes it with a spear or knife. Selling is gated on standing in a sell
 * zone, so the catch has to physically travel.
 */

export const BUCKET_TIERS = [
  { id: 'bucket_old', name: 'Old Bucket', capacity: 15, price: 0, desc: 'It held paint once. It has opinions about that.' },
  { id: 'bucket_steel', name: 'Steel Bucket', capacity: 30, price: 340, desc: 'Galvanised. Rattles honestly.' },
  { id: 'crate_fish', name: 'Fish Crate', capacity: 60, price: 1500, desc: 'Slatted, stackable, smells permanently of its job.' },
  { id: 'crate_large', name: 'Large Crate', capacity: 120, price: 6200, desc: 'You will feel this one in your back.' },
];
export const BUCKET_BY_ID = Object.fromEntries(BUCKET_TIERS.map((b) => [b.id, b]));

/** Weight at which the carry penalty is at its worst, as a fraction of capacity. */
const HEAVY_AT = 1;

export class BucketSystem {
  constructor(game) {
    this.game = game;
    this.name = 'bucket';
    this.order = 32;
    this.tierId = 'bucket_old';
    /** Set true while the player is physically holding the bucket. */
    this.carried = false;
    /**
     * Where the bucket is standing, or null when it is on your belt.
     *
     * A bucket you always have makes the catch loop one button: hook, and it
     * is banked. Setting it down puts a place in the world back into the loop
     * -- you fish near it, and a fish landed out of range is one you have to
     * carry over.
     */
    this.placed = null;
    this.mesh = null;
  }

  /** How far from the bucket a landed catch will still put itself away. */
  static get REACH() { return 11; }

  async init() {
    bus.on('game:newgame', () => {
      this.tierId = 'bucket_old'; this.carried = false; this.pickUp();
    });
    bus.on('bucket:toggleGround', () => this.togglePlaced());
    // Casting with the bucket still on your belt sets it down behind you.
    // The catch loop -- grab, kill, throw it in -- needs a bucket in the
    // world to throw into, and a player who has to remember to place it
    // first is a player who fishes for ten minutes and then wonders where the
    // fish went.
    bus.on('fishing:cast', () => { if (!this.placed) this.setDown({ behind: true }); });
    // The modelled bucket. Preloaded here because setDown() is synchronous.
    const m = await this.game.assets.model(BUCKET_URL);
    if (m?.scene) this._model = m.scene;
    // A fish only enters the world alive; everything else about it is the
    // inventory's business.
    bus.on('inventory:fishStored', () => this._tagNewest());
    return this;
  }

  togglePlaced() { return this.placed ? this.pickUp() : this.setDown(); }

  /**
   * Stand the bucket on the ground near the player: in front by default,
   * behind when set down automatically on a cast -- in front is the water.
   * Refuses rather than dropping it in the sea.
   */
  setDown(opts = {}) {
    const game = this.game;
    const player = game.get('player');
    if (!player) return false;
    const THREE = _THREE;
    const fwd = new THREE.Vector3();
    player.forward(fwd);
    const sign = opts.behind ? -1 : 1;
    let x = player.position.x + fwd.x * 1.4 * sign;
    let z = player.position.z + fwd.z * 1.4 * sign;
    if (worldHeight(x, z) < 0.1) {
      // Try beside instead; if that is water too, keep it on the belt.
      x = player.position.x - fwd.z * 1.3; z = player.position.z + fwd.x * 1.3;
      if (worldHeight(x, z) < 0.1) return false;
    }
    const y = worldHeight(x, z);

    if (!this.mesh) this.mesh = bucketMeshFrom(this._model);
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = Math.random() * Math.PI * 2;
    if (!this.mesh.parent) game.scene.add(this.mesh);
    this.mesh.visible = true;

    this.placed = { x, y, z };
    game.audio?.play('crate_break', { volume: 0.3, rate: 1.5 });
    bus.emit('toast', {
      text: opts.behind ? '🪣 Bucket set down behind you — grab each catch and throw it in'
        : '🪣 Bucket set down — grab each catch and throw it in',
      kind: 'gold', duration: 3600,
    });
    bus.emit('bucket:placed', { at: this.placed });
    bus.emit('bucket:changed');
    return true;
  }

  pickUp() {
    if (!this.placed) return false;
    this.placed = null;
    if (this.mesh) this.mesh.visible = false;
    bus.emit('toast', { text: '🪣 Bucket back on your belt', kind: '', duration: 2000 });
    bus.emit('bucket:placed', { at: null });
    bus.emit('bucket:changed');
    return true;
  }

  /** Metres to the standing bucket, or 0 when it is being carried. */
  distanceTo(x, z) {
    if (!this.placed) return 0;
    return Math.hypot(this.placed.x - x, this.placed.z - z);
  }

  /** Can a fish that landed here put itself away? */
  reaches(x, z) {
    if (!this.placed) return true;              // carried: always in reach
    return this.distanceTo(x, z) <= BucketSystem.REACH;
  }

  get tier() { return BUCKET_BY_ID[this.tierId] || BUCKET_TIERS[0]; }
  get capacity() { return this.tier.capacity; }
  get inv() { return this.game.get('inventory'); }
  get fish() { return this.inv?.fish || []; }

  get weight() { let w = 0; for (const f of this.fish) w += f.instance.weight; return w; }
  get count() { return this.fish.length; }
  get aliveCount() { return this.fish.reduce((n, f) => n + (f.alive ? 1 : 0), 0); }
  get processedCount() { return this.count - this.aliveCount; }

  /** Estimated take, using the same pricing the seller will actually apply. */
  get value() {
    const eco = this.game.get('economy');
    if (!eco) return 0;
    let v = 0;
    for (const f of this.fish) v += eco.priceFor(f.instance) * (f.styleMult || 1);
    return Math.round(v);
  }

  /** 0..1 how full by weight. */
  get fullness() { return clamp01(this.weight / Math.max(1, this.capacity)); }

  _tagNewest() {
    const f = this.fish[this.fish.length - 1];
    // Only a brand new entry is untagged; a loaded save already has its state.
    if (f && f.alive === undefined) f.alive = true;
  }

  /**
   * Kill one fish. This is what the spear does -- it is never automatic,
   * because the whole point of the loop is that the player does it.
   */
  process(index) {
    const f = this.fish[index];
    if (!f || !f.alive) return false;
    f.alive = false;
    f.processedAt = this.game.time;
    bus.emit('bucket:processed', { fish: f });
    bus.emit('inventory:changed');
    return true;
  }

  /** The topmost still-flopping fish, which is what a spear thrust should hit. */
  firstAlive() {
    const i = this.fish.findIndex((f) => f.alive);
    return i < 0 ? null : { index: i, fish: this.fish[i] };
  }

  upgradeTo(id) {
    const t = BUCKET_BY_ID[id];
    if (!t) return false;
    this.tierId = id;
    bus.emit('bucket:changed');
    bus.emit('toast', { text: `${t.name} — ${formatWeight(t.capacity)} capacity`, kind: 'gold' });
    return true;
  }

  /** Movement drag from the load. Kept mild: this is flavour, not a tax. */
  get carryPenalty() {
    if (!this.carried) return 0;
    return clamp01(this.weight / (this.capacity * HEAVY_AT)) * 0.22;
  }

  /** True when the player is close enough to a sell zone to trade. */
  atSeller() {
    const world = this.game.get('world');
    const p = this.game.get('player');
    if (!world?.sellZones || !p) return false;
    for (const z of world.sellZones) {
      const d = Math.hypot(p.position.x - z.position.x, p.position.z - z.position.z);
      if (d < (z.radius || 2.4) + 1.6) return true;
    }
    return false;
  }

  /**
   * Empty the bucket to the seller. Refuses at range on purpose: the catch has
   * to be carried there, which is the point of the bucket existing at all.
   */
  sell() {
    if (!this.count) {
      bus.emit('toast', { text: 'The bucket is empty.', kind: '' });
      return { count: 0, total: 0 };
    }
    if (!this.atSeller()) {
      bus.emit('toast', { text: 'Carry the bucket to a seller to sell your catch.', kind: 'error', duration: 3600 });
      return { count: 0, total: 0 };
    }
    const res = this.inv.sellAll();
    if (res.count) {
      this.game.audio?.play('bucket_sell', { volume: 0.8 });
      this.game.audio?.play('cash_register', { volume: 0.7 });
      bus.emit('toast', {
        text: `Sold ${res.count} fish for ${formatMoneyExact(res.total)}`, kind: 'gold', duration: 4200,
      });
      bus.emit('bucket:sold', res);
    }
    return res;
  }

  update() {
    const hud = this.game.get('hud');
    if (hud?.setBucket) {
      hud.setBucket({
        count: this.count, alive: this.aliveCount,
        weight: this.weight, capacity: this.capacity,
        value: this.value, carried: this.carried,
      });
    }
  }

  save() { return { tier: this.tierId, carried: this.carried, placed: this.placed }; }

  load(d) {
    if (!d) return;
    if (BUCKET_BY_ID[d.tier]) this.tierId = d.tier;
    this.carried = !!d.carried;
    if (d.placed) {
      if (!this.mesh) this.mesh = bucketMeshFrom(this._model);
      this.mesh.position.set(d.placed.x, d.placed.y, d.placed.z);
      if (!this.mesh.parent) this.game.scene.add(this.mesh);
      this.mesh.visible = true;
      this.placed = d.placed;
    } else this.pickUp();
    // Fish saved before the bucket existed have no alive flag. Treat them as
    // already processed rather than resurrecting a boatload of them.
    for (const f of this.fish) if (f.alive === undefined) f.alive = false;
  }
}
