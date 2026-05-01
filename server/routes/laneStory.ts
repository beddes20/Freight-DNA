// Task #873 — Lane Story endpoints.
//
//   GET  /api/lanes/story/:laneSignature
//        Returns { header, timeline, outcomes30d } for a recurring lane,
//        or 404 with { recurring: false, prefill: {...} } when the
//        signature does not map to a recurring lane in the rep's org.
//
//   GET  /api/users/me/lane-inbox-prefs
//   PATCH /api/users/me/lane-inbox-prefs
//        Read / write the per-user "Group by Lane" toggle for the Lane
//        Inbox page.

import type { Express } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import { db, storage } from "../storage";
import { qOptStr, pStr } from "../lib/req";
import {
  parseLaneSignature,
  findRecurringLanesBySig,
  buildLaneStoryHeader,
  buildLaneStoryTimeline,
  buildLaneStoryOutcomes30d,
  type LaneStoryNotRecurring,
  type LaneStoryPayload,
} from "../services/laneStory";

const updatePrefsSchema = z.object({
  groupByLane: z.boolean(),
});

export function registerLaneStoryRoutes(app: Express): void {
  // ── Lane Story payload ────────────────────────────────────────────────
  app.get("/api/lanes/story/:laneSignature", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const orgId = user.organizationId;
      if (!orgId) return res.status(403).json({ error: "No organization" });

      // Express decodes the path segment — but defensively decode again so
      // double-encoded callers (some test harnesses) still resolve correctly.
      const rawSig = pStr(req.params.laneSignature);
      let signature = rawSig;
      try {
        if (signature.includes("%")) signature = decodeURIComponent(signature);
      } catch {
        // bad encoding — fall back to the raw value
      }
      const parts = parseLaneSignature(signature);
      if (!parts) {
        return res.status(400).json({ error: "Invalid lane signature" });
      }

      const lanes = await findRecurringLanesBySig(db, orgId, signature);
      if (lanes.length === 0) {
        const payload: LaneStoryNotRecurring = {
          recurring: false,
          prefill: {
            originCity: parts.origin,
            originState: parts.originState,
            destCity: parts.destination,
            destState: parts.destinationState,
            equipment: parts.equipmentType,
          },
        };
        return res.status(404).json(payload);
      }

      const cursor = qOptStr(req.query.cursor) ?? null;
      const now = new Date();
      const laneIds = lanes.map((l) => l.id);
      const [header, timeline, outcomes30d] = await Promise.all([
        buildLaneStoryHeader(db, orgId, signature, lanes, now),
        buildLaneStoryTimeline(db, orgId, signature, laneIds, cursor),
        buildLaneStoryOutcomes30d(db, orgId, signature, laneIds, now),
      ]);

      const payload: LaneStoryPayload = { header, timeline, outcomes30d };
      res.json(payload);
    } catch (err) {
      console.error("[lane-story] error:", err);
      res.status(500).json({ error: "Failed to load lane story" });
    }
  });

  // ── Lane Inbox prefs (Group by Lane toggle) ──────────────────────────
  app.get("/api/users/me/lane-inbox-prefs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const prefs = await storage.getUserLaneInboxPrefs(user.id);
      res.json({ groupByLane: prefs?.groupByLane ?? false });
    } catch (err) {
      console.error("[lane-inbox-prefs] read error:", err);
      res.status(500).json({ error: "Failed to load lane inbox prefs" });
    }
  });

  app.patch("/api/users/me/lane-inbox-prefs", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const body = updatePrefsSchema.parse(req.body);
      const updated = await storage.upsertUserLaneInboxPrefs({
        userId: user.id,
        groupByLane: body.groupByLane,
      });
      res.json({ groupByLane: updated.groupByLane });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request", details: err.errors });
      }
      console.error("[lane-inbox-prefs] write error:", err);
      res.status(500).json({ error: "Failed to save lane inbox prefs" });
    }
  });
}
