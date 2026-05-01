/**
 * Task #911 — Confidence calibration.
 *
 * Per (orgId, classLabel='rate_con', fieldPath), computes the rep
 * correction rate over the last `WINDOW_DAYS` days. When the rate
 * exceeds a threshold, writes a `field_confidence_overrides` row with a
 * multiplier < 1 so the next extraction's confidence on that field is
 * downgraded. Multiplier scales linearly between two threshold knobs:
 *   correction rate ≤ MIN_THRESHOLD → no override (multiplier 1)
 *   correction rate ≥ MAX_THRESHOLD → multiplier MIN_MULTIPLIER
 * in between → linear interpolation.
 *
 * Surfaces `getCurrentOverrides(orgId)` for the admin panel.
 */
import { storage } from "../storage";
import { RATE_CON_FIELD_PATHS } from "@shared/schema";

const WINDOW_DAYS = 30;
const MIN_SAMPLE_SIZE = 5;
const MIN_THRESHOLD = 0.05;
const MAX_THRESHOLD = 0.4;
const MIN_MULTIPLIER = 0.6;

export interface CalibrationResult {
  organizationId: string;
  classLabel: string;
  windowDays: number;
  computed: Array<{
    fieldPath: string;
    correctionRate: number;
    sampleSize: number;
    multiplier: number;
    persisted: boolean;
  }>;
}

export async function calibrateRateConConfidence(args: {
  organizationId: string;
  windowDays?: number;
}): Promise<CalibrationResult> {
  const windowDays = args.windowDays ?? WINDOW_DAYS;
  const sinceIso = new Date(Date.now() - windowDays * 86400000).toISOString();

  const stats = await storage.getCorrectionRatesForClass(args.organizationId, "rate_con", sinceIso);
  if (stats.length === 0 || stats[0].sampleSize < MIN_SAMPLE_SIZE) {
    return { organizationId: args.organizationId, classLabel: "rate_con", windowDays, computed: [] };
  }

  // Build a per-field map (defaulting unsampled fields to 0 corrections).
  const byField = new Map<string, { count: number; sample: number }>();
  const sample = stats[0].sampleSize;
  for (const path of RATE_CON_FIELD_PATHS) {
    byField.set(path, { count: 0, sample });
  }
  for (const s of stats) {
    byField.set(s.fieldPath, { count: s.correctionCount, sample });
  }

  const computed: CalibrationResult["computed"] = [];
  for (const [fieldPath, { count, sample: ss }] of byField.entries()) {
    if (ss < MIN_SAMPLE_SIZE) continue;
    const correctionRate = ss === 0 ? 0 : count / ss;
    const multiplier = computeMultiplier(correctionRate);
    let persisted = false;
    if (multiplier < 1) {
      await storage.upsertFieldConfidenceOverride({
        organizationId: args.organizationId,
        classLabel: "rate_con",
        fieldPath,
        confidenceMultiplier: multiplier.toFixed(3),
        correctionRate: correctionRate.toFixed(3),
        sampleSize: ss,
        note: `Auto-calibrated over ${windowDays}d window: ${count}/${ss} corrected.`,
      });
      persisted = true;
    }
    computed.push({ fieldPath, correctionRate, sampleSize: ss, multiplier, persisted });
  }

  return { organizationId: args.organizationId, classLabel: "rate_con", windowDays, computed };
}

export function computeMultiplier(correctionRate: number): number {
  if (!Number.isFinite(correctionRate) || correctionRate <= MIN_THRESHOLD) return 1;
  if (correctionRate >= MAX_THRESHOLD) return MIN_MULTIPLIER;
  const t = (correctionRate - MIN_THRESHOLD) / (MAX_THRESHOLD - MIN_THRESHOLD);
  return 1 - t * (1 - MIN_MULTIPLIER);
}

export async function getCurrentOverrides(organizationId: string): Promise<ReturnType<typeof storage.listFieldConfidenceOverrides>> {
  return storage.listFieldConfidenceOverrides(organizationId, "rate_con");
}
