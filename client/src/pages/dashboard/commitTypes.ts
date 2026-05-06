/** Shared types and constants for the weekly freight commitment system. */

export const LEVERS = [
  "Contact Mapping",
  "Lane ID",
  "Pipeline",
  "QBR",
  "Recovery",
  "Referral",
  "Relationship Advance",
  "Spot-to-Contract",
] as const;

export type Lever = typeof LEVERS[number];

export interface CommitPayload {
  companyId?: string;
  companyName?: string;
  contactId?: string;
  contactName?: string;
  defaultText: string;
  defaultLever: Lever;
  source: string;
}
