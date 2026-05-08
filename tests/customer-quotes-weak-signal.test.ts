// Task #1148 — pin the five-AND `isWeakSignal` heuristic on
// `enrich()`. The filter ships default-on for the Customer Quotes
// list ("All" view); a regression that flips even one of the five
// inputs into a weaker check would silently start hiding real
// customer quotes from reps. Each case below toggles exactly one
// disqualifier and asserts the row is NOT flagged, and the all-true
// baseline IS flagged. Pure unit test of the exported `enrich`
// (via `__testables`) — no DB, no network.

import assert from "node:assert/strict";
import { __testables } from "../server/services/customerQuotes";

const { enrich } = __testables;

type AnyRow = any;

const baseRow: AnyRow = {
  id: "opp-1",
  organizationId: "org-1",
  customerId: "cust-1",
  repId: null,
  laneGroupId: null,
  carrierId: null,
  outcomeReasonId: null,
  requestDate: new Date("2026-05-07T12:00:00Z"),
  originCity: "Dallas", originState: "TX",
  destCity: "Atlanta", destState: "GA",
  equipment: "DRY",
  quotedAmount: null,
  validThrough: null,
  outcomeStatus: "pending",
  carrierPaid: null,
  responseTimeHours: null,
  source: "email",
  sourceReference: null,
  notes: null,
  score: null,
  routingStatus: "customer",
  partyType: "customer",
  snoozedUntil: null,
};

const customerMap = new Map([["cust-1", { id: "cust-1", name: "Acme" } as any]]);
const repMap = new Map();
const carrierMap = new Map();
const reasonMap = new Map();
const emailDerivedCustomerIds = new Set(["cust-1"]);

function runOne(overrides: Partial<AnyRow>): boolean {
  const row = { ...baseRow, ...overrides };
  const [enriched] = enrich([row], customerMap, repMap, carrierMap, reasonMap, {
    emailDerivedCustomerIds,
  });
  return enriched.isWeakSignal;
}

let failures = 0;
function check(label: string, actual: boolean, expected: boolean) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`PASS ${label}`);
  }
}

// Baseline — all five conditions hold → flagged.
check("baseline all-five-true → isWeakSignal=true", runOne({}), true);

// Each single disqualifier flips it to false.
check("source=manual disqualifies", runOne({ source: "manual" }), false);
check("source=portal disqualifies", runOne({ source: "portal" }), false);
check("repId set disqualifies", runOne({ repId: "rep-1" }), false);
check("quotedAmount set disqualifies", runOne({ quotedAmount: "1500.00" }), false);
check(
  "responseTimeHours set disqualifies",
  runOne({ responseTimeHours: "0.25" }),
  false,
);

// Company NOT email-derived → cust-2 not in the set.
const [outNonEmailDerivedCo] = enrich(
  [{ ...baseRow, customerId: "cust-2" }],
  new Map([["cust-2", { id: "cust-2", name: "Real Co" } as any]]),
  repMap, carrierMap, reasonMap,
  { emailDerivedCustomerIds: new Set(["cust-1"]) /* cust-2 absent */ },
);
check(
  "customer not email-derived disqualifies",
  outNonEmailDerivedCo.isWeakSignal,
  false,
);

// Default-safe behavior — when emailDerivedCustomerIds is omitted
// (legacy callers), every row is conservatively NOT flagged.
const [outNoSet] = enrich([baseRow], customerMap, repMap, carrierMap, reasonMap, {});
check("omitting emailDerivedCustomerIds → never flags (safe default)", outNoSet.isWeakSignal, false);

// Quoted amount of zero is treated like null (some inbound stubs
// land with a literal 0). The five-AND uses num()===0 → still flagged.
check("quotedAmount=0 still treated as no-price → flagged", runOne({ quotedAmount: "0" }), true);

assert.equal(failures, 0, `${failures} weak-signal heuristic check(s) failed`);
console.log("\nAll weak-signal heuristic checks passed.");
