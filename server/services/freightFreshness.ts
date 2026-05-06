// Task #871 — Shared freight-freshness aggregate.
//
// The "Fresh / Slowing / Stale" pill on AF was previously computed inline
// inside the freight-cockpit endpoint. LWQ now wants the same pill, so the
// org-scoped aggregate lives here and both endpoints (and any future
// surface) call this single function. Keeping one query path is what
// guarantees the pills cannot disagree across surfaces.

import { sql } from "drizzle-orm";
import { db } from "../storage";
import { freightOpportunities } from "@shared/schema";

const FRESH_GREEN_MAX_MIN = 60;
const FRESH_YELLOW_MAX_MIN = 240;
const FRESH_RED_MISSING_MIN = 24 * 60;

type ProducerKey = "won_load_autopilot" | "available_freight_importer" | "manual";

const PRODUCER_LABELS: Record<ProducerKey, string> = {
  won_load_autopilot: "Won Load Autopilot",
  available_freight_importer: "Excel Importer",
  manual: "Manual",
};

export interface FreightFreshnessSignal {
  overall: {
    healthState: "green" | "yellow" | "red";
    lastEventAt: string | null;
    ageMinutes: number | null;
  };
  producers: Array<{
    id: ProducerKey;
    label: string;
    lastEventAt: string | null;
    ageMinutes: number | null;
    count24h: number;
    healthState: "green" | "yellow" | "red";
  }>;
  thresholds: {
    greenMaxMinutes: number;
    yellowMaxMinutes: number;
    redMissingMinutes: number;
  };
}

function ageOf(t: Date | null, now: Date): number | null {
  return t ? Math.max(0, Math.round((now.getTime() - t.getTime()) / 60_000)) : null;
}
function stateForAge(age: number | null): "green" | "yellow" | "red" {
  if (age == null) return "red";
  if (age <= FRESH_GREEN_MAX_MIN) return "green";
  if (age <= FRESH_YELLOW_MAX_MIN) return "yellow";
  return "red";
}

/**
 * Computes the org-scoped freight-ingestion freshness signal — single
 * round-trip aggregate over the last 24h of `freight_opportunities`.
 * The producer attribution mirrors the JS precedence used elsewhere
 * (source_quote_id beats source_file_name).
 */
export async function computeFreightFreshnessSignal(orgId: string): Promise<FreightFreshnessSignal> {
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const freshnessRows = await db.execute(sql`
    SELECT
      MAX(${freightOpportunities.generatedAt}) FILTER (
        WHERE ${freightOpportunities.sourceQuoteId} IS NOT NULL
      ) AS won_last,
      COUNT(*) FILTER (
        WHERE ${freightOpportunities.sourceQuoteId} IS NOT NULL
          AND ${freightOpportunities.generatedAt} >= ${cutoff24h}
      ) AS won_count,
      MAX(${freightOpportunities.generatedAt}) FILTER (
        WHERE ${freightOpportunities.sourceQuoteId} IS NULL
          AND ${freightOpportunities.sourceFileName} IS NOT NULL
      ) AS importer_last,
      COUNT(*) FILTER (
        WHERE ${freightOpportunities.sourceQuoteId} IS NULL
          AND ${freightOpportunities.sourceFileName} IS NOT NULL
          AND ${freightOpportunities.generatedAt} >= ${cutoff24h}
      ) AS importer_count,
      MAX(${freightOpportunities.generatedAt}) FILTER (
        WHERE ${freightOpportunities.sourceQuoteId} IS NULL
          AND ${freightOpportunities.sourceFileName} IS NULL
      ) AS manual_last,
      COUNT(*) FILTER (
        WHERE ${freightOpportunities.sourceQuoteId} IS NULL
          AND ${freightOpportunities.sourceFileName} IS NULL
          AND ${freightOpportunities.generatedAt} >= ${cutoff24h}
      ) AS manual_count
    FROM ${freightOpportunities}
    WHERE ${freightOpportunities.orgId} = ${orgId}
  `);
  const f0: any =
    (freshnessRows as any).rows?.[0]
    ?? (Array.isArray(freshnessRows) ? (freshnessRows as any)[0] : null)
    ?? {};

  const parseDate = (v: any): Date | null => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  };
  const parseCount = (v: any): number => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
    return Number.isFinite(n) ? n : 0;
  };

  const buckets: Record<ProducerKey, { last: Date | null; count24h: number }> = {
    won_load_autopilot:        { last: parseDate(f0.won_last),      count24h: parseCount(f0.won_count) },
    available_freight_importer: { last: parseDate(f0.importer_last), count24h: parseCount(f0.importer_count) },
    manual:                     { last: parseDate(f0.manual_last),   count24h: parseCount(f0.manual_count) },
  };
  const producers = (Object.keys(buckets) as ProducerKey[]).map((id) => {
    const b = buckets[id];
    const age = ageOf(b.last, now);
    return {
      id,
      label: PRODUCER_LABELS[id],
      lastEventAt: b.last ? b.last.toISOString() : null,
      ageMinutes: age,
      count24h: b.count24h,
      healthState: stateForAge(age),
    };
  });
  const overallLast = producers.reduce<Date | null>((acc, p) => {
    if (!p.lastEventAt) return acc;
    const t = new Date(p.lastEventAt);
    if (!Number.isFinite(t.getTime())) return acc;
    if (!acc || t > acc) return t;
    return acc;
  }, null);
  const overallAge = ageOf(overallLast, now);
  const overallHealth = overallAge == null || overallAge >= FRESH_RED_MISSING_MIN
    ? "red"
    : stateForAge(overallAge);

  return {
    overall: {
      healthState: overallHealth as "green" | "yellow" | "red",
      lastEventAt: overallLast ? overallLast.toISOString() : null,
      ageMinutes: overallAge,
    },
    producers,
    thresholds: {
      greenMaxMinutes: FRESH_GREEN_MAX_MIN,
      yellowMaxMinutes: FRESH_YELLOW_MAX_MIN,
      redMissingMinutes: FRESH_RED_MISSING_MIN,
    },
  };
}
