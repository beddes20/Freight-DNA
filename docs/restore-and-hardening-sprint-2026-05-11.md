# Restore & Hardening Sprint — Plan

**Authored:** 2026-05-11.
**Status:** Phase 1 design + helpers landed. **Nothing executed.** No code semantics changed, no migrations run, no DB writes (dev or prod), no publish, no rollback. Awaiting operator approval at the Phase 1 gate.
**Companion docs (authoritative — this doc summarizes them, does not replace them):**
- `docs/dev-prod-schema-drift-2026-05-08.md`
- `docs/prod-restore-and-republish-plan-2026-05-08.md`
- `docs/operator-maintenance-window-checklist-2026-05-08.md`
- `docs/restore-target-recommendation-2026-05-08.md`
- `.local/dev-db-backups/prod-after-restore-target/audit_results.md`
- `docs/customer-quotes-stability-contract.md`
- `docs/freight-dna-platform-health-report-2026-05-11.md`

---

## Sprint shape (3 phases, hard stop conditions between each)

| Phase | Outcome target | Touches | Stop condition before next phase |
|---|---|---|---|
| **1 — Restore & republish** | Platform RED → YELLOW | Operator + Replit support; agent only writes read-only helpers + this doc | Boot is clean (no `[schema-drift] WARNING`, no `agent_org_settings`/`reauth_reason` errors); acceptance Block A/B/C all pass |
| **2 — Data cleanup & CQ hardening** | Data trust YELLOW → near-GREEN | Code (`server/storage.ts` already carries the race fix; cleanup script is new); one-shot dedupe; email-derived backfill; Mail.Read wiring | Dup-QO group count back to 0 over 24 h; legacy email-derived stubs flagged; Mail.Read granted on Ops mailbox and reply-tracking watchdog clears |
| **3 — CI enforcement for CQ contracts** | Make CQ discipline machine-enforced | New CI script + small `code-quality-guardrails.test.ts` section | CI fails when CQ-frozen files are touched without the declaration line; documented in CQ contract doc + `replit.md` |

**Each phase is independently revertible. Stopping after Phase 1 leaves a healthier, internally-consistent system. Stopping after Phase 2 leaves the same plus clean data. Phase 3 is pure additive process.**

---

# Phase 1 — Restore & republish

## What the existing docs already say (summary, in plain language)

Locked decisions from the post-audit lockdown on 2026-05-08:

- **Prod DB restore target:** `2026-05-04T00:00:00Z` (Option X). Rationale: the X-vs-Y audit showed the 4/30–5/3 backfill-window writes are *legitimate repairs* of an earlier P0, not corruption; the QO duplication problem is solved by *publishing the unpublished `7f577c98` fix*, not by restoring further back.
- **Workspace code target:** commit `9949c373` ("Update ownership logic for consistent customer data display"). It is the most recent commit that contains all the rep-facing fixes (Customers visibility, ownership normalization, `7f577c98` quote-race safety, Task #1126 lifecycle, Task #1093 contacts soft-delete enforcement) and is *before* the schema-experimentation chain that did not result in a successful publish.
- **Code preservation = Option A:** after rollback, cherry-pick the 3 preservation docs back on top.
- **Rep-data export:** small tables already in `.local/dev-db-backups/prod-after-restore-target/` (contacts.csv = 1 row, touchpoints.csv = 0 rows, tasks.csv = 9 rows / re-enter ~5 post-5/4, crm_opportunities.csv = 1 row).
- **Bulk forensic export of QO/email metadata:** delegated to Replit support `pg_dump` because read-replica caps blocked it from the workspace.

### Acceptance criteria, distilled

The full list lives in `docs/operator-maintenance-window-checklist-2026-05-08.md` (Step 5 / Block A/B/C). The hard pass criteria for declaring the window complete:

- **Block A — race fix actually live:**
  - **Zero** `duplicate key value violates unique constraint` matches in deploy logs at T+15, T+30, T+60 min after `CONTACT_JOBS_ENABLED=true`.
  - **Zero** `quote_opportunit.*conflict|duplicate` matches over the same window.
- **Block B — pipeline flowing:**
  - Post-restart `email_messages` count > 0.
  - Post-restart `quote_opportunities` count > 0.
  - Post-restart QO duplicate check (`GROUP BY source_reference HAVING count > 1`) returns **zero rows**.
  - At least one specific email→QO chain hand-verified end-to-end in the prod UI.
- **Block C — high-value accounts honest:**
  - 3–5 high-value accounts each pass: emails visible, QOs present exactly once, lifecycle fields correct (owner, `is_email_derived`, soft-delete, primary contact).
- **Schema cleanliness:**
  - Boot logs show **no** `[schema-drift] WARNING`.
  - Boot logs show **no** `agent_org_settings does not exist` from the `valueiq-today` scheduler.
  - Boot logs show **no** `reauth_reason does not exist` from the Webex webhook subscribe sweep.
  - `crm_opportunities`, `prospects`, `companies.is_email_derived`, `users.is_active`/`deleted_at`/`is_service_account`/`is_quarantined`, `company_financial_aliases`, `user_lifecycle_events` all present in prod.
  - No tables present in pre-publish prod were dropped.

### Operator-only vs. agent-helpable steps

| Runbook step | Owner | Agent can help with |
|---|---|---|
| 0. Replit support PITR confirmation in writing | OPERATOR + Replit support | Nothing — gate is human/external |
| 1. Maintenance mode (banner, `CONTACT_JOBS_ENABLED=false` in prod) | OPERATOR | Nothing — env var change is operator-side |
| 2. Pre-restore prod audit (read-only SELECTs) | AGENT (read-only) | Yes — already executed 2026-05-08; results in `audit_results.md` |
| 3. Run PITR | OPERATOR + Replit support | Nothing — destructive op outside agent surface |
| 4. Restore workspace to `9949c373` | OPERATOR (clicks View Checkpoints) | Agent invokes `suggestRollback` to surface the prompt |
| 5. Pre-publish drift sanity (read-only) | AGENT | Yes — read-only schema diff |
| 6. Publish | OPERATOR (clicks Publish) | Agent invokes `suggestDeploy()` |
| 7. Acceptance checks (Block A/B/C) | AGENT (log scans + SELECTs) + OPERATOR (UI smoke) | **This is where the new helper script earns its keep** |
| 8. Re-enable jobs (`CONTACT_JOBS_ENABLED=true`) | OPERATOR | Nothing — env var change is operator-side |

## Phase 1 helpers proposed (read-only, additive only)

### Helper 1 — `scripts/post-publish-acceptance-check.ts` (NEW, read-only)

Bundles Block A + Block B's automatable checks into one explicit invocation so the operator does not have to remember the SELECT shapes during a high-pressure window. **Pure SELECTs and log-fetches; never writes.** Runs from the workspace; needs `DATABASE_URL` to point at prod (operator decision, never agent).

What it reports:

1. **Schema sanity (additive to `scripts/check-schema-drift.ts`, which already exists):**
   - Confirms the 6 named tables/columns from the acceptance checklist are present in the live DB.
   - If `scripts/check-schema-drift.ts` reports drift, defers to that script's exit code rather than re-implementing the diff.
2. **Block B — duplicate-QO group count** by `source_reference` since a caller-supplied `--since-restart=<UTC>` timestamp. Pass = zero rows.
3. **Block B — `email_messages` and `quote_opportunities` counts** since `--since-restart`. Pass = both > 0.
4. **Orphan QO count** (no customer). Pass = ≤ the pre-window count of 6 (the script reports the delta so the operator can decide whether to treat new orphans as a regression).
5. Exit code: `0` if all checks pass, `1` if any check fails, `2` if the script can't reach the DB or read input.

Block A (deploy-log scans) is intentionally **not** in this script — it's owned by the agent's `fetchDeploymentLogs` invocations during the window because that's a Replit-managed log pipeline, not a DB query.

This helper is the *only* code change Phase 1 ships.

### Helper 2 — (NOT building) inline drift-check at boot

Considered: a boot-time refusal in `server/runMigrations.ts` if drift is detected. **Not building.** The existing `[schema-drift] WARNING` already covers this in dev (boot allowed) and the documented behavior is "production refuses to start until `runMigrations.ts` is updated." Adding a second checker would be redundant and risks coupling boot-time behavior to a class of changes Phase 1 explicitly does not want to perturb.

## What Phase 1 explicitly does NOT do

- Does not run PITR.
- Does not call `suggestRollback()` or `suggestDeploy()`.
- Does not modify `shared/schema.ts`, `migrations/*.sql`, `drizzle.config.ts`, `runMigrations.ts`, or any production code.
- Does not change `replit.md` Gotchas yet — those updates land *after* the restore is confirmed successful.
- Does not touch CQ-frozen files (`server/services/customerQuotes.ts`, `server/routes/customerQuotes.ts`, `client/src/pages/quote-requests.tsx`).

## Phase 1 approval gate (stop here)

Before Phase 2 begins, all of the following must be true:

- [ ] Operator approves this sprint plan.
- [ ] Replit support confirms PITR reachability for `2026-05-04T00:00:00Z` in writing.
- [ ] Maintenance window run completes per `docs/operator-maintenance-window-checklist-2026-05-08.md`.
- [ ] Boot logs no longer show `[schema-drift] WARNING`, `agent_org_settings does not exist`, or `reauth_reason does not exist`.
- [ ] Acceptance Block A/B/C all pass.
- [ ] Operator says "Phase 1 done, proceed to Phase 2."

---

# Phase 2 — Data cleanup & CQ hardening (DESIGN ONLY UNTIL PHASE 1 GATE PASSES)

> Designed below so the operator can review and approve. **No code written for this phase yet** — building it now would be premature because the post-restore baseline does not exist.

## 2.1 Race fix — already in the workspace, just needs to ship

`7f577c98` is in the workspace at HEAD. `server/storage.ts` `recordQuotePipelineDrop` (lines ~10766+) implements the race-safe pattern: read-existing-then-update for `(orgId, messageId, reasonCode)` open-row uniqueness, fall back to insert. `quoteEmailIngestion.ts` line 704 calls it.

**Phase 2 work for this:** verify in the post-restore prod that the deployed code's `recordQuotePipelineDrop` matches the workspace version, and confirm Block A's "zero duplicate-key matches" is sustained over a longer 24 h horizon (not just T+60 min). If sustained, no additional code changes needed — the fix is sufficient. If not, the divergence between workspace and deployed needs root-causing before any other Phase 2 work begins.

**No new contract changes needed.** The fix conforms to CQ-2 (single chokepoint) and does not touch CQ-1/-3/-4/-5/-6/-7.

## 2.2 One-shot historical dedupe (NEW, will be feature-flagged)

**Scope:** the ~9,560 dup_groups / ~19,283 redundant rows accrued *before* `7f577c98` ships. The race fix prevents new ones; this script cleans pre-existing.

**Design constraints:**

- Implemented as `scripts/dedupe-quote-opportunities.ts` (new file). Refuses to run unless **both** `ALLOW_QO_DEDUPE=1` and `--confirm-prod=<expected-org-uuid>` are passed. Single-run guard via a sentinel row in `app_settings` (`qo_dedupe_run_at`).
- For each `(organization_id, source_reference)` group with count > 1, keeps the row with the **lowest `created_at`** (the original) and soft-archives the rest by writing them to a new `quote_opportunities_dedupe_archive` audit table (created by an idempotent block in `runMigrations.ts`) **before** deleting. Archive table holds the full row + a `dedupe_reason` text + a `dedupe_run_id` uuid for traceability.
- Pre-flight: prints the count and a 50-row sample. Operator presses Enter to proceed (no `--yes` flag — interactive only).
- Wraps every group's archive+delete in a single transaction so partial failure is recoverable.
- Logs a single line per group: `[qo-dedupe] group=<source_reference> kept=<id> archived=<n>`.
- Idempotent: re-running with the sentinel set is a no-op + warning.

**Orphan QO fix:** same script, separate phase. For each of the 6 orphan QOs (no customer), prints the row, attempts to re-resolve customer via the same `loadContext` path Customer Quotes uses (CQ stability contract — read only). If still unresolvable, marks them with `customer_party_type = 'unknown'` (existing column from migration `0012_quote_customer_party_type.sql`) and writes an `[qo-orphan] id=<id> reason=<reason>` log line. Never deletes.

**No CQ contract changes** — `enrich()`, `loadContext`, `applyFilters`, `attachResponseTimes` are not touched. The script reads/writes `quote_opportunities` directly per the existing storage methods, and only adds rows to a new audit table.

## 2.3 Email-derived backfill for legacy stubs (NEW, idempotent)

**Scope:** legacy `companies` rows that were auto-created from inbound emails *before* Task #1095's `is_email_derived` column existed. Currently the admin "Heuristic (legacy)" mode in `/admin/email-derived-companies` infers them at query time; the goal is to flag them in the table so the default Customers list filter is correct without the heuristic.

**Design:**

- `scripts/backfill-email-derived-companies.ts`. Read-only by default; writes only when `ALLOW_EMAIL_DERIVED_BACKFILL=1` is set.
- Inference rule mirrors the admin heuristic mode exactly (re-uses the same predicate from `server/routes/adminEmailDerivedCompanies.ts` — no new heuristic). Reading the existing predicate guarantees the script is consistent with what admins see in the console.
- For each candidate row: sets `is_email_derived = true`, `email_derived_at = COALESCE(email_derived_at, <best-guess-ts-from-creation-or-first-linked-email>)`, `email_derived_seed_message_id = <best-guess-from-related-emails-or-NULL>`. **Never overwrites** an existing `true` flag or non-NULL timestamp.
- Idempotent: re-running flags zero rows because `is_email_derived = true` is already set on the previous batch.
- Logs `[email-derived-backfill] flagged=<n> skipped-already-flagged=<n> skipped-not-matching=<n>`.
- After backfill, the admin console's "is_email_derived flag" mode (`?source=flag`) becomes equivalent to the "Heuristic (legacy)" mode for the legacy population. The Customers default filter then no longer needs the heuristic.

**No CQ contract changes** — the won-quote handoff in `server/services/customerQuotes.ts` remains the only production *new-row* setter; this script is the *one-time historical* setter, called out in `replit.md` Gotchas after it runs.

## 2.4 Ops mailbox Mail.Read wiring (small, surgical)

**Today:** `[graph-sub] Probe mailbox Ops@valuetruck.com not found in tenant (404 ErrorInvalidUser)` then `[graph-sub] Mail.Read not yet granted — reply tracking dormant. Will retry every hour until granted.` The watchdog already retries hourly; the gap is operator action (grant Mail.Read in the M365 admin portal) plus a tiny verification surface so we know when it clears.

**Design:**

- **Operator step (out of code):** grant `Mail.Read` for `Ops@valuetruck.com` in the M365 admin portal.
- **Code step:** add a single `data-testid`-tagged surface to `/admin-monitored-mailboxes` (file already exists at `client/src/pages/admin-monitored-mailboxes.tsx`) showing per-mailbox `mailReadGranted: true|false|unknown` with a "Re-probe now" button that calls a new read-only `POST /api/admin/monitored-mailboxes/:mailbox/probe-mail-read` route. The route just runs the same Graph probe the watchdog runs and returns the result; no scope changes, no subscription changes, no new mailboxes added.
- **No new schema.** No new contracts. The watchdog scheduler keeps doing what it does.

## 2.5 Doc updates after Phase 2 ships

- `docs/customer-quotes-stability-contract.md`: add a "Race fix history" subsection pointing at `recordQuotePipelineDrop` and the dedupe script (so future agents know where the cleanup lived).
- `replit.md` Gotchas: add a brief entry on the dedupe + email-derived backfill having been run (with timestamps) so re-running them is deliberate, not accidental.
- `docs/freight-dna-platform-health-report-2026-05-11.md`: append a "Phase 2 outcome" section with new dup-QO group count, new orphan count, and email-derived-flagged count.

## Phase 2 approval gate

Before Phase 3 begins:

- [ ] Operator approves Phase 2 design.
- [ ] Phase 2 scripts run successfully against prod (with operator co-pilot, never agent-only).
- [ ] Dup-QO group count is 0 over 24 h.
- [ ] All 6 orphan QOs have either a resolved customer or `customer_party_type = 'unknown'`.
- [ ] Legacy email-derived stubs are flagged.
- [ ] Mail.Read granted on Ops mailbox and watchdog clears.

---

# Phase 3 — CI enforcement for CQ contracts (DESIGN ONLY UNTIL PHASE 2 GATE PASSES)

## 3.1 What gets enforced

Two checks, both implemented as additions to the existing `tests/code-quality-guardrails.test.ts` so they ride the existing `guardrails` workflow (no new CI plumbing):

- **Section 1100-CI (NEW):** when ANY of the CQ-frozen files (enumerated by name in `docs/customer-quotes-stability-contract.md`) appear in the current git diff vs main, the section's commit-message-or-PR-description-text MUST contain the literal phrase `Customer Quotes contracts touched: ` followed by either `NONE` or `CQ-N[, CQ-M, …]`. The check reads the message from `GIT_COMMIT_MSG` env var (set by CI) or from `git log -1 --pretty=%B` locally. Fails the workflow if the phrase is missing.
- **Section 1148-CI (NEW):** if any of the CQ-frozen *contract sources* (the four functions: `applyFilters`, `loadContext`, `enrich`, `attachResponseTimes` plus the `__none__` resolver) are textually modified in the diff, Section 1100 of `tests/code-quality-guardrails.test.ts` AND `docs/customer-quotes-stability-contract.md` must also be modified in the same commit. (Forces the contract + guardrail to evolve together.)

## 3.2 Implementation shape

- New helper: `scripts/cq-declaration-check.ts` (reads `git diff --name-only` and the commit message; applies the rules above). Exits 0/1.
- New section in `tests/code-quality-guardrails.test.ts` that shells out to the helper and `assert`s exit code 0. This way, *running the existing `guardrails` workflow* — which the team already runs in CI — automatically enforces the rule. No separate CI step.
- Locally: contributors can opt-in to a `pre-commit` hook calling the same script. (Documented but not auto-installed; no `husky` dependency added.)

## 3.3 Documentation

- Append to `docs/customer-quotes-stability-contract.md`: enumerate the CQ-frozen files (currently scattered across the doc) in ONE explicit list at the top, so the script can read them.
- Append to `replit.md` Gotchas: short pointer to the new check + how to author the declaration line.

## Phase 3 approval gate

- [ ] CI script + new guardrail section land.
- [ ] Test commit (touching a CQ-frozen file *without* the declaration) is shown to fail the `guardrails` workflow.
- [ ] Test commit (with the declaration) is shown to pass.
- [ ] Doc updates landed.

---

# Re-scoring checklist (use after the sprint completes)

Use this to re-grade the four lanes from `docs/freight-dna-platform-health-report-2026-05-11.md`:

| Lane | Pre-sprint | Phase 1 done | Phase 2 done | Phase 3 done | Pass criteria |
|---|---|---|---|---|---|
| **Platform** | RED | YELLOW | YELLOW | YELLOW | No `[schema-drift] WARNING`, no `agent_org_settings`/`reauth_reason` boot errors, publish path unblocked |
| **Customer Quotes** | YELLOW | YELLOW | GREEN | GREEN | Race fix live + dup count 0 over 24 h + orphans resolved + contracts CI-enforced |
| **Data trust** | YELLOW | YELLOW | near-GREEN | near-GREEN | Dup count 0, orphans resolved, email-derived flagged, Mail.Read live, no new silent regressions in 7 days |
| **New-tab readiness** | YELLOW | YELLOW | YELLOW | YELLOW (safer) | CQ contract pattern is now machine-enforced and copy-pasteable for new tabs; remains YELLOW until publish path is converged per Strategy B |

To reach **all-GREEN platform**, a fourth phase (out of scope here) is required: execute Strategy B from `docs/dev-prod-schema-drift-2026-05-08.md` (forward migrations) so future publishes are diff-clean.

---

# What this sprint plan does NOT do

To be unambiguous:

- Does not invent new tabs, features, or schema beyond what is necessary.
- Does not touch AI Hub, NBA, Webex (beyond the boot error + Mail.Read wiring), Sonar, Phone Usage, Goals, Coaching, or Playbook surfaces.
- Does not weaken or delete any existing guardrail or stability contract.
- Does not change soft-delete or lifecycle event semantics (Tasks #1093 and #1126 contracts are honored as-is).
- Does not silently drop data — every destructive action goes through an archive table or a soft-flag, with logs.
- Does not call `suggestDeploy`, `suggestRollback`, `executeSql` against prod with anything other than read-only SELECTs, or run `drizzle-kit push` in any environment, until you say "execute" at each gate.
