/**
 * Copilot Play Caller — Task #926 step 5.
 *
 * Reads a `copilot_intelligence` row + the matching extraction and produces
 * a ranked list of recommended plays. Each recommendation:
 *   - cites the evidence that drove the call
 *   - carries a confidence chip (high|medium|low)
 *   - lists 1–2 alternatives the rep can flip to
 *   - includes a `draftAction` (tool + args) the rep confirms before send
 *     (HITL only — never autonomous)
 *
 * Dedupes against open NBA cards (Phase 1 engine) for the same
 * (companyId, ruleType) so a doc-driven play doesn't double up on an
 * already-pending NBA.
 */
import { db } from "../../storage";
import { sql, eq, and } from "drizzle-orm";
import {
  copilotPlayRecommendations,
  copilotIntelligence,
  copilotAdjustments,
  documentExtractions,
  documents,
  nbaCards,
  type CopilotIntelligence,
  type CopilotPlayRecommendation,
  type DocumentExtraction,
  type Document,
} from "@shared/schema";
import { DOC_DRIVEN_PLAYS, type DocPlayDef } from "../../playsRegistry";

export interface PlayCallerInput {
  document: Document;
  extraction: DocumentExtraction;
  intelligence: CopilotIntelligence;
}

interface ScoredPlay {
  play: DocPlayDef;
  rank: number;          // post-adjustment rank used for ordering + persistence
  baseRank: number;      // pre-adjustment rank — kept for transparency
  reason: string;
  draftAction: { tool: string; args: Record<string, unknown>; preface?: string } | null;
  adjustmentApplied: number; // multiplier we ended up using (1 = no change)
  adjustmentEvidence: Array<{ scope: string; scopeKey: string; factor: number }>;
}

/** Bounded learning multiplier — matches copilotLearningScheduler's clamp. */
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.5;
function clampFactor(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, v));
}

/**
 * Public so tests can build a fake adjustments map and assert rank deltas
 * without touching the database.
 */
export function applyAdjustmentsToPlays(
  scored: Array<{ play: DocPlayDef; rank: number; reason: string; draftAction: ScoredPlay["draftAction"] }>,
  intel: Pick<CopilotIntelligence, "customerId" | "laneKey">,
  adjustments: Map<string, number>,
): ScoredPlay[] {
  const out: ScoredPlay[] = [];
  for (const s of scored) {
    const ev: Array<{ scope: string; scopeKey: string; factor: number }> = [];
    const playFactor = clampFactor(adjustments.get(`play:${s.play.id}`) ?? 1);
    if (playFactor !== 1) ev.push({ scope: "play", scopeKey: s.play.id, factor: playFactor });
    const custFactor = intel.customerId ? clampFactor(adjustments.get(`customer:${intel.customerId}`) ?? 1) : 1;
    if (custFactor !== 1 && intel.customerId) ev.push({ scope: "customer", scopeKey: intel.customerId, factor: custFactor });
    const laneFactor = intel.laneKey ? clampFactor(adjustments.get(`lane:${intel.laneKey}`) ?? 1) : 1;
    if (laneFactor !== 1 && intel.laneKey) ev.push({ scope: "lane", scopeKey: intel.laneKey, factor: laneFactor });
    // Composite: play factor dominates (it's the most direct signal); customer/
    // lane act as a secondary nudge averaged together so a single bad lane
    // can't crater every play in that lane.
    const secondary = (custFactor + laneFactor) / 2;
    const composite = clampFactor(playFactor * (0.5 + 0.5 * secondary));
    const adjusted = Math.max(0, Math.round(s.rank * composite));
    out.push({
      play: s.play,
      baseRank: s.rank,
      rank: adjusted,
      reason: s.reason,
      draftAction: s.draftAction,
      adjustmentApplied: composite,
      adjustmentEvidence: ev,
    });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

const STATE_RE = /^([A-Z]{2})-([A-Z]{2})/;

function dedupKeyFor(intel: CopilotIntelligence, playId: string): string {
  // Bind a recommendation to (org, customer or lane, play). The unique
  // partial index on `copilotPlayRecommendations.dedupKey` collapses
  // duplicates while pending.
  return [
    intel.organizationId,
    intel.customerId ?? "no-cust",
    intel.laneKey ?? "no-lane",
    playId,
  ].join(":");
}

function rateConDraft(intel: CopilotIntelligence, extraction: DocumentExtraction, playId: string): { tool: string; args: Record<string, unknown>; preface: string } | null {
  const payload = (extraction.payload ?? {}) as Record<string, { value?: unknown }>;
  const customer = String(payload?.customer?.value ?? "Customer");
  const lane = intel.laneKey ?? "this lane";
  const lo = intel.priceLow != null ? `$${intel.priceLow}` : "?";
  const hi = intel.priceHigh != null ? `$${intel.priceHigh}` : "?";
  if (playId === "pursue_quote_now") {
    return {
      tool: "draft_email",
      args: {
        to_company_name: customer,
        subject: `Re: ${lane} — quote ready`,
        body_outline: `Confirm pickup window, propose ${lo}–${hi} all-in, restate equipment + accessorials, ask for award timing.`,
      },
      preface: `Draft a pursuit email to ${customer} on ${lane}. Confirm before I save it.`,
    };
  }
  if (playId === "clarify_before_quoting") {
    return {
      tool: "draft_email",
      args: {
        to_company_name: customer,
        subject: `Quick clarifications on ${lane}`,
        body_outline: `Ask for: pickup/delivery windows, accessorials, expected weight, lane volume.`,
      },
      preface: `Draft a clarification email to ${customer} — I don't have enough to quote yet.`,
    };
  }
  if (playId === "pass_low_margin") {
    return {
      tool: "draft_email",
      args: {
        to_company_name: customer,
        subject: `Re: ${lane}`,
        body_outline: `Politely decline citing capacity / rate misalignment, leave door open for future lanes.`,
      },
      preface: `Draft a pass response to ${customer} — comparable rates don't support this load.`,
    };
  }
  return null;
}

function genericDraft(intel: CopilotIntelligence, playId: string): { tool: string; args: Record<string, unknown>; preface: string } | null {
  if (playId === "escalate_to_manager") {
    return {
      tool: "create_task",
      args: {
        title: `Escalate copilot recommendation: ${playId}`,
        notes: `Doc ${intel.documentId} — fit ${intel.laneFitScore ?? "?"}/${intel.customerFitScore ?? "?"}/${intel.carrierFitScore ?? "?"}; risks ${(intel.risks as Array<{ label: string }> | null)?.length ?? 0}`,
      },
      preface: `Open an escalation task — needs manager judgment.`,
    };
  }
  if (playId === "start_with_carrier_bench_A") {
    return {
      tool: "create_task",
      args: {
        title: `Reach out to A-tier carriers for ${intel.laneKey ?? "lane"}`,
        notes: `Doc ${intel.documentId}; carrier-fit score ${intel.carrierFitScore ?? "?"}.`,
      },
      preface: `Open a carrier-outreach task — start with the A-tier bench on this lane.`,
    };
  }
  if (playId === "negotiate_with_incumbent_first") {
    return {
      tool: "create_task",
      args: {
        title: `Re-negotiate with incumbent on ${intel.laneKey ?? "lane"}`,
        notes: `Doc ${intel.documentId}.`,
      },
      preface: `Open a task to re-negotiate with the incumbent before going to market.`,
    };
  }
  if (playId === "route_to_specialist_rep") {
    return {
      tool: "create_task",
      args: {
        title: `Route to specialist rep — ${intel.laneKey ?? "lane"}`,
        notes: `Doc ${intel.documentId}; team needs an SME on this lane.`,
      },
      preface: `Open a routing task — I'll suggest a specialist rep for this lane.`,
    };
  }
  return null;
}

/**
 * Decide which plays apply to a (doc, intelligence) pair. Deterministic
 * rules over fit scores + risk count — no hidden ML. Returns the *base*
 * (pre-adjustment) ranking; learning-loop multipliers are applied
 * separately by `applyAdjustmentsToPlays` so the math is testable.
 */
function rankPlaysBase(intel: CopilotIntelligence): Array<{ play: DocPlayDef; rank: number; reason: string; draftAction: ScoredPlay["draftAction"] }> {
  const scored: Array<{ play: DocPlayDef; rank: number; reason: string; draftAction: ScoredPlay["draftAction"] }> = [];
  const lf = intel.laneFitScore ?? 50;
  const cf = intel.customerFitScore ?? 50;
  const carrierFit = intel.carrierFitScore ?? 50;
  const risks = (intel.risks ?? []) as Array<{ severity: string }>;
  const highRisks = risks.filter((r) => r.severity === "high").length;
  const opps = ((intel.opportunities ?? []) as unknown[]).length;
  const hasPrice = intel.priceMid != null;

  const findPlay = (id: string): DocPlayDef | undefined => DOC_DRIVEN_PLAYS.find((p) => p.id === id);

  // Pursue when both lane fit and customer fit are healthy, price band exists.
  if (hasPrice && lf >= 60 && cf >= 50 && highRisks === 0) {
    const p = findPlay("pursue_quote_now"); if (p) scored.push({ play: p, rank: 90 + Math.round(lf / 10), reason: `lane_fit=${lf}, customer_fit=${cf}, no high-severity risks`, draftAction: null });
  }
  // Pass on low fit + low margin spread.
  if (lf < 40 || highRisks >= 2) {
    const p = findPlay("pass_low_margin"); if (p) scored.push({ play: p, rank: 80 + highRisks * 5, reason: `lane_fit=${lf}, high_risks=${highRisks}`, draftAction: null });
  }
  // Clarify when evidence is thin.
  if (intel.confidence === "low" || (!hasPrice && lf < 70)) {
    const p = findPlay("clarify_before_quoting"); if (p) scored.push({ play: p, rank: 70, reason: `confidence=${intel.confidence}, hasPrice=${hasPrice}`, draftAction: null });
  }
  // Carrier bench play if carrier fit is strong.
  if (carrierFit >= 80) {
    const p = findPlay("start_with_carrier_bench_A"); if (p) scored.push({ play: p, rank: 60, reason: `carrier_fit=${carrierFit}`, draftAction: null });
  }
  // Negotiate with incumbent if we already have rate history.
  if (opps >= 1 && hasPrice) {
    const p = findPlay("negotiate_with_incumbent_first"); if (p) scored.push({ play: p, rank: 50, reason: `${opps} opportunities cited, price band available`, draftAction: null });
  }
  // Specialist routing when lane is unfamiliar.
  if (lf < 30 && cf >= 50) {
    const p = findPlay("route_to_specialist_rep"); if (p) scored.push({ play: p, rank: 45, reason: `lane unfamiliar (lf=${lf}) but customer healthy`, draftAction: null });
  }
  // Escalation when scores conflict / no signal.
  if (intel.confidence === "low" && (lf < 20 || cf < 20)) {
    const p = findPlay("escalate_to_manager"); if (p) scored.push({ play: p, rank: 30, reason: `low confidence + at least one fit < 20`, draftAction: null });
  }

  return scored.sort((a, b) => b.rank - a.rank);
}

/**
 * Load this org's bounded adjustment factors keyed as `${scope}:${scopeKey}`
 * — same shape consumed by copilotFitEngine so callers can share a map.
 */
async function loadAdjustmentsForOrg(orgId: string): Promise<Map<string, number>> {
  const rows = await db.select().from(copilotAdjustments).where(eq(copilotAdjustments.organizationId, orgId));
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.scope}:${r.scopeKey}`, Number(r.factor ?? 1));
  }
  return map;
}

async function checkExistingNbaDedupe(orgId: string, customerId: string | null): Promise<Set<string>> {
  // Dedup-against-NBA: any open NBA card for this customer with a related
  // ruleType is treated as already-recommended; the play caller skips
  // doc-plays that map to those rule types. Open = not resolved/dismissed.
  if (!customerId) return new Set();
  const rows = await db
    .select({ ruleType: nbaCards.ruleType })
    .from(nbaCards)
    .where(and(
      eq(nbaCards.orgId, orgId),
      eq(nbaCards.companyId, customerId),
      sql`${nbaCards.status} NOT IN ('resolved', 'dismissed')`,
    ))
    .limit(20);
  const overlaps = new Set<string>();
  for (const r of rows) {
    for (const play of DOC_DRIVEN_PLAYS) {
      if (play.dedupAgainstNbaRuleTypes?.includes(r.ruleType)) overlaps.add(play.id);
    }
  }
  return overlaps;
}

export async function recommendPlaysForDocument(input: PlayCallerInput): Promise<CopilotPlayRecommendation[]> {
  const { document, extraction, intelligence } = input;
  const dedupedAgainstNba = await checkExistingNbaDedupe(document.organizationId, intelligence.customerId);
  const adjustments = await loadAdjustmentsForOrg(document.organizationId);
  const base = rankPlaysBase(intelligence).filter((s) => !dedupedAgainstNba.has(s.play.id));
  const scored = applyAdjustmentsToPlays(base, intelligence, adjustments);
  if (!scored.length) return [];

  const out: CopilotPlayRecommendation[] = [];
  const top = scored.slice(0, 3);
  const alternatives = scored.slice(1).map((s) => ({ playId: s.play.id, playName: s.play.name, reason: s.reason }));

  for (let i = 0; i < top.length; i++) {
    const s = top[i];
    const draftAction = rateConDraft(intelligence, extraction, s.play.id) ?? genericDraft(intelligence, s.play.id);
    const evidence = (intelligence.evidenceRefs ?? []) as object;
    const dedup = dedupKeyFor(intelligence, s.play.id);

    // Confidence: top play inherits intel confidence, lower-ranked drop a step.
    const confidence =
      i === 0 ? intelligence.confidence
      : intelligence.confidence === "high" ? "medium"
      : "low";

    // Surface the learning multipliers we applied alongside the original
    // citations so the rep + admin tab can see *why* this rec moved up or
    // down vs the deterministic base score.
    const evidenceWithAdjustments = {
      cited: evidence,
      learning: {
        baseRank: s.baseRank,
        adjustedRank: s.rank,
        composite: Number(s.adjustmentApplied.toFixed(3)),
        factors: s.adjustmentEvidence,
      },
    };

    const [row] = await db
      .insert(copilotPlayRecommendations)
      .values({
        organizationId: document.organizationId,
        intelligenceId: intelligence.id,
        documentId: document.id,
        laneKey: intelligence.laneKey ?? null,
        customerId: intelligence.customerId,
        carrierId: null,
        rfpId: null,
        freightId: null,
        playId: s.play.id,
        playName: s.play.name,
        rank: s.rank,
        confidence,
        evidence: evidenceWithAdjustments,
        alternatives: alternatives.filter((a) => a.playId !== s.play.id).slice(0, 2) as object,
        draftAction: draftAction as object | null,
        rationale: s.reason,
        status: "pending",
        ownerUserId: document.uploaderId,
        dedupKey: dedup,
      })
      .onConflictDoNothing({
        target: [copilotPlayRecommendations.organizationId, copilotPlayRecommendations.dedupKey],
      })
      .returning();
    if (row) out.push(row);
  }
  return out;
}

export async function listRecommendationsForDocument(orgId: string, documentId: string): Promise<CopilotPlayRecommendation[]> {
  return db
    .select()
    .from(copilotPlayRecommendations)
    .where(and(
      eq(copilotPlayRecommendations.organizationId, orgId),
      eq(copilotPlayRecommendations.documentId, documentId),
    ))
    .orderBy(sql`rank DESC`);
}

export async function listOpenRecommendationsForCustomer(orgId: string, customerId: string): Promise<CopilotPlayRecommendation[]> {
  return db
    .select()
    .from(copilotPlayRecommendations)
    .where(and(
      eq(copilotPlayRecommendations.organizationId, orgId),
      eq(copilotPlayRecommendations.customerId, customerId),
      eq(copilotPlayRecommendations.status, "pending"),
    ))
    .orderBy(sql`rank DESC`)
    .limit(10);
}

export async function listOpenRecommendationsForLane(orgId: string, laneKey: string): Promise<CopilotPlayRecommendation[]> {
  return db
    .select()
    .from(copilotPlayRecommendations)
    .where(and(
      eq(copilotPlayRecommendations.organizationId, orgId),
      eq(copilotPlayRecommendations.laneKey, laneKey),
      eq(copilotPlayRecommendations.status, "pending"),
    ))
    .orderBy(sql`rank DESC`)
    .limit(10);
}

export async function resolveRecommendation(args: {
  organizationId: string;
  recommendationId: string;
  userId: string;
  action: "accepted" | "dismissed" | "snoozed" | "overridden";
  snoozedUntil?: Date | null;
  overrideNote?: string | null;
}): Promise<CopilotPlayRecommendation | null> {
  const [row] = await db
    .update(copilotPlayRecommendations)
    .set({
      status: args.action === "accepted" ? "accepted" : args.action === "snoozed" ? "snoozed" : args.action === "overridden" ? "overridden" : "dismissed",
      resolvedByUserId: args.userId,
      resolvedAt: new Date(),
      snoozedUntil: args.snoozedUntil ?? null,
      overrideNote: args.overrideNote ?? null,
    })
    .where(and(
      eq(copilotPlayRecommendations.organizationId, args.organizationId),
      eq(copilotPlayRecommendations.id, args.recommendationId),
    ))
    .returning();
  return row ?? null;
}
