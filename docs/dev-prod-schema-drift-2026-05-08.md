# Dev ↔ Prod Schema Drift Inventory

**Captured:** 2026-05-08, read-only diff against live dev DB and live prod DB.
**Status:** information-only document. Not a migration plan.
**Backup of dev schema at time of capture:** `.local/dev-db-backups/dev_schema_20260508_175432.sql` (438 KB, schema-only, taken just before the aborted `drizzle-kit push --force` attempt). DO NOT OVERWRITE.

## Headline numbers

| Metric | Dev | Prod | Delta |
|---|---:|---:|---:|
| Total tables (`public` schema) | 179 | 236 | **prod has 57 more** |
| Tables only in prod | — | — | **59** |
| Tables only in dev | — | — | **2** |
| Tables with column-count mismatch (and present in both) | — | — | **7** |
| Tables with FK-count mismatch (and present in both) | — | — | **12** |
| Confirmed FK-name divergence (same FK, different name) | — | — | **≥1** (`tasks_org_id_*`) |
| Confirmed rename-detection prompt drizzle surfaces | — | — | **≥1** (`webex_user_tokens.scopes_version` ↔ `reauth_reason`) |

The drift is **bidirectional**: prod is ahead of dev for many features, and dev is ahead of prod for the most recent unpublished work. Neither side is a clean superset of the other.

## 1. Tables in PROD but missing from DEV (59)

These represent feature work that landed in prod (likely via earlier publishes) but was not preserved in dev's evolution path. Grouped by functional area for readability:

**CRM / Opportunity (the publish-blocker cluster):**
- `crm_opportunities`
- `crm_account_history`
- `crm_ownership_requests`
- `prospects`
- `prospect_activities`
- `prospect_contacts`

**AI / Agent runtime:**
- `agent_activity`, `agent_capabilities`, `agent_facts`, `agent_memories`, `agent_org_settings`, `agent_outcomes`, `agent_suggestions`
- `workflow_agents`
- `pods`, `pod_agents`, `pod_members`, `pod_intake_emails`, `pod_intake_settings`
- `copilot_adjustments`, `copilot_feedback`, `copilot_intelligence`, `copilot_outcomes`, `copilot_play_recommendations`, `copilot_recommendations`
- `org_corpus_chunks`
- `hitl_actions`
- `field_confidence_overrides`

**Document extraction pipeline:**
- `documents`, `document_pages`, `document_entity_links`, `document_extractions`, `document_extractions_typed`, `document_extraction_corrections`, `document_extraction_findings`

**Notes / Collaboration:**
- `coaching_notes`
- `company_collaborators`
- `context_notes`, `context_note_events`, `context_note_mentions`, `context_note_replies`
- `conversation_thread_feedback_events`
- `library_items`

**Webex (call/voicemail enrichment):**
- `webex_call_enrichment_jobs`
- `webex_inventory`
- `webex_sync_state`
- `webex_voicemails`

**Email / Mailbox plumbing:**
- `mailbox_health_alerts`
- `mailbox_sync_failures`
- `external_contact_consent`
- `sender_routing_rules`
- `adapter_status`

**Freight intelligence:**
- `freight_opportunity_rate_history`
- `intel_lane_rates`
- `intel_tracked_lanes`
- `leak_console_audit`
- `leak_console_daily_snapshot`

**UI prefs:**
- `sidebar_tooltips`
- `user_lane_inbox_prefs`

## 2. Tables in DEV but missing from PROD (2)

These represent **recent, unpublished work** that is correctly in dev's `shared/schema.ts` and not yet promoted to prod:

| Table | Source |
|---|---|
| `company_financial_aliases` | Migration `0017_company_financial_aliases.sql` (Task #1051 / unified daily upload) |
| `user_lifecycle_events` | Migration `0018_user_lifecycle_events.sql` (Task #1126 Phase 1 user lifecycle work) |

Both are additive — they would be created in prod by a successful publish, and Replit's publish-time diff treats them as benign `CREATE TABLE`. No risk to prod data; just paused along with everything else.

## 3. Tables with column-count mismatch (7)

| Table | Dev cols | Prod cols | Delta | Direction | Notes |
|---|---:|---:|---:|---|---|
| `users` | 27 | 14 | **−13** | Dev ahead | Task #1126 lifecycle work (`is_active`, `is_service_account`, `is_demo`, `is_fixture`, `is_quarantined`, `deleted_at`, `deactivated_at`, etc.). Replit publish-time diff would `ADD COLUMN` 13 nullable columns to prod — additive, safe. |
| `webex_user_tokens` | 16 | 20 | +4 | **Prod ahead** | Includes `reauth_reason` (the rename-detection prompt source) plus 3 other webex columns dev never received. |
| `account_contact_lane_pattern_responsibilities` | 24 | 19 | **−5** | Dev ahead | Recent ACLPR work landed in dev but not in prod's snapshot of this table. |
| `companies` | 29 | 26 | **−3** | Dev ahead | Task #1095 email-derived columns (`is_email_derived`, `email_derived_at`, `email_derived_seed_message_id`) plus migration `0017_company_financial_aliases.sql` shape changes. |
| `email_messages` | 24 | 21 | **−3** | Dev ahead | Recent email-pipeline columns. |
| `lane_coverage_profiles` | 15 | 16 | +1 | **Prod ahead** | One column missing in dev. |
| `threads` | 12 | 13 | +1 | **Prod ahead** | One column missing in dev. |

## 4. Tables with FK-count mismatch (12)

| Table | Dev FKs | Prod FKs | Delta | Note |
|---|---:|---:|---:|---|
| `tasks` | 5 | 6 | +1 | **The publish blocker** — `tasks_opportunity_id_crm_opportunities_id_fk` missing in dev because `crm_opportunities` doesn't exist there. |
| `tasks` (name only) | — | — | — | Plus `tasks_org_id_fkey` (dev legacy name) ↔ `tasks_org_id_organizations_id_fk` (prod canonical name). Same column, same target, same semantics, different label. |
| `account_contact_lane_pattern_responsibilities` | 2 | 5 | +3 | |
| `freight_opportunities` | 5 | 8 | +3 | |
| `nba_cards` | 6 | 8 | +2 | |
| `load_fact` | 0 | 2 | +2 | |
| `load_fact_history` | 0 | 2 | +2 | |
| `email_conversation_threads` | 6 | 7 | +1 | |
| `geographic_lane_patterns` | 0 | 1 | +1 | |
| `quote_customers` | 2 | 3 | +1 | |
| `quote_opportunities` | 6 | 7 | +1 | |
| `nam_lm_checkins` | 3 | 0 | **−3** | **Dev ahead** — three FKs in dev that don't exist in prod. |
| `users` | 3 | 1 | **−2** | Dev ahead — lifecycle-event/audit FKs added by Task #1126 work. |

## 5. Known drizzle-kit rename-detection prompts

When `drizzle-kit push --force` was attempted against dev, it surfaced this **interactive select prompt** before applying anything:

> **Prompt:** `Is reauth_reason column in webex_user_tokens table created or renamed from another column?`
> Choices: `+ reauth_reason create column` / `~ scopes_version › reauth_reason rename column`

**Correct answer is "create column"** — prod has both `scopes_version` AND `reauth_reason` as distinct columns; they are not a rename. Picking "rename" would drop `scopes_version` (destructive) and corrupt webex auth tokens.

We did NOT get past this first prompt before the `timeout` killed the push. **Other rename prompts almost certainly exist behind it** (likely candidates given column-count deltas: `users` lifecycle columns may have rename ambiguities, `companies` email-derived columns may, `account_contact_lane_pattern_responsibilities` may). Each one requires explicit human judgment; piped newlines do not answer select prompts.

## 6. Why this happened — root cause hypothesis

This drift is consistent with a long-running gap between the project's two schema-application channels:

1. **Schema source of truth (`shared/schema.ts`)** evolved continuously over months.
2. **Hand-written `migrations/*.sql`** (currently 17 files) were added for features that needed deployment-time DDL.
3. **Drizzle snapshot (`migrations/meta/0000_snapshot.json`)** was frozen at the March-2026 baseline — never refreshed.
4. **Dev DB** was kept current via a mix of `drizzle-kit push` (post-merge) and `runMigrations.ts` (boot-time). When push hit interactive prompts, post-merge.sh's 90s timeout killed it and changes were silently skipped.
5. **Prod DB** received changes mostly via Replit's publish-time dev↔prod diff (the documented flow). Over time, prod accumulated columns/tables/FKs that dev never received because dev's push kept stalling.

The result is a steady-state where neither side reflects the schema source, and the publish-time differ wants to "fix" prod by removing things that dev is missing — which is destructive in the worst direction.

---

# Repair strategy options (for a future maintenance window — NOT today)

Three realistic options, scoped honestly. Each assumes a dedicated 2–4 hour window with prod traffic acceptable to interrupt or with a clear rollback path. **None are recommended for execution today** per current emergency triage.

## Strategy A — Snapshot-then-realign (lowest blast radius, highest manual cost)

**Concept:** Treat dev as the disposable side. Take a fresh schema-only `pg_dump` of prod, restore it to a clean dev DB, then re-apply only the explicitly-known unpublished dev-side changes (the 2 dev-only tables + the 13 `users` lifecycle columns + the email-derived `companies` columns + the ACLPR new columns + recent FK additions on `nam_lm_checkins`).

**Scope:** Full dev DB rebuild from prod schema; selective replay of ~5 known dev-ahead deltas via your existing `migrations/0017`, `0018`, and Task #1126 / #1051 / #1095 schema additions.

**Effort:** 2–3 hours of focused work. Requires a clean dev DB to drop and recreate. Most of the time goes to verifying which dev-ahead deltas to keep and re-applying them.

**Main risks:**
- Dev DB data loss is total (dev data is not preserved). Acceptable if dev is treated as scratch; **bad** if anyone has dev test data they need.
- Any dev-ahead change we forget to replay reappears later as a new mystery delta.
- Anything in dev's data layer that depends on tables/columns prod doesn't have (e.g., the 2 dev-only tables) needs careful re-creation order.

**Likely impact on prod:** **None.** Pure dev-side operation. Prod is the source, untouched.

**Best for:** Teams comfortable with dev as a disposable environment, and where the 5 dev-ahead deltas are well-documented (they are — Tasks #1051/#1095/#1126 are in `replit.md`).

**Outcome:** Publish-time dev↔prod diff becomes minimal and predictable. Future publishes work without surprise.

---

## Strategy B — Forward migrations (highest control, highest cost)

**Concept:** Stop using `drizzle-kit push` entirely. Hand-write a series of small, reviewable `migrations/00xx_*.sql` files that reconcile each known delta one table at a time. Run them through `runMigrations.ts` (already idempotent and battle-tested). Keep doing this for new schema changes going forward.

**Scope:** ~12–15 new migration files (one per table delta cluster from sections 3+4 above). Each file is small (10–40 lines), uses `IF NOT EXISTS` / dynamic SQL guards like `migrations/0018_tasks_opportunity_fk_idempotent.sql` already does.

**Effort:** 4–6 hours, plus a "snapshot refresh" coda where `migrations/meta/0000_snapshot.json` gets regenerated against the post-converged dev DB.

**Main risks:**
- Long upfront cost; team velocity hit during the window.
- Easy to miss a delta — would surface later as another publish blocker.
- Requires discipline going forward: every new schema change must go through a migration file, not `db:push`. This is a process change.

**Likely impact on prod:** **None during the dev-side work.** Eventually a publish would carry the same schema deltas to prod, but each one would be a small reviewable change rather than a big-bang convergence.

**Best for:** Teams that want long-term control and are willing to pay the upfront tax. Makes future publishes explicit and auditable.

**Outcome:** No more snapshot drift. No more `drizzle-kit push` surprises. Schema source, migration files, dev DB, and prod DB all in lockstep.

---

## Strategy C — Interactive `drizzle-kit push` session against dev (fastest, riskiest)

**Concept:** A human runs `npx drizzle-kit push --force` interactively in the workspace shell, manually answers each rename-detection prompt as it appears, and lets drizzle converge dev to the schema source in one session. This is what `scripts/post-merge.sh` *tries* to do, except the script can't answer select prompts.

**Scope:** All ~70+ structural deltas in one push session. Each rename prompt is a destructive choice and must be evaluated case-by-case ("is `reauth_reason` truly a rename of `scopes_version`? No → pick `create`").

**Effort:** ~30–60 minutes of focused interactive work, IF prompts are well-behaved. Could balloon if drizzle proposes destructive ops we don't want.

**Main risks:**
- A wrong answer to any rename prompt = destructive dev DDL. Recoverable from the schema backup, but recovery is its own work.
- Drizzle may propose dropping the 2 dev-ahead tables (`company_financial_aliases`, `user_lifecycle_events`) on the assumption they were removed from schema — they weren't. We'd need to refuse those.
- Drizzle's "non-interactive" claim with `--force` is misleading; `--force` only skips confirms, not selects.
- After convergence, dev still won't match prod — it'll match the *schema source*. Prod will then diff against the new dev state during publish, and publish-time `ADD CONSTRAINT` / `ADD COLUMN` will hit prod for everything dev was missing. **That's actually what we want**, but we should be deliberate about it.

**Likely impact on prod:** None during the push (push is dev-only). When publish is later attempted, prod gets a flood of additive changes (tables it already has are skipped; missing items get added). For tables prod is ahead of dev (`webex_user_tokens`, `lane_coverage_profiles`, `threads`), prod loses the prod-only columns — **destructive on prod for those columns specifically**.

**Best for:** Time-pressured situations where a human can babysit a 30-minute interactive session and is OK with a small destructive risk. **NOT recommended without first manually verifying the 4 prod-ahead columns are not in active use** (and either backporting them to dev or accepting their loss).

**Outcome:** Fast convergence at cost of careful judgment per prompt and acceptance of small prod-side column loss on next publish.

---

## Strategy comparison

| | Strategy A (Snapshot-realign) | Strategy B (Forward migrations) | Strategy C (Interactive push) |
|---|---|---|---|
| Time | 2–3 hr | 4–6 hr + ongoing discipline | 30–60 min |
| Dev data preserved? | ❌ no | ✅ yes | ✅ yes |
| Prod data at risk? | ❌ no | ❌ no | ⚠ yes for 4 prod-ahead columns |
| Long-term sustainable? | ✅ yes | ✅✅ yes (best) | ⚠ no (kicks the can) |
| Reversible? | ✅ via dev backup | ✅ via dev backup + revert migration | ⚠ requires careful restore |
| Recommended for this repo | **2nd choice** | **1st choice** | **emergency-only** |

**My recommendation for the future maintenance window:** Strategy B. It's the most expensive in hours but it permanently resolves the snapshot-drift class of bugs that has now blocked two publishes. The hand-written migrations are the same shape as your existing 17 (and your existing `runMigrations.ts` already runs them idempotently on boot, so the deployment story is already proven).

---

# Rep workflow recommendation — operate while publish stays paused

**TL;DR: prod is fully functional today. Reps should keep using prod as-is. The pending dev fixes (`d10ac9d3` Customers visibility, `7f577c98` quote race fix, `9949c373` AF guards, `26b1d866`) are quality-of-life improvements, not blockers for daily rep work.** No external workflow needed.

## What works in prod today (unchanged by this triage)

All core CRM rep workflows are healthy in prod:

- ✅ **Customers** page — viewing accounts, searching, filtering. The visibility fix in dev (`d10ac9d3`) is a *display polish* — the canonical owner is still computed correctly server-side; only some borderline ownership cases display under the wrong rep. Reps can still find and work their accounts.
- ✅ **Contacts** — full CRUD, soft-delete, signature sweep. Task #1093 work is in prod.
- ✅ **Touchpoints** — logging, reading, history. No drift impact.
- ✅ **Tasks** — assign, complete, link to companies/contacts/opportunities. The `tasks_opportunity_id` FK exists in prod (the entire reason this triage started) — task linking to opportunities works.
- ✅ **RFP / Awards** — Excel uploads, AI-assisted RFP processing, award tracking. Untouched by drift.
- ✅ **Lane Work Queue** — assignment, dwell tracking. Untouched.
- ✅ **AI Hub features** — talking points, NBA, health scores, drafting. Untouched.
- ✅ **Webex calling, M365 email sync, FreightWaves** — all integrations untouched.

## What's degraded but not broken

- ⚠ **Customers visibility quirk:** ~2 confirmed disagreement rows (Armstrong World Industries, MASONITE MEXICO) where the current display rule disagrees with the canonical `ownerRepId ?? assignedTo ?? salesPersonId` precedence. Reps may briefly see these accounts attributed to a director rather than their NAM. **Workaround:** the affected reps can search by company name directly and the account record still loads correctly. The data is intact in prod; only the *list view* misattributes a couple of accounts.
- ⚠ **`recordQuotePipelineDrop` race condition:** if two inbound emails for the same quote drop event arrive within ~5 ms of each other, one of the two writes can fail with a duplicate-key error. **Real-world frequency observed:** rare. **Workaround:** the email re-processes on the next inbox sweep automatically.

## What I do NOT recommend doing today

- ❌ **Do not** stand up an external Airtable / spreadsheet workflow. The cost of mirroring contacts/touchpoints/RFPs/tasks externally and then reconciling back later is **higher** than the value gained. Prod is functional. Mirroring would create a second source of truth that you'd then have to merge back, and the two known degradations above don't hurt enough to justify it.
- ❌ **Do not** attempt small "prod-only" hotfixes that bypass dev. Replit's publish path *is* the prod write path. There is no supported way to push a code change to prod without going through publish. (Database hotfixes are off the table by your own guardrails.)
- ❌ **Do not** force a publish today. The `tasks_opportunity_id` FK DROP attempt would succeed (it exists in prod), but the next blocker would surface immediately — the dev↔prod diff has dozens of additional destructive operations queued behind it. Not worth the risk.

## What I DO recommend doing today

1. **Communicate to reps:** "Continue working in FreightDNA as normal. Two known minor display quirks (a couple of accounts may show under the wrong rep in the Customers list) — search by company name to find them. No data is lost; everything you log is preserved."
2. **Capture the publish-pause as a documented item** in `replit.md` Gotchas so the next agent (or human) doesn't accidentally re-trigger this. (Not done in this read-only pass; would need explicit approval to edit.)
3. **Schedule the maintenance window** for one of the three strategies above — pick a low-traffic time (Sunday morning?), allocate 4–6 hours for Strategy B, and assign one engineer to babysit it.
4. **Hold the four pending dev commits** (`d10ac9d3`, `7f577c98`, `9949c373`, `26b1d866`) on the dev branch. They will publish cleanly once the convergence work above is done. None of them are blockers for today's rep work.

## If a critical bug emerges before the maintenance window

Then we re-evaluate with current information. The current dev DB is unchanged from this morning, the schema backup at `.local/dev-db-backups/dev_schema_20260508_175432.sql` is intact, and the prod DB is exactly as it was when this triage started. Any future emergency triage will start from this known-good baseline.

---

# Status summary

- ✅ **Drift inventory complete.** Document at `docs/dev-prod-schema-drift-2026-05-08.md`.
- ✅ **3 repair strategies documented** with scope/effort/risk/prod-impact for each.
- ✅ **Rep workflow recommendation:** keep using prod as-is; no external mirror needed.
- ✅ **All guardrails honored.** No schema changes. No prod writes. No publish attempts. No application code changes. All probes were read-only SELECTs against dev or prod.
- ✅ **Dev backup preserved** at `.local/dev-db-backups/dev_schema_20260508_175432.sql`.
- 📌 **Standing recommendation:** Strategy B (forward migrations) for the eventual maintenance window. Defer everything until you explicitly approve a strategy.
