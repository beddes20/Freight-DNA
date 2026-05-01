/**
 * Contract extractor — headline economics only. Anything our regex pack
 * doesn't recognize is captured under `unrecognized_clauses` so a human can
 * review instead of the model hallucinating a clause.
 */
import type { FieldExtractor, ExtractorContext, ExtractorResult } from "./types";
import { findOnPages, makeField } from "./types";
import type { ContractPayload, FieldCitation } from "@shared/schema";

const CUST_RE = /(?:between|customer|shipper|account)\s+([A-Z][A-Za-z0-9 &.,'\-]{2,60}?)\s+(?:and|inc\.|llc|co\.|hereinafter)/i;
const CUST_LABEL_RE = /(?:^|\n)\s*(?:customer|shipper|account|client)\s*:\s*([A-Z][A-Za-z0-9 &.,'\-]{2,60})/i;
const EFF_RE = /(?:effective\s*(?:date)?|commencing|start\s*date)\s*[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|[A-Z][a-z]+\s+\d{1,2},\s*\d{4})/i;
const TERM_RE = /(?:term|duration|period)\s*(?:of)?\s*[:\s]+(\d{1,3})\s*(?:months?|years?)/i;
const FUEL_RE = /(?:fuel\s*program|fuel\s*surcharge|fsc|fuel\s*table)\s*[:\s]+([^\n]{5,120})/i;
const ACC_REF_RE = /(?:accessorial(?:\s*schedule|\s*table)?|attachment\s*[A-Z])\s*[:\s]+([^\n]{3,80})/i;
const MFN_RE = /\b(?:most[\s-]*favored[\s-]*nation|mfn|favored\s*pricing)\b/i;

const CLAUSE_HEADERS = /^\s*(\d+(?:\.\d+)*)\s+([A-Z][A-Za-z .,'\-/]{2,60})\s*[\.\:]/gm;
const KNOWN_HEADERS = /(term|payment|fuel|accessorial|insurance|liability|indemn|claims?|definitions|recital|signature|notice|confidential|term\s*and\s*termination|exhibits?|schedule|appendix|jurisdiction|governing\s*law)/i;

export const contractExtractor: FieldExtractor<ContractPayload> = {
  classLabel: "contract",
  extractor: "contract@1",
  schemaVersion: 1,
  extract(ctx: ExtractorContext): ExtractorResult<ContractPayload> {
    const { document, pages } = ctx;
    const docId = document.id;
    const warnings: string[] = [];
    const payload: ContractPayload = { unrecognized_clauses: [] };

    const cust = findOnPages(pages, CUST_RE) ?? findOnPages(pages, CUST_LABEL_RE);
    if (cust) {
      payload.customer = makeField({
        value: cust.match[1]?.trim() ?? "", confidence: "medium",
        documentId: docId, page: cust.page, snippet: cust.snippet,
      });
    }
    const eff = findOnPages(pages, EFF_RE);
    if (eff) {
      payload.effective_date = makeField({
        value: eff.match[1] ?? "", confidence: "high",
        documentId: docId, page: eff.page, snippet: eff.snippet,
      });
    }
    const term = findOnPages(pages, TERM_RE);
    if (term) {
      payload.term_months = makeField({
        value: term.match[0]?.trim() ?? "", confidence: "high",
        documentId: docId, page: term.page, snippet: term.snippet,
      });
    }
    const fuel = findOnPages(pages, FUEL_RE);
    if (fuel) {
      payload.fuel_program = makeField({
        value: fuel.match[1]?.trim() ?? "", confidence: "medium",
        documentId: docId, page: fuel.page, snippet: fuel.snippet,
      });
    }
    const acc = findOnPages(pages, ACC_REF_RE);
    if (acc) {
      payload.accessorial_schedule_ref = makeField({
        value: acc.match[1]?.trim() ?? "", confidence: "medium",
        documentId: docId, page: acc.page, snippet: acc.snippet,
      });
    }
    const mfn = findOnPages(pages, MFN_RE);
    if (mfn) {
      payload.mfn_clause = makeField({
        value: mfn.match[0]?.trim() ?? "", confidence: "medium",
        documentId: docId, page: mfn.page, snippet: mfn.snippet,
      });
    }

    // Sweep clause headers — anything not in KNOWN_HEADERS is human-review.
    for (const p of pages) {
      const text = (p.text ?? "").toString();
      if (!text) continue;
      const re = new RegExp(CLAUSE_HEADERS.source, "gm");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const header = m[2];
        if (!KNOWN_HEADERS.test(header)) {
          const citation: FieldCitation = {
            documentId: docId,
            page: p.pageNumber,
            snippet: text.slice(Math.max(0, m.index - 20), Math.min(text.length, m.index + 100)).replace(/\s+/g, " ").trim(),
          };
          payload.unrecognized_clauses!.push({ text: `${m[1]} ${header}`, citation });
        }
      }
    }

    const needsHumanReview =
      payload.unrecognized_clauses!.length > 0 || (!payload.fuel_program && !payload.term_months);
    if (needsHumanReview) warnings.push("Contract has unrecognized clauses or missing economics — flagging.");

    return {
      extractor: this.extractor,
      schemaVersion: this.schemaVersion,
      classLabel: this.classLabel,
      payload,
      needsHumanReview,
      warnings,
    };
  },
};
