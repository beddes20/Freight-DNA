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
// reps that pre-date the user system) are kept in the rep universe — they
// have no role to check, and removing them would erase historical
// attribution on quotes booked before the user system existed.

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

// Predicate for the rep filter / pickers / rep ranking: a `quote_reps` row
// qualifies when it has no linked user (legacy) OR its linked user has one
// of the strictly customer-facing roles above. Managers are filtered out
// from the rep universe even though they retain page access.
export function isCustomerFacingQuoteRep(linkedUserRole: string | null | undefined): boolean {
  if (linkedUserRole == null) return true;
  return QUOTE_REP_UNIVERSE_ROLES.has(linkedUserRole as UserRole);
}
