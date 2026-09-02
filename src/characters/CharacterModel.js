import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * The rigged human character, wrapped so the game's existing animators can
 * drive it.
 *
 * Every animator in the game -- workers, NPCs, remote players -- was written
 * against the block figure from WorkerMesh.js: a tree of plain Groups where
 * `arms.L.shoulder.rotation.x` swings the arm in the character's own frame
 * and `hips.position.y` is the hip height. A GLB skeleton is nothing like
 * that. Its bones point along their own axes, an arm hangs in an A-pose, and
 * rotating an upper-arm bone about its local X does something, but not the
 * thing the animator meant.
 *
 * Rather than rewrite three animators for a second rig, each driven bone gets
 * a small chain inserted above it: an `align` node that rotates the frame
 * back to the character's root, a `pivot` the animator owns, and a `post`
 * carrying a constant rest correction. With the pivot at identity the bone
 * sits exactly where it did, so skinning is undisturbed; when the animator
 * sets `pivot.rotation.x`, the bone swings in root space, which is what the
 * box rig always did. The result exposes the same `userData.rig` shape, so
 * callers do not know which figure they got.
 *
 * `legLen` is -0.06. The box rig's animators set the hip height as an
 * absolute, `rig.legLen + 0.06 + bob`; here the hip pivot already sits at the
 * hip, so the value the animators need to add is zero plus their bob.
 */

const URL = 'assets/models/character.glb';

const BONE = {
  hips: 'CC_Base_Hip', torso: 'CC_Base_Spine01', head: 'CC_Base_Head',
  L: { shoulder: 'CC_Base_L_Upperarm', elbow: 'CC_Base_L_Forearm', hand: 'CC_Base_L_Hand',
       hip: 'CC_Base_L_Thigh', knee: 'CC_Base_L_Calf', foot: 'CC_Base_L_Foot' },
  R: { shoulder: 'CC_Base_R_Upperarm', elbow: 'CC_Base_R_Forearm', hand: 'CC_Base_R_Hand',
       hip: 'CC_Base_R_Thigh', knee: 'CC_Base_R_Calf', foot: 'CC_Base_R_Foot' },
};

/** Real-world model is 1.84 m; the player's eye is at 1.6, so shave a little. */
const SCALE = 0.95;

const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class CharacterModel {
  constructor(game) {
    this.game = game;
    this.name = 'characters';
    this.order = 9;
    this.gltf = null;
    this.ready = false;
  }

  async init(game) {
    const g = await game.assets.model(URL);
    if (g?.scene) {
      this.gltf = g;
      this.ready = true;
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // A skinned mesh's bounds do not follow its bones; culling by the
        // bind-pose box drops the character the moment it bends over.
        o.frustumCulled = false;
        const m = o.material;
        if (m) { m.roughness = 0.86; m.metalness = 0; m.envMapIntensity = 0.35; }
      });
    } else {
      console.warn('[characters] character.glb unavailable — block figures will be used');
    }
    return this;
  }

  available() { return this.ready; }

  /**
   * A fresh instance with the WorkerMesh rig contract on `userData.rig`.
   * @returns {THREE.Group}
   */
  build(opts = {}) {
    const root = cloneSkinned(this.gltf.scene);
    const g = new THREE.Group();
    g.name = 'character';
    g.userData.noBatch = true;
    g.add(root);
    g.updateMatrixWorld(true);

    const bone = (name) => {
      const b = root.getObjectByName(name);
      if (!b) throw new Error(`[characters] bone missing: ${name}`);
      return b;
    };

    /**
     * Insert align -> pivot -> post above `b`. `post` is a constant rest
     * rotation in root space, used to hang the arms.
     */
    const insert = (b, post = null) => {
      const P = b.parent;
      P.getWorldQuaternion(_q);
      const align = new THREE.Object3D();
      align.name = `${b.name}.align`;
      align.quaternion.copy(_q).invert();      // align's frame == root frame
      align.position.copy(b.position);
      const pivot = new THREE.Object3D();
      pivot.name = `${b.name}.pivot`;
      const postN = new THREE.Object3D();
      postN.name = `${b.name}.post`;
      if (post) postN.quaternion.copy(post);
      // The bone keeps its world pose when the pivot is at identity.
      const orig = b.quaternion.clone();
      b.position.set(0, 0, 0);
      b.quaternion.copy(align.quaternion).invert().multiply(orig);
      P.remove(b);
      P.add(align); align.add(pivot); pivot.add(postN); postN.add(b);
      align.updateMatrixWorld(true);
      return pivot;
    };

    /**
     * The arms export in an A-pose. The animators' zero is "hanging", so
     * compute the Z rotation that brings the upper arm to vertical and bake
     * it in as the rest correction.
     */
    const hangArm = (upperName, foreName) => {
      const up = bone(upperName), fo = bone(foreName);
      up.getWorldPosition(_a); fo.getWorldPosition(_b);
      const ang = Math.atan2(_b.y - _a.y, _b.x - _a.x);
      return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2 - ang);
    };

    const hips = insert(bone(BONE.hips));
    const torso = insert(bone(BONE.torso));
    const head = insert(bone(BONE.head));

    const arms = {}, legs = {};
    for (const side of ['L', 'R']) {
      const n = BONE[side];
      const shoulder = insert(bone(n.shoulder), hangArm(n.shoulder, n.elbow));
      const elbow = insert(bone(n.elbow));
      const hand = bone(n.hand);
      arms[side] = { shoulder, elbow, hand, upper: bone(n.shoulder), fore: bone(n.elbow) };
      const hip = insert(bone(n.hip));
      const knee = insert(bone(n.knee));
      legs[side] = { hip, knee, thigh: bone(n.hip), shin: bone(n.knee), foot: bone(n.foot) };
    }

    // Tools attach here. Root-aligned at rest, like the box rig's hand, so a
    // rod built for that hand points the same way in this one.
    const handR = arms.R.hand;
    handR.getWorldQuaternion(_q);
    const socketAlign = new THREE.Object3D();
    socketAlign.quaternion.copy(_q).invert();
    const itemSocket = new THREE.Object3D();
    itemSocket.name = 'itemSocket';
    itemSocket.position.set(0, -0.05, 0.05);
    socketAlign.add(itemSocket);
    handR.add(socketAlign);

    g.scale.setScalar(opts.scale ?? SCALE);
    g.updateMatrixWorld(true);
    g.userData.rig = {
      hips, torso, head, arms, legs, itemSocket,
      chestH: 0.42, legLen: -0.06, armLen: 0.58,
      model: 'character',
    };
    return g;
  }
}
