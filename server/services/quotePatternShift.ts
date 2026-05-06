/**
 * Customer Quote Pattern-Shift Detection (Task #481)
 *
 * Daily job that compares each customer's trailing-30-day quote behaviour
 * against a trailing-90-day baseline (the 60 days prior to the recent
 * window) along three axes:
 *
 *   1. Total volume — recent vs baseline-per-30d.
 *   2. Top-lane mix — Jaccard overlap of top-5 lanes recent vs baseline.
 *   3. Equipment mix — Jaccard overlap of equipment sets.
 *
 * When any axis shifts beyond the configured threshold a single active
 * `quote_pattern_alerts` row is upserted per customer. The account owner
 * (rep with the most quotes for that customer in the last 90d, mapped via
 * quoteReps.userId) is notified once per active alert.
 *
 * Resolution: when subsequent runs report no shift, `normalizedSince` is
 * stamped on the active alert. Once the customer stays normal for
 * `resolveDays` (default 14) the alert is auto-resolved.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import { storage } from "../storage";
import {
  quoteCustomers, quoteOpportunities, quoteReps, quotePatternAlerts,
  type QuoteOpportunity, type QuoteCustomer,
} from "@shared/schema";

export type PatternShiftThresholds = {
  volumePctDelta: number;       // 0.5 ⇒ flag when |recent / baseline_per_30d − 1| ≥ 0.5
  laneOverlap: number;          // 0.6 ⇒ flag when Jaccard(top-5 lanes) < 0.6
  equipmentJaccard: number;     // 0.6 ⇒ flag when Jaccard(equipment sets) < 0.6
  minRecentQuotes: number;      // need this many in last 30d to consider
  minBaselineQuotes: number;    // need this many in trailing 60d before recent window
  resolveDays: number;          // resolve after N days normalized
  topLaneK: number;             // top-K lanes for mix overlap
};

export const DEFAULT_PATTERN_SHIFT_THRESHOLDS: PatternShiftThresholds = {
  volumePctDelta: 0.5,
  laneOverlap: 0.6,
  equipmentJaccard: 0.6,
  minRecentQuotes: 3,
  minBaselineQuotes: 6,
  resolveDays: 14,
  topLaneK: 5,
};

const DAY_MS = 24 * 3600 * 1000;

type AxisDetail = {
  shifted: boolean;
  metric: number;            // recent ratio | overlap | jaccard
  recent: unknown;
  baseline: unknown;
};

export type PatternShiftAxes = {
  volume: AxisDetail & { recentCount: number; baselinePer30: number; deltaPct: number };
  lane:   AxisDetail & { recentTop: string[]; baselineTop: string[]; newLanes: string[] };
  equipment: AxisDetail & { recentSet: string[]; baselineSet: string[] };
};

export type PatternShiftResult = {
  customerId: string;
  customerName: string;
  shifted: boolean;
  summary: string;
  axes: PatternShiftAxes;
  recentCount: number;
  baselineCount: number;
};

function laneKey(o: QuoteOpportunity): string {
  return `${o.originCity}, ${o.originState} → ${o.destCity}, ${o.destState}`;
}

function topLanes(rows: QuoteOpportunity[], k: number): string[] {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const key = laneKey(r);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return Array.from(tally.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([k2]) => k2);
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a), sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  sa.forEach(v => { if (sb.has(v)) inter++; });
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

export function evaluateCustomerShift(
  customer: QuoteCustomer,
  rows: QuoteOpportunity[],
  now: Date,
  th: PatternShiftThresholds = DEFAULT_PATTERN_SHIFT_THRESHOLDS,
): PatternShiftResult | null {
  const cutRecent = now.getTime() - 30 * DAY_MS;
  const cutBaseline = now.getTime() - 90 * DAY_MS;
  const recent = rows.filter(r => r.requestDate.getTime() >= cutRecent);
  const baseline = rows.filter(r => {
    const t = r.requestDate.getTime();
    return t >= cutBaseline && t < cutRecent;
  });

  if (recent.length < th.minRecentQuotes && baseline.length < th.minBaselineQuotes) return null;
  if (baseline.length < th.minBaselineQuotes) return null;

  // Axis 1 — Volume.
  const baselinePer30 = baseline.length / 2; // 60 day baseline → /2 to get per-30d
  const ratio = baselinePer30 > 0 ? recent.length / baselinePer30 : recent.length > 0 ? Infinity : 1;
  const deltaPct = ratio - 1;
  const volumeShifted = Math.abs(deltaPct) >= th.volumePctDelta;

  // Axis 2 — Top-lane mix.
  const recentTop = topLanes(recent, th.topLaneK);
  const baselineTop = topLanes(baseline, th.topLaneK);
  const overlap = jaccard(recentTop, baselineTop);
  const laneShifted = recentTop.length > 0 && baselineTop.length > 0 && overlap < th.laneOverlap;
  const baselineSetLanes = new Set(baselineTop);
  const newLanes = recentTop.filter(l => !baselineSetLanes.has(l));

  // Axis 3 — Equipment mix.
  const recentEq = Array.from(new Set(recent.map(r => r.equipment))).sort();
  const baselineEq = Array.from(new Set(baseline.map(r => r.equipment))).sort();
  const eqJaccard = jaccard(recentEq, baselineEq);
  const eqShifted = recentEq.length > 0 && baselineEq.length > 0 && eqJaccard < th.equipmentJaccard;

  const shifted = volumeShifted || laneShifted || eqShifted;

  const axes: PatternShiftAxes = {
    volume: {
      shifted: volumeShifted, metric: ratio,
      recent: recent.length, baseline: baselinePer30,
      recentCount: recent.length, baselinePer30, deltaPct,
    },
    lane: {
      shifted: laneShifted, metric: overlap,
      recent: recentTop, baseline: baselineTop,
      recentTop, baselineTop, newLanes,
    },
    equipment: {
      shifted: eqShifted, metric: eqJaccard,
      recent: recentEq, baseline: baselineEq,
      recentSet: recentEq, baselineSet: baselineEq,
    },
  };

  const summary = buildSummary(customer.name, axes);

  return {
    customerId: customer.id,
    customerName: customer.name,
    shifted, summary, axes,
    recentCount: recent.length,
    baselineCount: baseline.length,
  };
}

function buildSummary(customerName: string, a: PatternShiftAxes): string {
  const parts: string[] = [];
  if (a.volume.shifted) {
    const dir = a.volume.deltaPct > 0 ? "up" : "down";
    parts.push(`quote volume ${dir} ${Math.abs(Math.round(a.volume.deltaPct * 100))}% this month`);
  }
  if (a.lane.shifted) {
    if (a.lane.newLanes.length > 0) {
      parts.push(`${a.lane.newLanes.length} new top lane${a.lane.newLanes.length === 1 ? "" : "s"}`);
    } else {
      parts.push(`top-lane mix shifted (${Math.round(a.lane.metric * 100)}% overlap)`);
    }
  }
  if (a.equipment.shifted) {
    parts.push(`equipment mix shifted (${a.equipment.recentSet.join("/") || "—"})`);
  }
  if (parts.length === 0) return `${customerName} quote pattern shift detected.`;
  const tail = parts.length > 1 && (a.lane.shifted || a.equipment.shifted) ? " — possible RFP" : "";
  return `${customerName} ${parts.join(" with ")}${tail}.`;
}

export async function findOwnerUserIdForCustomer(orgId: string, customerId: string, since: Date): Promise<string | null> {
  // Most-frequent rep on this customer's recent quotes that maps to a real user.
  const rows = await db.execute(sql`
    SELECT r.user_id, COUNT(*) AS n
    FROM quote_opportunities o
    JOIN quote_reps r ON r.id = o.rep_id
    WHERE o.organization_id = ${orgId}
      AND o.customer_id = ${customerId}
      AND r.user_id IS NOT NULL
      AND o.request_date >= ${since.toISOString()}
    GROUP BY r.user_id
    ORDER BY n DESC
    LIMIT 1
  `);
  const r0 = (rows as any).rows?.[0] ?? (Array.isArray(rows) ? rows[0] : undefined);
  return r0?.user_id ?? null;
}

export type DetectionRunResult = {
  scanned: number;
  shifted: number;
  created: number;
  refreshed: number;
  resolved: number;
  notified: number;
};

/**
 * Run pattern shift detection for one org.
 * - Upserts active alerts for currently-shifted customers.
 * - Stamps `normalizedSince` for active alerts whose customer no longer shifts.
 * - Resolves alerts that have been normalized for `resolveDays` days.
 * - Notifies the account owner once per active alert (deduped via `relatedId`).
 */
export async function detectAndProcessPatternShifts(
  orgId: string,
  thresholds: PatternShiftThresholds = DEFAULT_PATTERN_SHIFT_THRESHOLDS,
  now: Date = new Date(),
): Promise<DetectionRunResult> {
  const customers = await db.select().from(quoteCustomers).where(eq(quoteCustomers.organizationId, orgId));
  if (customers.length === 0) {
    return { scanned: 0, shifted: 0, created: 0, refreshed: 0, resolved: 0, notified: 0 };
  }
  const cutBaseline = new Date(now.getTime() - 90 * DAY_MS);
  const allOpps = await db.select().from(quoteOpportunities)
    .where(and(
      eq(quoteOpportunities.organizationId, orgId),
      sql`${quoteOpportunities.requestDate} >= ${cutBaseline.toISOString()}`,
    ));
  const byCustomer = new Map<string, QuoteOpportunity[]>();
  for (const o of allOpps) {
    const arr = byCustomer.get(o.customerId) ?? [];
    arr.push(o);
    byCustomer.set(o.customerId, arr);
  }

  const activeAlerts = await db.select().from(quotePatternAlerts).where(and(
    eq(quotePatternAlerts.organizationId, orgId),
    eq(quotePatternAlerts.status, "active"),
  ));
  const activeByCustomer = new Map(activeAlerts.map(a => [a.customerId, a]));

  const out: DetectionRunResult = { scanned: 0, shifted: 0, created: 0, refreshed: 0, resolved: 0, notified: 0 };

  for (const customer of customers) {
    out.scanned++;
    const rows = byCustomer.get(customer.id) ?? [];
    const result = evaluateCustomerShift(customer, rows, now, thresholds);
    const existing = activeByCustomer.get(customer.id) ?? null;

    if (result?.shifted) {
      out.shifted++;
      if (existing) {
        await db.update(quotePatternAlerts).set({
          summary: result.summary,
          axes: result.axes,
          lastShiftedAt: now,
          normalizedSince: null,
        }).where(eq(quotePatternAlerts.id, existing.id));
        out.refreshed++;
      } else {
        const [created] = await db.insert(quotePatternAlerts).values({
          organizationId: orgId,
          customerId: customer.id,
          status: "active",
          summary: result.summary,
          // result.axes is a typed object from the AI service; the DB column is
          // jsonb, so Drizzle expects Record<string, unknown>. Safe cast.
          axes: result.axes as unknown as Record<string, unknown>,
          lastShiftedAt: now,
          normalizedSince: null,
          resolvedAt: null,
        }).returning();
        out.created++;

        // Notify the account owner — at most once per alert lifecycle.
        try {
          const ownerUserId = await findOwnerUserIdForCustomer(orgId, customer.id, cutBaseline);
          if (ownerUserId) {
            const relatedId = `quote_pattern_shift:${created.id}`;
            const seen = await storage.hasAnyNotification(ownerUserId, "quote_pattern_shift", relatedId).catch(() => false);
            if (!seen) {
              await storage.createNotification({
                userId: ownerUserId,
                type: "quote_pattern_shift",
                title: `Quote pattern shift — ${customer.name}`,
                body: result.summary,
                link: `/customer-quotes?customerId=${customer.id}&startDate=${new Date(now.getTime() - 30 * DAY_MS).toISOString().slice(0, 10)}`,
                relatedId,
                read: false,
              });
              out.notified++;
            }
          }
        } catch (err) {
          console.error("[quote-pattern-shift] notify error:", err);
        }
      }
    } else if (existing) {
      // No shift today — start / continue the normalization window.
      const since = existing.normalizedSince ?? now;
      const normalizedDays = (now.getTime() - new Date(since).getTime()) / DAY_MS;
      if (!existing.normalizedSince) {
        await db.update(quotePatternAlerts)
          .set({ normalizedSince: now })
          .where(eq(quotePatternAlerts.id, existing.id));
      } else if (normalizedDays >= thresholds.resolveDays) {
        await db.update(quotePatternAlerts)
          .set({ status: "resolved", resolvedAt: now })
          .where(eq(quotePatternAlerts.id, existing.id));
        out.resolved++;
      }
    }
  }

  return out;
}

export async function getActivePatternAlertsForOrg(orgId: string) {
  return db.select().from(quotePatternAlerts).where(and(
    eq(quotePatternAlerts.organizationId, orgId),
    eq(quotePatternAlerts.status, "active"),
  ));
}
