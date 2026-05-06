/**
 * Task #912 — Intelligence Reasoner.
 *
 * Deterministic transform from (extraction + overlay) → IntelligenceCardPayload.
 *
 * Hard rule: every reason / risk / play MUST carry at least one source chip
 * pointing back at an extraction field, CRM record, or finding. The reasoner
 * NEVER fabricates a claim from "general freight knowledge" — when no source
 * supports a claim, the card is downgraded to needsReview=true and the claim
 * is dropped.
 *
 * Aggregate confidence:
 *   high   — all primary fields (origin, dest, rate, carrier, customer)
 *            extracted with field confidence ≥ 0.75 AND no warn/block findings.
 *   medium — at least one field below 0.75 OR a warn finding; primary fields
 *            still all populated.
 *   low    — any primary field missing OR a block finding fired OR an
 *            ambiguous entity link.
 *
 * Fit score (0–100) is composed from:
 *   +30 carrier resolved & serves both states & equipment fit
 *   +25 carrier resolved & serves both states (equipment unknown)
 *   +20 customer resolved & no open capture failure
 *   +15 recurring lane present & lane health ≠ leaking/volatile/hot
 *   +10 freshness < 4h
 *   +5  no warn findings
 *   −20 block finding present
 *   −15 ambiguous customer / carrier
 *   −10 open capture failure on this customer
 *   Clamped 0..100.
 */

import {
  intelligenceCardPayloadSchema,
  type IntelligenceCardClaim,
  type IntelligenceCardPayload,
  type IntelligenceCardPlay,
  type IntelligenceCardSource,
  type DocumentExtractionTyped,
  type DocumentEntityLink,
  type DocumentExtractionFinding,
  type Document,
} from "@shared/schema";
import type { IntelligenceOverlay } from "./intelligenceOverlay";
import { readExtractionLeaves } from "./intelligenceOverlay";

export const REASONER_VERSION = "intelligence-reasoner@1.0.0";

const PRIMARY_FIELDS = [
  "originCity", "destinationCity", "allInRate", "carrierName", "brokerName",
] as const;

interface FieldEntry { value: unknown; confidence: number | null }

function readField(payload: Record<string, unknown> | null, key: string): FieldEntry | null {
  if (!payload) return null;
  const f = payload[key] as { value?: unknown; confidence?: number } | undefined;
  if (!f) return null;
  return {
    value: f.value ?? null,
    confidence: typeof f.confidence === "number" ? f.confidence : null,
  };
}

function extractionFieldSource(documentId: string, fieldPath: string): IntelligenceCardSource {
  return {
    kind: "extraction_field",
    ref: `extraction.${fieldPath}`,
    label: `Extraction: ${fieldPath}`,
    href: `/copilot/documents/${documentId}`,
    updatedAt: null,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function bandFor(score: number): "strong" | "watch" | "weak" | "blocked" {
  if (score >= 75) return "strong";
  if (score >= 50) return "watch";
  if (score >= 25) return "weak";
  return "blocked";
}

function deriveAggregateConfidence(
  payload: Record<string, unknown> | null,
  overlay: IntelligenceOverlay,
): "high" | "medium" | "low" {
  // Any block finding or missing primary → low.
  if (overlay.findings.some((f) => f.finding.severity === "block")) return "low";
  if (overlay.tags.includes("ambiguous_customer") || overlay.tags.includes("ambiguous_carrier")) return "low";
  for (const k of PRIMARY_FIELDS) {
    const f = readField(payload, k);
    if (!f || f.value == null) return "low";
  }
  if (overlay.findings.some((f) => f.finding.severity === "warn")) return "medium";
  for (const k of PRIMARY_FIELDS) {
    const f = readField(payload, k);
    if (f && (f.confidence ?? 0) < 0.75) return "medium";
  }
  return "high";
}

function deriveFitScore(overlay: IntelligenceOverlay): number {
  let score = 50; // neutral baseline so a sparse but clean card lands mid-band
  if (overlay.carrier) {
    if (overlay.carrier.servesOriginState && overlay.carrier.servesDestState) {
      if (overlay.carrier.equipmentMatch) score += 30;
      else score += 25;
    } else {
      score -= 5;
    }
    if (overlay.carrier.carrier.status === "do_not_use") score -= 35;
    else if (overlay.carrier.carrier.status === "flagged") score -= 15;
  }
  if (overlay.customer && overlay.captureFailures.length === 0) score += 20;
  if (overlay.recurringLanes.length > 0) {
    const healths = overlay.recurringLanes.map((l) => l.health);
    if (!healths.some((h) => h === "leaking" || h === "volatile" || h === "hot")) score += 15;
  }
  if (overlay.freshness?.freshnessMinutes != null && overlay.freshness.freshnessMinutes <= 4 * 60) score += 10;
  if (!overlay.findings.some((f) => f.finding.severity === "warn" || f.finding.severity === "block")) score += 5;
  if (overlay.findings.some((f) => f.finding.severity === "block")) score -= 20;
  if (overlay.tags.includes("ambiguous_customer") || overlay.tags.includes("ambiguous_carrier")) score -= 15;
  if (overlay.captureFailures.length > 0) score -= 10;
  return clamp(Math.round(score), 0, 100);
}

function buildHeader(
  document: Document,
  payload: Record<string, unknown> | null,
  overlay: IntelligenceOverlay,
): IntelligenceCardPayload["header"] {
  const leaves = readExtractionLeaves(payload);
  const lane = leaves.originCity && leaves.destinationCity
    ? `${leaves.originCity}${leaves.originState ? ", " + leaves.originState : ""} → ${leaves.destinationCity}${leaves.destinationState ? ", " + leaves.destinationState : ""}`
    : null;
  return {
    title: `Fit & Intelligence — ${document.filename}`,
    subtitle: lane ? `${lane}${leaves.equipmentType ? " · " + leaves.equipmentType : ""}` : null,
    laneLabel: lane,
    customerLabel: overlay.customer?.company.name ?? null,
    carrierLabel: overlay.carrier?.carrier.name ?? null,
  };
}

function deriveClaimConfidence(
  fieldConfidences: number[],
): "high" | "medium" | "low" {
  if (fieldConfidences.length === 0) return "medium";
  const avg = fieldConfidences.reduce((a, b) => a + b, 0) / fieldConfidences.length;
  if (avg >= 0.8) return "high";
  if (avg >= 0.55) return "medium";
  return "low";
}

function buildReasons(
  documentId: string,
  payload: Record<string, unknown> | null,
  overlay: IntelligenceOverlay,
): IntelligenceCardClaim[] {
  const out: IntelligenceCardClaim[] = [];

  // R1 — carrier serves the lane.
  if (overlay.carrier && overlay.carrier.servesOriginState && overlay.carrier.servesDestState) {
    out.push({
      text: `${overlay.carrier.carrier.name} claims service in both ${overlay.carrier.carrier.statesServed?.length ?? 0} states including this origin and destination.`,
      sources: [overlay.carrier.source],
      confidence: deriveClaimConfidence([0.9]),
    });
  }

  // R2 — recurring lane present & healthy.
  if (overlay.recurringLanes.length > 0) {
    const lane = overlay.recurringLanes[0].lane;
    const healthy = overlay.recurringLanes[0].health !== "leaking"
      && overlay.recurringLanes[0].health !== "volatile"
      && overlay.recurringLanes[0].health !== "hot";
    if (healthy) {
      const cadence = lane.avgLoadsPerWeek ? `${Number(lane.avgLoadsPerWeek).toFixed(1)} loads/wk` : "active cadence";
      out.push({
        text: `Recurring lane (${cadence}) with health "${overlay.recurringLanes[0].health}".`,
        sources: [overlay.recurringLanes[0].source],
        confidence: "high",
      });
    }
  }

  // R3 — rate is within payload (informational, lets the rep see the
  // dollar figure cited from the extraction).
  const rate = readField(payload, "allInRate");
  if (rate && rate.value != null) {
    out.push({
      text: `All-in rate $${Number(rate.value).toLocaleString()} captured from the rate-con.`,
      sources: [extractionFieldSource(documentId, "allInRate")],
      confidence: deriveClaimConfidence([rate.confidence ?? 0.6]),
    });
  }

  // R4 — clean extraction (no warn/block findings)
  if (overlay.findings.length === 0) {
    out.push({
      text: "Extraction passed all inconsistency rules.",
      sources: [{
        kind: "extraction_field",
        ref: `extraction.${documentId}`,
        label: "Extraction findings: 0",
        href: `/copilot/documents/${documentId}`,
        updatedAt: null,
      }],
      confidence: "high",
    });
  }

  // R5 — customer resolved & no open capture failure.
  if (overlay.customer && overlay.captureFailures.length === 0) {
    out.push({
      text: `Customer ${overlay.customer.company.name} is resolved and has no open won-quote capture failures.`,
      sources: [overlay.customer.source],
      confidence: "high",
    });
  }

  return out.slice(0, 8);
}

function buildRisks(
  documentId: string,
  payload: Record<string, unknown> | null,
  overlay: IntelligenceOverlay,
): IntelligenceCardClaim[] {
  const out: IntelligenceCardClaim[] = [];

  for (const f of overlay.findings) {
    out.push({
      text: f.finding.message,
      sources: [f.source],
      confidence: f.finding.severity === "block" ? "high" : "medium",
    });
  }

  if (overlay.tags.includes("ambiguous_customer") && overlay.customer) {
    out.push({
      text: "Multiple customer candidates returned by entity resolver — pick the right one before acting.",
      sources: [overlay.customer.source],
      confidence: "high",
    });
  } else if (overlay.tags.includes("unknown_customer")) {
    out.push({
      text: "Customer could not be resolved from the rate-con; downstream actions will lack an account anchor.",
      sources: [extractionFieldSource(documentId, "brokerName")],
      confidence: "medium",
    });
  }

  if (overlay.tags.includes("ambiguous_carrier") && overlay.carrier) {
    out.push({
      text: "Multiple carrier candidates returned by entity resolver — confirm the correct MC# before dispatch.",
      sources: [overlay.carrier.source],
      confidence: "high",
    });
  } else if (overlay.tags.includes("unknown_carrier")) {
    out.push({
      text: "Carrier could not be matched to a CRM row from MC/DOT in this rate-con.",
      sources: [extractionFieldSource(documentId, "carrierMcNumber")],
      confidence: "medium",
    });
  }

  if (overlay.carrier && (!overlay.carrier.servesOriginState || !overlay.carrier.servesDestState)) {
    out.push({
      text: `${overlay.carrier.carrier.name} does not list ${!overlay.carrier.servesOriginState ? "origin" : "destination"} state in claimed coverage.`,
      sources: [overlay.carrier.source],
      confidence: "medium",
    });
  }

  if (overlay.captureFailures.length > 0) {
    out.push({
      text: `${overlay.captureFailures.length} open won-quote capture failure(s) for this customer — likely the same lane is leaking into spot.`,
      sources: overlay.captureFailures.slice(0, 2).map((c) => c.source),
      confidence: "medium",
    });
  }

  if (overlay.openOpportunities.length > 0) {
    out.push({
      text: `${overlay.openOpportunities.length} open opportunit${overlay.openOpportunities.length === 1 ? "y" : "ies"} already exist for this lane — risk of duplicate posting.`,
      sources: overlay.openOpportunities.slice(0, 2).map((o) => o.source),
      confidence: "medium",
    });
  }

  if (overlay.freshness?.freshnessMinutes != null && overlay.freshness.freshnessMinutes > 4 * 60) {
    out.push({
      text: `Freight signal is ${overlay.freshness.freshnessMinutes} minutes old; pricing reference may be stale.`,
      sources: [overlay.freshness.source],
      confidence: "low",
    });
  }

  return out.slice(0, 8);
}

export interface ReasonArgs {
  document: Document;
  extraction: DocumentExtractionTyped;
  links: DocumentEntityLink[];
  findings: DocumentExtractionFinding[];
  overlay: IntelligenceOverlay;
  suggestedPlays: IntelligenceCardPlay[];
}

export interface ReasonResult {
  payload: IntelligenceCardPayload;
  fitScore: number;
  aggregateConfidence: "high" | "medium" | "low";
  needsReview: boolean;
  needsReviewReason: string | null;
  /** Materialized list of every overlay/extraction source we touched. */
  sourceRecords: IntelligenceCardSource[];
}

export function reason(args: ReasonArgs): ReasonResult {
  const payload = (args.extraction.payload ?? {}) as Record<string, unknown>;
  const aggregate = deriveAggregateConfidence(payload, args.overlay);
  const fitScore = deriveFitScore(args.overlay);
  const reasons = buildReasons(args.document.id, payload, args.overlay);
  const risks = buildRisks(args.document.id, payload, args.overlay);

  // needsReview when aggregate is low OR a block finding fired OR no
  // anchor records at all.
  const blockFinding = args.overlay.findings.some((f) => f.finding.severity === "block");
  const noAnchors = !args.overlay.customer && !args.overlay.carrier && args.overlay.recurringLanes.length === 0;
  const needsReview = aggregate === "low" || blockFinding || noAnchors;
  let needsReviewReason: string | null = null;
  if (blockFinding) needsReviewReason = "block_finding";
  else if (aggregate === "low") needsReviewReason = "low_aggregate_confidence";
  else if (noAnchors) needsReviewReason = "no_anchor_records";

  // If needsReview, downgrade the card to a "needs review" card by clearing
  // reasons and keeping only the high-signal risks. The play matcher already
  // surfaces the corrective plays; we don't drop them.
  const finalReasons = needsReview ? [] : reasons;
  const finalRisks = risks.length > 0 ? risks : (needsReview ? [{
    text: needsReviewReason === "block_finding" ? "Blocking inconsistency present — resolve before acting." :
          needsReviewReason === "low_aggregate_confidence" ? "Aggregate confidence is low — verify primary fields and entity links." :
          "No customer / carrier / recurring lane could be anchored — card cannot be trusted yet.",
    sources: [extractionFieldSource(args.document.id, "originCity")],
    confidence: "low" as const,
  }] : []);

  // Filter plays — every play already carries sources but we drop any that
  // somehow came back source-less (defense in depth).
  const safePlays = args.suggestedPlays.filter((p) => p.sources.length > 0);

  const sourceRecords: IntelligenceCardSource[] = [];
  const seen = new Set<string>();
  const push = (s: IntelligenceCardSource) => {
    const key = `${s.kind}:${s.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    sourceRecords.push(s);
  };
  for (const r of [...finalReasons, ...finalRisks]) for (const s of r.sources) push(s);
  for (const p of safePlays) for (const s of p.sources) push(s);

  const cardPayload: IntelligenceCardPayload = {
    schemaVersion: "1.0.0",
    header: buildHeader(args.document, payload, args.overlay),
    fitScore,
    fitBand: bandFor(fitScore),
    aggregateConfidence: aggregate,
    reasons: finalReasons,
    risks: finalRisks,
    inconsistencyFindings: args.overlay.findings.map((f) => ({
      ruleCode: f.finding.ruleCode,
      severity: f.finding.severity as "info" | "warn" | "block",
      message: f.finding.message,
    })),
    suggestedPlays: safePlays,
    generatedAt: new Date().toISOString(),
    reasonerVersion: REASONER_VERSION,
    needsReview,
    needsReviewReason,
    edits: null,
  };

  // Validate before returning — guarantees the card honours the API contract
  // before we ever try to persist it.
  const parsed = intelligenceCardPayloadSchema.parse(cardPayload);
  return {
    payload: parsed,
    fitScore,
    aggregateConfidence: aggregate,
    needsReview,
    needsReviewReason,
    sourceRecords,
  };
}
