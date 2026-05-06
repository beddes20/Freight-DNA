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

// ── 10. Owner-display role set widening — sanity guard ──
// Customer Quotes portlet bug-fix follow-up. The Tier-1 source-email
// resolver now uses QUOTE_OWNER_DISPLAY_ROLES (AM / NAM / logistics_manager
// / logistics_coordinator). These three cases pin the contract so a future
// edit to either set fails fast in CI.
{
  const {
    QUOTE_OWNER_DISPLAY_ROLES,
    QUOTE_REP_UNIVERSE_ROLES,
  } = await import("../shared/quoteOpportunitiesRoles");

  // (a) Logistics-manager mailbox MUST be in the owner display set.
  //     This is the entire reason for the wider gate — operations owners
  //     route ~60% of email-sourced quotes today.
  assert.ok(
    QUOTE_OWNER_DISPLAY_ROLES.has("logistics_manager"),
    "logistics_manager must be eligible as an owner on the portlet",
  );
  assert.ok(
    QUOTE_OWNER_DISPLAY_ROLES.has("logistics_coordinator"),
    "logistics_coordinator must be eligible as an owner on the portlet",
  );
  console.log("✓ Tier-1 promotes logistics_manager / logistics_coordinator to_email");

  // (b) Existing AM/NAM behavior MUST still work.
  assert.ok(
    QUOTE_OWNER_DISPLAY_ROLES.has("account_manager"),
    "account_manager must remain in the owner display set",
  );
  assert.ok(
    QUOTE_OWNER_DISPLAY_ROLES.has("national_account_manager"),
    "national_account_manager must remain in the owner display set",
  );
  console.log("✓ AM / NAM remain eligible (no regression)");

  // (c) The widened set MUST NOT bleed into the sales-funnel rep gate.
  //     Funnel attribution stays AM/NAM-only. If a future change adds
  //     logistics_manager to QUOTE_REP_UNIVERSE_ROLES this fires.
  assert.ok(
    !QUOTE_REP_UNIVERSE_ROLES.has("logistics_manager"),
    "logistics_manager must NOT enter the funnel rep universe",
  );
  assert.ok(
    !QUOTE_REP_UNIVERSE_ROLES.has("logistics_coordinator"),
    "logistics_coordinator must NOT enter the funnel rep universe",
  );
  console.log("✓ Funnel rep universe stays AM/NAM-only (no attribution leakage)");

  // (d) Sales-funnel page-access role gate is unchanged.
  //     Carrier-facing roles like "sales" stay out of both sets.
  assert.ok(
    !QUOTE_OWNER_DISPLAY_ROLES.has("sales" as never),
    "generic 'sales' role must stay excluded from owner display",
  );
  console.log("✓ Carrier-facing 'sales' role remains excluded from owner display");
}

// ── 11. Tier-1 enrich() + suppression — logistics-manager promoted, suppressed user blocked ──
// This pins the end-to-end contract: the helper drops suppressed users
// upstream so enrich() never sees them, and a non-suppressed
// logistics-manager mailbox flows through Tier-1 just like an AM/NAM.
{
  const enrich = customerQuotesTestables.enrich;
  const baseRow: any = {
    id: "opp-2",
    organizationId: "org-1",
    customerId: "cust-1",
    repId: "rep-2",
    laneGroupId: null, carrierId: null, outcomeReasonId: null,
    requestDate: new Date(), originCity: "A", originState: "AA",
    destCity: "B", destState: "BB", equipment: "Dry Van",
    quotedAmount: null, validThrough: null, outcomeStatus: "pending",
    source: "email", sourceReference: "msg-2",
    metadata: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const customerMap = new Map<string, any>([["cust-1", { id: "cust-1", name: "Acme" }]]);
  const repMap = new Map<string, any>([["rep-2", { id: "rep-2", name: "Legacy Name" }]]);

  // Logistics manager mailbox → resolveRepsFromSourceEmails would have put
  // their user.name on the map. enrich() honors it, beating the funnel
  // veto exactly the same way an AM/NAM Tier-1 hit does.
  const promoted = enrich([baseRow], customerMap, repMap, new Map(), new Map(), {
    funnelEligibleRepIds: new Set<string>(), // rep-2 ineligible under Tier-2/3/4
    repByOpportunityId: new Map([["opp-2", "Kassidy Harwood"]]),
  });
  assert.equal(promoted[0].repName, "Kassidy Harwood", "logistics-manager Tier-1 hit must promote");
  console.log("✓ Logistics-manager Tier-1 hit promoted into the owner column");

  // Suppressed user → resolveRepsFromSourceEmails dropped them upstream,
  // so enrich() sees an empty map and the legacy fallback runs (and the
  // funnel veto correctly re-hides the rep).
  const suppressed = enrich([baseRow], customerMap, repMap, new Map(), new Map(), {
    funnelEligibleRepIds: new Set<string>(),
    repByOpportunityId: new Map(), // helper omitted opp-2 because user was suppressed
  });
  assert.equal(suppressed[0].repName, "—", "suppressed user must remain hidden via empty Tier-1");
  console.log("✓ Suppressed user stays hidden (helper drops upstream, enrich sees empty map)");
}

console.log("\nAll buildCanonicalCustomerNameMap + Tier-1 enrich() + owner-role tests passed.");
