# Option A — Post-Publish Acceptance Checklist

**One-page checklist for what to run AFTER you click "Confirm Publish."** Companion: `docs/option-a-publish-checklist-2026-05-11.md` (the during-publish checklist).
**Status:** planning / read-only. Run from the workspace; all commands are read-only.
**T0 = the exact UTC timestamp you recorded when the deploy completed.** Example: `2026-05-11T16:42:00Z`.

---

## Step 0 — Wait for deploy to land (~5–15 min)

- [ ] Wait until the Replit Publish UI shows "Build successful" + "Deploy live."
- [ ] Tell me "deploy completed" — I will run `getDeploymentInfo()` and confirm `isDeployed: true` + `hasSuccessfulBuild: true`.
- [ ] I scan the first 60 seconds of boot logs (`fetchDeploymentLogs`) for the three signals:
  - `[schema-drift] WARNING` — **expected: absent in prod.** (It's expected to *still* be present in dev — that's a separate cleanup, not a publish blocker.)
  - `agent_org_settings does not exist` — **expected: absent.** Prod has the table.
  - `reauth_reason does not exist` — **expected: absent.** Prod has the column.
  - **If any of the three appears in PROD boot logs → problem.** Tell me; we triage before declaring success.

---

## Step 1 — Schema sanity (~2 min)

```bash
DATABASE_URL=<prod connection string> tsx scripts/check-schema-drift.ts
```

- **PASS:** `OK — live DB matches shared/schema.ts.` Exit `0`.
- **PROBLEM:** `FAIL — add the missing CREATE/ALTER statements…` Exit `1`. Tell me — likely the publish skipped one of the expected ops, or a column type mismatch surfaced.
- **CRITICAL:** Exit `2` (script crashed / can't reach DB). Tell me — DATABASE_URL or network issue.

---

## Step 2 — Acceptance check at T+15 min (~2 min)

Wait until **15 minutes after T0**. Then:

```bash
DATABASE_URL=<prod connection string> \
tsx scripts/post-publish-acceptance-check.ts \
  --since-restart <T0 in UTC ISO, e.g. 2026-05-11T16:42:00Z> \
  --org da3ed822-8846-4435-bb13-3cc4bf26f71d
```

(The flag is named `--since-restart` for legacy reasons; here it just means "T0".)

What each line of output means under Option A:

| Check | PASS | PROBLEM |
|---|---|---|
| `schema: table public.crm_opportunities` | `present` | `MISSING` → publish didn't apply. Tell me. |
| `schema: table public.prospects` | `present` | `MISSING` → publish didn't apply. Tell me. |
| `schema: table public.company_financial_aliases` | `present` | `MISSING` → the `CREATE TABLE` op didn't run. Tell me. |
| `schema: table public.user_lifecycle_events` | `present` | `MISSING` → the `CREATE TABLE` op didn't run. Tell me. |
| `schema: column public.companies.is_email_derived` | `present` | `MISSING` → Task #1095 ADD COLUMN didn't run. Tell me. |
| `schema: column public.users.{is_active, deleted_at, is_service_account, is_quarantined}` | `present` | `MISSING` → Task #1126 ADD COLUMN didn't run. Tell me. |
| `block-B: dup-QO groups since <T0>` | `0 duplicate groups (race fix live)` | `> 0 duplicate groups` → race fix didn't ship. Treat as a publish failure. |
| `block-B: email_messages since <T0>` | `> 0 new emails` (M365 resync flowing) | `0 new emails` after 15 min → triage Graph subscription. Wait another 30 min and re-check. |
| `block-B: quote_opportunities since <T0>` | `> 0 new QOs` (classifier flowing) | `0 new QOs` after 15 min → likely no quote-shaped inbound yet. Re-check at T+30 / T+60. |
| `orphan-QO count` | `≤ 6 (pre-window: 6; not regressed)` | `> 6` → new orphans being created. Triage. |

Overall script exit:
- `0` = all PASS → continue.
- `1` = at least one FAIL → stop, tell me, do NOT declare publish successful.
- `2` = script crashed / bad inputs → tell me.

**Important nuance under Option A (vs. the original restore plan):** the dup-QO check is *not* expected to be `0` for the *historical* baseline — there are ~9,560 dup-groups from before the race fix shipped. The script scopes its dup check to `created_at > T0`, so it only sees post-publish dupes. **Zero new dupes since T0 = pass.** Anything > 0 means the race fix didn't actually ship.

---

## Step 3 — Acceptance check at T+30 min (~2 min)

Re-run the same command from Step 2. Same pass/fail rubric. Required to pass before declaring publish successful.

---

## Step 4 — Acceptance check at T+60 min (~2 min)

Re-run the same command from Step 2. Same pass/fail rubric. **All three runs (T+15, T+30, T+60) must pass before declaring publish successful.**

---

## Step 5 — Race-fix log scan at T+15 / T+30 / T+60 (I run this for you)

At each checkpoint, I will call `fetchDeploymentLogs` with these patterns:

- `duplicate key value violates unique constraint`
- `(?i)quote_opportunit.*conflict|quote_opportunit.*duplicate`

**PASS:** zero matches at all three checkpoints — proves `7f577c98` race fix is live.
**PROBLEM:** any match — race fix did not ship. Treat as a publish failure; we hot-fix and re-publish.

Tell me at each checkpoint when you've finished Steps 2 / 3 / 4 and I'll run the log scan in the same window.

---

## Step 6 — UI sanity flows (operator, ~15 min)

Pick **one** account you know well and run all five flows against it. Then pick **two more** high-value accounts and just run flows 1, 4, 5 on them.

| # | Flow | PASS | PROBLEM |
|---|---|---|---|
| 1 | **Contacts:** open the account → Contacts tab → add a new test contact → edit it → soft-delete it → reload page | All three states persist as expected on reload | Any state lost on reload, or soft-deleted contact still appears in active list |
| 2 | **Touchpoints:** log a touchpoint with a short note on the same account → reload | Touchpoint appears in history with correct timestamp + author | Missing, wrong author, wrong timestamp |
| 3 | **Tasks:** create a task linked to an opportunity on the account → mark complete | Task disappears from open, appears in completed | Stays in open, or fails to save |
| 4 | **RFP:** upload a small test RFP Excel → respond to one row → submit | Excel parses cleanly; response captured | Parse fails, response not captured |
| 5 | **Email → QO:** find a recent inbound quote-shaped email in the account → confirm exactly one matching quote opportunity exists for it (not zero, not two+) | Exactly one QO per email, `source_reference` matches the email's `provider_message_id` | Zero QOs (classifier not running) or two+ (race fix not live) |

Plus one cross-account check:

- [ ] **Customers list:** open the Customers tab as yourself. Confirm you see only your book (not "every company"). If you have access to `Armstrong World Industries` or `MASONITE MEXICO`, confirm the displayed owner now matches what reps expect.

---

## Step 7 — Record results

Create `docs/option-a-publish-results-YYYY-MM-DD.md` and capture:

- T0 (exact UTC deploy timestamp).
- Step 0 boot-log signals (none present = pass).
- Step 1 `check-schema-drift.ts` exit code.
- Step 2 / 3 / 4 acceptance-check exit codes + which line(s) failed if any.
- Step 5 log-scan match counts at T+15 / T+30 / T+60.
- Step 6 UI flow pass/fail per row.

---

## Go / no-go for "Option A complete, Platform RED → YELLOW"

**GO** — declare success and move to deferred Phase 2 cleanup work — only if **all** of the following are true:

- [ ] Deploy live, `isDeployed: true` + `hasSuccessfulBuild: true`.
- [ ] No `[schema-drift] WARNING`, `agent_org_settings does not exist`, or `reauth_reason does not exist` in **prod** boot logs.
- [ ] `check-schema-drift.ts` exits `0`.
- [ ] `post-publish-acceptance-check.ts` exits `0` at T+15, T+30, T+60.
- [ ] Zero `duplicate key value violates unique constraint` matches at T+15, T+30, T+60.
- [ ] Zero `quote_opportunit.*conflict|duplicate` matches over the same window.
- [ ] All five UI flows pass on the primary account; flows 1, 4, 5 pass on the two additional accounts.
- [ ] Customers list shows your book correctly.

→ Tell me **"Option A complete, Platform RED → YELLOW."**

**NO-GO** — keep current build serving, do not declare success — if **any** of the above fails. Specifically:

- Boot errors in prod logs → tell me; we may need to roll back the deploy.
- `check-schema-drift.ts` fails → publish skipped an expected op.
- Acceptance check fails on schema rows → publish skipped a `CREATE TABLE` or `ADD COLUMN`.
- Acceptance check fails on dup-QO rows since T0 → race fix didn't ship; hot-fix and re-publish.
- Acceptance check shows zero new emails *and* zero new QOs after T+60 → M365 / classifier path is broken; triage before declaring success.
- UI flow fails → likely a pre-existing data issue on that specific account; spot-fix via UI, then re-verify.

**If any doubt at all → no-go.** Phase 2 cleanup work stays closed until you explicitly say "Option A complete, proceed to Phase 2."

---

## Quick-skim summary

1. Wait for deploy live; I confirm `getDeploymentInfo()`.
2. Scan **prod** boot logs for the three error signals — all should be absent.
3. Run `check-schema-drift.ts` against prod; exit `0` required.
4. Run `post-publish-acceptance-check.ts` with `--since-restart <T0>` `--org da3ed822-8846-4435-bb13-3cc4bf26f71d` at T+15 / T+30 / T+60; exit `0` all three times.
5. I scan logs for `duplicate key value violates unique constraint` at T+15 / T+30 / T+60; zero matches required.
6. Operator UI flows: 5 on a primary account, 3 on two more high-value accounts.
7. Customers list: confirm you see your book correctly.
8. Record everything in `docs/option-a-publish-results-YYYY-MM-DD.md`.
9. **All checks pass → say "Option A complete, Platform RED → YELLOW."** Phase 2 cleanup remains closed.
10. **Any check fails → say what failed; do NOT declare success.** We triage.
