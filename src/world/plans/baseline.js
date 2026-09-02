/**
 * Baseline plan: reproduces the island exactly as it was. Every hook answers
 * "as before", so this is the control the variants are graded against.
 */
export function plan(def, anchors) {
  return {
    allow: () => true,
  };
}
