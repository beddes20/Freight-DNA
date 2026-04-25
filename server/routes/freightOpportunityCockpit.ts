// Available Freight Cockpit (Task #601) — triage cockpit routes.

import type { Express } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import {
  FREIGHT_COCKPIT_GROUPINGS,
  FREIGHT_COCKPIT_LAYOUTS,
  FREIGHT_COCKPIT_SORTS,
  FREIGHT_OPPORTUNITY_STATUSES,
  type FreightOpportunity,
  type FreightOpportunityCarrier,
  type Carrier,
  type Company,
  type CompanyOutreachPolicy,
  type RecurringLane,
  type User,
} from "@shared/schema";
import { ensureShortlistRanked } from "../proactiveOpportunityService";
import { sendOpportunityWave } from "../freightOpportunityOutreachService";
import { getBlendedRate } from "../pricingBlendService";

function orgId(req: Express.Request): string {
  return (req as any).session?.organizationId as string;
}
function userId(req: Express.Request): string | null {
  return (req as any).session?.userId ?? null;
}


// Normalized 0-100 urgency: pickup-proximity x tier x lane-score, plus coverage/freshness bonuses.
export function computeCockpitUrgency(input: {
  pickupAt: Date | string | null | undefined;
  generatedAt: Date | string | null | undefined;
  includedCarriers: number;
  sentCarriers: number;
  respondedCarriers: number;
  status: string;
  customerTier?: string | null;
  laneScore?: number | null;
  now?: Date;
}): { score: number; level: "critical" | "high" | "medium" | "low"; reasons: string[] } {
  const now = input.now ?? new Date();
  const reasons: string[] = [];

  // 1) Pickup proximity — base signal (0–60).
  let pickupBase = 0;
  const pickup = input.pickupAt ? new Date(input.pickupAt) : null;
  if (pickup && Number.isFinite(pickup.getTime())) {
    const hours = (pickup.getTime() - now.getTime()) / 3_600_000;
    if (hours <= 12) { pickupBase = 60; reasons.push("pickup ≤ 12h"); }
    else if (hours <= 24) { pickupBase = 50; reasons.push("pickup ≤ 24h"); }
    else if (hours <= 48) { pickupBase = 35; reasons.push("pickup ≤ 48h"); }
    else if (hours <= 96) { pickupBase = 20; reasons.push("pickup ≤ 4d"); }
    else { pickupBase = 10; reasons.push("pickup > 4d"); }
  } else {
    pickupBase = 15;
    reasons.push("pickup unknown");
  }

  // 2) Customer-tier multiplier (0.85–1.30). Platinum customers always
  // float to the top of the queue even on calmer pickup days.
  const tierMultiplier = (() => {
    const t = (input.customerTier ?? "").toLowerCase();
    if (t === "platinum") { reasons.push("platinum customer"); return 1.30; }
    if (t === "gold")     { reasons.push("gold customer");      return 1.15; }
    if (t === "silver")   {                                      return 1.05; }
    if (t === "bronze")   {                                      return 0.95; }
    return 1.0;
  })();

  // 3) Lane-score multiplier (0.9–1.20). Strategic lanes get a bump.
  const laneMultiplier = (() => {
    if (input.laneScore === null || input.laneScore === undefined) return 1.0;
    if (input.laneScore >= 85) { reasons.push("top strategic lane"); return 1.20; }
    if (input.laneScore >= 65) { reasons.push("strong lane");        return 1.10; }
    if (input.laneScore >= 35) return 1.0;
    return 0.9;
  })();

  let score = pickupBase * tierMultiplier * laneMultiplier;

  // 4) Coverage gap (additive, up to 25 pts) — uncovered loads carry urgency.
  if (input.respondedCarriers === 0 && input.sentCarriers === 0) {
    score += 25;
    reasons.push("no outreach yet");
  } else if (input.respondedCarriers === 0) {
    score += 15;
    reasons.push("awaiting reply");
  } else if (input.respondedCarriers < input.sentCarriers) {
    score += 8;
    reasons.push("partial replies");
  }

  // 5) Shortlist health (additive, up to 15 pts) — empty is itself urgent.
  if (input.includedCarriers === 0) {
    score += 15;
    reasons.push("no shortlist");
  } else if (input.includedCarriers < 3) {
    score += 7;
    reasons.push("thin shortlist");
  }

  // 6) Bonus for stale generatedAt (>4h with no replies).
  const generated = input.generatedAt ? new Date(input.generatedAt) : null;
  if (generated && Number.isFinite(generated.getTime())) {
    const ageH = (now.getTime() - generated.getTime()) / 3_600_000;
    if (ageH > 4 && input.respondedCarriers === 0) {
      score += 5;
      reasons.push("stale, no replies");
    }
  }

  // Covered/expired/cancelled rows are de-prioritized hard.
  if (input.status === "covered" || input.status === "expired" || input.status === "cancelled") {
    score = Math.min(score, 5);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score >= 75 ? "critical" : score >= 55 ? "high" : score >= 30 ? "medium" : "low";
  return { score, level, reasons };
}

// The companies table doesn't carry an explicit tier; we derive a comparable
// tier from `estimatedFreightSpend` (decimal stored as string by drizzle).
function deriveCustomerTier(company: Company | null | undefined): string | null {
  const raw = company?.estimatedFreightSpend;
  if (raw === null || raw === undefined || raw === "") return null;
  const spend = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(spend) || spend <= 0) return null;
  if (spend >= 1_000_000) return "platinum";
  if (spend >= 500_000) return "gold";
  if (spend >= 100_000) return "silver";
  return "bronze";
}


function freshnessMinutes(generatedAt: Date | string | null | undefined, now = new Date()): number | null {
  if (!generatedAt) return null;
  const t = new Date(generatedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}


const bulkActionSchema = z.object({
  opportunityIds: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum([
    "approve",
    "snooze",
    "dismiss",
    "reassign",
    "mark_covered",
    "send_top",
  ]),
  ownerUserId: z.string().nullable().optional(),
  snoozeUntil: z.string().nullable().optional(),
  topN: z.number().int().min(1).max(10).optional(),
  reason: z.string().nullable().optional(),
  outcome: z.enum(["covered", "lost", "no_bid"]).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  carrierId: z.string().min(1).optional(),
  carrierName: z.string().min(1).max(200).optional(),
  paidRate: z.number().positive().max(999999).optional(),
  customerRate: z.number().positive().max(999999).optional(),
}).refine(
  (d) => d.action !== "mark_covered" || ((d.carrierId || d.carrierName) && d.paidRate != null && d.customerRate != null),
  { message: "mark_covered requires carrierId|carrierName, paidRate, and customerRate" },
);

const savedViewSchema = z.object({
  name: z.string().min(1).max(80),
  filters: z.record(z.string(), z.unknown()).default({}),
  isShared: z.boolean().optional().default(false),
});

const savedViewPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  isShared: z.boolean().optional(),
});

const prefsPatchSchema = z.object({
  activeViewId: z.string().nullable().optional(),
  layout: z.enum(FREIGHT_COCKPIT_LAYOUTS).optional(),
  grouping: z.enum(FREIGHT_COCKPIT_GROUPINGS).optional(),
  sort: z.enum(FREIGHT_COCKPIT_SORTS).optional(),
  autopilotMutedUntil: z.string().nullable().optional(),
});


// Per-feed lookup caches threaded through buildCockpitRow.
export interface CockpitLookupCaches {
  carriers?: Map<string, Carrier | null>;
  companies?: Map<string, Company | null>;
  policies?: Map<string, CompanyOutreachPolicy | null>;
  lanes?: Map<string, RecurringLane | null>;
  users?: Map<string, User | null>;
}

// SLA dot derivation (see Task #364 awaiting-approval clock).
function computeSlaState(opp: FreightOpportunity, now: Date): {
  level: "green" | "yellow" | "red" | null;
  ageMinutes: number | null;
} {
  if (!opp.awaitingApprovalSince) return { level: null, ageMinutes: null };
  const start = new Date(opp.awaitingApprovalSince);
  if (!Number.isFinite(start.getTime())) return { level: null, ageMinutes: null };
  const ageMinutes = Math.max(0, Math.round((now.getTime() - start.getTime()) / 60_000));
  // L1 notification fires at ~30m, L2 at ~120m. We mirror that here so the
  // UI dot stays in sync with the cron's escalation logic.
  const level = ageMinutes >= 120 ? "red" : ageMinutes >= 30 ? "yellow" : "green";
  return { level, ageMinutes };
}

export async function buildCockpitRow(
  org: string,
  opp: FreightOpportunity,
  opts: { now?: Date; caches?: CockpitLookupCaches } = {},
) {
  const now = opts.now ?? new Date();
  const caches = opts.caches ?? {};
  // Lazy rank — same in-flight join behavior is handled at the caller for the
  // detail page, but for the cockpit we just take whatever shortlist exists
  // and skip lazy-rank for non-blocking listing performance.
  const carriers = await storage.listFreightOpportunityCarriers(opp.id);
  const included = carriers.filter(c => !c.excludedReason);
  const excluded = carriers.filter(c => !!c.excludedReason);
  const sent = included.filter(c => !!c.sentAt);
  const responded = included.filter(c => !!c.lastResponseId);

  // Suppression breakdown — counts of excluded carriers grouped by reason.
  // Surfaced to the ROI panel so reps can see which guardrails are firing
  // most ("policy: do_not_automate", "cap: daily_limit", etc).
  const excludedReasons: Record<string, number> = {};
  for (const c of excluded) {
    const k = c.excludedReason ?? "unknown";
    excludedReasons[k] = (excludedReasons[k] ?? 0) + 1;
  }

  // Top-3 carrier chips. We deliberately bound the look-up to 3 carriers
  // because the cockpit row only renders three chips.
  const top3 = included.slice(0, 3);
  const chips = await Promise.all(
    top3.map(async (row) => {
      let carrier: Carrier | null | undefined;
      if (caches.carriers?.has(row.carrierId)) {
        carrier = caches.carriers.get(row.carrierId)!;
      } else {
        carrier = (await storage.getCarrier(row.carrierId)) ?? null;
        caches.carriers?.set(row.carrierId, carrier);
      }
      // Task #632 — bench tier-0 chip data is stamped on `responsivenessSnapshot`
      // at rank-time (proactiveOpportunityService). Snapshot is JSONB so cast
      // through `unknown` to read it safely without expanding the column type.
      const snap = (row.responsivenessSnapshot ?? {}) as {
        bench?: boolean;
        benchWins?: number;
      };
      return {
        opportunityCarrierId: row.id,
        carrierId: row.carrierId,
        carrierName: carrier?.name ?? "(unknown)",
        bucket: row.bucket,
        rank: row.rank,
        fitScore: row.fitScore,
        // `explanation` powers the fit-score tooltip on the chip ("Top
        // historical performer on this lane (12 loads in 90d)").
        explanation: row.explanation,
        sentAt: row.sentAt,
        // We don't track response timestamp on the join row; use sentAt as a
        // truthy proxy so the chip shows the "responded" check when a response
        // exists (`lastResponseId`). If sentAt is null fall back to createdAt.
        respondedAt: row.lastResponseId ? (row.sentAt ?? row.createdAt) : null,
        bench: !!snap.bench,
        benchWins: typeof snap.benchWins === "number" ? snap.benchWins : 0,
      };
    }),
  );

  // Customer / lane / owner enrichment for tier-aware urgency, owner avatar,
  // SLA dot and per-customer auto-pilot indicator.
  let company: Company | null = null;
  if (opp.companyId) {
    if (caches.companies?.has(opp.companyId)) {
      company = caches.companies.get(opp.companyId)!;
    } else {
      company = (await storage.getCompany(opp.companyId)) ?? null;
      caches.companies?.set(opp.companyId, company);
    }
  }

  let policy: CompanyOutreachPolicy | null = null;
  if (opp.companyId) {
    if (caches.policies?.has(opp.companyId)) {
      policy = caches.policies.get(opp.companyId)!;
    } else {
      policy = (await storage.getCompanyOutreachPolicy(org, opp.companyId)) ?? null;
      caches.policies?.set(opp.companyId, policy);
    }
  }

  let lane: RecurringLane | null = null;
  if (opp.recurringLaneId) {
    if (caches.lanes?.has(opp.recurringLaneId)) {
      lane = caches.lanes.get(opp.recurringLaneId)!;
    } else {
      lane = (await storage.getRecurringLane(opp.recurringLaneId)) ?? null;
      caches.lanes?.set(opp.recurringLaneId, lane);
    }
  }

  let owner: User | null = null;
  const ownerId = opp.delegatedToUserId ?? opp.ownerUserId ?? null;
  if (ownerId) {
    if (caches.users?.has(ownerId)) {
      owner = caches.users.get(ownerId)!;
    } else {
      owner = (await storage.getUser(ownerId)) ?? null;
      caches.users?.set(ownerId, owner);
    }
  }

  // Suggested buy — best-effort. Pricing service errors must never break the
  // cockpit response so we swallow them and surface a null rate.
  let suggestedBuy: {
    rate: number | null;
    confidence: string;
    reason: string;
    marketRpm?: number | null;
    marketDeltaPct?: number | null;
    lastPaidRpm?: number | null;
    loads30d?: number | null;
  } | null = null;
  try {
    const blended = await getBlendedRate({
      orgId: org,
      origin: opp.origin,
      destination: opp.destination,
      originState: opp.originState,
      destinationState: opp.destinationState,
      equipmentType: opp.equipmentType,
      customerName: company?.name ?? null,
    });
    // Surface market delta vs target buy so the cockpit can show "+8% over
    // market" / "-3% under market" badges without a second pricing call.
    const market = (blended as { marketRpm?: number | null }).marketRpm ?? null;
    const marketDeltaPct = (market && blended.targetBuyRpm)
      ? Math.round(((blended.targetBuyRpm - market) / market) * 1000) / 10
      : null;
    // Pull realized history off the blended response so the row can show
    // "last paid $2.34/mi over 12 loads" without a second DB call. Median
    // beats average for skew resilience; fall back to avgCost30d.
    const histLeg = blended.legs?.history;
    const lastPaidRpm =
      histLeg?.medianCostPerMile != null
        ? histLeg.medianCostPerMile
        : histLeg?.avgCost30d != null
          ? histLeg.avgCost30d
          : null;
    const loads30d = histLeg?.loads30d ?? null;
    suggestedBuy = {
      rate: blended.targetBuyRpm,
      confidence: blended.confidence,
      reason: blended.reason,
      marketRpm: market,
      marketDeltaPct,
      lastPaidRpm,
      loads30d,
    };
  } catch (e) {
    suggestedBuy = { rate: null, confidence: "none", reason: (e as Error)?.message ?? "blend failed" };
  }

  const urgency = computeCockpitUrgency({
    pickupAt: opp.pickupWindowStart,
    generatedAt: opp.generatedAt,
    includedCarriers: included.length,
    sentCarriers: sent.length,
    respondedCarriers: responded.length,
    status: opp.status,
    customerTier: deriveCustomerTier(company),
    laneScore: lane?.laneScore ?? null,
    now,
  });

  const sla = computeSlaState(opp, now);

  return {
    opportunity: opp,
    chips,
    coverage: {
      included: included.length,
      sent: sent.length,
      responded: responded.length,
      excluded: excluded.length,
      excludedReasons,
      covered: opp.status === "covered" || opp.status === "partially_covered",
      // Coverage stage drives the row's progression UI:
      //   none → outreach → awaiting → partial → covered
      stage: (opp.status === "covered" || opp.status === "partially_covered")
        ? "covered"
        : responded.length > 0 && responded.length < sent.length
          ? "partial"
          : sent.length > 0 && responded.length === 0
            ? "awaiting"
            : included.length > 0
              ? "outreach"
              : "none",
    },
    suggestedBuy,
    urgency,
    freshnessMinutes: freshnessMinutes(opp.generatedAt, now),
    customer: company ? {
      id: company.id,
      name: company.name,
      accountTier: deriveCustomerTier(company),
      autoPilotEnabled: !!policy?.autoSendEnabled,
    } : null,
    owner: owner ? {
      id: owner.id,
      name: owner.name?.trim() || owner.username,
    } : null,
    sla,
    laneScore: lane?.laneScore ?? null,
  };
}

export type CockpitRow = Awaited<ReturnType<typeof buildCockpitRow>>;


export function registerFreightCockpitRoutes(app: Express) {
  app.get("/api/freight-opportunities/cockpit", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      if (!org) return res.status(400).json({ error: "No organization" });

      const { companyId, status, limit = "100", grouping = "none", sort = "urgency" } = req.query as Record<string, string>;
      const statusList = (status ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
        .filter((s): s is typeof FREIGHT_OPPORTUNITY_STATUSES[number] =>
          (FREIGHT_OPPORTUNITY_STATUSES as readonly string[]).includes(s));

      const rows = await storage.listFreightOpportunities(org, {
        companyId: companyId || undefined,
        status: statusList.length ? statusList : undefined,
        limit: Math.min(500, parseInt(limit) || 100),
        offset: 0,
      });

      const now = new Date();
      // Hide snoozed rows whose snooze hasn't expired so the cockpit stays
      // focused. Snoozed rows are still reachable via /api/freight-opportunities.
      const visibleRows = rows.filter(r => {
        if (!r.snoozedUntil) return true;
        const t = new Date(r.snoozedUntil).getTime();
        if (!Number.isFinite(t)) return true;
        return t <= now.getTime();
      });
      const caches: CockpitLookupCaches = {
        carriers: new Map<string, Carrier | null>(),
        companies: new Map<string, Company | null>(),
        policies: new Map<string, CompanyOutreachPolicy | null>(),
        lanes: new Map<string, RecurringLane | null>(),
        users: new Map<string, User | null>(),
      };
      const items = await Promise.all(visibleRows.map(opp => buildCockpitRow(org, opp, { now, caches })));

      // Re-sort per request (the storage layer already sorts by urgencyScore desc;
      // the cockpit's "urgency" sort uses the just-recomputed score).
      const sortKey = (FREIGHT_COCKPIT_SORTS as readonly string[]).includes(sort) ? sort : "urgency";
      const confidenceRank = (c: string | null | undefined) => {
        switch ((c ?? "").toLowerCase()) {
          case "high": return 3;
          case "medium": return 2;
          case "low": return 1;
          default: return 0;
        }
      };
      items.sort((a, b) => {
        switch (sortKey) {
          case "pickup_soonest": {
            const ta = a.opportunity.pickupWindowStart ? new Date(a.opportunity.pickupWindowStart).getTime() : Infinity;
            const tb = b.opportunity.pickupWindowStart ? new Date(b.opportunity.pickupWindowStart).getTime() : Infinity;
            return ta - tb;
          }
          case "freshness": {
            const fa = a.freshnessMinutes ?? Infinity;
            const fb = b.freshnessMinutes ?? Infinity;
            return fa - fb;
          }
          case "customer":
            return (a.opportunity.companyId || "").localeCompare(b.opportunity.companyId || "");
          case "lane":
            return (`${a.opportunity.origin}->${a.opportunity.destination}`)
              .localeCompare(`${b.opportunity.origin}->${b.opportunity.destination}`);
          case "suggested_buy": {
            // Highest suggested buy first; nulls go last so they don't drown the sort.
            const ra = a.suggestedBuy?.rate ?? -Infinity;
            const rb = b.suggestedBuy?.rate ?? -Infinity;
            return rb - ra;
          }
          case "coverage_pct": {
            // Highest coverage progress first (responded / sent), with no-outreach (sent=0) sorted last.
            const ca = a.coverage.sent > 0 ? a.coverage.responded / a.coverage.sent : -1;
            const cb = b.coverage.sent > 0 ? b.coverage.responded / b.coverage.sent : -1;
            return cb - ca;
          }
          case "confidence": {
            // Suggested-buy confidence: high → medium → low → none.
            return confidenceRank(b.suggestedBuy?.confidence) - confidenceRank(a.suggestedBuy?.confidence);
          }
          case "urgency":
          default:
            return b.urgency.score - a.urgency.score;
        }
      });

      // KPIs per Task #601 contract:
      //   generated today      — opps freshly generated since 00:00 local-day UTC
      //   readyToSend          — status === "ready_to_send"
      //   sentAwaitingCarrier  — outreach is out, no carrier reply yet
      //   atRiskPickup24h      — pickup ≤ 24h away AND not yet covered/closed
      //   coveredToday         — opportunity moved to a covered state today
      // We also retain `total` and `avgFreshnessMinutes` as supporting context.
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const closedStatuses = new Set(["covered", "partially_covered", "expired", "cancelled"]);
      // `coveredToday` is sourced from the audit log so we report ACTUAL state
      // transitions today (independent of which rows happen to still be in the
      // cockpit feed). Falls back to 0 if the helper errors.
      const coveredTodayCount = await storage
        .countFreightOpportunitiesCoveredSince(org, startOfDay)
        .catch((err) => {
          console.error("[freight-cockpit] coveredToday count error:", err);
          return 0;
        });
      const kpis = {
        total: items.length,
        generatedToday: items.filter(i => {
          const t = i.opportunity.generatedAt ? new Date(i.opportunity.generatedAt).getTime() : NaN;
          return Number.isFinite(t) && t >= startOfDay.getTime();
        }).length,
        readyToSend: items.filter(i => i.opportunity.status === "ready_to_send").length,
        sentAwaitingCarrier: items.filter(i => i.coverage.sent > 0 && i.coverage.responded === 0).length,
        atRiskPickup24h: items.filter(i => {
          if (closedStatuses.has(i.opportunity.status)) return false;
          const t = i.opportunity.pickupWindowStart ? new Date(i.opportunity.pickupWindowStart).getTime() : NaN;
          if (!Number.isFinite(t)) return false;
          const hoursAway = (t - now.getTime()) / 3_600_000;
          return hoursAway <= 24 && !i.coverage.covered;
        }).length,
        coveredToday: coveredTodayCount,
        avgFreshnessMinutes: (() => {
          const fresh = items.map(i => i.freshnessMinutes).filter((n): n is number => n !== null);
          if (fresh.length === 0) return null;
          return Math.round(fresh.reduce((a, b) => a + b, 0) / fresh.length);
        })(),
      };

      // ROI metrics — response by carrier bucket, suppression breakdown, and
      // best-effort median time-to-cover. Computed off the cockpit feed so we
      // don't need an extra DB round trip; reflects the currently filtered set.
      const responseByBucket: Record<string, { sent: number; responded: number }> = {};
      const suppressionBreakdown: Record<string, number> = {};
      const timesToCover: number[] = [];
      for (const i of items) {
        for (const chip of i.chips) {
          const k = chip.bucket ?? "other";
          if (!responseByBucket[k]) responseByBucket[k] = { sent: 0, responded: 0 };
          if (chip.sentAt) responseByBucket[k].sent += 1;
          if (chip.respondedAt) responseByBucket[k].responded += 1;
        }
        for (const [reason, count] of Object.entries(i.coverage.excludedReasons ?? {})) {
          suppressionBreakdown[reason] = (suppressionBreakdown[reason] ?? 0) + count;
        }
        // Best-effort time-to-cover: time from generation → covered, in minutes.
        // Without a `coveredAt` column we approximate using freshnessMinutes
        // for currently-covered rows. Skipped when we can't measure it.
        if (i.coverage.covered && typeof i.freshnessMinutes === "number") {
          timesToCover.push(i.freshnessMinutes);
        }
      }
      const medianTimeToCoverMin = (() => {
        if (timesToCover.length === 0) return null;
        const sorted = [...timesToCover].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
          : sorted[mid];
      })();
      const roiMetrics = {
        responseByBucket,
        suppressionBreakdown,
        medianTimeToCoverMin,
      };

      // Last-import summary — most recent generatedAt across the queue is a
      // reliable proxy for "when did the importer last run for this org" since
      // every newly imported opp gets a fresh generatedAt.
      const latest = rows.reduce<Date | null>((acc, r) => {
        const t = r.generatedAt ? new Date(r.generatedAt) : null;
        if (!t || !Number.isFinite(t.getTime())) return acc;
        if (!acc || t > acc) return t;
        return acc;
      }, null);
      const lastImport = latest ? {
        at: latest.toISOString(),
        ageMinutes: Math.round((now.getTime() - latest.getTime()) / 60_000),
      } : null;

      // Next scheduled import: weekday 6:30 AM CT (matches CRON_EXPR).
      const nextImport = (() => {
        try {
          const ct = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
          }).formatToParts(now);
          const get = (k: string) => ct.find(p => p.type === k)?.value ?? "";
          const ctYmd = `${get("year")}-${get("month")}-${get("day")}`;
          const ctHour = parseInt(get("hour"), 10);
          const ctMin = parseInt(get("minute"), 10);
          const weekdayMap: Record<string, number> = {
            Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
          };
          let dow = weekdayMap[get("weekday")] ?? 1;
          let daysAhead = 0;
          const isWeekday = dow >= 1 && dow <= 5;
          const beforeFire = ctHour < 6 || (ctHour === 6 && ctMin < 30);
          if (!(isWeekday && beforeFire)) {
            for (let i = 1; i <= 7; i++) {
              const next = (dow + i) % 7;
              if (next >= 1 && next <= 5) { daysAhead = i; break; }
            }
          }
          const [y, m, d] = ctYmd.split("-").map(Number);
          const target = new Date(Date.UTC(y, m - 1, d, 6, 30, 0));
          target.setUTCDate(target.getUTCDate() + daysAhead);
          const utcHour = now.getUTCHours();
          let offsetH = utcHour - ctHour;
          if (offsetH < 0) offsetH += 24;
          target.setUTCHours(target.getUTCHours() + offsetH);
          const inMinutes = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60_000));
          return { at: target.toISOString(), inMinutes };
        } catch {
          return null;
        }
      })();

      // Optional grouping done client-side off `groupKey` to keep the response
      // flat & cacheable. We just compute the key.
      const groupKey = (FREIGHT_COCKPIT_GROUPINGS as readonly string[]).includes(grouping) ? grouping : "none";
      const itemsWithGroup = items.map(i => ({
        ...i,
        groupKey: groupKey === "customer"
          ? (i.opportunity.companyId || "—")
          : groupKey === "pickup_day"
            ? (i.opportunity.pickupWindowStart ? new Date(i.opportunity.pickupWindowStart).toISOString().slice(0, 10) : "—")
            : groupKey === "lane"
              ? `${i.opportunity.origin} → ${i.opportunity.destination}`
              : "all",
      }));

      res.json({
        items: itemsWithGroup,
        kpis,
        lastImport,
        nextImport,
        roiMetrics,
        sort: sortKey,
        grouping: groupKey,
      });
    } catch (err) {
      console.error("[freight-cockpit] feed error:", err);
      res.status(500).json({ error: "Failed to load cockpit" });
    }
  });

  app.post("/api/freight-opportunities/bulk-action", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      if (!org) return res.status(400).json({ error: "No organization" });
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const parsed = bulkActionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid bulk-action payload", issues: parsed.error.issues });

      const { opportunityIds, action } = parsed.data;
      const results: Array<{
        opportunityId: string;
        ok: boolean;
        message?: string;
        sent?: number;
        blocked?: number;
      }> = [];

      for (const oppId of opportunityIds) {
        try {
          const opp = await storage.getFreightOpportunity(org, oppId);
          if (!opp) {
            results.push({ opportunityId: oppId, ok: false, message: "Not found" });
            continue;
          }
          if (action === "approve") {
            const updated = await storage.updateFreightOpportunity(org, opp.id, {
              status: "ready_to_send",
              approvedAt: new Date(),
              approvedById: user.id,
            });
            await storage.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "approved",
              actorUserId: user.id,
              payload: { source: "bulk_action" },
            });
            results.push({ opportunityId: oppId, ok: !!updated });
          } else if (action === "snooze") {
            const until = parsed.data.snoozeUntil ? new Date(parsed.data.snoozeUntil) : null;
            await storage.updateFreightOpportunity(org, opp.id, { snoozedUntil: until });
            await storage.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "status_changed",
              actorUserId: user.id,
              payload: { kind: "snoozed", until: until?.toISOString() ?? null, reason: parsed.data.reason ?? null },
            });
            results.push({ opportunityId: oppId, ok: true });
          } else if (action === "dismiss") {
            await storage.updateFreightOpportunity(org, opp.id, { status: "cancelled" });
            await storage.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "cancelled",
              actorUserId: user.id,
              payload: {
                source: "bulk_action",
                reason: parsed.data.reason ?? null,
                outcome: parsed.data.outcome ?? null,
                notes: parsed.data.notes ?? null,
                to: "cancelled",
              },
            });
            results.push({ opportunityId: oppId, ok: true });
          } else if (action === "reassign") {
            await storage.updateFreightOpportunity(org, opp.id, { ownerUserId: parsed.data.ownerUserId ?? null });
            await storage.appendFreightOpportunityAudit({
              opportunityId: opp.id,
              eventType: "status_changed",
              actorUserId: user.id,
              payload: { kind: "reassigned", to: parsed.data.ownerUserId ?? null },
            });
            results.push({ opportunityId: oppId, ok: true });
          } else if (action === "mark_covered") {
            const { coverFreightOpportunity } = await import("../services/coverFreightOpportunity");
            const outcome = await coverFreightOpportunity({
              org,
              rep: user,
              opp,
              payload: {
                carrierId: parsed.data.carrierId ?? null,
                carrierName: parsed.data.carrierName ?? null,
                paidRate: parsed.data.paidRate!,
                customerRate: parsed.data.customerRate!,
                notes: parsed.data.notes ?? null,
              },
            });
            if (outcome.ok) {
              results.push({
                opportunityId: oppId,
                ok: true,
                loadFact: outcome.loadFact ? { inserted: outcome.loadFact.inserted, updated: outcome.loadFact.updated } : null,
              });
            } else {
              results.push({ opportunityId: oppId, ok: false, message: outcome.error });
            }
          } else if (action === "send_top") {
            // Re-evaluate guardrails inside sendOpportunityWave by selecting
            // the top-N included carriers and delegating. This preserves all
            // policy/dedup/cross-throttle logic that the per-row Send uses.
            await ensureShortlistRanked(storage, opp);
            const carriers = await storage.listFreightOpportunityCarriers(opp.id);
            const topN = parsed.data.topN ?? 3;
            const candidates = carriers
              .filter(c => !c.excludedReason && !c.sentAt)
              .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
              .slice(0, topN);
            if (candidates.length === 0) {
              results.push({ opportunityId: oppId, ok: true, sent: 0, blocked: 0, message: "No eligible carriers" });
              continue;
            }
            try {
              const { results: waveResults } = await sendOpportunityWave(
                storage, org, opp.id, user, { carrierRowIds: candidates.map(c => c.id) },
              );
              const sent = waveResults.filter(r => r.status === "sent" || r.status === "scheduled").length;
              const blocked = waveResults.filter(r => r.status === "blocked").length;
              results.push({ opportunityId: oppId, ok: true, sent, blocked });
            } catch (sendErr) {
              const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
              results.push({ opportunityId: oppId, ok: false, message });
            }
          }
        } catch (e) {
          results.push({ opportunityId: oppId, ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }

      res.json({ action, results });
    } catch (err) {
      console.error("[freight-cockpit] bulk error:", err);
      res.status(500).json({ error: "Bulk action failed" });
    }
  });

  app.get("/api/freight-opportunities/saved-views", requireAuth, async (req, res) => {
    const org = orgId(req);
    const uid = userId(req);
    if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
    const views = await storage.listFreightOpportunitySavedViews(org, uid);
    // Built-in operational tabs (Task #601). They are virtual — `id` is
    // prefixed with `builtin:` so PATCH/DELETE refuse them and the cockpit
    // UI just treats them as pinned tabs at the front of the list.
    const builtIn = [
      {
        id: "builtin:my-freight-today",
        name: "My freight today",
        isShared: false,
        isBuiltIn: true,
        filters: { ownerScope: "mine", pickupWithinHours: 24 },
      },
      {
        id: "builtin:team-needs-approval",
        name: "Team needs approval",
        isShared: true,
        isBuiltIn: true,
        filters: { statuses: ["awaiting_approval"], ownerScope: "team" },
      },
      {
        id: "builtin:pickup-tomorrow",
        name: "Pickup tomorrow",
        isShared: false,
        isBuiltIn: true,
        filters: { pickupWithinHours: 48, pickupAfterHours: 24 },
      },
      {
        id: "builtin:low-confidence",
        name: "Low confidence",
        isShared: false,
        isBuiltIn: true,
        filters: { confidenceFlag: "low" },
      },
      {
        id: "builtin:no-response-4h",
        name: "No response in 4h",
        isShared: false,
        isBuiltIn: true,
        filters: { sentNoReplyMinAgeMin: 240 },
      },
    ];
    res.json({ views, builtInViews: builtIn });
  });

  app.post("/api/freight-opportunities/saved-views", requireAuth, async (req, res) => {
    const org = orgId(req);
    const uid = userId(req);
    if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
    const parsed = savedViewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid view", issues: parsed.error.issues });
    const view = await storage.createFreightOpportunitySavedView({
      orgId: org,
      userId: uid,
      name: parsed.data.name,
      filters: parsed.data.filters,
      isShared: parsed.data.isShared,
    });
    res.json({ view });
  });

  app.patch("/api/freight-opportunities/saved-views/:id", requireAuth, async (req, res) => {
    const org = orgId(req);
    const uid = userId(req);
    if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
    const parsed = savedViewPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid patch", issues: parsed.error.issues });
    const view = await storage.updateFreightOpportunitySavedView(String(req.params.id), uid, {
      name: parsed.data.name,
      filters: parsed.data.filters,
      isShared: parsed.data.isShared,
    }, org);
    if (!view) return res.status(404).json({ error: "View not found" });
    res.json({ view });
  });

  app.delete("/api/freight-opportunities/saved-views/:id", requireAuth, async (req, res) => {
    const org = orgId(req);
    const uid = userId(req);
    if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
    const ok = await storage.deleteFreightOpportunitySavedView(String(req.params.id), uid, org);
    res.json({ ok });
  });

  app.get("/api/freight-opportunities/cockpit-prefs", requireAuth, async (req, res) => {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: "Unauthorized" });
    const prefs = await storage.getUserFreightCockpitPrefs(uid);
    res.json({ prefs: prefs ?? null });
  });

  app.patch("/api/freight-opportunities/cockpit-prefs", requireAuth, async (req, res) => {
    const org = orgId(req);
    const uid = userId(req);
    if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
    const parsed = prefsPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid prefs", issues: parsed.error.issues });
    if (parsed.data.activeViewId) {
      const visible = await storage.listFreightOpportunitySavedViews(org, uid);
      if (!visible.some(v => v.id === parsed.data.activeViewId)) {
        return res.status(400).json({ error: "Invalid activeViewId" });
      }
    }
    const existing = await storage.getUserFreightCockpitPrefs(uid);
    const prefs = await storage.upsertUserFreightCockpitPrefs({
      userId: uid,
      orgId: org,
      activeViewId: parsed.data.activeViewId !== undefined ? parsed.data.activeViewId : existing?.activeViewId ?? null,
      layout: (parsed.data.layout ?? existing?.layout ?? "table") as (typeof FREIGHT_COCKPIT_LAYOUTS)[number],
      grouping: (parsed.data.grouping ?? existing?.grouping ?? "none") as (typeof FREIGHT_COCKPIT_GROUPINGS)[number],
      sort: (parsed.data.sort ?? existing?.sort ?? "urgency") as (typeof FREIGHT_COCKPIT_SORTS)[number],
      autopilotMutedUntil: parsed.data.autopilotMutedUntil !== undefined
        ? (parsed.data.autopilotMutedUntil ? new Date(parsed.data.autopilotMutedUntil) : null)
        : existing?.autopilotMutedUntil ?? null,
    });
    res.json({ prefs });
  });
}
