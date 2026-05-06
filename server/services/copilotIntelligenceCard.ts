/**
 * Task #912 — Generator entry point.
 *
 * Top-level orchestration: load extraction + links + findings, build the
 * intelligence overlay, run the play matcher, hand both to the reasoner,
 * and persist the result. Used by:
 *   - rateConPipeline (fire-and-forget after `extracted` status),
 *   - the admin "regenerate card" route, and
 *   - tests / eval harness.
 */

import { storage } from "../storage";
import { buildIntelligenceOverlay } from "./intelligenceOverlay";
import { matchPlays } from "./playMatcher";
import { reason } from "./intelligenceReasoner";
import type { CopilotRecommendation, Document } from "@shared/schema";

export interface GenerateIntelligenceCardArgs {
  documentId: string;
  organizationId: string;
  generatedByUserId?: string | null;
  /** Agent ID for the play matcher. Optional — when omitted only
   *  deterministic rules fire. */
  agentId?: string | null;
}

export interface GenerateIntelligenceCardResult {
  status: "persisted" | "skipped";
  reason: string | null;
  recommendation: CopilotRecommendation | null;
}

export async function generateAndPersistIntelligenceCard(
  args: GenerateIntelligenceCardArgs,
): Promise<GenerateIntelligenceCardResult> {
  const document = await storage.getDocumentInOrg(args.documentId, args.organizationId);
  if (!document) return { status: "skipped", reason: "document_not_found", recommendation: null };

  const extraction = await storage.getDocumentExtraction(args.documentId);
  if (!extraction) return { status: "skipped", reason: "no_extraction", recommendation: null };
  if (extraction.extractionStatus === "failed") {
    return { status: "skipped", reason: "extraction_failed", recommendation: null };
  }

  const [links, findings] = await Promise.all([
    storage.getDocumentEntityLinks(args.documentId),
    storage.getDocumentExtractionFindings(args.documentId),
  ]);

  const overlay = await buildIntelligenceOverlay({
    organizationId: args.organizationId,
    payload: (extraction.payload ?? null) as Record<string, unknown> | null,
    links,
    findings,
  });

  const suggestedPlays = await matchPlays({ agentId: args.agentId ?? null, overlay });

  const result = reason({
    document,
    extraction,
    links,
    findings,
    overlay,
    suggestedPlays,
  });

  const customerCompanyId = overlay.customer?.company.id ?? null;
  const carrierId = overlay.carrier?.carrier.id ?? null;
  const opportunityId = overlay.openOpportunities[0]?.opportunity.id ?? null;

  const recommendation = await storage.createCopilotRecommendation({
    orgId: args.organizationId,
    sourceDocumentId: args.documentId,
    sourceKind: documentSourceKind(document),
    customerCompanyId,
    carrierId,
    opportunityId,
    laneSignature: overlay.laneSignature,
    cardPayload: result.payload,
    suggestedPlays,
    sourceRecords: result.sourceRecords,
    aggregateConfidence: result.aggregateConfidence,
    fitScore: result.fitScore,
    generatedByUserId: args.generatedByUserId ?? null,
    reaction: "pending",
    reactionReason: null,
    reactedByUserId: null,
    downstreamOutcome: null,
  });

  return { status: "persisted", reason: null, recommendation };
}

function documentSourceKind(doc: Document): "rate_con" | "bol" | "rfp_bid_sheet" | "routing_guide" | "scorecard" | "tariff" | "accessorial_schedule" | "contract" | "spreadsheet_lanes" | "email_thread" | "manual" {
  const allowed = new Set([
    "rate_con", "bol", "rfp_bid_sheet", "routing_guide", "scorecard",
    "tariff", "accessorial_schedule", "contract", "spreadsheet_lanes", "email_thread",
  ]);
  if (allowed.has(doc.classLabel)) return doc.classLabel as never;
  return "manual";
}
