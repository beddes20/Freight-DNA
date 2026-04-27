/**
 * Task #700 — AI Engagement Instrumentation
 *
 * Two endpoints:
 *   POST /api/ai-engagement/events    — batched ingestion from any AI surface
 *   GET  /api/ai-engagement/overview  — per-surface aggregates (admin-only)
 *
 * The ingest endpoint accepts up to 50 events per call; events not belonging
 * to the caller's organization are dropped server-side. We never throw 500
 * back to the client for analytics — a write failure must not break the
 * surface emitting the event.
 */
import type { Express, Request, Response } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../storage";
import { requireUser } from "../auth";
import { qInt } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import {
  aiEngagementEvents,
  AI_ENGAGEMENT_SURFACES,
  AI_ENGAGEMENT_EVENT_TYPES,
} from "@shared/schema";

const eventSchema = z.object({
  surface: z.string().min(1).max(60),
  feature: z.string().max(120).nullable().optional(),
  eventType: z.string().min(1).max(40),
  targetId: z.string().max(120).nullable().optional(),
  meta: z.unknown().optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

function isAdminish(role: string | null | undefined) {
  return role === "admin" || role === "director" || role === "sales_director";
}

export function registerAiEngagementRoutes(app: Express) {
  app.post("/api/ai-engagement/events", requireUser, async (req: Request, res: Response) => {
    try {
      const me = req.user!;
      const parsed = batchSchema.parse(req.body ?? {});
      const rows = parsed.events
        .filter((e) => AI_ENGAGEMENT_EVENT_TYPES.includes(e.eventType as typeof AI_ENGAGEMENT_EVENT_TYPES[number]))
        .map((e) => ({
          organizationId: me.organizationId,
          userId: me.id,
          surface: e.surface,
          feature: e.feature ?? null,
          eventType: e.eventType,
          targetId: e.targetId ?? null,
          meta: (e.meta ?? null) as object | null,
        }));
      if (rows.length === 0) return res.json({ inserted: 0 });
      await db.insert(aiEngagementEvents).values(rows);
      res.json({ inserted: rows.length });
    } catch (err) {
      // Telemetry failures must not break callers. Always 200.
      console.warn("[ai-engagement] insert failed:", getErrorMessage(err));
      res.json({ inserted: 0 });
    }
  });

  app.get("/api/ai-engagement/overview", requireUser, async (req: Request, res: Response) => {
    try {
      const me = req.user!;
      if (!isAdminish(me.role)) return res.status(403).json({ error: "Forbidden" });

      const days = Math.min(90, Math.max(1, qInt(req.query.days, 30)));
      const since = new Date(Date.now() - days * 86400_000);

      const rows = await db
        .select({
          surface: aiEngagementEvents.surface,
          eventType: aiEngagementEvents.eventType,
          count: sql<number>`COUNT(*)::int`,
          users: sql<number>`COUNT(DISTINCT ${aiEngagementEvents.userId})::int`,
        })
        .from(aiEngagementEvents)
        .where(and(
          eq(aiEngagementEvents.organizationId, me.organizationId),
          gte(aiEngagementEvents.createdAt, since),
        ))
        .groupBy(aiEngagementEvents.surface, aiEngagementEvents.eventType);

      type Bucket = {
        surface: string;
        impressions: number;
        clicks: number;
        accepts: number;
        applies: number;
        copies: number;
        dismisses: number;
        thumbsUp: number;
        thumbsDown: number;
        uniqueUsers: number;
      };
      const bySurface = new Map<string, Bucket>();
      const ensure = (surface: string): Bucket => {
        let b = bySurface.get(surface);
        if (!b) {
          b = {
            surface,
            impressions: 0, clicks: 0, accepts: 0, applies: 0,
            copies: 0, dismisses: 0, thumbsUp: 0, thumbsDown: 0,
            uniqueUsers: 0,
          };
          bySurface.set(surface, b);
        }
        return b;
      };
      for (const r of rows) {
        const b = ensure(r.surface);
        switch (r.eventType) {
          case "impression": b.impressions += r.count; b.uniqueUsers = Math.max(b.uniqueUsers, r.users); break;
          case "click": b.clicks += r.count; break;
          case "accept": b.accepts += r.count; break;
          case "apply": b.applies += r.count; break;
          case "copy": b.copies += r.count; break;
          case "dismiss": b.dismisses += r.count; break;
          case "thumbs_up": b.thumbsUp += r.count; break;
          case "thumbs_down": b.thumbsDown += r.count; break;
        }
      }

      // Surfaces in the registry that have *no* data for the window — these
      // are the consolidation candidates the admin page wants to see.
      for (const s of AI_ENGAGEMENT_SURFACES) {
        if (!bySurface.has(s)) ensure(s);
      }

      const surfaces = [...bySurface.values()].map((b) => {
        const ctr = b.impressions > 0 ? b.clicks / b.impressions : 0;
        const acceptRate = b.impressions > 0
          ? (b.accepts + b.applies) / b.impressions
          : 0;
        const dismissRate = b.impressions > 0 ? b.dismisses / b.impressions : 0;
        return { ...b, ctr, acceptRate, dismissRate };
      }).sort((a, b) => b.impressions - a.impressions);

      res.json({ days, surfaces });
    } catch (err) {
      console.error("[ai-engagement] overview error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
