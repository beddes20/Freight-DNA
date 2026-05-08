// Single source of truth for "who is the canonical owner of this company?"
//
// History: three columns accumulated over time —
//   - companies.ownerRepId    (Task #1011, primary; also drives email-ingestion fallback)
//   - companies.assignedTo    (legacy "account manager"; indexed)
//   - companies.salesPersonId (sales-org book of business; nearly empty in prod)
//
// Read-side coalesce was previously duplicated across server/auth.ts
// (visibility gate) and client/src/pages/customers.tsx (filter + label).
// Pulling it into one helper means future changes only have to update one
// rule. Anyone touching this function should also update Section 1126 / the
// admin-users gotchas if the precedence changes.
//
// Not a writer — does not mutate. Pure read.

import type { Company } from "@shared/schema";

export function getCanonicalCompanyOwnerId(
  company: Pick<Company, "ownerRepId" | "assignedTo"> & { salesPersonId?: string | null },
): string | null {
  return company.ownerRepId ?? company.assignedTo ?? company.salesPersonId ?? null;
}
