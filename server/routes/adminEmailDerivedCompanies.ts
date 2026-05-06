/**
 * Read-only admin console: Email-derived stub companies.
 *
 * Lists companies in the caller's organization that look like they were
 * auto-created by the inbound-email → company pipeline (Tasks #1052 / #1056)
 * and never matured into real customers. Match criteria:
 *
 *   - 0 rows in `contacts` for the company
 *   - `owner_rep_id IS NULL`
 *   - `industry IS NULL` or empty
 *   - `archived_at IS NULL`
 *
 * For each match we surface every signal we have so the admin can see
 * whether the row is truly orphan or just thinly populated:
 *
 *   - Inbound `email_messages` count + first/last (joined via `linked_account_id`)
 *   - `email_conversation_threads` count tied to the company
 *   - `quote_opportunities` count
 *   - `freight_opportunities` count
 *
 * Important note recorded during incident triage 2026-05-06:
 * `email_messages.linked_account_id` is sparsely populated in prod (≈1
 * distinct company); the thread-level `linked_account_id` covers a few
 * more. The view therefore does NOT require an inbound-email link to
 * include a row — it surfaces email evidence as columns instead.
 *
 * READ-ONLY by contract — this file MUST NOT contain any INSERT / UPDATE /
 * DELETE statements. Enforced by Section 1092 of
 * `tests/code-quality-guardrails.test.ts`.
 */

import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../storage";
import { requireAuth, getCurrentUser } from "../auth";
import { isAdmin } from "../lib/roles";

export type EmailDerivedCompanyRow = {
  companyId: string;
  companyName: string;
  organizationId: string | null;
  inboundEmailCount: number;
  threadCount: number;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  quoteOpportunityCount: number;
  freightOpportunityCount: number;
};

export type EmailDerivedCompaniesResponse = {
  ok: true;
  generatedAt: string;
  organizationId: string;
  totalCompanies: number;
  matched: number;
  matchedWithInboundEmail: number;
  rows: EmailDerivedCompanyRow[];
};

export function registerAdminEmailDerivedCompaniesRoutes(app: Express): void {
  app.get("/api/admin/email-derived-companies", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(user)) return res.status(403).json({ error: "Admin access required" });

      const orgId = user.organizationId;

      const rows = await db.execute<{
        company_id: string;
        company_name: string;
        organization_id: string | null;
        inbound_email_count: string;
        thread_count: string;
        first_inbound_at: string | null;
        last_inbound_at: string | null;
        quote_opportunity_count: string;
        freight_opportunity_count: string;
      }>(sql`
        WITH base AS (
          SELECT id, name, organization_id
            FROM companies
           WHERE organization_id = ${orgId}
             AND owner_rep_id IS NULL
             AND (industry IS NULL OR industry = '')
             AND archived_at IS NULL
        ),
        contact_counts AS (
          SELECT company_id, COUNT(*)::int AS n
            FROM contacts
           WHERE company_id IN (SELECT id FROM base)
           GROUP BY company_id
        ),
        inbound AS (
          SELECT linked_account_id AS company_id,
                 COUNT(*)::bigint  AS n,
                 MIN(created_at)   AS first_at,
                 MAX(created_at)   AS last_at
            FROM email_messages
           WHERE org_id = ${orgId}
             AND direction = 'inbound'
             AND linked_account_id IN (SELECT id FROM base)
           GROUP BY linked_account_id
        ),
        threads AS (
          SELECT linked_account_id AS company_id, COUNT(*)::bigint AS n
            FROM email_conversation_threads
           WHERE org_id = ${orgId}
             AND linked_account_id IN (SELECT id FROM base)
           GROUP BY linked_account_id
        ),
        qo_counts AS (
          SELECT customer_id AS company_id, COUNT(*)::bigint AS n
            FROM quote_opportunities
           WHERE organization_id = ${orgId}
             AND customer_id IN (SELECT id FROM base)
           GROUP BY customer_id
        ),
        fo_counts AS (
          SELECT company_id, COUNT(*)::bigint AS n
            FROM freight_opportunities
           WHERE org_id = ${orgId}
             AND company_id IN (SELECT id FROM base)
           GROUP BY company_id
        )
        SELECT b.id                              AS company_id,
               b.name                            AS company_name,
               b.organization_id                 AS organization_id,
               COALESCE(i.n, 0)::bigint          AS inbound_email_count,
               COALESCE(t.n, 0)::bigint          AS thread_count,
               i.first_at                        AS first_inbound_at,
               i.last_at                         AS last_inbound_at,
               COALESCE(qo.n, 0)::bigint         AS quote_opportunity_count,
               COALESCE(fo.n, 0)::bigint         AS freight_opportunity_count
          FROM base b
          LEFT JOIN contact_counts cc ON cc.company_id = b.id
          LEFT JOIN inbound        i  ON i.company_id  = b.id
          LEFT JOIN threads        t  ON t.company_id  = b.id
          LEFT JOIN qo_counts      qo ON qo.company_id = b.id
          LEFT JOIN fo_counts      fo ON fo.company_id = b.id
         WHERE COALESCE(cc.n, 0) = 0
         ORDER BY COALESCE(i.last_at, '1970-01-01'::timestamp) DESC,
                  b.name ASC
         LIMIT 1000
      `);

      const totalRow = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::bigint AS n FROM companies WHERE organization_id = ${orgId}
      `);

      const out: EmailDerivedCompaniesResponse = {
        ok: true,
        generatedAt: new Date().toISOString(),
        organizationId: orgId,
        totalCompanies: Number(totalRow.rows[0]?.n ?? 0),
        matched: rows.rows.length,
        matchedWithInboundEmail: rows.rows.filter((r) => Number(r.inbound_email_count) > 0).length,
        rows: rows.rows.map((r) => ({
          companyId: r.company_id,
          companyName: r.company_name,
          organizationId: r.organization_id,
          inboundEmailCount: Number(r.inbound_email_count),
          threadCount: Number(r.thread_count),
          firstInboundAt: r.first_inbound_at,
          lastInboundAt: r.last_inbound_at,
          quoteOpportunityCount: Number(r.quote_opportunity_count),
          freightOpportunityCount: Number(r.freight_opportunity_count),
        })),
      };

      res.json(out);
    } catch (err) {
      console.error("GET /api/admin/email-derived-companies error:", err);
      res.status(500).json({ error: "Failed to compute email-derived companies" });
    }
  });
}
