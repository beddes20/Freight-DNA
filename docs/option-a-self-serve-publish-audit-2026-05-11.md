# Option A — Self-Serve Publish Audit (no prod DB restore)

**Authored:** 2026-05-11. **Planning / read-only.** No code changes. No schema changes. No prod writes. No publish executed.
**Companions:** `docs/dev-prod-schema-drift-2026-05-08.md`, `docs/restore-target-recommendation-2026-05-08.md`, `docs/restore-and-hardening-sprint-2026-05-11.md`, `.local/dev-db-backups/prod-after-restore-target/audit_results.md`.

---

## TL;DR

**Option A is viable.** You can get back to a stable, publishable state without depending on Replit support for a prod DB restore.

But there is one important correction to the prior premise: **rolling the workspace back to `9949c373` is *not* what unblocks publish.** A read of the git history shows `shared/schema.ts`, `server/runMigrations.ts`, and the `migrations/` directory are **byte-identical** between `9949c373` and current HEAD (`01be52aa`). The 30 commits since `9949c373` are all docs + code (Tasks #1139–#1176 hardening), with **zero changes** to the schema source-of-truth.

So the publish blockers are independent of which of those two commits you ship. The choice between them is a *product-feature* choice (do you want the post-9949c373 hardening or not?), not a *publishability* choice. **My recommendation is to publish from current HEAD** — it carries 12 tasks of incremental CQ/Customers hardening (#1139, #1140, #1141, #1142, #1143, #1145, #1146, #1147, #1148, #1150, #1151, #1152, #1153, #1176) with their guardrail tests, and rolling them back loses bug fixes for no schema benefit.

If you'd rather still ship from `9949c373` for psychological-baseline reasons, that's also fine — same publish blockers, same fix, just fewer features.

---

## What changed between `9949c373` and HEAD (and what didn't)

**Did NOT change (verified by `git diff --stat 9949c373..HEAD`):**
- `shared/schema.ts`
- `server/runMigrations.ts`
- `server/checkSchemaDrift.ts`
- `migrations/*`

This means the **publish-time dev↔prod schema diff is identical** whether you publish from HEAD or from `9949c373`. The "schema experimentation chain" the prior docs warned about appears to have been operator-side (`drizzle-kit push` attempts against dev DB) that did not result in any committed source changes.

**DID change (~50 files):**
- `server/services/customerQuotes.ts`, `server/routes/customerQuotes.ts`, `server/storage.ts`, `server/routes/financials.ts`, `server/services/quoteEmailIngestion.ts`, `server/services/staleQuoteFollowup.ts`, etc.
- `client/src/pages/{customers,quote-requests,top-opportunities,conversations}.tsx`
- New CQ guardrail tests, new `tests/code-quality-guardrails.test.ts` sections (1140, 1142, 1143, 1146, 1147, 1148, 1150, 1151, 1152, 1153)
- `replit.md` Gotchas updates
- 11 planning / triage docs

None of these touch publish behavior. They harden ownership / dismiss / unknown-sender / sort-key / cache-bust paths.

---

## Real publish blockers (independent of commit choice)

From `docs/dev-prod-schema-drift-2026-05-08.md`:

### Blocker 1 — Drizzle rename-detection prompt

`webex_user_tokens.scopes_version` (dev) ↔ `reauth_reason` (prod) — drizzle's interactive `push --force` previously surfaced this as a "rename?" prompt. **In the Replit Publish UI**, the same surface appears as a rename ambiguity dialog.

**Fix:** at publish time, click **"+ create new column"** (not "rename"). This makes drizzle treat them as two independent columns: dev's `scopes_version` becomes a new column in prod (additive), and prod's `reauth_reason` is left alone. Both columns end up living in prod side-by-side; no data is destroyed; the in-code references in `server/routes/webex.ts` line 835 and `server/runMigrations.ts` line 4319 keep working because they target the prod-side column.

**Risk if mishandled:** if you click "rename" instead of "create new column," prod's `reauth_reason` column gets renamed to `scopes_version` and existing values become inaccessible to the Webex re-auth flow until the column is named correctly again. **Recoverable but disruptive.** This is the single most important publish-UI click.

### Blocker 2 — Two dev-only tables get CREATE'd in prod

- `company_financial_aliases` (Task #1051)
- `user_lifecycle_events` (Task #1126)

Both are additive `CREATE TABLE` operations from drizzle's perspective. **No risk to prod data.** They start empty in prod; readers tolerate empty.

### Blocker 3 — ADD COLUMN sweep

From the drift inventory:

- `users`: 13 nullable columns added (Task #1126 lifecycle work)
- `companies`: 3 nullable columns added (Task #1095 email-derived)
- `email_messages`: 3 nullable columns added
- `account_contact_lane_pattern_responsibilities`: 5 nullable columns added

All additive, all nullable, all safe. No DROPs, no data loss.

### Blocker 4 — Prod-only tables and columns the dev schema does not know about (59 tables + 6 columns)

These are tables / columns prod has that dev's `shared/schema.ts` does not declare. **Drizzle does not drop them by default** (it only proposes drops when you explicitly use `--force` against a non-source-of-truth directive). The Replit Publish flow surfaces these as a list of "unknown" tables that will be left alone.

**Risk:** none, as long as you confirm in the Publish UI that the diff is "additive only" and decline any "drop" prompts. Said another way: at publish time, **read the entire diff carefully and refuse anything that says DROP, DELETE, or DESTROY**.

### Non-blockers (already verified)

- The `agent_org_settings does not exist` boot error and the `reauth_reason does not exist` boot error are **dev-only** (the tables/columns exist in prod). They will *go away* in dev after a successful publish brings dev's DB in line via the schema-source-of-truth path. They do **not** affect prod boot.
- The `[schema-drift] WARNING` in dev boot is the same situation — prod-only tables/columns dev doesn't declare. Going away after publish.
- The `7f577c98` race fix is in workspace `server/storage.ts` line ~10766 (verified). Will ship with publish.

---

## Safest self-serve sequence

This is a single short window — **no maintenance mode, no DB restore, no Replit support needed**. Estimated total: **45–90 min** (most of which is operator clicking + waiting for build).

### Step 0 — Preflight (read-only, ~10 min)

- [ ] Confirm `.local/dev-db-backups/prod-after-restore-target/` is intact (audit reference for later data triage).
- [ ] Run `tsx scripts/check-schema-drift.ts` against **dev** DB. Capture the output. (Expected: drift, because dev is the source-of-truth-with-gaps. We just want a recorded baseline.)
- [ ] Run `git --no-optional-locks log -1 --format="%h %s"`. Confirm HEAD = `01be52aa` (or whatever is current). Decide: publish from HEAD (recommended) or roll back to `9949c373`.

### Step 1 — (Optional) Rollback to `9949c373` (~10 min)

**Skip this step if you publish from HEAD.** Only do it if you want to drop the post-`9949c373` hardening for product reasons.

- [ ] Tell me to call `suggestRollback`. You click **View Checkpoints** → select `9949c373` → confirm.
- [ ] After rollback lands, `git --no-optional-locks log -1` shows `9949c373`.
- [ ] Cherry-pick the docs you want to keep back on top:
  - `docs/dev-prod-schema-drift-2026-05-08.md`
  - `docs/restore-target-recommendation-2026-05-08.md`
  - `docs/restore-and-hardening-sprint-2026-05-11.md`
  - `docs/restore-window-operator-card-2026-05-11.md`
  - `docs/restore-window-day-of-checklist-2026-05-11.md`
  - `docs/freight-dna-platform-health-report-2026-05-11.md`
  - `docs/option-a-self-serve-publish-audit-2026-05-11.md` (this doc)
  - `docs/tab-customers-one-pager-2026-05-11.md`
- [ ] `npm run check` (typecheck) passes; `Start application` workflow boots.

### Step 2 — Pre-publish drift sanity (read-only, ~5 min)

- [ ] I re-run drift inventory. Confirm the diff vs prod is the four blocker categories above and **nothing destructive**.
- [ ] **STOP if any DROP, DELETE, or destructive op appears in the diff.** Switch to a different plan.

### Step 3 — Publish (~30–45 min, mostly waiting)

- [ ] You set / confirm `CONTACT_JOBS_ENABLED=true` in prod (default; no need to flip off because no DB restore is happening).
- [ ] Tell me to call `suggestDeploy()`. You click **Publish**.
- [ ] **In the schema-diff prompt, carefully:**
  - Approve all `CREATE TABLE` ops (the 2 dev-only tables).
  - Approve all `ADD COLUMN` ops (Task #1095, #1126, etc.).
  - **For the `webex_user_tokens.scopes_version` ↔ `reauth_reason` rename prompt: choose "+ create new column".** Do not click "rename".
  - Decline any DROP / DELETE prompts (there should be none; if there are, STOP).
- [ ] Single publish only. Wait for build + deploy to complete.
- [ ] I confirm `getDeploymentInfo()` returns `isDeployed: true` + `hasSuccessfulBuild: true`.

### Step 4 — Post-publish smoke (read-only, ~15 min)

- [ ] I watch boot logs for the three signals: `[schema-drift] WARNING`, `agent_org_settings does not exist`, `reauth_reason does not exist`. **All three should now be absent in prod.**
- [ ] Run:
  ```bash
  DATABASE_URL=<prod connection string> tsx scripts/check-schema-drift.ts
  ```
  Expected: `OK — live DB matches shared/schema.ts`, exit `0`.
- [ ] Run (acceptance check, with T0 = the deploy timestamp):
  ```bash
  DATABASE_URL=<prod connection string> \
  tsx scripts/post-publish-acceptance-check.ts \
    --since-restart <T0 in UTC ISO> \
    --org da3ed822-8846-4435-bb13-3cc4bf26f71d
  ```
  Expected: schema-presence checks PASS; pipeline-flowing checks PASS; **dup-QO check is informational only** (existing pre-publish dup rows are still in prod — we have not restored — so this will likely report dups; what matters is whether the count *grows* over T+15 / T+30 / T+60, which would mean the race fix didn't ship).
- [ ] I scan deploy logs at T+15 / T+30 / T+60 for `duplicate key value violates unique constraint` and `(?i)quote_opportunit.*conflict|quote_opportunit.*duplicate`. Pass = **zero matches** at all three (proves race fix is live).
- [ ] Operator UI smoke: contacts CRUD, touchpoint, task, RFP, customers list. Pass = all flows work.

### Step 5 — Stable shipping environment declared

If Step 4 passes:
- Platform: **RED → YELLOW** (publish path unblocked, boot clean, race fix live).
- Data trust: **stays YELLOW** until you do the data cleanup work (the prior Phase 2). Pre-publish dup-QO rows + 6 orphans + broken ownership attribs are unchanged.
- You now have a stable shipping environment without depending on Replit support.

### Step 6 — Rebuild / fix prod data (separate, no time pressure)

This is the equivalent of the prior Phase 2, but executed against the *unrestored* prod (which has the data corruption baked in). Work through these in the order that hurts reps least:

1. **Race-fix monitoring (passive, 24–48 h):** confirm dup-QO group count is *flat* over 24 h (no new dupes). If yes, the race fix is sustained.
2. **Reattribution of known broken accounts (manual, UI):** Armstrong World Industries, MASONITE MEXICO, and any others reps flag. Each correction goes through the prod app's normal write paths, not SQL.
3. **Email-derived flag backfill (deferred until designed):** the legacy stub population is unchanged — admin's "Heuristic (legacy)" mode at `/admin/email-derived-companies` still works as a stop-gap.
4. **One-shot dup-QO cleanup (deferred until designed):** the ~9,560 dup_groups / ~19,283 redundant rows from before `7f577c98` shipped are still there. Fix later via the script designed in `docs/restore-and-hardening-sprint-2026-05-11.md` §2.2 (not yet implemented; gated behind feature flag, requires explicit operator opt-in).
5. **Orphan QO triage (deferred):** the 6 orphan rows. Fix later via the script designed in §2.2.
6. **Ops mailbox `Mail.Read` grant (out-of-code):** operator action in M365 admin portal. Watchdog clears automatically.

None of (3)–(6) is blocking for declaring "stable shipping environment." They're trust polish, scheduled at your pace.

---

## What you give up by choosing Option A over a DB restore

**You keep the data corruption that a restore would have erased:**
- ~9,560 dup-QO groups / ~19,283 redundant rows (from before `7f577c98` ships).
- 6 orphan QOs (no customer).
- Whatever ownership mis-attributions reps flagged pre-restore (Armstrong World Industries, MASONITE MEXICO, etc.).
- ~838 stale `account_contact_suggestions` from the pre-publish signature sweep.

**You keep:**
- All post-restore-target writes that a restore-to-`2026-05-04T00:00:00Z` would have lost — including ~80,788 unique inbound emails, ~16,000 QOs (a mix of duplicates and legitimate new business), and any rep-entered work after `2026-05-04T00:00:00Z`.

**Trade-off summary:** Option A trades clean historical data for not losing 4–8 days of rep + integration work. The corruption is *known*, *bounded*, and *fixable in-app* over time. The lost work in a restore is *unrecoverable from app surfaces alone* (M365 emails resync, but classifier outputs and rep-entered work do not).

For most teams that are losing trust *because the system has been down*, Option A is the right trade. For a team that needs *historically clean* data more than it needs the recent activity, restore is the right trade.

---

## What I will NOT do without an explicit "execute" from you

- Will not call `suggestRollback`, `suggestDeploy`, `executeSql` (against prod with anything other than read-only SELECTs), or `drizzle-kit push` in any environment.
- Will not modify `shared/schema.ts`, `server/runMigrations.ts`, `migrations/*`, `drizzle.config.ts`, or `replit.md`.
- Will not start Phase 2 work (cleanup script, backfill script, Mail.Read wiring) — those land *after* Option A's publish stabilizes.

---

## Quick-skim summary

1. **Option A is viable** — self-serve, no Replit support needed, no DB restore.
2. **Schema source is identical at `9949c373` and HEAD** — rollback is *not* required to unblock publish; recommended is to publish from HEAD.
3. **Single most important publish-UI click:** for the `webex_user_tokens.scopes_version` ↔ `reauth_reason` rename prompt, choose **"+ create new column"** — not "rename".
4. **All other publish ops are additive** — 2 `CREATE TABLE`, ~24 nullable `ADD COLUMN`. No DROPs.
5. **Boot-time errors clear themselves** in prod after publish (they're dev-only; prod already has the underlying tables/columns).
6. **Data corruption stays as-is** — fix in-app over time (Phase 2 deferred work).
7. **No maintenance window required** — `CONTACT_JOBS_ENABLED` stays `true`. Publish + smoke checks take ~45–90 min.
8. **Acceptance script reused as-is:** `scripts/post-publish-acceptance-check.ts`. The dup-QO check becomes a *trend* check (does it grow?) instead of a pass/fail check (since pre-existing dupes remain).
9. **If anything in the schema-diff prompt says DROP, STOP.** Switch plans.
10. **Phase 2 work stays closed** until you say "Option A done, proceed to Phase 2 cleanup."
