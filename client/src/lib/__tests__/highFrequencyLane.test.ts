/**
 * High-Frequency Lane v2 — Unit Tests (Task #188)
 *
 * Tests pure functions exported from carrierRankingService.ts that do not
 * require a live server or database connection.
 *
 * Coverage:
 *   - isHighFrequencyLane: avgLoadsPerWeek fast path
 *   - isHighFrequencyLane: TMS upload historical path (computeHfFromUploads integrated)
 *   - HIGH_FREQUENCY_CONFIG: exported shape and values
 *   - HF floor constants: correct thresholds
 */

import { describe, it, expect } from "vitest";
import {
  isHighFrequencyLane,
  HIGH_FREQUENCY_CONFIG,
  HF_EXACT_FLOOR_HIGH,
  HF_EXACT_FLOOR_MED,
  HF_EXACT_FLOOR_ANY,
} from "../../../../server/carrierRankingService";
import type { RecurringLane, FinancialUpload } from "@shared/schema";

// ── Minimal lane factory ─────────────────────────────────────────────────────
// Provides all required RecurringLane columns so no type-escape cast is needed.

function makeLane(overrides: Partial<RecurringLane> = {}): RecurringLane {
  const now = new Date();
  return {
    id: "lane-1",
    orgId: "org-1",
    companyId: null,
    companyName: null,
    origin: "chicago",
    destination: "dallas",
    originState: "IL",
    destinationState: "TX",
    equipmentType: "dry_van",
    avgLoadsPerWeek: null,
    weeksActive: 0,
    lookbackWeeks: 4,
    hasPreferredCarrierProgram: false,
    ownerUserId: null,
    overseerUserId: null,
    assignedAt: null,
    assignedByUserId: null,
    laneScore: null,
    laneScoreFactors: null,
    eligibilityConfidence: "medium",
    lastScoredAt: null,
    isEligible: false,
    snoozedUntil: null,
    carriersContactedCount: 0,
    resolvedAt: null,
    isManual: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Minimal upload factory ────────────────────────────────────────────────────
// Generates an upload whose rows span the current month so they fall within
// the 30-day frequencyLookbackDays window.
// Provides all required FinancialUpload columns so no type-escape cast is needed.

function makeUploadWithRows(origin: string, destination: string, count: number): FinancialUpload {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const rows = Array.from({ length: count }, () => ({
    shipperCity: origin,
    consigneeCity: destination,
    carrier: "Test Carrier",
    month,
  }));
  return {
    id: "upload-1",
    fileName: "test.csv",
    uploadedAt: now.toISOString(),
    uploadedBy: "user-1",
    rowCount: count,
    rows,
    summaryRows: [],
    bestDealDaysSpot: [],
    bestDealDaysAll: [],
    trendAnalysis: [],
    averagesData: [],
    dailyAcquisition: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HIGH_FREQUENCY_CONFIG", () => {
  it("exports required config fields with expected types", () => {
    expect(HIGH_FREQUENCY_CONFIG).toBeDefined();
    expect(typeof HIGH_FREQUENCY_CONFIG.minLoadsPerWeek).toBe("number");
    expect(typeof HIGH_FREQUENCY_CONFIG.frequencyLookbackDays).toBe("number");
    expect(typeof HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours).toBe("number");
    expect(typeof HIGH_FREQUENCY_CONFIG.maxCandidates).toBe("number");
  });

  it("minLoadsPerWeek is 2 (≥2 loads/week = high-frequency)", () => {
    expect(HIGH_FREQUENCY_CONFIG.minLoadsPerWeek).toBe(2);
  });

  it("frequencyLookbackDays is 30", () => {
    expect(HIGH_FREQUENCY_CONFIG.frequencyLookbackDays).toBe(30);
  });

  it("maxCandidates is 30", () => {
    expect(HIGH_FREQUENCY_CONFIG.maxCandidates).toBe(30);
  });
});

describe("HF floor constants", () => {
  it("HF_EXACT_FLOOR_HIGH is 95 (≥10 exact runs)", () => {
    expect(HF_EXACT_FLOOR_HIGH).toBe(95);
  });

  it("HF_EXACT_FLOOR_MED is 85 (≥5 exact runs)", () => {
    expect(HF_EXACT_FLOOR_MED).toBe(85);
  });

  it("HF_EXACT_FLOOR_ANY is 72 (≥1 exact run)", () => {
    expect(HF_EXACT_FLOOR_ANY).toBe(72);
  });
});

describe("isHighFrequencyLane — avgLoadsPerWeek fast path", () => {
  it("returns true when avgLoadsPerWeek equals threshold (2)", () => {
    expect(isHighFrequencyLane(makeLane({ avgLoadsPerWeek: 2 }))).toBe(true);
  });

  it("returns true when avgLoadsPerWeek exceeds threshold", () => {
    expect(isHighFrequencyLane(makeLane({ avgLoadsPerWeek: 5 }))).toBe(true);
  });

  it("returns false when avgLoadsPerWeek is below threshold", () => {
    expect(isHighFrequencyLane(makeLane({ avgLoadsPerWeek: 1.5 }))).toBe(false);
  });

  it("returns false when avgLoadsPerWeek is 0", () => {
    expect(isHighFrequencyLane(makeLane({ avgLoadsPerWeek: 0 }))).toBe(false);
  });

  it("returns false when avgLoadsPerWeek is null", () => {
    expect(isHighFrequencyLane(makeLane({ avgLoadsPerWeek: null }))).toBe(false);
  });
});

describe("isHighFrequencyLane — TMS upload historical path (frequencyLookbackDays)", () => {
  it("returns true when uploads contain ≥ threshold loads/week for the lane", () => {
    // 30-day window = 30/7 ≈ 4.3 weeks. Need ≥2 loads/week → ≥9 loads total.
    const lane = makeLane({ avgLoadsPerWeek: null });
    const upload = makeUploadWithRows("chicago", "dallas", 10);
    expect(isHighFrequencyLane(lane, [upload])).toBe(true);
  });

  it("returns false when uploads contain fewer loads than threshold", () => {
    const lane = makeLane({ avgLoadsPerWeek: null });
    // Only 4 loads in 30 days → ~0.93 loads/week < 2 threshold
    const upload = makeUploadWithRows("chicago", "dallas", 4);
    expect(isHighFrequencyLane(lane, [upload])).toBe(false);
  });

  it("returns false when uploads do not contain rows for this lane", () => {
    const lane = makeLane({ avgLoadsPerWeek: null, origin: "chicago", destination: "dallas" });
    // Upload has rows for a different lane
    const upload = makeUploadWithRows("atlanta", "miami", 20);
    expect(isHighFrequencyLane(lane, [upload])).toBe(false);
  });

  it("falls back to upload scan even when avgLoadsPerWeek is 0 (stale/reset)", () => {
    const lane = makeLane({ avgLoadsPerWeek: 0 });
    const upload = makeUploadWithRows("chicago", "dallas", 15);
    // avgLoadsPerWeek = 0 → fast path fails, but upload scan detects HF
    expect(isHighFrequencyLane(lane, [upload])).toBe(true);
  });

  it("returns false with no uploads provided (no historical path)", () => {
    const lane = makeLane({ avgLoadsPerWeek: null });
    expect(isHighFrequencyLane(lane)).toBe(false);
    expect(isHighFrequencyLane(lane, [])).toBe(false);
  });

  it("avgLoadsPerWeek fast path wins even without uploads", () => {
    const lane = makeLane({ avgLoadsPerWeek: 3 });
    expect(isHighFrequencyLane(lane)).toBe(true);
    expect(isHighFrequencyLane(lane, [])).toBe(true);
  });
});
