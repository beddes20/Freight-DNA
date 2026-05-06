/**
 * Copilot Fit Engine — Task #926 step 4.
 *
 * Reads the resolved entities for an extracted document and produces
 * lane-fit / customer-fit / carrier-fit scores grounded in our own
 * historical data. Every score cites the records it used.
 *
 * Sources used:
 *   - lane_rate_history       → historic lane volume + cost-per-mile spread
 *   - recurring_lanes         → current recurring lane fit + score factors
 *   - carrier_scorecard_fact  → recent carrier reliability (by carrier name)
 *   - account_growth_scores   → customer health signal
 *   - carriers                → bridge from resolved.carrierIds → name
 *
 * Scoring rules — deliberately simple, deterministic, and explainable:
 *   - lane_fit_score: more recent loads → higher score; capped at 100.
 *   - customer_fit_score: account growth band → score band.
 *   - carrier_fit_score: carrier_scorecard_fact.performanceScore averaged.
 *
 * Adjustment factors from `copilot_adjustments` are applied as bounded
 * multipliers (0.5–1.5) — see `applyAdjustment`.
 */
import { db } from "../../storage";
import { sql, eq, and, inArray } from "drizzle-orm";
import {
  laneRateHistory,
  recurringLanes,
  carrierScorecardFact,
  accountGrowthScores,
  copilotAdjustments,
  carriers,
  type ResolvedEntities,
} from "@shared/schema";

export interface EvidenceRef {
  kind: string;          // 'lane_rate_history' | 'recurring_lane' | 'carrier_scorecard_fact' | 'account_growth_score'
  id?: string;
  label: string;
  value?: string | number;
  href?: string;
  updatedAt?: string;
}

export interface FitResult {
  laneKey: string | null;
  laneFitScore: number | null;
  customerFitScore: number | null;
  carrierFitScore: number | null;
  evidence: EvidenceRef[];
  risks: Array<{ label: string; severity: "high" | "medium" | "low"; evidence: EvidenceRef[] }>;
  opportunities: Array<{ label: string; evidence: EvidenceRef[] }>;
  confidence: "high" | "medium" | "low";
  adjustmentsApplied: Record<string, number>;
}

function parseLaneKey(laneKey: string): { originState: string | null; destinationState: string | null; equip: string | null } {
  // Format: "OST-DST-EQUIP"
  const parts = laneKey.split("-");
  if (parts.length < 2) return { originState: null, destinationState: null, equip: null };
  return {
    originState: parts[0] && parts[0] !== "NA" ? parts[0] : null,
    destinationState: parts[1] && parts[1] !== "NA" ? parts[1] : null,
    equip: parts.slice(2).join("-") || null,
  };
}

async function loadAdjustments(orgId: string): Promise<Map<string, number>> {
  const rows = await db.select().from(copilotAdjustments).where(eq(copilotAdjustments.organizationId, orgId));
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.scope}:${r.scopeKey}`, Number(r.factor ?? 1));
  }
  return map;
}

function applyAdjustment(score: number | null, factor: number): number | null {
  if (score == null) return null;
  const clamped = Math.max(0.5, Math.min(1.5, factor || 1));
  return Math.max(0, Math.min(100, Math.round(score * clamped)));
}

export async function computeFitForLane(args: {
  organizationId: string;
  laneKey: string;
  customerId: string | null;
  carrierIds: string[];
  customerName?: string | null;
}): Promise<FitResult> {
  const { organizationId, laneKey, customerId, carrierIds } = args;
  const evidence: EvidenceRef[] = [];
  const risks: FitResult["risks"] = [];
  const opportunities: FitResult["opportunities"] = [];
  const adjustments = await loadAdjustments(organizationId);
  const adjustmentsApplied: Record<string, number> = {};

  const { originState, destinationState } = parseLaneKey(laneKey);

  // ── Lane fit ──────────────────────────────────────────────────────────
  let laneFit: number | null = null;
  if (originState && destinationState) {
    const lh = await db
      .select()
      .from(laneRateHistory)
      .where(and(
        eq(laneRateHistory.orgId, organizationId),
        eq(laneRateHistory.originState, originState),
        eq(laneRateHistory.destinationState, destinationState),
      ))
      .limit(5);
    let loads = 0;
    for (const row of lh) {
      const n = Number(row.loads ?? 0);
      loads += Number.isFinite(n) ? n : 0;
      evidence.push({
        kind: "lane_rate_history",
        id: row.id,
        label: `Historic loads ${row.originState}→${row.destinationState}${row.equipmentType !== "ALL" ? ` ${row.equipmentType}` : ""}: ${row.loads}`,
        value: row.loads,
      });
    }
    if (loads > 0) laneFit = Math.min(100, 30 + Math.min(70, loads));
    if (loads >= 30) opportunities.push({ label: "Lane we historically dominate (30+ loads)", evidence: [{ kind: "lane_rate_history", label: `${loads} loads ${originState}→${destinationState}` }] });
    if (loads === 0) risks.push({ label: "No historical loads on this lane", severity: "medium", evidence: [{ kind: "lane_rate_history", label: `${originState}→${destinationState}` }] });

    // Recurring lane match.
    const where = customerId
      ? and(
          eq(recurringLanes.orgId, organizationId),
          eq(recurringLanes.companyId, customerId),
          eq(recurringLanes.originState, originState),
          eq(recurringLanes.destinationState, destinationState),
        )
      : and(
          eq(recurringLanes.orgId, organizationId),
          eq(recurringLanes.originState, originState),
          eq(recurringLanes.destinationState, destinationState),
        );
    const rls = await db.select().from(recurringLanes).where(where).limit(3);
    for (const rl of rls) {
      evidence.push({
        kind: "recurring_lane",
        id: rl.id,
        label: `Recurring lane ${rl.origin}→${rl.destination}${rl.equipmentType ? ` (${rl.equipmentType})` : ""} score=${rl.laneScore ?? "—"}`,
        value: rl.laneScore ?? undefined,
        href: `/lane-work-queue?focus=${rl.id}`,
      });
      if (rl.laneScore != null) {
        const s = Math.min(100, rl.laneScore);
        if (laneFit == null || s > laneFit) laneFit = s;
        if (rl.laneScore < 35) {
          risks.push({ label: `Recurring lane scoring low (${rl.laneScore})`, severity: "medium", evidence: [{ kind: "recurring_lane", id: rl.id, label: rl.origin + "→" + rl.destination }] });
        }
      }
    }
  }

  // ── Customer fit ──────────────────────────────────────────────────────
  let customerFit: number | null = null;
  if (customerId) {
    const [growth] = await db
      .select()
      .from(accountGrowthScores)
      .where(and(eq(accountGrowthScores.organizationId, organizationId), eq(accountGrowthScores.companyId, customerId)))
      .limit(1);
    if (growth) {
      customerFit = Math.max(0, Math.min(100, growth.score));
      evidence.push({
        kind: "account_growth_score",
        id: String(growth.id),
        label: `Account growth: ${growth.band} (score ${growth.score})`,
        value: growth.score,
      });
      if (growth.band === "at_risk") risks.push({ label: "Customer flagged at_risk by growth model", severity: "high", evidence: [{ kind: "account_growth_score", label: `band=at_risk` }] });
      if (growth.band === "high_expansion") opportunities.push({ label: "Customer in high_expansion band", evidence: [{ kind: "account_growth_score", label: `band=high_expansion` }] });
    }
  }

  // ── Carrier fit ───────────────────────────────────────────────────────
  let carrierFit: number | null = null;
  if (carrierIds.length) {
    // Bridge: carriers.id → carriers.name → carrierScorecardFact.carrierName
    const carrierRows = await db
      .select({ id: carriers.id, name: carriers.name })
      .from(carriers)
      .where(and(eq(carriers.orgId, organizationId), inArray(carriers.id, carrierIds)));
    const names = carrierRows.map((c) => c.name);
    if (names.length) {
      const sf = await db
        .select()
        .from(carrierScorecardFact)
        .where(and(eq(carrierScorecardFact.orgId, organizationId), inArray(carrierScorecardFact.carrierName, names)))
        .limit(20);
      let perfSum = 0, perfN = 0, otSum = 0, otN = 0;
      for (const r of sf) {
        perfSum += r.performanceScore ?? 0; perfN++;
        const ot = r.onTimePct != null ? Number(r.onTimePct) : NaN;
        if (Number.isFinite(ot)) { otSum += ot; otN++; }
        evidence.push({
          kind: "carrier_scorecard_fact",
          id: r.id,
          label: `Carrier ${r.carrierName} ${r.equipmentType !== "ALL" ? `(${r.equipmentType})` : ""}: tier ${r.tier}, perf ${r.performanceScore}, OTP ${r.onTimePct ?? "—"}%`,
          value: r.performanceScore,
        });
      }
      if (perfN) {
        carrierFit = Math.round(perfSum / perfN);
        const avgOt = otN ? otSum / otN : null;
        if (avgOt != null && avgOt < 80) risks.push({ label: `Carrier OTP averaging ${avgOt.toFixed(1)}%`, severity: "high", evidence: [{ kind: "carrier_scorecard_fact", label: `OTP avg ${avgOt.toFixed(1)}%` }] });
        if (carrierFit >= 80) opportunities.push({ label: "Carrier bench performing strongly", evidence: [{ kind: "carrier_scorecard_fact", label: `avg perf ${carrierFit}` }] });
      }
    }
  }

  // ── Apply adjustments ─────────────────────────────────────────────────
  const customerFactor = customerId ? (adjustments.get(`customer:${customerId}`) ?? 1) : 1;
  const laneFactor = adjustments.get(`lane:${laneKey}`) ?? 1;
  const carrierFactor = carrierIds[0] ? (adjustments.get(`carrier:${carrierIds[0]}`) ?? 1) : 1;
  if (customerFactor !== 1) adjustmentsApplied[`customer:${customerId}`] = customerFactor;
  if (laneFactor !== 1) adjustmentsApplied[`lane:${laneKey}`] = laneFactor;
  if (carrierFactor !== 1) adjustmentsApplied[`carrier:${carrierIds[0]}`] = carrierFactor;

  return {
    laneKey,
    laneFitScore: applyAdjustment(laneFit, laneFactor),
    customerFitScore: applyAdjustment(customerFit, customerFactor),
    carrierFitScore: applyAdjustment(carrierFit, carrierFactor),
    evidence,
    risks,
    opportunities,
    confidence: evidence.length >= 3 ? "high" : evidence.length >= 1 ? "medium" : "low",
    adjustmentsApplied,
  };
}

export async function computeDocLevelFit(args: {
  organizationId: string;
  resolved: ResolvedEntities;
}): Promise<FitResult[]> {
  const { organizationId, resolved } = args;
  const laneKeys = resolved.laneKeys.length ? resolved.laneKeys : ["NA-NA-ANY"];
  const out: FitResult[] = [];
  for (const laneKey of laneKeys) {
    out.push(
      await computeFitForLane({
        organizationId,
        laneKey,
        customerId: resolved.customerId,
        carrierIds: resolved.carrierIds,
        customerName: resolved.customerName ?? null,
      }),
    );
  }
  return out;
}
