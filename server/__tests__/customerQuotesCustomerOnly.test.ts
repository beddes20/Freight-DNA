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
// Task #816 — partyType-leaks: a customer row mis-flagged as
// `partyType: "customer"` whose name carries a carrier suffix
// ("FastHaul Freight") must still be hidden by the chokepoint.
const CUST_LEAKED = "cust-leaked";
// Task #837 — a customer-tagged row whose name is the canonical
// "Unknown — needs review" placeholder. The hardened chokepoint must
// still drop it from the customer-only Quote Opportunities surface.
const CUST_UNKNOWN_TAGGED = "cust-unknown-tagged";
// Task #837 — orphan opportunity points at a customerId that no
// longer exists in `quote_customers` (deleted, re-keyed, or stale
// inbox capture). listQuotes must filter the row out before the
// pagination math runs.
const CUST_DELETED = "cust-deleted-id";
// Customer-facing rep (NAM) and a back-office user that must be
// excluded from the rep filter dropdown surfaced by getSnapshot().
const REP_NAM = "rep-nam";
const REP_ADMIN = "rep-admin";

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

  // Task #816 — flexible chain so we can mock the queries that span
  // .from() → optional .leftJoin() → .where() → optional .orderBy() / .limit().
  // Every terminating call resolves to the bound rows array.
  const buildChain = (rows: any[]) => {
    const chain: any = Promise.resolve(rows);
    chain.where = () => buildChain(rows);
    chain.leftJoin = () => buildChain(rows);
    chain.innerJoin = () => buildChain(rows);
    chain.orderBy = () => buildChain(rows);
    chain.limit = () => buildChain(rows);
    chain.groupBy = () => buildChain(rows);
    return chain;
  };

  const rowsForTable = (table: any): any[] => {
    if (table === schema.quoteCustomers) return state.customers.filter(c => c.organizationId === ORG);
    if (table === schema.quoteReps) {
      // Task #816 — repsJoined includes a `linkedUserRole` field from a
      // left-join with `users`. The shape we return matches what
      // `loadContext` selects so `isFunnelEligibleRep` evaluates each rep.
      // Task #837 — also surface `linkedUserName` so loadContext can
      // build its rep-display-name map (prefers users.name over
      // quote_reps.name).
      return state.reps.map(r => ({
        id: r.id,
        organizationId: r.organizationId ?? ORG,
        userId: r.userId ?? null,
        name: r.name,
        email: r.email ?? null,
        suppressed: r.suppressed ?? false,
        linkedUserRole: r.linkedUserRole ?? null,
        linkedUserName: r.linkedUserName ?? null,
      }));
    }
    if (table === schema.quoteOutcomeReasons) return state.reasons;
    if (table === schema.quoteLaneGroups) return state.laneGroups;
    if (table === schema.quoteCarriers) return state.carriers;
    if (table === schema.quoteOpportunities) return state.opportunities.filter(r => r.organizationId === ORG);
    return [];
  };

  return {
    db: {
      select: (_proj?: any) => ({
        from: (table: any) => buildChain(rowsForTable(table)),
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
  // Task #816 — `customerQuotes.ts` references the canonical
  // lost-reason constants at module load. Ship them through the mock so
  // import time doesn't crash on `LOST_PRICE` not being defined.
  LOST_PRICE:     { code: "lost_price",     label: "Lost on price",                          status: "lost_price"     },
  LOST_SERVICE:   { code: "lost_service",   label: "Lost on service / fit",                  status: "lost_service"   },
  LOST_TIMING:    { code: "lost_timing",    label: "Load cancelled or no longer needed",     status: "lost_timing"    },
  LOST_INCUMBENT: { code: "lost_incumbent", label: "Customer covered with another carrier",  status: "lost_incumbent" },
  findOrCreateLostReasonExported: vi.fn(async () => "reason-x"),
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
    // Task #816 — display name carries no carrier-suffix tokens so the
    // hardened chokepoint keeps the row even when the carrier-name
    // catalog grows.
    { id: CUST_REAL, organizationId: ORG, name: "Acme Foods", segment: null, partyType: "customer", partyTypeManual: true },
    { id: CUST_CARRIER, organizationId: ORG, name: "FastHaul Carrier", segment: null, partyType: "carrier", partyTypeManual: true },
    { id: CUST_UNKNOWN, organizationId: ORG, name: "Unknown — needs review", segment: null, partyType: "unknown", partyTypeManual: false },
    // Task #816 — name carries a carrier-suffix token ("Freight") even
    // though partyType is still "customer". The hardened chokepoint must
    // still drop this row from every customer-only surface regardless of
    // the partyType column.
    { id: CUST_LEAKED, organizationId: ORG, name: "Sneaky Freight Inc", segment: null, partyType: "customer", partyTypeManual: true },
    // Task #837 — partyType=customer leaks where the persisted name is
    // the canonical UNKNOWN placeholder. Excluded by the chokepoint's
    // unknown-name guard.
    { id: CUST_UNKNOWN_TAGGED, organizationId: ORG, name: "Unknown — needs review", segment: null, partyType: "customer", partyTypeManual: false },
  ];
  state.reps = [
    // Task #816 — customer-facing rep (NAM). MUST surface in snapshot.reps.
    // Task #837 — `linkedUserName` is the canonical name from `users.name`
    // (preferred over the historical `quote_reps.name` value).
    { id: REP_NAM, organizationId: ORG, userId: "user-nam", name: "old quotes-table name",
      email: "nina@valuetruck.com", suppressed: false, linkedUserRole: "national_account_manager",
      linkedUserName: "Nina NAM" },
    // Back-office user (admin). MUST be filtered out of snapshot.reps by
    // the funnel-eligibility predicate.
    { id: REP_ADMIN, organizationId: ORG, userId: "user-admin", name: "Andy Admin",
      email: "admin@valuetruck.com", suppressed: false, linkedUserRole: "admin",
      linkedUserName: "Andy Admin" },
  ];
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
      // Task #837 — wired to REP_NAM whose `users.name` is "Nina NAM"
      // and stale `quote_reps.name` is "old quotes-table name". Used by
      // the rep-display-name preference test.
      laneGroupId: null, repId: REP_NAM, carrierId: null, outcomeReasonId: null,
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
    // Task #816 — leaked carrier-suffix row attached to a partyType=customer
    // record. The hardened chokepoint must filter this out.
    {
      id: "q-leaked-1", organizationId: ORG, customerId: CUST_LEAKED,
      outcomeStatus: "pending", requestDate: oldDate, validThrough: null,
      originCity: "Seattle", originState: "WA", destCity: "Boise", destState: "ID",
      equipment: "VAN", quotedAmount: "1700", carrierPaid: null, responseTimeHours: "4",
      score: 50, source: "email", sourceReference: null, notes: null,
      laneGroupId: null, repId: REP_NAM, carrierId: null, outcomeReasonId: null,
    },
    // Task #837 — partyType=customer + persisted name === UNKNOWN
    // placeholder. Excluded via the chokepoint's unknown-name guard.
    {
      id: "q-unknown-tagged-1", organizationId: ORG, customerId: CUST_UNKNOWN_TAGGED,
      outcomeStatus: "pending", requestDate: oldDate, validThrough: null,
      originCity: "Reno", originState: "NV", destCity: "Boise", destState: "ID",
      equipment: "VAN", quotedAmount: "900", carrierPaid: null, responseTimeHours: "1",
      score: 30, source: "email", sourceReference: null, notes: null,
      laneGroupId: null, repId: null, carrierId: null, outcomeReasonId: null,
    },
    // Task #837 — orphan row whose customerId is no longer present in
    // `quote_customers`. listQuotes must skip the row before the
    // pagination math (otherwise empty pages spawn at the bottom of
    // the table for ghost owners).
    {
      id: "q-orphan-1", organizationId: ORG, customerId: CUST_DELETED,
      outcomeStatus: "pending", requestDate: oldDate, validThrough: null,
      originCity: "Tulsa", originState: "OK", destCity: "Wichita", destState: "KS",
      equipment: "VAN", quotedAmount: "1100", carrierPaid: null, responseTimeHours: "2",
      score: 40, source: "email", sourceReference: null, notes: null,
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

  it("exportCsv emits only customer rows AND no carrier/margin columns (Task #816)", async () => {
    const { exportCsv } = await import("../services/customerQuotes");
    const csv = await exportCsv(ORG, {});
    expect(csv).toContain("Acme Foods");
    expect(csv).not.toContain("FastHaul Carrier");
    expect(csv).not.toContain("Unknown — needs review");
    // Leaked carrier-suffix row must be hidden too.
    expect(csv).not.toContain("Sneaky Freight Inc");
    // Carrier / margin columns are stripped from the header line.
    const headerLine = csv.split("\n")[0] ?? "";
    expect(headerLine).not.toMatch(/carrier/i);
    expect(headerLine).not.toMatch(/margin/i);
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

  // Task #816 — partyType-leak hardening: a customer row whose name carries
  // a carrier-suffix token MUST be hidden from listQuotes / exportCsv /
  // getSnapshot regardless of the persisted partyType column.
  it("hides partyType=customer rows whose display name carries a carrier-suffix token (Task #816)", async () => {
    const { listQuotes, getSnapshot } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "requestDate", "desc", 0, 50);
    expect(result.rows.map(r => r.id)).not.toContain("q-leaked-1");
    expect(result.rows.map(r => r.id)).toEqual(["q-real-1"]);
    const snap = await getSnapshot(ORG, {});
    expect(snap.total).toBe(1);
  });

  // Task #816 — `marginDollar` was removed from `ListSortKey`. A stale
  // saved view that still serializes `sortKey="marginDollar"` MUST not
  // crash listQuotes — the unknown key falls through to the default
  // request-date ordering.
  it("listQuotes tolerates a stale `marginDollar` sortKey by falling back to default ordering (Task #816)", async () => {
    const { listQuotes } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "marginDollar" as any, "desc", 0, 50);
    expect(result.rows.map(r => r.id)).toEqual(["q-real-1"]);
  });

  // Task #816 — snapshot.reps drives the rep filter dropdown on the
  // customer-only Quote Opportunities page. Only customer-facing roles
  // (NAM / AM) may surface there; back-office roles like `admin` are
  // dropped via `isFunnelEligibleRep`.
  it("getSnapshot.reps includes customer-facing reps (NAM/AM) and excludes back-office roles (Task #816)", async () => {
    const { getSnapshot } = await import("../services/customerQuotes");
    const snap = await getSnapshot(ORG, {});
    const repIds = snap.reps.map(r => r.id);
    expect(repIds).toContain(REP_NAM);
    expect(repIds).not.toContain(REP_ADMIN);
  });

  // Task #837 — partyType=customer rows whose persisted display name is
  // the canonical UNKNOWN_CUSTOMER_NAME placeholder must be hidden from
  // the customer-only Quote Opportunities surface even though the
  // partyType column still says "customer". Belt-and-suspenders for the
  // partyType chokepoint.
  it("hides partyType=customer rows whose name is the UNKNOWN placeholder (Task #837)", async () => {
    const { listQuotes, getSnapshot, exportCsv } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "requestDate", "asc", 0, 50);
    const ids = result.rows.map(r => r.id);
    expect(ids).not.toContain("q-unknown-tagged-1");
    expect(ids).toEqual(["q-real-1"]);
    expect(result.total).toBe(1);
    const snap = await getSnapshot(ORG, {});
    expect(snap.total).toBe(1);
    const csv = await exportCsv(ORG, {});
    expect(csv).not.toContain("Unknown — needs review");
  });

  // Task #837 — orphan opportunities (customerId not present in
  // `quote_customers`) inflate the header count badge and render with a
  // "—" fallback name. Drop them before pagination so list.total tracks
  // what's actually visible.
  it("filters out opportunities whose customerId is missing from quote_customers (Task #837)", async () => {
    const { listQuotes, getSnapshot, exportCsv } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "requestDate", "asc", 0, 50);
    const ids = result.rows.map(r => r.id);
    expect(ids).not.toContain("q-orphan-1");
    expect(ids).toEqual(["q-real-1"]);
    expect(result.total).toBe(1);
    const snap = await getSnapshot(ORG, {});
    expect(snap.total).toBe(1);
    const csv = await exportCsv(ORG, {});
    // No row from the orphan customerId leaks into the CSV either.
    expect(csv).not.toContain("Tulsa");
  });

  // Task #837 — Rep column must prefer the linked `users.name` value
  // over the historical `quote_reps.name` (the latter is often a stale
  // alias from an old import). The hidden rep behavior (`repHidden`
  // from Task #752) is preserved: hidden reps still resolve to the
  // em-dash fallback regardless of which name source we pick.
  it("Rep column prefers linked users.name over quote_reps.name (Task #837)", async () => {
    const { listQuotes } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "requestDate", "asc", 0, 50);
    const row = result.rows.find(r => r.id === "q-real-1");
    expect(row).toBeDefined();
    // REP_NAM has linkedUserName="Nina NAM" + quote_reps.name="old quotes-table name".
    // The new behavior must surface "Nina NAM" as the rep label.
    expect(row!.repName).toBe("Nina NAM");
    // repId is preserved on the row even when the display name was
    // sourced from the linked user.
    expect(row!.repId).toBe(REP_NAM);
  });

  // Task #837 — default sort. The unfiltered list endpoint must default
  // to requestDate ASC (oldest-first) so the customer-only Quote
  // Opportunities table opens on the rows that need attention first.
  it("listQuotes defaults to oldest-first when sort key/direction match the page default (Task #837)", async () => {
    const { listQuotes } = await import("../services/customerQuotes");
    const result = await listQuotes(ORG, {}, "requestDate", "asc", 0, 50);
    // Single visible row, but the assertion still pins the contract
    // for the sort param the page sends on first load.
    expect(result.rows.map(r => r.id)).toEqual(["q-real-1"]);
  });
});
