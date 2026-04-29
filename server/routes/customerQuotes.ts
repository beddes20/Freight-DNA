import type { Express, Request } from "express";
import { z } from "zod";
import { getCurrentUser, requireAuth, requireUser } from "../auth";
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
  getActionQueue,
  bulkReassignCustomerForQuotes,
  bulkSetQuoteStatus,
  getAutoWonQuoteAfHandoffEnabled,
  setAutoWonQuoteAfHandoffEnabled,
  getFunnel,
  getFunnelDiagnostics,
  getLeakedQuoteEmails,
  listNewContactReviews,
  resolveNewContactReview,
  resolveFunnelRepScope,
  markQuoteOutcome,
  type ManualMarkOutcomeStatus,
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
import {
  getFreightCaptureRepAudit,
  linkRepToUser,
  setRepSuppressed,
  mergeReps,
  searchOrgUsers,
  REP_AUDIT_LOOKBACK_DAYS,
} from "../services/freightCaptureRepAudit";
import { getStaleQuoteFollowUps, getStaleQuoteFollowUpCount, clearStaleFollowUpCache } from "../services/staleQuoteFollowup";
import { publish as publishLiveSync } from "../services/liveSync";
import { db } from "../storage";
import { and as andSql, eq as eqSql, sql as sqlExpr } from "drizzle-orm";
import { gatherDataAnchors, generateDraft } from "./emailDrafting";
import { getVoiceProfile } from "../voiceProfileService";
import { listMappings, deleteMapping } from "../services/quoteSenderMappings";
import multer from "multer";
import {
  parseQuoteIntakeFromText,
  parseQuoteIntakeFromImage,
  MAX_INTAKE_IMAGE_BYTES,
  MAX_INTAKE_TEXT_BYTES,
} from "../services/spotQuoteIntake";
import { getErrorMessage } from "../lib/errors";
import { pStr, qStr, qInt } from "../lib/req";

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
  // Task #615 — accepted but ignored. Kept on the schema so old saved-view
  // rows (and any old client builds during deploy) don't 400 the request;
  // the service layer now hard-filters every non-customer row.
  needsReviewOnly: z.boolean().optional(),
}).strict();

const queryFiltersSchema = filtersSchema.extend({
  wonOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  activeOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  lostOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  expiringOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  needsReviewOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
});

// Task #816 — `carrierPaid` / `marginDollar` / `marginPct` were retired
// from the Quote Opportunities surface (the table, drawer, and CSV are
// customer-only). Keep them tolerated by the route schema as a free-form
// string so a stale saved view that still references one doesn't 400 the
// list endpoint; the service layer's sort switch falls back to the
// default request-date ordering for any unknown sort key.
const KNOWN_SORT_KEYS = new Set<string>([
  "requestDate", "customerName", "originCity", "destCity", "equipment",
  "quotedAmount", "validThrough", "outcomeStatus", "outcomeReasonLabel",
  "repName", "responseTimeHours", "source", "score",
]);

const listQuerySchema = queryFiltersSchema.extend({
  sortKey: z.string().optional(),
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
  return f;
}

export function registerCustomerQuoteRoutes(app: Express): void {
  app.get("/api/customer-quotes/snapshot", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Task #597 — `ensureQuoteSeed` removed from request paths so demo
      // rows can never re-seed an org via the dashboard. Demo seeding is
      // now strictly opt-in via the dev-only seed script.
      void ensureEmailBackfill(user.organizationId);
      const filters = parseFilters(req);
      const snap = await getSnapshot(user.organizationId, filters);
      res.json(snap);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] snapshot error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #673 — Freight Capture Funnel.
  // Sliceable funnel view of quote opportunities. Reuses parseFilters so the
  // existing filter UI (customer/rep/equipment/date/outcome) works identically.
  // RBAC: account_manager is auto-scoped to the QuoteRep mapped to their user
  // id. national_account_manager / admin / director / sales_director are
  // manager-style roles (consistent with managerRoles elsewhere in the
  // codebase) and see the full org-wide funnel. Page-level access is still
  // gated by QUOTE_OPPORTUNITIES_ROLES on the client.
  app.get("/api/customer-quotes/funnel", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const allowed = new Set([
        "admin", "director", "sales_director",
        "national_account_manager", "sales", "account_manager",
      ]);
      if (!allowed.has(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const filters = parseFilters(req);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const result = await getFunnel(user.organizationId, filters, scope);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/list", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Task #597 — see snapshot route. No demo seeding from request paths.
      void ensureEmailBackfill(user.organizationId);
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      const d = parsed.data;
      const filters = parseFilters(req);
      // Task #816 — coerce stale saved-view sort keys (carrierPaid /
      // marginDollar / marginPct, retired with the carrier columns) into
      // the safe default so the request can't crash the list endpoint.
      const requestedSort = d.sortKey ?? "requestDate";
      const sortKey: ListSortKey = (KNOWN_SORT_KEYS.has(requestedSort)
        ? requestedSort
        : "requestDate") as ListSortKey;
      const sortDir = d.sortDir ?? "desc";
      const result = await listQuotes(user.organizationId, filters, sortKey, sortDir, d.offset, d.limit);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
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

  app.post("/api/customer-quotes/quote", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = createQuoteSchema.parse(req.body);
      const opp = await createQuote(user.organizationId, actorName(user), data, user.id);
      const detail = await getQuoteDetail(user.organizationId, opp.id);
      res.status(201).json(detail);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] create error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.patch("/api/customer-quotes/quote/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = updateQuoteSchema.parse(req.body);
      const opp = await updateQuote(user.organizationId, actorName(user), pStr(req.params.id), data, user.id);
      const detail = await getQuoteDetail(user.organizationId, opp.id);
      // Cross-tab UX (option A) — quote outcome/status edits affect the
      // snapshot KPIs, the list view, and the action queue. One topic
      // event covers all three (the client maps the topic to all three
      // query keys).
      publishLiveSync(user.organizationId, "customer_quote", opp.id);
      // Task #690 — any edit that could change a quote's outcome status
      // (won / lost / expired) drops it out of the stale-followup window;
      // any edit that revives a previously-decided quote could put one back
      // in. Bust the cache so the next sidebar badge poll (or page load)
      // recomputes; the membership tracker inside the service will then
      // publish `customer_quote_followup` if the set actually changed.
      clearStaleFollowUpCache(user.organizationId);
      res.json(detail);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] update error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #584 — inline "Create new customer" used by the dashboard's
  // Unknown-bucket reassign popover. Idempotent on case-insensitive name.
  app.post("/api/customer-quotes/customers", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = z.object({
        name: z.string().trim().min(1, "Name is required").max(120),
        segment: z.string().trim().max(80).optional().nullable(),
      }).parse(req.body);
      const customer = await createQuoteCustomer(user.organizationId, data.name, data.segment ?? null);
      res.json(customer);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] create customer error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #597 — manual party-type override for a single quote_customers row.
  // Always sets `partyTypeManual=true` so background classifiers leave the
  // row alone going forward. Used by the drawer's "Mark customer / Mark
  // carrier" buttons. Returns the updated row.
  app.patch("/api/customer-quotes/customers/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const data = z.object({
        partyType: z.enum(QUOTE_PARTY_TYPES),
      }).parse(req.body);
      const updated = await setCustomerPartyType(user.organizationId, pStr(req.params.id), data.partyType);
      if (!updated) return res.status(404).json({ error: "Not found" });
      // Bust the lazy backfill cache so other dashboards that depend on the
      // classification (e.g., snapshot KPIs) reflect the change immediately.
      clearPartyTypeBackfillCache(user.organizationId);
      res.json(updated);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] set party-type error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/quote/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const detail = await getQuoteDetail(user.organizationId, pStr(req.params.id));
      if (!detail) return res.status(404).json({ error: "Not found" });
      res.json(detail);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] detail error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/pricing-intelligence", requireUser, async (req, res) => {
    try {
      const user = req.user!;
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
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] pricing intel error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // 3-tier pricing recommendation for a specific quote (Aggressive /
  // Balanced / Premium with per-tier estimated win-prob and floor flag).
  app.get("/api/customer-quotes/quote/:id/recommendation", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const rec = await getPricingRecommendation(user.organizationId, pStr(req.params.id));
      res.json(rec);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] recommendation error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Per-equipment $/mile margin floors (read).
  app.get("/api/customer-quotes/pricing-floors", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const floors = await getMarginFloors(user.organizationId);
      res.json({ floors });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] pricing-floors get error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Per-equipment $/mile margin floors (admin update). Replaces the full map.
  app.patch("/api/customer-quotes/pricing-floors", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const schema = z.object({ floors: z.record(z.string(), z.number().finite().nonnegative()) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      const saved = await setMarginFloors(user.organizationId, parsed.data.floors, user.id);
      res.json({ floors: saved });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] pricing-floors patch error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #3 — admin list of learned sender→customer mappings.
  // Visible only to admin/director/sales_director — these mappings are an
  // org-level config artifact, not a per-rep view.
  app.get("/api/customer-quotes/sender-mappings", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const mappings = await listMappings(user.organizationId);
      res.json({ mappings });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] sender-mappings list error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #3 — admin delete of a learned mapping. Org-scoped at
  // the service layer; we still re-check the role here so we never let a
  // rep delete an org-wide config row.
  app.delete("/api/customer-quotes/sender-mappings/:id", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing mapping id" });
      const result = await deleteMapping(user.organizationId, id);
      if (!result.deleted) return res.status(404).json({ error: "Mapping not found" });
      res.json({ deleted: true });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] sender-mappings delete error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #654 — Org-level toggle for the won-quote → Available Freight
  // same-day handoff. Admin-only; the setting defaults ON if no row exists
  // in app_settings. Stored under the `auto_won_quote_af_handoff:${orgId}`
  // key so it follows the rest of the project's org-scoped settings
  // convention (no separate org_settings table).
  app.get("/api/customer-quotes/settings/auto-af-handoff", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const enabled = await getAutoWonQuoteAfHandoffEnabled(user.organizationId);
      res.json({ enabled });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] auto-af-handoff get error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/customer-quotes/settings/auto-af-handoff", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "enabled (boolean) required" });
      await setAutoWonQuoteAfHandoffEnabled(user.organizationId, parsed.data.enabled);
      res.json({ enabled: parsed.data.enabled });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] auto-af-handoff put error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #2 — Action Queue (sla-breaching / expiring-today).
  // Task #615 retired the needs-review bucket along with the rest of the
  // unknown-customer surface area. Each list capped at `limit` (default 5,
  // max 25).
  app.get("/api/customer-quotes/action-queue", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        limit: z.preprocess(
          v => v === undefined ? 5 : Number(v),
          z.number().int().min(1).max(25),
        ),
      });
      const parsed = schema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      const queue = await getActionQueue(user.organizationId, { limit: parsed.data.limit });
      res.json(queue);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] action-queue error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Customer Quotes #2 — bulk reassign Needs-Review quotes to a real
  // customer. Defensive: a quote is skipped if its current customer is
  // NOT in the shared "Unknown — needs review" bucket.
  app.post("/api/customer-quotes/quotes/bulk-reassign-customer", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        quoteIds: z.array(z.string().min(1)).min(1).max(500),
        targetCustomerId: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      const result = await bulkReassignCustomerForQuotes(
        user.organizationId,
        parsed.data.quoteIds,
        parsed.data.targetCustomerId,
      );
      // Bust the lazy backfill cache so snapshot KPIs reflect the move.
      clearPartyTypeBackfillCache(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] bulk-reassign error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Customer Quotes #2 — bulk-flip outcome status. Used by the
  // "Mark ignored" / "Mark pending" bulk action.
  app.post("/api/customer-quotes/quotes/bulk-status", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        quoteIds: z.array(z.string().min(1)).min(1).max(500),
        status: z.enum(["ignored", "pending"]),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      const result = await bulkSetQuoteStatus(
        user.organizationId,
        parsed.data.quoteIds,
        parsed.data.status,
      );
      // Cross-tab UX (option A) — bulk flip mutates many rows; one
      // org-wide hint is enough to refresh the list / snapshot / queue.
      publishLiveSync(user.organizationId, "customer_quote");
      // Task #690 — bulk status flip (e.g., ignored ↔ pending) can drop
      // many quotes out of, or back into, the stale-followup window in
      // one shot. Bust the cache so the next badge poll recomputes and
      // the membership tracker fires `customer_quote_followup` if the
      // set actually changed.
      clearStaleFollowUpCache(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] bulk-status error:", err);
      res.status(400).json({ error: msg });
    }
  });

  // Task #505 — Spot Quote Search
  app.get("/api/customer-quotes/spot-search", requireUser, async (req, res) => {
    try {
      const user = req.user!;
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
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] spot search error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #617 — Spot Quote Intake (drop a screenshot or paste an email)
  // Accepts either a multipart upload (image or `.eml` file) or a JSON body
  // with raw text/subject/body. Returns a normalized ParsedQuoteIntake the
  // Spot Quote Search form can use to pre-fill its inputs.
  const intakeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(MAX_INTAKE_IMAGE_BYTES, MAX_INTAKE_TEXT_BYTES) },
  });
  app.post(
    "/api/customer-quotes/spot-intake",
    requireUser,
    intakeUpload.single("file"),
    async (req, res) => {
      try {
        const user = req.user!;

        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (file) {
          const mime = (file.mimetype || "").toLowerCase();
          // Image branch — vision parse.
          if (mime.startsWith("image/")) {
            const result = await parseQuoteIntakeFromImage(file.buffer, mime);
            return res.json(result);
          }
          // .eml or plain-text branch — treat as raw email content.
          const isEmlName = (file.originalname || "").toLowerCase().endsWith(".eml");
          if (mime === "message/rfc822" || mime === "text/plain" || isEmlName) {
            if (file.buffer.byteLength > MAX_INTAKE_TEXT_BYTES) {
              return res.status(413).json({ error: "Email is too large — please paste the body instead." });
            }
            const rawText = file.buffer.toString("utf8");
            const result = await parseQuoteIntakeFromText({ rawText, source: "email" });
            return res.json(result);
          }
          return res.status(415).json({
            error: "Unsupported file type. Drop an image, an .eml file, or paste the email text.",
          });
        }

        // JSON body branch.
        const schema = z.object({
          subject: z.string().max(500).optional(),
          body: z.string().max(MAX_INTAKE_TEXT_BYTES).optional(),
          rawText: z.string().max(MAX_INTAKE_TEXT_BYTES).optional(),
        }).refine(d => (d.body && d.body.trim()) || (d.rawText && d.rawText.trim()) || (d.subject && d.subject.trim()), {
          message: "Provide subject, body, or rawText.",
        });
        const parsed = schema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid intake payload", issues: parsed.error.issues });
        }
        const result = await parseQuoteIntakeFromText({
          subject: parsed.data.subject ?? null,
          body: parsed.data.body ?? null,
          rawText: parsed.data.rawText ?? null,
          source: parsed.data.rawText ? "email" : "text",
        });
        res.json(result);
      } catch (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File is too large — please upload under 8 MB." });
        }
        const msg = getErrorMessage(err);
        console.error("[customer-quotes] spot-intake error:", err);
        res.status(500).json({ error: msg });
      }
    },
  );

  app.get("/api/customer-quotes/lane-autocomplete", requireUser, async (req, res) => {
    try {
      const user = req.user!;
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

  app.get("/api/customer-quotes/saved-views", requireUser, async (req, res) => {
    const user = req.user!;
    const views = await listSavedViews(user.organizationId);
    res.json(views);
  });

  app.post("/api/customer-quotes/saved-views", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const schema = z.object({
        name: z.string().min(1).max(80),
        filters: filtersSchema.default({}),
      });
      const data = schema.parse(req.body);
      const view = await createSavedView(user.organizationId, user.id, data.name, data.filters);
      res.json(view);
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/customer-quotes/saved-views/:id", requireUser, async (req, res) => {
    const user = req.user!;
    await deleteSavedView(user.organizationId, user.id, pStr(req.params.id));
    res.json({ ok: true });
  });

  // Task #516 — Spot Quote Search Deal Sheet: create + email-draft endpoints.
  // The create path delegates to the same `createQuote` service used elsewhere
  // (no duplicate insert logic). Margin guardrail is enforced server-side when
  // an estimatedCost is provided so the frontend can't bypass it.
  app.post("/api/customer-quotes/spot/create", requireUser, async (req, res) => {
    try {
      const user = req.user!;
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
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] spot create error:", err);
      res.status(400).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/spot/email-draft", requireUser, async (req, res) => {
    try {
      const user = req.user!;
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
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] spot email-draft error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #723 — Capture funnel diagnostics. Admin-only panel that reports
  // the most recent TMS sync (scanned / matched / probable / won-lost-
  // expired counts) plus a window of email-classifier outcomes (won / lost
  // / neither inbound replies) plus near-miss TMS candidates surfaced by
  // the looser matcher. Scoped to the same filter slice the funnel uses.
  app.get("/api/customer-quotes/funnel-diagnostics", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const filters = parseFilters(req);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const diagnostics = await getFunnelDiagnostics(user.organizationId, filters, scope);
      res.json(diagnostics);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Capture leak queue (Phase 1, read-only). Row-level expansion of the
  // missingIntentInbound / orphanOutbound counters surfaced by
  // /funnel-diagnostics. Same admin gating, same rep-scope rules; the
  // queue inherits windowDays from the diagnostics defaults so the count
  // and the rows are computed against the same window.
  app.get("/api/customer-quotes/funnel-diagnostics/leaks", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const elevated = new Set(["admin", "director", "sales_director"]);
      if (!elevated.has(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const typeRaw = qStr(req.query.type);
      if (typeRaw !== "missed_inbound" && typeRaw !== "orphan_outbound") {
        return res.status(400).json({ error: "type must be 'missed_inbound' or 'orphan_outbound'" });
      }
      // qInt collapses missing / non-numeric to the fallback. Sentinel
      // -1 ⇒ "use service default" (50 / 0). The service also clamps,
      // so a user-supplied 9999 still gets capped — we don't have to
      // duplicate the bounds here.
      const limitParsed = qInt(req.query.limit, -1);
      const offsetParsed = qInt(req.query.offset, -1);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const result = await getLeakedQuoteEmails(user.organizationId, scope, {
        type: typeRaw,
        limit: limitParsed >= 0 ? limitParsed : undefined,
        offset: offsetParsed >= 0 ? offsetParsed : undefined,
      });
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] funnel-diagnostics/leaks error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #803 — Quote Lifecycle Autopilot prompt queue. Lists every
  // pending "new sender at known customer" prompt scoped to the org so
  // the Quote Opportunities page can render the Add/Dismiss strip.
  // Returns a flat array sorted newest-first; we deliberately do NOT
  // apply rep-scope filtering here — the prompt is a one-window shared
  // chore and any rep with quote-list access should be able to clear it.
  app.get("/api/customer-quotes/new-contact-reviews", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const items = await listNewContactReviews(user.organizationId);
      res.json({ items });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] new-contact-reviews list error:", err);
      res.status(500).json({ error: msg });
    }
  });

  const newContactActionSchema = z.object({
    action: z.enum(["add", "dismiss"]),
    name: z.string().trim().min(1).max(120).optional(),
    companyId: z.string().min(1).optional(),
  });
  app.post("/api/customer-quotes/quote/:id/new-contact-review", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const parsed = newContactActionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payload", details: parsed.error.format() });
      }
      const quoteId = pStr(req.params.id);
      const result = await resolveNewContactReview(
        user.organizationId,
        quoteId,
        parsed.data.action,
        user.id,
        { name: parsed.data.name, companyIdHint: parsed.data.companyId ?? null },
      );
      switch (result.status) {
        case "not_found":            return res.status(404).json({ error: "Quote not found" });
        case "no_pending_prompt":    return res.status(409).json({ error: "No pending prompt for this quote" });
        case "no_company_match":     return res.status(409).json({ error: "Could not match sender domain to an existing customer; create the contact manually." });
        default:                     return res.json(result);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] new-contact-review action error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #723 — manual mark-outcome action. Lets reps resolve a pending
  // quote in-page with one click. Same write-path the auto-detectors use:
  // updates outcomeStatus + reasonId, writes manual_won / manual_lost
  // quote_event, fires the customer touchpoint. Idempotent — bails when
  // the quote is already in a terminal status.
  //
  // Authorization: allowed roles are the ones that can see the funnel.
  // Rep-scoped roles (account_manager etc.) are further restricted by
  // resolveFunnelRepScope to their own quotes — mirrors the GET /list and
  // /funnel scoping so a rep can never act on another rep's row.
  const markOutcomeSchema = z.object({
    outcomeStatus: z.enum([
      "won", "won_low_margin",
      "lost_price", "lost_service", "lost_timing", "lost_incumbent",
      "no_response",
    ]),
    outcomeReasonId: z.string().min(1).nullable().optional(),
  });
  app.post("/api/customer-quotes/quote/:id/mark-outcome", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const allowed = new Set([
        "admin", "director", "sales_director",
        "national_account_manager", "sales",
        "account_manager", "logistics_manager", "logistics_coordinator",
      ]);
      if (!allowed.has(user.role)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const id = pStr(req.params.id);
      if (!id) return res.status(400).json({ error: "Missing quote id" });
      const parsed = markOutcomeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      }
      const { outcomeStatus, outcomeReasonId } = parsed.data;

      // Resolve per-rep scope. Elevated roles get null (no rep restriction);
      // scoped roles get their rep id, which the service uses to bail with
      // status="forbidden" on cross-rep attempts. The "__none__" sentinel
      // means the user is in a scoped role with no rep mapping at all —
      // they can't have any quotes, so reject up-front.
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      if (scope === "__none__") {
        return res.status(403).json({ error: "No rep mapping — cannot mark quotes" });
      }

      const result = await markQuoteOutcome(
        user.organizationId,
        id,
        outcomeStatus as ManualMarkOutcomeStatus,
        outcomeReasonId ?? null,
        actorName(user),
        { enforceRepScope: scope ?? undefined },
      );
      if (result.status === "not_found") return res.status(404).json({ error: "Quote not found" });
      if (result.status === "forbidden") return res.status(403).json({ error: "Quote belongs to another rep" });
      if (result.status === "invalid_reason") return res.status(400).json({ error: "Unknown outcomeReasonId for this org" });
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] mark-outcome error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/sync-tms", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      // Restrict to admin/director — write path that mutates outcomes.
      if (user.role !== "admin" && user.role !== "director") {
        return res.status(403).json({ error: "Forbidden" });
      }
      const result = await syncQuoteOutcomesFromTms(user.organizationId);
      res.json(result);
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] tms sync error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #480 — list stale quote follow-ups (on-demand recompute supported via ?force=1).
  // Task #690 — viewer-scoped: account_manager sees only their own quotes,
  // managers/directors/admins see the full org list. Scope mirrors
  // resolveFunnelRepScope so behavior is consistent with the funnel view.
  app.get("/api/customer-quotes/stale-followups", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const forceStr = qStr(req.query.force);
      const force = forceStr === "1" || forceStr === "true";
      if (force) clearStaleFollowUpCache(user.organizationId);
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const items = await getStaleQuoteFollowUps(user.organizationId, { force, scope });
      res.json({ items });
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #690 — count-only variant for the sidebar badge. Shares the same
  // per-org cache as the full list endpoint (compute is org-wide, then
  // filtered post-cache per viewer), so a sidebar poll is free (cached hit)
  // or triggers a single shared recompute. Returns just the integer to keep
  // the payload tiny across many open tabs.
  app.get("/api/customer-quotes/stale-followups/count", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const scope = await resolveFunnelRepScope(user.organizationId, { id: user.id, role: user.role });
      const count = await getStaleQuoteFollowUpCount(user.organizationId, { scope });
      res.json({ count });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] stale-followups count error:", err);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/customer-quotes/recompute-stale", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      clearStaleFollowUpCache(user.organizationId);
      const items = await getStaleQuoteFollowUps(user.organizationId, { force: true });
      res.json({ ok: true, count: items.length });
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/customer-quotes/export.csv", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const filters = parseFilters(req);
      const csv = await exportCsv(user.organizationId, filters);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="customer-quotes-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) {
      const msg = getErrorMessage(err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — observability for the lazy auto-backfill (and any admin-
  // triggered run). Returns the most recent backfill state for the caller's
  // org so ops can verify the Customer Quotes table is fully real-data-backed.
  app.get("/api/customer-quotes/email-backfill-status", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      const status = getEmailBackfillStatus(user.organizationId);
      res.json({ ok: true, organizationId: user.organizationId, status });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] email-backfill-status error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // Task #526 — admin-only endpoint to backfill quote_opportunities from
  // historical inbound email_messages. Idempotent; safe to invoke repeatedly.
  app.post("/api/customer-quotes/backfill-from-emails", requireUser, async (req, res) => {
    try {
      const user = req.user!;
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
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] backfill error:", err);
      res.status(500).json({ error: msg });
    }
  });

  // ── Task #752 — Freight Capture Rep Audit (admin-only) ──────────────────
  // GET  /api/customer-quotes/rep-audit          → table + summary counters
  // GET  /api/customer-quotes/rep-audit/users    → user search for the link picker
  // POST /api/customer-quotes/rep-audit/:repId/link     { userId: string|null }
  // POST /api/customer-quotes/rep-audit/:repId/suppress { suppressed: boolean }
  // POST /api/customer-quotes/rep-audit/merge    { sourceRepId, targetRepId }
  function isRepAuditAdmin(role: string | undefined): boolean {
    // Task #752 — admin-only by spec. Mutates rep identity (link / suppress /
    // merge) and changes who appears in the funnel rep dropdown / column /
    // rankings, so we keep this strictly tighter than the rest of the
    // customer-quotes admin surface (which allows admin/director/sales_director).
    return role === "admin";
  }

  app.get("/api/customer-quotes/rep-audit", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const lookbackDays = Math.max(
        1,
        Math.min(365, qInt(req.query.lookbackDays, REP_AUDIT_LOOKBACK_DAYS)),
      );
      const result = await getFreightCaptureRepAudit(user.organizationId, { lookbackDays });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[customer-quotes] rep-audit list error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get("/api/customer-quotes/rep-audit/users", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const q = qStr(req.query.q);
      const rows = await searchOrgUsers(user.organizationId, q, 50);
      res.json({ ok: true, users: rows });
    } catch (err) {
      console.error("[customer-quotes] rep-audit users error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  const linkBodySchema = z.object({
    userId: z.string().min(1).nullable(),
  });
  app.post("/api/customer-quotes/rep-audit/:repId/link", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const repId = pStr(req.params.repId);
      if (!repId) return res.status(400).json({ error: "Missing repId" });
      const parsed = linkBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await linkRepToUser(user.organizationId, repId, parsed.data.userId);
      if (result.status === "not_found") return res.status(404).json({ error: "Rep not found" });
      if (result.status === "invalid") return res.status(400).json({ error: result.message });
      res.json({ ok: true });
    } catch (err) {
      console.error("[customer-quotes] rep-audit link error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  const suppressBodySchema = z.object({ suppressed: z.boolean() });
  app.post("/api/customer-quotes/rep-audit/:repId/suppress", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const repId = pStr(req.params.repId);
      if (!repId) return res.status(400).json({ error: "Missing repId" });
      const parsed = suppressBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const result = await setRepSuppressed(user.organizationId, repId, parsed.data.suppressed);
      if (result.status === "not_found") return res.status(404).json({ error: "Rep not found" });
      if (result.status === "invalid") return res.status(400).json({ error: result.message });
      res.json({ ok: true });
    } catch (err) {
      console.error("[customer-quotes] rep-audit suppress error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  const mergeBodySchema = z.object({
    sourceRepId: z.string().min(1),
    targetRepId: z.string().min(1),
  });
  app.post("/api/customer-quotes/rep-audit/merge", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!isRepAuditAdmin(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const parsed = mergeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }
      const { sourceRepId, targetRepId } = parsed.data;
      const result = await mergeReps(user.organizationId, sourceRepId, targetRepId);
      if (result.status === "not_found") return res.status(404).json({ error: "One or both reps not found" });
      if (result.status === "invalid") return res.status(400).json({ error: result.message });
      res.json({ ok: true, reassigned: result.reassigned ?? 0 });
    } catch (err) {
      console.error("[customer-quotes] rep-audit merge error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // Task #526 — admin-only endpoint to purge demo seed rows that may have
  // leaked into a live org (e.g., when QUOTE_DEMO_SEED_ENABLED was briefly on).
  // Idempotent. Defaults to the caller's org; pass { allOrgs: true } to sweep
  // every org (admin only).
  app.post("/api/customer-quotes/purge-demo-seed", requireUser, async (req, res) => {
    try {
      const user = req.user!;
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      const allOrgs = Boolean(req.body?.allOrgs) && user.role === "admin";
      const summary = await purgeDemoSeed(allOrgs ? undefined : user.organizationId);
      res.json({ ok: true, summary });
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error("[customer-quotes] purge-demo-seed error:", err);
      res.status(500).json({ error: msg });
    }
  });
}
