/**
 * The classic island: no plan at all.
 *
 * Returning null makes World.decorate() take the path it always took, so
 * this layout is the shipped one exactly -- not a plan that happens to allow
 * everything, which would still re-seed the scatter outside the start ring.
 * It is the fallback the reformed layouts are measured against, and the one
 * the player can go back to.
 */
export function plan() { return null; }
