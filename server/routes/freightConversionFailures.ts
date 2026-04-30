/**
 * Phase A5 — Won-Quote conversion failure audit (admin-only).
 *
 * Surfaces every silent drop the converter
 * (createFreightOpportunityFromWonQuote) would otherwise have buried in
 * server logs, and lets admins re-run the converter with one click.
 *
 * Endpoints:
 *   GET    /api/admin/freight-conversion-failures
 *            ?status=open|resolved|all (default open)
 *   GET    /api/admin/freight-conversion-failures/health
 *            { openCount, resolvedThisWeek, last24hOpened, last7dOpened }
 *   POST   /api/admin/freight-conversion-failures/:id/retry
 *   POST   /api/admin/freight-conversion-failures/:id/resolve { note? }
 *
 * All endpoints are scoped to the requesting admin's organization.
 */
import type { Express, Request, Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, storage } from "../storage";
import { requireUser } from "../auth";
import { pStr, qOptStr } from "../lib/req";
import { getErrorMessage } from "../lib/errors";
import {
  freightOpportunityCaptureFailures,
  quoteOpportunities,
  quoteCustomers,
  quoteReps,
} from "@shared/schema";
import { createFreightOpportunityFromWonQuote } from "../services/customerQuotes";

function isAdmin(role: string | null | undefined) { return role === "admin"; }

function orgId(req: Request): string | null {
  return ((req as any).session?.organizationId as string) ?? null;
}
function userId(req: Request): string | null {
  return ((req as any).session?.userId as string) ?? null;
}

export function registerFreightConversionFailuresRoutes(app: Express) {
  // List failures, default OPEN. Joined to quote so the UI can render
  // lane + customer name without a second round-trip.
  app.get(
    "/api/admin/freight-conversion-failures",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgId(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });

        const statusParam = qOptStr(req.query.status);
        const status = statusParam === "resolved" || statusParam === "all"
          ? statusParam
          : "open";

        const rows = await db
          .select({
            id: freightOpportunityCaptureFailures.id,
            quoteId: freightOpportunityCaptureFailures.quoteId,
            reason: freightOpportunityCaptureFailures.reason,
            detail: freightOpportunityCaptureFailures.detail,
            errorMessage: freightOpportunityCaptureFailures.errorMessage,
            attemptedAt: freightOpportunityCaptureFailures.attemptedAt,
            retryCount: freightOpportunityCaptureFailures.retryCount,
            lastRetryAt: freightOpportunityCaptureFailures.lastRetryAt,
            lastRetryError: freightOpportunityCaptureFailures.lastRetryError,
            resolvedAt: freightOpportunityCaptureFailures.resolvedAt,
            resolutionNote: freightOpportunityCaptureFailures.resolutionNote,
            // Joined context — null-safe on dropped quotes.
            customerName: quoteCustomers.name,
            repName: quoteReps.name,
            originCity: quoteOpportunities.originCity,
            originState: quoteOpportunities.originState,
            destCity: quoteOpportunities.destCity,
            destState: quoteOpportunities.destState,
            equipment: quoteOpportunities.equipment,
            quotedAmount: quoteOpportunities.quotedAmount,
            outcomeStatus: quoteOpportunities.outcomeStatus,
          })
          .from(freightOpportunityCaptureFailures)
          .leftJoin(quoteOpportunities, eq(quoteOpportunities.id, freightOpportunityCaptureFailures.quoteId))
          .leftJoin(quoteCustomers, eq(quoteCustomers.id, quoteOpportunities.customerId))
          .leftJoin(quoteReps, eq(quoteReps.id, quoteOpportunities.repId))
          .where(
            status === "open"
              ? and(
                  eq(freightOpportunityCaptureFailures.orgId, org),
                  sql`${freightOpportunityCaptureFailures.resolvedAt} IS NULL`,
                )
              : status === "resolved"
                ? and(
                    eq(freightOpportunityCaptureFailures.orgId, org),
                    sql`${freightOpportunityCaptureFailures.resolvedAt} IS NOT NULL`,
                  )
                : eq(freightOpportunityCaptureFailures.orgId, org),
          )
          .orderBy(desc(freightOpportunityCaptureFailures.attemptedAt))
          .limit(500);

        res.json({ ok: true, status, rows });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // Health pill for the page header. Plain numbers; the UI turns them
  // into "Won→Freight is healthy" when openCount === 0.
  app.get(
    "/api/admin/freight-conversion-failures/health",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgId(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });

        const result = await db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE resolved_at IS NULL)::int                                        AS open_count,
            COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND resolved_at >= now() - INTERVAL '7 days')::int  AS resolved_this_week,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND attempted_at >= now() - INTERVAL '24 hours')::int   AS last_24h_opened,
            COUNT(*) FILTER (WHERE resolved_at IS NULL AND attempted_at >= now() - INTERVAL '7 days')::int     AS last_7d_opened
          FROM freight_opportunity_capture_failures
          WHERE org_id = ${org}
        `);
        const row = (result.rows?.[0] ?? {}) as Record<string, number | null>;
        res.json({
          ok: true,
          openCount: Number(row.open_count ?? 0),
          resolvedThisWeek: Number(row.resolved_this_week ?? 0),
          last24hOpened: Number(row.last_24h_opened ?? 0),
          last7dOpened: Number(row.last_7d_opened ?? 0),
        });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // Retry — re-run the converter for the underlying quote. On success
  // the converter's own success-path auto-resolves the open failure; we
  // only need to bump retry counters on hard error.
  app.post(
    "/api/admin/freight-conversion-failures/:id/retry",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgId(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });
        const id = pStr(req.params.id);

        const [failure] = await db
          .select()
          .from(freightOpportunityCaptureFailures)
          .where(and(
            eq(freightOpportunityCaptureFailures.id, id),
            eq(freightOpportunityCaptureFailures.orgId, org),
          ))
          .limit(1);
        if (!failure) return res.status(404).json({ error: "Failure not found" });
        if (failure.resolvedAt) {
          return res.status(409).json({ error: "Already resolved" });
        }

        const [quote] = await db
          .select()
          .from(quoteOpportunities)
          .where(and(
            eq(quoteOpportunities.id, failure.quoteId),
            eq(quoteOpportunities.organizationId, org),
          ))
          .limit(1);
        if (!quote) {
          // The source quote was deleted out from under us. Mark resolved
          // so it stops cluttering the queue.
          await db.update(freightOpportunityCaptureFailures).set({
            resolvedAt: new Date(),
            resolvedById: userId(req),
            resolutionNote: "Source quote no longer exists — auto-resolved on retry.",
          }).where(eq(freightOpportunityCaptureFailures.id, id));
          return res.json({ ok: true, retried: false, resolved: true, reason: "quote_missing" });
        }
        // Phase A5 — match the converter's own won predicate so we don't
        // wrongly block low-margin wins from being retried.
        const isWonRetry = quote.outcomeStatus === "won" || quote.outcomeStatus === "won_low_margin";
        if (!isWonRetry) {
          await db.update(freightOpportunityCaptureFailures).set({
            retryCount: failure.retryCount + 1,
            lastRetryAt: new Date(),
            lastRetryError: `Quote outcomeStatus is "${quote.outcomeStatus}", converter only runs on won quotes.`,
          }).where(eq(freightOpportunityCaptureFailures.id, id));
          return res.status(409).json({
            error: `Quote is not won (status="${quote.outcomeStatus}") — nothing to retry.`,
          });
        }

        try {
          const result = await createFreightOpportunityFromWonQuote(org, quote, userId(req));
          if (result?.id) {
            // Success path inside the converter already auto-resolves
            // the open failure. Fetch the (now-resolved) row and return it.
            const [resolved] = await db
              .select()
              .from(freightOpportunityCaptureFailures)
              .where(eq(freightOpportunityCaptureFailures.id, id))
              .limit(1);
            return res.json({
              ok: true,
              retried: true,
              freightOpportunityId: result.id,
              created: result.created,
              resolved: !!resolved?.resolvedAt,
            });
          }
          // Converter returned null — it logged a fresh failure record (or
          // refreshed this one). Re-read it so the UI sees the new reason.
          const [refreshed] = await db
            .select()
            .from(freightOpportunityCaptureFailures)
            .where(eq(freightOpportunityCaptureFailures.id, id))
            .limit(1);
          return res.status(409).json({
            ok: false,
            retried: true,
            error: refreshed?.detail ?? "Converter returned null — see updated failure detail.",
            failure: refreshed,
          });
        } catch (err) {
          await db.update(freightOpportunityCaptureFailures).set({
            retryCount: failure.retryCount + 1,
            lastRetryAt: new Date(),
            lastRetryError: getErrorMessage(err),
          }).where(eq(freightOpportunityCaptureFailures.id, id));
          throw err;
        }
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );

  // Manual resolve — admin acknowledges the drop without retrying (e.g.
  // the underlying quote was a duplicate or genuinely should not become
  // freight). Optional plain-language note for the audit trail.
  app.post(
    "/api/admin/freight-conversion-failures/:id/resolve",
    requireUser,
    async (req: Request, res: Response) => {
      try {
        const me = await storage.getUser((req as any).session.userId);
        if (!isAdmin(me?.role)) return res.status(403).json({ error: "Forbidden" });
        const org = orgId(req);
        if (!org) return res.status(400).json({ error: "Missing organization" });
        const id = pStr(req.params.id);
        const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 1000) : null;

        const [failure] = await db
          .select()
          .from(freightOpportunityCaptureFailures)
          .where(and(
            eq(freightOpportunityCaptureFailures.id, id),
            eq(freightOpportunityCaptureFailures.orgId, org),
          ))
          .limit(1);
        if (!failure) return res.status(404).json({ error: "Failure not found" });
        if (failure.resolvedAt) {
          return res.status(409).json({ error: "Already resolved" });
        }

        await db.update(freightOpportunityCaptureFailures).set({
          resolvedAt: new Date(),
          resolvedById: userId(req),
          resolutionNote: note ?? "Manually resolved by admin (no note provided).",
        }).where(eq(freightOpportunityCaptureFailures.id, id));

        res.json({ ok: true, resolved: true });
      } catch (err) {
        res.status(500).json({ error: getErrorMessage(err) });
      }
    },
  );
}
