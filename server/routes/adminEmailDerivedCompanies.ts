/**
 * Read-only admin console: Email-derived stub companies.
 *
 * Lists companies in the caller's organization that look like they were
 * auto-created by the inbound-email → company pipeline (Tasks #1052 / #1056)
 * and never matured into real customers, classifies each one into a
 * triage bucket, and attaches name-similarity hints to existing real
 * companies. Match criteria for the stub list:
 *
 *   - 0 rows in `contacts` for the company
 *   - `owner_rep_id IS NULL`
 *   - `industry IS NULL` or empty
 *   - `archived_at IS NULL`
 *
 * For each match we surface every signal we have so the admin can see
 * whether the row is truly orphan or just thinly populated:
 *
 *   - `firstSeenAt` (DERIVED — `companies` has no `created_at` column;
 *     this is MIN over inbound email created_at, QO created_at,
 *     FO generated_at)
 *   - inbound `email_messages` count + first/last (joined via `linked_account_id`)
 *   - `email_conversation_threads` count tied to the company
 *   - `quote_opportunities` count
 *   - `freight_opportunities` count
 *   - `bucket`: classification — `real_incomplete`, `duplicate_candidate`,
 *     or `low_value_stub`
 *   - `similarityHints`: top up to 3 real companies in the same org whose
 *     normalized name resembles this stub's name (Dice coefficient on
 *     char bigrams)
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

export type StubBucket = "real_incomplete" | "duplicate_candidate" | "low_value_stub";

export type SimilarityHint = {
  companyId: string;
  companyName: string;
  score: number; // 0..1
};

export type EmailDerivedCompanyRow = {
  companyId: string;
  companyName: string;
  organizationId: string | null;
  firstSeenAt: string | null;
  inboundEmailCount: number;
  threadCount: number;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  quoteOpportunityCount: number;
  freightOpportunityCount: number;
  bucket: StubBucket;
  bucketReason: string;
  similarityHints: SimilarityHint[];
};

export type EmailDerivedCompaniesResponse = {
  ok: true;
  generatedAt: string;
  organizationId: string;
  totalCompanies: number;
  matched: number;
  matchedWithInboundEmail: number;
  bucketCounts: Record<StubBucket, number>;
  rows: EmailDerivedCompanyRow[];
};

// ── Classification thresholds (deliberately loose; tuned to "show me
// signal", not "auto-decide"). The admin is the decision-maker. ───────────
const SIMILARITY_DUPLICATE_THRESHOLD = 0.65;
const SIMILARITY_HINT_THRESHOLD = 0.45;
const SIMILARITY_HINT_MAX = 3;
const REAL_INCOMPLETE_FO_THRESHOLD = 3;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co|group|holdings|enterprises|llp|trucking|logistics|transport|transportation|freight|carriers?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export function registerAdminEmailDerivedCompaniesRoutes(app: Express): void {
  app.get("/api/admin/email-derived-companies", requireAuth, async (req, res) => {
    try {
      const user = await getCurrentUser(req);
      if (!user) return res.status(401).json({ error: "Not authenticated" });
      if (!isAdmin(user)) return res.status(403).json({ error: "Admin access required" });

      const orgId = user.organizationId;

      // ── Stub rows + per-stub signals (single CTE) ────────────────────
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
        first_qo_at: string | null;
        first_fo_at: string | null;
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
        qo AS (
          SELECT customer_id      AS company_id,
                 COUNT(*)::bigint AS n,
                 MIN(created_at)  AS first_at
            FROM quote_opportunities
           WHERE organization_id = ${orgId}
             AND customer_id IN (SELECT id FROM base)
           GROUP BY customer_id
        ),
        fo AS (
          SELECT company_id        AS company_id,
                 COUNT(*)::bigint  AS n,
                 MIN(generated_at) AS first_at
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
               COALESCE(fo.n, 0)::bigint         AS freight_opportunity_count,
               qo.first_at                       AS first_qo_at,
               fo.first_at                       AS first_fo_at
          FROM base b
          LEFT JOIN contact_counts cc ON cc.company_id = b.id
          LEFT JOIN inbound        i  ON i.company_id  = b.id
          LEFT JOIN threads        t  ON t.company_id  = b.id
          LEFT JOIN qo             qo ON qo.company_id = b.id
          LEFT JOIN fo             fo ON fo.company_id = b.id
         WHERE COALESCE(cc.n, 0) = 0
         ORDER BY COALESCE(i.last_at, fo.first_at, qo.first_at, '1970-01-01'::timestamp) DESC,
                  b.name ASC
         LIMIT 1000
      `);

      // ── Real companies in same org used as similarity targets ────────
      // "Real" = not a stub: has any one of owner, industry, contacts, or
      // is archived (archived rows still represent legitimate prior work).
      const realRows = await db.execute<{ id: string; name: string }>(sql`
        SELECT c.id, c.name
          FROM companies c
         WHERE c.organization_id = ${orgId}
           AND (
                 c.owner_rep_id IS NOT NULL
              OR (c.industry IS NOT NULL AND c.industry <> '')
              OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id LIMIT 1)
              OR c.archived_at IS NOT NULL
               )
      `);

      const realIndex = realRows.rows.map((r) => {
        const norm = normalizeName(r.name || "");
        return { id: r.id, name: r.name, norm, grams: bigrams(norm) };
      }).filter((r) => r.norm.length >= 2);

      const totalRow = await db.execute<{ n: string }>(sql`
        SELECT COUNT(*)::bigint AS n FROM companies WHERE organization_id = ${orgId}
      `);

      const bucketCounts: Record<StubBucket, number> = {
        real_incomplete: 0,
        duplicate_candidate: 0,
        low_value_stub: 0,
      };

      const enriched: EmailDerivedCompanyRow[] = rows.rows.map((r) => {
        const inboundN = Number(r.inbound_email_count);
        const threadN = Number(r.thread_count);
        const qoN = Number(r.quote_opportunity_count);
        const foN = Number(r.freight_opportunity_count);

        // Derived first-seen
        const candidates = [r.first_inbound_at, r.first_qo_at, r.first_fo_at]
          .filter((x): x is string => !!x)
          .map((x) => new Date(x).getTime())
          .filter((n) => Number.isFinite(n));
        const firstSeen = candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;

        // Similarity hints
        const stubNorm = normalizeName(r.company_name || "");
        const hints: SimilarityHint[] = [];
        if (stubNorm.length >= 2) {
          const stubGrams = bigrams(stubNorm);
          for (const candidate of realIndex) {
            // Cheap pre-filter: skip if neither name contains a 3-char run of the other
            const score = dice(stubGrams, candidate.grams);
            if (score >= SIMILARITY_HINT_THRESHOLD) {
              hints.push({ companyId: candidate.id, companyName: candidate.name, score });
            }
          }
          hints.sort((a, b) => b.score - a.score);
          hints.length = Math.min(hints.length, SIMILARITY_HINT_MAX);
        }

        // Bucket
        let bucket: StubBucket;
        let reason: string;
        if (hints.length > 0 && hints[0].score >= SIMILARITY_DUPLICATE_THRESHOLD) {
          bucket = "duplicate_candidate";
          reason = `Name resembles "${hints[0].companyName}" (${(hints[0].score * 100).toFixed(0)}% match)`;
        } else if (qoN > 0 || foN >= REAL_INCOMPLETE_FO_THRESHOLD || inboundN > 0 || threadN > 0) {
          bucket = "real_incomplete";
          const bits: string[] = [];
          if (qoN > 0) bits.push(`${qoN} quote opp${qoN === 1 ? "" : "s"}`);
          if (foN > 0) bits.push(`${foN} freight opp${foN === 1 ? "" : "s"}`);
          if (inboundN > 0) bits.push(`${inboundN} inbound email${inboundN === 1 ? "" : "s"}`);
          if (threadN > 0) bits.push(`${threadN} thread${threadN === 1 ? "" : "s"}`);
          reason = `Has activity: ${bits.join(", ")}`;
        } else {
          bucket = "low_value_stub";
          reason = "No quote opps, no inbound emails, no threads, and < 3 freight opps";
        }
        bucketCounts[bucket]++;

        return {
          companyId: r.company_id,
          companyName: r.company_name,
          organizationId: r.organization_id,
          firstSeenAt: firstSeen,
          inboundEmailCount: inboundN,
          threadCount: threadN,
          firstInboundAt: r.first_inbound_at,
          lastInboundAt: r.last_inbound_at,
          quoteOpportunityCount: qoN,
          freightOpportunityCount: foN,
          bucket,
          bucketReason: reason,
          similarityHints: hints,
        };
      });

      const out: EmailDerivedCompaniesResponse = {
        ok: true,
        generatedAt: new Date().toISOString(),
        organizationId: orgId,
        totalCompanies: Number(totalRow.rows[0]?.n ?? 0),
        matched: enriched.length,
        matchedWithInboundEmail: enriched.filter((r) => r.inboundEmailCount > 0).length,
        bucketCounts,
        rows: enriched,
      };

      res.json(out);
    } catch (err) {
      console.error("GET /api/admin/email-derived-companies error:", err);
      res.status(500).json({ error: "Failed to compute email-derived companies" });
    }
  });
}
