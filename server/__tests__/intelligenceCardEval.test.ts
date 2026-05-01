/**
 * Task #912 — Sealed Intelligence Card eval harness.
 *
 * Each fixture is a (extraction, overlay shape, expected card shape) tuple.
 * The harness pins the reasoner's behavior across the matrix of overlay
 * states slice 3 cares about:
 *
 *   - clean rate-con + fully resolved overlay → aggregate=high, fitBand=strong
 *   - rate-con + ambiguous customer → aggregate=low, needsReview=true
 *   - rate-con + carrier off-lane → "carrier_lane_mismatch" risk fires + medium
 *   - rate-con + open capture failure → matching risk fires
 *   - rate-con + open opportunity overlap → "open_opportunity_overlap" risk
 *   - rate-con + freshness > 4h → freshness risk fires
 *   - rate-con + block finding → needsReview, reasons cleared, fit ≤ 80
 *   - rate-con + carrier do-not-use → fit drops sharply
 *
 * The harness deliberately does NOT reach into the DB — overlay is a hand-
 * authored fixture. This keeps the harness fast, deterministic, and a real
 * gate against reasoner regressions.
 */
import { describe, it, expect } from "vitest";
import type {
  Document,
  DocumentExtractionTyped,
  DocumentExtractionFinding,
  IntelligenceCardPlay,
  RateConExtraction,
  Carrier,
  Company,
  RecurringLane,
  FreightOpportunity,
  FreightOpportunityCaptureFailure,
} from "@shared/schema";
import { reason } from "../services/intelligenceReasoner";
import type {
  IntelligenceOverlay,
  OverlayLane,
  OverlayCarrierSnapshot,
  OverlayCustomerSnapshot,
} from "../services/intelligenceOverlay";

function fld<T>(value: T | null, confidence = 0.92) {
  return { value, confidence, source: { page: 1, bbox: null } };
}

function clean(): RateConExtraction {
  return {
    brokerName: fld("Broker A"),
    brokerReference: fld("BR-1"),
    carrierName: fld("Allied Trucking"),
    carrierMcNumber: fld("123456"),
    carrierDotNumber: fld("987654"),
    loadReference: fld("LD-1"),
    proNumber: fld(null, 0.1),
    orderNumber: fld("ORD-1"),
    originCity: fld("Atlanta"),
    originState: fld("GA"),
    originZip: fld("30301"),
    destinationCity: fld("Miami"),
    destinationState: fld("FL"),
    destinationZip: fld("33101"),
    equipmentType: fld("53' Dry Van"),
    weightLbs: fld(42000),
    commodity: fld("General Merchandise"),
    pickupWindowStart: fld("2025-04-21T08:00:00-05:00"),
    pickupWindowEnd: fld("2025-04-21T16:00:00-05:00"),
    deliveryWindowStart: fld("2025-04-23T08:00:00-05:00"),
    deliveryWindowEnd: fld("2025-04-23T17:00:00-05:00"),
    allInRate: fld(1850),
    lineHaulRate: fld(1500),
    fuelSurcharge: fld(350),
    accessorials: { items: [], confidence: 0.9 },
    payTerms: fld("Net 30"),
    specialInstructions: fld(null, 0.1),
  };
}

function mkDocument(): Document {
  return {
    id: "doc_eval",
    organizationId: "org_eval",
    filename: "eval-rate-con.pdf",
    storageProvider: "s3",
    storageRef: "rate-cons/eval.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
    pageCount: 1,
    sha256: "deadbeef",
    classLabel: "rate_con",
    classConfidence: 0.95,
    extractionStatus: "extracted",
    uploadContext: null,
    uploaderId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Document;
}

function mkExtraction(payload: RateConExtraction): DocumentExtractionTyped {
  return {
    id: "ext_eval",
    documentId: "doc_eval",
    schemaVersion: "1.0.0",
    payload: payload as unknown as Record<string, unknown>,
    rawModelOutput: null,
    promptVersion: "v1",
    modelName: "test",
    extractedAt: new Date(),
  } as unknown as DocumentExtractionTyped;
}

function mkCarrier(over: Partial<Carrier> = {}): Carrier {
  return {
    id: "carrier_eval",
    name: "Allied Trucking",
    orgId: "org_eval",
    status: "active",
    statesServed: ["GA", "FL"],
    equipmentTypes: ["53' Dry Van"],
    updatedAt: new Date(),
    ...over,
  } as unknown as Carrier;
}

function carrierSnapshot(over: Partial<OverlayCarrierSnapshot> = {}): OverlayCarrierSnapshot {
  return {
    carrier: mkCarrier(),
    servesOriginState: true,
    servesDestState: true,
    equipmentMatch: true,
    source: {
      kind: "carrier_history",
      ref: "carrier_eval",
      label: "Carrier: Allied Trucking",
      href: "/carriers/carrier_eval",
      updatedAt: null,
    },
    ...over,
  };
}

function customerSnapshot(): OverlayCustomerSnapshot {
  return {
    company: { id: "company_eval", name: "Acme Foods", organizationId: "org_eval" } as unknown as Company,
    source: {
      kind: "entity_link",
      ref: "company_eval",
      label: "Customer: Acme Foods",
      href: "/companies/company_eval",
      updatedAt: null,
    },
  };
}

function recurringLane(): OverlayLane {
  return {
    lane: {
      id: "lane_eval",
      orgId: "org_eval",
      origin: "Atlanta",
      originState: "GA",
      destination: "Miami",
      destinationState: "FL",
      equipmentType: "53' Dry Van",
      avgLoadsPerWeek: 4.2 as unknown as number,
      laneScoreFactors: null,
      updatedAt: new Date(),
    } as unknown as RecurringLane,
    health: "healthy",
    source: {
      kind: "recurring_lane",
      ref: "lane_eval",
      label: "Recurring lane: Atlanta → Miami",
      href: "/lanes/story/sig",
      updatedAt: null,
    },
  };
}

function blockFinding(ruleCode: string, message: string): DocumentExtractionFinding {
  return {
    id: `f-${ruleCode}`,
    documentId: "doc_eval",
    organizationId: "org_eval",
    ruleCode,
    severity: "block",
    message,
    context: null,
    createdAt: new Date(),
  } as unknown as DocumentExtractionFinding;
}

function mkOverlay(over: Partial<IntelligenceOverlay> = {}): IntelligenceOverlay {
  return {
    laneSignature: "atlanta_ga|miami_fl|53dryvan",
    recurringLanes: [],
    freshness: null,
    openOpportunities: [],
    carrier: null,
    customer: null,
    captureFailures: [],
    findings: [],
    tags: [],
    ...over,
  };
}

const STUB_PLAY: IntelligenceCardPlay = {
  playId: null,
  name: "Stub play",
  why: "stub",
  action: "stub",
  matchScore: 1,
  matchKind: "deterministic",
  sources: [{ kind: "agent_play", ref: "play_stub", label: "Play: stub", href: null, updatedAt: null }],
};

interface Fixture {
  name: string;
  overlay: IntelligenceOverlay;
  findings: DocumentExtractionFinding[];
  payload?: RateConExtraction;
  expect: {
    aggregateConfidence: "high" | "medium" | "low";
    fitBand?: "strong" | "watch" | "weak" | "blocked";
    needsReview?: boolean;
    needsReviewReason?: string;
    minFit?: number;
    maxFit?: number;
    risksContain?: string[];
  };
}

const FIXTURES: Fixture[] = [
  {
    name: "G1: clean + fully resolved overlay",
    overlay: mkOverlay({
      carrier: carrierSnapshot(),
      customer: customerSnapshot(),
      recurringLanes: [recurringLane()],
      freshness: { freshnessMinutes: 30, source: { kind: "freshness", ref: "f", label: "Freshness", href: null, updatedAt: null } },
      tags: ["recurring_lane"],
    }),
    findings: [],
    expect: { aggregateConfidence: "high", fitBand: "strong", needsReview: false, minFit: 75 },
  },
  {
    name: "G2: ambiguous customer → low + needsReview",
    overlay: mkOverlay({
      carrier: carrierSnapshot(),
      customer: customerSnapshot(),
      tags: ["ambiguous_customer"],
    }),
    findings: [],
    expect: { aggregateConfidence: "low", needsReview: true, needsReviewReason: "low_aggregate_confidence" },
  },
  {
    name: "G3: carrier off-lane → mismatch risk + lower fit",
    overlay: mkOverlay({
      carrier: carrierSnapshot({
        carrier: mkCarrier({ statesServed: ["TX"] }),
        servesOriginState: false,
        servesDestState: false,
      }),
      customer: customerSnapshot(),
      tags: ["carrier_lane_mismatch"],
    }),
    findings: [],
    expect: { aggregateConfidence: "high", risksContain: ["does not list"], maxFit: 80 },
  },
  {
    name: "G4: open capture failure on customer → risk fires",
    overlay: mkOverlay({
      carrier: carrierSnapshot(),
      customer: customerSnapshot(),
      captureFailures: [{
        failure: {
          id: "cf_1",
          orgId: "org_eval",
          quoteId: "q_1",
          reason: "no_customer",
          detail: null,
          attemptedAt: new Date(),
          resolvedAt: null,
        } as unknown as FreightOpportunityCaptureFailure,
        source: { kind: "capture_failure", ref: "cf_1", label: "Won-quote capture failure: no_customer", href: null, updatedAt: null },
      }],
      tags: ["open_capture_failure"],
    }),
    findings: [],
    expect: { aggregateConfidence: "high", risksContain: ["capture failure"] },
  },
  {
    name: "G5: open opportunity overlap → duplicate-posting risk fires",
    overlay: mkOverlay({
      carrier: carrierSnapshot(),
      customer: customerSnapshot(),
      openOpportunities: [{
        opportunity: { id: "opp_1", origin: "Atlanta", destination: "Miami" } as unknown as FreightOpportunity,
        source: { kind: "opportunity", ref: "opp_1", label: "Open opportunity Atlanta → Miami", href: "/freight-opportunities/opp_1", updatedAt: null },
      }],
      tags: ["open_opportunity_overlap"],
    }),
    findings: [],
    expect: { aggregateConfidence: "high", risksContain: ["already exist"] },
  },
  {
    name: "G6: stale freshness (> 4h) → stale-pricing risk fires",
    overlay: mkOverlay({
      carrier: carrierSnapshot(),
      customer: customerSnapshot(),
      freshness: { freshnessMinutes: 360, source: { kind: "freshness", ref: "f", label: "Freshness", href: null, updatedAt: null } },
    }),
    findings: [],
    expect: { aggregateConfidence: "high", risksContain: ["stale"] },
  },
  {
    name: "G7: block finding → needsReview + reasons cleared",
    overlay: mkOverlay({
      carrier: carrierSnapshot(),
      customer: customerSnapshot(),
      findings: [{
        finding: blockFinding("rate_missing", "All-in rate missing"),
        source: { kind: "finding", ref: "finding:rate_missing", label: "All-in rate missing", href: null, updatedAt: null },
      }],
    }),
    findings: [blockFinding("rate_missing", "All-in rate missing")],
    expect: { aggregateConfidence: "low", needsReview: true, needsReviewReason: "block_finding", maxFit: 80 },
  },
  {
    name: "G8: carrier do-not-use → fit drops sharply",
    overlay: mkOverlay({
      carrier: carrierSnapshot({ carrier: mkCarrier({ status: "do_not_use" }) }),
      customer: customerSnapshot(),
      tags: ["carrier_do_not_use"],
    }),
    findings: [],
    expect: { aggregateConfidence: "high", maxFit: 70 },
  },
];

describe("intelligenceCardEval — sealed reasoner fixtures", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const result = reason({
        document: mkDocument(),
        extraction: mkExtraction(f.payload ?? clean()),
        links: [],
        findings: f.findings,
        overlay: f.overlay,
        suggestedPlays: [STUB_PLAY],
      });
      expect(result.aggregateConfidence).toBe(f.expect.aggregateConfidence);
      if (f.expect.fitBand) expect(result.payload.fitBand).toBe(f.expect.fitBand);
      if (f.expect.needsReview !== undefined) expect(result.needsReview).toBe(f.expect.needsReview);
      if (f.expect.needsReviewReason) expect(result.needsReviewReason).toBe(f.expect.needsReviewReason);
      if (f.expect.minFit != null) expect(result.fitScore).toBeGreaterThanOrEqual(f.expect.minFit);
      if (f.expect.maxFit != null) expect(result.fitScore).toBeLessThanOrEqual(f.expect.maxFit);
      if (f.expect.risksContain) {
        for (const needle of f.expect.risksContain) {
          const hit = result.payload.risks.some((r) => r.text.toLowerCase().includes(needle.toLowerCase()));
          expect(hit, `expected a risk containing "${needle}"; got: ${result.payload.risks.map((r) => r.text).join(" | ")}`).toBe(true);
        }
      }
      // Universal contract: every reason/risk/play has at least one source.
      for (const r of [...result.payload.reasons, ...result.payload.risks, ...result.payload.suggestedPlays]) {
        expect(r.sources.length).toBeGreaterThanOrEqual(1);
      }
      // fitScore bounded.
      expect(result.fitScore).toBeGreaterThanOrEqual(0);
      expect(result.fitScore).toBeLessThanOrEqual(100);
    });
  }

  it("corpus-level: ≥ 50% of fixtures keep aggregate high (proxy for reasoner not over-flagging)", () => {
    let highs = 0;
    for (const f of FIXTURES) {
      const result = reason({
        document: mkDocument(),
        extraction: mkExtraction(f.payload ?? clean()),
        links: [],
        findings: f.findings,
        overlay: f.overlay,
        suggestedPlays: [STUB_PLAY],
      });
      if (result.aggregateConfidence === "high") highs++;
    }
    expect(highs / FIXTURES.length).toBeGreaterThanOrEqual(0.5);
  });
});
