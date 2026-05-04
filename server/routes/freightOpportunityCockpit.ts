// Available Freight Cockpit (Task #601) — triage cockpit routes.

import type { Express } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser, getImpersonationContext } from "../auth";
import { storage } from "../storage";
import {
  FREIGHT_COCKPIT_GROUPINGS,
  FREIGHT_COCKPIT_LAYOUTS,
  FREIGHT_COCKPIT_SORTS,
  FREIGHT_OPPORTUNITY_STATUSES,
  freightOpportunities,
  type FreightOpportunity,
  type FreightOpportunityCarrier,
  type Carrier,
  type Company,
  type CompanyOutreachPolicy,
  type RecurringLane,
  type User,
} from "@shared/schema";
import { sql, and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { ensureShortlistRanked } from "../proactiveOpportunityService";
import { sendOpportunityWave } from "../freightOpportunityOutreachService";
import { getBlendedRateCached } from "../pricingBlendService";
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
import {
  computePickupFreshness,
  daysSincePickup,
  shouldHideForPickup,
  isPickupScope,
  isPickupWithinHours,
  DEFAULT_PICKUP_SCOPE,
  PICKUP_GRACE_DAYS_DEFAULT,
  type PickupScope,
  type PickupFreshness,
} from "@shared/pickupFreshness";
import {
  buildRowOwnership,
  isRowOwnedByUser,
  resolveUserIdentity,
  type CockpitRowOwnership,
} from "@shared/cockpitOwnership";
import {
  parseOwnerScopeTokens,
  resolveOwnerScope,
  isValidOwnerScopeToken,
} from "@shared/cockpitTeams";

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

// Task #900 — owner filter aliases. Specific-user filters pass through as
// arbitrary userId strings; the route refuses anything that's neither an
// alias nor a syntactically plausible id.
//
// Task #957 — owner filter is now multi-select: the value may be a single
// alias / userId (legacy) OR a comma-joined list of tokens. Each token is
// one of {"all" | "me" | "my-team" | "unassigned" | "team:<id>" | <userId>}.
// `parseOwnerScopeTokens` + `resolveOwnerScope` from `shared/cockpitTeams`
// handle the expansion server-side so the same predicate the client uses
// drives the visible row set.
const OWNER_FILTER_ALIASES = ["all", "me", "unassigned"] as const;
type OwnerFilterAlias = typeof OWNER_FILTER_ALIASES[number];
function isOwnerFilterAlias(v: unknown): v is OwnerFilterAlias {
  return typeof v === "string" && (OWNER_FILTER_ALIASES as readonly string[]).includes(v);
}
function isPlausibleUserId(v: unknown): boolean {
  return typeof v === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(v);
}
function isOwnerFilterValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  // Empty string — treat as "all".
  if (v.length === 0) return true;
  // Comma-joined multi-select: every individual token must be valid.
  if (v.includes(",")) {
    const tokens = parseOwnerScopeTokens(v);
    if (tokens.length === 0) return false;
    return tokens.every((t) => isValidOwnerScopeToken(t));
  }
  // Single token — accept legacy aliases, plausible userIds, "my-team",
  // and "team:<id>".
  if (isOwnerFilterAlias(v)) return true;
  if (v === "my-team" || v === "myteam") return true;
  if (v.startsWith("team:") && v.length > "team:".length) return true;
  return isPlausibleUserId(v);
}

const prefsPatchSchema = z.object({
  activeViewId: z.string().nullable().optional(),
  layout: z.enum(FREIGHT_COCKPIT_LAYOUTS).optional(),
  grouping: z.enum(FREIGHT_COCKPIT_GROUPINGS).optional(),
  sort: z.enum(FREIGHT_COCKPIT_SORTS).optional(),
  autopilotMutedUntil: z.string().nullable().optional(),
  // Task #900 — sticky filters. Either side may be cleared by sending null.
  ownerFilter: z
    .string()
    .nullable()
    .optional()
    .refine(
      (v) => v === null || v === undefined || isOwnerFilterValue(v),
      { message: "ownerFilter must be 'all' | 'me' | 'unassigned' | <userId>" },
    ),
  pickupScope: z
    .string()
    .nullable()
    .optional()
    .refine(
      (v) => v === null || v === undefined || isPickupScope(v),
      { message: "pickupScope must be 'actionable' | 'upcoming' | 'recent' | 'all'" },
    ),
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

  // Task #875 — resolve every owner-shaped user id (owner, delegated,
  // creator, approver) so the cockpit row's `ownership` envelope can
  // express "this row belongs to any of these people". The KPI strip,
  // server-side "mine" filters, and the client-side filter all share
  // the same predicate, so a row delegated from Jared to a load-mover
  // still counts as Jared's "My freight today".
  const ownerCandidateIds = Array.from(new Set([
    opp.ownerUserId,
    opp.delegatedToUserId,
    opp.createdById,
    opp.approvedById,
  ].filter((v): v is string => typeof v === "string" && v.length > 0)));
  for (const id of ownerCandidateIds) {
    if (!caches.users?.has(id)) {
      const u = (await storage.getUser(id)) ?? null;
      caches.users?.set(id, u);
    }
  }
  const resolveCachedUser = (id: string): User | null =>
    (caches.users?.get(id) ?? null);

  // Avatar/name still come from the "primary" owner — delegated takes
  // precedence so the LM sees their face on a delegated row, but the
  // ownership envelope below carries every contributor.
  let owner: User | null = null;
  const primaryOwnerId = opp.delegatedToUserId ?? opp.ownerUserId ?? null;
  if (primaryOwnerId) owner = resolveCachedUser(primaryOwnerId);

  const ownership: CockpitRowOwnership = buildRowOwnership(
    {
      ownerUserId: opp.ownerUserId,
      delegatedToUserId: opp.delegatedToUserId,
      createdById: opp.createdById,
      approvedById: opp.approvedById,
    },
    (id) => resolveCachedUser(id)?.username ?? null,
  );

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
    const blended = await getBlendedRateCached({
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
    // Task #875 — every owner-shaped attribution + their lowercased emails,
    // used by the shared `isRowOwnedByUser` predicate on both server and
    // client. The legacy `owner.id` above stays for backwards compat.
    ownership,
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
      // Task #972 — viewing-as scope. When an admin is impersonating a rep,
      // the entire cockpit response (rows, KPIs, bucket counts) is scoped
      // to that rep's book BEFORE any client-supplied owner filter runs.
      // The helper is the single source of truth: same logic as
      // /api/auth/me's `isImpersonating` flag and Clerk's impersonation
      // map. See server/auth.ts:getImpersonationContext.
      const impersonation = getImpersonationContext(req);
      const {
        companyId,
        status,
        limit = "100",
        grouping = "none",
        sort = "pickup_soonest",
        lane: laneFilter,
        carrierId: carrierFilter,
        pickupScope: pickupScopeRaw,
        ownerFilter: ownerFilterRaw,
        debug: debugRaw,
      } = req.query as Record<string, string>;
      // Task #972 — gated diagnostics. `?debug=cockpit` opens a small
      // server-side payload that the client debug pane prints; it never
      // changes the response shape used by production. Dev-only.
      const cockpitDebug = process.env.NODE_ENV !== "production" && debugRaw === "cockpit";
      // Phase B1 / Task #900 — pickup-date scope. Default 'actionable' keeps
      // upcoming + today + ≤24h-overdue still-open rows visible and drops
      // older lingering past-pickup rows from the rep's morning queue (the
      // count is surfaced via kpis.hiddenStale + the "Stale: N" chip so
      // recovery is one click away). Legacy scopes are preserved.
      const pickupScope: PickupScope = isPickupScope(pickupScopeRaw)
        ? pickupScopeRaw
        : DEFAULT_PICKUP_SCOPE;
      // Task #900 — owner filter. "all" (default), "me", "unassigned", or
      // a specific user id. Anything malformed silently degrades to "all"
      // so a stale URL never produces a hard 400 for the rep.
      const ownerFilter: string = isOwnerFilterValue(ownerFilterRaw)
        ? ownerFilterRaw
        : "all";
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
      //
      // Phase B1 — past-pickup is no longer a blanket exclude. Status drives
      // "still open"; pickup date drives only the freshness label. The
      // pickupScope param controls how aggressive the date filter is:
      //   'recent' (default) — show 'upcoming' + 'past_recent', hide stale
      //   'upcoming'         — strict, hide everything past pickup (legacy)
      //   'all'              — never hide for date (empty-state escape hatch)
      // pickupWindowStart is a text column storing ISO date strings
      // (YYYY-MM-DD or full ISO). Today is computed in the org's local
      // timezone (CT — see server/lib/orgLocalDate.ts) so loads that are
      // "today" for the rep don't get hidden by UTC drift.
      const todayIso = todayIsoInOrgTz(now);
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const startOfTodayMs = startOfToday.getTime();
      const rowsWithFreshness = rows.map(r => ({
        row: r,
        freshness: computePickupFreshness(r.pickupWindowStart, todayIso),
      }));
      const visibleRows = rowsWithFreshness
        .filter(({ row: r, freshness }) => {
          if (r.snoozedUntil) {
            const t = new Date(r.snoozedUntil).getTime();
            if (Number.isFinite(t) && t > now.getTime()) return false;
          }
          // Task #900 — actionable scope needs status + daysSincePickup so
          // it can keep ≤24h-overdue still-open rows visible without
          // dragging multi-day lingerers into the queue.
          if (shouldHideForPickup(freshness, pickupScope, {
            status: r.status,
            daysSincePickup: daysSincePickup(r.pickupWindowStart, todayIso),
          })) return false;
          return true;
        });
      const freshnessByOppId = new Map<string, PickupFreshness>(
        rowsWithFreshness.map(({ row, freshness }) => [row.id, freshness]),
      );
      const caches: CockpitLookupCaches = {
        carriers: new Map<string, Carrier | null>(),
        companies: new Map<string, Company | null>(),
        policies: new Map<string, CompanyOutreachPolicy | null>(),
        lanes: new Map<string, RecurringLane | null>(),
        users: new Map<string, User | null>(),
      };
      const baseItems = await Promise.all(
        visibleRows.map(({ row }) => buildCockpitRow(org, row, { now, caches })),
      );

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
        // Phase B1 — every row carries its pickup freshness AND a
        // server-computed days-ago value (org-local, via todayIsoInOrgTz)
        // so the UI badge "Pickup was Xd ago" never drifts off-by-one
        // from the server filter at CT/UTC midnight rollover.
        const pickupFreshness: PickupFreshness =
          freshnessByOppId.get(i.opportunity.id) ?? "no_pickup";
        const pickupDaysAgo = daysSincePickup(i.opportunity.pickupWindowStart, todayIso);
        return { ...i, lwqContext, laneSignature: sig, pickupFreshness, pickupDaysAgo };
      });

      // Optional `?lane=<sig>` deep-link filter — used by LWQ chip → AF.
      // Phase A3 — track per-stage counts so the empty-state hint can tell
      // the rep exactly which filter dropped what.
      const enrichedCount = enriched.length;
      let items = laneFilter
        ? enriched.filter(i => i.laneSignature === laneFilter)
        : enriched;
      const hiddenByLane = laneFilter ? Math.max(0, enrichedCount - items.length) : 0;

      // Task #875 — current-user identity used by the canonical predicate
      // for any "user X owns this row" check. Hoisted above the base-scope
      // block so both the impersonation gate (Task #972) and the client
      // owner filter share the same identity.
      const meIdentity = user
        ? resolveUserIdentity({
            id: user.id,
            email: (user as any).email ?? null,
            username: (user as any).username ?? null,
          })
        : null;

      // Task #972 — base owner scope (non-optional when impersonating).
      //
      // When an admin is "viewing as" a rep, every row in the response
      // must belong to that rep BEFORE any other filter (lane, owner,
      // carrier, …) runs. The base scope is derived from the impersonated
      // identity at request time — no persisted preference, no client
      // input. Outside viewing-as mode the base scope is "all" and the
      // existing client `ownerFilter` block is the only owner gate.
      //
      // The base scope tokens are an array (currently `[<userId>]`) so
      // we can grow this to "the impersonated rep's team" without
      // changing the wiring.
      const baseScopeUserIds: string[] = impersonation.isImpersonating && impersonation.impersonatedUserId
        ? [impersonation.impersonatedUserId]
        : [];
      const baseScope = baseScopeUserIds.length > 0
        ? resolveOwnerScope(baseScopeUserIds, user?.id ?? null, null)
        : null;
      const itemsBeforeBaseScope = items.length;
      const debugBaseScopeOwnerCounts: Record<string, number> = {};
      if (baseScope && !baseScope.isAll) {
        // Task #972 — ID-ONLY ownership match for the impersonation base
        // scope. The SQL aggregate that powers `hiddenCounts.totalInScope`
        // (and the byStatus / bySnooze / byPastPickup / … counters)
        // filters by the same four DB id columns
        // (owner_user_id / delegated_to_user_id / created_by_id /
        // approved_by_id). Using the email/username `isRowOwnedByUser`
        // alias fallback here would let alias-only rows show up in
        // `items` but be excluded from the aggregate, breaking parity
        // between visible rows and the empty-state / KPI counters that
        // surface them. The route's per-rep ownership lookup
        // (buildRowOwnership above) populates `ownership.ids` from the
        // same four columns the SQL aggregate counts, so an ID-only
        // match is exact and safe.
        items = items.filter(i => {
          const ids = i.ownership?.ids ?? (i.owner?.id ? [i.owner.id] : []);
          if (baseScope.includeUnassigned && ids.length === 0) return true;
          if (baseScope.userIds.size === 0) return false;
          for (const id of ids) {
            if (baseScope.userIds.has(id)) {
              if (cockpitDebug) {
                debugBaseScopeOwnerCounts[id] = (debugBaseScopeOwnerCounts[id] ?? 0) + 1;
              }
              return true;
            }
          }
          return false;
        });
      }
      const hiddenByBaseScope = baseScope && !baseScope.isAll
        ? Math.max(0, itemsBeforeBaseScope - items.length)
        : 0;

      // Task #900 — server-side owner filter. Reuses the shared
      // `isRowOwnedByUser` predicate so the filter agrees row-for-row with
      // the client "Mine" toggle and the cockpit KPI counters. We apply it
      // BEFORE the carrier-coverable filter so `hiddenByCarrier` keeps its
      // existing meaning (rows the carrier-coverable filter dropped on top
      // of every other constraint).
      //
      // Task #972 — when impersonating, this filter can only NARROW within
      // the base scope. Tokens that would widen beyond the impersonated
      // rep (`all`, `team:<id>` containing other users, `<otherUserId>`)
      // are ignored and we behave as if the rep had selected "me". The
      // base-scope filter above already dropped every out-of-scope row,
      // so this is belt-and-suspenders for the count attribution and the
      // echoed `ownerFilter` payload.
      const itemsBeforeOwner = items.length;
      let effectiveOwnerFilter = ownerFilter;
      if (impersonation.isImpersonating && impersonation.impersonatedUserId) {
        const requestedTokens = ownerFilter === "all" ? [] : parseOwnerScopeTokens(ownerFilter);
        const requestedScope = requestedTokens.length > 0
          ? resolveOwnerScope(requestedTokens, impersonation.impersonatedUserId, null)
          : null;
        // Reject anything that resolves wider than {impersonatedUserId}:
        // - empty / "all"
        // - tokens that resolve to user ids not equal to the impersonated rep
        // - includeUnassigned (admin would re-introduce unassigned rows)
        const widensPastImpersonated = !requestedScope
          || requestedScope.isAll
          || requestedScope.includeUnassigned
          || Array.from(requestedScope.userIds).some(uid => uid !== impersonation.impersonatedUserId);
        if (widensPastImpersonated) {
          effectiveOwnerFilter = "me";
        }
      }
      if (effectiveOwnerFilter !== "all") {
        // Task #957 — resolve the (possibly multi-select) owner filter into
        // a canonical {userIds, includeUnassigned, isAll} envelope. Legacy
        // single-token values still flow through unchanged.
        const tokens = parseOwnerScopeTokens(effectiveOwnerFilter);
        const scope = resolveOwnerScope(tokens, user?.id ?? null, null);
        if (!scope.isAll) {
          items = items.filter(i => {
            const ids = i.ownership?.ids ?? (i.owner?.id ? [i.owner.id] : []);
            if (scope.includeUnassigned && ids.length === 0) return true;
            if (scope.userIds.size === 0) return false;
            // Cheap fast-path: any direct id intersection wins.
            for (const id of ids) {
              if (scope.userIds.has(id)) return true;
            }
            // Fall back to the canonical predicate when "me" is in scope so
            // email/username aliasing on the envelope still matches.
            if (meIdentity && scope.userIds.has(meIdentity.id)) {
              if (isRowOwnedByUser(i.ownership ?? null, meIdentity, i.owner?.id ?? null)) {
                return true;
              }
            }
            return false;
          });
        }
      }
      const hiddenByOwner = effectiveOwnerFilter !== "all"
        ? Math.max(0, itemsBeforeOwner - items.length)
        : 0;
      const itemsBeforeCarrier = items.length;

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
      const hiddenByCarrier = carrierFilter
        ? Math.max(0, itemsBeforeCarrier - items.length)
        : 0;

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
          if (i.coverage.covered) return false;
          // Task #875 — anchor on org-local "today" so the KPI matches the
          // client `pickupWithinHours: 24` predicate. Same-day pickups are
          // always at-risk; past pickups never are.
          return isPickupWithinHours(i.opportunity.pickupWindowStart, 24, todayIso);
        }).length,
        coveredToday: coveredTodayCount,
        avgFreshnessMinutes: (() => {
          const fresh = items.map(i => i.freshnessMinutes).filter((n): n is number => n !== null);
          if (fresh.length === 0) return null;
          return Math.round(fresh.reduce((a, b) => a + b, 0) / fresh.length);
        })(),
        // Task #900 — count of past-pickup rows the 'actionable' rule would
        // hide right now (regardless of the rep's currently-selected scope).
        // Powers the "Stale: N" chip + the reveal-stale recovery affordance.
        // Initialized to 0 here; the actual value comes from the
        // hiddenCounts SQL aggregate further down (`hiddenStaleByActionable`)
        // and is patched onto this object before we serialize the response.
        hiddenStale: 0,
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

      // Phase A4 — per-producer ingestion freshness signal.
      //
      // freight_opportunities has no `source` column; we derive the producer
      // from columns present on each row:
      //   - source_quote_id IS NOT NULL  → Won Load Autopilot (won quote handoff)
      //   - source_file_name IS NOT NULL → Available Freight Importer (Excel)
      //   - else (created_by_id present) → Manual rep creation
      //
      // CORRECTNESS NOTE (post-architect-review): we MUST NOT compute this
      // from the `rows` returned by the page-scoped storage query — those are
      // already filtered (status, company, mineOnly) and capped (limit ≤ 500,
      // sorted by urgencyScore desc), so a fresh import of low-urgency rows
      // outside the active filter would be invisible and the pill would lie.
      // Instead we run a single org-scoped aggregate over the last 24h of
      // freight_opportunities, ignoring all UI filters. This is one cheap
      // query (FILTER clauses + index on org_id, generated_at) and is the
      // ground truth for "did anything land in the last day".
      //
      // PRODUCER ATTRIBUTION INVARIANT: the producer key uses field
      // precedence (source_quote_id beats source_file_name). The producers
      // are mutually exclusive at write time today: Won Load Autopilot
      // (server/services/customerQuotes.ts) sets source_quote_id only;
      // the Excel Importer (server/services/freightOpportunityImporter.ts)
      // sets source_file_name only. If a future writer ever sets both, the
      // row will be classified as autopilot — the SQL CASE below mirrors
      // the JS precedence used by other consumers.
      const FRESH_GREEN_MAX_MIN = 60;
      const FRESH_YELLOW_MAX_MIN = 240;
      const FRESH_RED_MISSING_MIN = 24 * 60; // no rows in 24h ⇒ red
      const ageOf = (t: Date | null): number | null =>
        t ? Math.max(0, Math.round((now.getTime() - t.getTime()) / 60_000)) : null;
      const stateForAge = (ageMin: number | null): "green" | "yellow" | "red" => {
        if (ageMin == null) return "red";
        if (ageMin <= FRESH_GREEN_MAX_MIN) return "green";
        if (ageMin <= FRESH_YELLOW_MAX_MIN) return "yellow";
        return "red";
      };
      const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      type ProducerKey = "won_load_autopilot" | "available_freight_importer" | "manual";
      const PRODUCER_LABELS: Record<ProducerKey, string> = {
        won_load_autopilot: "Won Load Autopilot",
        available_freight_importer: "Excel Importer",
        manual: "Manual",
      };
      // Org-scoped aggregate. Three FILTER buckets in one round trip; the
      // CASE expressions mirror the JS precedence noted above so backend &
      // frontend (or any future SQL consumer) cannot disagree on producer.
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
        WHERE ${freightOpportunities.orgId} = ${org}
      `);
      const f0: any = (freshnessRows as any).rows?.[0] ?? (Array.isArray(freshnessRows) ? (freshnessRows as any)[0] : null) ?? {};
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
        const ageMinutes = ageOf(b.last);
        return {
          id,
          label: PRODUCER_LABELS[id],
          lastEventAt: b.last ? b.last.toISOString() : null,
          ageMinutes,
          count24h: b.count24h,
          healthState: stateForAge(ageMinutes),
        };
      });
      const overallLast = producers.reduce<Date | null>((acc, p) => {
        if (!p.lastEventAt) return acc;
        const t = new Date(p.lastEventAt);
        if (!Number.isFinite(t.getTime())) return acc;
        if (!acc || t > acc) return t;
        return acc;
      }, null);
      const overallAge = ageOf(overallLast);
      const overallHealth: "green" | "yellow" | "red" = (() => {
        if (overallAge == null || overallAge >= FRESH_RED_MISSING_MIN) return "red";
        return stateForAge(overallAge);
      })();
      const freshness = {
        overall: {
          healthState: overallHealth,
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

      // Phase A3 — hidden-counts aggregate. Single org-scoped round trip
      // returning how many rows in the same org+company scope were dropped
      // by each upstream filter dimension. Pairs with the JS-derived
      // hiddenByLane / hiddenByCarrier deltas above. The empty-state hint
      // in the cockpit UI uses this to explain "0 rows" instead of leaving
      // the rep guessing whether the queue is genuinely empty or just
      // filtered out from view.
      //
      // Predicate ordering mirrors the in-memory filter:
      // status (DB-level) → snooze → past-pickup (scope-aware in B1).
      // A row that is both snoozed AND past-pickup attributes to "snooze"
      // so the totals stay mutually exclusive (no double-counting).
      //
      // Phase B1 — byPastPickup now means "rows the current pickupScope is
      // hiding for date reasons". Under 'recent' (default) that's only the
      // stale tail; under 'upcoming' it's the legacy strict count; under
      // 'all' it's always 0. byPastStale is a stable companion that always
      // counts strictly-stale (>graceDays) past pickups so the UI can show
      // a consistent "stale" number regardless of scope. visiblePastRecent
      // counts past-pickup-but-still-visible rows so the UI can hint
      // "N past-pickup loads are visible because they're still actionable."
      const statusFilterSql = statusList.length > 0
        ? sql`${freightOpportunities.status} IN (${sql.join(statusList.map(s => sql`${s}`), sql`, `)})`
        : sql`TRUE`;
      const statusExcludeSql = statusList.length > 0
        ? sql`${freightOpportunities.status} NOT IN (${sql.join(statusList.map(s => sql`${s}`), sql`, `)})`
        : sql`FALSE`;
      const companyScopeSql = companyId
        ? sql`AND ${freightOpportunities.companyId} = ${companyId}`
        : sql``;
      const notSnoozedSql = sql`(
        ${freightOpportunities.snoozedUntil} IS NULL
        OR ${freightOpportunities.snoozedUntil} <= ${now}
      )`;
      // Precompute the stale-boundary ISO so the comparison stays a plain
      // text inequality (no Postgres date arithmetic mixed with bind params).
      const staleBoundaryIso = new Date(
        Date.parse(`${todayIso}T00:00:00Z`) - PICKUP_GRACE_DAYS_DEFAULT * 86_400_000,
      ).toISOString().slice(0, 10);
      // NOTE: substring(...) is inlined (not factored to a variable) so the
      // §22 guardrail "past-pickup uses todayIsoInOrgTz" can grep the literal
      // `substring(... pickupWindowStart ...) < ${todayIso}` shape.
      const isPastSql = sql`${freightOpportunities.pickupWindowStart} IS NOT NULL AND substring(${freightOpportunities.pickupWindowStart}, 1, 10) < ${todayIso}`;
      const isStaleSql = sql`${freightOpportunities.pickupWindowStart} IS NOT NULL AND substring(${freightOpportunities.pickupWindowStart}, 1, 10) < ${staleBoundaryIso}`;
      // Per-scope "hidden by date" predicate, mirrors shouldHideForPickup().
      // Task #900 — `actionable` keeps past-pickup rows visible only when
      // pickup is ≤ 1 day past AND status is in ACTIONABLE_OPEN_STATUSES.
      // The SQL form mirrors that 1:1 so the per-scope hidden count never
      // diverges from the in-memory filter.
      const oneDayBeforeTodayIso = new Date(
        Date.parse(`${todayIso}T00:00:00Z`) - 1 * 86_400_000,
      ).toISOString().slice(0, 10);
      const actionableOpenStatusList = sql.join(
        ["pending_approval", "ready_to_send", "sent", "awaiting_carrier_reply", "partially_covered"]
          .map(s => sql`${s}`),
        sql`, `,
      );
      // Past-pickup AND NOT (within 24h overdue AND status still actionable).
      const hiddenByActionableSql = sql`
        ${freightOpportunities.pickupWindowStart} IS NOT NULL
        AND substring(${freightOpportunities.pickupWindowStart}, 1, 10) < ${todayIso}
        AND NOT (
          substring(${freightOpportunities.pickupWindowStart}, 1, 10) >= ${oneDayBeforeTodayIso}
          AND ${freightOpportunities.status} IN (${actionableOpenStatusList})
        )
      `;
      const hiddenByPickupForScopeSql = pickupScope === "all"
        ? sql`FALSE`
        : pickupScope === "upcoming"
          ? isPastSql
          : pickupScope === "actionable"
            ? hiddenByActionableSql
            : isStaleSql;
      // Task #972 — when impersonating, every hidden-count aggregate must
      // ALSO be scoped to the impersonated rep so admins don't leak
      // queue-level metadata about other reps' books (totalInScope,
      // byStatus, bySnooze, byPastPickup, byPastStale, byActionable, …).
      // Mirrors the row-level base-scope filter applied higher up — owner
      // attribution comes from any of the four ownership-bearing columns
      // (owner / delegated-to / created-by / approved-by) so the SQL count
      // matches the per-row predicate `isRowOwnedByUser` uses.
      const baseScopeImpersonationSql =
        impersonation.isImpersonating && impersonation.impersonatedUserId
          ? sql`AND (
              ${freightOpportunities.ownerUserId} = ${impersonation.impersonatedUserId}
              OR ${freightOpportunities.delegatedToUserId} = ${impersonation.impersonatedUserId}
              OR ${freightOpportunities.createdById} = ${impersonation.impersonatedUserId}
              OR ${freightOpportunities.approvedById} = ${impersonation.impersonatedUserId}
            )`
          : sql``;
      const hiddenRows = await db.execute(sql`
        SELECT
          COUNT(*) AS total_in_scope,
          COUNT(*) FILTER (WHERE ${statusExcludeSql}) AS hidden_by_status,
          COUNT(*) FILTER (
            WHERE ${statusFilterSql}
              AND ${freightOpportunities.snoozedUntil} IS NOT NULL
              AND ${freightOpportunities.snoozedUntil} > ${now}
          ) AS hidden_by_snooze,
          COUNT(*) FILTER (
            WHERE ${statusFilterSql}
              AND ${notSnoozedSql}
              AND (${hiddenByPickupForScopeSql})
          ) AS hidden_by_past_pickup,
          COUNT(*) FILTER (
            WHERE ${statusFilterSql}
              AND ${notSnoozedSql}
              AND ${isStaleSql}
          ) AS hidden_by_past_stale,
          -- Task #900 — stable count of rows the actionable rule would hide
          -- regardless of the currently-selected scope, so the "Stale: N"
          -- chip / reveal-stale recovery affordance always reflects the
          -- same number whether the rep is on actionable / recent / all.
          COUNT(*) FILTER (
            WHERE ${statusFilterSql}
              AND ${notSnoozedSql}
              AND (${hiddenByActionableSql})
          ) AS hidden_by_actionable,
          -- "Recent past pickup" = past-pickup AND inside the grace window.
          -- Defined independently of pickupScope so the count means the same
          -- thing under Recent / Upcoming-only / All (the operator question
          -- is "how many past-pickup loads are still inside the freshness
          -- window?", not "what does the current scope happen to expose?").
          COUNT(*) FILTER (
            WHERE ${statusFilterSql}
              AND ${notSnoozedSql}
              AND (${isPastSql})
              AND NOT (${isStaleSql})
          ) AS visible_past_pickup_recent
        FROM ${freightOpportunities}
        WHERE ${freightOpportunities.orgId} = ${org}
        ${companyScopeSql}
        ${baseScopeImpersonationSql}
      `);
      const h0: any = (hiddenRows as any).rows?.[0]
        ?? (Array.isArray(hiddenRows) ? (hiddenRows as any)[0] : null)
        ?? {};
      const hiddenCounts = {
        totalInScope: parseCount(h0.total_in_scope),
        byStatus: parseCount(h0.hidden_by_status),
        bySnooze: parseCount(h0.hidden_by_snooze),
        byPastPickup: parseCount(h0.hidden_by_past_pickup),
        byPastStale: parseCount(h0.hidden_by_past_stale),
        byActionable: parseCount(h0.hidden_by_actionable),
        visiblePastPickupRecent: parseCount(h0.visible_past_pickup_recent),
        byLane: hiddenByLane,
        byOwner: hiddenByOwner,
        byCarrier: hiddenByCarrier,
        // Task #972 — number of rows the impersonation base scope dropped
        // (always 0 outside viewing-as mode). Surfaced for the empty-state
        // hint and for parity between the per-stage drop counts and the
        // final visible row count.
        byBaseScope: hiddenByBaseScope,
      };
      // Task #900 — surface the actionable-rule hidden count on the kpis
      // envelope so the "Stale: N" chip in the cockpit header has it
      // alongside the other top-line counters. Patched onto `kpis` rather
      // than rebuilt because the kpis object was assembled earlier (above
      // the hiddenCounts SQL aggregate) so the per-row scans had a stable
      // reference point for the at-risk / generated-today counters.
      const hiddenStaleByActionable = parseCount(h0.hidden_by_actionable);
      kpis.hiddenStale = hiddenStaleByActionable;

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

      // Task #972 — debug payload only when `?debug=cockpit` is on a
      // non-production host. Surfaces what the server saw + applied so a
      // rep / admin can confirm scope is honest. Never includes PII —
      // just ids and counts.
      const cockpitDebugPayload = cockpitDebug
        ? {
            isImpersonating: impersonation.isImpersonating,
            impersonatedUserId: impersonation.impersonatedUserId,
            adminId: impersonation.adminId,
            currentUserId: user?.id ?? null,
            baseScope: baseScope
              ? {
                  userIds: Array.from(baseScope.userIds),
                  includeUnassigned: baseScope.includeUnassigned,
                  isAll: baseScope.isAll,
                }
              : null,
            requestedOwnerFilter: ownerFilter,
            effectiveOwnerFilter,
            itemsBeforeBaseScope,
            hiddenByBaseScope,
            perOwnerCounts: debugBaseScopeOwnerCounts,
            visibleItems: items.length,
          }
        : undefined;

      res.json({
        items: itemsWithGroup,
        kpis,
        lastImport,
        nextImport,
        freshness,
        hiddenCounts,
        roiMetrics,
        sort: sortKey,
        grouping: groupKey,
        pickupScope,
        pickupGraceDays: PICKUP_GRACE_DAYS_DEFAULT,
        // Task #900 — echo so the client can confirm what the server applied
        // (URL persistence + saved-view restoration both rely on a confirmed
        // server value rather than the raw query string).
        // Task #972 — when impersonating, the server may have coerced the
        // requested filter back to "me" (no widening past the base scope).
        // We echo the effective value so the combobox label matches what
        // actually drives the rows.
        ownerFilter: effectiveOwnerFilter,
        // Task #972 — small impersonation envelope so the client never
        // needs to re-derive view-as state from `currentUser`. Always
        // present (false / null when no impersonation) for shape stability.
        impersonation: {
          isImpersonating: impersonation.isImpersonating,
          impersonatedUserId: impersonation.impersonatedUserId,
        },
        ...(cockpitDebugPayload ? { debug: cockpitDebugPayload } : {}),
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
        // Task #900 — wires the new server-side ownerFilter + actionable
        // pickup scope so this default tab really does mean "freight that
        // is mine AND needs my attention today" (today + future + ≤24h
        // overdue still-open). The legacy `ownerScope` / `pickupWithinHours`
        // hints stay so existing client code that consumes them keeps
        // working until everything is migrated to the new envelope.
        filters: {
          ownerScope: "mine",
          ownerFilter: "me",
          pickupScope: "actionable",
          pickupWithinHours: 24,
        },
      },
      {
        id: "builtin:team-needs-approval",
        name: "Team needs approval",
        isShared: true,
        isBuiltIn: true,
        filters: {
          statuses: ["pending_approval"],
          ownerScope: "team",
          // Task #900 — keep the team queue scoped to genuinely actionable
          // approvals so old past-pickup rows don't dilute the manager view.
          pickupScope: "actionable",
        },
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
      // Task #900 — sticky owner filter + pickup scope round-trip.
      // `=== undefined` lets the client clear them by sending `null`.
      ownerFilter: parsed.data.ownerFilter !== undefined
        ? parsed.data.ownerFilter
        : existing?.ownerFilter ?? null,
      pickupScope: parsed.data.pickupScope !== undefined
        ? parsed.data.pickupScope
        : existing?.pickupScope ?? null,
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
            const blended = await getBlendedRateCached({
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
