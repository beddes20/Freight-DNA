/**
 * Admin Routes — POD Intake (Task #589)
 *
 * Surfaces the AR-mailbox POD pipeline (getpaid@valuetruckaz.com) to the
 * admin UI. Three buckets — forwarded / unmatched / not_pod — plus per-org
 * settings (enabled, monitored mailbox id, team fallback email, AI fallback).
 *
 * GET    /api/admin/pod-intake?bucket=forwarded|unmatched|not_pod|pending|all
 * GET    /api/admin/pod-intake/:id
 * POST   /api/admin/pod-intake/:id/link        { orderId }
 * POST   /api/admin/pod-intake/:id/reforward
 * GET    /api/admin/pod-intake/settings
 * PATCH  /api/admin/pod-intake/settings
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import {
  matchOrderIdToLoad,
  resolveRecipients,
  forwardPod,
  bucketForRow,
  downloadGraphAttachments,
  type PodCandidateAttachment,
} from "../services/podIntakeService";

function requireAdmin(req: Request, res: Response, next: () => void) {
  getCurrentUser(req)
    .then((user) => {
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!["admin", "director", "sales_director"].includes(user.role)) {
        return res.status(403).json({ error: "Admin access required" });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: "Auth error" }));
}

const bucketSchema = z.enum(["forwarded", "unmatched", "not_pod", "pending", "all"]);

const linkSchema = z.object({
  orderId: z.string().trim().min(1).max(64),
});

const settingsPatchSchema = z.object({
  monitoredMailboxId: z.string().uuid().nullable().optional(),
  teamFallbackEmail: z.string().email().nullable().optional(),
  enabled: z.boolean().optional(),
  useAiFallback: z.boolean().optional(),
});

export function registerPodIntakeRoutes(app: Express): void {
  // ── List buckets ────────────────────────────────────────────────────────
  app.get(
    "/api/admin/pod-intake",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const bucketParam = bucketSchema.safeParse(req.query.bucket ?? "forwarded");
        if (!bucketParam.success) {
          return res.status(400).json({ error: "Invalid bucket" });
        }
        const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);

        const rows = await storage.listPodIntakeEmails(user.orgId, {
          bucket: bucketParam.data,
          limit,
        });

        res.json({
          bucket: bucketParam.data,
          count: rows.length,
          rows: rows.map((r) => ({
            id: r.id,
            receivedAt: r.receivedAt,
            fromEmail: r.fromEmail,
            fromName: r.fromName,
            subject: r.subject,
            bodyPreview: r.bodyPreview,
            classification: r.classification,
            classifierMethod: r.classifierMethod,
            extractedOrderIds: r.extractedOrderIds,
            matchedOrderId: r.matchedOrderId,
            matchedLoadFactId: r.matchedLoadFactId,
            matchedCompanyId: r.matchedCompanyId,
            forwardStatus: r.forwardStatus,
            forwardedAt: r.forwardedAt,
            forwardedTo: r.forwardedTo,
            forwardError: r.forwardError,
            hasAttachments: r.hasAttachments,
            attachmentMeta: r.attachmentMeta,
            bucket: bucketForRow(r),
          })),
        });
      } catch (err) {
        console.error("[pod-intake] list failed:", err);
        res.status(500).json({ error: "Failed to list POD intake emails" });
      }
    },
  );

  // ── Single row detail ───────────────────────────────────────────────────
  app.get(
    "/api/admin/pod-intake/settings",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const settings = await storage.getPodIntakeSettings(user.orgId);
        res.json({
          settings:
            settings ?? {
              orgId: user.orgId,
              monitoredMailboxId: null,
              teamFallbackEmail: null,
              enabled: false,
              useAiFallback: true,
            },
        });
      } catch (err) {
        console.error("[pod-intake] settings GET failed:", err);
        res.status(500).json({ error: "Failed to load settings" });
      }
    },
  );

  app.patch(
    "/api/admin/pod-intake/settings",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const parsed = settingsPatchSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid settings", details: parsed.error.flatten() });
        }

        const existing = await storage.getPodIntakeSettings(user.orgId);
        const merged = {
          orgId: user.orgId,
          monitoredMailboxId:
            parsed.data.monitoredMailboxId !== undefined
              ? parsed.data.monitoredMailboxId
              : existing?.monitoredMailboxId ?? null,
          teamFallbackEmail:
            parsed.data.teamFallbackEmail !== undefined
              ? parsed.data.teamFallbackEmail
              : existing?.teamFallbackEmail ?? null,
          enabled:
            parsed.data.enabled !== undefined
              ? parsed.data.enabled
              : existing?.enabled ?? false,
          useAiFallback:
            parsed.data.useAiFallback !== undefined
              ? parsed.data.useAiFallback
              : existing?.useAiFallback ?? true,
        };

        const saved = await storage.upsertPodIntakeSettings(merged);
        res.json({ settings: saved });
      } catch (err) {
        console.error("[pod-intake] settings PATCH failed:", err);
        res.status(500).json({ error: "Failed to save settings" });
      }
    },
  );

  app.get(
    "/api/admin/pod-intake/:id",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const row = await storage.getPodIntakeEmail(user.orgId, req.params.id);
        if (!row) return res.status(404).json({ error: "Not found" });
        res.json({ row: { ...row, bucket: bucketForRow(row) } });
      } catch (err) {
        console.error("[pod-intake] detail failed:", err);
        res.status(500).json({ error: "Failed to load POD intake email" });
      }
    },
  );

  // ── Manual link to an order ID ──────────────────────────────────────────
  // Operator hits this after looking at an "unmatched" row and finding the
  // load by hand. We re-run match + recipient resolution for the supplied
  // orderId and stamp the row; we do NOT auto-reforward (operator does that
  // explicitly via the next endpoint).
  app.post(
    "/api/admin/pod-intake/:id/link",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const parsed = linkSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid payload", details: parsed.error.flatten() });
        }

        const row = await storage.getPodIntakeEmail(user.orgId, req.params.id);
        if (!row) return res.status(404).json({ error: "Not found" });

        const match = await matchOrderIdToLoad(user.orgId, [parsed.data.orderId]);
        const updated = await storage.updatePodIntakeEmail(user.orgId, row.id, {
          matchedOrderId: parsed.data.orderId,
          matchedLoadFactId: match?.loadFactId ?? null,
          matchedCompanyId: match?.companyId ?? null,
          // Manual link clears any prior unmatched / failed status — operator
          // can hit reforward next.
          forwardStatus: match ? "pending" : "unmatched",
          forwardError: null,
        });

        res.json({ row: updated });
      } catch (err) {
        console.error("[pod-intake] link failed:", err);
        res.status(500).json({ error: "Failed to link order ID" });
      }
    },
  );

  // ── Re-forward a previously-failed or manually-linked row ──────────────
  // Re-runs match (in case load_fact has caught up since the first attempt)
  // + recipient resolution + Outlook send. We re-download attachments from
  // Graph rather than relying on the stored metadata so we always send the
  // original bytes.
  app.post(
    "/api/admin/pod-intake/:id/reforward",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const row = await storage.getPodIntakeEmail(user.orgId, req.params.id);
        if (!row) return res.status(404).json({ error: "Not found" });
        if (!row.matchedOrderId) {
          return res
            .status(400)
            .json({ error: "Row is not linked to an order ID yet — link first" });
        }

        // Re-resolve match (load_fact may have been updated since ingest).
        const match = await matchOrderIdToLoad(user.orgId, [row.matchedOrderId]);
        const recipients = await resolveRecipients(user.orgId, match);

        // Look up the AR mailbox address. The row has a mailboxId FK; we
        // need the underlying email for the Graph send call.
        let mailboxAddress: string | null = null;
        if (row.mailboxId) {
          const mailboxes = await storage
            .getMonitoredMailboxes(user.orgId)
            .catch(() => []);
          mailboxAddress =
            mailboxes.find((m) => m.id === row.mailboxId)?.email ?? null;
        }
        if (!mailboxAddress) {
          return res
            .status(400)
            .json({ error: "Cannot determine sending mailbox for this row" });
        }

        // Re-download the original attachments. Metadata-only entries on the
        // row are not enough — forwardPod needs base64 bytes.
        let attachments: PodCandidateAttachment[] = [];
        try {
          attachments = await downloadGraphAttachments(
            mailboxAddress,
            row.providerMessageId,
          );
        } catch (err) {
          console.warn(
            "[pod-intake] reforward attachment fetch failed:",
            err instanceof Error ? err.message : String(err),
          );
        }

        const result = await forwardPod({
          fromMailbox: mailboxAddress,
          recipients,
          match,
          msg: {
            subject: row.subject ?? "(no subject)",
            fromEmail: row.fromEmail ?? "",
            fromName: row.fromName ?? "",
            bodyText: row.bodyText ?? row.bodyPreview ?? "",
            bodyPreview: row.bodyPreview ?? "",
            attachments,
          },
          attachments,
        });

        // Mirror ingest orchestrator semantics so reforwarded rows land in
        // the same bucket they would have on first ingest:
        //   - send ok + matched      → "forwarded"
        //   - send ok + unmatched    → "unmatched" (forwarded only to fallback)
        //   - send failed            → "failed"
        const newStatus = result.ok
          ? match
            ? "forwarded"
            : "unmatched"
          : "failed";

        const updated = await storage.updatePodIntakeEmail(user.orgId, row.id, {
          matchedLoadFactId: match?.loadFactId ?? null,
          matchedCompanyId: match?.companyId ?? null,
          matchedOrderId: match?.orderId ?? null,
          forwardStatus: newStatus,
          forwardedAt: result.ok ? new Date() : row.forwardedAt,
          forwardedTo: {
            dispatcher: recipients.dispatcher ?? null,
            accountOwner: recipients.accountOwner ?? null,
            teamFallback: recipients.teamFallback ?? null,
          },
          forwardError: result.error ?? null,
        });

        res.json({ row: updated, result });
      } catch (err) {
        console.error("[pod-intake] reforward failed:", err);
        res.status(500).json({ error: "Failed to re-forward POD" });
      }
    },
  );
}
