// Task #872 — Manager Leak Console service.
//
// Computes the four leak panels and the daily KPI rollup. Each panel is its
// own paginated query so the console never loads more than the visible panel.
//
//   1. no_contactable_under_demand     — LWQ "no contactable" + ≥1 live AF row
//   2. unstable_spot_deployed          — volatilityPenalty < 0 + recent AF cover
//                                        with no LWQ touchpoint in 14d
//   3. recurring_covered_on_spot       — recurring lane covered via AF without
//                                        an LWQ touchpoint in trailing 7d
//   4. owned_untouched_under_pressure  — owned recurring lane with no touchpoint
//                                        in 7d AND ≥1 live AF row today
//
// All queries are scoped by orgId. Visibility (team/owner) is applied as an
// optional filter — managers can override to see other reps. No N+1: every
// chip is precomputed in SQL or via constant-pass batch lookups.

import { and, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  carrierOutreachLogs,
  companies,
  freightOpportunities,
  laneCarrierInterest,
  laneSummaryCache,
  recurringLanes,
  users,
  type LeakConsolePanel,
} from "@shared/schema";
import { laneSig } from "./laneCrossLinkService";
import { db } from "./storage";

// ── Constants ────────────────────────────────────────────────────────────────

const OPEN_OPP_STATUSES = [
  "new",
  "ready_to_send",
  "sent",
  "awaiting_carrier_reply",
  "awaiting_customer_confirm",
  "partially_covered",
] as const;

const LIVE_DELIVERY_STATUSES = ["sent", "delivered", "opened"];

export type LaneHealth = "stable" | "volatile" | "hot";
export type SpendTier = "A" | "B" | "C" | "new";

export interface LeakFilters {
  ownerUserId?: string | null;
  teamUserIds?: string[] | null;
  tier?: SpendTier | null;
  health?: LaneHealth | null;
  /** Trailing window for spot-cover analysis (days). Default 14. */
  windowDays?: number;
  limit?: number;
  offset?: number;
}

export interface EvidenceChip {
  label: string;
  tone?: "neutral" | "warn" | "danger" | "info";
}

export interface LeakRow {
  laneId: string;
  laneSig: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyId: string | null;
  companyName: string | null;
  companyTier: SpendTier;
  ownerUserId: string | null;
  ownerName: string | null;
  laneScore: number | null;
  volatilityPenalty: number | null;
  health: LaneHealth;
  evidence: EvidenceChip[];
}

export interface LeakPanelResult {
  panel: LeakConsolePanel;
  rows: LeakRow[];
  total: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tierFromSpend(spend: string | null | undefined): SpendTier {
  if (!spend) return "new";
  const n = Number(spend);
  if (!Number.isFinite(n)) return "new";
  if (n >= 1_000_000) return "A";
  if (n >= 250_000) return "B";
  return "C";
}

export function laneHealthFromVolatility(penalty: number | null | undefined): LaneHealth {
  const p = Number(penalty ?? 0);
  if (!Number.isFinite(p) || p === 0) return "stable";
  if (p <= -5) return "hot";
  return "volatile";
}

function extractVolatility(factors: unknown): number | null {
  if (!factors || typeof factors !== "object") return null;
  const v = (factors as Record<string, unknown>).volatilityPenalty;
  return typeof v === "number" ? v : null;
}

function trimDays(days: number | undefined, fallback: number, maxDays: number): number {
  const n = Number(days ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), maxDays);
}

function applyFilters(rows: LeakRow[], filters: LeakFilters): LeakRow[] {
  let out = rows;
  if (filters.ownerUserId !== undefined && filters.ownerUserId !== null) {
    out = out.filter((r) => r.ownerUserId === filters.ownerUserId);
  }
  if (filters.teamUserIds && filters.teamUserIds.length > 0) {
    const set = new Set(filters.teamUserIds);
    out = out.filter((r) => r.ownerUserId && set.has(r.ownerUserId));
  }
  if (filters.tier) {
    out = out.filter((r) => r.companyTier === filters.tier);
  }
  if (filters.health) {
    out = out.filter((r) => r.health === filters.health);
  }
  return out;
}

function paginate(rows: LeakRow[], filters: LeakFilters): LeakPanelResult["rows"] {
  const offset = Math.max(0, Number(filters.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Number(filters.limit ?? 50)));
  return rows.slice(offset, offset + limit);
}

interface LaneCore {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  companyId: string | null;
  ownerUserId: string | null;
  laneScore: number | null;
  volatilityPenalty: number | null;
}

interface EnrichedLane extends LaneCore {
  companyName: string | null;
  companyTier: SpendTier;
  ownerName: string | null;
  laneSig: string;
  health: LaneHealth;
}

async function enrich(orgId: string, lanes: LaneCore[]): Promise<EnrichedLane[]> {
  if (lanes.length === 0) return [];
  const companyIds = Array.from(new Set(lanes.map((l) => l.companyId).filter((v): v is string => !!v)));
  const ownerIds = Array.from(new Set(lanes.map((l) => l.ownerUserId).filter((v): v is string => !!v)));

  const companyRows = companyIds.length
    ? await db
        .select({ id: companies.id, name: companies.name, spend: companies.estimatedFreightSpend })
        .from(companies)
        .where(and(eq(companies.organizationId, orgId), inArray(companies.id, companyIds)))
    : [];
  const companyById = new Map(companyRows.map((c) => [c.id, c]));

  const ownerRows = ownerIds.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds))
    : [];
  const ownerById = new Map(ownerRows.map((u) => [u.id, u.name]));

  return lanes.map((l) => {
    const company = l.companyId ? companyById.get(l.companyId) : undefined;
    return {
      ...l,
      companyName: company?.name ?? null,
      companyTier: tierFromSpend(company?.spend ?? null),
      ownerName: l.ownerUserId ? ownerById.get(l.ownerUserId) ?? null : null,
      laneSig: laneSig(l.origin, l.originState, l.destination, l.destinationState, l.equipmentType),
      health: laneHealthFromVolatility(l.volatilityPenalty),
    };
  });
}

// ── Live AF row index ────────────────────────────────────────────────────────

interface LiveOppCounts {
  countsBySig: Map<string, number>;
  loadsBySig: Map<string, number>;
}

async function buildLiveOppIndex(orgId: string): Promise<LiveOppCounts> {
  const rows = await db
    .select({
      origin: freightOpportunities.origin,
      originState: freightOpportunities.originState,
      destination: freightOpportunities.destination,
      destinationState: freightOpportunities.destinationState,
      equipmentType: freightOpportunities.equipmentType,
      loadCount: freightOpportunities.loadCount,
    })
    .from(freightOpportunities)
    .where(
      and(
        eq(freightOpportunities.orgId, orgId),
        inArray(freightOpportunities.status, [...OPEN_OPP_STATUSES]),
      ),
    );
  const countsBySig = new Map<string, number>();
  const loadsBySig = new Map<string, number>();
  for (const r of rows) {
    const sig = laneSig(r.origin, r.originState, r.destination, r.destinationState, r.equipmentType);
    countsBySig.set(sig, (countsBySig.get(sig) ?? 0) + 1);
    loadsBySig.set(sig, (loadsBySig.get(sig) ?? 0) + (r.loadCount ?? 1));
  }
  return { countsBySig, loadsBySig };
}

// ── Spot-cover index ─────────────────────────────────────────────────────────
//
// Counts AF "covered" status transitions per lane sig in the trailing window.
// Used by Panel 2 + Panel 3.

async function buildSpotCoverIndex(orgId: string, windowDays: number): Promise<Map<string, number>> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await db
    .select({
      origin: freightOpportunities.origin,
      originState: freightOpportunities.originState,
      destination: freightOpportunities.destination,
      destinationState: freightOpportunities.destinationState,
      equipmentType: freightOpportunities.equipmentType,
    })
    .from(freightOpportunities)
    .where(
      and(
        eq(freightOpportunities.orgId, orgId),
        eq(freightOpportunities.status, "covered"),
        gte(freightOpportunities.generatedAt, since),
      ),
    );
  const out = new Map<string, number>();
  for (const r of rows) {
    const sig = laneSig(r.origin, r.originState, r.destination, r.destinationState, r.equipmentType);
    out.set(sig, (out.get(sig) ?? 0) + 1);
  }
  return out;
}

// ── Last-touchpoint-per-lane index ───────────────────────────────────────────

async function buildLastTouchIndex(orgId: string): Promise<Map<string, Date>> {
  const rows = await db
    .select({
      laneId: carrierOutreachLogs.laneId,
      sentAt: carrierOutreachLogs.sentAt,
      timestamp: carrierOutreachLogs.timestamp,
      status: carrierOutreachLogs.deliveryStatus,
    })
    .from(carrierOutreachLogs)
    .where(
      and(
        eq(carrierOutreachLogs.orgId, orgId),
        isNotNull(carrierOutreachLogs.laneId),
      ),
    );
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (!r.laneId) continue;
    if (r.status && !LIVE_DELIVERY_STATUSES.includes(r.status)) continue;
    const ts = (r.sentAt ?? r.timestamp) as Date | null;
    if (!ts) continue;
    const prev = out.get(r.laneId);
    if (!prev || prev < ts) out.set(r.laneId, ts);
  }
  return out;
}

// ── Lane core fetch ──────────────────────────────────────────────────────────

async function fetchLaneCores(orgId: string): Promise<LaneCore[]> {
  const rows = await db
    .select({
      laneId: recurringLanes.id,
      origin: recurringLanes.origin,
      originState: recurringLanes.originState,
      destination: recurringLanes.destination,
      destinationState: recurringLanes.destinationState,
      equipmentType: recurringLanes.equipmentType,
      companyId: recurringLanes.companyId,
      ownerUserId: recurringLanes.ownerUserId,
      laneScore: recurringLanes.laneScore,
      laneScoreFactors: recurringLanes.laneScoreFactors,
      isEligible: recurringLanes.isEligible,
      hasPreferred: recurringLanes.hasPreferredCarrierProgram,
      resolvedAt: recurringLanes.resolvedAt,
    })
    .from(recurringLanes)
    .where(
      and(
        eq(recurringLanes.orgId, orgId),
        eq(recurringLanes.isEligible, true),
        eq(recurringLanes.hasPreferredCarrierProgram, false),
        isNull(recurringLanes.resolvedAt),
      ),
    );
  return rows.map((r) => ({
    laneId: r.laneId,
    origin: r.origin,
    originState: r.originState,
    destination: r.destination,
    destinationState: r.destinationState,
    equipmentType: r.equipmentType,
    companyId: r.companyId,
    ownerUserId: r.ownerUserId,
    laneScore: r.laneScore,
    volatilityPenalty: extractVolatility(r.laneScoreFactors),
  }));
}

// ── Lane Summary Cache fetch (used for "no contactable") ─────────────────────

async function fetchNoContactableLaneIds(orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      laneId: laneSummaryCache.laneId,
      contactableCount: laneSummaryCache.contactableCount,
      ownerUserId: laneSummaryCache.ownerUserId,
      isEligible: laneSummaryCache.isEligible,
      resolvedAt: laneSummaryCache.resolvedAt,
    })
    .from(laneSummaryCache)
    .where(eq(laneSummaryCache.orgId, orgId));
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.isEligible) continue;
    if (r.resolvedAt) continue;
    if ((r.contactableCount ?? 0) > 0) continue;
    out.add(r.laneId);
  }
  return out;
}

// ── Panel 1: No-contactable under demand ─────────────────────────────────────

export async function getNoContactableUnderDemand(
  orgId: string,
  filters: LeakFilters = {},
): Promise<LeakPanelResult> {
  const [cores, noContactSet, oppIdx] = await Promise.all([
    fetchLaneCores(orgId),
    fetchNoContactableLaneIds(orgId),
    buildLiveOppIndex(orgId),
  ]);
  const enriched = await enrich(orgId, cores.filter((c) => noContactSet.has(c.laneId)));
  const candidates = enriched.filter((l) => (oppIdx.countsBySig.get(l.laneSig) ?? 0) >= 1);
  const rows: LeakRow[] = candidates.map((l) => {
    const liveCount = oppIdx.countsBySig.get(l.laneSig) ?? 0;
    const liveLoads = oppIdx.loadsBySig.get(l.laneSig) ?? 0;
    return {
      ...rowFromEnriched(l),
      evidence: [
        { label: `AF live: ${liveCount} today`, tone: "danger" },
        { label: `${liveLoads} loads`, tone: "warn" },
        { label: "No contactable carriers", tone: "danger" },
      ],
    };
  });
  const filtered = applyFilters(rows, filters);
  filtered.sort((a, b) => (b.laneScore ?? 0) - (a.laneScore ?? 0));
  return { panel: "no_contactable_under_demand", rows: paginate(filtered, filters), total: filtered.length };
}

// ── Panel 2: Unstable lanes still being spot-deployed ────────────────────────

export async function getUnstableSpotDeployed(
  orgId: string,
  filters: LeakFilters = {},
): Promise<LeakPanelResult> {
  const windowDays = trimDays(filters.windowDays, 14, 90);
  const [cores, spotIdx, lastTouch] = await Promise.all([
    fetchLaneCores(orgId),
    buildSpotCoverIndex(orgId, windowDays),
    buildLastTouchIndex(orgId),
  ]);
  const enriched = await enrich(
    orgId,
    cores.filter((c) => (c.volatilityPenalty ?? 0) < 0),
  );
  const cutoff = Date.now() - windowDays * 86_400_000;
  const candidates = enriched.filter((l) => {
    const spotCovers = spotIdx.get(l.laneSig) ?? 0;
    if (spotCovers === 0) return false;
    const lastTouchAt = lastTouch.get(l.laneId);
    if (lastTouchAt && lastTouchAt.getTime() >= cutoff) return false;
    return true;
  });
  const rows: LeakRow[] = candidates.map((l) => {
    const spotCovers = spotIdx.get(l.laneSig) ?? 0;
    const v = l.volatilityPenalty ?? 0;
    return {
      ...rowFromEnriched(l),
      evidence: [
        { label: `score ${l.laneScore ?? "—"}, volatility ${v}`, tone: "warn" },
        { label: `${spotCovers} spot covers, last ${windowDays}d`, tone: "danger" },
        { label: l.health === "hot" ? "Hot" : "Volatile", tone: "warn" },
      ],
    };
  });
  const filtered = applyFilters(rows, filters);
  filtered.sort((a, b) => (a.volatilityPenalty ?? 0) - (b.volatilityPenalty ?? 0));
  return { panel: "unstable_spot_deployed", rows: paginate(filtered, filters), total: filtered.length };
}

// ── Panel 3: Recurring covered on spot ───────────────────────────────────────

export async function getRecurringCoveredOnSpot(
  orgId: string,
  filters: LeakFilters = {},
): Promise<LeakPanelResult> {
  const windowDays = trimDays(filters.windowDays, 7, 30);
  const [cores, spotIdx, lastTouch] = await Promise.all([
    fetchLaneCores(orgId),
    buildSpotCoverIndex(orgId, windowDays),
    buildLastTouchIndex(orgId),
  ]);
  const enriched = await enrich(orgId, cores);
  const cutoff = Date.now() - windowDays * 86_400_000;
  const candidates = enriched.filter((l) => {
    const spotCovers = spotIdx.get(l.laneSig) ?? 0;
    if (spotCovers === 0) return false;
    const lastTouchAt = lastTouch.get(l.laneId);
    return !lastTouchAt || lastTouchAt.getTime() < cutoff;
  });
  const rows: LeakRow[] = candidates.map((l) => {
    const spotCovers = spotIdx.get(l.laneSig) ?? 0;
    return {
      ...rowFromEnriched(l),
      evidence: [
        { label: `${spotCovers} spot covers, last ${windowDays}d`, tone: "danger" },
        { label: l.ownerName ? `owner ${l.ownerName}` : "unowned", tone: l.ownerName ? "info" : "warn" },
        { label: "no LWQ touchpoint", tone: "warn" },
      ],
    };
  });
  const filtered = applyFilters(rows, filters);
  filtered.sort((a, b) => (spotIdx.get(b.laneSig) ?? 0) - (spotIdx.get(a.laneSig) ?? 0));
  return { panel: "recurring_covered_on_spot", rows: paginate(filtered, filters), total: filtered.length };
}

// ── Panel 4: Owned-but-untouched under pressure ──────────────────────────────

export async function getOwnedUntouchedUnderPressure(
  orgId: string,
  filters: LeakFilters = {},
): Promise<LeakPanelResult> {
  const windowDays = trimDays(filters.windowDays, 7, 30);
  const [cores, oppIdx, lastTouch] = await Promise.all([
    fetchLaneCores(orgId),
    buildLiveOppIndex(orgId),
    buildLastTouchIndex(orgId),
  ]);
  const enriched = await enrich(orgId, cores.filter((c) => !!c.ownerUserId));
  const cutoff = Date.now() - windowDays * 86_400_000;
  const candidates = enriched.filter((l) => {
    if ((oppIdx.countsBySig.get(l.laneSig) ?? 0) < 1) return false;
    const lastTouchAt = lastTouch.get(l.laneId);
    return !lastTouchAt || lastTouchAt.getTime() < cutoff;
  });
  const rows: LeakRow[] = candidates.map((l) => {
    const liveCount = oppIdx.countsBySig.get(l.laneSig) ?? 0;
    const lastTouchAt = lastTouch.get(l.laneId);
    const stalenessDays = lastTouchAt
      ? Math.floor((Date.now() - lastTouchAt.getTime()) / 86_400_000)
      : null;
    return {
      ...rowFromEnriched(l),
      evidence: [
        { label: `AF live: ${liveCount} today`, tone: "danger" },
        {
          label: stalenessDays === null ? "never touched" : `${stalenessDays}d since touch`,
          tone: "warn",
        },
        { label: l.ownerName ? `owner ${l.ownerName}` : "unowned", tone: "info" },
      ],
    };
  });
  const filtered = applyFilters(rows, filters);
  filtered.sort((a, b) => {
    const lt = (laneId: string) => lastTouch.get(laneId)?.getTime() ?? 0;
    return lt(a.laneId) - lt(b.laneId);
  });
  return { panel: "owned_untouched_under_pressure", rows: paginate(filtered, filters), total: filtered.length };
}

// ── Row shaping helper ───────────────────────────────────────────────────────

function rowFromEnriched(l: EnrichedLane): Omit<LeakRow, "evidence"> {
  return {
    laneId: l.laneId,
    laneSig: l.laneSig,
    origin: l.origin,
    originState: l.originState,
    destination: l.destination,
    destinationState: l.destinationState,
    equipmentType: l.equipmentType,
    companyId: l.companyId,
    companyName: l.companyName,
    companyTier: l.companyTier,
    ownerUserId: l.ownerUserId,
    ownerName: l.ownerName,
    laneScore: l.laneScore,
    volatilityPenalty: l.volatilityPenalty,
    health: l.health,
  };
}

// ── KPI rollup ───────────────────────────────────────────────────────────────

export interface LeakKpiCounts {
  noContactableUnderDemand: number;
  unstableSpotDeployed: number;
  recurringCoveredOnSpot: number;
  ownedUntouchedUnderPressure: number;
}

export async function computeKpiCounts(orgId: string): Promise<LeakKpiCounts> {
  const [p1, p2, p3, p4] = await Promise.all([
    getNoContactableUnderDemand(orgId, { limit: 200 }),
    getUnstableSpotDeployed(orgId, { limit: 200 }),
    getRecurringCoveredOnSpot(orgId, { limit: 200 }),
    getOwnedUntouchedUnderPressure(orgId, { limit: 200 }),
  ]);
  return {
    noContactableUnderDemand: p1.total,
    unstableSpotDeployed: p2.total,
    recurringCoveredOnSpot: p3.total,
    ownedUntouchedUnderPressure: p4.total,
  };
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export const __test = {
  tierFromSpend,
  laneHealthFromVolatility,
  extractVolatility,
  trimDays,
  applyFilters,
  paginate,
};
