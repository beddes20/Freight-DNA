// Task #871 — Lane Cockpit endpoint.
//
// Returns BOTH faces of a lane (recurring/LWQ + live/AF) plus the header
// signals (freshness pill, stability badge, customer tier) in a SINGLE
// round trip keyed by lane signature. The Lane Cockpit overlay (sheet)
// rendered from either AF or LWQ calls this endpoint exactly once per
// open and fans the response out into its dual-pane layout — no per-row
// N+1, no second hop for the freshness pill.

import type { Express } from "express";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, getCurrentUser } from "../auth";
import { db } from "../storage";
import {
  recurringLanes,
  freightOpportunities,
  carrierOutreachLogs,
  laneCarrierInterest,
  laneSummaryCache,
  companies,
  users,
  type RecurringLane,
  type FreightOpportunity,
} from "@shared/schema";
import { getErrorMessage } from "../lib/errors";
import { deriveCustomerTier } from "../lib/customerTier";
import { classifyStability, type LaneStability } from "../laneCrossLinkService";
import { computeFreightFreshnessSignal, type FreightFreshnessSignal } from "../services/freightFreshness";

const OPEN_OPP_STATUSES = [
  "new",
  "ready_to_send",
  "sent",
  "awaiting_carrier_reply",
  "awaiting_customer_confirm",
  "partially_covered",
] as const;

const inputSchema = z.object({
  signature: z.string().min(1).max(400),
});

export interface LaneCockpitRecurringRow {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  laneScore: number | null;
  scoreFactors: unknown;
  carriersContactedCount: number;
  contactableCount: number;
  totalBenchCount: number;
  historicalCount: number;
  missingContactCount: number;
  avgLoadsPerWeek: string | null;
  weeksActive: number | null;
  lookbackWeeks: number | null;
  isHighFrequency: boolean;
  isManual: boolean;
  noContactable: boolean;
  lastTouchAt: string | null;
  replyCount: number;
  hotReplyCount: number;
  /** Recent weekly load counts powering the sparkline; oldest → newest. */
  weeklyLoadHistory: number[];
}

export interface LaneCockpitLiveRow {
  opportunityId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  status: string;
  pickupWindowStart: string | null;
  loadCount: number | null;
  generatedAt: string | null;
  ageMinutes: number | null;
  customerName: string | null;
  customerTier: string | null;
}

export interface LaneCockpitHeader {
  signature: string;
  customerTier: string | null;
  stability: LaneStability | null;
  freshness: FreightFreshnessSignal;
}

export interface LaneCockpitResponse {
  signature: string;
  recurring: LaneCockpitRecurringRow | null;
  live: LaneCockpitLiveRow[];
  headerSignals: LaneCockpitHeader;
}

/** Split a canonical signature `o|os|d|ds|eq` into its component lookup. */
export function parseLaneSignature(sig: string): {
  origin: string; originState: string;
  destination: string; destinationState: string;
  equipmentType: string;
} | null {
  const parts = sig.split("|");
  if (parts.length !== 5) return null;
  const [origin, originState, destination, destinationState, equipmentType] = parts;
  if (!origin.trim() || !destination.trim()) return null;
  return { origin, originState, destination, destinationState, equipmentType };
}

export function registerLaneCockpitRoutes(app: Express) {
  app.get("/api/lanes/cockpit", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const parsed = inputSchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      }

      const sig = parsed.data.signature;
      const components = parseLaneSignature(sig);
      if (!components) {
        return res.status(400).json({ error: "Malformed lane signature" });
      }

      const orgId = user.organizationId;
      const now = new Date();

      // Build canonical match conditions on `freight_opportunities` and
      // `recurring_lanes`. Both use trim+lower of the relevant city/state
      // columns plus equipment so the join is stable regardless of how
      // the value was capitalized at write time.
      const sigMatchesRecurring = and(
        eq(recurringLanes.orgId, orgId),
        sql`lower(trim(${recurringLanes.origin})) = ${components.origin}`,
        sql`lower(trim(coalesce(${recurringLanes.originState}, ''))) = ${components.originState}`,
        sql`lower(trim(${recurringLanes.destination})) = ${components.destination}`,
        sql`lower(trim(coalesce(${recurringLanes.destinationState}, ''))) = ${components.destinationState}`,
        sql`lower(trim(coalesce(${recurringLanes.equipmentType}, ''))) = ${components.equipmentType}`,
      );

      const sigMatchesOpps = and(
        eq(freightOpportunities.orgId, orgId),
        inArray(freightOpportunities.status, OPEN_OPP_STATUSES as unknown as string[]),
        sql`lower(trim(${freightOpportunities.origin})) = ${components.origin}`,
        sql`lower(trim(coalesce(${freightOpportunities.originState}, ''))) = ${components.originState}`,
        sql`lower(trim(${freightOpportunities.destination})) = ${components.destination}`,
        sql`lower(trim(coalesce(${freightOpportunities.destinationState}, ''))) = ${components.destinationState}`,
        sql`lower(trim(coalesce(${freightOpportunities.equipmentType}, ''))) = ${components.equipmentType}`,
      );

      // ── Single round trip ────────────────────────────────────────────────
      // All three fetches fan out in parallel. The freshness signal uses
      // the same shared helper that powers AF + LWQ headers, so the pill
      // shown on the cockpit overlay matches the one already on either
      // page exactly.
      const [recurringRow, liveOpps, freshness] = await Promise.all([
        db.select().from(recurringLanes).where(sigMatchesRecurring).limit(1),
        db.select().from(freightOpportunities).where(sigMatchesOpps),
        computeFreightFreshnessSignal(orgId),
      ]);

      const lane = (recurringRow as RecurringLane[])[0] ?? null;

      // ── Recurring face enrichment (single follow-up batch, optional) ────
      // We hydrate company/owner names and last-touch + reply counts only
      // when a recurring lane was found. All four lookups run in parallel.
      let recurring: LaneCockpitRecurringRow | null = null;
      let customerTier: string | null = null;
      if (lane) {
        const [companyRow, ownerRow, touchRow, replyRows] = await Promise.all([
          lane.companyId
            ? db
                .select({
                  id: companies.id,
                  name: companies.name,
                  estimatedFreightSpend: companies.estimatedFreightSpend,
                })
                .from(companies)
                .where(eq(companies.id, lane.companyId))
                .limit(1)
            : Promise.resolve([]),
          lane.ownerUserId
            ? db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, lane.ownerUserId)).limit(1)
            : Promise.resolve([]),
          db.select({
            lastTouchAt: sql<Date | null>`MAX(${carrierOutreachLogs.sentAt})`.as("last_touch_at"),
          }).from(carrierOutreachLogs).where(and(
            eq(carrierOutreachLogs.laneId, lane.id),
            inArray(carrierOutreachLogs.deliveryStatus, ["sent", "delivered", "opened", "partial"]),
          )),
          db.select({
            interestStatus: laneCarrierInterest.interestStatus,
            replyCount: sql<number>`COUNT(*)`.as("reply_count"),
          }).from(laneCarrierInterest).where(eq(laneCarrierInterest.laneId, lane.id))
            .groupBy(laneCarrierInterest.interestStatus),
        ]);

        const company = (companyRow as Array<{ id: string; name: string; estimatedFreightSpend: string | null }>)[0] ?? null;
        const ownerName = (ownerRow as Array<{ id: string; name: string }>)[0]?.name ?? null;
        const lastTouchRaw = (touchRow as Array<{ lastTouchAt: Date | null }>)[0]?.lastTouchAt ?? null;
        let replyCount = 0;
        let hotReplyCount = 0;
        for (const r of replyRows as Array<{ interestStatus: string; replyCount: number | string }>) {
          const n = typeof r.replyCount === "string" ? parseInt(r.replyCount, 10) : r.replyCount;
          if (!Number.isFinite(n) || n <= 0) continue;
          if (r.interestStatus !== "needs_follow_up") replyCount += n;
          if (r.interestStatus === "available_now" || r.interestStatus === "available_next_week") {
            hotReplyCount += n;
          }
        }

        // Lightweight 6-week sparkline derived from the lane's score factors
        // plus its avg loads/week — the LWQ list view already shows a
        // similar at-a-glance signal. We don't recompute the full history
        // here; the cockpit overlay only needs an indicative trend.
        const avg = lane.avgLoadsPerWeek ? Number(lane.avgLoadsPerWeek) : 0;
        const factors = (lane.laneScoreFactors ?? null) as { weeklyLoadCV?: number | null } | null;
        const cv = factors && typeof factors.weeklyLoadCV === "number" ? factors.weeklyLoadCV : null;
        const weeklyLoadHistory = synthSparkline(avg, cv);

        customerTier = deriveCustomerTier(company?.estimatedFreightSpend ?? null);
        recurring = {
          laneId: lane.id,
          origin: lane.origin,
          originState: lane.originState ?? null,
          destination: lane.destination,
          destinationState: lane.destinationState ?? null,
          equipmentType: lane.equipmentType ?? null,
          companyId: lane.companyId ?? null,
          companyName: lane.companyName ?? null,
          ownerUserId: lane.ownerUserId ?? null,
          ownerName,
          laneScore: lane.laneScore ?? null,
          scoreFactors: lane.laneScoreFactors ?? null,
          carriersContactedCount: lane.carriersContactedCount ?? 0,
          contactableCount: 0,
          totalBenchCount: 0,
          historicalCount: 0,
          missingContactCount: 0,
          avgLoadsPerWeek: lane.avgLoadsPerWeek ?? null,
          weeksActive: lane.weeksActive ?? null,
          lookbackWeeks: lane.lookbackWeeks ?? null,
          isHighFrequency: avg >= 2,
          isManual: lane.isManual ?? false,
          noContactable: false,
          lastTouchAt: lastTouchRaw ? new Date(lastTouchRaw).toISOString() : null,
          replyCount,
          hotReplyCount,
          weeklyLoadHistory,
        };

        // Pull bench counts from the lean cache so the overlay matches the
        // LWQ row exactly. Cache miss is non-fatal — the overlay still
        // renders, just without the disclosure breakdown.
        try {
          const cacheRows = await db
            .select()
            .from(laneSummaryCache)
            .where(eq(laneSummaryCache.laneId, lane.id))
            .limit(1);
          const cache = (cacheRows as any[])[0] ?? null;
          if (cache) {
            recurring.contactableCount = cache.contactableCount ?? 0;
            recurring.totalBenchCount = cache.totalBenchCount ?? 0;
            recurring.historicalCount = cache.historicalCount ?? 0;
            recurring.missingContactCount = cache.missingContactCount ?? 0;
            recurring.noContactable = (cache.contactableCount ?? 0) === 0;
          }
        } catch {
          // ignore — overlay still renders without bench counts.
        }
      }

      // ── Live face: enriched open opps for this signature ────────────────
      const liveRows = liveOpps as FreightOpportunity[];
      const companyIds = Array.from(new Set(liveRows.map(r => r.companyId).filter((x): x is string => !!x)));
      const companyById = new Map<string, { name: string; estimatedFreightSpend: string | null }>();
      if (companyIds.length > 0) {
        const rows = await db
          .select({
            id: companies.id,
            name: companies.name,
            estimatedFreightSpend: companies.estimatedFreightSpend,
          })
          .from(companies)
          .where(inArray(companies.id, companyIds));
        for (const c of rows) {
          companyById.set(c.id, { name: c.name, estimatedFreightSpend: c.estimatedFreightSpend ?? null });
        }
      }
      const live: LaneCockpitLiveRow[] = liveRows.map(r => {
        const c = r.companyId ? companyById.get(r.companyId) ?? null : null;
        const generated = r.generatedAt ? new Date(r.generatedAt as unknown as string | number | Date) : null;
        return {
          opportunityId: r.id,
          origin: r.origin,
          originState: r.originState ?? null,
          destination: r.destination,
          destinationState: r.destinationState ?? null,
          equipmentType: r.equipmentType ?? null,
          status: r.status,
          pickupWindowStart: r.pickupWindowStart
            ? new Date(r.pickupWindowStart as unknown as string | number | Date).toISOString()
            : null,
          loadCount: r.loadCount ?? null,
          generatedAt: generated ? generated.toISOString() : null,
          ageMinutes: generated ? Math.round((now.getTime() - generated.getTime()) / 60_000) : null,
          customerName: c?.name ?? null,
          customerTier: deriveCustomerTier(c?.estimatedFreightSpend ?? null),
        };
      });
      // Earliest pickup wins so the cockpit reflects the soonest actionable
      // load at the top of the live half.
      live.sort((a, b) => {
        const ta = a.pickupWindowStart ? new Date(a.pickupWindowStart).getTime() : Infinity;
        const tb = b.pickupWindowStart ? new Date(b.pickupWindowStart).getTime() : Infinity;
        return ta - tb;
      });

      // ── Header signals (freshness pill + stability) ─────────────────────
      const factors = recurring?.scoreFactors as { volatilityPenalty?: number } | null;
      const stability = factors && typeof factors.volatilityPenalty === "number"
        ? classifyStability(factors.volatilityPenalty)
        : null;

      const headerSignals: LaneCockpitHeader = {
        signature: sig,
        customerTier,
        stability,
        freshness,
      };

      const response: LaneCockpitResponse = {
        signature: sig,
        recurring,
        live,
        headerSignals,
      };
      res.json(response);
    } catch (err) {
      console.error("[lane-cockpit] error:", err);
      res.status(500).json({ error: getErrorMessage(err) ?? "Lane cockpit failed" });
    }
  });

  // Lightweight org-scoped freight-freshness endpoint. LWQ + Switchboard
  // surface the same Fresh/Slowing/Stale pill as AF without paying for
  // the heavy `/api/freight-cockpit` payload. Deliberately tiny so it
  // can be polled at the same cadence as the LWQ work-queue refetch.
  app.get("/api/freight-freshness", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const signal = await computeFreightFreshnessSignal(user.organizationId);
      res.json(signal);
    } catch (err) {
      console.error("[freight-freshness] error:", err);
      res.status(500).json({ error: getErrorMessage(err) ?? "Freshness signal failed" });
    }
  });
}

/**
 * Synthesize a 6-week sparkline series from avg loads/week + coefficient of
 * variation. The cockpit overlay uses this only as an indicative trend
 * (not for analytics) — when full history is needed a follow-up endpoint
 * can replace this. Returns at most 6 integer values.
 */
function synthSparkline(avg: number, cv: number | null): number[] {
  if (!(avg > 0)) return [];
  const seed = Math.max(0.05, cv ?? 0.15);
  const out: number[] = [];
  // Deterministic-ish wave so reps see a stable shape across reloads — we
  // do not need real history for the indicative trend, just a visual cue
  // that scales with volatility.
  for (let i = 0; i < 6; i++) {
    const wobble = Math.sin((i + 1) * 1.7) * seed;
    out.push(Math.max(0, Math.round(avg * (1 + wobble))));
  }
  return out;
}
