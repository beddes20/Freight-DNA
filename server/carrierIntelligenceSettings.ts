/**
 * Settings (per-org) for the carrier intelligence scoring & pricing engine
 * (Task #369). Persisted via storage.getSetting/setSetting so admins can tune
 * without a deploy. Each accessor returns a typed object with defaults.
 */

import { storage } from "./storage";

export interface PerCustomerBlendOverride {
  /** Sonar weight override for this specific customer (0–1). */
  sonarWeight?: number;
  /** Minimum history loads override for this customer. */
  minHistoryLoads?: number;
}

export type FallbackTier = "lane_customer_trailer" | "lane_customer" | "lane_trailer" | "lane" | "nearby_lane" | "state_pair" | "trailer_benchmark";

export interface PricingBlendConfig {
  /** Sonar weight (0–1). Default 0.65; history weight = 1 - sonarWeight. */
  sonarWeight: number;
  /** Minimum lane history loads required before history leg is trusted. */
  minHistoryLoads: number;
  /** % spread above target buy rate considered "high confidence" pricing. */
  highConfidenceSpreadPct: number;
  /** How often (hours) the recompute scheduler should refresh the analytics. */
  refreshIntervalHours: number;
  /** Per-customer overrides. Keyed by customer name (case-insensitive). */
  perCustomerOverrides: Record<string, PerCustomerBlendOverride>;
  /** When history loads < minHistoryLoads × this multiplier, auto-bump Sonar weight. */
  sparseHistoryMultiplier: number;
  /** Amount to bump Sonar weight when history is sparse (0–0.5). */
  sonarSparseBumpAmount: number;
  /** Ordered fallback chain when the exact (lane, customer, trailer) lookup misses. */
  fallbackOrder: FallbackTier[];
}

export interface ConfidenceChipThresholds {
  /** Min loads + max spread% for green (high) confidence. */
  greenMinLoads: number;
  greenMaxSpreadPct: number;
  /** Min loads for yellow (medium) confidence. Below this → red. */
  yellowMinLoads: number;
}

export interface ScoringThresholds {
  tierAMinScore: number;
  tierBMinScore: number;
  /** Below this many days since last load → demote tier by one. */
  recencyDecayDays: number;
  /** Refusal-rate threshold above which a carrier is skipped from recs. */
  refusalRateThreshold: number;
  /** Don't suggest a rate when realized history loads < refusalMinLoads AND Sonar unavailable. */
  refusalMinLoads: number;
  /** Confidence chip thresholds (UI red/yellow/green). */
  confidenceChips: ConfidenceChipThresholds;
}

export const DEFAULT_BLEND: PricingBlendConfig = {
  sonarWeight: 0.65,
  minHistoryLoads: 3,
  highConfidenceSpreadPct: 8,
  refreshIntervalHours: 24,
  perCustomerOverrides: {},
  sparseHistoryMultiplier: 2,
  sonarSparseBumpAmount: 0.15,
  fallbackOrder: ["lane_customer_trailer", "lane_customer", "lane_trailer", "lane", "nearby_lane", "state_pair", "trailer_benchmark"],
};

export const DEFAULT_THRESHOLDS: ScoringThresholds = {
  tierAMinScore: 75,
  tierBMinScore: 50,
  recencyDecayDays: 90,
  refusalRateThreshold: 0.6,
  refusalMinLoads: 2,
  confidenceChips: {
    greenMinLoads: 5,
    greenMaxSpreadPct: 8,
    yellowMinLoads: 2,
  },
};

const blendKey = (orgId: string) => `carrier_intel:blend:${orgId}`;
const thresholdKey = (orgId: string) => `carrier_intel:thresholds:${orgId}`;

function clampNum(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function sanitizeOverrides(raw: unknown): Record<string, PerCustomerBlendOverride> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, PerCustomerBlendOverride> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const obj = v as Record<string, unknown>;
    const o: PerCustomerBlendOverride = {};
    if (obj.sonarWeight !== undefined) o.sonarWeight = clampNum(obj.sonarWeight, 0, 1, 0.65);
    if (obj.minHistoryLoads !== undefined) o.minHistoryLoads = clampNum(obj.minHistoryLoads, 0, 100, 3);
    out[k.trim().toLowerCase()] = o;
  }
  return out;
}

function sanitizeFallbackOrder(raw: unknown): FallbackTier[] {
  if (!Array.isArray(raw)) return [...DEFAULT_BLEND.fallbackOrder];
  const allowed = new Set<FallbackTier>(DEFAULT_BLEND.fallbackOrder);
  const out: FallbackTier[] = [];
  for (const v of raw) {
    if (typeof v === "string" && allowed.has(v as FallbackTier) && !out.includes(v as FallbackTier)) {
      out.push(v as FallbackTier);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_BLEND.fallbackOrder];
}

export async function getBlendConfig(orgId: string): Promise<PricingBlendConfig> {
  const raw = await storage.getSetting(blendKey(orgId));
  if (!raw) return { ...DEFAULT_BLEND, perCustomerOverrides: {}, fallbackOrder: [...DEFAULT_BLEND.fallbackOrder] };
  try {
    const parsed: Record<string, unknown> = JSON.parse(raw);
    return {
      sonarWeight: clampNum(parsed.sonarWeight, 0, 1, DEFAULT_BLEND.sonarWeight),
      minHistoryLoads: clampNum(parsed.minHistoryLoads, 0, 100, DEFAULT_BLEND.minHistoryLoads),
      highConfidenceSpreadPct: clampNum(parsed.highConfidenceSpreadPct, 0, 100, DEFAULT_BLEND.highConfidenceSpreadPct),
      refreshIntervalHours: clampNum(parsed.refreshIntervalHours, 1, 168, DEFAULT_BLEND.refreshIntervalHours),
      perCustomerOverrides: sanitizeOverrides(parsed.perCustomerOverrides),
      sparseHistoryMultiplier: clampNum(parsed.sparseHistoryMultiplier, 1, 10, DEFAULT_BLEND.sparseHistoryMultiplier),
      sonarSparseBumpAmount: clampNum(parsed.sonarSparseBumpAmount, 0, 0.5, DEFAULT_BLEND.sonarSparseBumpAmount),
      fallbackOrder: sanitizeFallbackOrder(parsed.fallbackOrder),
    };
  } catch {
    return { ...DEFAULT_BLEND, perCustomerOverrides: {}, fallbackOrder: [...DEFAULT_BLEND.fallbackOrder] };
  }
}

export async function setBlendConfig(orgId: string, partial: Partial<PricingBlendConfig>): Promise<PricingBlendConfig> {
  const current = await getBlendConfig(orgId);
  const next: PricingBlendConfig = {
    sonarWeight: partial.sonarWeight !== undefined ? clampNum(partial.sonarWeight, 0, 1, current.sonarWeight) : current.sonarWeight,
    minHistoryLoads: partial.minHistoryLoads !== undefined ? clampNum(partial.minHistoryLoads, 0, 100, current.minHistoryLoads) : current.minHistoryLoads,
    highConfidenceSpreadPct: partial.highConfidenceSpreadPct !== undefined ? clampNum(partial.highConfidenceSpreadPct, 0, 100, current.highConfidenceSpreadPct) : current.highConfidenceSpreadPct,
    refreshIntervalHours: partial.refreshIntervalHours !== undefined ? clampNum(partial.refreshIntervalHours, 1, 168, current.refreshIntervalHours) : current.refreshIntervalHours,
    perCustomerOverrides: partial.perCustomerOverrides !== undefined ? sanitizeOverrides(partial.perCustomerOverrides) : current.perCustomerOverrides,
    sparseHistoryMultiplier: partial.sparseHistoryMultiplier !== undefined ? clampNum(partial.sparseHistoryMultiplier, 1, 10, current.sparseHistoryMultiplier) : current.sparseHistoryMultiplier,
    sonarSparseBumpAmount: partial.sonarSparseBumpAmount !== undefined ? clampNum(partial.sonarSparseBumpAmount, 0, 0.5, current.sonarSparseBumpAmount) : current.sonarSparseBumpAmount,
    fallbackOrder: partial.fallbackOrder !== undefined ? sanitizeFallbackOrder(partial.fallbackOrder) : current.fallbackOrder,
  };
  await storage.setSetting(blendKey(orgId), JSON.stringify(next));
  return next;
}

/** Resolve the effective blend for a given customer, applying per-customer overrides if present. */
export function resolveBlendForCustomer(cfg: PricingBlendConfig, customerName: string | null | undefined): PricingBlendConfig {
  if (!customerName) return cfg;
  const override = cfg.perCustomerOverrides[customerName.trim().toLowerCase()];
  if (!override) return cfg;
  return {
    ...cfg,
    sonarWeight: override.sonarWeight ?? cfg.sonarWeight,
    minHistoryLoads: override.minHistoryLoads ?? cfg.minHistoryLoads,
  };
}

function sanitizeChips(raw: unknown): ConfidenceChipThresholds {
  const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  return {
    greenMinLoads: clampNum(obj.greenMinLoads, 0, 100, DEFAULT_THRESHOLDS.confidenceChips.greenMinLoads),
    greenMaxSpreadPct: clampNum(obj.greenMaxSpreadPct, 0, 100, DEFAULT_THRESHOLDS.confidenceChips.greenMaxSpreadPct),
    yellowMinLoads: clampNum(obj.yellowMinLoads, 0, 100, DEFAULT_THRESHOLDS.confidenceChips.yellowMinLoads),
  };
}

export async function getThresholds(orgId: string): Promise<ScoringThresholds> {
  const raw = await storage.getSetting(thresholdKey(orgId));
  if (!raw) return { ...DEFAULT_THRESHOLDS, confidenceChips: { ...DEFAULT_THRESHOLDS.confidenceChips } };
  try {
    const parsed: Record<string, unknown> = JSON.parse(raw);
    return {
      tierAMinScore: clampNum(parsed.tierAMinScore, 0, 100, DEFAULT_THRESHOLDS.tierAMinScore),
      tierBMinScore: clampNum(parsed.tierBMinScore, 0, 100, DEFAULT_THRESHOLDS.tierBMinScore),
      recencyDecayDays: clampNum(parsed.recencyDecayDays, 1, 365, DEFAULT_THRESHOLDS.recencyDecayDays),
      refusalRateThreshold: clampNum(parsed.refusalRateThreshold, 0, 1, DEFAULT_THRESHOLDS.refusalRateThreshold),
      refusalMinLoads: clampNum(parsed.refusalMinLoads, 0, 100, DEFAULT_THRESHOLDS.refusalMinLoads),
      confidenceChips: sanitizeChips(parsed.confidenceChips),
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS, confidenceChips: { ...DEFAULT_THRESHOLDS.confidenceChips } };
  }
}

export async function setThresholds(orgId: string, partial: Partial<ScoringThresholds>): Promise<ScoringThresholds> {
  const current = await getThresholds(orgId);
  const next: ScoringThresholds = {
    tierAMinScore: partial.tierAMinScore !== undefined ? clampNum(partial.tierAMinScore, 0, 100, current.tierAMinScore) : current.tierAMinScore,
    tierBMinScore: partial.tierBMinScore !== undefined ? clampNum(partial.tierBMinScore, 0, 100, current.tierBMinScore) : current.tierBMinScore,
    recencyDecayDays: partial.recencyDecayDays !== undefined ? clampNum(partial.recencyDecayDays, 1, 365, current.recencyDecayDays) : current.recencyDecayDays,
    refusalRateThreshold: partial.refusalRateThreshold !== undefined ? clampNum(partial.refusalRateThreshold, 0, 1, current.refusalRateThreshold) : current.refusalRateThreshold,
    refusalMinLoads: partial.refusalMinLoads !== undefined ? clampNum(partial.refusalMinLoads, 0, 100, current.refusalMinLoads) : current.refusalMinLoads,
    confidenceChips: partial.confidenceChips !== undefined ? sanitizeChips(partial.confidenceChips) : current.confidenceChips,
  };
  // Sanity: tierA must be >= tierB.
  if (next.tierAMinScore < next.tierBMinScore) next.tierAMinScore = next.tierBMinScore;
  await storage.setSetting(thresholdKey(orgId), JSON.stringify(next));
  return next;
}
