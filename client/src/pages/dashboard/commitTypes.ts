/** Shared types and constants for the weekly freight commitment system. */

export const LEVERS = [
  "Recovery",
  "Contact Mapping",
  "Lane ID",
  "Spot-to-Contract",
  "Referral",
  "Pipeline",
  "QBR",
  "Relationship Advance",
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
