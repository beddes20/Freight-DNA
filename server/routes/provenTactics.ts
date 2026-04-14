import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, getCurrentUser } from "../auth";
import {
  getProvenTacticsForSignal,
  getAllProvenTactics,
  getTacticStats,
  recordTacticOutcome,
  captureTacticFromResponse,
} from "../services/tacticalLearningService";

export function registerProvenTacticsRoutes(app: Express): void {

  app.get("/api/internal/proven-tactics", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { signalType, outcome } = req.query;
      const tactics = await getAllProvenTactics(user.organizationId, {
        signalType: signalType as string | undefined,
        outcome: outcome as string | undefined,
      });
      res.json({ tactics });
    } catch (err) {
      console.error("[proven-tactics] GET error:", err);
      res.status(500).json({ error: "Failed to fetch tactics" });
    }
  });

  app.get("/api/internal/proven-tactics/stats", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const stats = await getTacticStats(user.organizationId);
      res.json(stats);
    } catch (err) {
      console.error("[proven-tactics] stats error:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/api/internal/proven-tactics/for-signal", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const signalType = req.query.signalType as string;
      if (!signalType) return res.status(400).json({ error: "signalType is required" });

      const tactics = await getProvenTacticsForSignal(user.organizationId, signalType, 5);
      res.json({ tactics });
    } catch (err) {
      console.error("[proven-tactics] for-signal error:", err);
      res.status(500).json({ error: "Failed to fetch tactics for signal" });
    }
  });

  app.post("/api/internal/proven-tactics/:id/outcome", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ outcome: z.enum(["won", "lost"]) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

      const tactic = await recordTacticOutcome(req.params.id, parsed.data.outcome, user.organizationId);
      if (!tactic) return res.status(404).json({ error: "Tactic not found" });
      res.json({ tactic });
    } catch (err) {
      console.error("[proven-tactics] outcome error:", err);
      res.status(500).json({ error: "Failed to record outcome" });
    }
  });

  app.post("/api/internal/proven-tactics", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({
        signalType: z.string(),
        signalSubtype: z.string().optional(),
        tacticLabel: z.string(),
        tacticSummary: z.string(),
        exampleResponse: z.string(),
        sourceMessageId: z.string().optional(),
        sourceSignalId: z.string().optional(),
        linkedAccountId: z.string().optional(),
        accountName: z.string().optional(),
        outcome: z.enum(["pending", "won", "lost"]).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const tactic = await captureTacticFromResponse({
        orgId: user.organizationId,
        ...parsed.data,
        repUserId: user.id,
        repName: user.name,
      });
      res.json({ tactic });
    } catch (err) {
      console.error("[proven-tactics] create error:", err);
      res.status(500).json({ error: "Failed to create tactic" });
    }
  });
}
