# Phase 1 — Platform Safety Sweep (Audit Only)

**Task:** #1135
**Date:** 2026-05-07
**Author:** Replit Agent (audit-only pass; **no code changes**)
**Scope:** Eight surfaces — `contacts`, `companies`, `quote_opportunities`, `email_messages` / `email_conversation_threads` (read paths), `recurring_lanes` (LWQ), `one_on_one_sessions`, dashboard / NBA freshness, feature-flagged background writers (`CONTACT_JOBS_ENABLED`).
**Out of scope (do NOT regress here):** email plumbing (Graph webhook, capture-first, DROP-GATE, `quote_pipeline_drops` semantics, classifier thresholds, LLM prompts), `customerQuotes.ts` stability contract (`applyFilters` / `loadContext` / `enrich` / `attachResponseTimes` / `__none__`), `freight_daily_upload_fact` writers, backfills, refactors.

---

## 1. Executive Summary

1. **The boot-time idempotent migration runner (`server/runMigrations.ts`, ~6 504 lines, ~757 `IF NOT EXISTS` guards) is the de-facto schema authority.** Drizzle's `db:push` is a developer convenience; the production source-of-truth is whatever `runMigrations()` enforces on every boot, then verified by `assertNoSchemaDrift` (`server/index.ts:404`, fatal in production).
2. **Net effect: most schema risk is already covered.** Every column referenced by Drizzle in `shared/schema.ts` is reachable through either (a) an idempotent `ADD COLUMN IF NOT EXISTS` in `runMigrations.ts` or (b) the schema-drift guard refusing to start. There is **no observed P0 in this sweep**.
3. **The remaining risk surface is files that live ONLY in `migrations/*.sql`** (e.g. `0017_company_financial_aliases.sql`, the partial-index swap in `0016_contacts_partial_indexes.sql`). These get applied by `drizzle-kit push:pg` but are NOT mirrored in `runMigrations.ts`, so a fresh / restored DB that was never `db:push`-ed could silently miss them. **Severity: P1 / P2** depending on whether the missing object is a column (caught by drift guard) or a partial index (NOT caught by drift guard — drift guard checks columns, not indexes).
4. **Partial indexes are the single biggest blind spot.** The schema-drift guard inspects `information_schema.columns`; it does **not** verify that partial / unique / FILTERed indexes exist. Missing `contacts_company_active_idx`, `companies_email_derived_idx`, `quote_opportunities_snoozed_idx`, `quote_opportunities_routing_idx`, or `cfa_*` indexes degrades to a silent table-scan, not a 500 — but the perf cliff in production has bitten us before.
5. **`CONTACT_JOBS_ENABLED` kill switch is correctly wired and trivially auditable.** Two production callers (`server/services/signatureContactSweep.ts:92`, `server/accountContactCaptureService.ts:252` and `:402`); boot log line at `server/index.ts:391` echoes the effective value. The default-true semantics match `replit.md`.
6. **`feature_flags` table is fully boot-guaranteed** (`server/runMigrations.ts:1314`, with the `text → timestamp` migration handler at `:1331-1334` and `updated_by_id` ADD-COLUMN at `:1325`). Org-scoped flags like `profile_safety_labels_enabled` (Task #1109) and `lane_carrier_outreach_v1` are SELECT-on-demand with sensible defaults — no boot dependency.
7. **`one_on_one_sessions` uses `text` for every timestamp** (`start_date`, `meeting_date`, `closed_at`) but is fully covered by ADD-COLUMN guards (`runMigrations.ts:246`, `:525-527`). Drift-prone in principle; safe in practice.
8. **`recurring_lanes.lifecycle_stage` is nullable for legacy rows pending boot backfill (Task #1026).** This is *intentional* per the LWQ stability contract; no fix recommended.
9. **Two `migrations/*.sql` files are still production-uncovered:** `0015_quote_customers_owner_rep.sql` (column ✅ covered at `runMigrations.ts:3944`, but the FK constraint is NOT mirrored — drift guard does not inspect constraints) and the entirety of `0017_company_financial_aliases.sql` (table + 4 indexes; **the table is not yet referenced by production readers/writers** per the rollout plan, so missing-table-on-fresh-DB is currently dormant but will become P1 the moment P2.2 ships readers).
10. **Recommended Phase 1 action: replicate the eight `migrations/*.sql` operations into `runMigrations.ts` as idempotent guards, in the existing pattern (`ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `ALTER COLUMN ... SET DEFAULT`).** Total estimated change: ~80 lines, fully additive, no semantic change. This is the "safe implementation order" in §4 below.

---

## 2. Audit Table

Severity legend: **P0** = boot fails or runtime 500 on first request. **P1** = silent perf cliff, wrong default, or one user-visible 500 path. **P2** = cosmetic / future-only / dormant.

Status legend:
- **GUARANTEED_AT_BOOT** — `runMigrations.ts` ensures it idempotently on every boot, then `assertNoSchemaDrift` re-verifies (columns only).
- **GUARANTEED_BY_MIGRATION_FILE_ONLY** — only present in `migrations/*.sql`, applied by `drizzle-kit push:pg`. Will be missing if a deploy skips `db:push` (e.g. fresh DB, restored backup).
- **NOT_GUARANTEED** — depends on runtime data, env var, feature-flag row, or user action.
- **UNKNOWN** — could not verify in audit-only mode without running queries against prod.

| # | Surface | Assumption | Status | Evidence (file:line) | Severity | Failure Mode | Recommended Fix |
|---|---------|------------|--------|----------------------|----------|--------------|-----------------|
| 1 | `contacts` soft-delete cols | `deleted_at`, `deleted_by`, `delete_reason` exist | **GUARANTEED_AT_BOOT** | `server/runMigrations.ts:6467-6473`; schema `shared/schema.ts:213-215` | P0→mitigated | DELETE-by-mistake masquerades as success → row gone | Already covered. No action. |
| 2 | `contacts_deleted_at_idx` (partial, `WHERE deleted_at IS NOT NULL`) | Partial index exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6476`; mirrors `migrations/0016_contacts_partial_indexes.sql` | P2 | Admin "deleted contacts" report scans table | Already covered. No action. |
| 3 | `contacts_company_active_idx` (partial, `WHERE deleted_at IS NULL`) | Partial index exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6479`; mirrors `migrations/0016` | P1 | Every per-company contact lookup degrades to seq-scan | Already covered. No action. |
| 4 | `contacts.created_at` is `text` (not `timestamp`) | Schema is text | NOT_GUARANTEED (intentional) | `shared/schema.ts:196` | P2 | Sortability lost; cannot use as range filter without `::timestamptz` cast | Track in Phase 2 follow-up; do NOT fix as part of Phase 1. |
| 5 | `companies.is_email_derived` + `email_derived_at` + `email_derived_seed_message_id` | Columns exist (Task #1095) | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6441` (col); schema `shared/schema.ts:67-69` | P0→mitigated | Customers list 500s on `WHERE is_email_derived = false` | Already covered. No action. |
| 6 | `companies_email_derived_idx` (partial, `WHERE is_email_derived = true`) | Index exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6450` | P2 | Admin email-derived view slow on large orgs | Already covered. No action. |
| 7 | `companies.owner_rep_id` (Task #1011) | Column exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6085` | P0→mitigated | Owner rep fallback resolver 500s | Already covered. |
| 8 | `customer_email_identities` table + 3 indexes | Table & indexes exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6087-6101` | P1→mitigated | `resolveCustomerIdentityForEmail` 500s | Already covered. |
| 9 | `quote_opportunities.source` `DEFAULT 'email'` | Column has default | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6493` (Task 1, 2026-05-07) | P0→mitigated | Inserts that omit `source` fail NOT-NULL | Already covered. |
| 10 | `quote_opportunities.snoozed_until` + `quote_hints` + `routing_status` + `routing_decision_at` + `routing_decision_by_user_id` + `routing_note` + `needs_new_contact_review` + `sonar_benchmark` + `created_at` | Columns exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:4018-4019, :4106, :5483-5499` | P0→mitigated | Routing tab + spot-quote insert 500s | Already covered. |
| 11 | `quote_opportunities_snoozed_idx` (partial, `WHERE snoozed_until IS NOT NULL`) | Partial index exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:5487-5489` | P1 | Snoozed-row lookup scans table | Already covered. |
| 12 | `quote_opportunities_routing_idx` (partial, `WHERE routing_status = 'needs_routing'`) | Partial index exists | **GUARANTEED_BY_MIGRATION_FILE_ONLY** (defined in Drizzle schema only — `shared/schema.ts:6109-6111`; **not** mirrored in `runMigrations.ts`) | grep: `runMigrations.ts` has no `quote_opportunities_routing_idx` line | **P1** | Needs Routing tab full table scan; drift guard does NOT catch missing index | **Add `CREATE INDEX IF NOT EXISTS quote_opportunities_routing_idx ON quote_opportunities (organization_id, routing_status) WHERE routing_status = 'needs_routing'` to `runMigrations.ts`.** |
| 13 | `quote_opportunities_email_signal_source_ref_uidx` (partial unique, `WHERE source = 'email'`) | Index exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:5463-5464` | P0→mitigated | Email-signal idempotency breaks; duplicate opps | Already covered. |
| 14 | `quote_customers.party_type` / `party_type_manual` / `owner_rep_id` (+ FK) | Columns + index exist | **GUARANTEED_AT_BOOT** for cols (`runMigrations.ts:3944` + the older Task #597 / #752 / #969 / #1012 blocks); **GUARANTEED_BY_MIGRATION_FILE_ONLY** for `quote_customers_owner_rep_id_fkey` constraint | `migrations/0012`, `0013`, `0015`; `runMigrations.ts:3944` | P2 | Missing FK = orphan refs not auto-nulled on rep delete | Mirror the FK guard from `migrations/0015` into `runMigrations.ts`. |
| 15 | `quote_customers_org_party_type_idx` | Index exists | **GUARANTEED_BY_MIGRATION_FILE_ONLY** | `migrations/0012_quote_customer_party_type.sql`; not in `runMigrations.ts` | P2 | Party-type filter slow | Mirror into `runMigrations.ts`. |
| 16 | `quote_reps.suppressed` | Column exists | **GUARANTEED_BY_MIGRATION_FILE_ONLY** | `migrations/0013_quote_reps_suppressed.sql`; not in `runMigrations.ts` (drift guard catches it) | P1 | Boot fails in prod via drift guard until `db:push` runs | Mirror into `runMigrations.ts` so a fresh-DB boot succeeds without `db:push`. |
| 17 | `quote_pipeline_drops.archived_at` + `quote_pipeline_drops_org_archived_idx` | Column + partial idx exist | **GUARANTEED_BY_MIGRATION_FILE_ONLY** | `migrations/0014_quote_pipeline_drops_archived_at.sql`; not in `runMigrations.ts` | P1 | Drift guard catches col; cleanup scheduler 500s OR drops list 500s. Index missing = silent perf cliff. | Mirror into `runMigrations.ts`. **Caveat: `quote_pipeline_drops` semantics are out-of-scope per task spec — adding the schema guard is acceptable, but do NOT touch the cleanup-scheduler or filter logic.** |
| 18 | `company_financial_aliases` table + 4 indexes (Task #P2.1b) | Table + indexes exist | **GUARANTEED_BY_MIGRATION_FILE_ONLY** | `migrations/0017_company_financial_aliases.sql`; not in `runMigrations.ts` | P2 (today) → P1 (when P2.2 readers ship) | No production reader yet, so dormant. Becomes P1 the moment P2.2 ships. | Mirror into `runMigrations.ts` ahead of P2.2. Strictly schema-only — no backfill. |
| 19 | `email_messages.provider_message_id` + `provider_sent_at` + `ingested_via` + 5 link columns | Columns + 5 partial indexes | **GUARANTEED_AT_BOOT** | `runMigrations.ts:1712-1746, :1811, :2678-2679` | P0→mitigated | Webhook idempotency + timeline 500s | Already covered. |
| 20 | `email_conversation_threads` table + `snoozed_until` + `last_real_email_at` + `archived_at` | Table + cols | **GUARANTEED_AT_BOOT** | `runMigrations.ts:2039-2065, :2726-2727, :4298, :5318` | P1→mitigated | Conversations pane 500s; snooze sweep breaks | Already covered. |
| 21 | `recurring_lanes.lifecycle_stage` | NULL allowed for legacy rows | NOT_GUARANTEED (intentional per Task #1026) | `shared/schema.ts:1592` | P2 (intentional) | None — UI tolerates NULL; backfill runs at boot | No action. Keep contract. |
| 22 | `recurring_lanes.moves_last_30_days` / `qualification_reason` / `supporting_customers` / `recent_carriers` / `last_eligible_at` (Task #1051) | Columns exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:6188-6193` | P0→mitigated | LWQ qualification chip 500 | Already covered. |
| 23 | `recurring_lanes.assigned_at` / `assigned_by_user_id` / `is_eligible` / `drop_trailer_*` / `is_manual` | Columns exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:1213, :1272-1273, :2713-2714` | P0→mitigated | LWQ row writes fail | Already covered. |
| 24 | `lane_summary_cache` columns + indexes | Cache table fully populated | **GUARANTEED_AT_BOOT** | `runMigrations.ts:2076-2113, :2715-2716, :2771, :2787` | P1→mitigated | LWQ list endpoint slow | Already covered. |
| 25 | `nba_cards` Task #186 / #222 / #372 / #374 cols (`market_signal_id`, `play_label`, `at_stake_amount`, `at_stake_basis`, `primary_contact_id`, `primary_lane_id`, `linked_lane_id`) | Columns exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:1654, :1262, :2266, :3736-3739` | P0→mitigated | NBA card render 500 | Already covered. |
| 26 | `nba_cards` timestamp columns are `text` (`created_at`, `snooze_until`, `outcome_linked_at`, `first_viewed_at`, `resolved_at`) | Schema is text | NOT_GUARANTEED (intentional, legacy) | `shared/schema.ts:1296, :1311-1314` | P2 | "Stale" / 24h freshness checks must `::timestamptz` cast — confirmed they do (`useCompanyDataFreshness.ts`) | No action. Note in Phase 2. |
| 27 | `nba_card_events` + `nba_card_outcomes` tables + indexes | Tables exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:3776-3813` | P0→mitigated | NBA lifecycle audit broken | Already covered. |
| 28 | `one_on_one_sessions` (`morale_score`, `session_summary`, `closed_at`, `meeting_link`) | Columns exist | **GUARANTEED_AT_BOOT** | `runMigrations.ts:246, :525-527` | P0→mitigated | 1:1 detail view 500 | Already covered. |
| 29 | `one_on_one_sessions` timestamps are `text` (`start_date`, `meeting_date`, `closed_at`) | Schema is text | NOT_GUARANTEED (intentional, legacy) | `shared/schema.ts:455-461` | P2 | Same as #26 — must cast for ranges; verified call sites cast | No action. |
| 30 | `feature_flags` table + `(org_id, flag_key)` unique + `updated_by_id` FK + `updated_at` text→timestamp migration | Table + cols + index | **GUARANTEED_AT_BOOT** | `runMigrations.ts:1314-1348` | P0→mitigated | `/api/profile-safety-flag` 500 + every flag-gated UI breaks | Already covered. |
| 31 | `profile_safety_labels_enabled` flag — default-ON when no row exists (Task #1109a) | Application-layer default | NOT_GUARANTEED at DB level (by design) | `replit.md` Gotchas; `client/src/hooks/useProfileSafetyFlag()` | P2 | None — default is the safe value | No action. |
| 32 | `lane_carrier_outreach_v1` (or equivalent LWQ flag) for dev/test org | Org-scoped row exists with `enabled = true` | **UNKNOWN** | Not verifiable in audit-only mode without prod SELECT | P1 | If missing in prod org, LWQ outreach surfaces hidden — silent regression | Production read-only verification recommended pre-deploy (e.g. release-gatekeeper checklist §3). |
| 33 | `oneOnOne.listEndpointsCreateSessions` flag | Either unset or true | **UNKNOWN** | Not verifiable in audit-only mode | P2 | 1:1 list page may not auto-create sessions | Same as #32. |
| 34 | `CONTACT_JOBS_ENABLED` env var semantics | Default true; disabled only when literal `"false"` (case-insensitive, trimmed) | **GUARANTEED_AT_BOOT** (boot log echoes effective value) | `server/lib/featureFlags.ts:91-102`; boot log `server/index.ts:391` | P0→mitigated | Inbound contact / suggestion writers silently no-op | Already covered. |
| 35 | `CONTACT_JOBS_ENABLED` callers — exhaustive coverage | All inbound writers gated; user CRUD ungated | **GUARANTEED_AT_BOOT** for the existing 2 sites; **NOT_GUARANTEED** for future writers | `signatureContactSweep.ts:92`, `accountContactCaptureService.ts:252,:402`; ungated user CRUD per `replit.md` | P1 (process risk) | Future writer omits the gate; kill switch silently incomplete | Section 1094 of `tests/code-quality-guardrails.test.ts` enforces this. Already covered by the test contract. |
| 36 | `account_contact_suggestions` table + indexes | Table exists | **GUARANTEED_AT_BOOT** | `runMigrations.ts:1991-2024` | P0→mitigated | Suggestion writer 500 | Already covered. |
| 37 | `account_reviews` table + `follow_up_thread_id` + index | Table + cols | **GUARANTEED_AT_BOOT** | `runMigrations.ts:3303-3321` | P1→mitigated | Account review composer 500 | Already covered. |
| 38 | `tasks` table — `description` column expected by `createTask` | Column exists | **UNKNOWN** in audit-only mode | Not inspected directly in this sweep | P1 if missing | `createTask` 500 on every new task | Production read-only verification recommended (see follow-up #2). |
| 39 | `freight_daily_upload_fact` writer-side schema | Out-of-scope | **OUT_OF_SCOPE** | Task spec excludes | — | — | Do NOT touch. |
| 40 | `customerQuotes.ts` `applyFilters`/`loadContext`/`enrich`/`attachResponseTimes`/`__none__` | Stability contract | **OUT_OF_SCOPE** | `docs/customer-quotes-stability-contract.md` | — | — | Do NOT touch. |

---

## 3. P0 / P1 / P2 Plan

### P0 — none

No P0s found. The combination of `runMigrations.ts` boot guards + `assertNoSchemaDrift` (production-fatal) means every column referenced by Drizzle schema either exists or boot fails loudly. There is no observed silent-data-loss or guaranteed-runtime-500 path on the eight surfaces.

### P1 — 4 items (schema drift between `migrations/*.sql` and `runMigrations.ts`)

All four are **additive idempotent guards**; none change runtime behavior. All four already exist as `migrations/*.sql` files and are applied today by `drizzle-kit push:pg`.

| ID | Description | File to edit | Insertion pattern |
|----|-------------|--------------|-------------------|
| P1-A | Mirror `quote_opportunities_routing_idx` partial index into boot guards | `server/runMigrations.ts` (append a new block in the existing Task #1003 vicinity ~line 5483) | `CREATE INDEX IF NOT EXISTS quote_opportunities_routing_idx ON quote_opportunities (organization_id, routing_status) WHERE routing_status = 'needs_routing'` |
| P1-B | Mirror `migrations/0013_quote_reps_suppressed.sql` (`quote_reps.suppressed`) | `server/runMigrations.ts` | `ALTER TABLE quote_reps ADD COLUMN IF NOT EXISTS suppressed boolean NOT NULL DEFAULT false` |
| P1-C | Mirror `migrations/0014_quote_pipeline_drops_archived_at.sql` (col + partial idx) | `server/runMigrations.ts` | `ADD COLUMN IF NOT EXISTS archived_at timestamp` + `CREATE INDEX IF NOT EXISTS ... WHERE archived_at IS NULL`. **Schema only — do NOT modify cleanup-scheduler or filter semantics.** |
| P1-D | Mirror `quote_customers_owner_rep_id_fkey` constraint guard from `migrations/0015` | `server/runMigrations.ts` | The `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...) THEN ALTER TABLE ... ADD CONSTRAINT ... END IF; END $$;` block, copied verbatim. |

### P2 — 4 items (dormant or cosmetic)

| ID | Description | Recommended action |
|----|-------------|--------------------|
| P2-A | Mirror entirety of `migrations/0017_company_financial_aliases.sql` (table + 4 indexes) | Mirror as soon as P2.2 readers/writers are queued. Schema-only — no backfill in Phase 1. |
| P2-B | Mirror `quote_customers_org_party_type_idx` from `migrations/0012` | Same change set as P1 mirroring; tiny perf win. |
| P2-C | `contacts.created_at` is `text` (legacy) | Phase 2 column-type tightening; not in scope here. |
| P2-D | `nba_cards` and `one_on_one_sessions` text-typed timestamps | Phase 2 hygiene; current call sites cast correctly, so no action. |

---

## 4. Safe Implementation Order & Stop Rules

**Implementation MUST proceed in this exact order. Each step is independently revertible.** All edits are confined to `server/runMigrations.ts` (additive, idempotent) and the mirrored objects already exist today via `migrations/*.sql`, so the production behavior is unchanged in steady state — the change only affects fresh-DB / restored-backup boots.

### Step 1 — P1-A (`quote_opportunities_routing_idx`)
- **Edit:** append a new `try { ... } catch` block in `server/runMigrations.ts` near the existing Task #1003 routing block (~line 5483).
- **Verify:** boot the dev server; confirm log line `[migrations] Phase 1 quote_opportunities_routing_idx ensured`. Run `\d+ quote_opportunities` in psql; confirm partial index present.
- **Stop rule:** if boot log shows any new error or the existing routing block stops emitting its log line, REVERT and stop the sweep.

### Step 2 — P1-B (`quote_reps.suppressed`)
- **Edit:** append guard near the Task #752 vicinity.
- **Verify:** boot; confirm log; confirm `suppressed` column visible in `\d quote_reps`.
- **Stop rule:** any change to Freight Capture funnel test output → REVERT.

### Step 3 — P1-C (`quote_pipeline_drops.archived_at` + partial idx)
- **Edit:** append guard. **DO NOT touch** `quotePipelineDropsCleanupScheduler` or the `?include_archived=1` filter logic — they are out-of-scope per task spec.
- **Verify:** boot; confirm log; confirm column + partial idx present.
- **Stop rule:** any test in `tests/quote-pipeline-drops*.test.ts` (if present) regresses → REVERT. Any code reference to `quote_pipeline_drops` outside the new guard block → STOP and re-read the task spec.

### Step 4 — P1-D (`quote_customers_owner_rep_id_fkey`)
- **Edit:** copy the `DO $$` block from `migrations/0015` verbatim.
- **Verify:** boot; confirm log; `\d quote_customers` shows the FK.
- **Stop rule:** if the `pg_constraint` check pattern is unfamiliar to anything else in `runMigrations.ts`, prefer the column-only guard and defer the FK. The FK is P2-equivalent in real-world impact (orphans don't crash anything; they just need cleanup later).

### Step 5 — P2-A (`company_financial_aliases`)
- **Only ship if/when P2.2 readers are imminent.** Otherwise leave dormant — `db:push` covers it today.
- **Stop rule:** if P2.2 timing slips beyond one release, drop this from the sweep.

### Hard stop rules (apply to ALL steps)

1. **DO NOT** edit `server/services/customerQuotes.ts`, `server/freightDailyUploadFactService.ts` (or any file under `server/services/freightDailyUploadFact*`), `server/services/graphWebhook*.ts`, or any classifier/LLM-prompt file. These are explicitly out-of-scope per task spec.
2. **DO NOT** modify `quote_pipeline_drops` cleanup or filter semantics.
3. **DO NOT** add or change feature flag default values; flag work belongs in a separate task.
4. **DO NOT** run `drizzle-kit push:pg` as part of validation — boot-time guards must be sufficient. `db:push` is the developer fallback only.
5. **DO NOT** introduce a new `db.delete(contacts)` site, `db.update(quoteOpportunities)` write that bypasses `customerQuotes.ts`, or any new auto-create writer for `companies` / `contacts` without the `contactJobsEnabled()` gate.
6. **DO NOT** weaken any Section 1051 / 1094 / 1095 / 1100 / 1109 / 1200 guardrail in `tests/code-quality-guardrails.test.ts`. Adding new guardrail rows is fine; relaxing existing ones is not.
7. If `assertNoSchemaDrift` reports a drift in dev after any step, STOP and reconcile rather than suppressing the warning.

---

## 5. Proposed Follow-Up Idempotent Quick-Wins

These are small, safe, additive proposals — each isolatable to a single PR. They are NOT part of this audit's scope; flag them as candidate follow-up tasks via `proposeFollowUpTasks`.

1. **Boot-time partial-index drift verifier (Phase 1.5).** Extend `server/checkSchemaDrift.ts` to also verify that every partial index named in `shared/schema.ts` `(t) => ({ ... where(...) })` exists in `pg_indexes` with the expected `indexdef`. Today the drift guard checks columns only, which is exactly the reason P1-A is even possible. ~30 lines, additive, no behavior change in steady state. Failure mode is the same as the column drift guard: warn in dev, fatal in prod.
2. **Production schema spot-check script.** Add `scripts/verify-prod-schema-readiness.ts` (read-only) that connects to the production DB and prints a one-line PASS/FAIL for the items in the §2 audit table marked **UNKNOWN** (rows #32, #33, #38). Operators run this manually before clicking Republish. Pure SELECTs; no writes.
3. **Migration-file ↔ runMigrations parity test (CI-only).** New section in `tests/code-quality-guardrails.test.ts` that scans `migrations/*.sql` for `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` and asserts each appears (by exact object name) somewhere in `server/runMigrations.ts`. This catches the next P1-A automatically. Allow-list mechanism for intentional exceptions (e.g. `0017` while still dormant).

---

## Appendix A — Files Referenced

- `server/runMigrations.ts` (6 504 lines, 757 idempotent guards)
- `server/index.ts:391` — `CONTACT_JOBS_ENABLED` boot log
- `server/index.ts:404` — `assertNoSchemaDrift` invocation (production-fatal)
- `server/checkSchemaDrift.ts` — column-level drift assertion
- `server/lib/featureFlags.ts` — `contactJobsEnabled()` / `describeContactJobsFlag()`
- `server/services/signatureContactSweep.ts:92` — gated writer
- `server/accountContactCaptureService.ts:252, :402` — gated writers
- `shared/schema.ts` (8 245 lines) — Drizzle source of truth for column shape
- `migrations/0012-0017*.sql` — drizzle-kit push migrations
- `tests/code-quality-guardrails.test.ts` — Sections 1051 / 1094 / 1095 / 1100 / 1109 / 1200
- `docs/customer-quotes-stability-contract.md`
- `docs/unified-replit-daily-upload.md`
- `docs/contact-promotion-design.md`
- `replit.md` — Gotchas section

## Appendix B — Audit Constraints

- This was an **audit-only** pass per the Task #1135 specification. No code, schema, env var, or data was changed.
- "UNKNOWN" rows in §2 require a production read-only SELECT to resolve and were intentionally not executed in this sweep.
- The schema-drift guard scope (columns only, not indexes / constraints / FKs) is what makes the §3 P1 set non-empty despite the otherwise strong boot-time coverage.
