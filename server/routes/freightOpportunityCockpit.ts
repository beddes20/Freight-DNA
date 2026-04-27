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
import {
  listAutoPilotPendingForOrg,
  buildSkipNextRunPolicyUpsert,
  buildDisableAutoSendPolicyUpsert,
} from "../freightOpportunityAutoPilot";
import {
  buildLwqContextByLaneSig,
  laneSig,
  type LwqLaneContext,
} from "../laneCrossLinkService";
import { getCarrierCoverableLanes } from "../services/carrierCoverableLanes";
import { db } from "../storage";
import { publish as publishLiveSync } from "../services/liveSync";
import { getErrorMessage } from "../lib/errors";
import { pStr } from "../lib/req";
import { todayIsoInOrgTz } from "../lib/orgLocalDate";

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
  // Task #636 — per-cover opt-out flags for the three downstream
  // capture loops (bench, lane rate band, recurring-lane suggestion).
  applyToBench: z.boolean().optional(),
  applyToRateBand: z.boolean().optional(),
  offerRecurringLane: z.boolean().optional(),
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
        carrier = (await storage.getCarrierInOrg(row.carrierId, org)) ?? null;
        caches.carriers?.set(row.carrierId, carrier);
      }
      // Task #632 — bench tier-0 chip data is stamped on `responsivenessSnapshot`
      // at rank-time (proactiveOpportunityService). Snapshot is JSONB so cast
      // through `unknown` to read it safely without expanding the column type.
      // Task #633 also stamps `reasons` (capped, ordered) and the original
      // `suppressionReasons` so the chip popover can render them inline.
      const snap = (row.responsivenessSnapshot ?? {}) as {
        bench?: boolean;
        benchWins?: number;
        reasons?: string[];
        suppressionReasons?: string[];
        claimed?: boolean;
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
        // Task #633 — surface "why this carrier" reasons + suppression list to
        // the cockpit chip popover. Both are bounded plain-string arrays.
        reasons: Array.isArray(snap.reasons) ? snap.reasons : [],
        suppressionReasons: Array.isArray(snap.suppressionReasons) ? snap.suppressionReasons : [],
        // Cross-tab UX (option C) — carrier-asserted lane preference. Drives
        // the small "claimed" pill rendered next to the carrier badge.
        claimed: !!snap.claimed,
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

      const user = await getCurrentUser(req);
      const { companyId, status, limit = "100", grouping = "none", sort = "pickup_soonest", lane: laneFilter, carrierId: carrierFilter } = req.query as Record<string, string>;
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
      // Also drop rows whose pickup window start is before today (Task #750).
      // Reps can't act on freight that was supposed to move days ago, and
      // these rows would otherwise bury today's real work. Rows with no
      // pickup date set are kept (they're not "past"). The underlying rows
      // remain reachable via /api/freight-opportunities and the audit log.
      // pickupWindowStart is a text column storing ISO date strings
      // (YYYY-MM-DD or full ISO) so we slice the first 10 chars and compare
      // lexicographically against today's date in the org's local
      // timezone (CT — see server/lib/orgLocalDate.ts). UTC midnight lands
      // at 6 PM the prior CT day, so deriving "today" from UTC would hide
      // loads that are still "today" for the rep.
      const todayIso = todayIsoInOrgTz(now);
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const startOfTodayMs = startOfToday.getTime();
      const visibleRows = rows.filter(r => {
        if (r.snoozedUntil) {
          const t = new Date(r.snoozedUntil).getTime();
          if (Number.isFinite(t) && t > now.getTime()) return false;
        }
        if (r.pickupWindowStart) {
          const pickupIso = String(r.pickupWindowStart).slice(0, 10);
          if (pickupIso && pickupIso < todayIso) return false;
        }
        return true;
      });
      const caches: CockpitLookupCaches = {
        carriers: new Map<string, Carrier | null>(),
        companies: new Map<string, Company | null>(),
        policies: new Map<string, CompanyOutreachPolicy | null>(),
        lanes: new Map<string, RecurringLane | null>(),
        users: new Map<string, User | null>(),
      };
      const baseItems = await Promise.all(visibleRows.map(opp => buildCockpitRow(org, opp, { now, caches })));

      // Task #635 — Cross-link map: which AF rows match a lane in the rep's
      // LWQ. Computed in a single pass per request (no per-row N+1).
      let lwqByLaneSig: Map<string, LwqLaneContext> = new Map();
      if (user) {
        try {
          const { visibleUserIds, canSeeUnassigned } = await storage.resolveVisibleUserIds(
            user.id, org, user.role,
          );
          lwqByLaneSig = await buildLwqContextByLaneSig(db, org, visibleUserIds, canSeeUnassigned);
        } catch (err) {
          console.error("[freight-cockpit] lwq context build error:", err);
        }
      }
      const enriched = baseItems.map(i => {
        const sig = laneSig(
          i.opportunity.origin,
          i.opportunity.originState,
          i.opportunity.destination,
          i.opportunity.destinationState,
          i.opportunity.equipmentType,
        );
        const lwqContext = lwqByLaneSig.get(sig) ?? null;
        return { ...i, lwqContext, laneSignature: sig };
      });

      // Optional `?lane=<sig>` deep-link filter — used by LWQ chip → AF.
      let items = laneFilter
        ? enriched.filter(i => i.laneSignature === laneFilter)
        : enriched;

      // Optional `?carrierId=<id>` deep-link filter — Carrier Hub → AF.
      // Keeps only opportunities the carrier "could cover" (claimed lanes
      // OR historical load_fact lanes). Falls through silently if the
      // carrier was not found so the URL never produces a confusing
      // empty cockpit because of a typo'd ID.
      if (carrierFilter) {
        try {
          const lookup = await getCarrierCoverableLanes(org, carrierFilter);
          if (lookup) {
            items = items.filter(i => lookup.matches({
              origin: i.opportunity.origin,
              originState: i.opportunity.originState,
              destination: i.opportunity.destination,
              destinationState: i.opportunity.destinationState,
              equipmentType: i.opportunity.equipmentType,
            }));
          }
        } catch (err) {
          console.error("[freight-cockpit] carrier coverable filter error:", err);
        }
      }

      // Re-sort per request (the storage layer already sorts by urgencyScore desc;
      // the cockpit's "urgency" sort uses the just-recomputed score).
      const sortKey = (FREIGHT_COCKPIT_SORTS as readonly string[]).includes(sort) ? sort : "pickup_soonest";
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
      // `startOfToday` (computed above for the past-pickup filter) doubles as
      // our "since 00:00 today" reference for these KPIs.
      const closedStatuses = new Set(["covered", "partially_covered", "expired", "cancelled"]);
      // `coveredToday` is sourced from the audit log so we report ACTUAL state
      // transitions today (independent of which rows happen to still be in the
      // cockpit feed). Falls back to 0 if the helper errors.
      const coveredTodayCount = await storage
        .countFreightOpportunitiesCoveredSince(org, startOfToday)
        .catch((err) => {
          console.error("[freight-cockpit] coveredToday count error:", err);
          return 0;
        });
      const kpis = {
        total: items.length,
        generatedToday: items.filter(i => {
          const t = i.opportunity.generatedAt ? new Date(i.opportunity.generatedAt).getTime() : NaN;
          return Number.isFinite(t) && t >= startOfTodayMs;
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
      // Task #636 — `mark_covered` paths attach the canonical `loadFact` and
      // capture-loop result so the client can surface "Set as recurring lane".
      // Other actions leave these undefined.
      const results: Array<{
        opportunityId: string;
        ok: boolean;
        message?: string;
        sent?: number;
        blocked?: number;
        loadFact?: { inserted: boolean; updated: boolean } | null;
        loops?: {
          bench?: { applied: boolean; reason: string; rows: Array<{ laneId: string; benchRowId: string }> };
          rateBand?: { applied: boolean; reason: string };
          recurringLaneSuggestion?: {
            suggested: boolean;
            reason: string;
            suggestion?: {
              origin: string;
              originState: string | null;
              destination: string;
              destinationState: string | null;
              equipmentType: string | null;
              companyId: string | null;
              companyName: string | null;
            };
          };
        } | null;
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
                loops: {
                  applyToBench: parsed.data.applyToBench ?? true,
                  applyToRateBand: parsed.data.applyToRateBand ?? true,
                  offerRecurringLane: parsed.data.offerRecurringLane ?? true,
                },
              },
            });
            if (outcome.ok) {
              results.push({
                opportunityId: oppId,
                ok: true,
                loadFact: outcome.loadFact ? { inserted: outcome.loadFact.inserted, updated: outcome.loadFact.updated } : null,
                loops: outcome.loops,
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

      // Cross-tab UX (option A) — bulk-action mutates one or more opps;
      // a single org-wide hint is enough to nudge open AF tabs to refetch.
      // Per-opp keys are intentionally omitted (the UI invalidates the list
      // query, not individual rows).
      if (results.some(r => r.ok)) publishLiveSync(org, "freight_opportunity");
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
    const view = await storage.updateFreightOpportunitySavedView(pStr(req.params.id), uid, {
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
    const ok = await storage.deleteFreightOpportunitySavedView(pStr(req.params.id), uid, org);
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
      sort: (parsed.data.sort ?? existing?.sort ?? "pickup_soonest") as (typeof FREIGHT_COCKPIT_SORTS)[number],
      autopilotMutedUntil: parsed.data.autopilotMutedUntil !== undefined
        ? (parsed.data.autopilotMutedUntil ? new Date(parsed.data.autopilotMutedUntil) : null)
        : existing?.autopilotMutedUntil ?? null,
    });
    res.json({ prefs });
  });

  // ── Auto-pilot transparency drawer (Task #634) ──────────────────────────
  // Read-only preview of what the scheduler would dispatch at the next CT
  // hour. Mirrors `runAutoPilotTick` selection logic; does not send.
  app.get("/api/freight-opportunities/auto-pilot/preview", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      if (!org) return res.status(400).json({ error: "No organization" });
      const now = new Date();
      const entries = await listAutoPilotPendingForOrg(storage, org, now);

      // Hydrate company name + carrier name + suggested buy. Caches keep the
      // response cheap when one company has many opps.
      const carrierCache = new Map<string, Carrier | null>();
      const companyCache = new Map<string, Company | null>();

      const companies = await Promise.all(entries.map(async (entry) => {
        const company = await (async () => {
          if (companyCache.has(entry.policy.companyId)) return companyCache.get(entry.policy.companyId)!;
          const c = (await storage.getCompany(entry.policy.companyId)) ?? null;
          companyCache.set(entry.policy.companyId, c);
          return c;
        })();

        const opportunities = await Promise.all(entry.opportunities.map(async (oppEntry) => {
          const opp = oppEntry.opportunity;

          // Carrier-name hydration (parallel, dedup'd by id).
          const allRows = [...oppEntry.candidates, ...oppEntry.suppressed];
          await Promise.all(allRows.map(async (row) => {
            if (carrierCache.has(row.carrierId)) return;
            carrierCache.set(row.carrierId, (await storage.getCarrierInOrg(row.carrierId, org)) ?? null);
          }));
          const carrierName = (id: string) => carrierCache.get(id)?.name ?? "(unknown)";

          // Suggested buy — best-effort; pricing failures must never break the
          // preview since the scheduler doesn't compute it either.
          let suggestedBuy: { rate: number | null; confidence: string; reason: string } | null = null;
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
            suggestedBuy = {
              rate: blended.targetBuyRpm,
              confidence: blended.confidence,
              reason: blended.reason,
            };
          } catch (e) {
            suggestedBuy = { rate: null, confidence: "none", reason: (e as Error)?.message ?? "blend failed" };
          }

          return {
            opportunityId: opp.id,
            origin: opp.origin,
            originState: opp.originState,
            destination: opp.destination,
            destinationState: opp.destinationState,
            equipmentType: opp.equipmentType,
            pickupWindowStart: opp.pickupWindowStart,
            loadCount: opp.loadCount,
            status: opp.status,
            candidates: oppEntry.candidates.map(c => ({
              rowId: c.rowId, carrierId: c.carrierId, carrierName: carrierName(c.carrierId),
              rank: c.rank, fitScore: c.fitScore, bucket: c.bucket, explanation: c.explanation,
            })),
            suppressed: oppEntry.suppressed.map(c => ({
              carrierId: c.carrierId, carrierName: carrierName(c.carrierId), reason: c.reason,
            })),
            suggestedBuy,
          };
        }));

        return {
          companyId: entry.policy.companyId,
          companyName: company?.name ?? "(unknown company)",
          policyId: entry.policy.id,
          nextRunAt: entry.nextRunAt.toISOString(),
          ctHour: entry.policy.autoSendHourCt,
          topN: entry.policy.autoSendTopN,
          maxPerDay: entry.policy.autoSendMaxPerDay,
          approvalRequired: entry.policy.approvalRequired,
          autoSendEnabled: entry.policy.autoSendEnabled,
          blockedReason: entry.blockedReason ?? null,
          totalCarriers: entry.totalCarriers,
          opportunities,
        };
      }));

      const totalCarriers = companies.reduce((a, c) => a + c.totalCarriers, 0);
      const nextRunAt = companies.length > 0 ? companies[0].nextRunAt : null;
      const ctHour = companies.length > 0 ? companies[0].ctHour : null;

      res.json({
        nextRunAt,
        ctHour,
        totalCompanies: companies.length,
        totalCarriers,
        companies,
      });
    } catch (err) {
      console.error("[auto-pilot] preview failed:", err);
      res.status(500).json({ error: "Failed to load auto-pilot preview" });
    }
  });

  const skipSchema = z.object({ companyId: z.string().min(1) });
  app.post("/api/freight-opportunities/auto-pilot/skip", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
      const parsed = skipSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });

      const policy = await storage.getCompanyOutreachPolicy(org, parsed.data.companyId);
      if (!policy) return res.status(404).json({ error: "Policy not found" });
      if (!policy.autoSendEnabled) return res.status(400).json({ error: "Auto-pilot is not armed for this customer" });

      const now = new Date();
      // Audit the would-have-been-sent opps BEFORE flipping lastRunAt so the
      // preview helper still returns them.
      const entries = await listAutoPilotPendingForOrg(storage, org, now);
      const entry = entries.find(e => e.policy.companyId === parsed.data.companyId);
      const auditPayload = {
        kind: "auto_pilot_skipped" as const,
        companyId: parsed.data.companyId,
        actorUserId: uid,
        skippedAt: now.toISOString(),
      };
      if (entry) {
        await Promise.all(entry.opportunities.map(o =>
          storage.appendFreightOpportunityAudit({
            opportunityId: o.opportunity.id,
            eventType: "outreach_blocked",
            actorUserId: uid,
            payload: auditPayload,
          }).catch((auditErr: unknown) => {
            // Audit must never block the rep action; log so failures are
            // visible in production without losing the persisted skip.
            console.error("[auto-pilot] skip audit failed", {
              opportunityId: o.opportunity.id, err: (auditErr as Error)?.message,
            });
          })
        ));
      } else {
        console.log("[auto-pilot] skip recorded with no pending opportunities", {
          companyId: parsed.data.companyId, actorUserId: uid,
        });
      }

      const upsert = buildSkipNextRunPolicyUpsert(policy, now);
      // Preserve audit trail of the user that performed the skip.
      upsert.updatedById = uid;
      const updated = await storage.upsertCompanyOutreachPolicy(upsert);
      res.json({ policy: updated, skippedOpportunities: entry?.opportunities.length ?? 0 });
    } catch (err) {
      console.error("[auto-pilot] skip failed:", err);
      res.status(500).json({ error: "Failed to skip auto-pilot run" });
    }
  });

  const disableSchema = z.object({
    companyId: z.string().min(1),
    confirm: z.literal(true),
  });
  app.post("/api/freight-opportunities/auto-pilot/disable", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
      const parsed = disableSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });

      const policy = await storage.getCompanyOutreachPolicy(org, parsed.data.companyId);
      if (!policy) return res.status(404).json({ error: "Policy not found" });

      const now = new Date();
      const entries = await listAutoPilotPendingForOrg(storage, org, now);
      const entry = entries.find(e => e.policy.companyId === parsed.data.companyId);
      const auditPayload = {
        kind: "auto_pilot_disabled" as const,
        companyId: parsed.data.companyId,
        actorUserId: uid,
        disabledAt: now.toISOString(),
      };
      if (entry) {
        await Promise.all(entry.opportunities.map(o =>
          storage.appendFreightOpportunityAudit({
            opportunityId: o.opportunity.id,
            eventType: "policy_blocked",
            actorUserId: uid,
            payload: auditPayload,
          }).catch((auditErr: unknown) => {
            console.error("[auto-pilot] disable audit failed", {
              opportunityId: o.opportunity.id, err: (auditErr as Error)?.message,
            });
          })
        ));
      } else {
        console.log("[auto-pilot] disable recorded with no pending opportunities", {
          companyId: parsed.data.companyId, actorUserId: uid,
        });
      }

      const upsert = buildDisableAutoSendPolicyUpsert(policy);
      upsert.updatedById = uid;
      const updated = await storage.upsertCompanyOutreachPolicy(upsert);
      res.json({ policy: updated, blockedOpportunities: entry?.opportunities.length ?? 0 });
    } catch (err) {
      console.error("[auto-pilot] disable failed:", err);
      res.status(500).json({ error: "Failed to disable auto-pilot policy" });
    }
  });

  const approveNowSchema = z.object({
    opportunityId: z.string().min(1),
    carrierRowIds: z.array(z.string().min(1)).min(1).max(20),
  });
  app.post("/api/freight-opportunities/auto-pilot/approve-now", requireAuth, async (req, res) => {
    try {
      const org = orgId(req);
      const uid = userId(req);
      if (!org || !uid) return res.status(401).json({ error: "Unauthorized" });
      const parsed = approveNowSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });

      const opp = await storage.getFreightOpportunity(org, parsed.data.opportunityId);
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });

      // Reuse the rep's session user as the actor — Approve-now is the rep
      // explicitly choosing to bypass the wait, so attribute the send to them
      // (not the policy.updatedById). sendOpportunityWave still re-evaluates
      // every guardrail; we are only choosing carrier rows here.
      const actor = await storage.getUser(uid);
      if (!actor) return res.status(401).json({ error: "Unauthorized" });

      const { results, opportunity } = await sendOpportunityWave(storage, org, opp.id, actor, {
        carrierRowIds: parsed.data.carrierRowIds,
        sourceModule: "auto_pilot",
      });

      // Tag the audit with the approve-now kind so reviewers can distinguish
      // these from the scheduled tick. sendOpportunityWave already wrote per-
      // carrier audit entries; this is a single summary marker.
      await storage.appendFreightOpportunityAudit({
        opportunityId: opp.id,
        eventType: "outreach_sent",
        actorUserId: uid,
        payload: {
          kind: "auto_pilot_approve_now",
          carrierRowIds: parsed.data.carrierRowIds,
          sentNow: results.filter(r => r.status === "sent" || r.status === "scheduled").length,
          blocked: results.filter(r => r.status === "blocked").length,
        },
      }).catch((auditErr: unknown) => {
        console.error("[auto-pilot] approve-now summary audit failed", {
          opportunityId: opp.id, err: (auditErr as Error)?.message,
        });
      });

      res.json({ opportunity, results });
    } catch (err) {
      console.error("[auto-pilot] approve-now failed:", err);
      const msg = getErrorMessage(err);
      res.status(400).json({ error: msg });
    }
  });
}
