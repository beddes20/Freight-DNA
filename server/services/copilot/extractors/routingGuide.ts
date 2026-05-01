/**
 * Routing-guide extractor — pulls per-lane carrier bench (primary, backup,
 * tertiary, fuel handling, tender lead time). XLSX-friendly via tableRows;
 * regex sweep for PDFs.
 */
import type { DocumentPage } from "@shared/schema";
import type { FieldExtractor, ExtractorContext, ExtractorResult } from "./types";
import { findOnPages, makeField } from "./types";
import type { RoutingGuidePayload, RoutingGuideEntry } from "@shared/schema";

const LANE_KEYS_O = ["origin", "from", "lane origin"];
const LANE_KEYS_D = ["destination", "to", "lane destination"];
const EQ_KEYS = ["equipment", "trailer"];
const PRIM_KEYS = ["primary", "primary carrier", "1st", "tier 1"];
const BACK_KEYS = ["backup", "backup carrier", "2nd", "tier 2", "secondary"];
const TERT_KEYS = ["tertiary", "3rd", "tier 3"];
const FUEL_KEYS = ["fuel", "fsc", "fuel program"];
const LEAD_KEYS = ["lead time", "tender lead", "tender lead time"];

function findCol(row: Record<string, unknown>, candidates: string[]): { key: string; value: string } | null {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const k = keys.find((x) => x.trim().toLowerCase() === cand.toLowerCase()) ??
      keys.find((x) => x.trim().toLowerCase().includes(cand.toLowerCase()));
    if (k && row[k] != null && String(row[k]).trim().length > 0) {
      return { key: k, value: String(row[k]).trim() };
    }
  }
  return null;
}

function tableEntries(documentId: string, page: DocumentPage): RoutingGuideEntry[] {
  const rows = (page.tableRows ?? []) as Record<string, unknown>[];
  const out: RoutingGuideEntry[] = [];
  for (const row of rows) {
    const o = findCol(row, LANE_KEYS_O);
    const d = findCol(row, LANE_KEYS_D);
    if (!o && !d) continue;
    const cite = (key: string, value: string) =>
      makeField({
        value, confidence: "high", documentId, page: page.pageNumber, snippet: `${key}=${value}`,
      });
    const entry: RoutingGuideEntry = {};
    if (o) entry.origin = cite(o.key, o.value);
    if (d) entry.destination = cite(d.key, d.value);
    const eq = findCol(row, EQ_KEYS); if (eq) entry.equipment = cite(eq.key, eq.value);
    const pr = findCol(row, PRIM_KEYS); if (pr) entry.primary_carrier = cite(pr.key, pr.value);
    const bk = findCol(row, BACK_KEYS); if (bk) entry.backup_carrier = cite(bk.key, bk.value);
    const tr = findCol(row, TERT_KEYS); if (tr) entry.tertiary_carrier = cite(tr.key, tr.value);
    const f = findCol(row, FUEL_KEYS); if (f) entry.fuel_handling = cite(f.key, f.value);
    const l = findCol(row, LEAD_KEYS); if (l) entry.tender_lead_time = cite(l.key, l.value);
    if (entry.primary_carrier || entry.backup_carrier) {
      const okey = (o?.value ?? "").toUpperCase();
      const dkey = (d?.value ?? "").toUpperCase();
      const ekey = (eq?.value ?? "").toUpperCase();
      entry.lane_key = `${okey}|${dkey}|${ekey}`;
      out.push(entry);
    }
  }
  return out;
}

const CUST_RE = /(?:routing\s*guide\s*for|customer|account|shipper)[:\s]+([A-Z][A-Za-z0-9 &.,'\-]{2,60})/i;
const EFF_RE = /(?:effective|valid\s*from|start\s*date)[:\s]+([0-9]{1,2}[\/\-][0-9]{1,2}[\/\-][0-9]{2,4})/i;

export const routingGuideExtractor: FieldExtractor<RoutingGuidePayload> = {
  classLabel: "routing_guide",
  extractor: "routing_guide@1",
  schemaVersion: 1,
  extract(ctx: ExtractorContext): ExtractorResult<RoutingGuidePayload> {
    const { document, pages } = ctx;
    const docId = document.id;
    const payload: RoutingGuidePayload = { entries: [] };
    const warnings: string[] = [];

    const cust = findOnPages(pages, CUST_RE);
    if (cust) {
      payload.customer = makeField({
        value: cust.match[1]?.trim() ?? "", confidence: "medium",
        documentId: docId, page: cust.page, snippet: cust.snippet,
      });
    }
    const eff = findOnPages(pages, EFF_RE);
    if (eff) {
      payload.effective_date = makeField({
        value: eff.match[1]?.trim() ?? "", confidence: "high",
        documentId: docId, page: eff.page, snippet: eff.snippet,
      });
    }

    for (const p of pages) payload.entries!.push(...tableEntries(docId, p));
    if (!payload.entries!.length) warnings.push("No routing-guide rows recognized.");

    return {
      extractor: this.extractor,
      schemaVersion: this.schemaVersion,
      classLabel: this.classLabel,
      payload,
      needsHumanReview: !payload.entries!.length,
      warnings,
    };
  },
};
