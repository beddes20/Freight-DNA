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
import { pStr, qStr, qOptStr } from "../lib/req";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  registerMailboxSubscription,
  removeMailboxSubscription,
  getMailReadConsentStatus,
  getMailReadConsentStatusAsync,
  refreshMailReadConsentStatus,
  webhookSecretConfigured,
} from "../graphSubscriptionService";
import { azureCredentialsConfigured } from "../graphService";
import { syncMailboxDelta, retryMailboxSyncFailure } from "../services/mailboxDeltaSyncService";
import {
  runBackfillForMailbox,
  runBackfillForAllEnabledMailboxes,
  triggerBackfillInBackground,
} from "../services/mailboxHistoricalBackfillService";
import { db } from "../storage";
import { quoteOpportunities, emailMessages } from "@shared/schema";
import { classifyCoverage } from "../services/coverageClassifier";
import { and, eq, gte, sql } from "drizzle-orm";
import { getErrorMessage } from "../lib/errors";

// Roles whose users get a mailbox auto-enrolled by enroll-all and are
// counted as "eligible" for the coverage banner. Kept in one place so the
// enroll-all handler and the coverage endpoint never drift apart.
export const ELIGIBLE_ROLES: ReadonlyArray<string> = [
  "national_account_manager",
  "account_manager",
  "admin",
  "director",
  "sales_director",
  "logistics_manager",
];

// Fixture mailbox detection — see server/lib/fixtureMailboxes.ts for the
// full rationale. Re-exported so existing imports (and tests) keep working.
export {
  FIXTURE_MAILBOX_DOMAINS,
  isFixtureMailboxAddress,
} from "../lib/fixtureMailboxes";
import { isFixtureMailboxAddress } from "../lib/fixtureMailboxes";

async function persistSubscriptionFailure(
  mailbox: { id: string; orgId: string },
  err: unknown,
): Promise<void> {
  const errMsg = getErrorMessage(err);
  try {
    await storage.updateMonitoredMailbox(mailbox.id, {
      syncStatus: "error",
      syncError: `Subscription registration failed: ${errMsg}`,
    });
  } catch (uErr) {
    console.error("[monitoredMailboxes] sub-failure persist (mailbox) error:", uErr);
  }
  try {
    await storage.upsertMailboxSyncFailure({
      orgId: mailbox.orgId,
      mailboxId: mailbox.id,
      folder: "subscription",
      providerMessageId: `subscription:${mailbox.id}`,
      errorCategory: "subscription",
      errorMessage: errMsg,
      nextAttemptAt: null,
    });
  } catch (uErr) {
    console.error("[monitoredMailboxes] sub-failure persist (failures table) error:", uErr);
  }
}

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

      if (isFixtureMailboxAddress(parsed.data.email)) {
        return res.status(400).json({
          error: "Test/fixture mailbox addresses (e.g. @example.com) cannot be enrolled — they cannot be subscribed to in your Microsoft 365 tenant and would permanently appear unhealthy.",
        });
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
        registerMailboxSubscription(mailbox.email, mailbox.id).catch(async err => {
          console.error("[monitoredMailboxes] Subscription registration error:", err);
          await persistSubscriptionFailure(mailbox, err);
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

      const allUsers = await storage.getUsers(user.organizationId);
      const eligible = allUsers.filter(u => ELIGIBLE_ROLES.includes(u.role) && !!u.username);

      const existing = await storage.getMonitoredMailboxes(user.organizationId);
      const existingEmails = new Set(existing.map(m => m.email.toLowerCase()));
      const existingUserIds = new Set(existing.map(m => m.userId));

      // Task #517 — surface a per-user breakdown so the admin UI can show
      // exactly who got enrolled, who was already enrolled, who has no
      // mailbox, and who errored. Drives the "results panel" after the run.
      type EnrollOutcome =
        | "enrolled"
        | "already_enrolled"
        | "skipped_no_mailbox"
        | "error";
      interface EnrollResult {
        userId: string;
        userName: string;
        email: string | null;
        outcome: EnrollOutcome;
        error?: string;
      }
      const results: EnrollResult[] = [];
      let added = 0;
      let skipped = 0;
      let failed = 0;
      let skippedNoMailbox = 0;
      const created: typeof existing = [];

      // Capture users with no usable mailbox (no username/login email).
      for (const u of allUsers.filter(u => ELIGIBLE_ROLES.includes(u.role) && !u.username)) {
        skippedNoMailbox++;
        results.push({
          userId: u.id,
          userName: u.name,
          email: null,
          outcome: "skipped_no_mailbox",
        });
      }

      for (const u of eligible) {
        const email = u.username.toLowerCase();
        if (existingUserIds.has(u.id) || existingEmails.has(email)) {
          skipped++;
          results.push({ userId: u.id, userName: u.name, email, outcome: "already_enrolled" });
          continue;
        }
        // Skip test/fixture mailbox addresses — they can never be subscribed
        // in a real Microsoft 365 tenant and would permanently flip the
        // Conversations Inbox health badge to "unhealthy". This is the
        // long-standing root cause of the recurring "Webhook unhealthy" pill.
        if (isFixtureMailboxAddress(email)) {
          skippedNoMailbox++;
          results.push({ userId: u.id, userName: u.name, email, outcome: "skipped_no_mailbox" });
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
          results.push({ userId: u.id, userName: u.name, email, outcome: "enrolled" });
        } catch (err: unknown) {
          // Race-condition: unique index (orgId,email) tripped because
          // another request created the row concurrently. Treat as skip.
          // Postgres unique_violation = SQLSTATE 23505.
          const errCode = err && typeof err === "object" && "code" in err
            ? String((err as { code?: unknown }).code ?? "")
            : "";
          const errMsg = getErrorMessage(err);
          const isUniqueViolation =
            errCode === "23505" ||
            /duplicate key|unique constraint/i.test(errMsg);
          if (isUniqueViolation) {
            skipped++;
            results.push({ userId: u.id, userName: u.name, email, outcome: "already_enrolled" });
          } else {
            console.error("[monitoredMailboxes] enroll-all create error:", err);
            failed++;
            results.push({
              userId: u.id,
              userName: u.name,
              email,
              outcome: "error",
              error: errMsg || "Unknown error",
            });
          }
        }
      }

      // Fire subscription registration in the background (mirrors POST path).
      // Task #508 — also auto-trigger the 30-day historical backfill so the
      // newly-enrolled mailbox immediately starts pulling its history.
      // Subscription failures must NOT block enrollment of remaining users.
      for (const mailbox of created) {
        if (mailbox.enabled) {
          // Subscription registration is fire-and-forget so a single
          // failing user doesn't block the rest of the batch — but on
          // failure we now persist the error onto monitored_mailboxes so
          // the admin can see it on the mailbox card and the new
          // diagnostics panel without grepping logs (Task #727 — review).
          registerMailboxSubscription(mailbox.email, mailbox.id).catch(async err => {
            console.error("[monitoredMailboxes] enroll-all subscription error:", err);
            await persistSubscriptionFailure(mailbox, err);
          });
          triggerBackfillInBackground(mailbox.id, { triggeredBy: "auto" });
        }
      }

      // Backwards-compatible: keep `failures` as a flat list for callers
      // that already use it. New consumers should prefer `results`.
      const failures = results
        .filter(r => r.outcome === "error")
        .map(r => ({ userId: r.userId, email: r.email ?? "", error: r.error ?? "Unknown error" }));

      res.json({
        added,
        skipped,
        failed,
        skippedNoMailbox,
        eligible: eligible.length,
        totalConsidered: eligible.length + skippedNoMailbox,
        results,
        failures,
      });
    } catch (err) {
      console.error("[monitoredMailboxes] POST /enroll-all error:", err);
      res.status(500).json({ error: "Failed to enroll users" });
    }
  });

  app.patch("/api/internal/admin/monitored-mailboxes/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const existing = await storage.getMonitoredMailbox(pStr(req.params.id));
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      const schema = z.object({
        enabled: z.boolean().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });

      const updated = await storage.updateMonitoredMailbox(pStr(req.params.id), parsed.data);

      if (parsed.data.enabled === true && !existing.enabled) {
        registerMailboxSubscription(existing.email, existing.id).catch(async err => {
          console.error("[monitoredMailboxes] Subscription registration error:", err);
          await persistSubscriptionFailure(existing, err);
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

      const existing = await storage.getMonitoredMailbox(pStr(req.params.id));
      if (!existing || existing.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }

      if (existing.subscriptionId || existing.sentItemsSubscriptionId) {
        const primarySubId = existing.subscriptionId ?? existing.sentItemsSubscriptionId!;
        await removeMailboxSubscription(primarySubId, existing.id).catch(() => {});
      }

      await storage.deleteMonitoredMailbox(pStr(req.params.id));
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

      const existing = await storage.getMonitoredMailbox(pStr(req.params.id));
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
      const mailbox = await storage.getMonitoredMailbox(pStr(req.params.id));
      if (!mailbox || mailbox.orgId !== user.organizationId) {
        return res.status(404).json({ error: "Monitored mailbox not found" });
      }
      if (!mailbox.enabled) {
        return res.status(400).json({ error: "Mailbox is disabled — enable it before backfilling" });
      }
      // Run synchronously so the admin gets back final counts. The window is
      // capped (10k messages per folder) and per-mailbox runs are bounded.
      // Task #727 — runBackfillForMailbox now finalizes thread
      // classification for the org by default (so auto-backfill on
      // enrollment also lands correctly classified). The bulk caller
      // opts out via skipFinalize.
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
      const mailbox = await storage.getMonitoredMailbox(pStr(req.params.id));
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

  // -----------------------------------------------------------------------
  // Task #727 — Per-mailbox sync diagnostics.
  //
  // Returns a one-shot health snapshot for a single monitored mailbox so an
  // admin can answer "is this mailbox actually flowing?" without grepping
  // logs. Pulls together everything from monitored_mailboxes itself, the
  // latest mailbox_historical_backfills row, the unresolved-failure count,
  // and 7-day / 30-day ingest counts (split by direction + customer/carrier
  // linkage) from email_messages.
  // -----------------------------------------------------------------------
  app.get(
    "/api/internal/admin/monitored-mailboxes/:id/diagnostics",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const mailbox = await storage.getMonitoredMailbox(pStr(req.params.id));
        if (!mailbox || mailbox.orgId !== user.organizationId) {
          return res.status(404).json({ error: "Mailbox not found" });
        }

        const now = Date.now();
        const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

        // Per-mailbox ingest counts via email recipient (delta sync writes
        // are scoped by recipient address — same join used by
        // /quote-stats above). Split by window so the UI can show 7d / 30d
        // side by side, and by customer-vs-carrier linkage so admins can
        // immediately see whether the customer lane is actually flowing.
        const lowerEmail = mailbox.email.toLowerCase();
        const counts = await db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE em.created_at >= ${sevenDaysAgo})::int                                                    AS total_7d,
            COUNT(*) FILTER (WHERE em.created_at >= ${sevenDaysAgo} AND em.linked_account_id IS NOT NULL)::int               AS customer_7d,
            COUNT(*) FILTER (WHERE em.created_at >= ${sevenDaysAgo} AND em.linked_carrier_id IS NOT NULL AND em.linked_account_id IS NULL)::int AS carrier_7d,
            COUNT(*) FILTER (WHERE em.created_at >= ${sevenDaysAgo} AND em.direction = 'outbound')::int                       AS outbound_7d,
            COUNT(*) FILTER (WHERE em.created_at >= ${thirtyDaysAgo})::int                                                   AS total_30d,
            COUNT(*) FILTER (WHERE em.created_at >= ${thirtyDaysAgo} AND em.linked_account_id IS NOT NULL)::int              AS customer_30d,
            COUNT(*) FILTER (WHERE em.created_at >= ${thirtyDaysAgo} AND em.linked_carrier_id IS NOT NULL AND em.linked_account_id IS NULL)::int AS carrier_30d,
            COUNT(*) FILTER (WHERE em.created_at >= ${thirtyDaysAgo} AND em.direction = 'outbound')::int                      AS outbound_30d
          FROM email_messages em
          WHERE em.org_id = ${user.organizationId}
            AND (
              LOWER(em.to_email) = ${lowerEmail}
              OR LOWER(em.from_email) = ${lowerEmail}
            )
        `);
        type Row = { rows?: Array<Record<string, unknown>> };
        const raw = counts as unknown as Row;
        const r = raw.rows?.[0] ?? {};
        const num = (v: unknown) => Number((v as number | string | null) ?? 0);

        const latestBackfill = await storage.getLatestMailboxHistoricalBackfill(mailbox.id);
        const unresolvedFailures = await storage
          .countUnresolvedMailboxSyncFailures(mailbox.id)
          .catch(() => 0);

        // Surface the most recent unresolved failure so the operator can
        // triage from the diagnostics panel without opening the failures
        // table separately. Cap to 3 rows to keep the payload small.
        const recentFailures = await storage
          .getUnresolvedMailboxSyncFailures(mailbox.id)
          .then(rows => rows.slice(0, 3).map(f => ({
            id: f.id,
            providerMessageId: f.providerMessageId,
            errorCategory: f.errorCategory,
            errorMessage: f.errorMessage,
            attemptCount: f.attemptCount,
            lastAttemptAt: f.lastAttemptAt,
          })))
          .catch(() => []);

        res.json({
          mailbox: {
            id: mailbox.id,
            email: mailbox.email,
            enabled: mailbox.enabled,
            syncStatus: mailbox.syncStatus,
            syncError: mailbox.syncError,
            lastSyncAt: mailbox.lastSyncAt,
            lastSentItemsNotificationAt: mailbox.lastSentItemsNotificationAt,
            lastOutboundCapturedAt: mailbox.lastOutboundCapturedAt,
          },
          subscription: {
            inboxSubscriptionId: mailbox.subscriptionId,
            sentItemsSubscriptionId: mailbox.sentItemsSubscriptionId,
            expiresAt: mailbox.subscriptionExpiresAt,
            expired: mailbox.subscriptionExpiresAt
              ? mailbox.subscriptionExpiresAt.getTime() < now
              : null,
          },
          ingest: {
            last7d: {
              total: num(r.total_7d),
              customerLinked: num(r.customer_7d),
              carrierLinked: num(r.carrier_7d),
              outbound: num(r.outbound_7d),
            },
            last30d: {
              total: num(r.total_30d),
              customerLinked: num(r.customer_30d),
              carrierLinked: num(r.carrier_30d),
              outbound: num(r.outbound_30d),
            },
          },
          latestBackfill: latestBackfill ?? null,
          unresolvedFailures,
          recentFailures,
        });
      } catch (err) {
        console.error("[monitoredMailboxes] GET /diagnostics error:", err);
        res.status(500).json({ error: "Failed to load diagnostics" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // Task #727 — Rebuild thread classification.
  //
  // One-button admin action that:
  //   1. Materializes any missing email_conversation_threads rows for the
  //      org (covers messages that were ingested before threads existed).
  //   2. Drops linked_carrier_id on threads / user-mailbox-lane email
  //      messages where a linked_account_id is set — customer lane wins.
  //
  // Intended to be run after a bulk "Backfill last 30 days (all)" so any
  // historical messages that came in mis-classified are normalised in one
  // pass without reprocessing the inbox.
  // -----------------------------------------------------------------------
  app.post(
    "/api/internal/admin/monitored-mailboxes/rebuild-thread-classification",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const { backfillMissingConversationThreads, reclassifyThreadsCustomerWins } =
          await import("../services/conversationThreadBackfillService");
        const backfill = await backfillMissingConversationThreads({ orgId: user.organizationId });
        const reclassify = await reclassifyThreadsCustomerWins({ orgId: user.organizationId });
        res.json({ backfill, reclassify });
      } catch (err) {
        console.error("[monitoredMailboxes] POST /rebuild-thread-classification error:", err);
        res.status(500).json({ error: "Failed to rebuild thread classification" });
      }
    },
  );

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

  // -----------------------------------------------------------------------
  // Task #517 — Email-traffic coverage summary.
  //
  // Drives the banner shown on Email Intelligence + Customer Quoting tabs
  // so admins can see at a glance whether 30-day email ingestion is
  // actually flowing for their org. Three failure modes surface here:
  //   1. Zero mailboxes enrolled (eligible reps exist but nothing being read).
  //   2. Mail.Read tenant consent missing (Azure permission not granted).
  //   3. One or more mailbox backfills failed or never ran in the last 30d.
  //
  // The endpoint is read-only and safe for non-admin reps to call so the
  // banner can render on shared dashboards. We don't expose Azure errors
  // verbatim to non-admins to avoid leaking infra details.
  // -----------------------------------------------------------------------
  app.get(
    "/api/internal/admin/monitored-mailboxes/coverage",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const isAdmin = ["admin", "director", "sales_director"].includes(user.role);

        const allUsers = await storage.getUsers(user.organizationId);
        const eligibleUsers = allUsers.filter(
          u => ELIGIBLE_ROLES.includes(u.role) && !!u.username,
        );
        const mailboxes = await storage.getMonitoredMailboxes(user.organizationId);
        const enabled = mailboxes.filter(m => m.enabled);

        // Backfill state for each enabled mailbox — pull the latest run.
        let failedBackfills = 0;
        let neverBackfilled = 0;
        let succeededBackfills = 0;
        let totalSpotQuotesFromBackfill = 0;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        for (const m of enabled) {
          const latest = await storage.getLatestMailboxHistoricalBackfill(m.id);
          if (!latest) {
            neverBackfilled++;
            continue;
          }
          if (latest.status === "failed") {
            failedBackfills++;
          } else if (latest.status === "completed") {
            succeededBackfills++;
          }
        }

        // Org-aggregate count of spot-quote opportunities created from any
        // ingested email in the last 30 days. Joined via providerMessageId
        // → quoteOpportunities.sourceReference (the idempotency key set by
        // ingestQuoteFromEmail).
        try {
          const rows = await db
            .select({ n: sql<number>`count(*)::int` })
            .from(quoteOpportunities)
            .innerJoin(
              emailMessages,
              and(
                eq(emailMessages.orgId, quoteOpportunities.organizationId),
                eq(emailMessages.providerMessageId, quoteOpportunities.sourceReference),
              ),
            )
            .where(
              and(
                eq(quoteOpportunities.organizationId, user.organizationId),
                eq(quoteOpportunities.source, "email"),
                gte(quoteOpportunities.createdAt, thirtyDaysAgo),
                // Task #517 — only count quotes whose source email was
                // written by the historical 30-day backfill path. Live
                // delta-sync emails are tracked by other dashboards.
                eq(emailMessages.ingestedVia, "backfill"),
              ),
            );
          totalSpotQuotesFromBackfill = Number(rows[0]?.n ?? 0);
        } catch (err) {
          console.error("[monitoredMailboxes] coverage spot-quote count failed:", err);
        }

        // Use the DB-fresh accessor so a cold-start coverage call still
        // reflects persisted Mail.Read consent — otherwise the very first
        // request after a restart could falsely report "unknown" and
        // surface a misleading mail_read_missing banner (Task #517).
        const consent = await getMailReadConsentStatusAsync();
        const safeConsent = isAdmin
          ? consent
          : { ...consent, lastError: consent.lastError ? "see admin" : null };

        // Single severity classification so the UI doesn't have to re-derive.
        // Single source of truth — see services/coverageClassifier so
        // route + tests can never drift apart (Task #517).
        const { severity, reasons } = classifyCoverage({
          eligibleUsers: eligibleUsers.length,
          enrolledMailboxes: enabled.length,
          consentStatus: consent.status,
          consentConfigured: consent.configured,
          failedBackfills,
          neverBackfilled,
        });

        res.json({
          severity,
          reasons,
          eligibleUsers: eligibleUsers.length,
          enrolledMailboxes: enabled.length,
          totalMailboxes: mailboxes.length,
          backfills: {
            succeeded: succeededBackfills,
            failed: failedBackfills,
            neverRun: neverBackfilled,
            windowDays: 30,
          },
          spotQuotesFromBackfill30d: totalSpotQuotesFromBackfill,
          mailReadConsent: safeConsent,
        });
      } catch (err) {
        console.error("[monitoredMailboxes] GET /coverage error:", err);
        res.status(500).json({ error: "Failed to load coverage summary" });
      }
    },
  );

  // Admin-only: force a re-probe of Mail.Read tenant consent. Useful after
  // an admin grants the permission in Azure and wants to clear the banner
  // without waiting for the next mailbox sync.
  app.post(
    "/api/internal/admin/monitored-mailboxes/refresh-mail-read",
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response) => {
      try {
        const status = await refreshMailReadConsentStatus();
        res.json({ ok: true, mailReadConsent: status });
      } catch (err) {
        console.error("[monitoredMailboxes] refresh-mail-read error:", err);
        res.status(500).json({ error: "Failed to refresh Mail.Read consent" });
      }
    },
  );

  // Per-mailbox spot-quote opportunities created from backfilled email in
  // the last 30 days. Powers the "Spot quotes (30d)" column in the admin
  // mailbox table so directors can see which reps' inboxes are actually
  // generating opportunities vs. just being read.
  app.get(
    "/api/internal/admin/monitored-mailboxes/:id/quote-stats",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const mailbox = await storage.getMonitoredMailbox(pStr(req.params.id));
        if (!mailbox || mailbox.orgId !== user.organizationId) {
          return res.status(404).json({ error: "Mailbox not found" });
        }
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        // Quote opportunities whose source-reference matches an email
        // message addressed to this mailbox. We match on toEmail because
        // emailMessages doesn't carry a mailboxId column (delta sync writes
        // are scoped by recipient address).
        const rows = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(quoteOpportunities)
          .innerJoin(
            emailMessages,
            and(
              eq(emailMessages.orgId, quoteOpportunities.organizationId),
              eq(emailMessages.providerMessageId, quoteOpportunities.sourceReference),
            ),
          )
          .where(
            and(
              eq(quoteOpportunities.organizationId, user.organizationId),
              eq(quoteOpportunities.source, "email"),
              eq(sql`lower(${emailMessages.toEmail})`, mailbox.email.toLowerCase()),
              gte(quoteOpportunities.createdAt, thirtyDaysAgo),
              // Task #517 — restrict to the historical-backfill ingestion path.
              eq(emailMessages.ingestedVia, "backfill"),
            ),
          );
        res.json({
          mailboxId: mailbox.id,
          email: mailbox.email,
          spotQuotesFromBackfill30d: Number(rows[0]?.n ?? 0),
          windowDays: 30,
        });
      } catch (err) {
        console.error("[monitoredMailboxes] GET /quote-stats error:", err);
        res.status(500).json({ error: "Failed to load quote stats" });
      }
    },
  );

  // -----------------------------------------------------------------------
  // Task #549 — Go-live readiness checklist.
  //
  // Aggregates the eight gates IT must clear before the shared-mailbox
  // reply-tracking pipeline is safe to enable for an org:
  //   1. Azure app-only credentials configured (tenant/client/secret env)
  //   2. Shared reply mailbox configured (OUTLOOK_REPLY_EMAIL)
  //   3. Public webhook URL configured (APP_BASE_URL)
  //   4. Webhook clientState secret configured (OUTLOOK_WEBHOOK_SECRET)
  //   5. Mail.Read tenant admin consent granted
  //   6. At least one monitored mailbox enrolled
  //   7. At least one mailbox has synced in the last 24 hours (proves the
  //      Graph delta loop is alive end-to-end)
  //   8. No mailboxes have unresolved sync failures piling up
  //
  // Returns one item per check with a stable `id`, an "ok" / "warn" /
  // "error" status, and a short human-readable hint so the admin UI can
  // render rows without re-deriving wording.
  // -----------------------------------------------------------------------
  app.get(
    "/api/internal/admin/monitored-mailboxes/readiness",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const azureOk = azureCredentialsConfigured();
        const replyMailbox = process.env.OUTLOOK_REPLY_EMAIL?.trim() ?? null;
        const appBaseUrl = process.env.APP_BASE_URL?.trim() ?? null;
        const webhookSecret = webhookSecretConfigured();

        const consent = await getMailReadConsentStatusAsync();
        const mailboxes = await storage.getMonitoredMailboxes(user.organizationId);
        const enabled = mailboxes.filter(m => m.enabled);

        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const recentlySyncedCount = enabled.filter(
          m => m.lastSyncAt && m.lastSyncAt.getTime() > Date.now() - ONE_DAY_MS,
        ).length;

        // Org-wide unresolved-failure tally. We only care about mailboxes
        // that are still actively trying — a disabled mailbox cannot be
        // "draining" since the worker won't touch it.
        let totalUnresolvedFailures = 0;
        let mailboxesWithFailures = 0;
        for (const m of enabled) {
          const c = await storage.countUnresolvedMailboxSyncFailures(m.id).catch(() => 0);
          if (c > 0) {
            mailboxesWithFailures++;
            totalUnresolvedFailures += c;
          }
        }

        type Status = "ok" | "warn" | "error";
        interface Check {
          id: string;
          label: string;
          status: Status;
          hint: string;
        }

        const checks: Check[] = [
          {
            id: "azure_credentials",
            label: "Azure app-only credentials",
            status: azureOk ? "ok" : "error",
            hint: azureOk
              ? "OUTLOOK_TENANT_ID / OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET are set."
              : "Set OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET (Azure app registration).",
          },
          {
            id: "reply_mailbox",
            label: "Shared reply mailbox",
            status: replyMailbox ? "ok" : "error",
            hint: replyMailbox
              ? `OUTLOOK_REPLY_EMAIL is ${replyMailbox}.`
              : "Set OUTLOOK_REPLY_EMAIL to the shared M365 mailbox that receives carrier replies.",
          },
          {
            id: "app_base_url",
            label: "Public APP_BASE_URL",
            status: appBaseUrl
              ? (appBaseUrl.startsWith("https://") ? "ok" : "warn")
              : "error",
            hint: !appBaseUrl
              ? "Set APP_BASE_URL to the public HTTPS URL Microsoft Graph will call."
              : appBaseUrl.startsWith("https://")
                ? `APP_BASE_URL is ${appBaseUrl}.`
                : `APP_BASE_URL must be HTTPS for Graph subscriptions (currently ${appBaseUrl}).`,
          },
          {
            id: "webhook_secret",
            label: "Webhook clientState secret",
            status: webhookSecret ? "ok" : "error",
            hint: webhookSecret
              ? "OUTLOOK_WEBHOOK_SECRET is set — webhook payloads are validated."
              : "Set OUTLOOK_WEBHOOK_SECRET to a strong random string. Without it, all webhook payloads and subscription registrations are refused.",
          },
          {
            id: "mail_read_consent",
            label: "Mail.Read admin consent",
            status: consent.status === "granted"
              ? "ok"
              : consent.status === "denied"
                ? "error"
                : "warn",
            hint: consent.status === "granted"
              ? `Mail.Read application permission granted${consent.lastCheckedAt ? ` (checked ${new Date(consent.lastCheckedAt).toLocaleString()})` : ""}.`
              : consent.status === "denied"
                ? "Mail.Read denied by Azure. Ask an Azure tenant admin to grant the Mail.Read application permission and consent for the tenant."
                : "Mail.Read consent status not yet probed. Use 'Re-check Mail.Read' on the Email coverage card.",
          },
          {
            id: "mailboxes_enrolled",
            label: "At least one mailbox enrolled",
            status: enabled.length > 0 ? "ok" : "error",
            hint: enabled.length > 0
              ? `${enabled.length} enabled mailbox${enabled.length === 1 ? "" : "es"} (of ${mailboxes.length} total).`
              : "Enroll at least one team-member mailbox via 'Enroll all users' or 'Add Mailbox'.",
          },
          {
            id: "recent_sync",
            label: "Recent successful sync (last 24h)",
            status: enabled.length === 0
              ? "warn"
              : recentlySyncedCount > 0
                ? "ok"
                : "error",
            hint: enabled.length === 0
              ? "No enabled mailboxes — enroll one and trigger a sync."
              : recentlySyncedCount > 0
                ? `${recentlySyncedCount} mailbox${recentlySyncedCount === 1 ? "" : "es"} synced within the last 24 hours.`
                : "No mailbox has synced in the last 24 hours. Click the sync icon on a mailbox row to verify Graph connectivity.",
          },
          {
            id: "no_draining_failures",
            label: "No draining sync failures",
            status: totalUnresolvedFailures === 0 ? "ok" : (totalUnresolvedFailures > 25 ? "error" : "warn"),
            hint: totalUnresolvedFailures === 0
              ? "All ingested messages persisted cleanly."
              : `${totalUnresolvedFailures} unresolved failure${totalUnresolvedFailures === 1 ? "" : "s"} across ${mailboxesWithFailures} mailbox${mailboxesWithFailures === 1 ? "" : "es"}. Open each affected mailbox card to retry or dismiss.`,
          },
        ];

        const errorCount = checks.filter(c => c.status === "error").length;
        const warnCount = checks.filter(c => c.status === "warn").length;
        const overall: Status = errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok";

        res.json({
          overall,
          checks,
          summary: {
            ok: checks.filter(c => c.status === "ok").length,
            warn: warnCount,
            error: errorCount,
          },
        });
      } catch (err) {
        console.error("[monitoredMailboxes] GET /readiness error:", err);
        res.status(500).json({ error: "Failed to load readiness checklist" });
      }
    },
  );
}
