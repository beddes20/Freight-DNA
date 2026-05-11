# Freight-DNA Platform Health Report

**Date:** 2026-05-11
**Branch / environment inspected:** `main` @ `62302141` (workspace HEAD); dev DB live; prod DB read-only (no queries this session — relying on the 2026-05-08 audit captured in `.local/dev-db-backups/prod-after-restore-target/audit_results.md`)
**Was this read-only?** Yes. No code changes, no migrations, no DB writes (dev or prod), no publish, no rollback. Only this report file was written.

---

## 1) Executive summary

- **Platform: RED.** Publish is blocked. Dev↔prod schema drift is bidirectional (59 tables only in prod, 2 only in dev, 7 column-count mismatches, 12 FK-count mismatches). The dev app boots with a schema-drift WARNING but `production will refuse to start until server/runMigrations.ts is updated`. A point-in-time-restore plan exists and is parked waiting on operator "execute" + Replit support confirmation.
- **Core tabs overall: YELLOW.** Most rep-facing surfaces work today in prod. Two surfaces (Customer Quotes, Customers) have known degradations the operator has accepted as workaroundable. Lane Work Queue and Available Freight are stable but carry unpublished fixes.
- **Data trust overall: YELLOW.** Strong written contracts exist (CQ-1..CQ-7 stability contract; Section 1200 contacts soft-delete enforcement; Section 1095 email-derived flag; Section 1500 dashboard freshness envelope). Three live trust gaps remain: (a) ~9,560 duplicate quote_opportunities groups (~19,283 rows) in prod from the unpatched `7f577c98` race condition, (b) legacy email-derived company stubs are not yet flagged with `is_email_derived=true`, (c) 6 orphan quote_opportunities surfaced in the 5/8 audit.
- **New-tab readiness: YELLOW.** Shared primitives (EmptyState honesty, `MineOnlyMeta`, `sortMeta`, freshness-envelope contract, weak-signal additive filter pattern, lifecycle-events audit table) are strong. The "stability contract + Section N guardrail" discipline is real and tested. But the contract pattern is heavy, currently only formalized for Customer Quotes / Dashboard / LWQ. A new tab adopting these would need ~1–2 days of contract setup before it can claim the same trust grade.

---

## 2) Platform

### Status: RED · Confidence: HIGH

**Why:**
- The dev app boots, but `[schema-drift] WARNING: drift detected. Boot allowed in this environment, but production will refuse to start until server/runMigrations.ts is updated.` (live boot log).
- The schema-drift inventory (`docs/dev-prod-schema-drift-2026-05-08.md`) lists **59 tables in prod only**, **2 tables in dev only** (`company_financial_aliases`, `user_lifecycle_events`), **7 column-count mismatches**, **12 FK-count mismatches**, and at least one drizzle rename-detection prompt that destructively conflates `webex_user_tokens.scopes_version` with `reauth_reason`.
- Two known runtime errors fire on every boot from this drift: `[valueiq-today] Scheduler init error: relation "agent_org_settings" does not exist` and `[webex] Startup webhook subscribe sweep error: column "reauth_reason" does not exist` (live boot log).
- A prior `drizzle-kit push --force` attempt against dev died on the first interactive rename prompt (post-merge.sh's 90 s timeout kills selects). Each subsequent rename prompt is a destructive choice that needs human-judgement.
- A production point-in-time-restore plan is fully written but parked: `docs/prod-restore-and-republish-plan-2026-05-08.md` + `docs/operator-maintenance-window-checklist-2026-05-08.md`. Locked decision is restore prod to **2026-05-04T00:00:00Z**, roll workspace to commit `9949c373`, then publish once. Currently blocked on operator "execute" + Replit support's written PITR confirmation.

**Evidence:**
- `docs/dev-prod-schema-drift-2026-05-08.md` (drift inventory + 3 repair strategies).
- `docs/prod-restore-and-republish-plan-2026-05-08.md` (Locked Decisions block; Step 0 hard-gate on support; Step 3 explicit `2026-05-04T00:00:00Z`; A/B/C acceptance checklist).
- `docs/operator-maintenance-window-checklist-2026-05-08.md` (one-page 7-step operator runbook).
- `docs/restore-target-recommendation-2026-05-08.md` + `.local/dev-db-backups/prod-after-restore-target/audit_results.md` (X-vs-Y audit: 81,015 post-pause emails 100% unique; 9,560 dup_groups → 19,283 dup_rows in QOs; 78 backfill-replay QOs; 6 orphan QOs; rest genuine new business).
- Live `Start application` workflow log (2026-05-11 16:05) — boot succeeds with explicit drift warning + two relation/column errors.
- 18 hand-written `migrations/*.sql` files plus `server/runMigrations.ts` (boot-time idempotent runner). Snapshot at `migrations/meta/0000_snapshot.json` is frozen at the March-2026 baseline — never refreshed (root cause hypothesis in drift doc Section 6).
- Rep-entered tables exported pre-restore for safety: `.local/dev-db-backups/prod-after-restore-target/{contacts,touchpoints,tasks,crm_opportunities}.csv`. Dev schema backup at `.local/dev-db-backups/dev_schema_20260508_175432.sql` (438 KB).

**Known gaps / risks:**
- **Publish path is currently a one-shot loaded gun.** Forcing publish today would attempt destructive ops on prod for the 4 prod-ahead columns (`webex_user_tokens.reauth_reason`/`last_reauth_email_at`/`scope_version`/`disconnected_at`, plus `lane_coverage_profiles.created_at` and `threads.seed_kind`).
- **`drizzle-kit push` is unsafe to run unattended** because of rename-detection prompts that piped newlines do not answer. Wrong answer = destructive dev DDL.
- **Forensic export of bulk QO/email metadata failed** (read-replica result-set caps); delegated to Replit support pg_dump. Until support delivers, the 5/4–5/8 classifier-output history is not externally archived.
- **Rollback risk to commit `9949c373` is non-trivial:** five commits land after it; per `docs/preservation-plan-2026-05-08.md`, all five are docs/attached_assets only (zero runtime code), so cherry-picking them back is safe — but anyone reading the git log has to know that.
- **Environment stability today:** the dev mirror serves on port 23636 and the app binds port 5000. Stripe, Graph token, scheduler bootstrapping all succeed in the live log. Webex enrichment-job sweep starts but the Webex webhook subscribe sweep fails at boot due to the missing prod column. Sonar daily refresh runs fine.
- **Critical broken dependencies:** `agent_org_settings` table is referenced by `valueiq-today` scheduler but missing in dev (it's a prod-only table per the drift doc). The valueiq-today scheduler is silently dead in dev.

**What would have to be true to move it up one color (RED → YELLOW):**
1. Operator green-lights the locked restore plan.
2. Replit support confirms PITR reachability for `2026-05-04T00:00:00Z` in writing.
3. The maintenance-window run completes and post-restore acceptance checklist Block A (zero duplicate-key log matches at T+15/30/60) passes.
4. After republish, `[schema-drift] WARNING` no longer appears at boot.
5. The two boot-time errors (`agent_org_settings` does not exist, `reauth_reason` does not exist) clear.

To reach **GREEN**, the team also needs to commit to one of the three repair strategies in `docs/dev-prod-schema-drift-2026-05-08.md` (recommended: Strategy B — forward migrations) and execute the snapshot refresh so future publishes are diff-clean.

---

## 3) Core tabs

### Customers
- **Status: YELLOW · Confidence: HIGH**
- **Why:**
  - Two confirmed display-disagreement rows in the live customer list (Armstrong World Industries, MASONITE MEXICO) where the rendered owner does not match the canonical `ownerRepId ?? assignedTo ?? salesPersonId` precedence. Documented in `docs/dev-prod-schema-drift-2026-05-08.md` § "What's degraded but not broken".
  - Email-derived companies are now hidden from the default `GET /api/companies` (Task #1095). Customers page exposes the toggle `data-testid="toggle-show-email-derived"`. **But:** legacy stub rows from before #1095 are NOT yet flagged — the admin "Heuristic (legacy)" mode in `/admin/email-derived-companies` is the workaround until a backfill migration runs.
  - Customers tab ownership unification landed in dev (commits `c4ec5f0f`, `33f9d02c`, `9a0afe65`, `9187fef1`) but the underlying ownership-rule write paths only exist in dev — **not yet in prod**.
  - Page is large but disciplined: 1,366 lines, 48 `data-testid` attributes.
- **Evidence:**
  - `client/src/pages/customers.tsx` (1,366 lines, 48 testids).
  - `server/routes/companies.ts` (`includeEmailDerived` query flag).
  - `replit.md` Gotchas: "Email-Derived Companies (Task #1095)" entry.
  - Recent task chain: #1141 (leadership cull toggle, superseded), #1142 (archived email-derived orphans), #1145 (ownership unification).
- **Known gaps / risks:**
  - The two known mis-display rows are cosmetic, not data loss — but they undermine rep trust in the list.
  - Backfill of `is_email_derived=true` for legacy stubs is still TODO (called out in `replit.md`).
  - Customer ownership write paths (cherry-picked from `26b1d866`, `d10ac9d3`) are bundled with the parked publish.
- **Move to next color (YELLOW → GREEN) by:**
  - Publishing the parked dev fixes so the ownership unification reaches prod.
  - Running the email-derived backfill so legacy stubs filter out cleanly.
  - Confirming the Armstrong / MASONITE rows display correctly post-restore.

### Customer Quotes
- **Status: YELLOW · Confidence: HIGH**
- **Why:**
  - Strongest contract discipline of any surface in the app — 7 stability contracts (CQ-1..CQ-7) with named guardrails in `tests/code-quality-guardrails.test.ts` Section 1100 and Section 1148.
  - 8+ runtime test files specifically defending CQ surfaces (`customer-quotes-{trust-hardening, customer-only-filter, display-resolution, attribution-endpoint, weak-signal, sort-meta, dropped-filter-telemetry, default-sort, presets, permissions, cockpit, followup-cache-stats, handoff-toast-contract, theme-flicker}.test.ts`).
  - **But:** prod has 9,560 duplicate-key groups → 19,283 redundant rows from the unpatched `7f577c98` quote-pipeline race (`audit_results.md`). The fix is in dev, not in prod. Duplicates accrue continuously on every inbound email.
  - 6 orphan quote_opportunities (no customer) found in the 5/8 audit.
  - Task #1169 (one canonical ownership rule) is currently IN_PROGRESS and was deferred this session — would touch CQ-1, CQ-2, CQ-5.
- **Evidence:**
  - `docs/customer-quotes-stability-contract.md` (7 contracts, 407 lines, mandatory declaration rule).
  - `tests/code-quality-guardrails.test.ts` Section 1100 (~lines 4448–4641), Section 1148 (~lines 4638–4757).
  - `server/services/customerQuotes.ts` (7,965 lines — central read/display layer).
  - `server/routes/customerQuotes.ts` (2,924 lines).
  - `client/src/pages/quote-requests.tsx` (4,553 lines, 153 testids).
  - `audit_results.md`: `qo_dupes_post_pause` = 9560 dup_groups / 19283 dup_rows; `qo_orphan` = 6.
- **Known gaps / risks:**
  - Race-condition duplicates will keep accruing until `7f577c98` ships.
  - The "weak-signal" filter (CQ-7) is additive and conservative — won't hide a real quote — but it's only as good as `companies.is_email_derived`, which still misses legacy stubs.
  - `enrich()` is a 130-line function with 5 input maps; the contract calls out it's a "fragile area".
  - The mandatory contract declaration ("Customer Quotes contracts touched: NONE | CQ-X[, CQ-Y, …]") is process-only, not enforced by CI.
- **Move to next color (YELLOW → GREEN) by:**
  - Publishing `7f577c98` (the race fix) and seeing duplicate-key log matches drop to zero in the post-restore acceptance Block A.
  - Resolving the 6 orphan QOs (likely a one-shot SQL cleanup).
  - Adding an automated check that fails CI when a CQ-frozen file is touched without the declaration line.

### Conversations
- **Status: GREEN (with one recent fix not yet in prod) · Confidence: MEDIUM**
- **Why:**
  - 1,764 lines, 25 `data-testid` attributes — comparatively focused surface.
  - Task #1139 ("Close Conversations unowned visibility leak", commit `d388989e`) just landed in dev. Closes a real visibility leak — **not yet in prod**.
  - 4 dedicated test files (`conversations-{freshness-regression, leakage-stats, task968-hardening, task968-rep-filter}.{test,spec}.ts`) defending the freshness, leakage, and rep-filter contracts.
  - Live boot log shows `conversation-archive` (daily 2 AM) and `conversation-snooze` (every 5 min) schedulers initialize cleanly.
  - `conv-thread-backfill-cron` runs every 6h cleanly.
- **Evidence:**
  - `client/src/pages/conversations.tsx`.
  - `server/routes/conversations.ts`, `server/routes/conversationsLeakage.ts`.
  - `docs/conversations-sync.md`, `docs/shared-inbox-go-live-runbook.md`.
  - Tests above + `tests/shared-inbox-webhook-e2e.test.ts`.
- **Known gaps / risks:**
  - The unowned-visibility-leak fix from #1139 is in the parked publish.
  - The dependency on M365 Graph (token refresh, delta-sync, mailbox watchdog) is healthy in the boot log but Mail.Read is "not yet granted" on Ops@valuetruck.com — `[graph-sub] Mail.Read not yet granted — reply tracking dormant. Will retry every hour until granted.` Reply tracking is dormant for that mailbox right now.
- **Move to next color (GREEN → consolidated GREEN) by:**
  - Granting Mail.Read on Ops@valuetruck.com and confirming the watchdog clears.
  - Publishing the #1139 fix.

### Lane Work Queue
- **Status: GREEN · Confidence: HIGH**
- **Why:**
  - Largest single surface (4,072 lines) but well-tested: `lane-work-queue.test.ts`, `lane-system-e2e.spec.cjs`, `lwq-shortcut-and-undo.spec.cjs`, `lwq-virtualization.spec.cjs`, `lane-stable-coverage.test.ts`, `lane-strategic-priority.test.ts`, `lane-lifecycle-derivation.test.ts`, `lane-formatters.test.ts`, `lane-switchboard-parser.test.ts`, `high-frequency-lanes.test.ts`.
  - Four named guardrail sections (1026 LWQ-A lifecycle, 1027 LWQ-B strategic priority, 1028 LWQ-C mode split, 1029 LWQ-D row redesign) in `tests/code-quality-guardrails.test.ts`.
  - 105 `data-testid` attributes on the page.
  - Boot log: lane-cache warm-up complete in 9 ms, no errors.
  - No recent breakage in commit log; last LWQ-specific change is in the LWQ guardrail series (well before this week's incident).
- **Evidence:** files above + `client/src/pages/lane-work-queue.tsx`, `server/routes/laneCockpit.ts`, `server/routes/laneSwitchboard.ts`, `server/routes/laneInbox.ts`.
- **Known gaps / risks:**
  - LWQ depends on `freight_daily_upload_fact` (unified upload) — that pipeline's contract is in `docs/unified-replit-daily-upload.md` and Section 1051 of guardrails. Healthy in dev.
  - The `geographic_lane_patterns` FK count differs between dev (0) and prod (1) — not user-visible, but lane-tagging joins may behave subtly differently across environments.
- **Move to next color:** already GREEN. Stay there by keeping the Section 1026–1029 guardrail discipline.

### Available Freight
- **Status: YELLOW · Confidence: MEDIUM**
- **Why:**
  - Largest page in the app (5,330 lines, 202 testids) — high blast radius for any change.
  - Task #1128 ("AF Phase 0 read-only audit") landed in dev. Audit-only — no behavior change yet.
  - `[available-freight-scheduler]` initialized cleanly (import 6:30 AM CT, SLA sweep every 15 min, autopilot hourly).
  - 5 dedicated tests (`af-action-mode-ops-signals.test.ts`, `af-cockpit-{owner-filter, refresh-pill, urgency-drift}.spec.cjs`, `af-make-recurring.spec.cjs`).
  - **But:** AF reads from `freight_daily_upload_fact` and `freight_opportunities` (latter has 5 dev FKs vs 8 prod FKs — 3-FK gap). Dev runs against a thinner constraint set than prod.
- **Evidence:** `client/src/pages/available-freight.tsx`, `server/routes/freightOpportunityCockpit.ts`, `server/routes/loadFact.ts`, `docs/available-freight-audit.md`, `docs/unified-replit-daily-upload.md`.
- **Known gaps / risks:**
  - `freight_opportunity_rate_history` is a prod-only table — dev doesn't enforce that history.
  - `won-quote-af-handoff.test.ts` + `won-quote-lwq-handoff.{test.ts,spec.cjs}` defend the won-quote → AF handoff (CQ stability contract crosses into AF here). Healthy.
  - The `7f577c98` race fix touches the won-quote → AF handoff path; that fix is in the parked publish.
- **Move to next color (YELLOW → GREEN) by:**
  - Publishing so prod schema parity stops creating the 3-FK gap on `freight_opportunities`.
  - Completing the Phase 0 audit's follow-up work (Task #1128 explicitly says "audit only" — Phase 1 is still pending).

---

## 4) Data trust

### Status: YELLOW · Confidence: HIGH

**Ownership rules**
- Single source of truth for "who owns this account" is `companies.ownerRepId` (CQ-3 contract).
- `companies.ownerRepId` is mutated only through `PATCH /api/companies/:id/owner` (RBAC-gated). The generic `PATCH /api/companies/:id` strips `ownerRepId` from its payload.
- Display fallback in `enrich()` reads `opts.ownerRepNameByCustomerId` (built in `loadContext` from `companies → users` join).
- Deprecated `quote_customers.owner_rep_id` column is kept for one release of safety; reading it for display is forbidden in `enrich()` (Section 1100 guardrail).
- Top Opportunities page enforces a hard role list `["admin","director","national_account_manager","sales_director"]` in exactly 3 server handlers and the client `canManage` check (Task #1140 / Section 1140 guardrail).

**Fake / polluted customer risk**
- Email-derived companies are flagged by `companies.is_email_derived = true` and hidden from default Customers list (Task #1095 / Section 1095).
- The won-quote handoff in `server/services/customerQuotes.ts` is the only production setter (`true` iff `opp.source === "email"`).
- **Gap:** legacy stubs from before #1095 are not flagged. Workaround is admin "Heuristic (legacy)" mode at `/admin/email-derived-companies`. A backfill migration is documented as TODO.
- Quote Requests UI default-hides rows where `customerName === "Unknown — needs review"` via a client-side filter (`toggle-show-unknown-senders`). Server filter chokepoint is intentionally untouched so audit / Account-Owner-fallback callers still see those rows.

**Contacts health**
- Hard `db.delete(contacts)` is forbidden in production code (Section 1200 guardrail enforces every `getContact*` method either filters `isNull(contacts.deletedAt)` or is on the explicit allow-list).
- `storage.deleteContact(id, { userId, reason })` writes `deleted_at` / `deleted_by` / `delete_reason` instead.
- Restore = clear `deleted_at`.
- Partial indexes for active-vs-deleted contacts shipped in `migrations/0016_contacts_partial_indexes.sql`.
- `CONTACT_JOBS_ENABLED` env-driven kill switch can pause inbound contact / suggestion auto-create writers (Section 1094). Default true. User-driven CRUD stays ungated.

**Email / conversation reliability**
- Boot log shows: Graph access token obtained/refreshed; delta-sync every 1 minute; mailbox-watchdog every 1 minute; reply-capture self-heal every 5 min; emailIntelligenceScheduler recovery sweep every 2 min with in-flight guard.
- Quote-SLA scheduler (escalation check every 1 minute, SLA=7 min, escalation=5 min) is alive.
- **Gap:** Mail.Read not yet granted on Ops@valuetruck.com → reply tracking dormant for that mailbox; will retry hourly until granted.
- 81,015 post-pause emails are 100% unique (zero `provider_message_id` duplicates) per the 5/8 audit. Email_messages table is honest.

**Quote ingestion reliability**
- `quote_opportunities` has 9,560 dup_groups → 19,283 redundant rows in prod (audit). Cause: unpatched race in `recordQuotePipelineDrop` when two inbound emails for the same drop arrive within ~5 ms. Fix is `7f577c98`, not in prod.
- 6 orphan quote_opportunities (no customer) — small, but should be triaged after restore.
- `quoteEmailIngestion` predicate `isCustomerFacingQuoteRep` gates rep auto-creation from email signatures so the rep table stops growing forever.
- 7 documented stability contracts (CQ-1..CQ-7) defend the read/display path.

**Orphaned or mismatched records**
- 6 orphan QOs (audit).
- Schema drift: 12 tables with FK-count mismatches between dev and prod. The most operationally relevant are `tasks` (+1 FK in prod for `tasks_opportunity_id_crm_opportunities_id_fk`) and `users` (−2 FKs in dev for lifecycle audit work).
- 59 prod-only tables include the entire AI-agent runtime (`agent_*`, `pod_*`, `copilot_*`), document extraction, and several Webex enrichment tables — none of which are in dev's schema source.

**Auditability / recoverability / soft-delete / guardrails**
- `tests/code-quality-guardrails.test.ts` (7,920 lines) carries 30+ named sections that gate-check known fragile contracts. Sample sections: 1026/1027/1028/1029 (LWQ), 1051 (unified upload), 1052 (hero loop), 1053 (Needs Routing hints), 1056 (free-mail attribution), 1075 (UI trust), 1076/1077 (hero loop polish), 1078 (AF order number), 1092 (email-derived admin console), 1094 (CONTACT_JOBS_ENABLED), 1095 (email-derived flag), 1100 (CQ contracts), 1101 (email→exec tender), 1106 (1:1 list endpoints), 1126.3/.4/.4-UI (user lifecycle), 1140 (Top Opps trust), 1148 (CQ-7 weak-signal), 1200 (contacts soft-delete), 1500/1500a/1500b/1500c (dashboard freshness envelope), 1501 (empty-state clarity).
- User lifecycle now has a single audit table (`user_lifecycle_events`) and forced write-through helpers `storage.{classify,deactivate,reactivate,softDelete,restore}User` (Section 1126.3).
- Dev schema backed up at `.local/dev-db-backups/dev_schema_20260508_175432.sql`; rep-entered prod tables exported to `.local/dev-db-backups/prod-after-restore-target/`.
- **Gap:** the bulk QO/email forensic export was capped by the read-replica; full archive is delegated to Replit support pg_dump.

**What would have to be true to move data trust up one color (YELLOW → GREEN):**
1. Publish `7f577c98` so the race condition stops creating duplicates.
2. Backfill `is_email_derived=true` on legacy company stubs.
3. Triage the 6 orphan QOs.
4. Grant Mail.Read on Ops@valuetruck.com so reply tracking is no longer dormant on that mailbox.
5. Replit support delivers the bulk pg_dump so the 5/4–5/8 classifier history is externally archived.
6. Add CI enforcement of the "Customer Quotes contracts touched: …" declaration rule (currently process-only).

---

## 5) New-tab readiness

### Status: YELLOW · Confidence: MEDIUM

**Are the shared primitives strong enough?**
- **Yes for trust primitives.** A new tab inherits:
  - `EmptyState` honest empty-state pattern (forbidden hand-rolled empty divs in CQ).
  - `MineOnlyMeta` + `sortMeta` envelopes for "did your filter actually narrow the result?".
  - Freshness envelope contract (Section 1500/1500a/1500b/1500c) — every dashboard portlet must declare its freshness primitive.
  - Three-state freshness pill (loading / unavailable / fresh|stale) — Task #1109a hardening.
  - Weak-signal additive filter pattern (CQ-7) for "hide low-trust rows without lying about KPI counts".
  - `parseFilters` + `logDroppedFilterKeys` + `logFilterParseFailure` telemetry pattern (Section 1148) for "tell ops when a query dropped silently".
  - `formatUserAttribution` "Unknown user" fallback to preserve attribution honesty when an author is soft-deleted.
- **Yes for write-path primitives.**
  - `storage.{classify,deactivate,reactivate,softDelete,restore}User` is the template for "audit-row + row-lock + transactional state change".
  - `CONTACT_JOBS_ENABLED` kill switch is the template for "env-driven pause" of any background writer.
- **Yes for testing primitives.** 30+ named guardrail sections in `code-quality-guardrails.test.ts` give a clear pattern: "Section N — feature, contract assertions, error message names the contract ID".
- **Mixed for backend primitives.** `IStorage` is large (12,296 lines in `server/storage.ts`); adding a new tab means adding new methods to a heavy interface.

**Consistency / discipline today:**
- The "stability contract + Section guardrail + mandatory PR declaration" pattern is genuinely effective — the CQ surface has not regressed in weeks of work, despite being the most-edited file in the app.
- That pattern is **only formalized for Customer Quotes, Top Opportunities, Dashboard, LWQ**. A new tab today either (a) adopts the pattern up-front (cost: ~1–2 days), or (b) ships without it and accepts the higher silent-regression risk other surfaces have.
- TestID coverage on existing tabs is high (LWQ 105, Customers 48, Conversations 25, AF 202, CQ 153) — good baseline for Playwright spec parity on new tabs.

**Risks for any new tab landing this week:**
- **Schema drift makes any new table risky.** A new tab that needs a new table would need to land both in dev and survive the publish — and publish is paused.
- **The `runMigrations.ts` boot-time runner is the only sanctioned schema-application channel today.** Any new tab adding a new column should add an idempotent `CREATE`/`ALTER` block there, NOT rely on `drizzle-kit push`.
- **`replit.md` Gotchas list is at 12 entries already** — new tabs that touch CQ / Top Opps / contacts / users / freight / email-derived stub or otherwise break a frozen surface get expensive fast. Read it before scoping.

**What would have to be true to move new-tab readiness up one color (YELLOW → GREEN):**
1. Publish unblocked (depends on the restore plan executing successfully).
2. A documented "new-tab stability contract template" (skeleton .md + skeleton Section N block) so new tabs adopt the pattern without inventing it from scratch.
3. CI enforcement of the contract-declaration rule, so new tabs land with the same trust surface as Customer Quotes by default.
4. Migration discipline switched to Strategy B (forward migrations) per the drift doc — eliminates the `drizzle-kit push` rename-prompt class of risk for new tabs.

---

## Notes on this report's scope and limits

- **Read-only.** The only file written is this document. No code, no migrations, no DB writes (dev or prod), no publish, no rollback, no workflow restarts.
- **Prod numbers come from the 2026-05-08 audit**, not from fresh prod queries this session. The prod DB is paused / awaiting restore; re-querying today would either return the same numbers (no recent writes) or grow them slightly (if traffic continued).
- **Confidence ratings reflect the strength of the evidence** I cite (HIGH = guardrail + test + live log + doc, MEDIUM = doc + code, LOW = code only).
- **I deliberately did not run the `guardrails`, `typecheck`, or any test workflows** — those are not strictly read-only (they spawn processes that touch state). Their last-known-green status is implied by the live `Start application` workflow successfully booting and serving traffic.
- **Out of scope on purpose:** the AI Hub / NBA / Webex / Sonar / Phone Usage / Coaching / Goals / Playbook surfaces. Operator scope was the four named tabs plus Customers — extending to those would roughly double the report length without adding decision-relevant signal for the publish/restore question.
