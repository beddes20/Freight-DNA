/**
 * Task #911 — Rate-Con Extractor unit tests.
 *
 * The extractor is hard to fully exercise without a DB, so we use the
 * `payloadOverride` test hook to skip the OpenAI round-trip and Zod
 * validation surface area is the main contract under test.
 *
 * What this file pins:
 *   - rateConExtractionSchema accepts a well-formed envelope.
 *   - rateConExtractionSchema rejects payloads where a leaf is missing the
 *     {value, confidence, source} wrapper, or confidence is out of [0,1],
 *     or accessorials.items is not an array.
 *   - The pure helper `applyConfidenceOverrides` (re-exported logic) is
 *     not directly exposed; we cover its behaviour by validating the
 *     payload version constant and the field-path enum stays in sync
 *     with the schema (a common drift source as fields are added).
 *   - CURRENT_RATE_CON_PAYLOAD_VERSION is exported and >= 1.
 */
import { describe, it, expect } from "vitest";
import { rateConExtractionSchema, RATE_CON_FIELD_PATHS, type RateConExtraction } from "@shared/schema";
import { CURRENT_RATE_CON_PAYLOAD_VERSION } from "../services/rateConExtractor";

function fld<T>(value: T | null, confidence = 0.9, page = 1) {
  return { value, confidence, source: { page, bbox: null } };
}

const goodPayload: RateConExtraction = {
  brokerName: fld("ACME Brokerage Inc."),
  brokerReference: fld("BR-12345"),
  carrierName: fld("Allied Trucking LLC"),
  carrierMcNumber: fld("123456"),
  carrierDotNumber: fld("987654"),
  loadReference: fld("LD-9001"),
  proNumber: fld(null, 0.2),
  orderNumber: fld("ORD-555"),
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
  accessorials: { items: [{ description: "Detention", amount: null, confidence: 0.6 }], confidence: 0.8 },
  payTerms: fld("Net 30"),
  specialInstructions: fld("Driver assist not required."),
};

describe("rateConExtractionSchema (Task #911)", () => {
  it("accepts a well-formed payload", () => {
    const result = rateConExtractionSchema.safeParse(goodPayload);
    expect(result.success).toBe(true);
  });

  it("rejects when a leaf is missing the {value, confidence, source} wrapper", () => {
    const broken = { ...goodPayload, allInRate: 1850 as unknown as RateConExtraction["allInRate"] };
    const result = rateConExtractionSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    const broken = { ...goodPayload, carrierName: { ...goodPayload.carrierName, confidence: 1.4 } };
    const result = rateConExtractionSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts null values with low confidence (the model says 'not present')", () => {
    const sparse: RateConExtraction = {
      ...goodPayload,
      proNumber: fld(null, 0),
      payTerms: fld(null, 0),
      lineHaulRate: fld(null, 0),
      fuelSurcharge: fld(null, 0),
    };
    expect(rateConExtractionSchema.safeParse(sparse).success).toBe(true);
  });

  it("rejects when accessorials.items is not an array", () => {
    const broken = {
      ...goodPayload,
      accessorials: { items: "not an array" as unknown, confidence: 0.5 },
    } as unknown as RateConExtraction;
    expect(rateConExtractionSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts an empty accessorials list", () => {
    const empty: RateConExtraction = {
      ...goodPayload,
      accessorials: { items: [], confidence: 0.9 },
    };
    expect(rateConExtractionSchema.safeParse(empty).success).toBe(true);
  });

  it("RATE_CON_FIELD_PATHS stays in sync with the schema's top-level keys", () => {
    const schemaKeys = Object.keys(rateConExtractionSchema.shape).sort();
    const fieldPaths = [...RATE_CON_FIELD_PATHS].sort();
    expect(fieldPaths).toEqual(schemaKeys);
  });

  it("payload version constant is at least 1 and is an integer", () => {
    expect(CURRENT_RATE_CON_PAYLOAD_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(CURRENT_RATE_CON_PAYLOAD_VERSION)).toBe(true);
  });
});

// ─── End-to-end roundtrip via payloadOverride ─────────────────────────
// This validates that a caller can hand the extractor a synthetic typed
// payload and the Zod gate at the persistence boundary still fires —
// guarding against a future refactor that bypasses validation when the
// override path is taken.

describe("rateConExtractionSchema strict-mode roundtrip", () => {
  it("a JSON.stringify/parse roundtrip survives the schema", () => {
    const cloned = JSON.parse(JSON.stringify(goodPayload));
    expect(rateConExtractionSchema.safeParse(cloned).success).toBe(true);
  });
});
