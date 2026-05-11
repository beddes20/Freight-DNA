# Restore Window — Operator Card

**One-page operational card.** Full runbook: `docs/operator-maintenance-window-checklist-2026-05-08.md`.
**Sprint context:** `docs/restore-and-hardening-sprint-2026-05-11.md`.
**Locked decisions:** restore prod to `2026-05-04T00:00:00Z`; workspace to commit `9949c373`.

---

## A. What I need from Replit support (BEFORE the window)

Open a ticket. Do not start the window until support confirms in writing:

1. PITR can restore production to `2026-05-04T00:00:00Z` (or names the closest reachable timestamp **at or before** that — never after). Record actual timestamp: `__________________________`
2. Restore mode (in-place vs. new-DB-then-swap) and the rollback-of-restore path.
3. First-publish-after-restore behavior is additive only (`CREATE TABLE`, `ADD COLUMN`, `ADD CONSTRAINT`) — no DROPs.
4. (Optional but recommended) Bulk `pg_dump` of post-target `quote_opportunities` + `email_messages` delivered before restore lands. Once restore runs, the forensic source is gone.

**Lead time: typically 24–48 h. Do not enter the window until every box above is ticked.**

---

## B. Maintenance window — exact order of operations

Estimated total: **3–4 h**. Best on a Sunday morning.

| # | Step | Owner | Time |
|---|---|---|---|
| 1 | Post maintenance banner. Set `CONTACT_JOBS_ENABLED=false` in **prod** env. Leave M365 + Webex subscriptions alone. | OPERATOR | 15 min |
| 2 | Trigger PITR to `2026-05-04T00:00:00Z`. Wait for DB online. Tell me when ready — I run read-only verification SELECTs. | OPERATOR + Replit support | 30–60 min |
| 3 | Roll workspace to `9949c373`: I'll call `suggestRollback`; you click View Checkpoints → select `9949c373` → confirm. After it lands, I cherry-pick the 3 preservation docs back. | OPERATOR (clicks) | 15 min |
| 4 | I re-run drift inventory; confirm dev↔prod diff is **additive only**. **Stop and reassess if any DROP or rename prompt appears.** | AGENT (read-only) | 15 min |
| 5 | I call `suggestDeploy()`; you click Publish. In the schema-diff prompt, for any rename ambiguity choose **`+ create new column`**. Single publish only. | OPERATOR (clicks) | 20–40 min |
| 6 | Acceptance checks (Block A/B/C — Section D below). | AGENT + OPERATOR | 30–45 min |
| 7 | Re-enter the 7 rep rows from `.local/dev-db-backups/prod-after-restore-target/` via the prod **UI** (never SQL). | OPERATOR | 15 min |
| 8 | Set `CONTACT_JOBS_ENABLED=true` in prod. Record the **exact UTC restart timestamp**: `__________________________`. Post all-clear. | OPERATOR | 15 min |

---

## C. Exact commands / scripts after publish

After Step 8, with the restart timestamp from Step 8 in hand:

**1. Pipeline + dup-QO + orphan + schema sanity (run at T+15, T+30, T+60 min):**

```bash
DATABASE_URL=<prod connection string> \
tsx scripts/post-publish-acceptance-check.ts \
  --since-restart <Step 8 restart timestamp, e.g. 2026-05-11T15:30:00Z> \
  --org da3ed822-8846-4435-bb13-3cc4bf26f71d
```

Exit code `0` = pass. Exit code `1` = at least one check failed (do not declare success). Exit code `2` = bad inputs / DB unreachable.

**2. Schema drift sanity (already exists, run alongside):**

```bash
DATABASE_URL=<prod connection string> tsx scripts/check-schema-drift.ts
```

Must print `OK — live DB matches shared/schema.ts`. Exit `0`.

**3. Block A — deploy-log scan for race-fix regressions (I run this for you; not a shell command):**

I'll call `fetchDeploymentLogs` at T+15, T+30, T+60 min with these patterns:
- `duplicate key value violates unique constraint`
- `(?i)quote_opportunit.*conflict|quote_opportunit.*duplicate`

Pass = **zero matches** at all three checkpoints.

---

## D. Success / fail conditions — does Phase 2 open?

**Phase 2 opens ONLY if every box below is ticked. One miss = stop.**

### Schema cleanliness
- [ ] Boot logs show **no** `[schema-drift] WARNING`.
- [ ] Boot logs show **no** `agent_org_settings does not exist` from `valueiq-today`.
- [ ] Boot logs show **no** `reauth_reason does not exist` from Webex webhook subscribe.
- [ ] `scripts/check-schema-drift.ts` exits 0 against prod.

### Block A — race fix actually live
- [ ] Zero `duplicate key value violates unique constraint` in deploy logs at T+15, T+30, T+60 min.
- [ ] Zero `quote_opportunit.*conflict|duplicate` matches over the same window.

### Block B — pipeline flowing, no new dupes
- [ ] `post-publish-acceptance-check.ts` exits 0 at T+30 and T+60 min.
- [ ] At least one specific email→QO chain hand-verified end-to-end in the prod UI.

### Block C — high-value accounts honest
- [ ] 3–5 high-value accounts each pass: emails visible, QOs present **exactly once**, owner is the right rep, `is_email_derived` correct, soft-deleted contacts hidden, primary contact set.

### Functional UI smoke (operator)
- [ ] Contacts: create / edit / soft-delete cycle.
- [ ] Touchpoints: log + reload + appears in history.
- [ ] Tasks: create linked to opportunity + complete.
- [ ] RFP: upload + parse + respond.
- [ ] Customers list: previously-misattributed accounts (Armstrong World Industries, MASONITE MEXICO) display under the correct rep.
- [ ] `/admin-users` lifecycle tabs render and filter correctly.

### Re-entry of rep rows
- [ ] 1 contact row from `contacts.csv` re-entered via prod UI.
- [ ] ~5 task rows from `tasks.csv` (subset created after `2026-05-04T00:00:00Z`) re-entered via prod UI.
- [ ] 1 crm_opportunity row from `crm_opportunities.csv` re-entered via prod UI.
- [ ] `touchpoints.csv` is empty — no action.

**If every box above is ticked → say "Phase 1 done, proceed to Phase 2." If any box is unchecked → see Section E.**

---

## E. If anything fails

| Failing step | Action |
|---|---|
| Step 2 (PITR) lands wrong | Prod usually unchanged. Re-coordinate with Replit support. Do not proceed. |
| Step 4 (drift) shows DROPs or rename prompts | **Do NOT publish.** Fall back to Strategy A from `docs/dev-prod-schema-drift-2026-05-08.md`. |
| Step 5 (publish) build fails | Prior build keeps serving. I triage logs; reschedule if unrecoverable. |
| Block A fails (dup-key matches) | `7f577c98` did not actually ship. Hot-fix and re-publish (Step 5 again). |
| Block B fails (zero new emails or new QOs) | Wait 30 more min for M365 resync; if still zero, scope-dependent triage. |
| Block C fails on a single account | Hot-fix that account; re-verify. |
| Block C fails widely | Consider full rollback per `docs/prod-restore-and-republish-plan-2026-05-08.md` Section 5. |

**Worst case (full rollback):** restore prod to the pre-window forensic snapshot (Step 1), roll workspace back to `32170406`, set `CONTACT_JOBS_ENABLED=true`, notify reps, reschedule.

---

## F. Reminders

- I will never call `suggestDeploy`, `suggestRollback`, or `executeSql` (against prod with anything other than read-only SELECTs) without your explicit go.
- Re-enter rep rows through the **UI**, never direct SQL — lifecycle hooks, audit trails, and FK validation must run.
- Single publish per window. No second publish unless a hot-fix is required by Block A/B/C.
- The Mail.Read grant on `Ops@valuetruck.com` is **not** part of this window — it lands in Phase 2.
