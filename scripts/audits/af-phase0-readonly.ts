/**
 * Task #1128 — Available Freight Phase 0 Read-Only Audit (TS wrapper).
 *
 * Runs the five SELECT-only queries from `af-phase0-readonly.sql`, captures
 * per-query runtime, and prints a single JSON blob to stdout that the
 * diagnostic doc consumes.
 *
 * SAFETY:
 *   • Strictly SELECT-only. Refuses to run if any query string contains
 *     INSERT/UPDATE/DELETE/MERGE/CREATE/DROP/ALTER/TRUNCATE.
 *   • Refuses to run unless `process.env.AUDIT_READ_ONLY !== "false"`.
 *   • Connects through the existing `storage.pool` so credential handling
 *     stays in one place. Point it at a different replica by exporting
 *     `DATABASE_URL` before invocation.
 *
 * Usage:
 *   AUDIT_READ_ONLY=true tsx scripts/audits/af-phase0-readonly.ts
 *   AUDIT_READ_ONLY=true tsx scripts/audits/af-phase0-readonly.ts --pretty
 *   # write the JSON to disk for the diagnostic doc:
 *   AUDIT_READ_ONLY=true tsx scripts/audits/af-phase0-readonly.ts \
 *     > /tmp/audits/af-phase0-dev.json
 *
 * Re-run cadence: monthly. Dev replica first; prod only with explicit
 * approval inside the originating task.
 *
 * IMPORTANT for consumers: validate that EVERY query in the JSON payload
 * has `ok: true` before using the report for phase decisions. The wrapper
 * also exits non-zero (code 4) if any query fails, so a CI/cron caller can
 * rely on the exit code instead of parsing the JSON.
 *
 * Source-of-truth note: this TS wrapper is the canonical runtime; the
 * companion `af-phase0-readonly.sql` mirrors the same query bodies for
 * ad-hoc psql use. When editing a query, update BOTH files to keep them
 * from drifting.
 */

import { storage } from "../../server/storage";

if (process.env.AUDIT_READ_ONLY === "false") {
  console.error("[audit] AUDIT_READ_ONLY=false — refusing to run read-only audit with safety disabled.");
  process.exit(1);
}

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i;

interface Query {
  id: string;
  label: string;
  sql: string;
}

const QUERIES: Query[] = [
  {
    id: "Q1_email_derived_pollution",
    label: "Email-derived pollution (last 14d, by org × status)",
    sql: `
      SELECT fo.org_id, fo.status,
             COUNT(*) AS rows,
             COUNT(*) FILTER (WHERE c.is_email_derived = true) AS email_derived_rows,
             ROUND(100.0 * COUNT(*) FILTER (WHERE c.is_email_derived = true)
                   / NULLIF(COUNT(*), 0), 1) AS pct_email_derived
        FROM freight_opportunities fo
        JOIN companies c ON c.id = fo.company_id
       WHERE fo.generated_at >= now() - interval '14 days'
       GROUP BY fo.org_id, fo.status
       ORDER BY fo.org_id, email_derived_rows DESC, fo.status
    `,
  },
  {
    id: "Q1b_email_derived_pollution_rollup",
    label: "Email-derived pollution rollup (last 14d, by org)",
    sql: `
      SELECT fo.org_id,
             COUNT(*) AS rows,
             COUNT(*) FILTER (WHERE c.is_email_derived = true) AS email_derived_rows,
             ROUND(100.0 * COUNT(*) FILTER (WHERE c.is_email_derived = true)
                   / NULLIF(COUNT(*), 0), 1) AS pct_email_derived
        FROM freight_opportunities fo
        JOIN companies c ON c.id = fo.company_id
       WHERE fo.generated_at >= now() - interval '14 days'
       GROUP BY fo.org_id
       ORDER BY email_derived_rows DESC
    `,
  },
  {
    id: "Q2_snooze_sla_desync",
    label: "Snooze/SLA desync — L1/L2 fired on hidden rows (current)",
    sql: `
      SELECT org_id,
             COUNT(*) AS desync_rows,
             COUNT(*) FILTER (WHERE sla_notified_l1_at IS NOT NULL
                                AND sla_notified_l2_at IS NULL) AS l1_only,
             COUNT(*) FILTER (WHERE sla_notified_l2_at IS NOT NULL) AS l2_fired,
             MIN(awaiting_approval_since) AS oldest_awaiting,
             MAX(snoozed_until)           AS furthest_snooze
        FROM freight_opportunities
       WHERE snoozed_until IS NOT NULL
         AND snoozed_until > now()
         AND awaiting_approval_since IS NOT NULL
         AND (sla_notified_l1_at IS NOT NULL OR sla_notified_l2_at IS NOT NULL)
       GROUP BY org_id
       ORDER BY desync_rows DESC
    `,
  },
  {
    id: "Q3_importer_divergence_today",
    label: "Importer divergence today (CT) — opps vs upload-fact (DISTINCT triples)",
    // Set semantics: we compare DISTINCT triples (orgId, normalized lane,
    // pickup_date) on each side so a duplicate row inside one source can't
    // inflate divergence counts. Companion `_rows_total` columns retain the
    // raw row counts so operators can spot structural drift vs volume
    // duplication on the same line.
    sql: `
      WITH today_ct AS (
        SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS d
      ),
      opps_raw AS (
        SELECT fo.org_id,
               LOWER(TRIM(fo.origin)) AS origin_city,
               LOWER(TRIM(COALESCE(fo.origin_state, ''))) AS origin_state,
               LOWER(TRIM(fo.destination)) AS dest_city,
               LOWER(TRIM(COALESCE(fo.destination_state, ''))) AS dest_state,
               LOWER(TRIM(COALESCE(fo.equipment_type, ''))) AS equipment,
               SUBSTRING(fo.pickup_window_start, 1, 10) AS pickup_date
          FROM freight_opportunities fo, today_ct
         WHERE fo.status NOT IN ('expired','cancelled','covered')
           AND SUBSTRING(fo.pickup_window_start, 1, 10) = today_ct.d
      ),
      fact_raw AS (
        SELECT f.org_id,
               LOWER(TRIM(COALESCE(f.origin_city, ''))) AS origin_city,
               LOWER(TRIM(COALESCE(f.origin_state, ''))) AS origin_state,
               LOWER(TRIM(COALESCE(f.dest_city, '')))    AS dest_city,
               LOWER(TRIM(COALESCE(f.dest_state, '')))   AS dest_state,
               LOWER(TRIM(COALESCE(f.equipment, '')))    AS equipment,
               SUBSTRING(f.ship_date, 1, 10)             AS pickup_date
          FROM freight_daily_upload_fact f, today_ct
         WHERE f.ship_date IS NOT NULL
           AND SUBSTRING(f.ship_date, 1, 10) = today_ct.d
      ),
      opps AS (
        SELECT DISTINCT org_id, origin_city, origin_state, dest_city, dest_state, equipment, pickup_date
          FROM opps_raw
      ),
      fact AS (
        SELECT DISTINCT org_id, origin_city, origin_state, dest_city, dest_state, equipment, pickup_date
          FROM fact_raw
      ),
      opp_row_counts  AS (SELECT org_id, COUNT(*) AS opp_rows  FROM opps_raw GROUP BY org_id),
      fact_row_counts AS (SELECT org_id, COUNT(*) AS fact_rows FROM fact_raw GROUP BY org_id),
      joined AS (
        SELECT COALESCE(o.org_id, fct.org_id) AS org_id,
               COUNT(*) FILTER (WHERE fct.org_id IS NULL) AS in_opps_not_in_fact,
               COUNT(*) FILTER (WHERE o.org_id   IS NULL) AS in_fact_not_in_opps,
               COUNT(*) FILTER (WHERE o.org_id IS NOT NULL AND fct.org_id IS NOT NULL) AS in_both
          FROM opps o
          FULL OUTER JOIN fact fct
            ON  o.org_id = fct.org_id
            AND o.origin_city = fct.origin_city
            AND o.origin_state = fct.origin_state
            AND o.dest_city = fct.dest_city
            AND o.dest_state = fct.dest_state
            AND o.equipment = fct.equipment
            AND o.pickup_date = fct.pickup_date
         GROUP BY COALESCE(o.org_id, fct.org_id)
      )
      SELECT j.org_id,
             j.in_opps_not_in_fact,
             j.in_fact_not_in_opps,
             j.in_both,
             COALESCE(orc.opp_rows,  0) AS opp_rows_total,
             COALESCE(frc.fact_rows, 0) AS fact_rows_total
        FROM joined j
        LEFT JOIN opp_row_counts  orc ON orc.org_id = j.org_id
        LEFT JOIN fact_row_counts frc ON frc.org_id = j.org_id
       ORDER BY j.org_id
    `,
  },
  {
    id: "Q4a_unmatched_customer_distribution",
    label: "Unmatched-customer distribution (last 30d, by org)",
    sql: `
      SELECT org_id,
             COUNT(*) AS runs,
             MIN(unmatched_companies) AS min_unmatched,
             PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY unmatched_companies) AS p50,
             PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY unmatched_companies) AS p95,
             MAX(unmatched_companies) AS max_unmatched,
             SUM(unmatched_companies) AS sum_unmatched
        FROM freight_opportunity_import_audit
       WHERE created_at >= now() - interval '30 days'
       GROUP BY org_id
       ORDER BY sum_unmatched DESC
    `,
  },
  {
    id: "Q4b_worst_5_import_runs",
    label: "Worst 5 import runs by unmatched_companies (last 30d)",
    sql: `
      SELECT id, org_id, file_name, total_rows, inserted, updated, expired,
             unmatched_companies, triggered_by, created_at
        FROM freight_opportunity_import_audit
       WHERE created_at >= now() - interval '30 days'
       ORDER BY unmatched_companies DESC, created_at DESC
       LIMIT 5
    `,
  },
  {
    id: "Q5_owner_attribution_drift",
    label: "Owner attribution drift (>1 distinct non-null user across 4 owner-shape cols)",
    sql: `
      WITH owners AS (
        SELECT id, org_id, status,
               (SELECT COUNT(DISTINCT u)
                  FROM (VALUES (owner_user_id),
                               (delegated_to_user_id),
                               (created_by_id),
                               (approved_by_id)) AS t(u)
                 WHERE u IS NOT NULL) AS distinct_users
          FROM freight_opportunities
      )
      SELECT org_id,
             COUNT(*) FILTER (WHERE distinct_users >= 2) AS rows_with_owner_drift,
             COUNT(*) FILTER (WHERE distinct_users >= 3) AS rows_with_3plus_owners,
             COUNT(*) FILTER (WHERE distinct_users  = 4) AS rows_with_4_owners,
             COUNT(*)                                    AS total_rows,
             ROUND(100.0 * COUNT(*) FILTER (WHERE distinct_users >= 2)
                   / NULLIF(COUNT(*), 0), 2) AS pct_drift
        FROM owners
       GROUP BY org_id
       ORDER BY rows_with_owner_drift DESC
    `,
  },
];

interface Outcome {
  id: string;
  label: string;
  ok: boolean;
  rowCount: number;
  runtimeMs: number;
  rows?: unknown[];
  error?: string;
}

async function run() {
  // Refuse to execute anything that smells like a write.
  for (const q of QUERIES) {
    if (FORBIDDEN.test(q.sql)) {
      console.error(`[audit] ${q.id} contains a forbidden write keyword — aborting.`);
      process.exit(2);
    }
  }

  const out: Outcome[] = [];
  for (const q of QUERIES) {
    const t0 = Date.now();
    try {
      const result = await storage.pool.query(q.sql);
      out.push({
        id: q.id,
        label: q.label,
        ok: true,
        rowCount: result.rowCount ?? result.rows.length,
        runtimeMs: Date.now() - t0,
        rows: result.rows,
      });
    } catch (err) {
      out.push({
        id: q.id,
        label: q.label,
        ok: false,
        rowCount: 0,
        runtimeMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pretty = process.argv.includes("--pretty");
  const payload = {
    generatedAt: new Date().toISOString(),
    databaseUrlHash: hashDbUrl(process.env.DATABASE_URL ?? ""),
    queries: out,
  };
  process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + "\n");
  await storage.pool.end().catch(() => {});

  // Operational guard: if any query returned ok=false the JSON payload was
  // still printed (so it can be inspected) but the process must exit non-zero
  // so monthly reruns don't silently hand a partial report to the next phase
  // decision. Every consumer should validate ok=true on every query before
  // using the report for phase decisions.
  const failed = out.filter((o) => !o.ok);
  if (failed.length > 0) {
    console.error(
      `[audit] ${failed.length}/${out.length} queries failed: ${failed
        .map((f) => f.id)
        .join(", ")}`,
    );
    process.exit(4);
  }
}

function hashDbUrl(url: string): string {
  // Strip credentials before fingerprinting so we can identify which replica
  // a JSON came from without leaking secrets into a doc.
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "unknown";
  }
}

run().catch((err) => {
  console.error("[audit] fatal:", err);
  process.exit(3);
});
