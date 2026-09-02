/**
 * The island layouts the player can choose between.
 *
 * 'classic' is the shipped island, untouched: baseline.js returns no plan at
 * all, so the world takes the path it always took. 'reformed' is the current
 * winner of the layout rounds. The choice lives in settings (islandLayout)
 * and applies when the island next loads, because a region is dressed once
 * at activation and re-dressing it under the player is not worth the risk.
 */
import { plan as classic } from './baseline.js';
import { plan as reformed } from './variant5.js';

export const LAYOUTS = { classic, reformed };
export const DEFAULT_LAYOUT = 'reformed';

/** The plan for a layout id, falling back to the default for unknown ids. */
export function ACTIVE_PLAN(def, anchors, layout) {
  return (LAYOUTS[layout] || LAYOUTS[DEFAULT_LAYOUT])(def, anchors);
}
