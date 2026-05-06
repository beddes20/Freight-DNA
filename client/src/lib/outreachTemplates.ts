/**
 * Curated outreach message templates for Lane Work Queue carrier outreach.
 *
 * Carrier-bound only — variables must never carry customer/shipper identity (Task #820).
 *
 * Lane-level vars (substituted before display):
 *   {{origin}}, {{destination}}, {{equipmentType}}
 * Per-carrier var (substituted at draft generation time):
 *   {{carrierName}}
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
    body: `{{carrierName}} team, I've got {{equipmentType}} freight running {{origin}} → {{destination}}. You have capacity on that lane? If so, shoot me your availability and I'll get you the details.`,
  },
  {
    id: "steady_lane_ask",
    label: "Steady Lane Ask",
    subject: "Steady {{origin}} to {{destination}} freight",
    body: `{{carrierName}} team, I've got a consistent lane on {{origin}} → {{destination}} for {{equipmentType}} and I'm looking for steady coverage. If that fits your network, let me know and I'll send over the details.`,
  },
  {
    id: "spot_quote_request",
    label: "Spot Quote Request",
    subject: "Quote request: {{origin}} to {{destination}}",
    body: `{{carrierName}} team, need a quote on {{origin}} → {{destination}}, {{equipmentType}}. Can you cover it? Send me your best rate and availability and I'll get you the load details right away.`,
  },
  {
    id: "re_engage_prior",
    label: "Re-engage Prior Carrier",
    subject: "Checking capacity on a lane we've run together",
    body: `{{carrierName}} team, checking on {{origin}} → {{destination}} for {{equipmentType}} — looks like a lane we may have overlap on. Got capacity to cover it again? Let me know and I'll send the details.`,
  },
  {
    id: "network_fit_check",
    label: "Network Fit Check",
    subject: "Does {{origin}} to {{destination}} fit your network?",
    body: `{{carrierName}} team, does {{origin}} → {{destination}} on {{equipmentType}} fit your network? If it does, I'll send over the lane details and we can talk through coverage.`,
  },
  {
    id: "drop_trailer_project",
    label: "Drop Trailer Project",
    subject: "Drop trailer opportunity — {{origin}} to {{destination}}",
    body: `Hi {{carrierName}} team — Value Truck here. We've got a drop trailer lane kicking off in the next few days running {{origin}} → {{destination}} on {{equipmentType}}. Looking for a consistent partner who can handle it on a recurring basis. If drop trailer work fits your fleet, shoot me a note and I'll get you all the details.`,
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
