/**
 * Task #911 — Rate-Con Inconsistency Rules.
 *
 * Each rule is a small typed function that takes the typed extraction +
 * the resolved entity links + the storage interface and emits zero or
 * more findings. Findings are persisted via
 * `storage.replaceDocumentExtractionFindings` so they are atomically
 * refreshed on every extractor re-run.
 *
 * Severities:
 *   info  — informational (no quote on file, no tariff, no comparable load)
 *   warn  — material discrepancy worth a rep glance (rate diff, accessorial off)
 *   block — should not auto-act (carrier off-bench, MC# unknown, pay-slow flag)
 */
import { db, storage } from "../storage";
import { and, eq } from "drizzle-orm";
import {
  carriers,
  quoteOpportunities,
  loadFact,
  freightOpportunities,
  type RateConExtraction,
  type DocumentEntityLink,
  type InsertDocumentExtractionFinding,
  type FindingSeverity,
} from "@shared/schema";

const RATE_DIFF_WARN_PCT = 0.05;
const RATE_DIFF_BLOCK_PCT = 0.15;
const STANDARD_PAY_DAYS = 30;

interface RuleContext {
  organizationId: string;
  payload: RateConExtraction;
  links: DocumentEntityLink[];
}

interface RuleResult {
  ruleCode: string;
  severity: FindingSeverity;
  message: string;
  context: Record<string, unknown> | null;
}

type Rule = (ctx: RuleContext) => Promise<RuleResult[]>;

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

export async function runRateConInconsistencyRules(args: {
  documentId: string;
  organizationId: string;
  payload: RateConExtraction;
  links: DocumentEntityLink[];
  /** When false, returns findings but does not write them. Default: true. */
  persist?: boolean;
}): Promise<InsertDocumentExtractionFinding[]> {
  const ctx: RuleContext = {
    organizationId: args.organizationId,
    payload: args.payload,
    links: args.links,
  };
  // Run all rules in parallel — each is a small read.
  const ruleResults = await Promise.all(RULES.map(async (r) => {
    try {
      return await r(ctx);
    } catch (err) {
      console.warn("[rateConInconsistencyRules] rule failed:", err);
      return [];
    }
  }));
  const flattened = ruleResults.flat();
  const findings: InsertDocumentExtractionFinding[] = flattened.map((f) => ({
    documentId: args.documentId,
    organizationId: args.organizationId,
    ruleCode: f.ruleCode,
    severity: f.severity,
    message: f.message,
    context: f.context,
  }));
  if (args.persist !== false) {
    await storage.replaceDocumentExtractionFindings(args.documentId, args.organizationId, findings);
  }
  return findings;
}

// ──────────────────────────────────────────────────────────────────────
// Individual rules
// ──────────────────────────────────────────────────────────────────────

const ruleRateVsLastQuote: Rule = async (ctx) => {
  const rate = ctx.payload.allInRate.value;
  if (rate == null) return [];
  const quoteLink = ctx.links.find((l) => l.kind === "quote" && l.isPrimary);
  if (!quoteLink) return [];
  const [quote] = await db.select().from(quoteOpportunities)
    .where(and(eq(quoteOpportunities.organizationId, ctx.organizationId), eq(quoteOpportunities.id, quoteLink.targetId))).limit(1);
  if (!quote || quote.quotedAmount == null) return [];
  const quoted = Number(quote.quotedAmount);
  if (!Number.isFinite(quoted) || quoted <= 0) return [];
  const diffPct = Math.abs(rate - quoted) / quoted;
  if (diffPct < RATE_DIFF_WARN_PCT) return [];
  const direction = rate > quoted ? "above" : "below";
  const severity: FindingSeverity = diffPct >= RATE_DIFF_BLOCK_PCT ? "block" : "warn";
  return [{
    ruleCode: "rate_vs_last_quote",
    severity,
    message: `Rate $${rate.toLocaleString()} is ${(diffPct * 100).toFixed(1)}% ${direction} our last quote ($${quoted.toLocaleString()}, ${quote.outcomeStatus}).`,
    context: { rate, quoted, diffPct, quoteId: quote.id, quoteStatus: quote.outcomeStatus },
  }];
};

const ruleRateVsAward: Rule = async (ctx) => {
  const rate = ctx.payload.allInRate.value;
  if (rate == null) return [];
  const loadLink = ctx.links.find((l) => l.kind === "load" && l.isPrimary);
  if (!loadLink) return [];
  const [load] = await db.select().from(loadFact)
    .where(and(eq(loadFact.orgId, ctx.organizationId), eq(loadFact.id, loadLink.targetId))).limit(1);
  if (!load || load.revenue == null) return [];
  const awarded = Number(load.revenue);
  if (!Number.isFinite(awarded) || awarded <= 0) return [];
  const diffPct = Math.abs(rate - awarded) / awarded;
  if (diffPct < RATE_DIFF_WARN_PCT) return [];
  const direction = rate > awarded ? "above" : "below";
  const severity: FindingSeverity = diffPct >= RATE_DIFF_BLOCK_PCT ? "block" : "warn";
  return [{
    ruleCode: "rate_vs_award",
    severity,
    message: `Rate $${rate.toLocaleString()} is ${(diffPct * 100).toFixed(1)}% ${direction} the awarded revenue on load ${load.orderId} ($${awarded.toLocaleString()}).`,
    context: { rate, awarded, diffPct, loadId: load.id, orderId: load.orderId },
  }];
};

const ruleTransitWindow: Rule = async (ctx) => {
  const pickEnd = parseIso(ctx.payload.pickupWindowEnd.value);
  const delStart = parseIso(ctx.payload.deliveryWindowStart.value);
  if (!pickEnd || !delStart) return [];
  const transitHours = (delStart.getTime() - pickEnd.getTime()) / 3600000;
  if (transitHours <= 0) {
    return [{
      ruleCode: "transit_window_invalid",
      severity: "warn",
      message: `Delivery window starts (${ctx.payload.deliveryWindowStart.value}) before pickup window ends (${ctx.payload.pickupWindowEnd.value}).`,
      context: { transitHours },
    }];
  }
  if (transitHours < 12) {
    return [{
      ruleCode: "transit_window_tight",
      severity: "warn",
      message: `Transit window is only ${transitHours.toFixed(1)}h — verify drivers can run this lane.`,
      context: { transitHours },
    }];
  }
  return [];
};

const ruleAccessorialUnknown: Rule = async (ctx) => {
  // Without a per-customer tariff table this rule is informational. We flag
  // accessorials that are TBD / "as incurred" so the rep manually reconciles.
  const items = ctx.payload.accessorials.items ?? [];
  const tbdItems = items.filter((i) => i.amount == null || i.amount === 0);
  if (tbdItems.length === 0) return [];
  return [{
    ruleCode: "accessorial_tbd",
    severity: "info",
    message: `${tbdItems.length} accessorial line item${tbdItems.length === 1 ? "" : "s"} marked TBD or zero amount: ${tbdItems.map((i) => i.description).slice(0, 3).join(", ")}.`,
    context: { tbdCount: tbdItems.length, items: tbdItems.slice(0, 5) },
  }];
};

const ruleCarrierOffBench: Rule = async (ctx) => {
  const carrierLink = ctx.links.find((l) => l.kind === "carrier" && l.isPrimary);
  if (carrierLink) {
    // Carrier matched against our bench — check status.
    const [c] = await db.select().from(carriers)
      .where(and(eq(carriers.orgId, ctx.organizationId), eq(carriers.id, carrierLink.targetId))).limit(1);
    if (!c) return [];
    if (c.status === "do_not_use" || c.status === "flagged") {
      return [{
        ruleCode: "carrier_off_bench",
        severity: "block",
        message: `Carrier ${c.name} is on the ${c.status} list — do not auto-tender.`,
        context: { carrierId: c.id, status: c.status },
      }];
    }
    return [];
  }
  // No carrier match at all.
  const mc = (ctx.payload.carrierMcNumber.value ?? "").trim();
  const name = (ctx.payload.carrierName.value ?? "").trim();
  if (!mc && !name) return [];
  return [{
    ruleCode: "carrier_unknown",
    severity: "block",
    message: `Carrier "${name || "?"}"${mc ? ` (MC ${mc})` : ""} is not on our approved bench.`,
    context: { mcNumber: mc, carrierName: name },
  }];
};

const rulePayTermsLong: Rule = async (ctx) => {
  const terms = (ctx.payload.payTerms.value ?? "").trim();
  if (!terms) return [];
  // Match "Net N" patterns.
  const m = terms.match(/net\s*(\d{1,3})/i);
  if (!m) return [];
  const days = Number(m[1]);
  if (!Number.isFinite(days)) return [];
  if (days > STANDARD_PAY_DAYS + 10) {
    return [{
      ruleCode: "pay_terms_long",
      severity: "warn",
      message: `Pay terms "${terms}" exceed our standard Net ${STANDARD_PAY_DAYS}.`,
      context: { days, standard: STANDARD_PAY_DAYS },
    }];
  }
  return [];
};

const ruleRateMissing: Rule = async (ctx) => {
  if (ctx.payload.allInRate.value == null) {
    return [{
      ruleCode: "rate_missing",
      severity: "warn",
      message: "All-in rate not detected — confirm with broker before booking.",
      context: { confidence: ctx.payload.allInRate.confidence },
    }];
  }
  return [];
};

const ruleOpportunityClosed: Rule = async (ctx) => {
  const oppLink = ctx.links.find((l) => l.kind === "opportunity" && l.isPrimary);
  if (!oppLink) return [];
  const [opp] = await db.select().from(freightOpportunities)
    .where(eq(freightOpportunities.id, oppLink.targetId)).limit(1);
  if (!opp) return [];
  if (["awarded", "lost", "cancelled", "closed"].includes(opp.status)) {
    return [{
      ruleCode: "opportunity_closed",
      severity: "info",
      message: `Linked opportunity is already ${opp.status}.`,
      context: { opportunityId: opp.id, status: opp.status },
    }];
  }
  return [];
};

const RULES: Rule[] = [
  ruleRateVsLastQuote,
  ruleRateVsAward,
  ruleTransitWindow,
  ruleAccessorialUnknown,
  ruleCarrierOffBench,
  rulePayTermsLong,
  ruleRateMissing,
  ruleOpportunityClosed,
];

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function parseIso(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? null : d;
}
