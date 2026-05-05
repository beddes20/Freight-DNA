/**
 * Task #1027 (LWQ B) — Per-org tunable weights for the Lane Work Queue
 * strategic priority composite. Mirrors the
 * `server/carrierIntelligenceSettings.ts` pattern: persisted via
 * `storage.getSetting/setSetting` so admins can tune without a deploy.
 */

import { storage } from "./storage";
import {
  DEFAULT_LANE_STRATEGIC_WEIGHTS,
  type LaneStrategicWeights,
} from "./services/laneStrategicPriority";

export { DEFAULT_LANE_STRATEGIC_WEIGHTS, type LaneStrategicWeights };

const settingsKey = (orgId: string) => `lane_strategic:weights:${orgId}`;

function clampNum(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function sanitize(raw: Partial<LaneStrategicWeights> | undefined, base: LaneStrategicWeights): LaneStrategicWeights {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    customerValue: clampNum(r.customerValue, 0, 1, base.customerValue),
    freshness: clampNum(r.freshness, 0, 1, base.freshness),
    outcomeHistory: clampNum(r.outcomeHistory, 0, 1, base.outcomeHistory),
    tactical: clampNum(r.tactical, 0, 1, base.tactical),
    lifecycle: clampNum(r.lifecycle, 0, 1, base.lifecycle),
    customerValueCap: clampNum(r.customerValueCap, 1_000, 1_000_000_000, base.customerValueCap),
    freshnessStaleDays: clampNum(r.freshnessStaleDays, 1, 365, base.freshnessStaleDays),
    avgLoadsCap: clampNum(r.avgLoadsCap, 1, 100, base.avgLoadsCap),
    outcomeBoostPerLoad: clampNum(r.outcomeBoostPerLoad, 0, 100, base.outcomeBoostPerLoad),
  };
}

export async function getLaneStrategicWeights(orgId: string): Promise<LaneStrategicWeights> {
  const raw = await storage.getSetting(settingsKey(orgId));
  if (!raw) return { ...DEFAULT_LANE_STRATEGIC_WEIGHTS };
  try {
    const parsed = JSON.parse(raw);
    return sanitize(parsed, DEFAULT_LANE_STRATEGIC_WEIGHTS);
  } catch {
    return { ...DEFAULT_LANE_STRATEGIC_WEIGHTS };
  }
}

export async function setLaneStrategicWeights(
  orgId: string,
  partial: Partial<LaneStrategicWeights>,
): Promise<LaneStrategicWeights> {
  const current = await getLaneStrategicWeights(orgId);
  const next = sanitize({ ...current, ...partial }, current);
  await storage.setSetting(settingsKey(orgId), JSON.stringify(next));
  return next;
}
