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
import { syncMailboxDelta, retryMailboxSyncFailure } from "../services/mailboxDeltaSyncService";
import {
  runBackfillForMailbox,
  runBackfillForAllEnabledMailboxes,
  triggerBackfillInBackground,
} from "../services/mailboxHistoricalBackfillService";

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

      // Task #435: include SentItems coverage health so admins can spot
      // mailboxes whose webhook silently stopped delivering rep replies.
      const { getMailboxSentItemsHealth } = await import("../services/conversationReplyCaptureService");
      const enriched = mailboxes.map(m => ({
        ...m,
        userName: userMap.get(m.userId) ?? "Unknown",
        sentItemsHealth: getMailboxSentItemsHealth(m),
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
        // Task #508 — auto-trigger 30-day historical backfill on first
        // monitored-mailbox insert. Runs in the background so the HTTP
        // response returns immediately; idempotent if a completed backfill
        // already exists.
        triggerBackfillInBackground(mailbox.id, { triggeredBy: "auto" });
      }

      res.status(201).json({ mailbox });
    } catch (err) {
      console.error("[monitoredMailboxes] POST error:", err);
      res.status(500).json({ error: "Failed to create monitored mailbox" });
    }
  });

  // Task #473 — Bulk-enroll all eligible org users as monitored mailboxes.
  // Idempotent: skips users already monitored in this org without changing
  // their `enabled` value. Reuses createMonitoredMailbox + subscription
  // registration so newly-added rows go through the normal pending → active
  // path.
  app.post("/api/internal/admin/monitored-mailboxes/enroll-all", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const ELIGIBLE_ROLES = [
        "national_account_manager",
        "account_manager",
        "admin",
        "director",
        "sales_director",
      ];

      const allUsers = await storage.getUsers(user.organizationId);
      const eligible = allUsers.filter(u => ELIGIBLE_ROLES.includes(u.role) && !!u.username);

      const existing = await storage.getMonitoredMailboxes(user.organizationId);
      const existingEmails = new Set(existing.map(m => m.email.toLowerCase()));
      const existingUserIds = new Set(existing.map(m => m.userId));

      let added = 0;
      let skipped = 0;
      let failed = 0;
      const created: typeof existing = [];
      const failures: Array<{ userId: string; email: string; error: string }> = [];

      for (const u of eligible) {
        const email = u.username.toLowerCase();
        if (existingUserIds.has(u.id) || existingEmails.has(email)) {
          skipped++;
          continue;
        }
        try {
          const mailbox = await storage.createMonitoredMailbox({
            orgId: user.organizationId,
            userId: u.id,
            email,
            enabled: true,
          });
          existingEmails.add(email);
          existingUserIds.add(u.id);
          created.push(mailbox);
          added++;
        } catch (err: any) {
          // Race-condition: unique index (orgId,email) tripped because
          // another request created the row concurrently. Treat as skip.
          // Postgres unique_violation = SQLSTATE 23505.
          const isUniqueViolation =
            err?.code === "23505" ||
            /duplicate key|unique constraint/i.test(err?.message ?? "");
          if (isUniqueViolation) {
            skipped++;
          } else {
            console.error("[monitoredMailboxes] enroll-all create error:", err);
            failed++;
            failures.push({ userId: u.id, email, error: err?.message ?? "Unknown error" });
          }
        }
      }

      // Fire subscription registration in the background (mirrors POST path).
      // Task #508 — also auto-trigger the 30-day historical backfill so the
      // newly-enrolled mailbox immediately starts pulling its history.
      for (const mailbox of created) {
        if (mailbox.enabled) {
          registerMailboxSubscription(mailbox.email, mailbox.id).catch(err => {
            console.error("[monitoredMailboxes] enroll-all subscription error:", err);
          });
          triggerBackfillInBackground(mailbox.id, { triggeredBy: "auto" });
        }
      }

      res.json({ added, skipped, failed, eligible: eligible.length, failures });
    } catch (err) {
      console.error("[monitoredMailboxes] POST /enroll-all error:", err);
      res.status(500).json({ error: "Failed to enroll users" });
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

  // ── Task #438 — Per-message sync failure diagnostics + self-heal ──────────

  const failureListParams = z.object({ id: z.string().min(1) });
  const failureActionParams = z.object({ id: z.string().min(1), failureId: z.string().min(1) });

  app.get("/api/internal/admin/monitored-mailboxes/:id/failures", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const parsedParams = failureListParams.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid params", details: parsedParams.error.flatten() });

      const mailbox = await storage.getMonitoredMailbox(parsedParams.data.id);
      if (!mailbox || mailbox.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      const failures = await storage.getUnresolvedMailboxSyncFailures(mailbox.id);
      res.json({ failures });
    } catch (err) {
      console.error("[monitoredMailboxes] GET /failures error:", err);
      res.status(500).json({ error: "Failed to fetch sync failures" });
    }
  });

  app.post("/api/internal/admin/monitored-mailboxes/:id/failures/:failureId/retry", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const parsedParams = failureActionParams.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid params", details: parsedParams.error.flatten() });

      const mailbox = await storage.getMonitoredMailbox(parsedParams.data.id);
      if (!mailbox || mailbox.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      const failure = await storage.getMailboxSyncFailure(parsedParams.data.failureId);
      if (!failure || failure.mailboxId !== mailbox.id || failure.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Sync failure not found" });
      }

      const result = await retryMailboxSyncFailure(failure.id);
      res.json(result);
    } catch (err) {
      console.error("[monitoredMailboxes] POST /failures/retry error:", err);
      res.status(500).json({ error: "Failed to retry sync failure" });
    }
  });

  // ── Task #508 — 30-day historical backfill admin endpoints ────────────────

  app.post("/api/internal/admin/monitored-mailboxes/:id/backfill", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const mailbox = await storage.getMonitoredMailbox(req.params.id);
      if (!mailbox || mailbox.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }
      if (!mailbox.enabled) {
        return res.status(400).json({ error: "Mailbox is disabled — enable it before backfilling" });
      }
      // Run synchronously so the admin gets back final counts. The window is
      // capped (10k messages per folder) and per-mailbox runs are bounded.
      const result = await runBackfillForMailbox(mailbox.id, {
        triggeredBy: "admin",
        triggeredByUserId: user.id,
      });
      res.json(result);
    } catch (err) {
      console.error("[monitoredMailboxes] POST /backfill error:", err);
      res.status(500).json({ error: "Failed to run backfill" });
    }
  });

  app.post("/api/internal/admin/monitored-mailboxes/backfill-all", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const result = await runBackfillForAllEnabledMailboxes(user.organizationId, {
        triggeredBy: "admin_bulk",
        triggeredByUserId: user.id,
      });
      res.json(result);
    } catch (err) {
      console.error("[monitoredMailboxes] POST /backfill-all error:", err);
      res.status(500).json({ error: "Failed to run bulk backfill" });
    }
  });

  app.get("/api/internal/admin/monitored-mailboxes/:id/backfill", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const mailbox = await storage.getMonitoredMailbox(req.params.id);
      if (!mailbox || mailbox.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }
      const latest = await storage.getLatestMailboxHistoricalBackfill(mailbox.id);
      res.json({ backfill: latest ?? null });
    } catch (err) {
      console.error("[monitoredMailboxes] GET /backfill error:", err);
      res.status(500).json({ error: "Failed to fetch backfill status" });
    }
  });

  app.get("/api/internal/admin/monitored-mailboxes/backfills", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      const all = await storage.getMailboxHistoricalBackfillsForOrg(user.organizationId);
      // Latest per mailbox.
      const byMailbox = new Map<string, typeof all[number]>();
      for (const r of all) {
        if (!byMailbox.has(r.mailboxId)) byMailbox.set(r.mailboxId, r);
      }
      res.json({ backfills: Array.from(byMailbox.values()) });
    } catch (err) {
      console.error("[monitoredMailboxes] GET /backfills error:", err);
      res.status(500).json({ error: "Failed to fetch backfills" });
    }
  });

  app.post("/api/internal/admin/monitored-mailboxes/:id/failures/:failureId/dismiss", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const parsedParams = failureActionParams.safeParse(req.params);
      if (!parsedParams.success) return res.status(400).json({ error: "Invalid params", details: parsedParams.error.flatten() });

      const mailbox = await storage.getMonitoredMailbox(parsedParams.data.id);
      if (!mailbox || mailbox.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      const failure = await storage.getMailboxSyncFailure(parsedParams.data.failureId);
      if (!failure || failure.mailboxId !== mailbox.id || failure.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Sync failure not found" });
      }

      const dismissed = await storage.markMailboxSyncFailureDismissed(failure.id, user.organizationId);

      // Recompute mailbox status now that an unresolved failure is gone.
      const unresolved = await storage.countUnresolvedMailboxSyncFailures(mailbox.id);
      await storage.updateMonitoredMailbox(mailbox.id, {
        syncStatus: unresolved > 0 ? "partial" : "active",
        syncError: unresolved > 0 ? `${unresolved} message(s) failed` : null,
      });

      res.json({ ok: true, failure: dismissed });
    } catch (err) {
      console.error("[monitoredMailboxes] POST /failures/dismiss error:", err);
      res.status(500).json({ error: "Failed to dismiss sync failure" });
    }
  });
}
