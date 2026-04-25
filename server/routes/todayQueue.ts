// Task #639 — Today queue routes.
//
// Surface for the unified prioritized work queue at /today. Five endpoints:
//   GET  /api/today-queue                       — paginated aggregator output
//   POST /api/today-queue/snooze                — "Done for now" upsert
//   POST /api/today-queue/unsnooze              — undo a snooze
//   GET  /api/users/me/landing-preference       — read defaultToTodayQueue flag
//   PATCH /api/users/me/landing-preference      — write the flag
//
// All endpoints require auth and are scoped to the requester's org/user. The
// landing-preference endpoint also lives on /api/auth/me for client convenience
// (see auth.ts), so the dedicated GET here is mainly for callers that don't
// want the full /me payload.
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import { storage } from "../storage";
import {
  getTodayQueue,
  snoozeTodayItem,
  unsnoozeTodayItem,
} from "../services/todayQueue";
import { TODAY_QUEUE_SOURCES } from "@shared/schema";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // Cursor is a small numeric page index emitted by the aggregator. Reject
  // anything else with a 400 instead of silently coercing to page 0.
  cursor: z.string().regex(/^\d+$/).optional(),
});

const sourceSchema = z.enum(TODAY_QUEUE_SOURCES);

const snoozeBodySchema = z.object({
  source: sourceSchema,
  sourceId: z.string().min(1).max(200),
  hours: z.number().int().min(1).max(24 * 14),
  reason: z.string().max(500).nullable().optional(),
});

const unsnoozeBodySchema = z.object({
  source: sourceSchema,
  sourceId: z.string().min(1).max(200),
});

const landingPrefBodySchema = z.object({
  defaultToTodayQueue: z.boolean(),
});

export function registerTodayQueueRoutes(app: Express): void {
  // ── GET /api/today-queue ────────────────────────────────────────────────
  // Returns the aggregated, prioritized queue for the current user. Paginated.
  // Designed to fit a single round-trip well under 500ms for ~50 items.
  app.get("/api/today-queue", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
      }

      const t0 = Date.now();
      const result = await getTodayQueue(user.organizationId, user.id, {
        limit: parsed.data.limit,
        cursor: parsed.data.cursor ?? null,
      });
      const ms = Date.now() - t0;
      // Emit a lightweight perf log so the SLO target (<500ms for 50 items)
      // is observable from the operator log search without extra tooling.
      if (ms > 500) {
        console.warn(`[todayQueue] slow aggregation user=${user.id} ms=${ms} items=${result.totalBeforePagination}`);
      }
      res.setHeader("X-Today-Queue-Ms", String(ms));
      return res.json(result);
    } catch (err) {
      console.error("[GET /api/today-queue] error:", err);
      return res.status(500).json({ error: "Failed to load today queue" });
    }
  });

  // ── POST /api/today-queue/snooze ────────────────────────────────────────
  // "Done for now" — hides the item from this user's queue for `hours` hours.
  // Stored in today_queue_snoozes; the row itself is the audit record (it
  // carries userId + timestamp + reason).
  app.post("/api/today-queue/snooze", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = snoozeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const { snoozedUntil } = await snoozeTodayItem({
        orgId: user.organizationId,
        userId: user.id,
        source: parsed.data.source,
        sourceId: parsed.data.sourceId,
        hours: parsed.data.hours,
        reason: parsed.data.reason ?? null,
      });
      return res.json({ ok: true, snoozedUntil: snoozedUntil.toISOString() });
    } catch (err) {
      console.error("[POST /api/today-queue/snooze] error:", err);
      return res.status(500).json({ error: "Failed to snooze item" });
    }
  });

  // ── POST /api/today-queue/unsnooze ──────────────────────────────────────
  // Removes a previously-set snooze so the item resurfaces immediately.
  app.post("/api/today-queue/unsnooze", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = unsnoozeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }

      await unsnoozeTodayItem({
        orgId: user.organizationId,
        userId: user.id,
        source: parsed.data.source,
        sourceId: parsed.data.sourceId,
      });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[POST /api/today-queue/unsnooze] error:", err);
      return res.status(500).json({ error: "Failed to unsnooze item" });
    }
  });

  // ── GET /api/users/me/landing-preference ────────────────────────────────
  app.get("/api/users/me/landing-preference", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      // Drizzle returns the boolean as a true/false; legacy rows (pre-migration)
      // resolve to true via the column default but we double-default here so
      // the client gets a deterministic value during the brief migration window.
      const defaultToTodayQueue = (user as any).defaultToTodayQueue !== false;
      return res.json({ defaultToTodayQueue });
    } catch (err) {
      console.error("[GET landing-preference] error:", err);
      return res.status(500).json({ error: "Failed to read preference" });
    }
  });

  // ── PATCH /api/users/me/landing-preference ──────────────────────────────
  app.patch("/api/users/me/landing-preference", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });

      const parsed = landingPrefBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const updated = await storage.updateUser(user.id, user.organizationId, {
        defaultToTodayQueue: parsed.data.defaultToTodayQueue,
      } as any);
      if (!updated) return res.status(404).json({ error: "User not found" });
      return res.json({ defaultToTodayQueue: parsed.data.defaultToTodayQueue });
    } catch (err) {
      console.error("[PATCH landing-preference] error:", err);
      return res.status(500).json({ error: "Failed to update preference" });
    }
  });
}
