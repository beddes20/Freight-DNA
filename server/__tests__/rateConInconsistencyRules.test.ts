/**
 * Task #911 — rate-con inconsistency rule unit tests.
 *
 * The rules module is wired to Drizzle for the rules that need a DB
 * round-trip (rate_vs_quote, rate_vs_award, opportunity_closed,
 * carrier_off_bench when the carrier matched). The rules that DON'T
 * touch the DB — `transit_window`, `accessorial_tbd`, `pay_terms_long`,
 * `rate_missing`, and the `carrier_unknown` branch — are pure functions
 * over the typed payload + links and that's what we pin here.
 *
 * Strategy: hit the public entry point with `persist: false` so we get
 * the findings array back without writing anything, on a doc that has
 * NO carrier/quote/load/opportunity link. Only the pure rules fire.
 */
import { describe, it, expect } from "vitest";
import { runRateConInconsistencyRules } from "../services/rateConInconsistencyRules";
import type { RateConExtraction, DocumentEntityLink } from "@shared/schema";

function fld<T>(value: T | null, confidence = 0.9) {
  return { value, confidence, source: { page: 1, bbox: null } };
}

function basePayload(): RateConExtraction {
  return {
    brokerName: fld("ACME Brokerage"),
    brokerReference: fld(null, 0),
    carrierName: fld("Allied Trucking"),
    carrierMcNumber: fld("123456"),
    carrierDotNumber: fld(null, 0),
    loadReference: fld(null, 0),
    proNumber: fld(null, 0),
    orderNumber: fld(null, 0),
    originCity: fld("Atlanta"),
    originState: fld("GA"),
    originZip: fld("30301"),
    destinationCity: fld("Miami"),
    destinationState: fld("FL"),
    destinationZip: fld("33101"),
    equipmentType: fld("53' Dry Van"),
    weightLbs: fld(42000),
    commodity: fld("Mixed"),
    pickupWindowStart: fld("2025-04-21T08:00:00-05:00"),
    pickupWindowEnd: fld("2025-04-21T16:00:00-05:00"),
    deliveryWindowStart: fld("2025-04-23T08:00:00-05:00"),
    deliveryWindowEnd: fld("2025-04-23T17:00:00-05:00"),
    allInRate: fld(1850),
    lineHaulRate: fld(1500),
    fuelSurcharge: fld(350),
    accessorials: { items: [], confidence: 0.9 },
    payTerms: fld("Net 30"),
    specialInstructions: fld(null, 0),
  };
}

const NO_LINKS: DocumentEntityLink[] = [];

async function run(payload: RateConExtraction, links: DocumentEntityLink[] = NO_LINKS) {
  return runRateConInconsistencyRules({
    documentId: "doc-test",
    organizationId: "org-test",
    payload,
    links,
    persist: false,
  });
}

describe("rateConInconsistencyRules (Task #911)", () => {
  it("clean payload + no links → only carrier_unknown fires (no carrier match)", async () => {
    const findings = await run(basePayload());
    const codes = findings.map((f) => f.ruleCode).sort();
    // carrier_unknown fires because there's no carrier link AND we have a
    // carrier name + MC. Other DB-dependent rules can't fire without
    // links. Pure rules (transit/accessorial/pay_terms/rate_missing) all
    // pass on this clean payload.
    expect(codes).toContain("carrier_unknown");
    expect(codes).not.toContain("rate_missing");
    expect(codes).not.toContain("transit_window_invalid");
    expect(codes).not.toContain("transit_window_tight");
    expect(codes).not.toContain("accessorial_tbd");
    expect(codes).not.toContain("pay_terms_long");
  });

  it("rate_missing fires when allInRate is null", async () => {
    const p = basePayload();
    p.allInRate = fld(null, 0);
    const findings = await run(p);
    const rateMissing = findings.find((f) => f.ruleCode === "rate_missing");
    expect(rateMissing).toBeTruthy();
    expect(rateMissing?.severity).toBe("warn");
  });

  it("transit_window_invalid fires when delivery starts before pickup ends", async () => {
    const p = basePayload();
    p.pickupWindowEnd = fld("2025-04-23T17:00:00-05:00");
    p.deliveryWindowStart = fld("2025-04-21T08:00:00-05:00");
    const findings = await run(p);
    const f = findings.find((x) => x.ruleCode === "transit_window_invalid");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("warn");
  });

  it("transit_window_tight fires when transit < 12h but positive", async () => {
    const p = basePayload();
    p.pickupWindowEnd = fld("2025-04-21T16:00:00-05:00");
    p.deliveryWindowStart = fld("2025-04-21T22:00:00-05:00"); // 6h transit
    const findings = await run(p);
    const f = findings.find((x) => x.ruleCode === "transit_window_tight");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("warn");
  });

  it("accessorial_tbd fires when any line item has null/zero amount", async () => {
    const p = basePayload();
    p.accessorials = {
      items: [
        { description: "Detention", amount: null, confidence: 0.5 },
        { description: "Lumper", amount: 0, confidence: 0.5 },
        { description: "TONU", amount: 250, confidence: 0.9 },
      ],
      confidence: 0.7,
    };
    const findings = await run(p);
    const f = findings.find((x) => x.ruleCode === "accessorial_tbd");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("info");
    expect(f?.message).toContain("2 accessorial line items");
  });

  it("pay_terms_long fires for Net 60", async () => {
    const p = basePayload();
    p.payTerms = fld("Net 60");
    const findings = await run(p);
    const f = findings.find((x) => x.ruleCode === "pay_terms_long");
    expect(f).toBeTruthy();
    expect(f?.severity).toBe("warn");
  });

  it("pay_terms_long does NOT fire for Net 30 / Quickpay", async () => {
    const p = basePayload();
    p.payTerms = fld("Quickpay 2%/7");
    const findings = await run(p);
    expect(findings.find((x) => x.ruleCode === "pay_terms_long")).toBeUndefined();
  });

  it("carrier_unknown does NOT fire when neither carrier name nor MC is present", async () => {
    const p = basePayload();
    p.carrierName = fld(null, 0);
    p.carrierMcNumber = fld(null, 0);
    const findings = await run(p);
    expect(findings.find((x) => x.ruleCode === "carrier_unknown")).toBeUndefined();
  });

  it("findings emitted carry the documentId + organizationId from the call", async () => {
    const findings = await runRateConInconsistencyRules({
      documentId: "doc-XYZ",
      organizationId: "org-Q",
      payload: basePayload(),
      links: NO_LINKS,
      persist: false,
    });
    findings.forEach((f) => {
      expect(f.documentId).toBe("doc-XYZ");
      expect(f.organizationId).toBe("org-Q");
    });
  });
});
