/**
 * Curated outreach message templates for Lane Work Queue carrier outreach.
 *
 * Templates support the following lane-level variables (substituted before display):
 *   {{origin}}       — e.g. "Phoenix, AZ"
 *   {{destination}}  — e.g. "Kent, WA"
 *   {{equipmentType}} — e.g. "Dry Van"
 *
 * And the following per-carrier variable (substituted at draft generation time):
 *   {{carrierName}}  — e.g. "Starline Logistics LLC"
 */

export interface OutreachTemplate {
  id: string;
  label: string;
  subject: string;
  body: string;
}

export const OUTREACH_TEMPLATES: OutreachTemplate[] = [
  {
    id: "quick_capacity_check",
    label: "Quick Capacity Check",
    subject: "Capacity for {{origin}} to {{destination}}",
    body: `Hi {{carrierName}} team — Value Truck here. Do you have capacity for {{origin}} → {{destination}} on {{equipmentType}}? If it fits your network, send over availability and I can share the details.`,
  },
  {
    id: "steady_lane_ask",
    label: "Steady Lane Ask",
    subject: "Steady {{origin}} to {{destination}} freight",
    body: `Hi {{carrierName}} team — we're looking to build steady coverage on {{origin}} → {{destination}} for {{equipmentType}}. If this is a lane you like, let me know and I can send over the details and timing.`,
  },
  {
    id: "spot_quote_request",
    label: "Spot Quote Request",
    subject: "Quote request: {{origin}} to {{destination}}",
    body: `Hi {{carrierName}} team — do you have coverage for {{origin}} → {{destination}} on {{equipmentType}}? If yes, send me your best rate and availability and I'll get you the load details right away.`,
  },
  {
    id: "re_engage_prior",
    label: "Re-engage Prior Carrier",
    subject: "Checking capacity on a lane we've run together",
    body: `Hi {{carrierName}} team — reaching out from Value Truck on {{origin}} → {{destination}} for {{equipmentType}}. Since this looks like a lane we may have overlap on, I wanted to see if you have capacity and interest in covering it again.`,
  },
  {
    id: "network_fit_check",
    label: "Network Fit Check",
    subject: "Does {{origin}} to {{destination}} fit your network?",
    body: `Hi {{carrierName}} team — wanted to check whether {{origin}} → {{destination}} on {{equipmentType}} fits your network. If it does, I'd be happy to send over the lane details and talk through coverage.`,
  },
];

export const DEFAULT_TEMPLATE_ID = "quick_capacity_check";

export interface TemplateVars {
  origin?: string;
  destination?: string;
  equipmentType?: string;
  carrierName?: string;
}

/**
 * Substitute all template variables in a string.
 * Missing vars are replaced with empty string or sensible defaults.
 */
export function applyTemplateVars(text: string, vars: TemplateVars): string {
  return text
    .replace(/\{\{origin\}\}/g, vars.origin ?? "")
    .replace(/\{\{destination\}\}/g, vars.destination ?? "")
    .replace(/\{\{equipmentType\}\}/g, vars.equipmentType ?? "dry van")
    .replace(/\{\{carrierName\}\}/g, vars.carrierName ?? "team");
}

/**
 * Substitute only lane-level variables (origin, destination, equipmentType).
 * Leaves {{carrierName}} untouched so it can be substituted per-carrier at draft time.
 */
export function applyLaneVars(text: string, vars: Omit<TemplateVars, "carrierName">): string {
  return text
    .replace(/\{\{origin\}\}/g, vars.origin ?? "")
    .replace(/\{\{destination\}\}/g, vars.destination ?? "")
    .replace(/\{\{equipmentType\}\}/g, vars.equipmentType ?? "dry van");
}

/** Returns true if the text still contains any unresolved {{...}} placeholders. */
export function hasUnresolvedVars(text: string): boolean {
  return /\{\{[^}]+\}\}/.test(text);
}
