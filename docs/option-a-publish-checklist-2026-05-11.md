# Option A — Publish Operator Checklist

**One-page checklist for the Publish click.** Companion: `docs/option-a-self-serve-publish-audit-2026-05-11.md` (the audit), `docs/option-a-post-publish-checklist-2026-05-11.md` (what to run after).
**Status:** planning / read-only. **Do NOT click Publish until you have read this end-to-end and the diff matches "expected" below.**

---

## Pre-publish drift sanity — re-verified just now (read-only)

I just re-ran `tsx scripts/check-schema-drift.ts` against the live dev DB. Results, in plain language:

- `shared/schema.ts` (the source of truth) **already declares** the 58 prod-only tables (CRM, agent, copilot, document, prospect, webex enrichment, mailbox plumbing, etc.) and the 6 prod-only columns (`webex_user_tokens.{reauth_reason, last_reauth_email_at, scope_version, disconnected_at}`, `lane_coverage_profiles.created_at`, `threads.seed_kind`).
- The dev DB itself does **not** have those tables/columns yet — but that does not matter for publish, because publish reconciles **schema source ↔ prod**, not dev DB ↔ prod.
- **Net effect at publish time:** for those 58 tables + 6 columns, schema source agrees with prod → **no diff, no prompt, no change.** The rename ambiguity from the 2026-05-08 inventory is gone — both `reauth_reason` and `scope_version` are now declared side-by-side in source, so drizzle has no reason to ask "is this a rename?"

### Expected publish-time diff (additive only)

| Op type | Target | Source | Risk |
|---|---|---|---|
| `CREATE TABLE` | `company_financial_aliases` | Migration `0017` (Task #1051) | None — additive, empty in prod after create |
| `CREATE TABLE` | `user_lifecycle_events` | Migration `0018` (Task #1126) | None — additive, empty in prod after create |
| `ADD COLUMN` (nullable) | `users` (~13 cols: `is_active`, `is_service_account`, `is_demo`, `is_fixture`, `is_quarantined`, `deleted_at`, `deactivated_at`, etc.) | Task #1126 | None — nullable defaults |
| `ADD COLUMN` (nullable) | `companies` (~3 cols: `is_email_derived`, `email_derived_at`, `email_derived_seed_message_id`) | Task #1095 | None |
| `ADD COLUMN` (nullable) | `email_messages` (~3 cols) | Recent email-pipeline work | None |
| `ADD COLUMN` (nullable) | `account_contact_lane_pattern_responsibilities` (~5 cols) | Recent ACLPR work | None |

**Total: 2 `CREATE TABLE` + ~24 nullable `ADD COLUMN`. Zero DROPs, zero destructive renames.**

If the actual Publish UI shows you something materially different (more rows, any DROP / DELETE / DESTROY / "rename existing column" op), **STOP and tell me before clicking confirm.** That would mean the prod schema has drifted further since 2026-05-08 (someone manually pushed something) and we need to re-audit.

---

## Decisions you must make on each schema-diff screen

The Publish UI surfaces a schema diff with one row per proposed operation. Here is exactly how to handle each row type:

| Row type in the Publish UI | Decision | Why |
|---|---|---|
| `CREATE TABLE company_financial_aliases` | **Approve** | Additive, empty after create, drizzle source declares it |
| `CREATE TABLE user_lifecycle_events` | **Approve** | Additive, empty after create, drizzle source declares it |
| `ADD COLUMN <col>` on `users` / `companies` / `email_messages` / `account_contact_lane_pattern_responsibilities` (any of the ~24 columns above) | **Approve** | All nullable, all from Task #1126 / #1095 / pipeline work |
| `ADD COLUMN reauth_reason` or `ADD COLUMN scope_version` on `webex_user_tokens` | **Approve** | Should not appear (prod already has both per drift inventory). If it appears, it is still safe — additive nullable. |
| **Any** "Rename column X to Y?" prompt | **Choose "+ create new column"** — never "rename" | Renaming destroys the original column's data. The audit-confirmed safe path for the historical `webex_user_tokens.scopes_version` ↔ `reauth_reason` ambiguity is to keep both columns in prod side-by-side. (This prompt is now expected NOT to surface — but if it does for any column, the same rule applies.) |
| `ADD CONSTRAINT <fk_name>` | **Approve** | FK additions are non-destructive |
| `DROP TABLE <anything>` | **STOP — abort publish, tell me** | None of these are expected. Any DROP means the schema source has changed in a way the audit did not anticipate |
| `DROP COLUMN <anything>` | **STOP — abort publish, tell me** | Same reasoning |
| `DROP CONSTRAINT <anything>` | **STOP — abort publish, tell me** | Same reasoning |
| Any prompt with "DELETE", "DESTROY", "destructive", or red-coded text | **STOP — abort publish, tell me** | Out of scope for Option A |

---

## Hard STOP conditions (abort the publish, tell me)

Abort immediately if **any** of these are true at the moment you'd click "Confirm Publish":

- [ ] You see any `DROP TABLE`, `DROP COLUMN`, or `DROP CONSTRAINT` op.
- [ ] You see any "rename column" prompt and the alternative offered is not "+ create new column".
- [ ] You see more than ~30 total operations in the diff (the audit predicts exactly 26).
- [ ] You see operations on tables not in the expected list above (e.g. `ADD COLUMN` on `quote_opportunities`, `tasks`, `contacts`, `nba_cards`, etc. — none of those should appear).
- [ ] You see any operation on `webex_user_tokens` that is not a clean `ADD COLUMN`.
- [ ] The build fails to start (the Replit build screen shows a red error before the schema-diff prompt even loads).
- [ ] The build starts but the schema-diff prompt looks visually different from "list of additive operations" (e.g. it shows a red banner, a warning about data loss, or asks you to acknowledge a destructive change).

If any of those, **do not click Confirm.** Cancel the publish, paste me what you saw, and we replan.

---

## Step-by-step click sequence

1. **Confirm `CONTACT_JOBS_ENABLED=true`** (default) in prod env vars — no flip needed because there's no DB restore.
2. Tell me "ready to publish" — I will call `suggestDeploy()` to surface the Publish UI.
3. **Read the schema diff carefully.** Compare every row to the expected list above. If it matches → continue. If anything differs → STOP per the rules above.
4. **For each row in the diff, click "Approve" / "+ create new column" / etc. per the decision table above.** Do not click anything you have not pre-decided.
5. **Click "Confirm Publish".** Wait for build + deploy.
6. **Record the exact UTC deploy timestamp** here for the post-publish checklist's T0:
   `T0 = __________________________`
7. Tell me "deploy completed" — I will confirm `getDeploymentInfo()` returns `isDeployed: true` and `hasSuccessfulBuild: true`, then move you to the post-publish checklist.

**Single publish only.** Do not republish in the same window unless a hot-fix is required by the post-publish acceptance checks.

---

## Quick-skim summary

1. Drift re-verified: schema source already aligned with prod for 58 tables + 6 columns → **no rename prompt expected**.
2. Expected diff: **2 `CREATE TABLE` + ~24 nullable `ADD COLUMN`. Zero DROPs.**
3. Approve every `CREATE TABLE` and every `ADD COLUMN` in the expected set.
4. If a "rename" prompt appears anywhere, **choose "+ create new column"**, never "rename".
5. **STOP and tell me** if you see any DROP / DELETE / DESTROY / unexpected destructive op.
6. Single publish, record exact UTC deploy timestamp as T0, then move to post-publish checklist.
