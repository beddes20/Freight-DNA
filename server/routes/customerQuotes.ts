import type { Express, Request } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import {
  getSnapshot, getQuoteDetail,
  listQuotes, listSavedViews, createSavedView, deleteSavedView, exportCsv,
  createQuote, updateQuote,
  getPricingIntelligence,
  searchSpotQuote, laneAutocomplete,
  purgeDemoSeed,
  createQuoteCustomer,
  setCustomerPartyType,
  clearPartyTypeBackfillCache,
  type QuoteFilters, type ListSortKey,
} from "../services/customerQuotes";
import { QUOTE_PARTY_TYPES } from "@shared/schema";
import { syncQuoteOutcomesFromTms } from "../services/quoteTmsSync";
import { backfillQuotesFromEmails, ensureEmailBackfill, getEmailBackfillStatus } from "../services/quoteEmailIngestion";
import {
  getPricingRecommendation,
  getMarginFloors,
  setMarginFloors,
} from "../services/quotePricingRecommendation";
import { QUOTE_OUTCOME_STATUSES, QUOTE_SOURCES, companies, contacts, quoteReps, spotQuoteCreateSchema } from "@shared/schema";
import { getStaleQuoteFollowUps, clearStaleFollowUpCache } from "../services/staleQuoteFollowup";
import { db } from "../storage";
import { and as andSql, eq as eqSql, sql as sqlExpr } from "drizzle-orm";
import { gatherDataAnchors, generateDraft } from "./emailDrafting";
import { getVoiceProfile } from "../voiceProfileService";

// Minimum margin % guardrail when estimatedCost is supplied. Env-tunable.
const SPOT_MIN_MARGIN_PCT: number = (() => {
  const raw = parseFloat(process.env.SPOT_MIN_MARGIN_PCT ?? "");
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
})();

const filtersSchema = z.object({
  customerId: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  equipment: z.string().min(1).optional(),
  repId: z.string().min(1).optional(),
  outcomeStatus: z.string().min(1).optional(),
  outcomeReasonId: z.string().min(1).optional(),
  laneSearch: z.string().min(1).max(120).optional(),
  laneGroupId: z.string().min(1).optional(),
  wonOnly: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  lostOnly: z.boolean().optional(),
  expiringOnly: z.boolean().optional(),
  // Task #584 — quick filter for the shared "Unknown — needs review" bucket.
  needsReviewOnly: z.boolean().optional(),
  // Task #597 — header "Show carriers too" toggle.
  includeCarriers: z.boolean().optional(),
}).strict();

const queryFiltersSchema = filtersSchema.extend({
  wonOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  activeOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  lostOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  expiringOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  needsReviewOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  includeCarriers: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
});

const SORT_KEYS = [
  "requestDate", "customerName", "originCity", "destCity", "equipment",
  "quotedAmount", "validThrough", "outcomeStatus", "outcomeReasonLabel",
  "carrierPaid", "marginDollar", "marginPct", "repName", "responseTimeHours",
  "source", "score",
] as const;

const listQuerySchema = queryFiltersSchema.extend({
  sortKey: z.enum(SORT_KEYS).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  offset: z.preprocess(v => v === undefined ? 0 : Number(v), z.number().int().min(0).max(100000)),
  limit: z.preprocess(v => v === undefined ? 50 : Number(v), z.number().int().min(1).max(500)),
});

function parseFilters(req: Request): QuoteFilters {
  const parsed = queryFiltersSchema.safeParse(req.query);
  if (!parsed.success) return {};
  const f: QuoteFilters = {};
  const d = parsed.data;
  if (d.customerId) f.customerId = d.customerId;
  if (d.startDate) f.startDate = d.startDate;
  if (d.endDate) f.endDate = d.endDate;
  if (d.equipment) f.equipment = d.equipment;
  if (d.repId) f.repId = d.repId;
  if (d.outcomeStatus) f.outcomeStatus = d.outcomeStatus;
  if (d.outcomeReasonId) f.outcomeReasonId = d.outcomeReasonId;
  if (d.laneSearch) f.laneSearch = d.laneSearch;
  if (d.laneGroupId) f.laneGroupId = d.laneGroupId;
  if (d.wonOnly) f.wonOnly = true;
  if (d.activeOnly) f.activeOnly = true;
  if (d.lostOnly) f.lostOnly = true;
  if (d.expiringOnly) f.expiringOnly = true;
  if (d.needsReviewOnly) f.needsReviewOnly = true;
  if (d.includeCarriers) f.includeCarriers = true;
  return f;
}

export function registerCustomerQuoteRoutes(app: Express): void {
  app.get("/api/customer-quotes/snapshot", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      // Task #597 — `ensureQuoteSeed` removed from request paths so demo
      // rows can never re-seed an org via the dashboard. Demo seeding is
      // now strictly opt-in via the dev-only seed script.
      void ensureEmailBackfill(user.organizationId);
      const filters = parseFilters(req);
      const snap = await getSnapshot(user.organizationId, filters);
      res.json(snap);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] snapshot error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/list", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      // Task #597 — see snapshot route. No demo seeding from request paths.
      void ensureEmailBackfill(user.organizationId);
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      const d = parsed.data;
      const filters = parseFilters(req);
      const sortKey: ListSortKey = (d.sortKey ?? "requestDate") as ListSortKey;
      const sortDir = d.sortDir ?? "desc";
      const result = await listQuotes(user.organizationId, filters, sortKey, sortDir, d.offset, d.limit);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] list error:", err);
      res.status(500).json({ error: msg });
    }
  });

  const createQuoteSchema = z.object({
    customerId: z.string().min(1),
    repId: z.string().min(1).nullable().optional(),
    carrierId: z.string().min(1).nullable().optional(),
    outcomeReasonId: z.string().min(1).nullable().optional(),
    originCity: z.string().min(1).max(80),
    originState: z.string().min(1).max(8),
    destCity: z.string().min(1).max(80),
    destState: z.string().min(1).max(8),
    equipment: z.string().min(1).max(40),
    quotedAmount: z.union([z.string(), z.number()]).nullable().optional(),
    validThrough: z.string().nullable().optional(),
    outcomeStatus: z.enum(QUOTE_OUTCOME_STATUSES).optional(),
    carrierPaid: z.union([z.string(), z.number()]).nullable().optional(),
    responseTimeHours: z.union([z.string(), z.number()]).nullable().optional(),
    source: z.enum(QUOTE_SOURCES).optional(),
    sourceReference: z.string().max(80).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    score: z.union([z.string(), z.number()]).nullable().optional(),
    requestDate: z.string().nullable().optional(),
  });

  const updateQuoteSchema = createQuoteSchema.partial().extend({
    // Task #477 — UI win-outcome dialog passes this when the rep unchecks
    // "Create LWQ lane" before confirming the win.
    skipLwqHandoff: z.boolean().optional(),
  });

  function actorName(u: { name?: string | null; username?: string | null; id: string } | null): string {
    if (!u) return "system";
    return (u.name && u.name.trim()) || u.username || u.id;
  }

  app.post("/api/customer-quotes/quote", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const data = createQuoteSchema.parse(req.body);
      const opp = await createQuote(user.organizationId, actorName(user), data, user.id);
      const detail = await getQuoteDetail(user.organizationId, opp.id);
      res.status(201).json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      console.error("[customer-quotes] create error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.patch("/api/customer-quotes/quote/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const data = updateQuoteSchema.parse(req.body);
      const opp = await updateQuote(user.organizationId, actorName(user), String(req.params.id), data, user.id);
      const detail = await getQuoteDetail(user.organizationId, opp.id);
      res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      console.error("[customer-quotes] update error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #584 — inline "Create new customer" used by the dashboard's
  // Unknown-bucket reassign popover. Idempotent on case-insensitive name.
  app.post("/api/customer-quotes/customers", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const data = z.object({
        name: z.string().trim().min(1, "Name is required").max(120),
        segment: z.string().trim().max(80).optional().nullable(),
      }).parse(req.body);
      const customer = await createQuoteCustomer(user.organizationId, data.name, data.segment ?? null);
      res.json(customer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      console.error("[customer-quotes] create customer error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #597 — manual party-type override for a single quote_customers row.
  // Always sets `partyTypeManual=true` so background classifiers leave the
  // row alone going forward. Used by the drawer's "Mark customer / Mark
  // carrier" buttons. Returns the updated row.
  app.patch("/api/customer-quotes/customers/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const data = z.object({
        partyType: z.enum(QUOTE_PARTY_TYPES),
      }).parse(req.body);
      const updated = await setCustomerPartyType(user.organizationId, String(req.params.id), data.partyType);
      if (!updated) return res.status(404).json({ error: "Not found" });
      // Bust the lazy backfill cache so other dashboards that depend on the
      // classification (e.g., snapshot KPIs) reflect the change immediately.
      clearPartyTypeBackfillCache(user.organizationId);
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      console.error("[customer-quotes] set party-type error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/quote/:id", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const detail = await getQuoteDetail(user.organizationId, String(req.params.id));
      if (!detail) return res.status(404).json({ error: "Not found" });
      res.json(detail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] detail error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/pricing-intelligence", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        customerId: z.string().min(1),
        originCity: z.string().min(1),
        originState: z.string().min(1).max(4),
        destCity: z.string().min(1),
        destState: z.string().min(1).max(4),
        equipment: z.string().min(1).optional(),
        laneGroupId: z.string().min(1).optional(),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      // Task #597 — ensureQuoteSeed removed from request paths.
      void ensureEmailBackfill(user.organizationId);
      const intel = await getPricingIntelligence(user.organizationId, parsed.data);
      res.json(intel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] pricing intel error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // 3-tier pricing recommendation for a specific quote (Aggressive /
  // Balanced / Premium with per-tier estimated win-prob and floor flag).
  app.get("/api/customer-quotes/quote/:id/recommendation", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const rec = await getPricingRecommendation(user.organizationId, String(req.params.id));
      res.json(rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] recommendation error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Per-equipment $/mile margin floors (read).
  app.get("/api/customer-quotes/pricing-floors", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const floors = await getMarginFloors(user.organizationId);
      res.json({ floors });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] pricing-floors get error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Per-equipment $/mile margin floors (admin update). Replaces the full map.
  app.patch("/api/customer-quotes/pricing-floors", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const schema = z.object({ floors: z.record(z.string(), z.number().finite().nonnegative()) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      const saved = await setMarginFloors(user.organizationId, parsed.data.floors, user.id);
      res.json({ floors: saved });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] pricing-floors patch error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #505 — Spot Quote Search
  app.get("/api/customer-quotes/spot-search", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        pickupCity: z.string().min(1).max(80),
        pickupState: z.string().min(1).max(8),
        deliveryCity: z.string().min(1).max(80),
        deliveryState: z.string().min(1).max(8),
        equipment: z.string().max(40).optional(),
        pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
        customerId: z.string().min(1).optional(),
        lookbackDays: z.coerce.number().int().min(1).max(3650).optional(),
        exactOnly: z.preprocess(v => v === "true" || v === true, z.boolean()).optional(),
        includeSimilar: z.preprocess(v => !(v === "false" || v === false), z.boolean()).optional(),
        matchMode: z.enum(["strict", "relaxed"]).optional(),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      // Task #597 — ensureQuoteSeed removed from request paths.
      void ensureEmailBackfill(user.organizationId);
      const result = await searchSpotQuote(user.organizationId, parsed.data);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] spot search error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/lane-autocomplete", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        q: z.string().min(1).max(80),
        kind: z.enum(["origin", "dest"]),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.json([]);
      // Task #597 — ensureQuoteSeed removed from request paths.
      void ensureEmailBackfill(user.organizationId);
      const items = await laneAutocomplete(user.organizationId, parsed.data.q, parsed.data.kind);
      res.json(items);
    } catch (err) {
      console.error("[customer-quotes] autocomplete error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/api/customer-quotes/saved-views", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const views = await listSavedViews(user.organizationId);
    res.json(views);
  });

  app.post("/api/customer-quotes/saved-views", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        name: z.string().min(1).max(80),
        filters: filtersSchema.default({}),
      });
      const data = schema.parse(req.body);
      const view = await createSavedView(user.organizationId, user.id, data.name, data.filters);
      res.json(view);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/customer-quotes/saved-views/:id", requireAuth, async (req, res) => {
    const user = await getCurrentUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    await deleteSavedView(user.organizationId, user.id, String(req.params.id));
    res.json({ ok: true });
  });

  // Task #516 — Spot Quote Search Deal Sheet: create + email-draft endpoints.
  // The create path delegates to the same `createQuote` service used elsewhere
  // (no duplicate insert logic). Margin guardrail is enforced server-side when
  // an estimatedCost is provided so the frontend can't bypass it.
  app.post("/api/customer-quotes/spot/create", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const parsed = spotQuoteCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const data = parsed.data;
      if (typeof data.estimatedCost === "number" && data.estimatedCost > 0) {
        const marginPct = ((data.quotedAmount - data.estimatedCost) / data.quotedAmount) * 100;
        if (marginPct < SPOT_MIN_MARGIN_PCT) {
          return res.status(400).json({
            error: `Margin ${marginPct.toFixed(1)}% is below the ${SPOT_MIN_MARGIN_PCT}% guardrail`,
            marginPct,
            minMarginPct: SPOT_MIN_MARGIN_PCT,
          });
        }
      }
      const actor = (user.name && user.name.trim()) || user.username || user.id;
      let resolvedRepId: string | null = null;
      try {
        const [rep] = await db.select().from(quoteReps).where(andSql(
          eqSql(quoteReps.organizationId, user.organizationId),
          eqSql(quoteReps.userId, user.id),
        )).limit(1);
        if (rep) resolvedRepId = rep.id;
      } catch (lookupErr) {
        console.warn("[customer-quotes] spot create rep lookup failed:", lookupErr);
      }
      const opp = await createQuote(user.organizationId, actor, {
        customerId: data.customerId,
        repId: resolvedRepId,
        originCity: data.pickupCity,
        originState: data.pickupState.toUpperCase(),
        destCity: data.deliveryCity,
        destState: data.deliveryState.toUpperCase(),
        equipment: data.equipment,
        quotedAmount: data.quotedAmount,
        validThrough: data.validUntil ?? null,
        source: "manual",
        notes: data.notes ?? null,
      }, user.id);
      res.status(201).json(opp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      console.error("[customer-quotes] spot create error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/spot/email-draft", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const schema = z.object({
        quoteId: z.string().min(1),
        recommendedRate: z.number().finite().positive().optional(),
        guidanceMessage: z.string().max(500).optional(),
        bandLow: z.number().finite().positive().optional(),
        bandMid: z.number().finite().positive().optional(),
        bandHigh: z.number().finite().positive().optional(),
        bandSource: z.string().max(40).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
      }
      const { quoteId, recommendedRate, guidanceMessage, bandLow, bandMid, bandHigh, bandSource } = parsed.data;
      const detail = await getQuoteDetail(user.organizationId, quoteId);
      if (!detail) return res.status(404).json({ error: "Quote not found" });

      let accountId: string | undefined;
      let toEmails: string[] = [];
      if (detail.customer) {
        try {
          const [match] = await db.select().from(companies).where(andSql(
            eqSql(companies.organizationId, user.organizationId),
            sqlExpr`lower(${companies.name}) = lower(${detail.customer.name})`,
          )).limit(1);
          if (match) {
            accountId = match.id;
            const cs = await db.select().from(contacts).where(eqSql(contacts.companyId, match.id)).limit(20);
            toEmails = cs.map(c => c.email).filter((e): e is string => !!e).slice(0, 5);
          }
        } catch (lookupErr) {
          console.warn("[customer-quotes] spot email-draft contact lookup failed:", lookupErr);
        }
      }

      const [voiceProfile, dataResult] = await Promise.all([
        getVoiceProfile(user.id, user.username, user.organizationId),
        gatherDataAnchors(user.organizationId, accountId, undefined),
      ]);

      const lane = `${detail.opp.originCity}, ${detail.opp.originState} → ${detail.opp.destCity}, ${detail.opp.destState}`;
      const quotedAmt = Number(detail.opp.quotedAmount ?? 0);
      const validStr = detail.opp.validThrough ? new Date(detail.opp.validThrough).toLocaleDateString() : "";
      const recRate = recommendedRate && recommendedRate > 0 ? recommendedRate : quotedAmt;
      const guidanceLine = (bandLow || bandMid || bandHigh)
        ? `Pricing guidance${bandSource ? ` (${bandSource})` : ""}: ` +
          [
            bandLow ? `low $${Math.round(bandLow).toLocaleString()}` : "",
            bandMid ? `mid $${Math.round(bandMid).toLocaleString()}` : "",
            bandHigh ? `high $${Math.round(bandHigh).toLocaleString()}` : "",
          ].filter(Boolean).join(" / ")
        : "";
      const guidanceContextLine = guidanceMessage && guidanceMessage.trim()
        ? `Guidance: ${guidanceMessage.trim()}`
        : "";
      const dataContext = [
        `Spot quote: ${lane}`,
        `Equipment: ${detail.opp.equipment}`,
        `Recommended rate: $${Math.round(recRate).toLocaleString()}`,
        `Quoted: $${quotedAmt.toLocaleString()}`,
        guidanceLine,
        guidanceContextLine,
        validStr ? `Valid through: ${validStr}` : "",
        detail.opp.notes ? `Internal notes: ${detail.opp.notes}` : "",
        dataResult.context,
      ].filter(Boolean).join("\n");

      const body = await generateDraft({
        voiceProfile,
        playType: "general",
        dataContext,
        additionalContext: `Outreach for spot quote ${lane}. Recommended rate $${Math.round(recRate).toLocaleString()}${guidanceLine ? `. ${guidanceLine}` : ""}.`,
      });
      const subject = `Spot Quote: ${lane}`;
      res.json({ subject, body, to: toEmails });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid input";
      console.error("[customer-quotes] spot email-draft error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/sync-tms", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      // Restrict to admin/director — write path that mutates outcomes.
      if (user.role !== "admin" && user.role !== "director") {
        return res.status(403).json({ error: "Forbidden" });
      }
      const result = await syncQuoteOutcomesFromTms(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] tms sync error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #480 — list stale quote follow-ups (on-demand recompute supported via ?force=1).
  app.get("/api/customer-quotes/stale-followups", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const force = req.query.force === "1" || req.query.force === "true";
      if (force) clearStaleFollowUpCache(user.organizationId);
      const items = await getStaleQuoteFollowUps(user.organizationId, { force });
      res.json({ items });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/recompute-stale", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      clearStaleFollowUpCache(user.organizationId);
      const items = await getStaleQuoteFollowUps(user.organizationId, { force: true });
      res.json({ ok: true, count: items.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/export.csv", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const filters = parseFilters(req);
      const csv = await exportCsv(user.organizationId, filters);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="customer-quotes-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — observability for the lazy auto-backfill (and any admin-
  // triggered run). Returns the most recent backfill state for the caller's
  // org so ops can verify the Customer Quotes table is fully real-data-backed.
  app.get("/api/customer-quotes/email-backfill-status", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const status = getEmailBackfillStatus(user.organizationId);
      res.json({ ok: true, organizationId: user.organizationId, status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] email-backfill-status error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — admin-only endpoint to backfill quote_opportunities from
  // historical inbound email_messages. Idempotent; safe to invoke repeatedly.
  app.post("/api/customer-quotes/backfill-from-emails", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const sinceDays = req.body?.sinceDays ? Number(req.body.sinceDays) : undefined;
      const limit = req.body?.limit ? Number(req.body.limit) : undefined;
      const summary = await backfillQuotesFromEmails(user.organizationId, {
        sinceDays: Number.isFinite(sinceDays) ? sinceDays : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] backfill error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — admin-only endpoint to purge demo seed rows that may have
  // leaked into a live org (e.g., when QUOTE_DEMO_SEED_ENABLED was briefly on).
  // Idempotent. Defaults to the caller's org; pass { allOrgs: true } to sweep
  // every org (admin only).
  app.post("/api/customer-quotes/purge-demo-seed", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const allOrgs = Boolean(req.body?.allOrgs) && user.role === "admin";
      const summary = await purgeDemoSeed(allOrgs ? undefined : user.organizationId);
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal error";
      console.error("[customer-quotes] purge-demo-seed error:", err);
      res.status(500).json({ error: msg });
    }
  });
}
