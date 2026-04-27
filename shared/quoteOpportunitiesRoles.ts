// Task #714 — Source of truth for role gating on the Customer Quotes →
// Quote Opportunities surface.
//
// Two distinct concepts live here:
//
//   1) QUOTE_OPPORTUNITIES_ROLES — page-access gate.
//      Who is allowed to see the /customer-quotes page at all (and the
//      matching sidebar entry). Includes managers + customer-facing reps,
//      because directors/admins/sales_directors need to view, manage, and
//      coach on these quotes even though they don't typically own them.
//
//   2) QUOTE_REP_UNIVERSE_ROLES — rep dropdown & ranking universe.
//      Tighter set used to decide which `quote_reps` rows show up in the
//      "All reps" filter, the New/Edit Quote rep pickers, and the
//      best/worst rep performance breakdown on the funnel. Per Task #714
//      follow-up: "just be customer facing reps (AM's/NAM's) not
//      logistics managers or carrier facing reps." Managers are NOT in
//      this set — they retain access via #1 but don't appear AS reps.
//
// In both cases a `quote_reps` row whose linked user has an excluded role
// (logistics_manager, logistics_coordinator, generic "sales", or any
// management role) is hidden from the rep pickers/rankings. The row
// itself stays in the database, and individual quote rows still resolve
// the rep's display name via the full repMap, so historical attribution
// is preserved and existing quotes remain visible on the page.
//
// `quote_reps` rows with a NULL `user_id` (legacy / email-signature only
// reps that pre-date the user system) are kept in the rep universe by the
// ingestion-side predicate `isCustomerFacingQuoteRep` — they have no role
// to check, and removing them would erase historical attribution.
//
// Task #752 — A SECOND, stricter predicate `isFunnelEligibleRep` is used on
// the Freight Capture funnel display path: a rep is eligible only when its
// linked user is AM/NAM AND its admin-controlled `suppressed` flag is
// false. Unlinked reps (and reps marked Not customer-facing by an admin)
// are excluded from the funnel rep dropdown / rankings / quote-row rep
// column. Their underlying quotes still count toward customer/lane totals.

import { type UserRole } from "./schema";

// Page-access gate (sidebar + /customer-quotes page).
export const QUOTE_OPPORTUNITIES_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "account_manager",
]);

// Rep universe shown in the rep dropdown / pickers / funnel rep ranking.
// Strictly customer-facing reps. Managers are intentionally excluded.
export const QUOTE_REP_UNIVERSE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  "national_account_manager",
  "account_manager",
]);

export function isQuoteOpportunitiesRole(role: string | null | undefined): boolean {
  if (role == null) return false;
  return QUOTE_OPPORTUNITIES_ROLES.has(role as UserRole);
}

// Predicate for the INGESTION-side rep-create gate. Used by quoteEmailIngestion
// to decide whether a fresh sender email should be persisted as a `quote_reps`
// row. Returns true when there is no linked user (we don't have enough info
// to reject — fall back to "create") OR when the linked user has a strictly
// customer-facing role. Managers / carrier-facing roles are rejected here so
// their signatures don't keep growing the rep table.
export function isCustomerFacingQuoteRep(linkedUserRole: string | null | undefined): boolean {
  if (linkedUserRole == null) return true;
  return QUOTE_REP_UNIVERSE_ROLES.has(linkedUserRole as UserRole);
}

// Task #752 — DISPLAY-side predicate for the Freight Capture funnel rep
// dropdown / rankings / quote-row rep column. Strict: requires the rep to
// be linked to a user with a customer-facing role AND to NOT be flagged
// as suppressed by an admin. Unlinked reps and suppressed reps are
// excluded from the funnel display surface (their underlying quote rows
// still count toward customer/lane totals — only the rep buckets are hidden).
export function isFunnelEligibleRep(input: {
  linkedUserRole: string | null | undefined;
  suppressed: boolean | null | undefined;
}): boolean {
  if (input.suppressed === true) return false;
  if (input.linkedUserRole == null) return false;
  return QUOTE_REP_UNIVERSE_ROLES.has(input.linkedUserRole as UserRole);
}

// Task #752 — Per-row status badge for the rep-audit admin page. Pure
// function so the same labels live in tests and in the client.
export type FunnelRepAuditStatus = "ok" | "wrong_role" | "unlinked" | "suppressed";

export function classifyRepAuditStatus(input: {
  linkedUserRole: string | null | undefined;
  suppressed: boolean | null | undefined;
  hasLinkedUser: boolean;
}): FunnelRepAuditStatus {
  if (input.suppressed === true) return "suppressed";
  if (!input.hasLinkedUser) return "unlinked";
  if (input.linkedUserRole && QUOTE_REP_UNIVERSE_ROLES.has(input.linkedUserRole as UserRole)) return "ok";
  return "wrong_role";
}
