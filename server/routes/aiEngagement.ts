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
import { qInt, qOptStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import {
  aiEngagementEvents,
  users as usersTable,
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
      // Validate surface against the canonical registry. Unknown surfaces
      // are routed to an explicit `unknown_surface` bucket (with the
      // submitted name in `meta.requestedSurface`) so accidental typos
      // don't silently pollute the analytics table with drifted surface
      // names — they show up as a single, easy-to-spot bucket instead.
      const KNOWN_SURFACES = new Set<string>(AI_ENGAGEMENT_SURFACES as readonly string[]);
      const rows = parsed.events
        .filter((e) => AI_ENGAGEMENT_EVENT_TYPES.includes(e.eventType as typeof AI_ENGAGEMENT_EVENT_TYPES[number]))
        .map((e) => {
          const known = KNOWN_SURFACES.has(e.surface);
          const surface = known ? e.surface : "unknown_surface";
          const meta = (e.meta ?? null) as Record<string, unknown> | null;
          const finalMeta = known
            ? meta
            : { ...(meta ?? {}), requestedSurface: e.surface };
          return {
            organizationId: me.organizationId,
            userId: me.id,
            surface,
            feature: e.feature ?? null,
            eventType: e.eventType,
            targetId: e.targetId ?? null,
            meta: finalMeta as object | null,
          };
        });
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
      const surfaceFilter = qOptStr(req.query.surface);

      const baseFilter = surfaceFilter
        ? and(
            eq(aiEngagementEvents.organizationId, me.organizationId),
            gte(aiEngagementEvents.createdAt, since),
            eq(aiEngagementEvents.surface, surfaceFilter),
          )
        : and(
            eq(aiEngagementEvents.organizationId, me.organizationId),
            gte(aiEngagementEvents.createdAt, since),
          );

      const rows = await db
        .select({
          surface: aiEngagementEvents.surface,
          eventType: aiEngagementEvents.eventType,
          count: sql<number>`COUNT(*)::int`,
          users: sql<number>`COUNT(DISTINCT ${aiEngagementEvents.userId})::int`,
        })
        .from(aiEngagementEvents)
        .where(baseFilter)
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

      // ── Top users (org-scoped, joined to users for display name) ────────────
      const topUserRows = await db
        .select({
          userId: aiEngagementEvents.userId,
          name: usersTable.name,
          username: usersTable.username,
          impressions: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} = 'impression' THEN 1 ELSE 0 END)::int`,
          accepts: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} IN ('accept','apply') THEN 1 ELSE 0 END)::int`,
          total: sql<number>`COUNT(*)::int`,
        })
        .from(aiEngagementEvents)
        .leftJoin(usersTable, eq(usersTable.id, aiEngagementEvents.userId))
        .where(baseFilter)
        .groupBy(aiEngagementEvents.userId, usersTable.name, usersTable.username)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10);
      const topUsers = topUserRows.map((u) => ({
        userId: u.userId,
        name: u.name || u.username || "(unknown)",
        impressions: u.impressions,
        accepts: u.accepts,
        total: u.total,
        acceptRate: u.impressions > 0 ? u.accepts / u.impressions : 0,
      }));

      // ── Per-feature leaderboard (most + least engaged features) ─────────────
      const featureRows = await db
        .select({
          surface: aiEngagementEvents.surface,
          feature: aiEngagementEvents.feature,
          impressions: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} = 'impression' THEN 1 ELSE 0 END)::int`,
          accepts: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} IN ('accept','apply') THEN 1 ELSE 0 END)::int`,
          dismisses: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} = 'dismiss' THEN 1 ELSE 0 END)::int`,
        })
        .from(aiEngagementEvents)
        .where(baseFilter)
        .groupBy(aiEngagementEvents.surface, aiEngagementEvents.feature);
      const featureBuckets = featureRows
        .filter((f) => f.feature !== null)
        .map((f) => ({
          surface: f.surface,
          feature: f.feature as string,
          impressions: f.impressions,
          accepts: f.accepts,
          dismisses: f.dismisses,
          acceptRate: f.impressions > 0 ? f.accepts / f.impressions : 0,
          dismissRate: f.impressions > 0 ? f.dismisses / f.impressions : 0,
        }));
      // `most` = features with at least one impression, ranked by accept rate.
      // `least` = the same set ranked the other way (low accept rate).
      // `zeroImpression` = features tracked (any event type) but never shown
      // to a user — these are the strongest "kill or merge" candidates and
      // are the explicit deliverable from the AI Engagement task.
      const withImpressions = featureBuckets.filter((f) => f.impressions > 0);
      const zeroImpression = featureBuckets.filter((f) => f.impressions === 0);
      const featureLeaderboard = {
        most: [...withImpressions].sort((a, b) => b.acceptRate - a.acceptRate).slice(0, 10),
        least: [...withImpressions].sort((a, b) => a.acceptRate - b.acceptRate).slice(0, 10),
        zeroImpression: zeroImpression.slice(0, 20),
      };

      // ── Time series (impressions per day for sparkline) ─────────────────────
      const seriesRows = await db
        .select({
          day: sql<string>`to_char(${aiEngagementEvents.createdAt}, 'YYYY-MM-DD')`,
          impressions: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} = 'impression' THEN 1 ELSE 0 END)::int`,
          accepts: sql<number>`SUM(CASE WHEN ${aiEngagementEvents.eventType} IN ('accept','apply') THEN 1 ELSE 0 END)::int`,
          total: sql<number>`COUNT(*)::int`,
        })
        .from(aiEngagementEvents)
        .where(baseFilter)
        .groupBy(sql`to_char(${aiEngagementEvents.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${aiEngagementEvents.createdAt}, 'YYYY-MM-DD')`);
      const timeSeries = seriesRows.map((s) => ({
        day: s.day,
        impressions: s.impressions,
        accepts: s.accepts,
        total: s.total,
      }));

      res.json({
        days,
        surface: surfaceFilter ?? null,
        availableSurfaces: AI_ENGAGEMENT_SURFACES,
        surfaces,
        topUsers,
        featureLeaderboard,
        timeSeries,
      });
    } catch (err) {
      console.error("[ai-engagement] overview error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
