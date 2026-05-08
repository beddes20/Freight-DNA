# Production Restore + Republish Plan

**Authored:** 2026-05-08. **Last updated:** 2026-05-08 (post-audit, decisions locked).
**Status:** plan / runbook. **No execution has been performed.** All guardrails (no schema changes, no prod writes, no publish) remain in effect until you explicitly say "execute."
**Companion docs:** `docs/dev-prod-schema-drift-2026-05-08.md` (drift inventory), `docs/preservation-plan-2026-05-08.md` (commits-after-9949c373 inventory), `docs/restore-target-recommendation-2026-05-08.md` (X-vs-Y audit and restore-target recommendation), `docs/operator-maintenance-window-checklist-2026-05-08.md` (short operator checklist).
**Related backups:** `.local/dev-db-backups/dev_schema_20260508_175432.sql` (dev schema snapshot, do not overwrite); `.local/dev-db-backups/prod-after-restore-target/` (rep-entered tables exported pre-restore).

---

## Locked decisions (2026-05-08, post-audit)

The following are CONFIRMED by the operator and must not silently change. If any of these need to change, this entire runbook needs to be re-reviewed.

- **Restore target (production database):** `2026-05-04T00:00:00Z` (Option X). Rationale lives in `docs/restore-target-recommendation-2026-05-08.md`.
- **Workspace code target:** commit `9949c373` ("Update ownership logic for consistent customer data display").
- **Code preservation:** Option A — after rollback, cherry-pick three docs back: `docs/dev-prod-schema-drift-2026-05-08.md`, `docs/prod-restore-and-republish-plan-2026-05-08.md` (this doc), `docs/preservation-plan-2026-05-08.md`.
- **Data export:** small rep-entered tables already exported to `.local/dev-db-backups/prod-after-restore-target/` (contacts.csv, touchpoints.csv, tasks.csv, crm_opportunities.csv). Bulk QO/email export delegated to Replit support via server-side `pg_dump` if forensic archive is desired.

These supersede the "what I'm asking you to decide" prompts in Section 7 below — Section 7 is retained for historical context only.

---

## 0. Scope and honest disclosures

What this plan delivers:

- A **specific recommended restore-target timestamp** for production, with rationale and a fallback range if that timestamp turns out to be too late.
- A **specific recommended workspace code checkpoint** to align to, with the diff of what's lost and gained.
- A **step-by-step maintenance window runbook** with explicit "agent does this" vs "you do this" splits.
- A **verification checklist** for the four flows you named (contacts, touchpoints, tasks, RFPs).
- A **rollback contingency** if the maintenance window itself goes sideways.

What I am being honest about up front:

- **I cannot trigger a production DB point-in-time restore from my seat.** Replit's agent surface exposes only read-only prod queries plus the Publish flow. Prod DB restore is a workspace-UI operation owned by you (or by Replit support if PITR is needed beyond the UI's window).
- **I cannot trigger a publish from my seat.** I can only call `suggestDeploy` which prompts *you* to click Publish. You retain final authority on every state-changing step in this plan.
- **I do not have direct evidence that prod data was corrupted in this incident — I only have direct evidence of schema drift.** All my read-only prod queries this session showed an intact schema with all expected tables (`crm_opportunities`, `prospects`, etc.) and FKs (`tasks_opportunity_id_crm_opportunities_id_fk`). If reps are seeing missing/wrong contacts, touchpoints, tasks, or RFPs in prod, the corruption mechanism happened before this triage started — most likely tied to the `tools/backfill-incident-window.ts` window or to one of the earlier schema-touching deploys (`e0d0de27`, `437c0c1c`, `19ee8425`, `74736c92`). **Step 2 of the runbook is a pre-restore prod audit to confirm what's actually corrupted before we restore.** Do not skip it — restoring without knowing what we're "fixing" risks losing good data we didn't realize was there.

---

## 1. Proposed restore target — production database

> **2026-05-08 update (post-audit):** the recommended primary target was originally `2026-04-29T23:30:00Z`. The X-vs-Y audit (see `docs/restore-target-recommendation-2026-05-08.md`) revealed that the 4/30–5/3 backfill-window writes are *legitimate repairs* of a prior P0, not corruption — and that the duplication problem is solved by publishing `7f577c98`, not by restoring further back. **The locked target is now `2026-05-04T00:00:00Z` (Option X)**, replacing the original recommendation. The original Section 1 text is retained below for historical context.

### Recommended primary target (ORIGINAL — superseded by Locked Decisions block above)

**Restore prod to a snapshot from approximately 2026-04-29 23:30 UTC** — i.e. ~30 minutes before the start of the documented `backfill-incident` window (`tools/backfill-incident-window.ts` declares `WINDOW_START = 2026-04-30T00:00:00Z`).

**Why this point:**

- The backfill tool's existence implies that *something* about email→quote ingestion went wrong starting 2026-04-30 and was being repaired through 2026-05-05. A capture-first ingestion bug in that window is the most plausible source of contacts/touchpoints/RFPs landing in inconsistent states.
- Restoring to ~30 min before the window guarantees the corruption-introducing code path was not yet active in the data.
- It is recent enough that account/contact/task structure is current and reps recognize it.

**Cost of this target (you said you accept this cost):**
- ~9 days of legitimate writes are lost: 2026-04-30 through 2026-05-08 (today).
- Reps re-enter touchpoints, tasks, notes, and RFP responses for that window.
- Inbound emails stored in `email_messages` from that window are lost — but Microsoft Graph / Resend will re-deliver them on next sync (they live in the actual mailbox, not just our DB).

### Fallback target if the primary is too aggressive

**2026-05-04 23:00 UTC** — end of the backfill window, accepting the backfill's repairs as the truth. Loses ~4 days instead of ~9. **Risk:** if any of the backfill writes themselves were wrong, we keep that wrongness.

### Fallback target if the primary is too conservative (more days lost than acceptable)

**2026-04-25 00:00 UTC** — one full week before the backfill window. Loses ~13 days. Use only if the 2026-04-29 target turns out to *also* contain corruption that surfaces during the Step-2 audit.

### What you need from Replit's database UI

Open the workspace's Database pane → Production → look for "Backups" / "Point-in-time recovery" / "Snapshots". The exact label depends on your Replit plan tier. If PITR is not exposed in the UI for your plan, **contact Replit support before the maintenance window** with: project ID, target timestamp (`2026-04-29T23:30:00Z`), and a request to stage (not execute) the restore. They typically need 24–48h lead time.

**If PITR/snapshots are unavailable for your tier:** a `pg_dump` of prod taken right now, then a manual `psql` restore of selected tables to a fresh prod DB is theoretically possible — but it's a multi-hour, expert-supervised operation and is **not** in scope for this plan. If that's the situation, stop and request Replit support's involvement before planning further.

---

## 2. Proposed workspace code state

### Recommended target commit

**Restore workspace HEAD to commit `9949c373` — "Update ownership logic for consistent customer data display"** (2026-05-08, the last commit before today's schema-experimentation chain began).

### Why `9949c373`

Looking at the recent git log:

```
32170406 (HEAD) Create documentation detailing database schema differences and recovery options    ← documentation only, safe to keep
e0d0de27 Align development database schema with production for critical tables                     ← part of failed convergence attempt
35460487 Add investigation report for deployment pipeline errors                                    ← documentation, safe
2cbbdcc7 Update project setup instructions for new tasks                                            ← documentation, safe
9949c373 Update ownership logic for consistent customer data display                                ← ★ RECOMMENDED HEAD
79fa072e Task #1126 Phase 1 Step 4a-UI — admin-users.tsx lifecycle tabs                             ← good, in dev
d10ac9d3 Update customer ownership rules for better visibility and accuracy                         ← good, in dev
35a3ffdb Task #1128 — AF Phase 0 read-only audit
70919e75 Task #1135 — Phase 1 Platform Safety Sweep (audit only)
26b1d866 Standardize how company ownership is determined and displayed                              ← good, in dev
7f577c98 Handle duplicate record insertions safely to prevent errors                                ← good, in dev (quote pipeline race)
ba74c9ea Add freight opportunity import audit to ignored tables for schema checks
97d29e77 Add a way to securely manage sales team organizational structures
87ae65af Add a way for users to safely log in to their accounts
437c0c1c Fix: idempotent migration 0018 to unblock production publish                               ← prior failed convergence
19ee8425 Improve database migration process for increased reliability                               ← prior failed convergence
74736c92 runMigrations: ensure contacts soft-delete columns at boot (Task #1/#1093)                 ← prior failed convergence
```

**Rationale for picking `9949c373`:**
- It's the **most recent commit that contains all the rep-facing fixes** you've been trying to ship (Customers visibility, ownership normalization, quote-race safety from `7f577c98`, lifecycle UI, lifecycle write paths, contacts soft-delete enforcement).
- It is **before** the schema-experimentation chain (`e0d0de27` and the documentation/investigation commits above it) that did not result in a successful publish.
- Documentation-only commits (`32170406`, `35460487`, `2cbbdcc7`) on top of it are safe; we keep them or drop them — they don't affect runtime.

**What gets dropped vs `9949c373` and current HEAD `32170406`:**
- ❌ `e0d0de27 Align development database schema with production for critical tables` — this commit's intent was right but it didn't actually achieve dev-prod alignment (per today's drift doc). Drop.
- ✅ `35460487`, `2cbbdcc7`, `32170406` — pure documentation. Either drop with the rollback (clean state) or cherry-pick back on top of `9949c373` after the rollback. Cosmetic choice. **My recommendation: keep them via cherry-pick** so the post-mortem documentation survives.

**What is preserved vs current HEAD:**
- ✅ All Task #1093 contacts soft-delete work
- ✅ All Task #1126 user lifecycle work (DB columns, write paths, admin-users.tsx UI tabs, default `GET /api/users` filter)
- ✅ All Task #1095 email-derived companies work
- ✅ Customer Quotes & Account Ownership fixes (`d10ac9d3`, `26b1d866`, `9949c373`)
- ✅ Quote-pipeline duplicate-key race fix (`7f577c98`)
- ✅ All Task #1051 unified daily upload work
- ✅ `runMigrations.ts` improvements

### How to restore the workspace to `9949c373`

You execute this through the **View Checkpoints** UI (the Replit Workspace's checkpoint browser). I will trigger that UI for you when you say "execute" — see Step 4 of the runbook.

**Important:** restoring a checkpoint also restores the dev DB to its state at that checkpoint. Today's dev DB is unchanged from before any push attempt (verified in earlier read-only checks), so a checkpoint restore to `9949c373` returns the dev DB to a known-good state too.

### Optional alternative: skip code rollback entirely

If you'd rather **not** roll back code at all, the alternative is: drop only the publishing-blocked schema work and republish from current `HEAD = 32170406`. This is viable IF the post-restore prod state (Step 7) accepts the current schema. **My recommendation is still to roll back to `9949c373`** because it provides a clean, well-understood baseline rather than a current state with three layers of unsuccessful schema experiments stacked on top.

---

## 3. Maintenance window runbook (single window)

Estimated window: **3–4 hours total.** Best run on a Sunday morning or other low-traffic period. Roles below: **OPERATOR** = you (or a designated human with publish authority), **AGENT** = me (running read-only verification, code edits inside the workspace, and `suggestDeploy` prompts).

### Step 0 — Support-confirmed plan (BLOCKING; lead time 24–48h) — **OPERATOR + Replit support**

**Goal:** do not enter the maintenance window until Replit support has confirmed in writing that the two operations we depend on will behave as expected. This is a HARD GATE on every step below.

**What support must confirm before Step 1 begins:**

1. **PITR target is reachable for production:** confirm Replit's point-in-time-recovery / snapshot system can restore the production database to **`2026-05-04T00:00:00Z`** specifically. If this exact timestamp is not reachable, support must propose the **closest reachable timestamp at or before** 2026-05-04T00:00:00Z (never after — that would import post-restore-window writes we already accepted as lost). Document the actual confirmed timestamp here before proceeding.
   - Confirmed restore timestamp (fill in after support reply): `__________________________`
   - Snapshot identifier / restore method (fill in): `__________________________`
2. **Restore-to-new-DB vs restore-in-place:** confirm which mode Replit will use. If restore-to-new-DB, document the swap procedure and downtime estimate. If restore-in-place, document the rollback path if the restore lands wrong (e.g. did support take a pre-restore forensic snapshot we can return to?).
3. **Migration behavior on first publish post-restore:** confirm Replit's publish flow will run forward migrations against the *restored* prod schema (not the pre-restore schema), and that the migration runner will detect the dev-vs-prod additive diff correctly. Specifically confirm: when we publish workspace HEAD = `9949c373`, the publish UI will surface `CREATE TABLE company_financial_aliases`, `CREATE TABLE user_lifecycle_events`, and the additive `ADD COLUMN` operations from Tasks #1051/#1093/#1095/#1126 — and **no DROP operations**.
4. **Bulk forensic export window (optional):** if the operator chose to request a server-side `pg_dump` of post-restore-target `quote_opportunities` and `email_messages` rows for forensic archive (per Step 3 of `docs/restore-target-recommendation-2026-05-08.md`), support must complete and deliver that archive **before** the restore lands — once the restore runs, the forensic source is gone.

**Actions:**

1. **OPERATOR** opens Replit support ticket using the template in `docs/restore-target-recommendation-2026-05-08.md` Step 3, plus the four items above.
2. Wait for support's written confirmation. Typical lead time 24–48h.
3. **OPERATOR** logs the confirmed restore timestamp and method in the blanks above. **AGENT** will reference these in Step 3.
4. **OPERATOR** schedules the maintenance window to start **after** support's confirmation lands and after the optional bulk forensic archive (if requested) is downloaded and verified.

**Exit criterion:** support has confirmed PITR reachability for `2026-05-04T00:00:00Z` (or proposed an at-or-before alternative which the operator has accepted in writing); migration behavior on first publish is confirmed; optional forensic archive (if requested) is in hand. **Do not proceed to Step 1 until all of this is true.**

### Step 1 — Maintenance mode (15 min) — **OPERATOR**

**Goal:** prevent reps and inbound integrations from writing to prod during the restore window.

**Actions:**

1. **Communicate to reps:** post a banner in your team channel: "FreightDNA is in scheduled maintenance from HH:MM to HH:MM. Do not attempt to log touchpoints, tasks, or RFP responses. We'll signal when the all-clear is given." Provide a fallback email/Slack channel to capture anything urgent.
2. **Pause inbound integrations:**
   - Microsoft Graph email subscriptions: leave as-is — emails accumulate in mailboxes and re-deliver on next sync. **Do not unsubscribe** (that requires re-subscription work later).
   - **Set `CONTACT_JOBS_ENABLED=false`** in the production environment (the existing kill switch in `replit.md`). This halts inbound `contacts` / `companies` / `account_contact_suggestions` auto-creation. PERSIST-UNKNOWN still preserves source emails so nothing is lost.
   - Webex subscriptions: leave as-is — they re-deliver on resubscription.
3. **(Optional but recommended)** Take a final pre-restore `pg_dump` of the *current* prod DB — even if it contains corruption, it's a forensic snapshot you can reference later if you need to recover specific records. **The Replit support team can do this for you on request** if you don't have prod connection credentials in your local env.

**Exit criterion:** team acknowledges maintenance mode; `CONTACT_JOBS_ENABLED` is `false` in prod env vars; pre-restore forensic dump is in hand (if Replit support participated).

### Step 2 — Pre-restore prod audit (20–30 min) — **AGENT** (read-only)

**Goal:** confirm what's actually corrupted vs healthy in prod *before* picking the final restore target.

**Actions (I run these once you give me the go-ahead):**

- Count contacts / touchpoints / tasks / RFPs (`quote_opportunities` + related) per-day for the last 14 days. Look for sudden drops or spikes.
- Sample 20 randomly-selected accounts: dump their `contacts`, recent `touchpoints`, recent `tasks`. Compare structure to what reps describe as broken.
- Check `email_messages` for the documented incident window (2026-04-30 → 2026-05-05): how many `quote_opportunities` ended up tied to those emails? How many emails are orphaned (no quote opp linked)?
- Check `account_contact_suggestions` and the `signature_contact_sweep` audit trail for that window — did the sweep create unexpected stub contacts?

**Decision point at end of step:** I report findings; **OPERATOR** confirms the restore-target timestamp from Section 1 (or revises it). If the audit shows the corruption window is wider than expected, we move to the conservative fallback (`2026-04-25T00:00:00Z`).

### Step 3 — Restore production database to `2026-05-04T00:00:00Z` (30–60 min) — **OPERATOR + Replit support**

**Goal:** restore prod to **`2026-05-04T00:00:00Z`** (the locked target from the X-vs-Y audit), or to the closest at-or-before timestamp Replit support confirmed in Step 0.

**Actions:**

1. **OPERATOR** opens the Database pane → Production → Backups/PITR (or coordinates with Replit support directly if PITR is support-driven on this plan).
2. Select the snapshot/timestamp confirmed in Step 0:
   - **Primary target:** `2026-05-04T00:00:00Z`
   - **Acceptable alternative:** any timestamp at or before `2026-05-04T00:00:00Z` that Replit support confirmed is reachable. Never accept a target *after* `2026-05-04T00:00:00Z` — the audit-derived data-loss estimates do not cover that case.
   - **Stage the restore — do not execute yet.**
3. **AGENT** runs a final read-only sanity SELECT against the *staging* restored snapshot if Replit's UI exposes it as a separate connection (some plans allow restore-to-new-DB, then swap; others restore in place). If swap-only is available, skip to step 4.
4. **OPERATOR** executes the restore. Wait for the database to come back online (typically 5–20 min).
5. **AGENT** runs read-only verification:
   - `SELECT count(*) FROM contacts WHERE deleted_at IS NULL;`
   - `SELECT max(date) FROM touchpoints;`
   - `SELECT count(*), max(created_at) FROM crm_opportunities;`
   - `SELECT count(*), max(created_at) FROM quote_opportunities;`
   - `SELECT count(*), max(created_at) FROM email_messages;`
   - `SELECT count(*), max(created_at) FROM tasks;`
   - **Pass criteria:** every `max(created_at)` / `max(date)` returns a value ≤ `2026-05-04T00:00:00Z`. `quote_opportunities` count drops by ≈16,000 vs the pre-restore figure (the audit estimate). `email_messages` count drops by ≈66,000 vs pre-restore.
   - **Pre-restore reference counts** for diff: see `.local/dev-db-backups/prod-after-restore-target/audit_results.md` (captured 2026-05-08).

**Exit criterion:** prod DB is back online; the verification SELECTs above all pass; no row's `created_at` is after `2026-05-04T00:00:00Z` for any audited table.

### Step 4 — Restore workspace code (15 min) — **OPERATOR**

**Goal:** roll workspace back to commit `9949c373` so the schema source matches the post-restore prod schema as closely as possible.

**Actions:**

1. **AGENT** calls the `View Checkpoints` UI by invoking `suggestRollback` with the rationale: "Roll back to checkpoint `9949c373` to align workspace with post-restore prod state."
2. **OPERATOR** clicks "View Checkpoints" → selects the checkpoint corresponding to commit `9949c373` (or the immediately following safe documentation commit) → confirms restore.
3. The Replit checkpoint system restores both the workspace files AND the dev DB to the chosen point.
4. **AGENT** verifies: `git log -1` shows `9949c373` (or the chosen point); `npm run typecheck` passes; the `Start application` workflow restarts cleanly against the restored dev DB.

**Exit criterion:** workspace HEAD is `9949c373`; typecheck green; dev workflow boots without errors.

### Step 5 — Pre-publish dev↔prod schema sanity (15 min) — **AGENT** (read-only)

**Goal:** before publishing, confirm the dev↔prod diff is now small and additive-only.

**Actions:**

I re-run the same drift inventory queries from `docs/dev-prod-schema-drift-2026-05-08.md` against (now-restored) prod and (now-rolled-back) dev. The expected outcome is a much smaller drift list — primarily the 2 dev-only tables (`company_financial_aliases`, `user_lifecycle_events`) and the additive columns from Task #1126/#1095/#1051. If the diff still shows **destructive** operations queued (DROPs against prod), **STOP and reassess**. Do not publish.

**Exit criterion:** drift diff is reviewed and contains only `CREATE TABLE` / `ADD COLUMN` / `ADD CONSTRAINT` operations — no drops, no rename ambiguities. If drops or rename ambiguities remain, fall back to the contingency in Section 5.

### Step 6 — Publish (20–40 min) — **OPERATOR**

**Goal:** execute the publish so prod gets the additive schema changes and the current intended code.

**Actions:**

1. **AGENT** calls `suggestDeploy()`.
2. **OPERATOR** clicks Publish.
3. The Publish UI surfaces the dev↔prod schema diff. **OPERATOR** carefully reviews:
   - Confirm only additive operations are listed.
   - For any rename prompt that surfaces, **explicitly choose `+ create new column`** unless you have positive knowledge that a true rename is intended.
4. **OPERATOR** confirms the publish.
5. Wait for build + deploy to finish (typically 5–15 min). Monitor the deploy logs (I can fetch them with `fetchDeploymentLogs` once they're available).

**Exit criterion:** deploy completes successfully; `getDeploymentInfo()` returns `isDeployed: true` and `hasSuccessfulBuild: true`.

### Step 7 — Verification (30–45 min) — **AGENT** (read-only) + **OPERATOR** (UI smoke test)

**Goal:** confirm the four named flows work end-to-end against prod.

**AGENT actions (read-only prod queries):**

- ✅ `crm_opportunities` table exists in prod with FK from `tasks` intact.
- ✅ `prospects` table exists in prod.
- ✅ `companies.is_email_derived` column exists.
- ✅ `users.is_active` / `users.deleted_at` / `users.is_service_account` columns exist (Task #1126).
- ✅ `company_financial_aliases` table exists.
- ✅ `user_lifecycle_events` table exists.
- ✅ Row counts: contacts/touchpoints/tasks/quote_opportunities all return non-zero counts matching the restore target.

**OPERATOR actions (UI smoke test against the live prod app):**

1. **Contacts:** open a known account, create a new contact, edit an existing contact, soft-delete a test contact. Verify all three persist on page reload.
2. **Touchpoints:** log a touchpoint on the test account with notes. Reload. Verify it appears in history and on the dashboard.
3. **Tasks:** create a task linked to an opportunity and to a contact. Mark complete. Verify it disappears from open tasks and appears in completed.
4. **RFPs:** upload a small test RFP Excel; verify it parses; respond to one row and submit; verify the response is captured.
5. **Customers list:** confirm at least one of the previously-misattributed accounts (Armstrong World Industries, MASONITE MEXICO) now displays under the correct rep.

#### Post-restore acceptance checklist — email & quotes (NEW; addresses the 7f577c98 race-fix and the post-restore inbound flow)

This is the single most important verification block in the entire runbook because it confirms (a) the QO race-condition fix is actually live in prod, (b) M365 resync is processing inbound correctly, and (c) high-value accounts are not silently broken.

**(A) No duplicate-key errors on QO inserts in the first 30–60 minutes — AGENT**

- **AGENT** runs `fetchDeploymentLogs(message: "duplicate key value violates unique constraint", message_context: { lines: 10, limit: 5 })` at T+15 min, T+30 min, and T+60 min after re-enabling `CONTACT_JOBS_ENABLED=true` (Step 8).
- **Pass criterion:** zero matches at all three checkpoints. The `7f577c98` fix uses `ON CONFLICT DO NOTHING` (or equivalent) so the unique-constraint path should never raise.
- **Fail criterion:** any match means `7f577c98` did NOT actually ship in this publish — re-publish required before declaring the window complete. Treat this as a blocker.
- **Also check:** `fetchDeploymentLogs(message: "(?i)quote_opportunit.*conflict|quote_opportunit.*duplicate", message_context: { lines: 5, limit: 5 })` — secondary phrasing.

**(B) Sample of emails → QO creation flows working as expected — AGENT (read-only) + OPERATOR (sample selection)**

- **AGENT** waits 30 min after `CONTACT_JOBS_ENABLED=true` (Step 8) for the M365 resync to land a meaningful batch of post-restore inbound emails.
- **AGENT** runs:
  - `SELECT count(*) FROM email_messages WHERE created_at > '<step-8-restart-timestamp>';` — confirm > 0 (resync is working).
  - `SELECT count(*) FROM quote_opportunities WHERE created_at > '<step-8-restart-timestamp>';` — confirm > 0.
  - `SELECT em.provider_message_id, em.from_email, em.subject, em.created_at AS email_at, q.id AS qo_id, q.created_at AS qo_at FROM email_messages em LEFT JOIN quote_opportunities q ON q.organization_id = em.org_id AND q.source_reference = em.provider_message_id WHERE em.created_at > '<step-8-restart-timestamp>' AND em.subject ILIKE '%quote%' ORDER BY em.created_at DESC LIMIT 20;` — sample of recent quote-shaped inbound emails with their derived QO (or NULL if not yet processed / not classified as a quote).
- **AGENT** checks: for each email row that *should* have produced a QO (subject/body indicates a quote request), is there exactly one matching QO row? Zero is acceptable if the classifier judged it not a quote; **two or more is a regression** of the race-condition fix.
- **AGENT** runs the post-restore duplicate-detection check: `SELECT source_reference, count(*) c FROM quote_opportunities WHERE organization_id = 'da3ed822-8846-4435-bb13-3cc4bf26f71d' AND created_at > '<step-8-restart-timestamp>' GROUP BY 1 HAVING count(*) > 1;` — **expected result: zero rows.** Any rows here = the race fix is not live.
- **Pass criterion:** at least 1 sample email→QO chain exists; the post-restart QO duplicate check returns zero rows.
- **OPERATOR** picks one specific email from the sample, opens it in the prod app's mail/quote view, and confirms the linked QO renders correctly with the right account and right contact attribution.

**(C) High-value accounts verified by hand — OPERATOR**

- **OPERATOR** picks 3–5 high-value accounts (e.g., the largest revenue customers, or the accounts most affected by the prior visibility bug). For each:
  - **(C.1) Emails visible:** open the account → Activity / Inbound tab → confirm recent inbound emails are listed (post-restore + post-Step-8 emails should appear; pre-restore emails up to `2026-05-04T00:00:00Z` should also appear).
  - **(C.2) QOs present, exactly once:** open the account → Quotes / Opportunities tab → confirm each known recent quote appears as a single row (not duplicated). For at least one quote, confirm `source_reference` matches a real `provider_message_id` of a real inbound email (cross-check via `AGENT` SELECT if needed).
  - **(C.3) Lifecycle fields correct:** confirm the account's owner, `is_email_derived` flag, and contact roster look correct — specifically:
    - Owner is the rep the team expects (not `Unknown user`, not the wrong rep from the prior visibility bug).
    - `is_email_derived` is `false` for established customer accounts; `true` only for accounts that were truly auto-created from inbound emails.
    - Primary contact is set; soft-deleted contacts do not appear in the active list; restored contacts (if any from the export bundle) appear correctly.
- **Pass criterion:** all 3–5 high-value accounts pass C.1, C.2, and C.3 with zero hand-corrections needed. If a single account fails any sub-check, hot-fix and re-verify before declaring the window complete.
- **Fail criterion:** any high-value account shows duplicate QOs, missing emails, wrong owner, or incorrect lifecycle flags. This blocks declaring the window successful.

**Exit criterion:** all four operator flows pass UI smoke test; **all three blocks (A), (B), (C) of the email & quotes acceptance checklist pass**; no errors in deployment logs from `fetchDeploymentLogs`.

### Step 8 — Re-enable inbound integrations & exit maintenance (15 min) — **OPERATOR**

**Goal:** turn the lights back on.

**Actions:**

1. **OPERATOR** sets `CONTACT_JOBS_ENABLED=true` (or removes the env var; default is enabled) in prod.
2. Microsoft Graph and Webex subscriptions catch up automatically as the next scheduled syncs run (typically within 5–10 min).
3. **AGENT** monitors `fetchDeploymentLogs` for any errors during catchup; reports anomalies.
4. **OPERATOR** posts the all-clear to the team channel: "FreightDNA is back online. Production data has been restored to [timestamp]. Anything you logged between [timestamp] and now needs to be re-entered. Email contents are preserved on the mail server side and will sync back over the next 30 minutes."

**Exit criterion:** prod inbound writes flowing again; deploy logs clean; team notified.

---

## 4. Verification checklist (consolidated)

Print this and tick off as you go.

**Schema verification (AGENT, read-only):**

- [ ] `crm_opportunities` exists in prod
- [ ] `prospects` exists in prod
- [ ] `tasks_opportunity_id_crm_opportunities_id_fk` exists in prod
- [ ] `companies.is_email_derived` column exists
- [ ] `users.is_active`, `users.deleted_at`, `users.is_service_account`, `users.is_quarantined` columns exist
- [ ] `company_financial_aliases` table exists in prod (newly created by publish)
- [ ] `user_lifecycle_events` table exists in prod (newly created by publish)
- [ ] No tables present in pre-publish prod were dropped by the publish

**Functional verification (OPERATOR, UI):**

- [ ] Contacts: create / edit / soft-delete cycle works
- [ ] Touchpoints: log + reload + appears in history and on dashboard
- [ ] Tasks: create linked to opportunity + complete + appears in completed
- [ ] RFPs: upload + parse + respond + capture
- [ ] Customers list: previously-misattributed accounts now display correctly
- [ ] Quote pipeline: a test inbound email lands as a quote opportunity (validates `7f577c98` race fix)
- [ ] Admin: `/admin-users` lifecycle tabs render and filter correctly

**Operational verification (AGENT):**

- [ ] `fetchDeploymentLogs` shows no ERROR/FATAL lines in the last 30 min
- [ ] `getDeploymentInfo()` reports `hasSuccessfulBuild: true`
- [ ] No 5xx responses in the deploy logs during the smoke test
- [ ] Migration log line `[boot] CONTACT_JOBS_ENABLED=true` present after re-enable

**Email & quotes acceptance (AGENT + OPERATOR) — see Step 7 for details:**

- [ ] (A) Zero `duplicate key value violates unique constraint` matches in deploy logs at T+15 / T+30 / T+60 min after `CONTACT_JOBS_ENABLED=true`
- [ ] (A) Zero `quote_opportunit.*conflict|duplicate` matches in deploy logs over the same window
- [ ] (B) Post-restart `email_messages` count > 0 (M365 resync confirmed flowing)
- [ ] (B) Post-restart `quote_opportunities` count > 0 (inline classifier confirmed flowing)
- [ ] (B) Post-restart `quote_opportunities` duplicate check (`GROUP BY source_reference HAVING count > 1`) returns zero rows
- [ ] (B) At least one specific email→QO chain hand-verified end-to-end in the prod UI
- [ ] (C) 3–5 high-value accounts each pass: emails visible (C.1), QOs present exactly once (C.2), lifecycle fields correct (C.3)

---

## 5. Contingency / rollback plan

If any step fails irrecoverably, here are the exits:

### If Step 3 (DB restore) fails or lands at an unexpected state

- The restore is a destructive operation but the *target* of restore was the snapshot — failures here usually mean the restore didn't actually run, in which case prod is unchanged.
- If the restore landed at the wrong timestamp: contact Replit support immediately to retry against the correct snapshot. Do not proceed to code rollback or publish until prod is at the intended state.

### If Step 5 (drift sanity) shows destructive ops still queued

- **Do NOT publish.** The drift convergence work was not as complete as expected.
- Fall back to **Strategy A from `docs/dev-prod-schema-drift-2026-05-08.md`** (snapshot-then-realign on dev) before re-attempting Step 6. This adds 2–3 hours to the maintenance window or pushes the publish to a follow-up window.

### If Step 6 (publish) fails partway

- Replit's publish flow is transactional at the build level — a failed build does not affect prod.
- A failed *runtime* on the new build will keep serving the previous successful build. Your prod app stays available, just on the previous build.
- **AGENT** fetches the deploy logs (`fetchDeploymentLogs`) and triages the failure. Most likely causes: missing env var on the prod side, schema-diff rename misclick, or runtime crash on first request.
- If the failure is unrecoverable in the window, leave the previous build serving and reschedule the publish.

### If Step 7 verification fails

- If a *single* flow fails, hot-fix in the workspace, re-publish (Step 6 again).
- If *multiple* flows fail in unrelated ways, treat as a deeper compatibility issue between the restored DB state and current code; consider rolling workspace forward to a slightly more recent commit (e.g., add `26b1d866` and `7f577c98` back via cherry-pick) and re-publish.

### Worst case: full rollback of the maintenance window itself

- Restore prod DB to the *pre-restore* forensic snapshot taken in Step 1 (if Replit support assisted with one).
- Roll workspace back to `32170406` (current pre-window HEAD).
- Reset `CONTACT_JOBS_ENABLED=true`.
- Notify reps that the window did not succeed and reschedule.

---

## 6. What I will NOT do without an explicit "execute" from you

To be unambiguous about the guardrails:

- I will not run any `pg_dump` against prod that writes to prod.
- I will not run `executeSql` with `environment: "production"` for anything other than read-only SELECTs.
- I will not invoke `suggestDeploy()` until Step 6 of the runbook is reached AND you confirm.
- I will not invoke `suggestRollback()` until Step 4 of the runbook is reached AND you confirm.
- I will not modify `shared/schema.ts`, `migrations/*.sql`, `drizzle.config.ts`, or run `drizzle-kit push` in any environment.
- I will not modify `.replit` deployment config in this plan (it is correctly set up; no changes needed).

---

## 7. Summary — what I'm asking you to decide

To move this plan from "design" to "scheduled," I need the following from you:

1. **Confirm the restore target:** primary `2026-04-29T23:30:00Z` UTC, fallback later (`2026-05-04T23:00:00Z`) or earlier (`2026-04-25T00:00:00Z`)?
2. **Confirm the workspace target:** rollback to `9949c373` (recommended) or stay on current `32170406`?
3. **Confirm Replit support involvement:** do you want to open a support ticket now (24–48h lead time) for PITR assistance, or check the Database UI first to see if PITR is self-serve on your plan?
4. **Confirm a maintenance window:** date and time. I recommend a Sunday morning (low rep activity, low inbound email volume).
5. **Confirm your intent on the optional dev-side realignment:** do that as a follow-up window per `docs/dev-prod-schema-drift-2026-05-08.md` Strategy B, or roll it into this same window? (Recommended: separate window.)

Once you give me those five answers and say "execute," I run Step 2 (the read-only pre-restore audit) and report findings. After your decision on Step 2's findings, we proceed sequentially.

**Until then, no action is taken. Dev DB is unchanged. Prod DB is unchanged. Workspace is unchanged.**
