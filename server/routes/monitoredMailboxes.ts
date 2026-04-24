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
import {
  registerMailboxSubscription,
  removeMailboxSubscription,
  getMailReadConsentStatus,
  getMailReadConsentStatusAsync,
  refreshMailReadConsentStatus,
} from "../graphSubscriptionService";
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

// Roles whose users get a mailbox auto-enrolled by enroll-all and are
// counted as "eligible" for the coverage banner. Kept in one place so the
// enroll-all handler and the coverage endpoint never drift apart.
const ELIGIBLE_ROLES: ReadonlyArray<string> = [
  "national_account_manager",
  "account_manager",
  "admin",
  "director",
  "sales_director",
];

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
          const errMsg = err instanceof Error ? err.message : "";
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
          registerMailboxSubscription(mailbox.email, mailbox.id).catch(err => {
            console.error("[monitoredMailboxes] enroll-all subscription error:", err);
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
        const mailbox = await storage.getMonitoredMailbox(req.params.id);
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
}
