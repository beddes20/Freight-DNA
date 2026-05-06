/**
 * Per-class extractor registry — Task #926 step 2.
 *
 * Add a new class by writing a `FieldExtractor` and registering it here.
 * Anything not in this map skips extraction (text-only — still searchable).
 */
import type { FieldExtractor } from "./types";
import { rateConExtractor } from "./rateCon";
import { rfpBidSheetExtractor } from "./rfpBidSheet";
import { routingGuideExtractor } from "./routingGuide";
import { bolExtractor } from "./bol";
import { scorecardExtractor } from "./scorecard";
import { contractExtractor } from "./contract";

export const EXTRACTOR_REGISTRY: Record<string, FieldExtractor> = {
  rate_con: rateConExtractor,
  rfp_bid_sheet: rfpBidSheetExtractor,
  routing_guide: routingGuideExtractor,
  bol: bolExtractor,
  scorecard: scorecardExtractor,
  contract: contractExtractor,
};

export function extractorForClass(classLabel: string): FieldExtractor | null {
  return EXTRACTOR_REGISTRY[classLabel] ?? null;
}

export function supportedExtractorClasses(): string[] {
  return Object.keys(EXTRACTOR_REGISTRY);
}
