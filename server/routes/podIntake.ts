/**
 * Admin Routes — POD Intake (Task #589 + Task #614)
 *
 * Surfaces the AR-mailbox POD pipeline (getpaid@valuetruckaz.com) to the
 * admin UI plus the rep "My PODs" view.
 *
 * Admin endpoints
 *   GET    /api/admin/pod-intake?bucket=forwarded|unmatched|not_pod|pending|all
 *                                       &delivery=email|in_app|all
 *   GET    /api/admin/pod-intake/:id
 *   POST   /api/admin/pod-intake/:id/link        { orderId }
 *   POST   /api/admin/pod-intake/:id/reforward
 *   GET    /api/admin/pod-intake/settings
 *   PATCH  /api/admin/pod-intake/settings        { ..., autoForwardEmail? }
 *
 * Rep endpoints (Task #614)
 *   GET    /api/my-pods
 *   GET    /api/my-pods/unread-count
 *   POST   /api/my-pods/:id/seen
 *   GET    /api/loads/by-order-id/:orderId/pods
 *   GET    /api/pods/:id/attachments/:attachmentId/download
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { storage, db } from "../storage";
import { loadFact, freightOpportunities } from "@shared/schema";
import { requireAuth, getCurrentUser } from "../auth";
import {
  matchOrderIdToLoad,
  resolveRecipients,
  forwardPod,
  bucketForRow,
  downloadGraphAttachments,
  type PodCandidateAttachment,
} from "../services/podIntakeService";
import { getErrorMessage } from "../lib/errors";
import { pStr } from "../lib/req";

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

const bucketSchema = z.enum([
  "forwarded",
  "unmatched",
  "not_pod",
  "pending",
  "delivered_in_app",
  "all",
]);

const deliverySchema = z.enum(["email", "in_app", "all"]);

const linkSchema = z.object({
  orderId: z.string().trim().min(1).max(64),
});

const settingsPatchSchema = z.object({
  monitoredMailboxId: z.string().uuid().nullable().optional(),
  teamFallbackEmail: z.string().email().nullable().optional(),
  enabled: z.boolean().optional(),
  useAiFallback: z.boolean().optional(),
  autoForwardEmail: z.boolean().optional(),
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
        const deliveryParam = deliverySchema.safeParse(req.query.delivery ?? "all");
        if (!deliveryParam.success) {
          return res.status(400).json({ error: "Invalid delivery filter" });
        }
        const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);

        const rows = await storage.listPodIntakeEmails(user.organizationId, {
          bucket: bucketParam.data,
          delivery: deliveryParam.data,
          limit,
        });

        res.json({
          bucket: bucketParam.data,
          delivery: deliveryParam.data,
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
            deliveryMethod: r.deliveryMethod,
            dispatcherUserId: r.dispatcherUserId,
            accountOwnerUserId: r.accountOwnerUserId,
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
        const settings = await storage.getPodIntakeSettings(user.organizationId);
        res.json({
          settings:
            settings ?? {
              orgId: user.organizationId,
              monitoredMailboxId: null,
              teamFallbackEmail: null,
              enabled: false,
              useAiFallback: true,
              autoForwardEmail: true,
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

        const existing = await storage.getPodIntakeSettings(user.organizationId);
        const merged = {
          orgId: user.organizationId,
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
          autoForwardEmail:
            parsed.data.autoForwardEmail !== undefined
              ? parsed.data.autoForwardEmail
              : existing?.autoForwardEmail ?? true,
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
        const row = await storage.getPodIntakeEmail(user.organizationId, pStr(req.params.id));
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

        const row = await storage.getPodIntakeEmail(user.organizationId, pStr(req.params.id));
        if (!row) return res.status(404).json({ error: "Not found" });

        const match = await matchOrderIdToLoad(user.organizationId, [parsed.data.orderId]);
        const updated = await storage.updatePodIntakeEmail(user.organizationId, row.id, {
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

        const row = await storage.getPodIntakeEmail(user.organizationId, pStr(req.params.id));
        if (!row) return res.status(404).json({ error: "Not found" });
        if (!row.matchedOrderId) {
          return res
            .status(400)
            .json({ error: "Row is not linked to an order ID yet — link first" });
        }

        // Re-resolve match (load_fact may have been updated since ingest).
        const match = await matchOrderIdToLoad(user.organizationId, [row.matchedOrderId]);
        const recipients = await resolveRecipients(user.organizationId, match);

        // Look up the AR mailbox address. The row has a mailboxId FK; we
        // need the underlying email for the Graph send call.
        let mailboxAddress: string | null = null;
        if (row.mailboxId) {
          const mailboxes = await storage
            .getMonitoredMailboxes(user.organizationId)
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
            getErrorMessage(err),
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

        const updated = await storage.updatePodIntakeEmail(user.organizationId, row.id, {
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

  // ── Rep-facing routes (Task #614) ──────────────────────────────────────

  /**
   * Shape PODs for the rep-facing surfaces (My PODs page + load detail).
   * Hides admin-only routing details and surfaces only fields the rep needs.
   */
  function repPodView(
    r: import("@shared/schema").PodIntakeEmail,
    customerName: string | null = null,
    freightOpportunityId: string | null = null,
  ) {
    return {
      id: r.id,
      receivedAt: r.receivedAt,
      fromEmail: r.fromEmail,
      fromName: r.fromName,
      subject: r.subject,
      bodyPreview: r.bodyPreview,
      bodyText: r.bodyText,
      matchedOrderId: r.matchedOrderId,
      matchedLoadFactId: r.matchedLoadFactId,
      matchedCompanyId: r.matchedCompanyId,
      matchedCustomerName: customerName,
      // Resolved freight opportunity id so the client can deep-link to
      // /available-freight/<id> (the route is keyed by FO id, NOT load_fact id).
      matchedFreightOpportunityId: freightOpportunityId,
      forwardStatus: r.forwardStatus,
      deliveryMethod: r.deliveryMethod,
      hasAttachments: r.hasAttachments,
      attachmentMeta: r.attachmentMeta,
      dispatcherUserId: r.dispatcherUserId,
      accountOwnerUserId: r.accountOwnerUserId,
    };
  }

  /**
   * Batch-resolve display extras for a set of POD rows:
   *   - customer name from load_fact (joined on matchedOrderId)
   *   - freight opportunity id (joined on sourceRef.orderId) so the client
   *     can deep-link to /available-freight/<id>
   * Both are returned as maps keyed by orderId.
   */
  async function podDisplayExtras(
    orgId: string,
    rows: import("@shared/schema").PodIntakeEmail[],
  ): Promise<{
    customerByOrderId: Record<string, string>;
    foIdByOrderId: Record<string, string>;
  }> {
    const orderIds = Array.from(
      new Set(
        rows
          .map((r) => r.matchedOrderId)
          .filter((x): x is string => Boolean(x)),
      ),
    );
    if (orderIds.length === 0) {
      return { customerByOrderId: {}, foIdByOrderId: {} };
    }

    const customerByOrderId: Record<string, string> = {};
    const foIdByOrderId: Record<string, string> = {};

    try {
      const lf = await db
        .select({
          orderId: loadFact.orderId,
          customerName: loadFact.customerName,
          lastChangedAt: loadFact.lastChangedAt,
        })
        .from(loadFact)
        .where(
          and(eq(loadFact.orgId, orgId), inArray(loadFact.orderId, orderIds)),
        )
        .orderBy(desc(loadFact.lastChangedAt));
      for (const r of lf) {
        if (!customerByOrderId[r.orderId] && r.customerName) {
          customerByOrderId[r.orderId] = r.customerName;
        }
      }
    } catch (err) {
      console.warn(
        `[my-pods] customer-name lookup failed: ${
          getErrorMessage(err)
        }`,
      );
    }

    try {
      const fos = await db
        .select({
          id: freightOpportunities.id,
          orderId: sql<string>`${freightOpportunities.sourceRef}->>'orderId'`,
          generatedAt: freightOpportunities.generatedAt,
        })
        .from(freightOpportunities)
        .where(
          and(
            eq(freightOpportunities.orgId, orgId),
            sql`${freightOpportunities.sourceRef}->>'orderId' = ANY(${orderIds})`,
          ),
        )
        .orderBy(desc(freightOpportunities.generatedAt));
      for (const r of fos) {
        if (r.orderId && !foIdByOrderId[r.orderId]) {
          foIdByOrderId[r.orderId] = r.id;
        }
      }
    } catch (err) {
      console.warn(
        `[my-pods] freight-opportunity lookup failed: ${
          getErrorMessage(err)
        }`,
      );
    }

    return { customerByOrderId, foIdByOrderId };
  }

  // List the PODs the current user owns (as dispatcher OR account owner).
  // Each row is augmented with `unreadNotificationIds` so the client can
  // post a single mark-as-seen call per row.
  app.get("/api/my-pods", requireAuth, async (req: Request, res: Response) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
      const rows = await storage.listPodIntakeEmailsForUser(user.id, user.organizationId, { limit });

      // Pull notification rows for this user so the client can show
      // unread state per POD without a second roundtrip.
      const allNotifs = await storage.getNotifications(user.id);
      const podNotifs = allNotifs.filter(
        (n) => n.type === "pod_received" && n.relatedId,
      );
      const unreadByPod: Record<string, string[]> = {};
      const readByPod: Record<string, boolean> = {};
      for (const n of podNotifs) {
        const k = n.relatedId!;
        if (!n.read) {
          (unreadByPod[k] ??= []).push(n.id);
        } else {
          readByPod[k] = true;
        }
      }

      const { customerByOrderId, foIdByOrderId } = await podDisplayExtras(
        user.organizationId,
        rows,
      );

      res.json({
        count: rows.length,
        rows: rows.map((r) => ({
          ...repPodView(
            r,
            r.matchedOrderId ? customerByOrderId[r.matchedOrderId] ?? null : null,
            r.matchedOrderId ? foIdByOrderId[r.matchedOrderId] ?? null : null,
          ),
          unreadNotificationIds: unreadByPod[r.id] ?? [],
          unread: (unreadByPod[r.id] ?? []).length > 0,
          everNotified: !!unreadByPod[r.id] || !!readByPod[r.id],
        })),
      });
    } catch (err) {
      console.error("[my-pods] list failed:", err);
      res.status(500).json({ error: "Failed to list your PODs" });
    }
  });

  // Cheap "do I have unread PODs?" probe for the sidebar badge.
  app.get(
    "/api/my-pods/unread-count",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const allNotifs = await storage.getNotifications(user.id);
        const unread = allNotifs.filter(
          (n) => n.type === "pod_received" && !n.read,
        );
        res.json({ count: unread.length });
      } catch (err) {
        console.error("[my-pods] unread-count failed:", err);
        res.status(500).json({ error: "Failed to load unread count" });
      }
    },
  );

  // Mark every pod_received notification for this POD row as read for the
  // current user. Idempotent + scoped to the caller via storage.markNotificationsReadByIds.
  app.post(
    "/api/my-pods/:id/seen",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const podId = pStr(req.params.id);

        // Confirm the user owns this POD before clearing notifications —
        // prevents a malicious client from marking arbitrary IDs read.
        const row = await storage.getPodIntakeEmail(user.organizationId, podId);
        if (!row) return res.status(404).json({ error: "Not found" });
        if (
          row.dispatcherUserId !== user.id &&
          row.accountOwnerUserId !== user.id
        ) {
          return res.status(403).json({ error: "Not your POD" });
        }

        const allNotifs = await storage.getNotifications(user.id);
        const ids = allNotifs
          .filter(
            (n) =>
              n.type === "pod_received" &&
              n.relatedId === podId &&
              !n.read,
          )
          .map((n) => n.id);
        if (ids.length > 0) {
          await storage.markNotificationsReadByIds(user.id, ids);
        }
        res.json({ ok: true, marked: ids.length });
      } catch (err) {
        console.error("[my-pods] mark-seen failed:", err);
        res.status(500).json({ error: "Failed to mark POD as seen" });
      }
    },
  );

  // Load-detail surface support: list PODs matched to a given orderId,
  // org-scoped. Anyone in the org with access to the load page can see
  // that PODs exist (subject, sender display name, attachment metadata).
  // To avoid overexposing message content to non-owners we strip the
  // sender email + body fields for callers who are not an admin and not
  // the dispatcher / account owner of the row.
  app.get(
    "/api/loads/by-order-id/:orderId/pods",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const orderId = pStr(req.params.orderId).trim();
        if (!orderId) return res.json({ count: 0, rows: [] });
        const rows = await storage.listPodIntakeEmailsByOrderId(user.organizationId, orderId);
        const { customerByOrderId, foIdByOrderId } = await podDisplayExtras(
          user.organizationId,
          rows,
        );
        const isAdmin = ["admin", "director", "sales_director"].includes(user.role);
        res.json({
          orderId,
          count: rows.length,
          rows: rows.map((r) => {
            const view = repPodView(
              r,
              r.matchedOrderId ? customerByOrderId[r.matchedOrderId] ?? null : null,
              r.matchedOrderId ? foIdByOrderId[r.matchedOrderId] ?? null : null,
            );
            const isOwner =
              r.dispatcherUserId === user.id ||
              r.accountOwnerUserId === user.id;
            if (isAdmin || isOwner) return view;
            // Non-owner view: keep enough for the load-detail UI to show
            // "POD received from X on date Y with N attachments" but redact
            // sender email + email body so message content doesn't leak.
            const { fromEmail, bodyPreview, bodyText, ...safe } = view;
            return safe;
          }),
        });
      } catch (err) {
        console.error("[my-pods] by-order list failed:", err);
        res.status(500).json({ error: "Failed to list PODs for this load" });
      }
    },
  );

  // Per-attachment download proxy. Available to: admins, the dispatcher
  // user, and the account owner user. Re-fetches the attachment from
  // Microsoft Graph at request time (we never persist attachment bytes).
  app.get(
    "/api/pods/:id/attachments/:attachmentId/download",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const row = await storage.getPodIntakeEmail(user.organizationId, pStr(req.params.id));
        if (!row) return res.status(404).json({ error: "Not found" });

        const isAdmin = ["admin", "director", "sales_director"].includes(user.role);
        const isOwner =
          row.dispatcherUserId === user.id || row.accountOwnerUserId === user.id;
        if (!isAdmin && !isOwner) {
          return res.status(403).json({ error: "Not your POD" });
        }

        // Find the AR mailbox address. Required to call Graph.
        let mailboxAddress: string | null = null;
        if (row.mailboxId) {
          const mailboxes = await storage
            .getMonitoredMailboxes(user.organizationId)
            .catch(() => []);
          mailboxAddress =
            mailboxes.find((m) => m.id === row.mailboxId)?.email ?? null;
        }
        if (!mailboxAddress) {
          return res
            .status(400)
            .json({ error: "Cannot determine mailbox for this POD" });
        }

        const attachments: PodCandidateAttachment[] = await downloadGraphAttachments(
          mailboxAddress,
          row.providerMessageId,
        );
        const att = attachments.find((a) => a.id === pStr(req.params.attachmentId));
        if (!att) return res.status(404).json({ error: "Attachment not found" });
        if (!att.contentBase64) {
          return res
            .status(413)
            .json({ error: "Attachment too large to download here" });
        }

        const buf = Buffer.from(att.contentBase64, "base64");
        res.setHeader("Content-Type", att.contentType || "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${(att.name || "attachment").replace(/"/g, "")}"`,
        );
        res.setHeader("Content-Length", String(buf.length));
        res.end(buf);
      } catch (err) {
        console.error("[my-pods] attachment download failed:", err);
        res.status(500).json({ error: "Failed to download attachment" });
      }
    },
  );
}
