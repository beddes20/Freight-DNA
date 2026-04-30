/**
 * Customer Quotes portlet bug-fix — guards the two display-resolution
 * helpers added during the bug-fix pass:
 *
 *   1. `buildCanonicalCustomerNameMap` — upgrades sluggified
 *      `quote_customers.name` strings ("Mohawkind") to canonical
 *      CRM names ("Mohawk Industries") via a conservative two-tier
 *      match (exact normalized → prefix-uniqueness with +3 char
 *      extension). Must NEVER guess on ambiguous prefixes (Masonite
 *      → 3 candidates) or near-misses (Valuetruck → Valuetruckaz).
 *
 *   2. The Tier-1 source-email rep contract baked into `enrich()`:
 *      when `repByOpportunityId` carries an entry for an opportunity,
 *      that name beats every other tier and bypasses the funnel-
 *      eligibility veto (the upstream resolver already verified the
 *      linked user is customer-facing).
 *
 * These tests are pure — no DB seeding required. They exercise the
 * exported helpers directly so a regression that re-introduces the
 * "Unassigned" / sluggified-string display fails fast in CI.
 */
import { strict as assert } from "node:assert";
import {
  buildCanonicalCustomerNameMap,
  __testables as customerQuotesTestables,
} from "../server/services/customerQuotes";

// ── 1. buildCanonicalCustomerNameMap — happy path: exact-prefix uniqueness ──
{
  const customers = [
    { id: "c1", name: "Mohawkind" },
    { id: "c2", name: "Armstrong" },
  ];
  const companies = [
    { name: "Mohawk Industries" },
    { name: "Armstrong World Industries" },
  ];
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(map.get("c1"), "Mohawk Industries", "Mohawkind → Mohawk Industries");
  assert.equal(map.get("c2"), "Armstrong World Industries", "Armstrong → Armstrong World Industries");
  console.log("✓ Mohawkind → Mohawk Industries (prefix-uniqueness, +7 chars)");
  console.log("✓ Armstrong → Armstrong World Industries (prefix-uniqueness, +15 chars)");
}

// ── 2. Ambiguous prefix → no mapping (don't guess) ──
{
  const customers = [{ id: "c1", name: "Masonite" }];
  const companies = [
    { name: "MASONITE MEXICO SA DE CV" },
    { name: "MASONITE CORPORATION - MONTERREY" },
    { name: "MASONITE CORPORATION - US" },
  ];
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(map.get("c1"), undefined, "ambiguous Masonite prefix must not be canonicalized");
  console.log("✓ Masonite → no mapping (3 candidates → ambiguous, leave as-is)");
}

// ── 3. Near-miss extension < 3 chars → no mapping ──
{
  const customers = [{ id: "c1", name: "Valuetruck" }];
  const companies = [{ name: "Valuetruckaz" }]; // only +2 chars
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(map.get("c1"), undefined, "Valuetruck → Valuetruckaz is too close to be canonical");
  console.log("✓ Valuetruck → no mapping (+2 chars below threshold)");
}

// ── 4. Exact normalized match with case difference → adopt canonical casing ──
{
  const customers = [{ id: "c1", name: "ACME corp" }];
  const companies = [{ name: "Acme Corp" }];
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(map.get("c1"), "Acme Corp", "exact normalized match adopts canonical casing");
  console.log("✓ ACME corp → Acme Corp (exact normalized, case differs)");
}

// ── 5. Exact normalized match where strings are identical → no-op ──
{
  const customers = [{ id: "c1", name: "Acme Corp" }];
  const companies = [{ name: "Acme Corp" }];
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(map.get("c1"), undefined, "no-op when canonical equals stored");
  console.log("✓ Acme Corp == Acme Corp → no entry (identical strings)");
}

// ── 6. Empty / too-short names are skipped silently ──
{
  const customers = [
    { id: "c1", name: "" },
    { id: "c2", name: "Ab" }, // < 3 chars normalized
    { id: "c3", name: "  " },
  ];
  const companies = [{ name: "Anything LLC" }];
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(map.size, 0, "empty / too-short names are not mapped");
  console.log("✓ Empty + too-short names skipped");
}

// ── 7. Non-alphanumeric noise is normalized away ──
{
  const customers = [{ id: "c1", name: "Mohawkind" }];
  const companies = [{ name: "MOHAWK-INDUSTRIES, INC." }]; // dashes/commas/period
  const map = buildCanonicalCustomerNameMap(customers, companies);
  assert.equal(
    map.get("c1"),
    "MOHAWK-INDUSTRIES, INC.",
    "punctuation in canonical is stripped for matching but preserved on output",
  );
  console.log("✓ Punctuation stripped for match, preserved on output");
}

// ── 8. Multiple companies share normalization → exact-tier skipped ──
{
  const customers = [{ id: "c1", name: "Acme" }];
  const companies = [
    { name: "ACME" },
    { name: "Acme" },
  ];
  const map = buildCanonicalCustomerNameMap(customers, companies);
  // Exact tier sees a Set of 2 distinct strings → bails. Prefix tier
  // requires +3 chars so neither candidate qualifies. End: no entry.
  assert.equal(map.get("c1"), undefined, "duplicate normalization bails out of exact tier");
  console.log("✓ Duplicate normalization → no mapping");
}

// ── 9. Tier-1 enrich() contract — repByOpportunityId beats funnel-eligibility hiding ──
{
  const enrich = customerQuotesTestables.enrich;
  const baseRow: any = {
    id: "opp-1",
    organizationId: "org-1",
    customerId: "cust-1",
    repId: "rep-1",
    laneGroupId: null,
    carrierId: null,
    outcomeReasonId: null,
    requestDate: new Date(),
    originCity: "A", originState: "AA", destCity: "B", destState: "BB",
    equipment: "Dry Van", quotedAmount: null, validThrough: null,
    outcomeStatus: "pending", source: "email", sourceReference: "msg-1",
    metadata: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const customerMap = new Map<string, any>([["cust-1", { id: "cust-1", name: "Acme" }]]);
  const repMap = new Map<string, any>([["rep-1", { id: "rep-1", name: "Legacy Rep Name" }]]);
  const carrierMap = new Map<string, any>();
  const reasonMap = new Map<string, any>();

  // Case A: rep-1 is NOT funnel-eligible (would normally be hidden), but Tier-1
  // supplies the source-email-derived name → that name wins.
  const aRows = enrich([baseRow], customerMap, repMap, carrierMap, reasonMap, {
    funnelEligibleRepIds: new Set<string>(), // empty = rep-1 hidden under Tier-2/3/4
    repByOpportunityId: new Map([["opp-1", "Taylor Call"]]),
  });
  assert.equal(aRows[0].repName, "Taylor Call", "Tier-1 must beat funnel-eligibility veto");
  console.log("✓ Tier-1 source-email name beats funnel-eligibility hiding");

  // Case B: helper omitted opp-1 from the map (e.g. user was suppressed, or
  // role wasn't AM/NAM, or no source email). Tier-2/3/4 cascade runs, and
  // funnel-eligibility hiding takes effect.
  const bRows = enrich([baseRow], customerMap, repMap, carrierMap, reasonMap, {
    funnelEligibleRepIds: new Set<string>(), // rep-1 still ineligible
    repByOpportunityId: new Map(), // no Tier-1 entry (suppressed/non-AM/etc.)
  });
  assert.equal(bRows[0].repName, "—", "no Tier-1 + ineligible rep → '—' (Unassigned)");
  console.log("✓ No Tier-1 entry + ineligible rep → '—' (suppressed-rep behavior preserved)");

  // Case C: no Tier-1, but rep IS eligible → fall through to repMap name.
  const cRows = enrich([baseRow], customerMap, repMap, carrierMap, reasonMap, {
    funnelEligibleRepIds: new Set(["rep-1"]),
    repByOpportunityId: new Map(),
  });
  assert.equal(cRows[0].repName, "Legacy Rep Name", "no Tier-1 + eligible rep → repMap name");
  console.log("✓ No Tier-1 + eligible rep → falls through to legacy tiers");

  // Case D: canonicalCustomerNames upgrades the customer column.
  const dRows = enrich([baseRow], customerMap, repMap, carrierMap, reasonMap, {
    canonicalCustomerNames: new Map([["cust-1", "Acme Corporation, Inc."]]),
  });
  assert.equal(dRows[0].customerName, "Acme Corporation, Inc.", "canonical name beats stored");
  console.log("✓ canonicalCustomerNames upgrade applied in enrich()");
}

console.log("\nAll buildCanonicalCustomerNameMap + Tier-1 enrich() tests passed.");
