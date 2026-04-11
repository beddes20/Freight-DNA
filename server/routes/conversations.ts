/**
 * Conversations Routes (Task #202)
 *
 * Org-scoped CRUD for email_conversation_threads — ownership, waiting state, priority.
 *
 * GET  /api/internal/conversations
 * POST /api/internal/conversations/:id/owner
 * POST /api/internal/conversations/:id/waiting-state
 * POST /api/internal/conversations/:id/priority
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { setWaitingState, setPriority } from "../services/conversationWaitingStateService";
import { assignOwner } from "../services/conversationOwnershipService";

export function registerConversationsRoutes(app: Express): void {

  // ── GET /api/internal/conversations/my-count ─────────────────────────────────
  // Returns the number of threads currently "waiting on me" (owned by the
  // requesting user with waitingState = 'waiting_on_us'). Used for the sidebar
  // badge so reps see how many conversations need their attention at a glance.
  app.get("/api/internal/conversations/my-count", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const threads = await storage.listEmailConversationThreads(user.organizationId, {
        ownerUserId: user.id,
        waitingState: "waiting_on_us",
        limit: 200,
      });
      res.json({ count: threads.length });
    } catch (err) {
      console.error("[conversations] GET /conversations/my-count error:", err);
      res.status(500).json({ error: "Failed to fetch count" });
    }
  });

  // ── GET /api/internal/conversations ─────────────────────────────────────────
  // Query filters: accountId, carrierId, ownerUserId, waitingState,
  // responsePriority, overdue=true|false, unowned=true
  app.get("/api/internal/conversations", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const orgId = user.organizationId;
      const { accountId, carrierId, ownerUserId, unowned, waitingState, responsePriority, overdue, threadId } = req.query;

      const filters: Parameters<typeof storage.listEmailConversationThreads>[1] = {};

      if (accountId) filters.linkedAccountId = accountId as string;
      if (carrierId) filters.linkedCarrierId = carrierId as string;
      if (threadId) filters.threadId = threadId as string;
      if (unowned === "true") {
        filters.unowned = true;
      } else if (ownerUserId) {
        filters.ownerUserId = ownerUserId as string;
      }
      if (waitingState) filters.waitingState = waitingState as string;
      if (responsePriority) filters.responsePriority = responsePriority as string;
      if (overdue === "true") filters.overdue = true;

      const threads = await storage.listEmailConversationThreads(orgId, filters);

      // Enrich with owner name
      const ownerIds = [...new Set(threads.map(t => t.ownerUserId).filter(Boolean) as string[])];
      const ownerMap = new Map<string, string>();
      await Promise.all(ownerIds.map(async id => {
        const u = await storage.getUser(id);
        if (u) ownerMap.set(id, u.name);
      }));

      const enriched = threads.map(t => ({
        ...t,
        ownerName: t.ownerUserId ? (ownerMap.get(t.ownerUserId) ?? null) : null,
      }));

      res.json({ count: enriched.length, threads: enriched });
    } catch (err) {
      console.error("[conversations] GET /conversations error:", err);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  // ── POST /api/internal/conversations/:id/owner ───────────────────────────────
  app.post("/api/internal/conversations/:id/owner", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ ownerUserId: z.string().nullable() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      await assignOwner(req.params.id, parsed.data.ownerUserId, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      res.json({ thread });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/owner error:", err);
      res.status(500).json({ error: "Failed to update owner" });
    }
  });

  // ── POST /api/internal/conversations/:id/waiting-state ──────────────────────
  app.post("/api/internal/conversations/:id/waiting-state", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ waitingState: z.enum(["waiting_on_us", "waiting_on_them", "resolved"]) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      await setWaitingState(req.params.id, parsed.data.waitingState, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      res.json({ thread });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/waiting-state error:", err);
      res.status(500).json({ error: "Failed to update waiting state" });
    }
  });

  // ── POST /api/internal/conversations/:id/priority ───────────────────────────
  app.post("/api/internal/conversations/:id/priority", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({ responsePriority: z.enum(["high", "normal", "low"]) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      await setPriority(req.params.id, parsed.data.responsePriority, user.organizationId, storage);
      const thread = await storage.getEmailConversationThreadById(req.params.id);
      if (!thread || thread.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      res.json({ thread });
    } catch (err) {
      console.error("[conversations] POST /conversations/:id/priority error:", err);
      res.status(500).json({ error: "Failed to update priority" });
    }
  });
}
