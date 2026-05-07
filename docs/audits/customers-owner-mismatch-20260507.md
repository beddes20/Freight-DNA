# Customers — Owner Mismatch Diff

**Generated:** 2026-05-07 (production read-replica via the `database` skill, `environment: "production"`)
**Artifact:** [`exports/customers-owner-mismatch-20260507.csv`](exports/customers-owner-mismatch-20260507.csv)
**Posture:** Read-only. No production writes, no schema changes, no UI/route changes, no auto-fix proposals. Phase-2 reconciliation is a separate future task once directors mark up this CSV.

---

## What this is

Every `companies` row whose canonical owner column (`owner_rep_id`, Task #1011) and legacy account-manager column (`assigned_to`) are both populated and disagree. Both columns are bare `varchar` with no FK to `users`, so stale references survive — those surface here as `owner_inactive` / `assigned_inactive` rather than dropped rows. The `sales_person_id` column (sales-org book of business) is included for context — it is a third "owner-ish" field and the audit needs to know when it agrees with one column but not the other.

This is the read-only diff artifact called for by the customers-tab audit. It is **not** a fix list and **not** a backfill plan.

## "Inactive user" proxy

`users` has no `archived_at` / `deleted_at` / `is_active` column today. "Inactive" is **inferred** in SQL as:

```
users.id IS NULL                                              -- referenced user no longer exists
OR NULLIF(users.last_login_at, '') IS NULL                    -- never logged in
OR NULLIF(users.last_login_at, '')::timestamptz < (now() - interval '90 days')
```

`users.last_login_at` is a `text` column; the `NULLIF(..., '')::timestamptz` cast is deliberate so empty strings do not throw. This is an opinionated heuristic, not a system flag — directors should treat the `owner_inactive_proxy` / `assigned_inactive_proxy` columns as a starting point for review, not a verdict.

## Production schema caveat

The production `companies` table did not yet have the Task #1095 columns (`is_email_derived`, `email_derived_at`, `email_derived_seed_message_id`) at the time of this snapshot — no Drizzle push has happened in prod yet. The CSV's `company_is_email_derived` column is therefore hard-coded to `f` (false) for every row, and the `email_derived_company` branch in the `mismatch_category` `CASE` is wired to a literal `WHEN false THEN 'email_derived_company'` so the **branch and its precedence position are preserved** but cannot match in this snapshot. A re-run after the prod push only requires swapping the literal for `WHEN c.is_email_derived = true THEN 'email_derived_company'` — the rest of the SQL is unchanged. Directors reviewing this CSV should treat email-derived classification as "not yet measurable in prod" rather than "no email-derived rows".

## Exact SQL used

```sql
SELECT
  c.organization_id,
  o.name AS organization_name,
  c.id AS company_id,
  c.name AS company_name,
  (c.archived_at IS NOT NULL) AS company_archived,
  false AS company_is_email_derived,
  c.owner_rep_id,
  uo.name AS owner_name,
  uo.username AS owner_username,
  uo.role AS owner_role,
  uo.last_login_at AS owner_last_login_at,
  CASE
    WHEN c.owner_rep_id IS NULL THEN false
    WHEN uo.id IS NULL THEN true
    WHEN NULLIF(uo.last_login_at, '') IS NULL THEN true
    WHEN NULLIF(uo.last_login_at, '')::timestamptz < (now() - interval '90 days') THEN true
    ELSE false
  END AS owner_inactive_proxy,
  c.assigned_to,
  ua.name AS assigned_name,
  ua.username AS assigned_username,
  ua.role AS assigned_role,
  ua.last_login_at AS assigned_last_login_at,
  CASE
    WHEN c.assigned_to IS NULL THEN false
    WHEN ua.id IS NULL THEN true
    WHEN NULLIF(ua.last_login_at, '') IS NULL THEN true
    WHEN NULLIF(ua.last_login_at, '')::timestamptz < (now() - interval '90 days') THEN true
    ELSE false
  END AS assigned_inactive_proxy,
  c.sales_person_id,
  us.name AS sales_person_name,
  us.role AS sales_person_role,
  CASE
    -- Precedence order matches the Task #1118 spec exactly. The first
    -- matching label wins. The 'email_derived_company' branch is kept
    -- explicit even though the prod schema is missing the
    -- companies.is_email_derived column today (Task #1095 push not yet
    -- applied to prod) — it is wired to a literal `false` so the
    -- precedence is preserved and a re-run after the prod push only
    -- requires swapping the literal for `c.is_email_derived = true`.
    WHEN c.archived_at IS NOT NULL THEN 'archived_company'
    WHEN false THEN 'email_derived_company'
    WHEN (uo.id IS NULL OR NULLIF(uo.last_login_at,'') IS NULL OR NULLIF(uo.last_login_at,'')::timestamptz < (now() - interval '90 days'))
      AND (ua.id IS NULL OR NULLIF(ua.last_login_at,'') IS NULL OR NULLIF(ua.last_login_at,'')::timestamptz < (now() - interval '90 days'))
      THEN 'both_inactive'
    WHEN (uo.id IS NULL OR NULLIF(uo.last_login_at,'') IS NULL OR NULLIF(uo.last_login_at,'')::timestamptz < (now() - interval '90 days'))
      THEN 'owner_inactive'
    WHEN (ua.id IS NULL OR NULLIF(ua.last_login_at,'') IS NULL OR NULLIF(ua.last_login_at,'')::timestamptz < (now() - interval '90 days'))
      THEN 'assigned_inactive'
    WHEN c.sales_person_id IS NOT NULL AND c.owner_rep_id = c.sales_person_id AND c.sales_person_id IS DISTINCT FROM c.assigned_to
      THEN 'owner_eq_sales_ne_assigned'
    WHEN c.sales_person_id IS NOT NULL AND c.assigned_to = c.sales_person_id AND c.sales_person_id IS DISTINCT FROM c.owner_rep_id
      THEN 'assigned_eq_sales_ne_owner'
    WHEN c.sales_person_id IS NOT NULL AND c.sales_person_id IS DISTINCT FROM c.owner_rep_id AND c.sales_person_id IS DISTINCT FROM c.assigned_to
      THEN 'all_three_differ'
    ELSE 'clean_disagreement'
  END AS mismatch_category
FROM companies c
LEFT JOIN users uo ON uo.id = c.owner_rep_id
LEFT JOIN users ua ON ua.id = c.assigned_to
LEFT JOIN users us ON us.id = c.sales_person_id
LEFT JOIN organizations o ON o.id = c.organization_id
WHERE c.owner_rep_id IS NOT NULL
  AND c.assigned_to IS NOT NULL
  AND c.owner_rep_id IS DISTINCT FROM c.assigned_to
ORDER BY o.name, c.name;
```

Re-run via the `database` skill with `environment: "production"`. The query is a pure `SELECT` — no CTE writes, no `FOR UPDATE`, no `WITH ... AS (INSERT ...)`.

## Headline numbers

- **Total mismatched companies:** **2**
- **Sample size** (`companies` rows with both `owner_rep_id` and `assigned_to` populated): **9**
- **Mismatch rate within sample:** **~22.2%** (2 / 9)
- **Mismatch rate vs whole org book** (267 non-archived companies across all orgs): **~0.75%** (2 / 267)

The sample size is small because most production rows have at least one of the two ownership fields null — those rows are out of scope for this diff (the task targets disagreements where both are populated). They remain a separate cleanup concern (see "Not included" below).

## Counts by organization

| organization_name | mismatch_count | active_book | mismatch_rate_vs_active_book |
|---|---:|---:|---:|
| Value Truck | 2 | 251 | 0.80% |
| Demo Org | 0 | 10 | 0% |
| Fixture Guard Org 1777325756225 | 0 | 2 | 0% |
| Fixture Guard Org 1777326047505 | 0 | 1 | 0% |
| Hero Loop Test 1778076221906 | 0 | 1 | 0% |
| Hero Loop Test 1778076222109 | 0 | 1 | 0% |
| Hero Loop Test 1778076222051 | 0 | 1 | 0% |

## Counts by mismatch category

Categories are evaluated top-to-bottom; the **first** matching label wins.

| mismatch_category | count |
|---|---:|
| `archived_company` | 0 |
| `email_derived_company` | 0 (not measurable — see "Production schema caveat" above) |
| `both_inactive` | 0 |
| `owner_inactive` | 1 |
| `assigned_inactive` | 0 |
| `owner_eq_sales_ne_assigned` | 0 |
| `assigned_eq_sales_ne_owner` | 0 |
| `all_three_differ` | 0 |
| `clean_disagreement` | 1 |

## Orgs above the 10% callout threshold

> Threshold: mismatch count > 10% of the org's `count(*) FILTER (WHERE archived_at IS NULL)`.

**None.** Value Truck is the only org with any mismatches and sits at 0.80% of its non-archived book — well below the 10% callout bar.

## Not included (out of scope, deliberately)

Repeating the task's out-of-scope list so the next reviewer does not assume action was taken:

- **No writes to `companies.owner_rep_id`, `companies.assigned_to`, or `companies.sales_person_id`.** Every artifact above is the product of a single `SELECT`.
- **No call to `PATCH /api/companies/:id/owner` or any owner-write endpoint.**
- **No schema changes** — no new columns, no migrations, no `drizzle-kit push:pg`. (The Task #1095 prod push is a separate concern; this audit just notes that prod doesn't yet have the column.)
- **No UI changes** — the Customers tab, admin consoles, and dialogs are untouched.
- **No automated reconciliation logic** and no "suggested fix" code.
- **No republish.** This task ships only docs + a CSV.
- **No Phase-2 backfill / merge work.** That is a separate future task once directors review this CSV.
- **Companies with `owner_rep_id IS NULL XOR assigned_to IS NULL`.** Excluded by the predicate; they are a related but distinct cleanup (canonical-column adoption gap, not a disagreement). Out of scope here.
- **Companies whose only disagreement is with `sales_person_id`.** The `sales_person_id` column is included for context but does not gate the predicate; rows where `owner_rep_id = assigned_to` but both differ from `sales_person_id` are not in this CSV.

## Stability contracts respected

- `docs/customer-quotes-stability-contract.md` (Section 1100) — not touched.
- Section 1095 (`is_email_derived`) — referenced for classification context only; **no writes** to `companies.is_email_derived`. The won-quote AF handoff in `server/services/customerQuotes.ts` remains the only production setter.
- Section 1200 (contacts soft-delete) — not relevant; the query does not read `contacts`.
- Section 1051 (`freight_daily_upload_fact`) — not relevant; the query does not read fact tables.
