/**
 * Lane outreach email builder helpers.
 * Exported separately so they can be unit-tested without starting the server.
 */

import { formatLaneDisplay, formatWeeklyLoadRange } from "@shared/laneFormatters";

export { formatLaneDisplay, formatWeeklyLoadRange };

export function buildFallbackEmail(
  name: string,
  isKnown: boolean,
  laneDisplay: string,
  equipment: string,
  loadRange: string,
  mode: string,
): string {
  const intro = isKnown
    ? `We've run freight together before and I wanted to loop you in on something steady.`
    : `I'm with Value Truck, a freight brokerage, and wanted to reach out about a lane we run regularly.`;

  const modeNote = mode === "immediate_plus_lane"
    ? ` We also have a load coming up on this corridor soon — happy to share details if the timing works.`
    : "";

  return `Hi ${name} team,

${intro} We move ${equipment} freight on the ${laneDisplay} corridor ${loadRange}, and I'm looking for reliable carriers to run it with us.${modeNote}

Even if you don't have a truck available this week, I'd still love to connect — this lane runs consistently and I'd want you top of mind. Worth a quick call?`;
}
