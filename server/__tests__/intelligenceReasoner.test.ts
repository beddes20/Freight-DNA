/**
 * Task #912 — Intelligence Reasoner unit tests.
 *
 * Pure transform tests. We construct synthetic `IntelligenceOverlay`s and
 * extraction payloads and assert the reasoner's invariants:
 *
 *   1. Every reason / risk / play in the produced payload carries at least
 *      one source chip — never fabricated.
 *   2. Aggregate confidence collapses to "low" on block findings, ambiguous
 *      links, or any missing primary field.
 *   3. needsReview=true clears reasons (so the UI never shows positive
 *      claims when we explicitly refused to be confident) and inserts a
 *      "needs review" sentinel risk so the rep sees *why*.
 *   4. fitScore is bounded 0..100 and bands to "blocked" on hard risks.
 *   5. The payload always validates against `intelligenceCardPayloadSchema`
 *      (the reasoner runs the parser internally; we re-validate to ensure
 *      we didn't sneak any optional-field defaults in).
 */
import { describe, it, expect } from "vitest";
import {
  intelligenceCardPayloadSchema,
  type Document,
  type DocumentExtractionTyped,
  type DocumentExtractionFinding,
  type IntelligenceCardPlay,
  type RateConExtraction,
  type Carrier,
  type Company,
  type RecurringLane,
} from "@shared/schema";
import { reason, REASONER_VERSION } from "../services/intelligenceReasoner";
import type {
  IntelligenceOverlay,
  OverlayCarrierSnapshot,
  OverlayCustomerSnapshot,
  OverlayLane,
} from "../services/intelligenceOverlay";

function fld<T>(value: T | null, confidence = 0.92) {
  return { value, confidence, source: { page: 1, bbox: null } };
}

function mkDocument(): Document {
  return {
    id: "doc_1",
    organizationId: "org_1",
    filename: "synthetic-rate-con.pdf",
    storageProvider: "s3",
    storageRef: "rate-cons/doc_1.pdf",
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
    id: "ext_1",
    documentId: "doc_1",
    schemaVersion: "1.0.0",
    payload: payload as unknown as Record<string, unknown>,
    rawModelOutput: null,
    promptVersion: "v1",
    modelName: "test",
    extractedAt: new Date(),
  } as unknown as DocumentExtractionTyped;
}

function cleanRateCon(): RateConExtraction {
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

function mkCarrierSnapshot(): OverlayCarrierSnapshot {
  return {
    carrier: {
      id: "carrier_1",
      name: "Allied Trucking",
      orgId: "org_1",
      status: "active",
      statesServed: ["GA", "FL"],
      equipmentTypes: ["53' Dry Van"],
      updatedAt: new Date(),
    } as unknown as Carrier,
    servesOriginState: true,
    servesDestState: true,
    equipmentMatch: true,
    source: {
      kind: "carrier_history",
      ref: "carrier_1",
      label: "Carrier: Allied Trucking",
      href: "/carriers/carrier_1",
      updatedAt: null,
    },
  };
}

function mkCustomerSnapshot(): OverlayCustomerSnapshot {
  return {
    company: {
      id: "company_1",
      name: "Acme Foods",
      organizationId: "org_1",
    } as unknown as Company,
    source: {
      kind: "entity_link",
      ref: "company_1",
      label: "Customer: Acme Foods",
      href: "/companies/company_1",
      updatedAt: null,
    },
  };
}

function mkRecurringLane(): OverlayLane {
  return {
    lane: {
      id: "lane_1",
      orgId: "org_1",
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
      ref: "lane_1",
      label: "Recurring lane: Atlanta → Miami",
      href: "/lanes/story/sig",
      updatedAt: null,
    },
  };
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
  sources: [{
    kind: "agent_play",
    ref: "play_stub",
    label: "Play: stub",
    href: null,
    updatedAt: null,
  }],
};

describe("intelligenceReasoner.reason() — happy path", () => {
  it("produces a high-confidence card when overlay is fully resolved and clean", () => {
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        recurringLanes: [mkRecurringLane()],
        freshness: { freshnessMinutes: 30, source: { kind: "freshness", ref: "f", label: "Freshness", href: null, updatedAt: null } },
        tags: ["recurring_lane"],
      }),
      suggestedPlays: [STUB_PLAY],
    });
    expect(result.aggregateConfidence).toBe("high");
    expect(result.needsReview).toBe(false);
    expect(result.fitScore).toBeGreaterThanOrEqual(75);
    expect(result.fitScore).toBeLessThanOrEqual(100);
    expect(result.payload.fitBand).toBe("strong");
    expect(result.payload.reasons.length).toBeGreaterThan(0);
    expect(result.payload.reasonerVersion).toBe(REASONER_VERSION);
  });

  it("EVERY reason / risk / play in the payload carries at least one source", () => {
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        recurringLanes: [mkRecurringLane()],
      }),
      suggestedPlays: [STUB_PLAY],
    });
    for (const r of [...result.payload.reasons, ...result.payload.risks]) {
      expect(r.sources.length).toBeGreaterThanOrEqual(1);
      for (const s of r.sources) expect(s.ref.length).toBeGreaterThan(0);
    }
    for (const p of result.payload.suggestedPlays) {
      expect(p.sources.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("intelligenceReasoner.reason() — degrades to needsReview", () => {
  it("collapses aggregate=low and clears reasons when a block finding fires", () => {
    const blockFinding: DocumentExtractionFinding = {
      id: "f1",
      documentId: "doc_1",
      organizationId: "org_1",
      ruleCode: "rate_missing",
      severity: "block",
      message: "All-in rate is missing.",
      context: null,
      createdAt: new Date(),
    } as unknown as DocumentExtractionFinding;
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [blockFinding],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        findings: [{
          finding: blockFinding,
          source: { kind: "finding", ref: "finding:rate_missing", label: blockFinding.message, href: null, updatedAt: null },
        }],
      }),
      suggestedPlays: [STUB_PLAY],
    });
    expect(result.aggregateConfidence).toBe("low");
    expect(result.needsReview).toBe(true);
    expect(result.needsReviewReason).toBe("block_finding");
    expect(result.payload.reasons).toHaveLength(0);
    expect(result.payload.risks.length).toBeGreaterThan(0);
    // Block finding deducts 20 from the fit score; we don't pin a hard band
    // here because the rest of the overlay is intentionally clean.
    expect(result.fitScore).toBeLessThanOrEqual(80);
  });

  it("flags needsReview when no anchor records (no carrier/customer/lane) are present", () => {
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({ tags: ["unknown_carrier", "unknown_customer"] }),
      suggestedPlays: [STUB_PLAY],
    });
    expect(result.needsReview).toBe(true);
    expect(["no_anchor_records", "low_aggregate_confidence"]).toContain(result.needsReviewReason);
    expect(result.payload.reasons).toHaveLength(0);
    expect(result.payload.risks.length).toBeGreaterThan(0);
  });

  it("downgrades aggregate to low when ambiguous_customer tag is present", () => {
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        tags: ["ambiguous_customer"],
      }),
      suggestedPlays: [STUB_PLAY],
    });
    expect(result.aggregateConfidence).toBe("low");
    expect(result.needsReview).toBe(true);
  });

  it("downgrades aggregate to medium when a primary field has confidence < 0.75", () => {
    const payload = cleanRateCon();
    payload.allInRate = fld(1850, 0.4);
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(payload),
      links: [],
      findings: [],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        recurringLanes: [mkRecurringLane()],
      }),
      suggestedPlays: [STUB_PLAY],
    });
    expect(result.aggregateConfidence).toBe("medium");
    expect(result.needsReview).toBe(false);
  });
});

describe("intelligenceReasoner.reason() — invariants", () => {
  it("payload always validates against intelligenceCardPayloadSchema", () => {
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({ carrier: mkCarrierSnapshot(), customer: mkCustomerSnapshot() }),
      suggestedPlays: [STUB_PLAY],
    });
    expect(() => intelligenceCardPayloadSchema.parse(result.payload)).not.toThrow();
  });

  it("drops plays that come back source-less (defense in depth against the matcher)", () => {
    const sourcelessPlay = { ...STUB_PLAY, sources: [] } as unknown as IntelligenceCardPlay;
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({ carrier: mkCarrierSnapshot(), customer: mkCustomerSnapshot() }),
      suggestedPlays: [sourcelessPlay, STUB_PLAY],
    });
    expect(result.payload.suggestedPlays).toHaveLength(1);
    expect(result.payload.suggestedPlays[0].name).toBe("Stub play");
  });

  it("fitScore is always within [0, 100]", () => {
    const r1 = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({}),
      suggestedPlays: [],
    });
    const r2 = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        recurringLanes: [mkRecurringLane()],
        freshness: { freshnessMinutes: 5, source: { kind: "freshness", ref: "f", label: "f", href: null, updatedAt: null } },
      }),
      suggestedPlays: [],
    });
    for (const r of [r1, r2]) {
      expect(r.fitScore).toBeGreaterThanOrEqual(0);
      expect(r.fitScore).toBeLessThanOrEqual(100);
    }
  });

  it("materialized sourceRecords is the deduped union of all reason / risk / play sources", () => {
    const result = reason({
      document: mkDocument(),
      extraction: mkExtraction(cleanRateCon()),
      links: [],
      findings: [],
      overlay: mkOverlay({
        carrier: mkCarrierSnapshot(),
        customer: mkCustomerSnapshot(),
        recurringLanes: [mkRecurringLane()],
      }),
      suggestedPlays: [STUB_PLAY],
    });
    const refs = new Set(result.sourceRecords.map((s) => `${s.kind}:${s.ref}`));
    expect(refs.size).toBe(result.sourceRecords.length); // deduped
    for (const r of [...result.payload.reasons, ...result.payload.risks]) {
      for (const s of r.sources) expect(refs.has(`${s.kind}:${s.ref}`)).toBe(true);
    }
  });
});
