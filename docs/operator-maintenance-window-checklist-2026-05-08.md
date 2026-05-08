# Operator Maintenance Window Checklist

**One-page operator checklist for the FreightDNA prod restore + republish window.**
**Authored:** 2026-05-08. **Status:** planning only. **No execution until operator says "execute."**
**Full runbook:** `docs/prod-restore-and-republish-plan-2026-05-08.md` (Step 0 → Step 8).
**Audit & rationale:** `docs/restore-target-recommendation-2026-05-08.md`.

---

## Locked decisions (do not silently change)

- **Prod DB restore target:** `2026-05-04T00:00:00Z`
- **Workspace code target:** commit `9949c373`
- **Code preservation:** Option A — cherry-pick 3 docs back on top of `9949c373` after rollback
- **Rep-data export:** small tables already in `.local/dev-db-backups/prod-after-restore-target/` (contacts.csv, touchpoints.csv = empty, tasks.csv, crm_opportunities.csv)

---

## Pre-window blocking gate

**Step 0 — Replit support has confirmed (in writing) all of the following BEFORE the window starts:**

- [ ] PITR can restore prod to `2026-05-04T00:00:00Z` (or to a confirmed at-or-before alternative timestamp; record it: `__________________________`)
- [ ] Restore mode (in-place vs new-DB-then-swap) and rollback-of-restore path are documented
- [ ] First-publish migration behavior post-restore is confirmed: additive only (`CREATE TABLE`, `ADD COLUMN`), no DROPs
- [ ] (Optional) Bulk forensic `pg_dump` of post-target `quote_opportunities` + `email_messages` is delivered and verified

**Do NOT enter the window until every box above is ticked.**

---

## During maintenance window — 7 ordered steps

### 1. Enter maintenance mode — OPERATOR (~15 min)

- [ ] Post maintenance banner to team channel; provide fallback channel for urgent items
- [ ] Set `CONTACT_JOBS_ENABLED=false` in **production** environment variables
- [ ] Confirm Replit support has the optional pre-restore forensic snapshot in hand (if requested)
- [ ] Acknowledge: M365 / Webex subscriptions are intentionally LEFT AS-IS (they re-deliver on next sync; do not unsubscribe)

### 2. Run support-approved PITR for `2026-05-04T00:00:00Z` — OPERATOR + Replit support (~30–60 min)

- [ ] Trigger PITR / snapshot restore to **`2026-05-04T00:00:00Z`** (or to the Step-0-confirmed at-or-before alternative)
- [ ] Wait for prod DB to come back online (typically 5–20 min after restore command)
- [ ] AGENT runs read-only verification SELECTs (full list in runbook Step 3): `max(created_at)` ≤ target on contacts/touchpoints/tasks/crm_opportunities/quote_opportunities/email_messages
- [ ] Pre/post counts diff matches audit estimates: `quote_opportunities` drops by ≈16,000; `email_messages` drops by ≈66,000
- **Do NOT proceed if any verification fails — re-coordinate with Replit support before continuing.**

### 3. Roll workspace code back to `9949c373` — OPERATOR (~15 min)

- [ ] AGENT calls `suggestRollback` with rationale "align workspace with post-restore prod state"
- [ ] OPERATOR opens View Checkpoints → selects checkpoint corresponding to commit `9949c373` → confirms restore
- [ ] AGENT verifies: `git log -1` shows `9949c373`; `npm run typecheck` passes; `Start application` workflow boots cleanly
- [ ] (After restore lands) cherry-pick the 3 preservation docs back on top per Code Preservation Option A:
  - `docs/dev-prod-schema-drift-2026-05-08.md`
  - `docs/prod-restore-and-republish-plan-2026-05-08.md`
  - `docs/preservation-plan-2026-05-08.md`

### 4. Publish ONCE — OPERATOR (~20–40 min)

- [ ] AGENT re-runs the dev↔prod drift inventory; confirms diff is additive only (no DROPs, no rename ambiguities). **Stop and reassess if drops or rename prompts appear.**
- [ ] AGENT calls `suggestDeploy()`
- [ ] OPERATOR clicks Publish in the Publish UI
- [ ] OPERATOR carefully reviews the schema diff in the Publish UI:
  - Confirm only `CREATE TABLE` / `ADD COLUMN` / `ADD CONSTRAINT` operations
  - For any rename prompt: explicitly choose **`+ create new column`** unless a true rename is positively known
- [ ] OPERATOR confirms publish; waits for build + deploy to complete
- [ ] AGENT confirms `getDeploymentInfo()` returns `isDeployed: true` and `hasSuccessfulBuild: true`
- **Single publish only. Do NOT republish in the same window unless an explicit hot-fix is required by acceptance checks (Step 5).**

### 5. Run acceptance checks — AGENT + OPERATOR (~30–45 min)

**Schema verification (AGENT, read-only):** run the consolidated checklist from runbook Section 4.

**Functional verification (OPERATOR, UI):** contacts CRUD, touchpoints log, tasks complete, RFP upload+respond, customers list rep attribution.

**Email & quotes acceptance — the critical block (AGENT + OPERATOR):**

- [ ] (A) Zero `duplicate key value violates unique constraint` matches in deploy logs at **T+15 / T+30 / T+60 min** after Step 7's `CONTACT_JOBS_ENABLED=true` (run separately during/after Step 7 below — placed here so the operator sees the full acceptance set in one place)
- [ ] (A) Zero `quote_opportunit.*conflict|duplicate` log matches over same window
- [ ] (B) Post-restart `email_messages` count > 0 (M365 resync flowing)
- [ ] (B) Post-restart `quote_opportunities` count > 0 (inline classifier flowing)
- [ ] (B) Post-restart QO duplicate check (`GROUP BY source_reference HAVING count > 1`) returns **zero rows** — confirms `7f577c98` race fix is live
- [ ] (B) At least one specific email→QO chain hand-verified end-to-end in the prod UI
- [ ] (C) 3–5 high-value accounts each pass:
  - C.1 Emails visible (post-restore inbound + pre-restore up to 5/4 both appear)
  - C.2 Quotes present **exactly once** (no duplicates), `source_reference` matches a real `provider_message_id`
  - C.3 Lifecycle fields correct: owner is the right rep (not Unknown, not the prior-bug wrong rep), `is_email_derived` is correctly false for established customers, soft-deleted contacts hidden, primary contact set
- **Any failure in (A), (B), or (C) blocks declaring the window successful — hot-fix and re-publish, or roll back per runbook Section 5.**

### 6. Re-enter the 7 rep rows via UI — OPERATOR (~15 min)

The rep-entered rows exported pre-restore are at `.local/dev-db-backups/prod-after-restore-target/`. Re-enter through the prod app's normal write paths — NOT direct SQL — so lifecycle hooks, audit trails, and FK validation all run.

- [ ] **`contacts.csv`** (1 row): re-create the contact through the prod UI → Customers → [account] → Contacts → New
- [ ] **`tasks.csv`** (9 rows total; re-enter the subset whose `created_at > '2026-05-04T00:00:00Z'`, ~5 rows): re-create through the prod UI → Tasks (or the in-context task creator on the linked account/opportunity)
- [ ] **`crm_opportunities.csv`** (1 row): re-create through the prod UI → CRM → Opportunities → New
- [ ] **`touchpoints.csv`** (0 rows, header only): no action — confirmed empty
- [ ] After each re-entry, reload and confirm the row appears with correct attribution
- **Total: ~7 rows of manual rep-entry. Should take <30 min.**

### 7. Re-enable jobs — OPERATOR (~15 min)

- [ ] OPERATOR sets `CONTACT_JOBS_ENABLED=true` (or removes the env var) in **production**
- [ ] OPERATOR notes the **exact UTC restart timestamp** here for use by Step 5's acceptance queries: `__________________________`
- [ ] AGENT confirms boot log line `[boot] CONTACT_JOBS_ENABLED=true` appears in deploy logs
- [ ] AGENT begins the T+15 / T+30 / T+60 min log scans from Step 5 acceptance block (A)
- [ ] M365 / Webex subscriptions catch up automatically over the next 5–10 min
- [ ] OPERATOR posts all-clear to team channel: "FreightDNA is back online. Production restored to 2026-05-04T00:00:00Z. Anything you tried to log between then and now needs to be re-entered. Inbound emails will catch up over the next 30 min."
- **Window is NOT declared complete until Step 5 acceptance block (A)/(B)/(C) all pass post-restart.**

---

## If anything fails partway

See runbook Section 5 ("Contingency / rollback plan"). Quick map:

- **Step 2 (PITR) fails:** prod is unchanged; re-coordinate with Replit support. Do not proceed.
- **Step 3 (workspace rollback) fails:** revert checkpoint UI action; re-attempt or escalate.
- **Step 4 (publish) fails build:** prod stays on previous successful build. AGENT triages logs; reschedule publish if unrecoverable.
- **Step 5 (acceptance) fails (A) — duplicate-key errors:** `7f577c98` did not actually ship. Hot-fix and re-publish (Step 4 again).
- **Step 5 (acceptance) fails (B)/(C):** scope-dependent. Single-account issue → hot-fix; widespread issue → consider full rollback per runbook Section 5 ("Worst case: full rollback of the maintenance window itself").

---

## Post-window (separate maintenance window, NOT today)

- [ ] Schedule dev schema realignment per `docs/dev-prod-schema-drift-2026-05-08.md` Strategy B
- [ ] Plan a separate dedup SQL pass on the preserved 4/30–5/3 backfill-window QOs if duplication is observed there (race-fix prevents NEW duplicates but doesn't clean pre-existing ones)
