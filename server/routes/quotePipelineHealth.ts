/**
 * Task #952 — Customer Quotes pipeline hardening (Phase A0).
 *
 * Admin operator surface for the email → quote opportunity pipeline.
 * Mirrors the shape of `routes/freightConversionFailures.ts` (Phase A5)
 * but operates on the upstream stage: every silent skip / classifier-miss
 * / ingest exception caught by `quoteEmailIngestion.ts` +
 * `inlineEmailClassifier.ts` lands in `quote_pipeline_drops`, and this
 * router lets an admin list them, see the trailing funnel, replay a
 * single drop, or manually resolve it.
 *
 * Endpoints:
 *   GET    /api/admin/quote-pipeline/funnel?window=24h|7d
 *            { window, inboundCustomer, classifiedAsQuote, ingested,
 *              dropsByReason: { classifier_miss, outbound, ... } }
 *   GET    /api/admin/quote-pipeline/health
 *            { openCount, openByReason, last24hOpened, last7dOpened }
 *   GET    /api/admin/quote-pipeline/drops?reason=&resolved=&limit=&offset=
 *            { ok, rows: [{ ...drop, fromEmail?, subject?, ... }], total }
 *   POST   /api/admin/quote-pipeline/drops/:id/reprocess
 *   POST   /api/admin/quote-pipeline/drops/:id/resolve { note? }
 *
 * All endpoints are admin-only and scoped to the requesting admin's
 * organization. The reprocess path re-runs the same fire-and-forget
 * dispatcher used by the live ingest path; the inner
 * `ingestQuoteFromEmail` is idempotent on (org, source, ref) so repeat
 * reprocesses are safe no-ops on already-ingested rows.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, sql, inArray } from "drizzle-orm";
import { db, storage } from "../storage";
import { requireUser } from "../auth";
import { pStr, qOptStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import {
  quotePipelineDrops,
  emailMessages,
  QUOTE_PIPELINE_DROP_REASONS,
  type QuotePipelineDropReason,
} from "@shared/schema";
import { getFollowUpCacheBustStats } from "../services/staleQuoteFollowup";

function isAdmin(role: string | null | undefined): boolean {
  return role === "admin";
}
function orgIdFromReq(req: Request): string | null {
  return ((req as any).session?.organizationId as string) ?? null;
}
function userIdFromReq(req: Request): string | null {
  return ((req as any).session?.userId as string) ?? null;
}

/**
 * Resolve the SQL interval for the funnel `window` query param. Two
 * windows only — 24h is the default rep-facing horizon, 7d is the
 * weekly trending view. Anything else falls back to 24h to keep the
 * SQL safe.
 */
function windowToInterval(window: string | null | undefined): { sql: string; label: string } {
  if (window === "7d") return { sql: "7 days", label: "7d" };
  return { sql: "24 hours", label: "24h" };
}

function isValidReason(value: string): value is QuotePipelineDropReason {
  return (QUOTE_PIPELINE_DROP_REASONS as readonly string[]).includes(value);
}

export function registerQuotePipelineHealthRoutes(app: Express): void {
  // ── GET /funnel ─────────────────────────────────────────────────────────
  // Trailing funnel for the requested window. Counts come from three
  // sources joined on org + time:
  //   - inbound customer emails: email_messages WHERE direction='inbound'
  //     AND received_at >= window. The "customer" half is approximated by
  //     `linked_account_id IS NOT NULL OR linked_carrier_id IS NULL` —
  //     same heuristic the inline classifier uses to pick the actor side.
  //   - classified-as-quote: email_signals.intent_type IN
  //     ('pricing_request','new_opportunity') joined to messages in window.
  //   - ingested: quote_opportunities WHERE source='email' AND
  //     created_at >= window.
  //   - drops: quote_pipeline_drops grouped by reason_code in window.
  app.get(
    "/api/admin/quote-pipeline/funnel",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgIdFromReq(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });

        const win = windowToInterval(qOptStr(req.query.window));
        // Single round-trip: each metric in its own scalar subquery so we
        // don't fan out a join across email_messages × signals × drops.
        const result = await db.execute(sql`
          WITH win AS (SELECT now() - (${win.sql})::interval AS since)
          SELECT
            (SELECT COUNT(*)::int FROM email_messages
              WHERE org_id = ${org}
                AND direction = 'inbound'
                AND COALESCE(provider_sent_at, created_at) >= (SELECT since FROM win)
            ) AS inbound_total,
            (SELECT COUNT(DISTINCT em.id)::int FROM email_messages em
              JOIN email_signals es ON es.message_id = em.id
              WHERE em.org_id = ${org}
                AND em.direction = 'inbound'
                AND COALESCE(em.provider_sent_at, em.created_at) >= (SELECT since FROM win)
                AND es.intent_type IN ('pricing_request','new_opportunity')
            ) AS classified_as_quote,
            (SELECT COUNT(*)::int FROM quote_opportunities
              WHERE organization_id = ${org}
                AND source = 'email'
                AND created_at >= (SELECT since FROM win)
            ) AS ingested,
            (SELECT COALESCE(json_object_agg(reason_code, c), '{}'::json) FROM (
              SELECT reason_code, COUNT(*)::int AS c
              FROM quote_pipeline_drops
              WHERE org_id = ${org}
                AND attempted_at >= (SELECT since FROM win)
              GROUP BY reason_code
            ) g) AS drops_by_reason
        `);
        const row = (result.rows?.[0] ?? {}) as Record<string, unknown>;
        const dropsByReason = (row.drops_by_reason ?? {}) as Record<string, number>;
        // Backfill zeros for every known reason so the UI can render a
        // stable shape (don't make the front-end dance around missing keys).
        const dropsBackfilled: Record<QuotePipelineDropReason, number> = {
          classifier_miss: 0,
          outbound: 0,
          duplicate: 0,
          unparseable: 0,
          exception: 0,
        };
        for (const k of Object.keys(dropsByReason)) {
          if (isValidReason(k)) dropsBackfilled[k] = Number(dropsByReason[k] ?? 0);
        }
        res.json({
          ok: true,
          window: win.label,
          inboundTotal: Number(row.inbound_total ?? 0),
          classifiedAsQuote: Number(row.classified_as_quote ?? 0),
          ingested: Number(row.ingested ?? 0),
          dropsByReason: dropsBackfilled,
        });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // ── GET /health ─────────────────────────────────────────────────────────
  // Header pill summary. Plain numbers; the UI turns them into "pipeline
  // is healthy" when openCount === 0.
  app.get(
    "/api/admin/quote-pipeline/health",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgIdFromReq(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });

        const result = await db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_count,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND attempted_at >= now() - INTERVAL '24 hours')::int AS last_24h_opened,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND attempted_at >= now() - INTERVAL '7 days')::int AS last_7d_opened,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND reason_code = 'classifier_miss')::int AS open_classifier_miss,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND reason_code = 'unparseable')::int AS open_unparseable,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND reason_code = 'exception')::int AS open_exception,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND reason_code = 'outbound')::int AS open_outbound,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND reason_code = 'duplicate')::int AS open_duplicate
          FROM quote_pipeline_drops
          WHERE org_id = ${org}
        `);
        const row = (result.rows?.[0] ?? {}) as Record<string, number | null>;
        res.json({
          ok: true,
          openCount: Number(row.open_count ?? 0),
          last24hOpened: Number(row.last_24h_opened ?? 0),
          last7dOpened: Number(row.last_7d_opened ?? 0),
          openByReason: {
            classifier_miss: Number(row.open_classifier_miss ?? 0),
            unparseable: Number(row.open_unparseable ?? 0),
            exception: Number(row.open_exception ?? 0),
            outbound: Number(row.open_outbound ?? 0),
            duplicate: Number(row.open_duplicate ?? 0),
          },
        });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // ── GET /drops ──────────────────────────────────────────────────────────
  // Paginated list with optional reason + resolved filters. The default
  // hides `duplicate` rows and resolved rows because both are usually
  // expected outcomes that don't need operator attention; a query param
  // opt-in is needed to see them.
  app.get(
    "/api/admin/quote-pipeline/drops",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgIdFromReq(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });

        const reason = qOptStr(req.query.reason);
        const resolvedParam = qOptStr(req.query.resolved);
        // Task #969 — admins opt-in to historical (archived) drops with
        // `?include_archived=1`. Default view shows only the active 30-day
        // tail so the queue stays focused on rows that still need triage.
        const includeArchived = qOptStr(req.query.include_archived) === "1";
        const limit = Math.min(Math.max(parseInt(qOptStr(req.query.limit) ?? "50", 10) || 50, 1), 500);
        const offset = Math.max(parseInt(qOptStr(req.query.offset) ?? "0", 10) || 0, 0);

        const conditions = [eq(quotePipelineDrops.orgId, org)];
        if (reason && isValidReason(reason)) {
          conditions.push(eq(quotePipelineDrops.reasonCode, reason));
        } else {
          // Default — hide noisy reasons unless explicitly requested.
          conditions.push(sql`${quotePipelineDrops.reasonCode} != 'duplicate'`);
        }
        if (resolvedParam !== "all" && resolvedParam !== "true") {
          conditions.push(sql`${quotePipelineDrops.resolvedAt} IS NULL`);
        }
        if (!includeArchived) {
          conditions.push(sql`${quotePipelineDrops.archivedAt} IS NULL`);
        }

        const rows = await db.select({
          id: quotePipelineDrops.id,
          messageId: quotePipelineDrops.messageId,
          stage: quotePipelineDrops.stage,
          reasonCode: quotePipelineDrops.reasonCode,
          detail: quotePipelineDrops.detail,
          errorMessage: quotePipelineDrops.errorMessage,
          senderEmail: quotePipelineDrops.senderEmail,
          subject: quotePipelineDrops.subject,
          receivedAt: quotePipelineDrops.receivedAt,
          confidence: quotePipelineDrops.confidence,
          quoteId: quotePipelineDrops.quoteId,
          attemptedAt: quotePipelineDrops.attemptedAt,
          resolvedAt: quotePipelineDrops.resolvedAt,
          resolutionNote: quotePipelineDrops.resolutionNote,
          reprocessCount: quotePipelineDrops.reprocessCount,
          lastReprocessAt: quotePipelineDrops.lastReprocessAt,
          lastReprocessError: quotePipelineDrops.lastReprocessError,
          archivedAt: quotePipelineDrops.archivedAt,
        })
          .from(quotePipelineDrops)
          .where(and(...conditions))
          .orderBy(desc(quotePipelineDrops.attemptedAt))
          .limit(limit)
          .offset(offset);

        // Total count for pagination — same filter set, no limit/offset.
        const totalResult = await db.execute(sql`
          SELECT COUNT(*)::int AS c
          FROM quote_pipeline_drops
          WHERE org_id = ${org}
            ${reason && isValidReason(reason) ? sql`AND reason_code = ${reason}` : sql`AND reason_code != 'duplicate'`}
            ${resolvedParam === "all" || resolvedParam === "true" ? sql`` : sql`AND resolved_at IS NULL`}
            ${includeArchived ? sql`` : sql`AND archived_at IS NULL`}
        `);
        const total = Number((totalResult.rows?.[0] as Record<string, number> | undefined)?.c ?? 0);

        res.json({ ok: true, rows, total, limit, offset, includeArchived });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // ── POST /:id/reprocess ─────────────────────────────────────────────────
  // Re-run the classifier+ingest for the underlying message. Auto-resolves
  // the drop on `ingested`; otherwise records the new attempt + error so
  // the row stays open until either a real fix lands or an admin manually
  // resolves it.
  //
  // Idempotent: ingestQuoteFromEmail's (org, source, ref) unique guard
  // means a double-click "Reprocess" on an already-ingested message just
  // returns `skipped_duplicate` with the existing quoteId.
  app.post(
    "/api/admin/quote-pipeline/drops/:id/reprocess",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgIdFromReq(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });
        const id = pStr(req.params.id);

        const drop = await storage.getQuotePipelineDrop(id, org);
        if (!drop) return res.status(404).json({ error: "Drop not found" });
        if (drop.resolvedAt) return res.status(409).json({ error: "Already resolved" });
        if (!drop.messageId) {
          // Source message was nulled (set null on delete). Nothing to
          // replay against — auto-resolve so it stops cluttering the queue.
          await storage.resolveQuotePipelineDrop(id, org, {
            resolvedById: userIdFromReq(req),
            note: "Source email message was deleted — nothing to reprocess; auto-resolved.",
          });
          return res.json({ ok: true, reprocessed: false, resolved: true, reason: "message_missing" });
        }

        // Load the full email_messages row by id. We bypass the storage
        // interface (no `getEmailMessage(id)` exists today) and read
        // directly — same pattern the inline dispatcher uses.
        const [message] = await db
          .select()
          .from(emailMessages)
          .where(and(eq(emailMessages.id, drop.messageId), eq(emailMessages.orgId, org)))
          .limit(1);
        if (!message) {
          await storage.resolveQuotePipelineDrop(id, org, {
            resolvedById: userIdFromReq(req),
            note: "Email message no longer exists in this organization — auto-resolved.",
          });
          return res.json({ ok: true, reprocessed: false, resolved: true, reason: "message_missing" });
        }

        // Re-run the appropriate stage based on where the original drop
        // happened. A `classification` drop means the classifier itself
        // didn't surface a quote signal — replaying the ingest stage
        // alone would skip the very logic the drop was created to flag.
        // An `ingestion` drop means classification already succeeded;
        // calling ingest directly is the right primitive (and avoids a
        // redundant OpenAI call).
        try {
          if (drop.stage === "classification") {
            const { replayClassificationForReprocess } = await import(
              "../services/inlineEmailClassifier"
            );
            // Replay the full classify → ingest pipeline. The classifier
            // path internally calls ingestQuoteFromEmail when a quote
            // signal is found, AND it re-records a classifier_miss drop
            // if the classifier still doesn't find one — which is the
            // correct outcome (operator sees the same drop reappear with
            // an updated lastReprocessAt).
            await replayClassificationForReprocess(message);
            // After classify→ingest, check whether a quote was actually
            // produced for this message. The dedupe lookup in
            // quoteEmailIngestion uses providerMessageId-or-id as the
            // sourceReference, so we mirror that here.
            const messageRef = message.providerMessageId ?? message.id;
            const newQuoteId = await storage.findQuoteOpportunityByMessageRef(
              org,
              messageRef,
            );
            if (newQuoteId) {
              await storage.resolveQuotePipelineDrop(id, org, {
                resolvedById: userIdFromReq(req),
                note: `Reprocess (classification replay) succeeded — quote opportunity ${newQuoteId} created.`,
              });
              return res.json({
                ok: true,
                reprocessed: true,
                resolved: true,
                status: "ingested",
                quoteId: newQuoteId,
              });
            }
            // Classifier still didn't surface a quote signal — bump the
            // counter, leave the drop open. The fresh classifier_miss
            // row recorded by the replay will dedupe via the (orgId,
            // messageId, stage, reason) UPSERT path so the operator sees
            // an updated `lastReprocessAt` on the existing row.
            await storage.bumpQuotePipelineDropReprocess(
              id,
              "Reprocess: classifier still did not surface a quote signal",
            );
            return res.status(409).json({
              ok: false,
              reprocessed: true,
              resolved: false,
              status: "classifier_miss",
              error: "Classifier replayed but still found no pricing/new_opportunity signal",
            });
          }

          // Ingestion-stage drop — bypass classification, call ingest
          // directly. Pull the latest signal extraction from the persisted
          // email_signals (cheaper + more deterministic than re-running
          // OpenAI). If none exists, ingestQuoteFromEmail will fall back
          // to its regex+AI pipeline using just the email body.
          const { ingestQuoteFromEmail } = await import("../services/quoteEmailIngestion");
          const result = await ingestQuoteFromEmail(message);
          if (result.status === "ingested") {
            await storage.resolveQuotePipelineDrop(id, org, {
              resolvedById: userIdFromReq(req),
              note: `Reprocess succeeded — quote opportunity ${result.quoteId} created.`,
            });
            return res.json({
              ok: true,
              reprocessed: true,
              resolved: true,
              status: result.status,
              quoteId: result.quoteId ?? null,
            });
          }
          if (result.status === "skipped_duplicate") {
            // The original message did become a quote at some point —
            // probably via the recovery cron between when this drop was
            // recorded and when the operator clicked reprocess. Resolve.
            await storage.resolveQuotePipelineDrop(id, org, {
              resolvedById: userIdFromReq(req),
              note: `Reprocess found existing quote ${result.quoteId} — auto-resolved.`,
            });
            return res.json({
              ok: true,
              reprocessed: true,
              resolved: true,
              status: result.status,
              quoteId: result.quoteId ?? null,
            });
          }
          // Still skipped (unparseable / outbound). Bump the counter and
          // leave the drop open with the latest reason.
          await storage.bumpQuotePipelineDropReprocess(id, `Reprocess returned status=${result.status}`);
          return res.status(409).json({
            ok: false,
            reprocessed: true,
            resolved: false,
            status: result.status,
            error: `Reprocess still skipped: ${result.status}`,
          });
        } catch (err) {
          const errMsg = getErrorMessage(err);
          await storage.bumpQuotePipelineDropReprocess(id, errMsg);
          throw err;
        }
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // ── POST /:id/resolve ───────────────────────────────────────────────────
  // Manual resolve — admin acknowledges the drop without retrying. Used
  // for cases the operator has investigated and decided don't need a
  // quote (off-topic email mis-classified as customer, internal team
  // mail, etc).
  app.post(
    "/api/admin/quote-pipeline/drops/:id/resolve",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgIdFromReq(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });
        const id = pStr(req.params.id);
        const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 1000) : null;

        const drop = await storage.getQuotePipelineDrop(id, org);
        if (!drop) return res.status(404).json({ error: "Drop not found" });
        if (drop.resolvedAt) return res.status(409).json({ error: "Already resolved" });

        const resolved = await storage.resolveQuotePipelineDrop(id, org, {
          resolvedById: userIdFromReq(req),
          note: note ?? "Manually resolved by admin (no note provided).",
        });
        res.json({ ok: true, resolved: !!resolved });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // ── GET /followup-cache-stats ──────────────────────────────────────────
  // Task #1150 — Read-only observability on the org-wide follow-up cache
  // bust. Every PATCH /api/customer-quotes/quote/:id (and a few other CQ
  // writers) calls clearStaleFollowUpCache(orgId), which is correct for
  // freshness but is org-wide on every individual quote edit. This admin
  // endpoint exposes the per-org bust counter so we can tell whether
  // moving to per-rep busting is worth the complexity. Counters live in
  // process memory and reset on restart — that's intentional, this is
  // process-local telemetry. Scoped to the requesting admin's org so we
  // don't leak other orgs' IDs/volume into a tenant's response.
  app.get(
    "/api/admin/customer-quotes/followup-cache-stats",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgIdFromReq(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });
        const stats = getFollowUpCacheBustStats();
        res.json({
          ok: true,
          orgId: org,
          bustCount: stats.totals[org] ?? 0,
          processTotalBusts: stats.totalBusts,
          processOrgCount: stats.orgCount,
        });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );
}
