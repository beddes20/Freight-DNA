/**
 * Lane outreach email builder helpers.
 * Exported separately so they can be unit-tested without starting the server.
 */

import { formatLaneDisplay, formatWeeklyLoadRange, normalizeEquipmentType } from "@shared/laneFormatters";

export { formatLaneDisplay, formatWeeklyLoadRange, normalizeEquipmentType };

/**
 * Fallback email used when the AI call fails.
 *
 * @param name                 Carrier display name
 * @param hasVerifiedHistory   True ONLY when the carrier has a payeeCode (appeared in TMS data).
 *                             Being in the catalog alone does not qualify — do not imply prior
 *                             business otherwise.
 * @param laneDisplay          Pre-formatted "City, ST → City, ST" string
 * @param equipment            Human-readable equipment type (normalize before passing)
 * @param loadRange            Human-friendly volume phrase from formatWeeklyLoadRange()
 * @param mode                 "lane_building" | "immediate_plus_lane"
 */
export function buildFallbackEmail(
  name: string,
  hasVerifiedHistory: boolean,
  laneDisplay: string,
  equipment: string,
  loadRange: string,
  mode: string,
): string {
  const greeting = hasVerifiedHistory ? `Hey ${name} —` : `Hey ${name} team —`;
  const intro = hasVerifiedHistory
    ? ``
    : ` I'm with Value Truck, a freight brokerage.`;

  const modeNote = mode === "immediate_plus_lane"
    ? ` We also have an immediate load coming up on this lane that needs coverage now.`
    : "";

  const bareRange = loadRange.replace(/^(usually|around|about)\s+/i, "");

  return `${greeting}${intro} Checking to see if you've got capacity for ${laneDisplay} (${equipment}). We usually have ${bareRange} on this lane and are looking to line up steady coverage.${modeNote} Does that fit your network? If so, I'd be glad to talk through it.`;
}
