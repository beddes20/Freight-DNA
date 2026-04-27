/**
 * Task #701 — Integrations Health Console.
 *
 * One admin endpoint that fans out to a registered probe per integration,
 * persists a snapshot, and returns the latest state. The Integrations
 * Health page renders one card per source from the snapshot.
 *
 * Probes are intentionally cheap (read in-memory state from the integration
 * client / read the most recent rolling event, no live external call by
 * default). The admin "test now" button re-probes a single source which
 * may make a live call.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import { requireUser } from "../auth";
import { pStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import { integrationHealthSnapshots } from "@shared/schema";
import { runAllProbes, runOneProbe, INTEGRATION_SOURCES } from "../integrations/probeRegistry";

function isAdmin(role: string | null | undefined) { return role === "admin"; }

export function registerIntegrationsHealthRoutes(app: Express) {
  // Public-to-rep read of the *current* state for one source — drives the
  // small <IntegrationDegradedPill /> component in the rate widgets and
  // email pages. Anyone authenticated can read it.
  app.get("/api/integrations/health/:source", requireUser, async (req: Request, res: Response) => {
    try {
      const source = pStr(req.params.source);
      if (!INTEGRATION_SOURCES.includes(source as typeof INTEGRATION_SOURCES[number])) {
        return res.status(404).json({ error: "Unknown integration source" });
      }
      const [latest] = await db
        .select()
        .from(integrationHealthSnapshots)
        .where(eq(integrationHealthSnapshots.source, source))
        .orderBy(desc(integrationHealthSnapshots.createdAt))
        .limit(1);
      if (!latest) return res.json({ source, healthState: "unknown", connected: false });
      res.json(latest);
    } catch (err) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.get("/api/admin/integrations/health", requireUser, async (req: Request, res: Response) => {
    try {
      const me = req.user!;
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Forbidden" });
      const snapshots = await runAllProbes();
      // Persist each snapshot for trend analysis + first-time-degraded notif.
      try {
        await db.insert(integrationHealthSnapshots).values(snapshots.map((s) => ({
          source: s.source,
          connected: s.connected,
          healthState: s.healthState,
          lastSuccessAt: s.lastSuccessAt ?? null,
          lastErrorAt: s.lastErrorAt ?? null,
          lastErrorMessage: s.lastErrorMessage ?? null,
          breakerState: s.breakerState ?? null,
          detail: (s.detail ?? null) as object | null,
        })));
      } catch (err) {
        console.warn("[integrations-health] snapshot persist failed:", getErrorMessage(err));
      }
      res.json({ snapshots });
    } catch (err) {
      console.error("[integrations-health] error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  app.post("/api/admin/integrations/health/:source/test", requireUser, async (req: Request, res: Response) => {
    try {
      const me = req.user!;
      if (!isAdmin(me.role)) return res.status(403).json({ error: "Forbidden" });
      const source = pStr(req.params.source);
      if (!INTEGRATION_SOURCES.includes(source as typeof INTEGRATION_SOURCES[number])) {
        return res.status(404).json({ error: "Unknown integration source" });
      }
      const snapshot = await runOneProbe(source as typeof INTEGRATION_SOURCES[number], { liveProbe: true });
      try {
        await db.insert(integrationHealthSnapshots).values({
          source: snapshot.source,
          connected: snapshot.connected,
          healthState: snapshot.healthState,
          lastSuccessAt: snapshot.lastSuccessAt ?? null,
          lastErrorAt: snapshot.lastErrorAt ?? null,
          lastErrorMessage: snapshot.lastErrorMessage ?? null,
          breakerState: snapshot.breakerState ?? null,
          detail: (snapshot.detail ?? null) as object | null,
        });
      } catch { /* non-fatal */ }
      res.json(snapshot);
    } catch (err) {
      console.error("[integrations-health] test error:", err);
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });
}
