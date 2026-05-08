-- ============================================================================
-- Task #1128 — Available Freight Phase 0 Read-Only Audit
-- ----------------------------------------------------------------------------
-- Purpose: size the eight high-risk patterns the AF tab audit identified
-- before any cleanup, labeling or filter change is committed. STRICTLY
-- SELECT-only — no UPDATE/INSERT/DELETE/MERGE/DDL.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/audits/af-phase0-readonly.sql
--   # or via the wrapper that prints results as JSON:
--   tsx scripts/audits/af-phase0-readonly.ts
--
-- Re-run cadence: monthly. Dev replica first; prod replica only with explicit
-- approval inside the originating task.
--
-- Sources:
--   freight_opportunities                — shared/schema.ts:4275
--   companies.is_email_derived           — shared/schema.ts:67   (Task #1095)
--   freight_daily_upload_fact            — server/services/freightDailyUploadFact.ts
--   freight_opportunity_import_audit     — server/availableFreightImporter.ts:55
-- ============================================================================

\echo '== Q1: Email-derived pollution (last 14d, by org × status) =='
SELECT
  fo.org_id,
  fo.status,
  COUNT(*)                                                AS rows,
  COUNT(*) FILTER (WHERE c.is_email_derived = true)       AS email_derived_rows,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE c.is_email_derived = true)
    / NULLIF(COUNT(*), 0),
    1
  )                                                       AS pct_email_derived
FROM freight_opportunities fo
JOIN companies c ON c.id = fo.company_id
WHERE fo.generated_at >= now() - interval '14 days'
GROUP BY fo.org_id, fo.status
ORDER BY fo.org_id, email_derived_rows DESC, fo.status;

\echo ''
\echo '== Q1b: Email-derived pollution rollup (last 14d, by org) =='
SELECT
  fo.org_id,
  COUNT(*)                                                AS rows,
  COUNT(*) FILTER (WHERE c.is_email_derived = true)       AS email_derived_rows,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE c.is_email_derived = true)
    / NULLIF(COUNT(*), 0),
    1
  )                                                       AS pct_email_derived
FROM freight_opportunities fo
JOIN companies c ON c.id = fo.company_id
WHERE fo.generated_at >= now() - interval '14 days'
GROUP BY fo.org_id
ORDER BY email_derived_rows DESC;

\echo ''
\echo '== Q2: Snooze / SLA desync (L1 or L2 fired on hidden rows) =='
SELECT
  org_id,
  COUNT(*)                                            AS desync_rows,
  COUNT(*) FILTER (WHERE sla_notified_l1_at IS NOT NULL
                AND sla_notified_l2_at IS NULL)       AS l1_only,
  COUNT(*) FILTER (WHERE sla_notified_l2_at IS NOT NULL) AS l2_fired,
  MIN(awaiting_approval_since)                        AS oldest_awaiting,
  MAX(snoozed_until)                                  AS furthest_snooze
FROM freight_opportunities
WHERE snoozed_until IS NOT NULL
  AND snoozed_until > now()
  AND awaiting_approval_since IS NOT NULL
  AND (sla_notified_l1_at IS NOT NULL OR sla_notified_l2_at IS NOT NULL)
GROUP BY org_id
ORDER BY desync_rows DESC;

\echo ''
\echo '== Q3: Importer divergence (today CT) — opps vs upload-fact =='
-- "Today" anchored to America/Chicago (the org-local timezone — see
-- server/lib/orgLocalDate.ts).
--
-- Set semantics: the task asks for the symmetric difference of
-- (orgId, normalized lane, pickup_date) TRIPLES. Both CTEs SELECT DISTINCT
-- those triples first so the FULL OUTER JOIN compares sets, not multisets;
-- a duplicate row inside one source must not inflate divergence counts.
-- Companion `_rows` columns retain the raw row counts so operators can spot
-- structural drift vs volume duplication on the same line.
WITH today_ct AS (
  SELECT to_char((now() AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS d
),
opps_raw AS (
  SELECT
    fo.org_id,
    LOWER(TRIM(fo.origin))                AS origin_city,
    LOWER(TRIM(COALESCE(fo.origin_state, '')))      AS origin_state,
    LOWER(TRIM(fo.destination))           AS dest_city,
    LOWER(TRIM(COALESCE(fo.destination_state, '')))  AS dest_state,
    LOWER(TRIM(COALESCE(fo.equipment_type, '')))     AS equipment,
    SUBSTRING(fo.pickup_window_start, 1, 10)         AS pickup_date
  FROM freight_opportunities fo, today_ct
  WHERE fo.status NOT IN ('expired','cancelled','covered')
    AND SUBSTRING(fo.pickup_window_start, 1, 10) = today_ct.d
),
fact_raw AS (
  SELECT
    f.org_id,
    LOWER(TRIM(COALESCE(f.origin_city, '')))   AS origin_city,
    LOWER(TRIM(COALESCE(f.origin_state, '')))  AS origin_state,
    LOWER(TRIM(COALESCE(f.dest_city, '')))     AS dest_city,
    LOWER(TRIM(COALESCE(f.dest_state, '')))    AS dest_state,
    LOWER(TRIM(COALESCE(f.equipment, '')))     AS equipment,
    SUBSTRING(f.ship_date, 1, 10)              AS pickup_date
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
opp_row_counts AS (
  SELECT org_id, COUNT(*) AS opp_rows FROM opps_raw GROUP BY org_id
),
fact_row_counts AS (
  SELECT org_id, COUNT(*) AS fact_rows FROM fact_raw GROUP BY org_id
),
joined AS (
  SELECT
    COALESCE(o.org_id, fct.org_id) AS org_id,
    COUNT(*) FILTER (WHERE fct.org_id IS NULL)            AS in_opps_not_in_fact,
    COUNT(*) FILTER (WHERE o.org_id   IS NULL)            AS in_fact_not_in_opps,
    COUNT(*) FILTER (WHERE o.org_id   IS NOT NULL
                       AND fct.org_id IS NOT NULL)        AS in_both
  FROM opps o
  FULL OUTER JOIN fact fct
    ON  o.org_id       = fct.org_id
    AND o.origin_city  = fct.origin_city
    AND o.origin_state = fct.origin_state
    AND o.dest_city    = fct.dest_city
    AND o.dest_state   = fct.dest_state
    AND o.equipment    = fct.equipment
    AND o.pickup_date  = fct.pickup_date
  GROUP BY COALESCE(o.org_id, fct.org_id)
)
SELECT
  j.org_id,
  j.in_opps_not_in_fact,
  j.in_fact_not_in_opps,
  j.in_both,
  COALESCE(orc.opp_rows,  0) AS opp_rows_total,
  COALESCE(frc.fact_rows, 0) AS fact_rows_total
FROM joined j
LEFT JOIN opp_row_counts  orc ON orc.org_id = j.org_id
LEFT JOIN fact_row_counts frc ON frc.org_id = j.org_id
ORDER BY j.org_id;

\echo ''
\echo '== Q4a: Unmatched-customer trend distribution (last 30d) =='
SELECT
  org_id,
  COUNT(*)                                          AS runs,
  MIN(unmatched_companies)                          AS min_unmatched,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY unmatched_companies) AS p50,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY unmatched_companies) AS p95,
  MAX(unmatched_companies)                          AS max_unmatched,
  SUM(unmatched_companies)                          AS sum_unmatched
FROM freight_opportunity_import_audit
WHERE created_at >= now() - interval '30 days'
GROUP BY org_id
ORDER BY sum_unmatched DESC;

\echo ''
\echo '== Q4b: Worst 5 import runs by unmatched_companies (last 30d) =='
SELECT
  id, org_id, file_name, total_rows, inserted, updated, expired,
  unmatched_companies, triggered_by, created_at
FROM freight_opportunity_import_audit
WHERE created_at >= now() - interval '30 days'
ORDER BY unmatched_companies DESC, created_at DESC
LIMIT 5;

\echo ''
\echo '== Q5: Owner attribution drift (>1 distinct non-null user across 4 owner-shape cols) =='
WITH owners AS (
  SELECT
    id, org_id, status,
    -- Build a deduped set of non-null owner-shape ids per row.
    (
      SELECT COUNT(DISTINCT u)
      FROM (VALUES
        (owner_user_id),
        (delegated_to_user_id),
        (created_by_id),
        (approved_by_id)
      ) AS t(u)
      WHERE u IS NOT NULL
    ) AS distinct_users
  FROM freight_opportunities
)
SELECT
  org_id,
  COUNT(*) FILTER (WHERE distinct_users >= 2) AS rows_with_owner_drift,
  COUNT(*) FILTER (WHERE distinct_users >= 3) AS rows_with_3plus_owners,
  COUNT(*) FILTER (WHERE distinct_users  = 4) AS rows_with_4_owners,
  COUNT(*)                                    AS total_rows,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE distinct_users >= 2)
    / NULLIF(COUNT(*), 0),
    2
  )                                           AS pct_drift
FROM owners
GROUP BY org_id
ORDER BY rows_with_owner_drift DESC;
