/**
 * Admin Routes — Monitored Mailboxes (Task #230)
 *
 * CRUD + sync-trigger endpoints for managing which NAM/AM mailboxes
 * are monitored for customer email auto-sync.
 *
 * GET    /api/internal/admin/monitored-mailboxes
 * POST   /api/internal/admin/monitored-mailboxes
 * PATCH  /api/internal/admin/monitored-mailboxes/:id
 * DELETE /api/internal/admin/monitored-mailboxes/:id
 * POST   /api/internal/admin/monitored-mailboxes/:id/sync
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { registerMailboxSubscription, removeMailboxSubscription } from "../graphSubscriptionService";
import { syncMailboxDelta } from "../services/mailboxDeltaSyncService";

function requireAdmin(req: Request, res: Response, next: () => void) {
  getCurrentUser(req).then(user => {
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!["admin", "director", "sales_director"].includes(user.role)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  }).catch(() => res.status(500).json({ error: "Auth error" }));
}

export function registerMonitoredMailboxRoutes(app: Express): void {

  app.get("/api/internal/admin/monitored-mailboxes", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const mailboxes = await storage.getMonitoredMailboxes(user.organizationId);

      const userIds = [...new Set(mailboxes.map(m => m.userId))];
      const userMap = new Map<string, string>();
      await Promise.all(userIds.map(async id => {
        const u = await storage.getUser(id);
        if (u) userMap.set(id, u.name);
      }));

      const enriched = mailboxes.map(m => ({
        ...m,
        userName: userMap.get(m.userId) ?? "Unknown",
      }));

      res.json({ mailboxes: enriched });
    } catch (err) {
      console.error("[monitoredMailboxes] GET error:", err);
      res.status(500).json({ error: "Failed to fetch monitored mailboxes" });
    }
  });

  app.post("/api/internal/admin/monitored-mailboxes", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const schema = z.object({
        userId: z.string(),
        email: z.string().email(),
        enabled: z.boolean().default(true),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const targetUser = await storage.getUser(parsed.data.userId);
      if (!targetUser || targetUser.organizationId !== user.organizationId) {
        return res.status(400).json({ error: "User not found in your organization" });
      }

      const existing = await storage.getMonitoredMailboxByEmail(user.organizationId, parsed.data.email);
      if (existing) {
        return res.status(409).json({ error: "This email is already being monitored" });
      }

      const mailbox = await storage.createMonitoredMailbox({
        orgId: user.organizationId,
        userId: parsed.data.userId,
        email: parsed.data.email,
        enabled: parsed.data.enabled,
      });

      if (mailbox.enabled) {
        registerMailboxSubscription(mailbox.email, mailbox.id).catch(err => {
          console.error("[monitoredMailboxes] Subscription registration error:", err);
        });
      }

      res.status(201).json({ mailbox });
    } catch (err) {
      console.error("[monitoredMailboxes] POST error:", err);
      res.status(500).json({ error: "Failed to create monitored mailbox" });
    }
  });

  app.patch("/api/internal/admin/monitored-mailboxes/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const existing = await storage.getMonitoredMailbox(req.params.id);
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      const schema = z.object({
        enabled: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const updated = await storage.updateMonitoredMailbox(req.params.id, parsed.data);

      if (parsed.data.enabled === true && !existing.enabled) {
        registerMailboxSubscription(existing.email, existing.id).catch(err => {
          console.error("[monitoredMailboxes] Subscription registration error:", err);
        });
      } else if (parsed.data.enabled === false && existing.enabled && (existing.subscriptionId || existing.sentItemsSubscriptionId)) {
        const primarySubId = existing.subscriptionId ?? existing.sentItemsSubscriptionId!;
        removeMailboxSubscription(primarySubId, existing.id).catch(err => {
          console.error("[monitoredMailboxes] Subscription removal error:", err);
        });
      }

      res.json({ mailbox: updated });
    } catch (err) {
      console.error("[monitoredMailboxes] PATCH error:", err);
      res.status(500).json({ error: "Failed to update monitored mailbox" });
    }
  });

  app.delete("/api/internal/admin/monitored-mailboxes/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const existing = await storage.getMonitoredMailbox(req.params.id);
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      if (existing.subscriptionId || existing.sentItemsSubscriptionId) {
        const primarySubId = existing.subscriptionId ?? existing.sentItemsSubscriptionId!;
        await removeMailboxSubscription(primarySubId, existing.id).catch(() => {});
      }

      await storage.deleteMonitoredMailbox(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[monitoredMailboxes] DELETE error:", err);
      res.status(500).json({ error: "Failed to delete monitored mailbox" });
    }
  });

  app.post("/api/internal/admin/monitored-mailboxes/:id/sync", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const existing = await storage.getMonitoredMailbox(req.params.id);
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      if (!existing.enabled) {
        return res.status(400).json({ error: "Mailbox is disabled — enable it before syncing" });
      }

      const needsSubscription =
        existing.syncStatus === "error" ||
        (!existing.subscriptionId && !existing.sentItemsSubscriptionId);

      if (needsSubscription) {
        await registerMailboxSubscription(existing.email, existing.id);
        const refreshed = await storage.getMonitoredMailbox(existing.id);
        if (refreshed?.syncStatus === "error") {
          return res.json({ ok: false, processed: 0, errors: 1, error: refreshed.syncError });
        }
      }

      const result = await syncMailboxDelta(existing.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[monitoredMailboxes] POST /sync error:", err);
      res.status(500).json({ error: "Failed to trigger sync" });
    }
  });
}
