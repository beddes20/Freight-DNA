/**
 * Task #911 — End-to-end rate-con pipeline.
 *
 * One entry point that sequences extract → resolve entities → run
 * inconsistency rules → set extractionStatus. Used by:
 *   - the auto-queue worker (after slice 1 ingest finishes parsing),
 *   - the admin "Force extract" route, and
 *   - the eval harness in tests.
 *
 * Each step is independently re-runnable; this module just wires them
 * together in the canonical order.
 */
import { storage } from "../storage";
import OpenAI from "openai";
import { extractRateCon } from "./rateConExtractor";
import { resolveRateConEntities } from "./documentEntityResolver";
import { runRateConInconsistencyRules } from "./rateConInconsistencyRules";
import type {
  RateConExtraction,
  DocumentExtractionTyped,
  DocumentEntityLink,
  InsertDocumentExtractionFinding,
  DocumentPage,
} from "@shared/schema";

export interface RunRateConPipelineArgs {
  documentId: string;
  organizationId: string;
  openaiOverride?: OpenAI;
  pagesOverride?: DocumentPage[];
  payloadOverride?: RateConExtraction;
  force?: boolean;
}

export interface RunRateConPipelineResult {
  status: "extracted" | "needs_review" | "failed" | "skipped";
  reason: string | null;
  extraction: DocumentExtractionTyped | null;
  payload: RateConExtraction | null;
  links: DocumentEntityLink[];
  findings: InsertDocumentExtractionFinding[];
}

export async function runRateConPipeline(args: RunRateConPipelineArgs): Promise<RunRateConPipelineResult> {
  const extracted = await extractRateCon({
    documentId: args.documentId,
    organizationId: args.organizationId,
    openaiOverride: args.openaiOverride,
    pagesOverride: args.pagesOverride,
    payloadOverride: args.payloadOverride,
    force: args.force,
  });

  if (extracted.status === "failed" || extracted.status === "skipped") {
    return {
      status: extracted.status,
      reason: extracted.reason,
      extraction: extracted.extraction,
      payload: extracted.payload,
      links: [],
      findings: [],
    };
  }
  if (!extracted.payload || !extracted.extraction) {
    return {
      status: "failed",
      reason: "extractor_returned_no_payload",
      extraction: extracted.extraction,
      payload: null,
      links: [],
      findings: [],
    };
  }

  const resolution = await resolveRateConEntities({
    documentId: args.documentId,
    organizationId: args.organizationId,
    payload: extracted.payload,
  });

  // Re-fetch the persisted links so downstream rules see the same shape
  // the API + UI will see (with generated ids + matchScore decimals).
  const links = await storage.getDocumentEntityLinks(args.documentId);

  const findings = await runRateConInconsistencyRules({
    documentId: args.documentId,
    organizationId: args.organizationId,
    payload: extracted.payload,
    links,
  });

  // Determine final status. needs_review if entity resolution flagged an
  // ambiguity OR a `block` finding fired. Otherwise extracted.
  const blocked = findings.some((f) => f.severity === "block");
  let finalStatus: "extracted" | "needs_review" = "extracted";
  let reason: string | null = null;
  if (resolution.needsReview) {
    finalStatus = "needs_review";
    reason = `ambiguous_match:${resolution.ambiguousKinds.join(",")}`;
  } else if (blocked) {
    finalStatus = "needs_review";
    reason = `block_finding:${findings.find((f) => f.severity === "block")?.ruleCode ?? "unknown"}`;
  }
  if (finalStatus !== "extracted") {
    await storage.setDocumentExtractionStatus(args.documentId, args.organizationId, finalStatus, reason);
  }

  return {
    status: finalStatus,
    reason,
    extraction: extracted.extraction,
    payload: extracted.payload,
    links,
    findings,
  };
}
