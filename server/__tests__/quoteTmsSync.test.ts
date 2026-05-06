import { describe, it, expect } from "vitest";
import {
  decideSyncAction,
  customerMatchTier,
  normalizeCity,
  normalizeCustomerName,
} from "../services/quoteTmsSync";
import type { LoadFact, QuoteOpportunity } from "@shared/schema";

function fact(over: Partial<LoadFact> = {}): LoadFact {
  return {
    id: "f1",
    orgId: "org1",
    orderId: "ORD-100",
    companyId: null,
    customerName: "Acme Logistics",
    carrierName: "Best Carrier",
    carrierPayeeCode: null,
    originCity: "Dallas",
    originState: "TX",
    originZip: null,
    destinationCity: "Atlanta",
    destinationState: "GA",
    destinationZip: null,
    accountManager: null,
    dispatcher: null,
    equipmentType: "Van",
    pickupDate: "2026-04-20",
    deliveryDate: null,
    pickupApptStart: null,
    pickupApptEnd: null,
    deliveryApptStart: null,
    deliveryApptEnd: null,
    arrivedAtPickup: null,
    arrivedAtDelivery: null,
    totalStops: null,
    totalMiles: null,
    month: "2026-04",
    moveStatus: "delivered",
    bucket: "realized",
    revenue: "2000.00",
    cost: "1700.00",
    margin: "300.00",
    marginPct: "0.15",
    loadCount: 1,
    rawRow: null,
    sourceFileName: null,
    sourceKind: "powerbi",
    importedAt: new Date(),
    lastChangedAt: new Date(),
    lastSeenAt: new Date(),
    expiredAt: null,
    ...over,
  } as LoadFact;
}

function opp(over: Partial<QuoteOpportunity> = {}): QuoteOpportunity {
  return {
    id: "q1",
    organizationId: "org1",
    customerId: "c1",
    repId: null,
    laneGroupId: null,
    carrierId: null,
    outcomeReasonId: null,
    requestDate: new Date("2026-04-19T00:00:00Z"),
    originCity: "Dallas",
    originState: "TX",
    destCity: "Atlanta",
    destState: "GA",
    equipment: "Van",
    quotedAmount: "2000.00",
    validThrough: new Date("2026-05-01T00:00:00Z"),
    outcomeStatus: "pending",
    carrierPaid: null,
    responseTimeHours: null,
    source: "email",
    sourceReference: null,
    notes: null,
    score: null,
    createdAt: new Date(),
    ...over,
  } as QuoteOpportunity;
}

const NOW = new Date("2026-04-23T00:00:00Z").getTime();

describe("decideSyncAction", () => {
  it("matches by sourceReference orderId and returns won when bucket=realized", () => {
    const o = opp({ sourceReference: "ORD-100" });
    const d = decideSyncAction(o, "Acme Logistics", [fact()], NOW);
    expect(d.kind).toBe("won");
    if (d.kind === "won") {
      expect(d.lowMargin).toBe(false);
      expect(d.cost).toBe(1700);
      expect(d.revenue).toBe(2000);
    }
  });

  it("flags low margin when margin/quoted < 6%", () => {
    const o = opp({ sourceReference: "ORD-100", quotedAmount: "1800.00" });
    const f = fact({ cost: "1750.00", revenue: "1800.00" });
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("won");
    if (d.kind === "won") expect(d.lowMargin).toBe(true);
  });

  it("returns lost when matched bucket=cancelled", () => {
    const f = fact({ bucket: "cancelled", moveStatus: "cancelled" });
    const o = opp({ sourceReference: "ORD-100" });
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("lost");
    if (d.kind === "lost") expect(d.match.bucket).toBe("cancelled");
  });

  it("returns expired when validThrough has passed and no TMS match", () => {
    const o = opp({ validThrough: new Date("2026-04-01T00:00:00Z") });
    const d = decideSyncAction(o, "Acme Logistics", [], NOW);
    expect(d.kind).toBe("expired");
  });

  it("returns unchanged when no match and validThrough in the future", () => {
    const o = opp();
    const d = decideSyncAction(o, "Acme Logistics", [], NOW);
    expect(d.kind).toBe("unchanged");
  });

  it("falls back to lane+customer+pickup-window matching when sourceReference is null", () => {
    const o = opp(); // no sourceReference
    const d = decideSyncAction(o, "Acme Logistics Inc", [fact()], NOW);
    expect(d.kind).toBe("won");
  });

  it("does not auto-flip when pickupDate is more than 14 days from requestDate", () => {
    // Task #723: outside-window matches now surface as "probable" so the
    // diagnostics panel can show them — but they MUST NOT auto-flip the
    // pending quote to won/lost.
    const f = fact({ pickupDate: "2026-06-01" });
    const o = opp(); // requestDate 2026-04-19
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).not.toBe("won");
    expect(d.kind).not.toBe("lost");
  });

  it("does not match when lane differs", () => {
    const f = fact({ destinationCity: "Memphis", destinationState: "TN" });
    const o = opp();
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("unchanged");
  });

  it("ignores active/available buckets even when matched", () => {
    const f = fact({ bucket: "active" });
    const o = opp({ sourceReference: "ORD-100" });
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    // Task #723: orderId-only match outside the realized/cancelled buckets
    // is still strong enough to surface as "probable" so admins can see it
    // in the diagnostics panel — but it MUST NOT auto-flip the quote.
    expect(d.kind).not.toBe("won");
    expect(d.kind).not.toBe("lost");
  });
});

// ─── Task #723 — alias / city / date-window matching + probable tier ─────────

describe("Task #723 — TMS matcher tolerance", () => {
  describe("normalizeCustomerName", () => {
    it("strips Inc / LLC / Corp", () => {
      expect(normalizeCustomerName("Acme Logistics Inc")).toBe("acme logistics");
      expect(normalizeCustomerName("Acme Logistics, LLC")).toBe("acme logistics");
      expect(normalizeCustomerName("Acme Corp")).toBe("acme");
    });
    it("strips a leading 'The'", () => {
      expect(normalizeCustomerName("The Acme Group")).toBe("acme");
    });
    it("collapses whitespace and punctuation", () => {
      expect(normalizeCustomerName("  ACME-Foods  ")).toBe("acme foods");
    });
  });

  describe("normalizeCity", () => {
    it("treats 'Saint Louis' and 'St. Louis' the same", () => {
      expect(normalizeCity("Saint Louis")).toBe(normalizeCity("St. Louis"));
      expect(normalizeCity("Saint Louis")).toBe(normalizeCity("st louis"));
    });
  });

  describe("customerMatchTier", () => {
    it("returns 'exact' for case-insensitive equality", () => {
      expect(customerMatchTier("Acme Logistics", fact({ customerName: "ACME LOGISTICS" }))).toBe("exact");
    });
    it("returns 'alias' when only legal suffix differs", () => {
      expect(customerMatchTier("Acme Logistics", fact({ customerName: "Acme Logistics, Inc." }))).toBe("alias");
    });
    it("returns 'none' when names truly differ", () => {
      expect(customerMatchTier("Acme Logistics", fact({ customerName: "Globex" }))).toBe("none");
    });
  });

  it("auto-flips on alias customer match (Inc vs. plain)", () => {
    const o = opp(); // requestDate 2026-04-19, no sourceReference
    const f = fact({ customerName: "Acme Logistics, Inc." });
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("won");
    if (d.kind === "won") expect(d.matchTier).toBe("alias");
  });

  it("auto-flips when origin city differs only by Saint vs. St. spelling", () => {
    const f = fact({ originCity: "Saint Louis", originState: "MO" });
    const o = opp({ originCity: "St. Louis", originState: "MO" });
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("won");
  });

  it("returns 'probable' (NOT won/lost) when pickup is just outside the date window", () => {
    // requestDate = 2026-04-19; pickup 2026-05-10 = 21 days out, beyond the
    // 14-day default window but with same customer + lane.
    const f = fact({ pickupDate: "2026-05-10" });
    const o = opp();
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("probable");
    if (d.kind === "probable") {
      expect(d.reason).toBe("outside-date-window");
      expect(d.match.id).toBe(f.id);
    }
  });

  it("returns 'probable' when an alias-matched load is still active in the TMS", () => {
    const f = fact({ bucket: "active", customerName: "Acme Logistics, LLC" });
    const o = opp(); // no sourceReference, in-window pickup
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("probable");
    if (d.kind === "probable") expect(d.reason).toBe("still-active-in-tms");
  });

  it("respects the QUOTE_TMS_MATCH_WINDOW_DAYS override via opts.matchWindowDays", () => {
    // Same case as the "outside-date-window" probable test, but bumping the
    // window to 30 days flips it back to a confident "won".
    const f = fact({ pickupDate: "2026-05-10" });
    const o = opp();
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW, { matchWindowDays: 30 });
    expect(d.kind).toBe("won");
  });

  it("does NOT downgrade an exact in-window match to 'probable'", () => {
    // Exact match should still win; probable is only the fallback path.
    const f = fact();
    const o = opp();
    const d = decideSyncAction(o, "Acme Logistics", [f], NOW);
    expect(d.kind).toBe("won");
  });
});
