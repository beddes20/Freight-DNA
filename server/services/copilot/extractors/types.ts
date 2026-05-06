/**
 * Shared types for per-class document field extractors. Every extractor
 * accepts the parsed document + its pages and returns a typed payload
 * with `{ value, confidence, citation }` per field.
 *
 * The dispatcher (`copilotExtractionEngine.ts`) routes by `document.classLabel`.
 */
import type { Document, DocumentPage, FieldCitation, ExtractedField } from "@shared/schema";

export interface ExtractorContext {
  document: Document;
  pages: DocumentPage[];
}

export interface ExtractorResult<TPayload = unknown> {
  extractor: string;          // e.g. 'rate_con@1'
  schemaVersion: number;      // matches the suffix above
  classLabel: string;         // 'rate_con' | 'rfp_bid_sheet' | ...
  payload: TPayload;
  needsHumanReview: boolean;  // any field that the regex pack couldn't match
  warnings: string[];
}

export interface FieldExtractor<TPayload = unknown> {
  classLabel: string;
  extractor: string;
  schemaVersion: number;
  extract(ctx: ExtractorContext): ExtractorResult<TPayload>;
}

// Helper — build an `ExtractedField` with a citation pointing at the page
// where the regex hit. `match.index` is the offset inside `pageText`.
export function makeField(args: {
  value: ExtractedField["value"];
  confidence: ExtractedField["confidence"];
  documentId: string;
  page: number;
  snippet?: string;
  needs_review?: boolean;
}): ExtractedField {
  const citation: FieldCitation = {
    documentId: args.documentId,
    page: args.page,
    snippet: args.snippet?.slice(0, 280),
  };
  return {
    value: args.value,
    confidence: args.confidence,
    citation,
    needs_review: args.needs_review,
  };
}

/**
 * Find the page that contains a regex hit and return the snippet around it.
 * Returns `null` when the pattern doesn't match any page text.
 */
export function findOnPages(
  pages: DocumentPage[],
  pattern: RegExp,
): { page: number; snippet: string; match: RegExpExecArray } | null {
  for (const p of pages) {
    const txt = (p.text ?? "").toString();
    if (!txt) continue;
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    const m = re.exec(txt);
    if (m) {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(txt.length, m.index + m[0].length + 60);
      return { page: p.pageNumber, snippet: txt.slice(start, end).replace(/\s+/g, " ").trim(), match: m };
    }
  }
  return null;
}
