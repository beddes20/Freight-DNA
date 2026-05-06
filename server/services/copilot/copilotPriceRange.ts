/**
 * Copilot Price Range — Task #926 step 4.
 *
 * Produces a low / mid / high price band per lane (in $/mile) keyed off
 * `lane_rate_history` rows for the same origin/destination state-pair (and
 * equipment when available). Cites the comparable rows it used.
 *
 * No comparables found → returns nulls, not a guess. The intelligence card
 * surfaces this as "low evidence" so the rep doesn't assume a band that
 * isn't grounded.
 */
import { db } from "../../storage";
import { and, eq, sql } from "drizzle-orm";
import { laneRateHistory } from "@shared/schema";
import type { EvidenceRef } from "./copilotFitEngine";

export interface PriceRangeResult {
  /** $/mile band — UI multiplies by miles when known. */
  low: number | null;
  mid: number | null;
  high: number | null;
  comparables: EvidenceRef[];
  confidence: "high" | "medium" | "low";
  unit: "per_mile";
}

export async function computePriceRange(args: {
  organizationId: string;
  originState: string | null;
  destinationState: string | null;
  equipment: string | null;
  customerId?: string | null;
}): Promise<PriceRangeResult> {
  const { organizationId, originState, destinationState, equipment } = args;
  if (!originState || !destinationState) {
    return { low: null, mid: null, high: null, comparables: [], confidence: "low", unit: "per_mile" };
  }
  const conditions = [
    eq(laneRateHistory.orgId, organizationId),
    eq(laneRateHistory.originState, originState),
    eq(laneRateHistory.destinationState, destinationState),
  ];
  if (equipment) {
    const eq_ = equipment.toUpperCase();
    conditions.push(sql`UPPER(${laneRateHistory.equipmentType}) = ${eq_}`);
  }
  const rows = await db.select().from(laneRateHistory).where(and(...conditions)).limit(20);

  const comparables: EvidenceRef[] = [];
  const lows: number[] = [];
  const mids: number[] = [];
  const highs: number[] = [];
  for (const r of rows) {
    const lo = r.p25CostPerMile != null ? Number(r.p25CostPerMile) : (r.minCostPerMile != null ? Number(r.minCostPerMile) : null);
    const md = r.medianCostPerMile != null ? Number(r.medianCostPerMile) : (r.avgCostPerMile != null ? Number(r.avgCostPerMile) : null);
    const hi = r.p75CostPerMile != null ? Number(r.p75CostPerMile) : (r.maxCostPerMile != null ? Number(r.maxCostPerMile) : null);
    if (lo != null) lows.push(lo);
    if (md != null) mids.push(md);
    if (hi != null) highs.push(hi);
    comparables.push({
      kind: "lane_rate_history",
      id: r.id,
      label: `${r.originState}→${r.destinationState}${r.equipmentType !== "ALL" ? ` ${r.equipmentType}` : ""}: ${r.loads ?? "?"} loads, $${md?.toFixed(2) ?? "?"}/mi median`,
      value: md ?? undefined,
    });
  }
  if (!mids.length && !lows.length) {
    return { low: null, mid: null, high: null, comparables, confidence: "low", unit: "per_mile" };
  }
  const median = (arr: number[]) => {
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)] ?? null;
  };
  const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);
  return {
    low: round2(median(lows)),
    mid: round2(median(mids)),
    high: round2(median(highs)),
    comparables,
    confidence: comparables.length >= 5 ? "high" : comparables.length >= 2 ? "medium" : "low",
    unit: "per_mile",
  };
}
