/**
 * RFP bid-sheet extractor. Pulls the lane list out of XLSX / CSV uploads
 * (preferred — `documentPages.tableRows` is already structured) and falls
 * back to text regex sweeps for PDF bid sheets.
 */
import type { DocumentPage } from "@shared/schema";
import type { FieldExtractor, ExtractorContext, ExtractorResult } from "./types";
import { findOnPages, makeField } from "./types";
import type { RfpBidSheetPayload, RfpBidLane } from "@shared/schema";

const ORIGIN_KEYS = ["origin", "origin city", "origin_city", "from city", "ship from", "from"];
const ORIGIN_STATE_KEYS = ["origin state", "origin_state", "from state", "o state"];
const DEST_KEYS = ["destination", "destination city", "destination_city", "to city", "ship to", "to"];
const DEST_STATE_KEYS = ["destination state", "destination_state", "to state", "d state"];
const EQUIP_KEYS = ["equipment", "equipment type", "trailer type", "trailer", "mode"];
const VOL_KEYS = ["volume", "annual volume", "loads", "loads/year", "loads_per_year", "frequency"];
const RATE_KEYS = ["incumbent rate", "current rate", "current_rate", "linehaul", "incumbent", "rate"];
const RESPONSE_KEYS = ["proposed rate", "your rate", "bid", "response", "your response", "all in"];

function findCol(row: Record<string, unknown>, candidates: string[]): { key: string; value: string } | null {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const k = keys.find((x) => x.trim().toLowerCase() === cand.toLowerCase());
    if (k && row[k] != null && String(row[k]).trim().length > 0) {
      return { key: k, value: String(row[k]).trim() };
    }
  }
  // Substring fallback.
  for (const cand of candidates) {
    const k = keys.find((x) => x.trim().toLowerCase().includes(cand.toLowerCase()));
    if (k && row[k] != null && String(row[k]).trim().length > 0) {
      return { key: k, value: String(row[k]).trim() };
    }
  }
  return null;
}

function extractFromTableRows(
  documentId: string,
  page: DocumentPage,
): RfpBidLane[] {
  const rows = (page.tableRows ?? []) as Record<string, unknown>[];
  const lanes: RfpBidLane[] = [];
  for (const row of rows) {
    const o = findCol(row, ORIGIN_KEYS);
    const d = findCol(row, DEST_KEYS);
    if (!o && !d) continue;
    const lane: RfpBidLane = {};
    const cite = (key: string, value: string) =>
      makeField({
        value,
        confidence: "high",
        documentId,
        page: page.pageNumber,
        snippet: `${key}=${value}`,
      });
    if (o) lane.origin_city = cite(o.key, o.value);
    const os = findCol(row, ORIGIN_STATE_KEYS);
    if (os) lane.origin_state = cite(os.key, os.value);
    if (d) lane.destination_city = cite(d.key, d.value);
    const ds = findCol(row, DEST_STATE_KEYS);
    if (ds) lane.destination_state = cite(ds.key, ds.value);
    const eq = findCol(row, EQUIP_KEYS);
    if (eq) lane.equipment = cite(eq.key, eq.value);
    const vol = findCol(row, VOL_KEYS);
    if (vol) lane.projected_volume = cite(vol.key, vol.value);
    const rate = findCol(row, RATE_KEYS);
    if (rate) lane.incumbent_rate = cite(rate.key, rate.value);
    const resp = findCol(row, RESPONSE_KEYS);
    if (resp) lane.requested_rate_field = cite(resp.key, resp.value);
    if (lane.origin_city || lane.destination_city) lanes.push(lane);
  }
  return lanes;
}

const DUE_RE = /(?:due|response\s*due|bid\s*due|rfq\s*due)\s*(?:date|by)?[:\s]+([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i;
const CUST_RE = /(?:rfp\s*from|customer|company|account|issued\s*by)[:\s]+([A-Z][A-Za-z0-9 &.,'\-]{2,60})/i;

export const rfpBidSheetExtractor: FieldExtractor<RfpBidSheetPayload> = {
  classLabel: "rfp_bid_sheet",
  extractor: "rfp_bid_sheet@1",
  schemaVersion: 1,
  extract(ctx: ExtractorContext): ExtractorResult<RfpBidSheetPayload> {
    const { document, pages } = ctx;
    const docId = document.id;
    const warnings: string[] = [];
    const payload: RfpBidSheetPayload = { lanes: [] };

    // Header fields from page text.
    const cust = findOnPages(pages, CUST_RE);
    if (cust) {
      payload.customer = makeField({
        value: cust.match[1]?.trim() ?? "",
        confidence: "medium",
        documentId: docId,
        page: cust.page,
        snippet: cust.snippet,
      });
    }
    const due = findOnPages(pages, DUE_RE);
    if (due) {
      payload.due_date = makeField({
        value: due.match[1]?.trim() ?? "",
        confidence: "high",
        documentId: docId,
        page: due.page,
        snippet: due.snippet,
      });
    }

    // Lane list — prefer table rows.
    for (const p of pages) {
      const lanes = extractFromTableRows(docId, p);
      if (lanes.length) payload.lanes!.push(...lanes);
    }
    if (!payload.lanes!.length) warnings.push("No lane rows recognized — likely a PDF scan; flagging for review.");

    return {
      extractor: this.extractor,
      schemaVersion: this.schemaVersion,
      classLabel: this.classLabel,
      payload,
      needsHumanReview: !payload.lanes!.length,
      warnings,
    };
  },
};
