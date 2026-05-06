/**
 * BOL extractor — stops, references, weight, commodity, signed-by, special
 * instructions. Image-heavy in real life; relies on OCR pages from #910.
 */
import type { FieldExtractor, ExtractorContext, ExtractorResult } from "./types";
import { findOnPages, makeField } from "./types";
import type { BolPayload } from "@shared/schema";

const SHIPPER_RE = /(?:shipper|ship\s*from|origin)[:\s]+([A-Z][A-Za-z0-9 &.,'\-]{2,80})/i;
const CONSIGNEE_RE = /(?:consignee|ship\s*to|destination)[:\s]+([A-Z][A-Za-z0-9 &.,'\-]{2,80})/i;
const REF_RE = /(?:bol|pro|po|reference|ref)\s*#?\s*[:\s]+([A-Z0-9\-]{4,})/i;
const WEIGHT_RE = /\b(?:total|gross)?\s*weight\s*[:\s]+([\d,]+\s*(?:lbs?|kg)?)/i;
const COMM_RE = /(?:commodity|description\s*of\s*goods)[:\s]+([^\n]{3,80})/i;
const SIGN_RE = /(?:signed\s*by|signature|driver\s*signature)[:\s]+([A-Z][A-Za-z .'\-]{2,60})/i;
const INSTR_RE = /(?:special\s*instructions|notes|remarks)[:\s]+([^\n]{3,120})/i;

export const bolExtractor: FieldExtractor<BolPayload> = {
  classLabel: "bol",
  extractor: "bol@1",
  schemaVersion: 1,
  extract(ctx: ExtractorContext): ExtractorResult<BolPayload> {
    const { document, pages } = ctx;
    const docId = document.id;
    const warnings: string[] = [];
    const payload: BolPayload = { stops: [] };
    let unmatched = 0;

    const pull = (re: RegExp, key: keyof BolPayload, conf: "high" | "medium" | "low" = "medium") => {
      const hit = findOnPages(pages, re);
      if (hit) {
        // @ts-expect-error narrowing through dynamic key
        payload[key] = makeField({
          value: hit.match[1]?.trim() ?? "",
          confidence: conf,
          documentId: docId,
          page: hit.page,
          snippet: hit.snippet,
        });
      } else {
        unmatched++;
      }
    };

    pull(SHIPPER_RE, "shipper", "high");
    pull(CONSIGNEE_RE, "consignee", "high");
    pull(REF_RE, "reference_numbers", "high");
    pull(WEIGHT_RE, "weight", "high");
    pull(COMM_RE, "commodity", "medium");
    pull(SIGN_RE, "signed_by", "medium");
    pull(INSTR_RE, "special_instructions", "low");

    if (payload.shipper?.value) {
      payload.stops!.push({
        sequence: 1,
        type: "pickup",
        location: payload.shipper,
      });
    }
    if (payload.consignee?.value) {
      payload.stops!.push({
        sequence: payload.stops!.length + 1,
        type: "delivery",
        location: payload.consignee,
      });
    }

    return {
      extractor: this.extractor,
      schemaVersion: this.schemaVersion,
      classLabel: this.classLabel,
      payload,
      needsHumanReview: unmatched >= 5 || (!payload.shipper && !payload.consignee),
      warnings,
    };
  },
};
