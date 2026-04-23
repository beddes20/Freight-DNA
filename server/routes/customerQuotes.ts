import type { Express, Request } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import {
  ensureQuoteSeed, getSnapshot, getQuoteDetail,
  listQuotes, listSavedViews, createSavedView, deleteSavedView, exportCsv,
  type QuoteFilters, type ListSortKey,
} from "../services/customerQuotes";

const filtersSchema = z.object({
  customerId: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  equipment: z.string().min(1).optional(),
  repId: z.string().min(1).optional(),
  outcomeStatus: z.string().min(1).optional(),
  outcomeReasonId: z.string().min(1).optional(),
  laneSearch: z.string().min(1).max(120).optional(),
  wonOnly: z.boolean().optional(),
  activeOnly: z.boolean().optional(),
  lostOnly: z.boolean().optional(),
  expiringOnly: z.boolean().optional(),
}).strict();

const queryFiltersSchema = filtersSchema.extend({
  wonOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  activeOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  lostOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
  expiringOnly: z.preprocess(v => v === "true" || v === true, z.boolean().optional()),
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
  if (d.wonOnly) f.wonOnly = true;
  if (d.activeOnly) f.activeOnly = true;
  if (d.lostOnly) f.lostOnly = true;
  if (d.expiringOnly) f.expiringOnly = true;
  return f;
}

export function registerCustomerQuoteRoutes(app: Express): void {
  app.get("/api/customer-quotes/snapshot", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      await ensureQuoteSeed(user.organizationId);
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
      await ensureQuoteSeed(user.organizationId);
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
}
