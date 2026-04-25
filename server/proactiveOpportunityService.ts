/**
 * Proactive Available Freight Outreach Engine ("PAFOE") — service layer (Phase 2).
 *
 * Responsibilities:
 *   1. generateOpportunitiesForCompany — build freight_opportunities rows from
 *      either explicit open loads (exact_load mode) or recurring lane signals
 *      (lane_building mode), gated by per-company outreach policy.
 *   2. rankCarriersForOpportunity — wraps the existing rankCarriersForLane
 *      pipeline, then layers post-rank guardrails (eligibility, daily cap,
 *      48h dedup, approved-carrier-only, do_not_use, opted_out, rep override)
 *      and assigns shortlist buckets.
 *   3. applyEligibilityGate — the single guardrail entry point used both by
 *      generation-time ranking and by manual rep-add flows in later phases.
 *
 * No outreach is sent here. No response ingestion. UI lives in Phase 3+.
 */

import type { IStorage } from "./storage";
import { CARRIER_DAILY_BUDGET_CONFIG } from "./storage";
import { rankCarriersForLane, HIGH_FREQUENCY_CONFIG, type RankedCarrier } from "./carrierRankingService";
import { getLaneCoverageProfile } from "./laneCoverageService";
import type {
  Carrier,
  CompanyOutreachPolicy,
  FreightOpportunity,
  FreightOpportunityBucket,
  FreightOpportunityCarrier,
  FreightOpportunityConfidence,
  FreightOpportunityExcludedReason,
  InsertFreightOpportunity,
  InsertFreightOpportunityCarrier,
  RecurringLane,
} from "@shared/schema";

// ── Defaults & tunables ─────────────────────────────────────────────────────

export const PAFOE_DEFAULTS = {
  /** Default policy values when no row exists for a company. */
  policy: {
    enabled: false,
    mode: "exact_load" as const,
    approvalRequired: true,
    maxCarriersPerOpportunity: 25,
    leadTimeMinDays: 2,
    leadTimeMaxDays: 7,
    approvedCarrierOnly: false,
    approvedCarrierIds: [] as string[],
    doNotAutomate: false,
  },
  /** Cross-lane recent-contact suppression window (mirrors HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours). */
  recentContactWindowHours: HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours,
  /** Carrier daily-cap config (mirrors the global CARRIER_DAILY_BUDGET_CONFIG). */
  dailyBudget: CARRIER_DAILY_BUDGET_CONFIG,
  /** Bucket thresholds (see Phase 1 audit §4 / shortlist composition). */
  buckets: {
    /** A carrier needs this many exact-lane loads OR a recent positive bench outcome to be 'proven'. */
    provenExactLaneLoads: 1,
    /** Strong-fit-underused requires fitScore >= this AND no/very few recent loads on this lane. */
    strongFitUnderusedMinScore: 70,
    /** Exploratory minimum fit floor — anything below this is dropped from shortlist. */
    exploratoryMinScore: 45,
  },
};

// ── Types ───────────────────────────────────────────────────────────────────

export interface GenerationLoadSpec {
  /** Origin city (free-text — matches recurringLanes.origin convention). */
  origin: string;
  originState?: string | null;
  destination: string;
  destinationState?: string | null;
  equipmentType?: string | null;
  pickupWindowStart: string;       // ISO date (YYYY-MM-DD or full ISO)
  pickupWindowEnd: string;
  loadCount?: number;
  /** Caller-provided ref (e.g. ELD load id, TMS shipment id). */
  sourceRef?: Record<string, unknown>;
  /** Optional link to an existing recurring lane (lane_building only). */
  recurringLaneId?: string | null;
  geographicLanePatternId?: string | null;
  /** 0–100, defaults to 50. */
  urgencyScore?: number;
  notes?: string;
}

export interface GenerateOptions {
  /** Force a mode override; otherwise read from policy. */
  mode?: "exact_load" | "lane_building";
  /** Caller (rep) — recorded as createdById. */
  actorUserId?: string | null;
  /** Source loads for exact_load mode. Required when mode=exact_load. */
  loads?: GenerationLoadSpec[];
  /** Caller-supplied recurring lanes for lane_building mode. If omitted in
   *  lane_building mode, all eligible recurring lanes for the company are pulled. */
  recurringLanes?: RecurringLane[];
}

export type EligibilityDecision =
  | { allowed: true }
  | { allowed: false; reason: FreightOpportunityExcludedReason; message: string };

export interface CarrierEligibilityContext {
  policy: CompanyOutreachPolicy;
  /** Carrier IDs that have been contacted within the recent-contact window (cross-lane). */
  recentContactCarrierIds: Set<string>;
  /** Carrier IDs explicitly added by rep (skip recent-contact + lane-fit gates, but never bypass do_not_use/opted_out). */
  repOverrideCarrierIds?: Set<string>;
  /** Per-carrier daily budget cache (keyed by carrierId). */
  dailyBudgetCheck: (carrierId: string) => Promise<{ allowed: boolean; reason?: string }>;
}

export interface RankedShortlistRow {
  carrier: Pick<Carrier, "id" | "primaryEmail" | "status" | "tags">;
  ranked: RankedCarrier;
  bucket: FreightOpportunityBucket | null;
  excludedReason: FreightOpportunityExcludedReason | null;
  rank: number | null;
}

export interface OpportunityGenerationResult {
  opportunity: FreightOpportunity;
  carriers: FreightOpportunityCarrier[];
  blocked?: false;
}

export interface OpportunityBlockedResult {
  blocked: true;
  reason: "policy_disabled" | "policy_do_not_automate" | "policy_missing_company";
  message: string;
}

// ── Policy loading ──────────────────────────────────────────────────────────

/**
 * Load the company outreach policy. If none exists, returns an in-memory
 * default (NOT persisted) so callers always have a stable shape to read from.
 * The returned shape is a real CompanyOutreachPolicy when persisted, or a
 * synthetic stub with `id=""` and `enabled=false` when missing.
 */
export async function loadEffectivePolicy(
  storage: IStorage,
  orgId: string,
  companyId: string,
): Promise<CompanyOutreachPolicy> {
  const existing = await storage.getCompanyOutreachPolicy(orgId, companyId);
  if (existing) return existing;
  return {
    id: "",
    orgId,
    companyId,
    enabled: PAFOE_DEFAULTS.policy.enabled,
    mode: PAFOE_DEFAULTS.policy.mode,
    approvalRequired: PAFOE_DEFAULTS.policy.approvalRequired,
    maxCarriersPerOpportunity: PAFOE_DEFAULTS.policy.maxCarriersPerOpportunity,
    leadTimeMinDays: PAFOE_DEFAULTS.policy.leadTimeMinDays,
    leadTimeMaxDays: PAFOE_DEFAULTS.policy.leadTimeMaxDays,
    approvedCarrierOnly: PAFOE_DEFAULTS.policy.approvedCarrierOnly,
    approvedCarrierIds: PAFOE_DEFAULTS.policy.approvedCarrierIds,
    doNotAutomate: PAFOE_DEFAULTS.policy.doNotAutomate,
    specialNotes: null,
    updatedAt: new Date(0),
    updatedById: null,
  };
}

// ── Eligibility gate ────────────────────────────────────────────────────────

/**
 * The single eligibility / guardrail gate. Returns the first failing reason
 * (in priority order) or `{allowed:true}` if the carrier is eligible.
 *
 * Priority order matches the Phase 1 audit's excludedReason precedence:
 *   do_not_use > opted_out > not_approved > daily_cap > recent_contact > rep_override-only
 */
export async function evaluateCarrierEligibility(
  carrier: Pick<Carrier, "id" | "primaryEmail" | "status" | "tags">,
  ctx: CarrierEligibilityContext,
): Promise<EligibilityDecision> {
  const tagSet = new Set((carrier.tags ?? []).map(t => (t || "").toLowerCase()));
  const isOverride = ctx.repOverrideCarrierIds?.has(carrier.id) ?? false;

  // 1. do_not_use — never bypassable
  if (carrier.status === "do_not_use" || tagSet.has("do_not_use") || tagSet.has("no_use")) {
    return { allowed: false, reason: "do_not_use", message: "Carrier is marked do_not_use" };
  }

  // 2. opted_out — never bypassable
  if (tagSet.has("opted_out") || tagSet.has("unsubscribed")) {
    return { allowed: false, reason: "opted_out", message: "Carrier has opted out of outreach" };
  }

  // 3. customer-blocked (placeholder enum value reserved; specific list not yet maintained)
  // Intentionally not implemented in Phase 2; the enum value exists for future use.

  // 4. not_approved (only when policy demands approved-carrier-only)
  if (ctx.policy.approvedCarrierOnly) {
    const approved = new Set(ctx.policy.approvedCarrierIds ?? []);
    if (!approved.has(carrier.id)) {
      return { allowed: false, reason: "not_approved", message: "Customer policy requires an approved carrier" };
    }
  }

  // 5. daily_cap (cross-lane email throttle)
  const budget = await ctx.dailyBudgetCheck(carrier.id);
  if (!budget.allowed) {
    return { allowed: false, reason: "daily_cap", message: budget.reason ?? "Daily email cap reached for this carrier" };
  }

  // 6. recent_contact (48h cross-lane suppression) — bypassed only by rep override
  if (!isOverride && ctx.recentContactCarrierIds.has(carrier.id)) {
    return {
      allowed: false,
      reason: "recent_contact",
      message: `Carrier was contacted within the last ${PAFOE_DEFAULTS.recentContactWindowHours}h`,
    };
  }

  return { allowed: true };
}

// ── Bucket assignment ───────────────────────────────────────────────────────

/**
 * Assign a shortlist bucket to an eligible (non-excluded) ranked carrier. Returns
 * null when the carrier sits below the exploratory floor (caller should drop them
 * from the shortlist entirely).
 */
export function assignBucket(
  ranked: RankedCarrier,
  opts: { repAdded?: boolean } = {},
): FreightOpportunityBucket | null {
  if (opts.repAdded) return "rep_added";

  const score = ranked.fitScore ?? 0;
  const exact = ranked.exactLaneLoads ?? 0;
  const provenByOutcome = ranked.priorOutcomeBoost === true;

  if (exact >= PAFOE_DEFAULTS.buckets.provenExactLaneLoads || provenByOutcome) {
    return "proven";
  }
  if (score >= PAFOE_DEFAULTS.buckets.strongFitUnderusedMinScore) {
    return "strong_fit_underused";
  }
  if (score >= PAFOE_DEFAULTS.buckets.exploratoryMinScore) {
    return "exploratory";
  }
  return null;
}

// ── Confidence flag ─────────────────────────────────────────────────────────

export function deriveConfidenceFlag(rows: RankedShortlistRow[]): FreightOpportunityConfidence {
  const eligible = rows.filter(r => r.bucket !== null);
  if (eligible.length === 0) return "low";
  const provenCount = eligible.filter(r => r.bucket === "proven").length;
  const provenShare = provenCount / eligible.length;
  const scores = eligible.map(r => r.ranked.fitScore ?? 0).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)] ?? 0;
  if (provenShare >= 0.25 && median >= 60) return "normal";
  if (eligible.length >= 5 && median >= 65) return "normal";
  return "low";
}

// ── Shortlist construction (the carrier-recommendation adapter) ─────────────

/**
 * Build the eligibility context (recent-contact set + budget checker) once
 * per opportunity so the gate is cheap to evaluate per carrier.
 */
export async function buildEligibilityContext(
  storage: IStorage,
  orgId: string,
  policy: CompanyOutreachPolicy,
): Promise<CarrierEligibilityContext> {
  // Recent-contact window: pull all carriers contacted in the last N hours
  // (cross-lane). The storage interface owns the SQL — the service stays
  // declarative.
  const sinceMs = Date.now() - PAFOE_DEFAULTS.recentContactWindowHours * 60 * 60 * 1000;
  const sinceDate = new Date(sinceMs);
  const ids = await storage.getRecentlyContactedCarrierIds(orgId, sinceDate);
  const recentSet = new Set<string>(ids);

  return {
    policy,
    recentContactCarrierIds: recentSet,
    dailyBudgetCheck: async (carrierId: string) => {
      const r = await storage.checkCarrierDailyBudget(orgId, carrierId);
      return { allowed: r.allowed, reason: r.allowed ? undefined : (r as { message: string }).message };
    },
  };
}

/**
 * Rank carriers for a freight opportunity. Reuses rankCarriersForLane (shaping
 * the opportunity into a synthetic RecurringLane it accepts) and then applies
 * the post-rank guardrail layer + bucket assignment + cap.
 *
 * Returned shortlist contains BOTH eligible carriers (with bucket set) and
 * carriers excluded by guardrails (with excludedReason set). Callers persist
 * the entire shortlist so the audit trail is complete.
 */
export async function rankCarriersForOpportunity(
  storage: IStorage,
  opportunity: FreightOpportunity,
  policy: CompanyOutreachPolicy,
  opts: { repAddedCarrierIds?: Set<string> } = {},
): Promise<RankedShortlistRow[]> {
  // Look up the company name so the underlying ranker can credit carriers
  // that have hauled for this same shipper before (customer-history bonus).
  // Without this, the synthetic lane carries no shipper identity and the
  // customer-history boost is never applied — a major contributor to the
  // empty-shortlist class of bug.
  let lookupCompanyName: string | null = null;
  try {
    const company = await storage.getCompany(opportunity.companyId);
    lookupCompanyName = company?.name ?? null;
  } catch {
    // Best-effort — proceed without the customer-history boost.
  }

  // Resolve to a real RecurringLane when possible so the ranker uses the same
  // weighted inputs as the Lane Work Queue: per-lane carrier bench (prior
  // outreach outcomes + recent-contact suppression) and lane coverage profile
  // (incumbents / claimed carriers). Without these the ranker falls back to
  // catalog-only scoring, which is why Available Freight shortlists looked
  // thinner than their LWQ counterparts on the same corridor.
  let resolvedLane: RecurringLane | null = null;
  try {
    if (opportunity.recurringLaneId) {
      const l = await storage.getRecurringLane(opportunity.recurringLaneId);
      if (l && l.orgId === opportunity.orgId) resolvedLane = l;
    }
    if (!resolvedLane) {
      const lanes = await storage.getRecurringLanesByCompany(opportunity.companyId);
      const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
      const match = lanes.find(l =>
        norm(l.origin) === norm(opportunity.origin) &&
        norm(l.destination) === norm(opportunity.destination) &&
        norm(l.equipmentType) === norm(opportunity.equipmentType),
      );
      if (match) resolvedLane = match;
    }
  } catch (e) {
    console.warn(`[pafoe] resolvedLane lookup failed for opp ${opportunity.id}:`, (e as Error)?.message ?? e);
  }

  const syntheticLane: RecurringLane = resolvedLane ?? {
    id: `synthetic-${opportunity.id}`,
    orgId: opportunity.orgId,
    companyId: opportunity.companyId,
    companyName: lookupCompanyName,
    origin: opportunity.origin,
    originState: opportunity.originState,
    destination: opportunity.destination,
    destinationState: opportunity.destinationState,
    equipmentType: opportunity.equipmentType,
    avgLoadsPerWeek: null,
    weeksActive: 0,
    lookbackWeeks: 4,
    hasPreferredCarrierProgram: false,
    ownerUserId: null,
    overseerUserId: null,
    assignedAt: null,
    assignedByUserId: null,
    laneScore: null,
    laneScoreFactors: null,
    eligibilityConfidence: "medium",
    lastScoredAt: null,
    isEligible: true,
    snoozedUntil: null,
    carriersContactedCount: 0,
    resolvedAt: null,
    isManual: false,
    sourceQuoteId: null,
    dropTrailerShipper: false,
    dropTrailerReceiver: false,
    createdAt: opportunity.generatedAt,
    updatedAt: opportunity.generatedAt,
  };

  // Fetch the same signals the LWQ carrier-suggestions endpoint uses so we run
  // through the identical weighted pipeline. Each is best-effort — if any
  // lookup fails the ranker degrades gracefully.
  let bench: Awaited<ReturnType<IStorage["getLaneCarrierBench"]>> | undefined;
  let coverageProfile: Awaited<ReturnType<typeof getLaneCoverageProfile>>["profile"] | null = null;
  let coverageCarriers: Awaited<ReturnType<typeof getLaneCoverageProfile>>["carriers"] = [];
  if (resolvedLane) {
    try {
      bench = await storage.getLaneCarrierBench(resolvedLane.id);
    } catch (e) {
      console.warn(`[pafoe] bench lookup failed for lane ${resolvedLane.id}:`, (e as Error)?.message ?? e);
    }
    try {
      const prof = await getLaneCoverageProfile(resolvedLane, storage);
      coverageProfile = prof.profile;
      if (!coverageProfile?.broadenSearchActive) {
        coverageCarriers = prof.carriers;
      }
    } catch (e) {
      console.warn(`[pafoe] coverage profile lookup failed for lane ${resolvedLane.id}:`, (e as Error)?.message ?? e);
    }
  } else {
    // Task #632 — synthetic AF opportunities have no RecurringLane to anchor
    // bench against. Resolve bench by lane signature so any prior positive
    // outcome from a matching org-wide RecurringLane still promotes carriers
    // to bench tier-0 in the ranker.
    try {
      bench = await storage.getOrgWideBenchByLaneSignature(
        opportunity.orgId,
        opportunity.origin,
        opportunity.originState ?? null,
        opportunity.destination,
        opportunity.destinationState ?? null,
        opportunity.equipmentType ?? null,
      );
    } catch (e) {
      console.warn(`[pafoe] org-wide bench signature lookup failed for opp ${opportunity.id}:`, (e as Error)?.message ?? e);
    }
  }

  const ranked = await rankCarriersForLane(syntheticLane, storage, bench, coverageProfile, coverageCarriers);
  const ctx = await buildEligibilityContext(storage, opportunity.orgId, policy);
  ctx.repOverrideCarrierIds = opts.repAddedCarrierIds;

  const rows: RankedShortlistRow[] = [];
  for (const r of ranked) {
    if (!r.carrierId) continue;
    const carrierShape = {
      id: r.carrierId,
      primaryEmail: r.primaryEmail,
      status: r.isDoNotUse ? "do_not_use" : "active",
      tags: r.tags ?? [],
    };
    const decision = await evaluateCarrierEligibility(carrierShape, ctx);
    const repAdded = opts.repAddedCarrierIds?.has(r.carrierId) ?? false;
    if (!decision.allowed) {
      rows.push({
        carrier: carrierShape,
        ranked: r,
        bucket: null,
        excludedReason: decision.reason,
        rank: null,
      });
      continue;
    }
    const bucket = assignBucket(r, { repAdded });
    if (!bucket) continue; // below exploratory floor — drop entirely
    rows.push({ carrier: carrierShape, ranked: r, bucket, excludedReason: null, rank: null });
  }

  // Sort eligible rows by fitScore desc, then assign 1-based rank within the cap.
  const eligible = rows.filter(r => r.bucket !== null);
  eligible.sort((a, b) => (b.ranked.fitScore ?? 0) - (a.ranked.fitScore ?? 0));
  const cap = Math.max(1, policy.maxCarriersPerOpportunity || PAFOE_DEFAULTS.policy.maxCarriersPerOpportunity);
  const capped = eligible.slice(0, cap);
  const overflowIds = new Set(eligible.slice(cap).map(r => r.carrier.id));
  capped.forEach((r, idx) => { r.rank = idx + 1; });

  // Anything that survived guardrails but exceeds the cap is recorded as excluded
  // with reason rep_override (slot reserved for "trimmed by max-carriers cap" -
  // the audit doc treats the cap as a soft override-able limit).
  for (const r of rows) {
    if (r.bucket !== null && r.rank === null && overflowIds.has(r.carrier.id)) {
      r.bucket = null;
      r.excludedReason = "rep_override";
    }
  }

  return rows;
}

// ── Opportunity generation ─────────────────────────────────────────────────

function buildOpportunityRecords(
  orgId: string,
  companyId: string,
  policy: CompanyOutreachPolicy,
  loads: GenerationLoadSpec[],
  mode: "exact_load" | "lane_building",
  actorUserId: string | null,
): InsertFreightOpportunity[] {
  return loads.map<InsertFreightOpportunity>(load => ({
    orgId,
    companyId,
    mode,
    recurringLaneId: load.recurringLaneId ?? null,
    geographicLanePatternId: load.geographicLanePatternId ?? null,
    origin: load.origin,
    originState: load.originState ?? null,
    destination: load.destination,
    destinationState: load.destinationState ?? null,
    equipmentType: load.equipmentType ?? null,
    pickupWindowStart: load.pickupWindowStart,
    pickupWindowEnd: load.pickupWindowEnd,
    loadCount: load.loadCount ?? 1,
    sourceRef: load.sourceRef ?? null,
    urgencyScore: clampUrgency(load.urgencyScore),
    confidenceFlag: "normal",
    status: "new",
    policySnapshot: snapshotPolicy(policy),
    expiresAt: null,
    createdById: actorUserId,
    notes: load.notes ?? null,
  }));
}

function clampUrgency(n: number | undefined): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function snapshotPolicy(p: CompanyOutreachPolicy): Record<string, unknown> {
  return {
    enabled: p.enabled,
    mode: p.mode,
    approvalRequired: p.approvalRequired,
    maxCarriersPerOpportunity: p.maxCarriersPerOpportunity,
    leadTimeMinDays: p.leadTimeMinDays,
    leadTimeMaxDays: p.leadTimeMaxDays,
    approvedCarrierOnly: p.approvedCarrierOnly,
    approvedCarrierIds: p.approvedCarrierIds ?? [],
    doNotAutomate: p.doNotAutomate,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Generate freight opportunities for a single shipper. This is the main entry
 * point used by background jobs and rep-triggered "scan-now" actions.
 *
 * Returns an array of generation results (one per opportunity created), or a
 * single blocked-result if policy gates rejected the whole batch.
 */
export async function generateOpportunitiesForCompany(
  storage: IStorage,
  orgId: string,
  companyId: string,
  opts: GenerateOptions = {},
): Promise<OpportunityGenerationResult[] | OpportunityBlockedResult> {
  const policy = await loadEffectivePolicy(storage, orgId, companyId);

  if (!policy.enabled) {
    return { blocked: true, reason: "policy_disabled", message: "Outreach is disabled for this customer" };
  }
  if (policy.doNotAutomate) {
    return { blocked: true, reason: "policy_do_not_automate", message: "Customer policy forbids automated outreach" };
  }

  // Policy mode may be "exact_load", "lane_building", or "both". "both" means
  // we run the generator twice — once per sub-mode — and concatenate results.
  // opts.mode (when provided by the caller) always wins.
  const requestedMode: "exact_load" | "lane_building" | "both" =
    opts.mode ?? (policy.mode as "exact_load" | "lane_building" | "both");

  if (requestedMode === "both") {
    const exactResults = await generateOpportunitiesForCompany(storage, orgId, companyId, {
      ...opts,
      mode: "exact_load",
    });
    const laneResults = await generateOpportunitiesForCompany(storage, orgId, companyId, {
      ...opts,
      mode: "lane_building",
      // lane_building pulls recurring lanes from storage when none supplied;
      // don't pass exact_load's `loads` through to it.
      loads: opts.recurringLanes ? undefined : opts.loads,
    });
    // If either side returned a blocked result, surface it; otherwise merge arrays.
    if (!Array.isArray(exactResults)) return exactResults;
    if (!Array.isArray(laneResults)) return laneResults;
    return [...exactResults, ...laneResults];
  }

  const mode: "exact_load" | "lane_building" = requestedMode;
  let loads: GenerationLoadSpec[] = opts.loads ?? [];

  if (mode === "lane_building" && (!opts.loads || opts.loads.length === 0)) {
    // Storage-backed default: if the caller doesn't hand us lanes, pull every
    // recurring lane the shipper currently has on file. The eligibility
    // filter (`isEligible`) gates which ones produce opportunities.
    const lanes = opts.recurringLanes ?? await storage.getRecurringLanesByCompany(companyId);
    loads = lanes
      .filter(l => l.isEligible !== false)
      .map<GenerationLoadSpec>(l => ({
        origin: l.origin,
        originState: l.originState,
        destination: l.destination,
        destinationState: l.destinationState,
        equipmentType: l.equipmentType,
        // Pickup window defaults to policy lead-time bracket.
        pickupWindowStart: addDaysIso(new Date(), policy.leadTimeMinDays),
        pickupWindowEnd: addDaysIso(new Date(), policy.leadTimeMaxDays),
        loadCount: 1,
        recurringLaneId: l.id,
        urgencyScore: l.laneScore ?? 50,
        sourceRef: { kind: "recurring_lane", id: l.id },
      }));
  }

  if (loads.length === 0) {
    return [];
  }

  const records = buildOpportunityRecords(orgId, companyId, policy, loads, mode, opts.actorUserId ?? null);
  const results: OpportunityGenerationResult[] = [];

  for (const record of records) {
    const opportunity = await storage.createFreightOpportunity(record);
    await storage.appendFreightOpportunityAudit({
      opportunityId: opportunity.id,
      eventType: "generated",
      actorUserId: opts.actorUserId ?? null,
      payload: { mode, loadCount: record.loadCount, sourceRef: record.sourceRef ?? null },
    });

    const shortlist = await rankCarriersForOpportunity(storage, opportunity, policy);

    const carrierRows: InsertFreightOpportunityCarrier[] = shortlist.map(row => ({
      opportunityId: opportunity.id,
      carrierId: row.carrier.id,
      rank: row.rank,
      bucket: row.bucket,
      fitScore: row.ranked.fitScore ?? 0,
      historyMatch: row.ranked.historyMatch ?? "none",
      explanation: row.ranked.fitReason ?? null,
      explanationStructured: row.ranked.carrierFitExplanation ?? null,
      responsivenessSnapshot: {
        suppressionReasons: row.ranked.suppressionReasons ?? [],
        loadsOnLane: row.ranked.loadsOnLane,
        priorOutcomeBoost: row.ranked.priorOutcomeBoost,
        // Task #632 — bench tier-0: persist on JSONB so the AF cockpit chip
        // surface can render "Bench Nx wins" without a schema migration.
        bench: row.ranked.bench,
        benchWins: row.ranked.benchWins,
      },
      excludedReason: row.excludedReason,
      outreachLogId: null,
      lastResponseId: null,
    }));

    const persistedCarriers = await storage.insertFreightOpportunityCarriers(carrierRows);

    // Derive confidence flag, persist, and advance status if no approval needed.
    const confidenceFlag = deriveConfidenceFlag(shortlist);
    const nextStatus = policy.approvalRequired ? "ready_to_send" : "ready_to_send";
    // Phase 2 NEVER auto-sends; both branches stop at ready_to_send. Approval
    // semantics will be implemented in Phase 3 when the rep UI is built.
    const updated = await storage.updateFreightOpportunity(opportunity.orgId, opportunity.id, {
      confidenceFlag,
      status: nextStatus,
    });

    // Audit any excluded carriers for traceability.
    for (const row of shortlist.filter(r => r.excludedReason)) {
      await storage.appendFreightOpportunityAudit({
        opportunityId: opportunity.id,
        eventType: "carrier_excluded",
        actorUserId: opts.actorUserId ?? null,
        payload: { carrierId: row.carrier.id, reason: row.excludedReason },
      });
    }

    await storage.appendFreightOpportunityAudit({
      opportunityId: opportunity.id,
      eventType: "status_changed",
      actorUserId: opts.actorUserId ?? null,
      payload: { from: "new", to: nextStatus, confidenceFlag, shortlistSize: persistedCarriers.length },
    });

    results.push({ opportunity: updated ?? opportunity, carriers: persistedCarriers });
  }

  return results;
}

/**
 * Ensure a freight opportunity has a persisted ranked-carrier shortlist.
 *
 * The Available Freight importer creates `freight_opportunities` rows directly
 * (bypassing `generateOpportunitiesForCompany`), which means newly-imported
 * rows arrive with NO `freight_opportunity_carriers` rows attached — the
 * detail page's "Ranked carriers" panel then shows empty.
 *
 * This helper plugs that gap: if the opportunity has no carrier rows yet, run
 * the rank pipeline now, persist the resulting shortlist (including excluded
 * rows, for audit), and refresh the confidence flag. Idempotent: calling it
 * again is a cheap no-op once any rows exist.
 *
 * Returns the persisted carrier rows (existing or newly-created).
 */
export async function ensureShortlistRanked(
  storage: IStorage,
  opportunity: FreightOpportunity,
): Promise<{ ranked: boolean; carriers: FreightOpportunityCarrier[] }> {
  const existing = await storage.listFreightOpportunityCarriers(opportunity.id);
  if (existing.length > 0) return { ranked: false, carriers: existing };

  const policy = await loadEffectivePolicy(storage, opportunity.orgId, opportunity.companyId);
  const shortlist = await rankCarriersForOpportunity(storage, opportunity, policy);
  if (shortlist.length === 0) {
    // Record the empty-result attempt so the activity log shows that ranking
    // ran (and the frontend can stop expecting a future result). Without this
    // audit row, "no carriers matched" was indistinguishable from "ranking
    // never ran" and the page used to spin forever.
    try {
      await storage.appendFreightOpportunityAudit({
        opportunityId: opportunity.id,
        eventType: "generated",
        actorUserId: null,
        payload: { kind: "lazy_shortlist_rank", shortlistSize: 0, result: "no_matches" },
      });
    } catch {
      // Audit is advisory — never block the response on it.
    }
    return { ranked: true, carriers: [] };
  }

  const carrierRows: InsertFreightOpportunityCarrier[] = shortlist.map(row => ({
    opportunityId: opportunity.id,
    carrierId: row.carrier.id,
    rank: row.rank,
    bucket: row.bucket,
    fitScore: row.ranked.fitScore ?? 0,
    historyMatch: row.ranked.historyMatch ?? "none",
    explanation: row.ranked.fitReason ?? null,
    explanationStructured: row.ranked.carrierFitExplanation ?? null,
    responsivenessSnapshot: {
      suppressionReasons: row.ranked.suppressionReasons ?? [],
      loadsOnLane: row.ranked.loadsOnLane,
      priorOutcomeBoost: row.ranked.priorOutcomeBoost,
      // Task #632 — bench tier-0: persist on JSONB so the AF cockpit chip
      // surface can render "Bench Nx wins" without a schema migration.
      bench: row.ranked.bench,
      benchWins: row.ranked.benchWins,
    },
    excludedReason: row.excludedReason,
    outreachLogId: null,
    lastResponseId: null,
  }));

  const persisted = await storage.insertFreightOpportunityCarriers(carrierRows);
  const confidenceFlag = deriveConfidenceFlag(shortlist);
  try {
    await storage.updateFreightOpportunity(opportunity.orgId, opportunity.id, { confidenceFlag });
  } catch {
    // Confidence flag is advisory — non-fatal if the update races with another writer.
  }
  await storage.appendFreightOpportunityAudit({
    opportunityId: opportunity.id,
    eventType: "generated",
    actorUserId: null,
    payload: { kind: "lazy_shortlist_rank", shortlistSize: persisted.length, confidenceFlag },
  });
  return { ranked: true, carriers: persisted };
}

function addDaysIso(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
