/**
 * Task #1042 — Customer Quotes customer-only read-layer filter.
 *
 * Pure-function unit tests for `applyFilters` in
 * `server/services/customerQuotes.ts`. They exercise the two new gates
 * (routing-status + rep-role) layered on top of the existing
 * customer-only chokepoint, with seeded fixtures covering the four
 * categories called out in the task spec:
 *
 *   1. customer-side row (auto_customer + customer-facing rep) — appears
 *   2. carrier-side row (auto_carrier)                       — excluded
 *   3. internal/LM row (auto_customer + non-customer rep)    — excluded
 *   4. ambiguous row    (needs_routing)                      — excluded
 *   5. Account-Owner-fallback row (rep_id null)              — appears
 *
 * No DB / no network — `applyFilters` is a synchronous pure helper, so
 * we keep this file in the same lightweight harness style as
 * `tests/customer-quotes-trust-hardening.test.ts`.
 */

import { applyFilters } from "../server/services/customerQuotes";
import type { QuoteOpportunity } from "../shared/schema";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expectEq<T>(label: string, actual: T, expected: T): void {
  if (Object.is(actual, expected)) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
    failures.push(label);
    failed++;
  }
}

function makeRow(overrides: Partial<QuoteOpportunity>): QuoteOpportunity {
  // Minimal fixture — only the fields applyFilters reads matter; the
  // rest are filled with type-shaped defaults so the row satisfies the
  // QuoteOpportunity select type without touching the DB.
  return {
    id: overrides.id ?? "opp-x",
    organizationId: "org-1",
    customerId: overrides.customerId ?? "cust-1",
    repId: overrides.repId ?? null,
    laneGroupId: null,
    carrierId: null,
    outcomeReasonId: null,
    requestDate: new Date("2026-04-01T12:00:00Z"),
    originCity: "Atlanta",
    originState: "GA",
    destCity: "Dallas",
    destState: "TX",
    equipment: "dry van",
    quotedAmount: null,
    validThrough: null,
    outcomeStatus: "pending",
    carrierPaid: null,
    responseTimeHours: null,
    source: "email",
    sourceReference: null,
    notes: null,
    score: null,
    sonarBenchmark: null,
    needsNewContactReview: null,
    snoozedUntil: null,
    routingStatus: overrides.routingStatus ?? "auto_customer",
    routingDecisionAt: null,
    routingDecisionByUserId: null,
    routingNote: null,
    createdAt: new Date("2026-04-01T12:00:00Z"),
    ...overrides,
  } as QuoteOpportunity;
}

console.log("══════════════════════════════════════════════════════════════");
console.log("  Customer Quotes customer-only filter — Task #1042");
console.log("══════════════════════════════════════════════════════════════");

// Customer-facing reps used by the gate. The "lm-rep" rep is omitted so
// rows attributed to it (logistics_manager / logistics_coordinator) get
// dropped by the rep-role gate.
const customerFacingRepIds = new Set(["cust-rep-1", "cust-rep-2"]);
// Customer-only chokepoint already drops these (carrier / unknown).
const nonCustomerCustomerIds = new Set<string>(["carrier-cust-1"]);

const customerSide = makeRow({
  id: "row-customer",
  customerId: "cust-1",
  repId: "cust-rep-1",
  routingStatus: "auto_customer",
});
const carrierSide = makeRow({
  id: "row-carrier",
  customerId: "cust-1", // valid customer link, but classifier says carrier
  repId: "cust-rep-1",
  routingStatus: "auto_carrier",
});
const internalLm = makeRow({
  id: "row-lm",
  customerId: "cust-1",
  repId: "lm-rep", // not in customerFacingRepIds → logistics_manager
  routingStatus: "auto_customer",
});
const ambiguous = makeRow({
  id: "row-needs-routing",
  customerId: "cust-1",
  repId: "cust-rep-1",
  routingStatus: "needs_routing",
});
const ownerFallback = makeRow({
  id: "row-owner-fallback",
  customerId: "cust-1",
  repId: null, // owner_rep on customer governs attribution (Task #1012)
  routingStatus: "auto_customer",
});
// Belt-and-suspenders: a row whose customer is in the non-customer set
// must still be dropped even if everything else looks customer-shaped.
const carrierByCustomer = makeRow({
  id: "row-carrier-customer",
  customerId: "carrier-cust-1",
  repId: "cust-rep-1",
  routingStatus: "auto_customer",
});

const all = [customerSide, carrierSide, internalLm, ambiguous, ownerFallback, carrierByCustomer];

console.log("── applyFilters — main queue (list / snapshot / funnel / CSV) ──");
const filtered = applyFilters(all, {}, nonCustomerCustomerIds, customerFacingRepIds);
const ids = filtered.map(r => r.id).sort();

expectEq("customer-side row appears", ids.includes("row-customer"), true);
expectEq("carrier-side row excluded (auto_carrier)", ids.includes("row-carrier"), false);
expectEq("internal/LM row excluded (rep not customer-facing)", ids.includes("row-lm"), false);
expectEq("needs_routing row excluded from main queue", ids.includes("row-needs-routing"), false);
expectEq("Account-Owner-fallback row (repId null) appears", ids.includes("row-owner-fallback"), true);
expectEq("non-customer customer chokepoint still wins", ids.includes("row-carrier-customer"), false);
expectEq("filtered count == visible categories", filtered.length, 2);

console.log("── routing-status gate is unconditional (no rep set provided) ──");
// Even without the rep-role gate, auto_carrier and needs_routing must
// be dropped — this protects the funnel-diagnostics caller that doesn't
// pass a customerFacingRepIds set.
const noRepGate = applyFilters(all, {}, nonCustomerCustomerIds);
const noRepGateIds = noRepGate.map(r => r.id).sort();
expectEq("auto_carrier still dropped without rep gate", noRepGateIds.includes("row-carrier"), false);
expectEq("needs_routing still dropped without rep gate", noRepGateIds.includes("row-needs-routing"), false);
expectEq("LM row passes when rep gate not provided", noRepGateIds.includes("row-lm"), true);

console.log("── rep-role gate ignores rows with repId === null ──");
// The Account-Owner fallback (Task #1012) attributes rows whose
// `repId` is null via the customer's owner_rep_id. The new rep-role
// gate must NOT drop them — only customer chokepoint / Account-Owner
// fallback govern those rows.
const onlyOwnerFallback = applyFilters(
  [ownerFallback],
  {},
  new Set<string>(),
  customerFacingRepIds,
);
expectEq("repId-null row preserved", onlyOwnerFallback.length, 1);
expectEq("repId-null row id preserved", onlyOwnerFallback[0]?.id, "row-owner-fallback");

console.log("── routed_customer / routed_carrier / dismissed pass-through ──");
// The task's routing-status gate is intentionally narrow: only
// `auto_carrier` and `needs_routing` are dropped. Human-resolved
// statuses fall through and rely on the existing customer/rep
// chokepoints for visibility — verify we don't accidentally widen the
// gate.
const resolved = applyFilters(
  [
    makeRow({ id: "rc", repId: "cust-rep-1", routingStatus: "routed_customer" }),
    makeRow({ id: "rk", repId: "cust-rep-1", routingStatus: "routed_carrier" }),
    makeRow({ id: "dm", repId: "cust-rep-1", routingStatus: "dismissed" }),
  ],
  {},
  new Set<string>(),
  customerFacingRepIds,
);
expectEq("routed_customer passes", resolved.some(r => r.id === "rc"), true);
expectEq("routed_carrier passes (governed by other gates, not this one)", resolved.some(r => r.id === "rk"), true);
expectEq("dismissed passes (governed by other gates, not this one)", resolved.some(r => r.id === "dm"), true);

console.log("──────────────────────────────────────────────────────────────");
console.log(`  ${passed} passed, ${failed} failed`);
console.log("══════════════════════════════════════════════════════════════");
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
