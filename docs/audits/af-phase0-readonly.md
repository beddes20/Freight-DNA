# Available Freight — Phase 0 Read-Only Audit

**Task:** #1128
**Owner:** Phase 0 (read-only sizing) for the AF tab cleanup plan.
**Cadence:** monthly. Re-run by `tsx scripts/audits/af-phase0-readonly.ts` (or
`psql -f scripts/audits/af-phase0-readonly.sql`).

## Why this audit exists

The AF tab audit identified eight high-risk patterns (email-derived stub
pollution, snooze/SLA desync, divergence between the two import writers,
multi-headed owner attribution, etc.). Before Phase 1 ships any labeling
or filter change, we need actual numbers — not vibes — to decide whether
each downstream phase ships as drafted, gets reordered, or escalates. This
doc captures those numbers and the recommendation per phase.

## Scope & safety

- **Strictly SELECT-only.** The TS wrapper refuses to run any query that
  contains `INSERT/UPDATE/DELETE/MERGE/CREATE/DROP/ALTER/TRUNCATE/GRANT/REVOKE`.
  The shell wrapper (`AUDIT_READ_ONLY=...`) refuses to run with the safety
  disabled.
- **No UI / writer changes.** Any drift surfaced here is reported, not
  fixed. Cleanup belongs to Phases 1+.
- **No edits to** `server/services/customerQuotes.ts`, the CQ stability
  contract, `freight_daily_upload_fact` writers, the importer, the cockpit
  list query, the scheduler, or the auto-pilot — Sections 1100 / 1051 /
  1095 of `tests/code-quality-guardrails.test.ts` would trip otherwise.

## Queries

| ID  | Question                                                    | Source             |
|-----|-------------------------------------------------------------|--------------------|
| Q1  | Email-derived pollution (last 14d, org × status)            | `freight_opportunities` ⨝ `companies.is_email_derived` |
| Q1b | Email-derived pollution rollup (last 14d, by org)           | same               |
| Q2  | Snooze/SLA desync — L1/L2 fired on hidden rows              | `freight_opportunities` |
| Q3  | Importer divergence (today CT) — opps vs upload-fact         | `freight_opportunities` ⊕ `freight_daily_upload_fact` |
| Q4a | Unmatched-customer distribution (last 30d)                  | `freight_opportunity_import_audit` |
| Q4b | Worst 5 import runs by `unmatched_companies` (last 30d)     | same               |
| Q5  | Owner attribution drift (≥2 distinct non-null users / row)  | `freight_opportunities` |

## Dev replica run — 2026-05-07

Replica fingerprint: `helium:5432/heliumdb` (dev container DB).
Total wall time: ~1.8s.

| Query | Rows returned | Runtime | Result | Interpretation |
|-------|---------------|---------|--------|----------------|
| Q1    | 0             | 1745 ms | empty  | Dev DB has no `freight_opportunities` from the last 14d. First-call cost dominates the budget; subsequent queries hit cached planner state. |
| Q1b   | 0             | 3 ms    | empty  | Same — no rollup either. |
| Q2    | 0             | 6 ms    | empty  | No snooze/SLA desync in dev — expected, no SLA cron has run here. |
| Q3    | 0             | 13 ms   | empty  | Neither importer has run today in dev → no divergence to measure. |
| Q4a   | 0             | 7 ms    | empty  | `freight_opportunity_import_audit` is empty in dev. |
| Q4b   | 0             | 1 ms    | empty  | Same — no runs to rank. |
| Q5    | 0             | 2 ms    | empty  | No `freight_opportunities` rows at all in dev (the 4-column subquery is the same per-row work the cockpit does, so cost is bounded). |

**Dev plan-validation outcome:** Every query is under the 5s budget on a
cold cache. No table scan is unbounded — Q1/Q1b/Q5 scan
`freight_opportunities` (small in dev), Q3 anchors both sides on a
date-prefixed `pickup_window_start`/`ship_date` substring filter, and
Q4a/Q4b are time-bounded. **Cleared to run on prod replica with no
adjustments.**

## Prod replica run — 2026-05-07 (approved in-task)

Executed via `executeSql({ environment: "production" })`, which routes through
Replit's READ-ONLY production replica. All query runtimes below include the
fixed ~5s replica-connect overhead (visible as the floor on every query) — the
queries themselves are sub-second once the connection is warm.

| Query | Rows returned | Runtime | Result | Interpretation |
|-------|---------------|---------|--------|----------------|
| Q1    | 0             | 6503 ms | empty  | **No `freight_opportunities` rows generated in the last 14d.** Either AF generation paused recently or fresh inbound has stalled — the email-derived pollution surface is currently *zero new rows*. |
| Q1b   | 0             | 5333 ms | empty  | Same — no rollup. |
| Q2    | 0             | 5175 ms | empty  | **Zero snooze/SLA desync rows right now.** No L1/L2 has fired on a hidden row. |
| Q3    | 4 orgs        | ~5 s   | see ↓  | **Importer divergence is one-sided.** Today (CT), at the unique-triple grain, 74 lane×pickup-date triples exist in opps with no matching `freight_daily_upload_fact` row; 0 fact-only and 0 in-both. Big org (`da3ed822…`): 71 unique-triple opps but 155 raw opp rows → ~2.2 rows per triple, signal of intra-source duplication on top of the import gap. Fact-side row count is 0 everywhere. |
| Q4a   | 0             | 5121 ms | empty  | **Zero importer runs recorded in the last 30d** — `freight_opportunity_import_audit` has nothing in the window. The importer audit table is either dark or no run has fired. |
| Q4b   | 0             | 5321 ms | empty  | Same — no runs to rank. |
| Q5    | 4 orgs        | 5183 ms | see ↓  | Big org (`da3ed822…`, 989 opps): **0 % owner drift.** Two tiny orgs (1 row each) report 100 % drift, but the absolute count is 1+1 — noise, not signal. |

### Q3 prod detail (DISTINCT triples; raw row counts in the right two columns)

| org_id              | in_opps_not_in_fact | in_fact_not_in_opps | in_both | opp_rows_total | fact_rows_total |
|---------------------|---------------------|---------------------|---------|----------------|-----------------|
| `da3ed822-…f71d`    | 71                  | 0                   | 0       | 155            | 0               |
| `0b082a21-…f24b`    | 1                   | 0                   | 0       | 1              | 0               |
| `4e121699-…3a17f2`  | 1                   | 0                   | 0       | 1              | 0               |
| `a0fa93f7-…825fe2`  | 1                   | 0                   | 0       | 1              | 0               |

> **Reading the columns:** the first three are computed at the unique-triple
> grain (so a duplicate row inside one source can't inflate divergence). The
> two `_rows_total` columns are the raw row counts on each side. For the
> big org, 155 raw opp rows collapse to 71 unique triples — ~2.2 rows per
> lane×pickup-date triple — which is *itself* a finding (intra-source
> duplication on the opps side). Fact-side row count is 0 in every org.

### Q5 prod detail

| org_id              | rows_with_owner_drift | rows_with_3plus | rows_with_4 | total_rows | pct_drift |
|---------------------|-----------------------|-----------------|-------------|------------|-----------|
| `a0fa93f7-…825fe2`  | 1                     | 0               | 0           | 1          | 100.00    |
| `4e121699-…3a17f2`  | 1                     | 0               | 0           | 1          | 100.00    |
| `0b082a21-…f24b`    | 0                     | 0               | 0           | 1          | 0.00      |
| `da3ed822-…f71d`    | 0                     | 0               | 0           | 989        | 0.00      |

## Threshold check (pre-defined)

Thresholds were locked before the prod numbers came back so the
recommendation isn't reverse-engineered to fit the data.

| Signal                                     | Yellow | Red   | Prod value (worst org)                  | Status |
|--------------------------------------------|--------|-------|-----------------------------------------|--------|
| Q1 `pct_email_derived` (any org)           | ≥ 5 %  | ≥ 15 % | 0 (no rows in window)                  | green  |
| Q2 `desync_rows` (any org)                 | ≥ 25   | ≥ 100 | 0                                       | green  |
| Q3 `in_opps_not_in_fact + in_fact_not_in_opps` (unique triples) | ≥ 20 | ≥ 100 | **71** unique triples (`da3ed822…`); raw opp rows = **155** | **yellow** at the set grain; **red** at the raw-row grain |
| Q4a `p95 unmatched_companies`              | ≥ 25   | ≥ 100 | n/a (no runs in window)                 | unknown|
| Q5 `pct_drift` (any org with ≥10 rows)     | ≥ 5 %  | ≥ 20 % | 0 % (big org); tiny-org 100 % is noise | green  |

## Per-phase recommendations

- **Phase 1 (UI labeling for email-derived rows / hidden rows): SHIP AS-DRAFTED, but downgrade urgency.** Q1 returned zero new email-derived rows in 14d and Q2 returned zero hidden-row SLA fires. Labels are still worth shipping for trust + for backfill-era rows the audit can't see, but this is *not* an emergency-filter situation.
- **Phase 2 (importer divergence cleanup): REORDER AHEAD OF PHASE 1.** Q3 (corrected for set semantics) reports 74 unique opp triples today with no matching upload-fact row — 71 of them in the largest tenant — and `fact_rows_total = 0` everywhere. By the pre-locked threshold this is **yellow at the unique-triple grain** and **red at the raw-row grain** (155 raw opp rows, ~2.2 rows per triple). Combined with Q4 showing **zero importer runs in the last 30d**, the most likely root cause is that the AF importer cron is dark on prod and the surviving opps are being kept alive by the won-quote autopilot path (which doesn't write to `freight_daily_upload_fact`). The duplication factor (~2.2 rows per triple on the opps side) is a *second* finding worth flagging — likely re-ingest without dedupe — and reinforces the recommendation. This needs an operational check (cron health + scheduler log) BEFORE labeling work hides the symptom from reps.
- **Phase 3 (owner attribution unification): SHIP AS-DRAFTED, low priority.** Big-org drift is 0 %. The two 100 %-drift orgs have one row each — likely test/seed data; not worth emergency work, but the planned unification still cleans up the long-tail.
- **Phase 4 (snooze/SLA reconciliation): SHIP AS-DRAFTED, lowest priority.** Q2 = 0. Keep the work in the plan as a guardrail against regression; do not front-load it.
- **Escalation:** Open a separate operational ticket for "AF importer + import-audit appear dark on prod for ≥30d" — surfaced by Q3 (one-sided divergence) and Q4 (empty audit window), not solvable by any UI phase.

## Notes for the next monthly run

- The ~5s floor on every prod query is replica-connect overhead from
  `executeSql`; running the wrapper script directly (with `DATABASE_URL`
  pointed at the replica) will be much faster.
- If Q1/Q4 stays at zero next month, escalate the "importer dark" finding
  before re-running anything else — there is no point sizing pollution
  against a feed that isn't producing.

## Files

- `scripts/audits/af-phase0-readonly.sql` — copy/paste SQL for `psql`.
- `scripts/audits/af-phase0-readonly.ts` — TS wrapper (prints JSON; refuses
  to run with `AUDIT_READ_ONLY=false` or any forbidden write keyword).
- `/tmp/audits/af-phase0-dev.json` — raw JSON from the dev run on
  2026-05-07 (kept transient, not committed).
