// Task #714 — Single source of truth for which user roles count as
// "customer-facing" on the Customer Quotes → Quote Opportunities surface.
//
// Used in TWO places that must always agree:
//   1. The page-level access gate on /customer-quotes (client-side) and the
//      sidebar visibility check — only these roles see the page at all.
//   2. The rep universe surfaced anywhere on that page: the "All reps"
//      filter dropdown, the rep performance breakdown (best/worst reps in
//      the funnel), and the rep pickers in the New Quote / Edit Quote
//      dialogs. A `quote_reps` row whose linked user has a role NOT in this
//      set (logistics_manager, logistics_coordinator, generic "sales", etc.)
//      is hidden from those pickers/rankings even though the row itself is
//      kept in the database for historical attribution.
//
// `quote_reps` rows with a NULL `user_id` (legacy / email-signature only
// reps that pre-date the user system) are still considered customer-facing
// — they are not gated by this set since they have no role to check
// against and removing them would erase historical attribution.

import { type UserRole } from "./schema";

export const QUOTE_OPPORTUNITIES_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  "admin",
  "director",
  "sales_director",
  "national_account_manager",
  "account_manager",
]);

export function isQuoteOpportunitiesRole(role: string | null | undefined): boolean {
  if (role == null) return false;
  return QUOTE_OPPORTUNITIES_ROLES.has(role as UserRole);
}

// Convenience predicate for the rep filter: a `quote_reps` row qualifies
// when it has no linked user (legacy) OR its linked user has one of the
// customer-facing roles above.
export function isCustomerFacingQuoteRep(linkedUserRole: string | null | undefined): boolean {
  if (linkedUserRole == null) return true;
  return isQuoteOpportunitiesRole(linkedUserRole);
}
