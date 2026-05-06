/**
 * Rate confirmation extractor — Task #926 step 2.
 *
 * Targets the fields the rep needs to make a pursue/pass decision:
 * customer, MC#, origin, destination, equipment, pickup/delivery windows,
 * line-haul rate, accessorials, reference numbers. Regex-first, deterministic.
 * Anything the regex pack can't pin down lands as `needs_review` — never a
 * silent guess.
 */
import type { FieldExtractor, ExtractorContext, ExtractorResult } from "./types";
import { findOnPages, makeField } from "./types";
import type { RateConPayload } from "@shared/schema";

const MC_RE = /\bMC[-#:\s]*?(\d{4,8})\b/i;
const DOT_RE = /\bDOT[-#:\s]*?(\d{5,8})\b/i;
const RATE_RE = /(?:line[\s-]*haul|total\s*rate|all[\s-]*in|rate\s*amount)[^\n$]{0,40}\$?\s*([\d,]+(?:\.\d{2})?)/i;
const PICKUP_RE = /(?:pick[\s-]*up|pu)\s*(?:date|time|window|appt)?[:\s]+([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}(?:[\sT][0-9:apm\s\-]+)?)/i;
const DELIVERY_RE = /(?:delivery|drop|del)\s*(?:date|time|window|appt)?[:\s]+([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4}(?:[\sT][0-9:apm\s\-]+)?)/i;
const ORIGIN_RE = /(?:origin|shipper|pickup\s+location|from)[:\s]+([A-Z][A-Za-z .'\-]+,\s*[A-Z]{2}\b(?:\s*\d{5})?)/i;
const DEST_RE = /(?:destination|consignee|delivery\s+location|to)[:\s]+([A-Z][A-Za-z .'\-]+,\s*[A-Z]{2}\b(?:\s*\d{5})?)/i;
const EQUIP_RE = /(?:equipment|trailer\s*type|equip)[:\s]+(\b(?:53'\s*van|dry\s*van|reefer|flatbed|step\s*deck|power\s*only|conestoga|rgn|hot\s*shot|sprinter|cargo\s*van)\b)/i;
const REF_RE = /(?:reference|ref|po|bol|load|pro)\s*#?\s*[:\s]+([A-Z0-9\-]{4,})/i;
const ACC_RE = /(?:accessorial|detention|layover|tonu|fuel\s*surcharge|lumper)[s]?[:\s]+([^\n]{3,80})/i;
const CUST_RE = /(?:bill[\s-]*to|customer|broker|account)[:\s]+([A-Z][A-Za-z0-9 &.,'\-]{2,60})/i;

export const rateConExtractor: FieldExtractor<RateConPayload> = {
  classLabel: "rate_con",
  extractor: "rate_con@1",
  schemaVersion: 1,
  extract(ctx: ExtractorContext): ExtractorResult<RateConPayload> {
    const { document, pages } = ctx;
    const docId = document.id;
    const warnings: string[] = [];
    const payload: RateConPayload = {};
    let unmatched = 0;

    const pull = (re: RegExp, key: keyof RateConPayload, conf: "high" | "medium" | "low" = "high") => {
      const hit = findOnPages(pages, re);
      if (hit) {
        const value = hit.match[1]?.trim() ?? hit.match[0].trim();
        payload[key] = makeField({
          value,
          confidence: conf,
          documentId: docId,
          page: hit.page,
          snippet: hit.snippet,
        });
      } else {
        unmatched++;
        warnings.push(`Could not locate ${String(key)} via regex pack.`);
      }
    };

    pull(CUST_RE, "customer", "medium");
    pull(MC_RE, "mc_number", "high");
    pull(ORIGIN_RE, "origin", "high");
    pull(DEST_RE, "destination", "high");
    pull(EQUIP_RE, "equipment", "high");
    pull(PICKUP_RE, "pickup_window", "high");
    pull(DELIVERY_RE, "delivery_window", "high");
    pull(RATE_RE, "rate", "high");
    pull(REF_RE, "reference_numbers", "medium");
    pull(ACC_RE, "accessorials", "medium");

    // DOT as a backup for MC.
    if (!payload.mc_number) {
      const dot = findOnPages(pages, DOT_RE);
      if (dot) {
        payload.mc_number = makeField({
          value: `DOT ${dot.match[1]}`,
          confidence: "medium",
          documentId: docId,
          page: dot.page,
          snippet: dot.snippet,
          needs_review: true,
        });
      }
    }

    // Heuristic: if neither rate nor lane fields landed at all, the doc is
    // likely a scanned image with poor OCR — flag for review explicitly.
    const needsHumanReview =
      unmatched >= 6 || (!payload.rate && !payload.origin && !payload.destination);

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
