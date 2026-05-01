/**
 * Carrier scorecard extractor — pulls metric grid (on-time %, tender
 * acceptance %, claim %, etc.) per carrier or per lane plus the period
 * the report covers.
 */
import type { DocumentPage } from "@shared/schema";
import type { FieldExtractor, ExtractorContext, ExtractorResult } from "./types";
import { findOnPages, makeField } from "./types";
import type { ScorecardPayload, ScorecardMetric } from "@shared/schema";

const PERIOD_RE = /(?:period|reporting\s*period|covering)[:\s]+([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})\s*(?:to|–|-)\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4})/i;

const METRIC_KEYS: Array<{ key: string; aliases: string[] }> = [
  { key: "on_time_pct", aliases: ["on time", "on-time", "otp", "on time %"] },
  { key: "tender_accept_pct", aliases: ["tender acceptance", "tender accept", "ta %"] },
  { key: "claim_pct", aliases: ["claim", "claim %", "claims"] },
  { key: "billing_accuracy_pct", aliases: ["billing accuracy", "billing %"] },
  { key: "average_pickup_minutes", aliases: ["pickup minutes", "avg pickup time"] },
];

function pickMetric(row: Record<string, unknown>, aliases: string[]): { key: string; value: string } | null {
  const keys = Object.keys(row);
  for (const a of aliases) {
    const k = keys.find((x) => x.trim().toLowerCase() === a.toLowerCase()) ??
      keys.find((x) => x.trim().toLowerCase().includes(a.toLowerCase()));
    if (k && row[k] != null && String(row[k]).trim().length > 0) {
      return { key: k, value: String(row[k]).trim() };
    }
  }
  return null;
}

function tableMetrics(documentId: string, page: DocumentPage): ScorecardMetric[] {
  const rows = (page.tableRows ?? []) as Record<string, unknown>[];
  const out: ScorecardMetric[] = [];
  for (const row of rows) {
    const carrier = (() => {
      const k = Object.keys(row).find((x) => /carrier|name|lane/i.test(x));
      return k ? String(row[k] ?? "").trim() : "";
    })();
    for (const def of METRIC_KEYS) {
      const m = pickMetric(row, def.aliases);
      if (!m) continue;
      out.push({
        metric: def.key,
        value: makeField({
          value: m.value,
          confidence: "high",
          documentId,
          page: page.pageNumber,
          snippet: `${m.key}=${m.value}`,
        }),
        carrier_or_lane: carrier || undefined,
      });
    }
  }
  return out;
}

export const scorecardExtractor: FieldExtractor<ScorecardPayload> = {
  classLabel: "scorecard",
  extractor: "scorecard@1",
  schemaVersion: 1,
  extract(ctx: ExtractorContext): ExtractorResult<ScorecardPayload> {
    const { document, pages } = ctx;
    const docId = document.id;
    const warnings: string[] = [];
    const payload: ScorecardPayload = { metrics: [] };

    const period = findOnPages(pages, PERIOD_RE);
    if (period) {
      payload.period_start = makeField({
        value: period.match[1] ?? "", confidence: "high",
        documentId: docId, page: period.page, snippet: period.snippet,
      });
      payload.period_end = makeField({
        value: period.match[2] ?? "", confidence: "high",
        documentId: docId, page: period.page, snippet: period.snippet,
      });
    }

    for (const p of pages) payload.metrics!.push(...tableMetrics(docId, p));

    // PDF text fallback — sniff a single OTP value if the table path failed.
    if (!payload.metrics!.length) {
      const otp = findOnPages(pages, /(?:on[\s-]*time|otp)[^0-9%]{0,15}([0-9]{1,3}(?:\.\d+)?\s*%)/i);
      if (otp) {
        payload.metrics!.push({
          metric: "on_time_pct",
          value: makeField({
            value: otp.match[1]?.trim() ?? "",
            confidence: "medium",
            documentId: docId,
            page: otp.page,
            snippet: otp.snippet,
          }),
        });
      }
    }
    if (!payload.metrics!.length) warnings.push("No scorecard metrics recognized.");

    return {
      extractor: this.extractor,
      schemaVersion: this.schemaVersion,
      classLabel: this.classLabel,
      payload,
      needsHumanReview: !payload.metrics!.length,
      warnings,
    };
  },
};
