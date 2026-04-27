/**
 * Admin Routes — Email Pipeline Ops (Task #751)
 *
 * Operator-facing health view + manual triggers for the carrier email
 * learning pipeline:
 *
 *   GET  /api/internal/admin/email-pipeline/health
 *   POST /api/internal/admin/email-pipeline/drain
 *   POST /api/internal/admin/email-pipeline/backfill-links
 *
 * All endpoints require admin/director/sales_director role.
 */

import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { runEmailIntelligenceBatch } from "../emailIntelligenceScheduler";
import {
  matchInboundCarrier,
  normalizeEmailAddress,
} from "../services/carrierContactMatchService";
import { getErrorMessage } from "../lib/errors";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${t} [emailPipelineOps] ${msg}`);
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

export function registerEmailPipelineOpsRoutes(app: Express): void {
  // ── GET health ────────────────────────────────────────────────────────────
  app.get(
    "/api/internal/admin/email-pipeline/health",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        const health = await storage.getEmailPipelineHealth(user.organizationId);
        res.json(health);
      } catch (err) {
        log(`health error: ${getErrorMessage(err)}`);
        res.status(500).json({ error: "Failed to load pipeline health" });
      }
    },
  );

  // ── POST drain ────────────────────────────────────────────────────────────
  // Runs the email intelligence batch synchronously up to N times.
  // Capped so a single click can't tie up the request thread for hours.
  app.post(
    "/api/internal/admin/email-pipeline/drain",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const body = req.body ?? {};
        const maxBatches = Math.max(1, Math.min(10, parseInt(String(body.maxBatches ?? "5"), 10)));
        const batchSize = body.batchSize !== undefined
          ? Math.max(1, Math.min(500, parseInt(String(body.batchSize), 10)))
          : undefined;

        // Scoped to user.organizationId so a tenant admin can only burn
        // OpenAI quota processing their own org's backlog (multi-tenant
        // isolation — Task #751 code review).
        let processedTotal = 0;
        let batchesRun = 0;
        for (let i = 0; i < maxBatches; i++) {
          const result = await runEmailIntelligenceBatch(batchSize, user.organizationId);
          batchesRun++;
          processedTotal += result.processed;
          if (result.processed === 0) break;
        }

        log(`drain: processed=${processedTotal} batches=${batchesRun} (orgId=${user.organizationId})`);
        res.json({ processedTotal, batchesRun });
      } catch (err) {
        log(`drain error: ${getErrorMessage(err)}`);
        res.status(500).json({ error: "Failed to drain pipeline" });
      }
    },
  );

  // ── POST backfill-links ───────────────────────────────────────────────────
  // Walk historical email_messages with no carrier/account link and re-run
  // the strengthened matcher. Each newly-linked row has its
  // processed_for_signals_at cleared so the scheduler will re-extract.
  app.post(
    "/api/internal/admin/email-pipeline/backfill-links",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      try {
        const user = await getCurrentUser(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const body = req.body ?? {};
        const batchSize = Math.max(1, Math.min(5000, parseInt(String(body.batchSize ?? body.limit ?? "1000"), 10)));
        const runUntilEmpty = body.runUntilEmpty === true;
        // Hard cap so a runaway loop can't tie up the request thread —
        // operator can re-click to continue beyond this.
        const maxBatches = runUntilEmpty
          ? Math.max(1, Math.min(50, parseInt(String(body.maxBatches ?? "20"), 10)))
          : 1;

        // Cache per counterparty address so identical senders aren't matched
        // hundreds of times across a long backfill run.
        type CacheVal = { carrierId: string | null; accountId: string | null };
        const cache = new Map<string, CacheVal>();

        let scanned = 0;
        let linkedCarrier = 0;
        let linkedAccount = 0;
        let batchesRun = 0;
        // Cursor advances past unmatched rows so each batch sees fresh
        // candidates. Linked rows shift OUT of the unlinked pool so we do
        // NOT count them toward the offset; unlinked rows remain in the
        // pool and would be re-fetched at offset 0, so we advance past
        // them by `messages.length - linkedThisBatch`. This guarantees
        // forward progress even when entire batches produce zero links.
        let offset = 0;

        for (let b = 0; b < maxBatches; b++) {
          const messages = await storage.getUnlinkedEmailMessages(user.organizationId, batchSize, offset);
          if (messages.length === 0) break;
          batchesRun++;

          let linkedThisBatch = 0;
          for (const m of messages) {
            scanned++;
            // Determine which side of the conversation is the counterparty.
            // For outbound rows the carrier/account is the recipient; for
            // inbound, it's the sender.
            const candidateAddress = m.direction === "outbound"
              ? normalizeEmailAddress(m.toEmail)
              : normalizeEmailAddress(m.fromEmail);
            if (!candidateAddress) continue;

            let cached = cache.get(candidateAddress);
            if (!cached) {
              const carrierMatch = await matchInboundCarrier(candidateAddress, user.organizationId, storage);
              let accountId: string | null = null;
              if (!carrierMatch.carrierId) {
                const accountMatch = await storage.getContactByEmailInOrg(candidateAddress, user.organizationId);
                accountId = accountMatch?.companyId ?? null;
              }
              cached = { carrierId: carrierMatch.carrierId, accountId };
              cache.set(candidateAddress, cached);
            }

            if (cached.carrierId || cached.accountId) {
              await storage.relinkEmailMessage(m.id, {
                linkedCarrierId: cached.carrierId,
                linkedAccountId: cached.accountId,
              });
              if (cached.carrierId) linkedCarrier++;
              if (cached.accountId) linkedAccount++;
              linkedThisBatch++;
            }
          }

          // Advance cursor past rows that were NOT linked (and therefore
          // remain in the unlinked-pool result set). Linked rows shift
          // out so they don't need to be skipped.
          offset += messages.length - linkedThisBatch;

          // Stop early when the underlying query returned a partial page
          // — there are no more candidates to scan.
          if (messages.length < batchSize) break;
        }

        log(`backfill-links: scanned=${scanned} linkedCarrier=${linkedCarrier} linkedAccount=${linkedAccount} batches=${batchesRun} (orgId=${user.organizationId})`);
        res.json({ scanned, linkedCarrier, linkedAccount, batchesRun });
      } catch (err) {
        log(`backfill-links error: ${getErrorMessage(err)}`);
        res.status(500).json({ error: "Failed to backfill links" });
      }
    },
  );
}
