/**
 * Task #615 — Quote Opportunities is customer-only.
 *
 * The dashboard surface (KPIs, list, CSV export, action queue) must
 * never include rows whose customer's `partyType` is `"carrier"` or
 * `"unknown"`. The `includeCarriers` opt-in toggle and the
 * `needsReviewOnly` quick filter have both been retired; the service
 * layer applies a single unconditional chokepoint.
 *
 * These tests drive the four service entry points directly with a
 * mocked Drizzle db and assert the chokepoint holds.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ORG = "org-A";
const CUST_REAL = "cust-real";
const CUST_CARRIER = "cust-carrier";
const CUST_UNKNOWN = "cust-unknown";

// Fixture state shared between the mock and the tests.
const state = vi.hoisted(() => ({
  customers: [] as any[],
  reps: [] as any[],
  reasons: [] as any[],
  laneGroups: [] as any[],
  carriers: [] as any[],
  opportunities: [] as any[],
}));

vi.mock("../storage", async () => {
  const schema: any = await import("@shared/schema");

  const buildChain = (rows: any[]) => {
    const p: any = Promise.resolve(rows);
    p.orderBy = () => Promise.resolve(rows);
    p.limit = () => Promise.resolve(rows);
    return p;
  };

  return {
    db: {
      select: () => ({
        from: (table: any) => ({
          where: () => {
            if (table === schema.quoteCustomers) return buildChain(state.customers.filter(c => c.organizationId === ORG));
            if (table === schema.quoteReps) return buildChain(state.reps);
            if (table === schema.quoteOutcomeReasons) return buildChain(state.reasons);
            if (table === schema.quoteLaneGroups) return buildChain(state.laneGroups);
            if (table === schema.quoteCarriers) return buildChain(state.carriers);
            if (table === schema.quoteOpportunities) return buildChain(state.opportunities.filter(r => r.organizationId === ORG));
            return buildChain([]);
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {
            const ret = { returning: () => Promise.resolve([]) };
            return Object.assign(Promise.resolve(0), ret);
          },
        }),
      }),
    },
    storage: {},
  };
});

// Stub side effects the service fans out to so we don't have to build
// a fake for each one (none touch the customer-only chokepoint).
vi.mock("../services/quoteEmailIngestion", () => ({
  backfillQuotesFromEmails: vi.fn(async () => ({ inserted: 0 })),
  ensureEmailBackfill: vi.fn(async () => undefined),
  getEmailBackfillStatus: vi.fn(() => ({ pending: false })),
}));
vi.mock("../services/staleQuoteFollowup", () => ({
  getStaleQuoteFollowUps: vi.fn(async () => []),
  clearStaleFollowUpCache: vi.fn(),
}));
vi.mock("../services/quotePatternShift", () => ({
  getActivePatternAlertsForOrg: vi.fn(async () => []),
}));

function nowIso(deltaMs: number = 0): Date {
  return new Date(Date.now() + deltaMs);
}

function seed() {
  state.customers = [
    { id: CUST_REAL, organizationId: ORG, name: "Acme Logistics", segment: null, partyType: "customer", partyTypeManual: true },
    { id: CUST_CARRIER, organizationId: ORG, name: "FastHaul Carrier", segment: null, partyType: "carrier", partyTypeManual: true },
    { id: CUST_UNKNOWN, organizationId: ORG, name: "Unknown — needs review", segment: null, partyType: "unknown", partyTypeManual: false },
  ];
  state.reps = [];
  state.reasons = [];
  state.laneGroups = [];
  state.carriers = [];
  // Three pending rows past the SLA threshold (>= 4h old) — one per
  // partyType so we can assert exactly which ones survive the filter.
  const oldDate = nowIso(-1000 * 60 * 60 * 24);
  state.opportunities = [
    {
      id: "q-real-1", organizationId: ORG, customerId: CUST_REAL,
      outcomeStatus: "pending", requestDate: oldDate, validThrough: null,
      originCity: "Chicago", originState: "IL", destCity: "Dallas", destState: "TX",
      equipment: "VAN", quotedAmount: "1500", carrierPaid: null, responseTimeHours: "2",
      score: 60, source: "email", sourceReference: null, notes: null,
      laneGroupId: null, repId: null, carrierId: null, outcomeReasonId: null,
    },
    {
      id: "q-carrier-1", organizationId: ORG, customerId: CUST_CARRIER,
      outcomeStatus: "pending", requestDate: oldDate, validThrough: null,
      originCity: "Atlanta", originState: "GA", destCity: "Memphis", destState: "TN",
      equipment: "REEFER", quotedAmount: "2200", carrierPaid: null, responseTimeHours: "3",
      score: 55, source: "email", sourceReference: null, notes: null,
      laneGroupId: null, repId: null, carrierId: null, outcomeReasonId: null,
    },
    {
      id: "q-unknown-1", organizationId: ORG, customerId: CUST_UNKNOWN,
      outcomeStatus: "pending", requestDate: oldDate, validThrough: null,
      originCity: "Denver", originState: "CO", destCity: "Phoenix", destState: "AZ",
      equipment: "FLATBED", quotedAmount: "1800", carrierPaid: null, responseTimeHours: "5",
      score: 45, source: "email", sourceReference: null, notes: null,
      laneGroupId: null, repId: null, carrierId: null, outcomeReasonId: null,
    },
  ];
}

beforeEach(() => {
  seed();
});

describe("Quote Opportunities — customer-only chokepoint", () => {
  it("getSnapshot.kpis count only customer rows", async () => {
    const { getSnapshot } = await import("../services/customerQuotes");
    const snap = await getSnapshot(ORG, {});
    expect(snap.total).toBe(1);
    expect(snap.kpis.total).toBe(1);
    expect(snap.kpis.pending).toBe(1);
    // Sanity: KPI shape no longer carries the retired needsReview field.
    expect((snap.kpis as any).needsReview).toBeUndefined();
  });

  it("listQuotes returns only customer rows", async () => {
    const { listQuotes } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "requestDate", "desc", 0, 50);
    expect(result.total).toBe(1);
    expect(result.rows.map(r => r.id)).toEqual(["q-real-1"]);
  });

  it("listQuotes still excludes non-customer rows even when needsReviewOnly is set (legacy filter is a no-op)", async () => {
    const { listQuotes } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, { needsReviewOnly: true } as any, "requestDate", "desc", 0, 50);
    // Unknown row would have been the only match historically, but the
    // chokepoint above already removed it — so we land on the (still
    // customer-only) baseline result.
    expect(result.rows.map(r => r.id)).toEqual(["q-real-1"]);
  });

  it("exportCsv emits only customer rows", async () => {
    const { exportCsv } = await import("../services/customerQuotes");
    const csv = await exportCsv(ORG, {});
    expect(csv).toContain("Acme Logistics");
    expect(csv).not.toContain("FastHaul Carrier");
    expect(csv).not.toContain("Unknown — needs review");
  });

  it("getActionQueue exposes only slaBreaching + expiringToday and only for customer rows", async () => {
    const { getActionQueue } = await import("../services/customerQuotes");
    const queue = await getActionQueue(ORG, { limit: 10 });
    // The retired needsReview key must be gone from the response.
    expect((queue as any).needsReview).toBeUndefined();
    expect(Object.keys(queue).sort()).toEqual(["expiringToday", "slaBreaching"]);
    expect(queue.slaBreaching.map(r => r.id)).toEqual(["q-real-1"]);
    // The carrier and unknown rows had no validThrough so neither bucket
    // surfaces them; the filter doing the heavy lifting is the partyType
    // chokepoint, not the bucket-specific predicate.
    for (const r of [...queue.slaBreaching, ...queue.expiringToday]) {
      expect([CUST_REAL]).toContain(r.customerId);
    }
  });
});
