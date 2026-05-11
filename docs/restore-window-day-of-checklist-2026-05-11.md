# Restore Window — Day-Of Checklist

**One-page checklist for the day you actually run the restore window.**
Companion (don't replace): `docs/restore-window-operator-card-2026-05-11.md`, `docs/operator-maintenance-window-checklist-2026-05-08.md`, `docs/prod-restore-and-republish-plan-2026-05-08.md`, `docs/restore-and-hardening-sprint-2026-05-11.md`.
**Locked targets:** prod DB → `2026-05-04T00:00:00Z`. Workspace → commit `9949c373`.

---

## 1. Pre-window (do BEFORE you open the window)

**Replit support — confirmed in writing:**
- [ ] PITR can restore prod to `2026-05-04T00:00:00Z` (or names the closest timestamp **at or before** that — never after). Actual confirmed: `__________________________`
- [ ] Restore mode (in-place vs. new-DB-then-swap) and rollback-of-restore path documented.
- [ ] First-publish-after-restore is additive only: `CREATE TABLE` / `ADD COLUMN` / `ADD CONSTRAINT`. **No DROPs.**
- [ ] (Optional but recommended) Bulk `pg_dump` of post-target `quote_opportunities` + `email_messages` delivered + verified before the restore lands.

**Local backups / exports — verify they exist:**
- [ ] `.local/dev-db-backups/prod-after-restore-target/contacts.csv` (1 row)
- [ ] `.local/dev-db-backups/prod-after-restore-target/touchpoints.csv` (0 rows — header only)
- [ ] `.local/dev-db-backups/prod-after-restore-target/tasks.csv` (9 rows total; ~5 to re-enter)
- [ ] `.local/dev-db-backups/prod-after-restore-target/crm_opportunities.csv` (1 row)
- [ ] `.local/dev-db-backups/prod-after-restore-target/audit_results.md` present (pre-window reference counts)

**Communication — tell these people "do not use Freight-DNA during the window":**
- [ ] Sales reps (team channel banner with start/end window in their TZ + fallback channel for urgent items).
- [ ] Sales managers / directors (separate ping — they'll see acceptance Block C results live).
- [ ] Anyone who has direct prod DB credentials (no manual SQL during the window).
- [ ] Whoever owns the M365 tenant (so they don't grant Mail.Read mid-window — that lands in Phase 2).

---

## 2. During the window — strict order

> Watch deploy logs continuously: I'll call `fetchDeploymentLogs` between steps and report. Workflow log to watch locally if you have access: `Start application`.

| # | Action | Owner | STOP if you see |
|---|---|---|---|
| 1 | Post maintenance banner. Set `CONTACT_JOBS_ENABLED=false` in **prod** env. Leave M365 + Webex subscriptions alone. | OPERATOR | Any rep still actively writing → wait 5 min and re-confirm |
| 2 | Trigger PITR to `2026-05-04T00:00:00Z`. Tell me when DB is back online; I run read-only verification SELECTs on contacts / touchpoints / tasks / crm_opportunities / quote_opportunities / email_messages. | OPERATOR + Replit support | Any `max(created_at)` > `2026-05-04T00:00:00Z` → restore landed wrong, re-coordinate with support |
| 3 | I call `suggestRollback`. You open View Checkpoints → select commit `9949c373` → confirm. | OPERATOR (clicks) | `git log -1` does not show `9949c373` → re-attempt or escalate |
| 4 | I cherry-pick the 3 preservation docs (`dev-prod-schema-drift-2026-05-08.md`, `prod-restore-and-republish-plan-2026-05-08.md`, `preservation-plan-2026-05-08.md`) back on top. Then `npm run check` (typecheck) and confirm `Start application` workflow boots clean against the rolled-back dev DB. | AGENT | Typecheck fails OR boot logs show errors → stop, triage |
| 5 | I re-run drift inventory; confirm dev↔prod diff is **additive only**. Note: `runMigrations.ts` runs automatically on first publish boot — you do NOT invoke it manually. | AGENT | Any DROP, rename ambiguity, or destructive op → **STOP**, do not publish; fall back to `docs/dev-prod-schema-drift-2026-05-08.md` Strategy A |
| 6 | I call `suggestDeploy()`. You click Publish. In any rename prompt, choose **`+ create new column`** unless a true rename is positively known. **Single publish only.** | OPERATOR (clicks) | Build fails → prod stays on previous build; I triage logs and we reschedule |
| 7 | After deploy completes, I confirm `getDeploymentInfo()` returns `isDeployed: true` + `hasSuccessfulBuild: true`, then watch boot logs for `[schema-drift] WARNING`, `agent_org_settings does not exist`, `reauth_reason does not exist`. | AGENT | Any of those three lines appears → **STOP**, do not declare success, do not re-enable jobs |
| 8 | Re-enter the rep rows from `.local/dev-db-backups/prod-after-restore-target/` via the prod **UI** only (never SQL): 1 contact, ~5 tasks (those with `created_at > 2026-05-04T00:00:00Z`), 1 crm_opportunity. | OPERATOR | Any row fails to save → triage individually before continuing |
| 9 | Set `CONTACT_JOBS_ENABLED=true` in prod. Record exact UTC restart timestamp here: `__________________________` | OPERATOR | Boot log does not show `[boot] CONTACT_JOBS_ENABLED=true` → triage |

---

## 3. Immediately post-publish — exact commands

Run these from the workspace with `DATABASE_URL` pointed at **prod**.

**T+15 min, T+30 min, T+60 min after the Step 9 restart timestamp:**

```bash
# Pipeline + dup-QO + orphan + schema sanity
DATABASE_URL=<prod connection string> \
tsx scripts/post-publish-acceptance-check.ts \
  --since-restart 2026-05-11T15:30:00Z \
  --org da3ed822-8846-4435-bb13-3cc4bf26f71d
```

(Replace the `--since-restart` example with the actual UTC timestamp from Step 9. The `--org` UUID `da3ed822-8846-4435-bb13-3cc4bf26f71d` is the FreightDNA prod org from the audit.)

Expected: exit code `0`, `OVERALL: PASS`. Exit `1` = at least one check failed (do NOT declare success). Exit `2` = bad inputs / DB unreachable.

**Run once after T+30 min — schema drift sanity:**

```bash
DATABASE_URL=<prod connection string> tsx scripts/check-schema-drift.ts
```

Expected: `OK — live DB matches shared/schema.ts`, exit `0`.

**Block A — race-fix log scan (I run this for you, three times):**

I'll call `fetchDeploymentLogs` at T+15, T+30, T+60 with patterns `duplicate key value violates unique constraint` and `(?i)quote_opportunit.*conflict|quote_opportunit.*duplicate`. Pass = **zero matches** at all three.

**Block C — operator UI verification (3–5 high-value accounts):**

For each account, confirm: emails visible (post-restore + pre-restore up to 5/4), QOs present **exactly once** (no dupes), owner is the right rep (not "Unknown user", not the prior-bug wrong rep), `is_email_derived` correct, soft-deleted contacts hidden, primary contact set.

**Record results — create a new doc** `docs/restore-window-results-YYYY-MM-DD.md` and copy/paste:
- The Step 9 restart timestamp.
- Exit codes + `OVERALL` lines from each `post-publish-acceptance-check.ts` run (T+15, T+30, T+60).
- Exit code from `check-schema-drift.ts`.
- Block A: timestamp + match count for each `fetchDeploymentLogs` call.
- Block C: the 3–5 account names + pass/fail per sub-check (C.1 emails, C.2 QOs, C.3 lifecycle).
- Functional UI smoke pass/fail (contacts CRUD, touchpoint, task, RFP, customers list).

---

## 4. Go / no-go for Phase 2

### GO — Phase 2 opens (Platform RED → YELLOW)

**ALL** of the following must be true. One miss = no-go.

- [ ] No `[schema-drift] WARNING` in boot logs.
- [ ] No `agent_org_settings does not exist` in boot logs.
- [ ] No `reauth_reason does not exist` in boot logs.
- [ ] `scripts/check-schema-drift.ts` exits `0` against prod.
- [ ] `scripts/post-publish-acceptance-check.ts` exits `0` at T+15, T+30, T+60.
- [ ] Zero `duplicate key value violates unique constraint` in deploy logs at T+15, T+30, T+60.
- [ ] Zero `quote_opportunit.*conflict|duplicate` matches over the same window.
- [ ] At least one specific email→QO chain hand-verified end-to-end in the prod UI.
- [ ] All 3–5 high-value accounts pass C.1 / C.2 / C.3.
- [ ] All operator UI smoke flows pass (contacts CRUD, touchpoint, task, RFP, customers list, `/admin-users` lifecycle tabs).
- [ ] All re-entered rep rows (Section 2 Step 8) saved correctly.

→ Tell me: **"Phase 1 done, proceed to Phase 2."**

### NO-GO — Phase 2 stays closed

Any **one** of these triggers no-go:

- Any `[schema-drift] WARNING` / `agent_org_settings` / `reauth_reason` line in boot logs.
- `check-schema-drift.ts` exit ≠ 0.
- `post-publish-acceptance-check.ts` exit ≠ 0 at any T+ checkpoint.
- Any duplicate-key match in deploy logs at T+15, T+30, or T+60.
- Any high-value account fails C.1, C.2, or C.3.
- Any UI smoke flow fails.
- Any rep-row re-entry refuses to save.

→ Do **NOT** declare success. Do **NOT** open Phase 2. Go to Section 5.

---

## 5. Failure paths

| Failure | First reference | Action |
|---|---|---|
| Step 2 PITR lands wrong | `docs/prod-restore-and-republish-plan-2026-05-08.md` Section 5 ("If Step 3 fails") | Re-coordinate with support; prod usually unchanged |
| Step 5 drift shows DROPs / rename ambiguity | `docs/dev-prod-schema-drift-2026-05-08.md` Strategy A | **Do not publish.** Fall back per the doc; reschedule publish |
| Step 6 publish build fails | `docs/prod-restore-and-republish-plan-2026-05-08.md` Section 5 ("If Step 6 fails") | Prior build keeps serving; I triage `fetchDeploymentLogs`; reschedule if unrecoverable |
| Step 7 boot errors (`[schema-drift] WARNING` etc.) | `docs/dev-prod-schema-drift-2026-05-08.md` + `server/runMigrations.ts` history | Stop. Do not re-enable jobs. Roll back per Section 5 worst-case if unrecoverable |
| Block A fails (dup-key matches) | `docs/restore-and-hardening-sprint-2026-05-11.md` §2.1; `server/storage.ts` `recordQuotePipelineDrop` (~line 10766) | `7f577c98` race fix did not actually ship. Hot-fix and re-publish (Step 6 again) |
| Block B fails (zero new emails or new QOs after 30 min) | `docs/operator-maintenance-window-checklist-2026-05-08.md` Step 5 (B) | Wait another 30 min for M365 resync; if still zero, check Graph subscription health in `/admin-monitored-mailboxes` |
| Block C fails on a single account | `docs/operator-maintenance-window-checklist-2026-05-08.md` Step 5 (C) | Hot-fix that account through normal app surfaces; re-verify |
| Block C fails widely | `docs/prod-restore-and-republish-plan-2026-05-08.md` Section 5 ("Worst case: full rollback") | Restore prod to pre-window forensic snapshot; roll workspace to `32170406`; reset `CONTACT_JOBS_ENABLED=true`; reschedule |

**If there is any doubt — even on a single ambiguous failure — Phase 2 stays closed.** It is always safer to extend Phase 1 (re-publish a hot-fix, or re-run acceptance checks the next day) than to start Phase 2 on top of a half-restored baseline.

---

## Quick-skim summary (read in 30 seconds mid-window)

1. Pre-window: get Replit support PITR confirmation in writing for `2026-05-04T00:00:00Z`.
2. Pre-window: verify `.local/dev-db-backups/prod-after-restore-target/` files all exist.
3. Step 1: post banner; set `CONTACT_JOBS_ENABLED=false` in **prod**.
4. Step 2: trigger PITR; I run read-only SELECTs to verify `max(created_at)` ≤ target.
5. Step 3: roll workspace to `9949c373` via View Checkpoints.
6. Step 4: I cherry-pick 3 preservation docs back; typecheck; boot.
7. Step 5: I re-check drift — **STOP if any DROP / rename ambiguity**.
8. Step 6: single publish; choose `+ create new column` for any rename prompt.
9. Step 7: confirm boot logs are clean (no `[schema-drift] WARNING`, no `agent_org_settings`, no `reauth_reason`).
10. Step 8: re-enter 7 rep rows via the **UI** only.
11. Step 9: `CONTACT_JOBS_ENABLED=true` in prod; **record the restart timestamp**.
12. T+15/30/60: run `scripts/post-publish-acceptance-check.ts` with `--since-restart` + `--org`; exit `0` required.
13. T+30: run `scripts/check-schema-drift.ts`; exit `0` required.
14. Operator: 3–5 high-value accounts pass C.1 emails / C.2 QOs-once / C.3 lifecycle.
15. Record everything in `docs/restore-window-results-YYYY-MM-DD.md`. Then say "Phase 1 done, proceed to Phase 2" — or, if anything is off, **keep Phase 2 closed** and triage per Section 5.
