/**
 * Task #911 — Rate-Con extractor REGRESSION harness.
 *
 * The synthetic eval (`rateConEval.test.ts`) pins the rule layer and
 * field-level confidence shape against typed fixtures. This file goes
 * one level deeper: it actually drives the live `extractRateCon()`
 * pipeline end-to-end against a fake LLM, validates that the persisted
 * payload round-trips through Zod, and computes per-field accuracy
 * against ground truth — the same bar the synthetic eval enforces, but
 * with the real extractor code path in the loop (idempotency check,
 * Zod parse on model output, calibration overrides, persistence call).
 *
 * Two scenarios:
 *   1. **Identity**: the fake LLM returns the fixture's ground-truth
 *      payload verbatim. Asserts mean field accuracy = 100% and
 *      `upsertDocumentExtraction` was called with `extractionStatus =
 *      "extracted"` and a payload that re-validates against
 *      `rateConExtractionSchema`.
 *   2. **Drift**: the fake LLM returns a perturbed payload (every
 *      confidence shifted by −0.5). Asserts the same per-field
 *      accuracy bar from the eval (mean ≥ 0.93) FAILS — proving the
 *      regression bar would actually catch a real model regression.
 *
 * If you swap in a real LLM later, replace `makeFakeOpenAI(...)` with
 * the real client and the asserts continue to gate.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  rateConExtractionSchema,
  RATE_CON_FIELD_PATHS,
  type RateConExtraction,
  type Document,
  type DocumentPage,
  type DocumentExtractionTyped,
} from "@shared/schema";

const upsertSpy = vi.fn();
const getDocSpy = vi.fn();
const getPagesSpy = vi.fn();
const getExtractionSpy = vi.fn();
const listOverridesSpy = vi.fn();

vi.mock("../storage", () => ({
  storage: {
    getDocumentInOrg: (...a: unknown[]) => getDocSpy(...a),
    getDocumentPages: (...a: unknown[]) => getPagesSpy(...a),
    upsertDocumentExtraction: (...a: unknown[]) => upsertSpy(...a),
    getDocumentExtraction: (...a: unknown[]) => getExtractionSpy(...a),
    listFieldConfidenceOverrides: (...a: unknown[]) => listOverridesSpy(...a),
  },
}));

import { extractRateCon } from "../services/rateConExtractor";

function fld<T>(value: T | null, confidence = 0.92) {
  return { value, confidence, source: { page: 1, bbox: null } };
}

function clean(name: string, overrides: Partial<RateConExtraction> = {}): RateConExtraction {
  const base: RateConExtraction = {
    brokerName: fld(`${name} Brokerage`),
    brokerReference: fld(`BR-${name.length}001`),
    carrierName: fld("Allied Trucking"),
    carrierMcNumber: fld("123456"),
    carrierDotNumber: fld("987654"),
    loadReference: fld(`LD-${name.length}9`),
    proNumber: fld(null, 0.1),
    orderNumber: fld(`ORD-${name.length}`),
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
  return { ...base, ...overrides };
}

// 5 representative ground-truth fixtures. Together they cover the leaf
// shapes the extractor must produce: clean, missing rate, transit
// invalid, accessorials present, and missing carrier id.
const GROUND_TRUTH: { name: string; payload: RateConExtraction }[] = [
  { name: "F1-clean", payload: clean("F1") },
  { name: "F6-missing-rate", payload: clean("F6", { allInRate: fld(null, 0.1), lineHaulRate: fld(null, 0.1), fuelSurcharge: fld(null, 0.1) }) },
  { name: "F8-transit-inverted", payload: clean("F8", { pickupWindowEnd: fld("2025-04-23T17:00:00-05:00"), deliveryWindowStart: fld("2025-04-22T08:00:00-05:00") }) },
  { name: "F12-accessorial-tbd", payload: clean("F12", { accessorials: { items: [{ description: "Detention", amount: null, confidence: 0.5 }], confidence: 0.6 } }) },
  { name: "F22-no-carrier-id", payload: clean("F22", { carrierName: fld(null, 0), carrierMcNumber: fld(null, 0), carrierDotNumber: fld(null, 0) }) },
];

const docFixture = (id: string): Document => ({
  id,
  organizationId: "org-eval",
  uploaderId: "user-uploader",
  filename: `${id}.pdf`,
  mimeType: "application/pdf",
  sizeBytes: 1024,
  storageProvider: "test",
  storageKey: `keys/${id}`,
  contentSha256: `sha-${id}`,
  classLabel: "rate_con",
  classLabelConfidence: "0.95",
  classLabelSource: "test",
  status: "parsed",
  sourceChannel: "manual",
  forwardedSubject: null,
  forwardedFromEmail: null,
  uploadContext: null,
  pageCount: 1,
  parsedAt: new Date(),
  failureReason: null,
  retryCount: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Document);

const pagesFixture = (id: string): DocumentPage[] => ([
  {
    id: `page-${id}`,
    documentId: id,
    organizationId: "org-eval",
    pageNumber: 1,
    text: `RATE CONFIRMATION ${id}\nCarrier ...\nOrigin ...\n`,
    textHash: `hash-${id}`,
    extractionMethod: "test",
    createdAt: new Date(),
  } as unknown as DocumentPage,
]);

function makeFakeOpenAI(responseFor: (model: string) => RateConExtraction) {
  // Duck-type the small surface area `callExtractor` actually touches.
  return {
    chat: {
      completions: {
        create: vi.fn(async (req: { model: string }) => {
          const payload = responseFor(req.model);
          return {
            choices: [{ message: { content: JSON.stringify(payload) } }],
          };
        }),
      },
    },
  } as unknown as Parameters<typeof extractRateCon>[0]["openaiOverride"];
}

function perturb(p: RateConExtraction): RateConExtraction {
  // Drop every numeric confidence by 0.5 (clamped) so confident-present
  // fields fall into the "neither confidently-present nor absent" zone.
  // Also flip a few values to wrong types … no, the schema would reject;
  // we want a payload that PARSES but degrades accuracy.
  const out = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    const leaf = out[key] as { value: unknown; confidence: number } | undefined;
    if (leaf && typeof leaf.confidence === "number") {
      leaf.confidence = Math.max(0, Math.min(1, leaf.confidence - 0.5));
    }
  }
  return out as unknown as RateConExtraction;
}

function scoreAccuracy(predicted: RateConExtraction, truth: RateConExtraction): { mean: number; perField: Record<string, number> } {
  const CONF_HIGH = 0.7;
  const CONF_LOW = 0.3;
  const perField: Record<string, number> = {};
  let total = 0;
  let correct = 0;
  for (const path of RATE_CON_FIELD_PATHS) {
    if (path === "accessorials") continue;
    const pLeaf = (predicted as unknown as Record<string, { value: unknown; confidence: number }>)[path];
    const tLeaf = (truth as unknown as Record<string, { value: unknown; confidence: number }>)[path];
    if (!pLeaf || !tLeaf) { perField[path] = 0; total++; continue; }
    const truthPresent = tLeaf.value != null && tLeaf.value !== "";
    const ok =
      truthPresent
        ? (pLeaf.value === tLeaf.value && pLeaf.confidence >= CONF_HIGH)
        : (pLeaf.value == null && pLeaf.confidence <= CONF_LOW);
    perField[path] = ok ? 1 : 0;
    if (ok) correct++;
    total++;
  }
  return { mean: total ? correct / total : 0, perField };
}

beforeEach(() => {
  upsertSpy.mockReset();
  getDocSpy.mockReset();
  getPagesSpy.mockReset();
  getExtractionSpy.mockReset();
  listOverridesSpy.mockReset();
  listOverridesSpy.mockResolvedValue([]);
  getExtractionSpy.mockResolvedValue(null);
  upsertSpy.mockImplementation(async (args: { payload: Record<string, unknown> }) => ({
    id: "ext-1",
    documentId: "doc",
    organizationId: "org-eval",
    classLabel: "rate_con",
    payloadVersion: 1,
    payload: args.payload,
    extractionStatus: "extracted",
    needsReviewReason: null,
    extractorModel: "test",
    extractedAt: new Date(),
    updatedAt: new Date(),
  } as DocumentExtractionTyped));
});

describe("rate-con extractor regression harness — live pipeline (Task #911)", () => {
  it("identity scenario: ground-truth in → mean field accuracy = 100%, payload re-validates", async () => {
    let totalMean = 0;
    for (const fx of GROUND_TRUTH) {
      const docId = `doc-${fx.name}`;
      getDocSpy.mockResolvedValueOnce(docFixture(docId));
      getPagesSpy.mockResolvedValueOnce(pagesFixture(docId));
      const fakeAi = makeFakeOpenAI(() => fx.payload);

      const result = await extractRateCon({
        documentId: docId,
        organizationId: "org-eval",
        openaiOverride: fakeAi,
      });

      expect(result.status).toBe("extracted");
      expect(result.payload).not.toBeNull();
      // The persisted payload must round-trip through Zod (this would
      // catch a regression in calibration that produced an invalid
      // confidence value, for example).
      const reparsed = rateConExtractionSchema.safeParse(result.payload);
      expect(reparsed.success).toBe(true);

      const { mean } = scoreAccuracy(result.payload!, fx.payload);
      expect(mean).toBe(1);
      totalMean += mean;
    }
    expect(totalMean / GROUND_TRUTH.length).toBe(1);

    // Sanity: upsertDocumentExtraction was called once per fixture with
    // status=extracted (proves the persistence call site is wired).
    expect(upsertSpy.mock.calls.length).toBe(GROUND_TRUTH.length);
    for (const call of upsertSpy.mock.calls) {
      expect(call[0].extractionStatus).toBe("extracted");
    }
  });

  it("drift scenario: every confidence −0.5 → corpus accuracy bar (≥0.93) FAILS", async () => {
    const accuracies: number[] = [];
    for (const fx of GROUND_TRUTH) {
      const docId = `doc-${fx.name}-drift`;
      getDocSpy.mockResolvedValueOnce(docFixture(docId));
      getPagesSpy.mockResolvedValueOnce(pagesFixture(docId));
      const fakeAi = makeFakeOpenAI(() => perturb(fx.payload));

      const result = await extractRateCon({
        documentId: docId,
        organizationId: "org-eval",
        openaiOverride: fakeAi,
      });

      // Even the perturbed payload still parses (only confidences moved,
      // not types) — that's the whole point: the rule and field-shape
      // layers are clean, but rep trust craters because nothing is
      // confident enough to surface. The accuracy bar is what catches it.
      expect(result.status).toBe("extracted");
      const { mean } = scoreAccuracy(result.payload!, fx.payload);
      accuracies.push(mean);
    }
    const corpusMean = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    // The eval bar is 0.93. After a uniform −0.5 confidence drift the
    // corpus must drop well below it; if this assertion ever flips, the
    // accuracy-scoring function or the extractor calibration silently
    // started masking regressions and the bar is no longer protective.
    expect(corpusMean).toBeLessThan(0.93);
  });

  it("the extractor rejects a model response that violates the typed envelope", async () => {
    const docId = "doc-malformed";
    getDocSpy.mockResolvedValueOnce(docFixture(docId));
    getPagesSpy.mockResolvedValueOnce(pagesFixture(docId));
    // Fake LLM emits `allInRate: 1850` instead of the {value,confidence,
    // source} wrapper. The extractor must mark the doc failed (via an
    // upsert with extractionStatus=failed) and never persist a partial
    // payload.
    const fakeAi = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: JSON.stringify({ ...clean("F1"), allInRate: 1850 }) } }],
          })),
        },
      },
    } as unknown as Parameters<typeof extractRateCon>[0]["openaiOverride"];

    const result = await extractRateCon({
      documentId: docId,
      organizationId: "org-eval",
      openaiOverride: fakeAi,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/zod_validation_failed/);
    // markFailed wrote a stub row with status=failed (so the admin queue
    // can show the reason and offer a retry). No "extracted" upsert.
    expect(upsertSpy.mock.calls.length).toBe(1);
    expect(upsertSpy.mock.calls[0][0].extractionStatus).toBe("failed");
  });
});
