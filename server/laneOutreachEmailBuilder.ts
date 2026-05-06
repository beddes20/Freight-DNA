/**
 * Lane outreach email builder helpers.
 * Exported separately so they can be unit-tested without starting the server.
 *
 * Carrier-bound only — do not add customer/shipper identity to this surface (Task #820).
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
  const greeting = hasVerifiedHistory ? `${name} team,` : `${name} team,`;

  const modeNote = mode === "immediate_plus_lane"
    ? ` Also have an immediate load on this lane that needs a truck now.`
    : "";

  const bareRange = loadRange.replace(/^(usually|around|about)\s+/i, "");

  return `${greeting} I've got ${laneDisplay} (${equipment}) running ${bareRange} a week and I'm looking for steady coverage.${modeNote} Does that fit your network? If so, let's talk through it.`;
}
