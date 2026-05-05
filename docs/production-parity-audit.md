# Production Parity Audit — Freight DNA

**Audit date:** 2026-05-05
**Scope:** Currently-active production-facing surfaces (sidebar `status: "active"`).
**Method:** Read-only code inspection of frontend pages, server routes, storage methods, DB schema, and tests/guardrails. Cross-checked against recent merges (Tasks #1051, #1052, #1053, #1055, #1060) and the live deployment that was republished today after the Schema-Drift Guard fix.
**Author note:** Brutally honest. Where I'm uncertain, I label it. No `LGTM` for things I didn't actually verify.

---

## TL;DR

- **What's real:** ~90% of the production-facing surface area is genuinely wired end-to-end. The Dashboard, 1:1's, Tasks, Goals, Team Performance (post-#1060), Customers, Customer Quotes, Conversations, Available Freight, Lane Work Queue, Available Loads, Financials, and the admin operability tools (Integrations Health, Webex Health, Endpoint Perf, Monitored Mailboxes, FC Rep Audit, POD Intake, Freight Import Health) are backed by real DB reads/writes against real tables.
- **What only looks real:** A small but real set of "UI affordance with no backend" or "silent stub inside a try/catch" issues. None are catastrophic — but several are exactly the kind of thing that erodes trust because they look like they work.
- **What's trustworthy now:** the merged email-ingest contract (DROP-GATE → PERSIST-UNKNOWN, Section 30), the Customer Quotes stability contract (CQ-1..CQ-6, Section 1100), and the Unified ReplitDailyUpload (Section 1051). All three have guardrails that fail the build on regression.
- **Biggest belief-vs-reality gaps** (full list in §4):
  1. `/api/1on1/prep-summary` returns `openTopics: 0` hardcoded inside a try/catch (silent failure).
  2. `Forward task` UI exists in `task-dialog.tsx` but the server route `/api/tasks/:id/forward` is **not implemented** → 404.
  3. The Team Performance drill-down endpoint silently ignores the `scope` query param and always re-derives the caller's tree (right answer for "Mine", wrong answer for "All Teams").
  4. Auto-completed goals do not revert to "active" when a manual value is corrected downward.
  5. `test:freight-capture-funnel` and `test:lane-system-e2e` have been failing on the main branch for multiple cycles. Either fix them or formally retire them — green CI is currently a lie for those two suites.
- **Recommended remediation order:** see §6.

---

## 1. Inventory — currently-active production surfaces

This is the set rendered for at least one role in `client/src/lib/nav-items.ts` with `status` defaulted (`"active"`). Surfaces marked `admin_preview` are intentionally hidden from non-admins and shown disabled to admins ("In development") — they are catalogued in §5 but excluded from the parity matrix below because they are not promised to users.

**Top-level (everyone):** Dashboard, 1:1's, Tasks, Goals, Team Performance.

**Customer-facing group:** Lane Intelligence, Customers, Customer Quotes, Top Opportunities, RFP & Awards, Contact Suggestions, Conversations.

**Carrier-facing group:** My Procurement, Lane Work Queue, Available Freight, Available Loads, LM Check-In Log, Conversations.

**Admin group:** User Management, Carrier Catalog, Monitored Mailboxes, FC Rep Audit, POD Intake, Freight Import Health, Carrier Intel Admin, Webex Health, Integrations Health, Endpoint Perf, Financials, Lane Analytics, Coordinators Corner, PTO Passoff, Touchpoint History, Sidebar Tooltips, Feedback Inbox, Notifications.

**Total active surfaces:** 36. **Total admin-preview (incubating) surfaces:** 20 — see §5.

---

## 2. Parity Matrix — Intended vs Actual

Legend:
- 🟢 **REAL** — wired end-to-end, real DB read/write, evidence cited.
- 🟡 **PARTIAL** — works for the headline use case but has a documented gap, edge case, or silent fallback.
- 🔴 **BROKEN/MISLEADING** — visible affordance whose backend is missing, returns hardcoded data, or is currently failing.
- ⚪ **INCUBATING** — `admin_preview` (hidden from users); excluded here, listed in §5.

### 2.1 Top-level rep surfaces

| Surface | Intent | State | Primary code path | Evidence | Gap |
|---|---|---|---|---|---|
| **Dashboard** `/` | Role-aware home: tasks, NBA cards, trending accounts, summary KPIs, today's-5, award health | 🟢 REAL | `client/src/pages/dashboard.tsx`, `server/routes/dashboard.ts` | All widgets back to real Drizzle queries; NBA panel suppresses legacy portlets when cards exist (`dashboard.tsx:404`) | Heavy use of `?? 0` / `?? []` in `dashboard.tsx:225-227` masks empty-state vs API failure; `streak` lookback hardcoded 60d (`dashboard.ts:1311-1330`); "Trending Accounts" returns `[]` when there's no upload, indistinguishable from "0 delta" |
| **1:1's** `/one-on-one` | Manager↔IC sessions, topics, replies, action items, dev goals, AI summary, recap email | 🟡 PARTIAL | `client/src/pages/one-on-one.tsx` + `one-on-one-portlet.tsx`, `server/routes/coaching.ts`, storage `OneOnOne*` methods | Sessions, topics, replies, dev goals, action items all real; AI summary uses GPT-4o-mini; access gated by `canAccessCoachingPair` (Task #525) | `GET /api/1on1/prep-summary` returns `openTopics: 0` hardcoded inside the try block (`coaching.ts:448`) — silent stub. The card looks live but the count is always zero. |
| **Tasks** `/tasks` | Personal task list: create, assign, complete, comment, due dates, lane procurement linkage | 🟡 PARTIAL | `client/src/pages/tasks.tsx`, `task-dialog.tsx`, `server/routes/tasks.ts`, storage `Task*` methods | Real CRUD, real notifications on create/assign/complete/comment, real `task_comments` (threaded), real `attached_lane_data` for procurement, `bump` notifications gated to ≥2 days overdue | (a) `task-dialog.tsx` calls `POST /api/tasks/:id/forward` (lines 49, 267) but **no server route exists** in `tasks.ts` — 404 on click. (b) No recurring-task engine despite recurrence implied by procurement flow. (c) `dueDate` stored as `text` YYYY-MM-DD — no time precision, "due soon" is day-grain. |
| **Goals** `/goals` | Personal + team goals with auto-tracked KPIs (margin, loads, contacts, touchpoints) | 🟡 PARTIAL | `client/src/pages/goals.tsx`, goals routes, `server/financialHelpers.ts`, `goal_comments` table | Real goal CRUD, real bulk-create for managers, real auto-progress for 6 metric types (margin/loads_booked/margin_pct from financial_uploads, contacts_added/touchpoints/meaningful from CRM tables), real goal-comment threads + notifications, leaderboard (`/api/goals/leaderboard`) | (a) Auto-complete does NOT revert to "active" if a manually-corrected value drops below target. (b) No historical snapshot table — progress is recomputed on the fly, so "what was it at month-end?" can't be answered after the next upload. (c) Margin tracking silently falls back to "manual mode" if `users.financialRepId` doesn't match the Excel column (`goals.tsx:104` `isEffectivelyManual`) — the user sees no warning. |
| **Team Performance** `/team-performance` | Per-rep KPIs, leaderboards, financial rollups, drill-downs (post-Task #1060: open to all roles with My Team / All Teams toggle) | 🟡 PARTIAL | `client/src/pages/team-performance.tsx`, `server/routes.ts:3540` (list), `:3641` (detail), `storage.getTeamPerformance` | All KPI cards (open tasks, overdue, accounts, new contacts, relationships moved, calls/texts/emails, touched, meaningful, total loads, total margin) computed from real `tasks`/`contacts`/`touchpoints`/`financial_uploads`. Scope toggle (mine/all) works end-to-end. `teamMappingMissing` empty-state correctly fires for ICs with no manager and no reports. `tests/team-performance-access.test.ts` 7/7 pass. | The drill-down endpoint `GET /api/team/performance/detail/:metric` does NOT read the `scope` query param — it always re-derives the caller's tree (`server/routes.ts:3674`). When the user switches the page to "All Teams" and clicks a card, the drill-down shows the wrong rep set. This is a real bug introduced by #1060. |

### 2.2 Customer-facing surfaces

| Surface | Intent | State | Primary code path | Evidence | Gap |
|---|---|---|---|---|---|
| **Lane Intelligence** `/research-tasks` | Research lanes from RFPs, mark researched | 🟢 REAL | `client/src/pages/research-tasks.tsx`, `server/routes.ts:1936` | Real `rfps` table query | None observed |
| **Customers** `/customers` and `/companies/:id` | Account list, profile, ownership, financials, AI insights, talking points, health score, lanes, opportunities, quotes, touchpoints, contact suggestions | 🟢 REAL | `client/src/pages/customers.tsx`, `company-detail.tsx`, `OverviewTab.tsx`, `IntelTab.tsx`, `OpportunitiesTab.tsx`; `server/routes/companies.ts`; `server/growthScoreCalculator.ts` | Health score is computed from real signals (touchpoint recency 40pts + relationship depth 18pts + volume 12pts + lane breadth 10pts, with risk penalties). AI talking points are real LLM calls (`POST /api/companies/:id/health-narrative`, 15-min cache). Owner attribution flows through the canonical `companies.ownerRepId` (Task #1011, CQ-3). Touchpoint history is real. | Financials match is fuzzy on `financialAlias` — accounts with aliases not captured will silently show $0 ("looks like the customer has no business with us" when in fact the join failed). Worth surfacing as a per-account warning. |
| **Customer Quotes** `/customer-quotes` and `/quote-requests` | Quote-request queue (Mine/All, Customers/Carriers, Needs Routing, Auto-Routed); detail drawer; mark outcome (won + 4 loss reasons); routing UI; hints panel; pipeline-drops admin console | 🟢 REAL | `client/src/pages/quote-requests.tsx`, `server/services/customerQuotes.ts` (locked by CQ-1..CQ-6), `server/routes/customerQuotes.ts`, `quote_pipeline_drops` table | Section 1100 of guardrails is green (1071 pass). Mine-only honest empty-state + banner work. AI auto-routing creates the `quote_opportunities` row immediately and tags `routing_status` (Confirm & Create flips status). Hints panel reads `quote_opportunities.quote_hints` (Task #1053). Pipeline drops are captured for `classifier_miss / unparseable / duplicate / exception`. | (a) `attachResponseTimes` in `customerQuotes.ts` runs a per-row subquery against `email_messages` to derive first-reply latency — fine at current volume but won't scale; cache or terminal-snapshot is the long-term shape. (b) The `Mine only` semantic for `Needs Routing` uses `ILIKE to_email/cc_email` (`customerQuotes.ts:2510`) instead of the `quote_reps` mapping the main list uses — same label, different definition. (c) `mark-outcome` idempotency relies on the application returning `'already_terminal'` rather than a DB unique constraint on terminal events — race-condition-shaped. |
| **Top Opportunities** `/top-opportunities` | High-value opps ranked by potential | 🟢 REAL | `client/src/pages/top-opportunities.tsx`; `/api/opportunities` | Hot-zone ranking against historical delivery volume + RFP origins | None observed |
| **RFP & Awards** `/rfp-awards` | RFP CRUD, award conversion, procurement task generation | 🟢 REAL | `client/src/pages/rfp-awards.tsx`; `/api/rfps`, `/api/awards` | Full CRUD, lane parsing, RFP→Award conversion | None observed |
| **Contact Suggestions** `/contact-suggestions` | Suggested new contacts learned from inbound email | 🟢 REAL | `client/src/pages/contact-suggestions.tsx`; `/api/internal/accounts/suggestion-counts`, `account_contact_suggestions` table (Task #742, expanded by #1055 signature parser) | Real accept/ignore actions. Signature parser (Task #1055) feeds this as a soft fallback — 23/23 tests pass | None observed; Task #1063 (proposed) would add a quick-review queue specifically for #1055-derived suggestions |
| **Conversations** `/conversations` | Org-scoped inbox: Customers / Carriers / Mine / All / Snoozed / Archived; thread detail; AI summaries; suggested actions; reply UI | 🟢 REAL | `client/src/pages/conversations.tsx`, `ThreadDetailPane.tsx`; `server/routes/conversations.ts`; `email_conversation_threads` + `email_messages` + `conversation_thread_summaries` tables | "Customers" filter = `linkedAccountId IS NOT NULL` and "Carriers" = `linkedCarrierId IS NOT NULL` (storage.ts:9050) — counts are honest post the DROP-GATE → PERSIST-UNKNOWN P0 fix (replit.md). AI summaries cached by `contentHash` and refreshed by background worker (Task #751). Suggested actions are deterministic-rules + LLM-refined and dispatch to real handlers (e.g. `quote_request_reply` opens carrier-capacity reply modal). `tests/shared-inbox-webhook-e2e.test.ts` 33/33 pass. | Acknowledged residual "leakage" risk: unstructured-text carrier rate quotes in messages without an attachment are still sometimes missed by the deterministic regexes and rely entirely on LLM fallback (`emailIntelligenceService.ts:167`). This is a known, accepted tradeoff. |

### 2.3 Carrier-facing surfaces

| Surface | Intent | State | Primary code path | Evidence | Gap |
|---|---|---|---|---|---|
| **My Procurement** `/my-procurement` | Personal lane-procurement work queue | 🟢 REAL | `client/src/pages/my-procurement.tsx`; `/api/recurring-lanes/my-procurement` | Shared selection hooks; real `recurring_lanes` reads | None observed |
| **Lane Work Queue** `/lanes/work-queue` | Strategic / outreach / triage / admin modes; ≥6/30d eligibility from unified upload (Task #1051) | 🟢 REAL | `client/src/pages/lane-work-queue.tsx`; `/api/recurring-lanes/work-queue` | Section 1051 guardrail green (engine reads `summarizeEligibleLanesFromFact`, no legacy 8-week rule, 7-day grace via `last_eligible_at`). LWQ row exposes qualification chip + supporting customers + recent carriers. `UnifiedUploadFreshnessPill` mounted | `test:lane-system-e2e` is failing 4/15 (cross-tab SSE assignment + Shift+L cockpit keyboard). Reproducible failure means the SSE/cockpit code paths are real but actively regressed. |
| **Available Freight** `/available-freight` | Open freight triage cockpit | 🟢 REAL | `client/src/pages/available-freight.tsx`; `/api/freight-opportunities`; `freight_daily_upload_fact` (Task #1051) | Workflow OS shared selection; freshness pill mounted; AVL rows forced to `moved=false` | Same `test:lane-system-e2e` failures touch this surface (Shift+L cockpit) |
| **Available Loads** `/carrier-intelligence/available-loads` | Open loads with top-3 carrier suggestions + target buy rate | 🟢 REAL | `client/src/pages/carrier-intelligence-available-loads.tsx`; `CarrierIntelligenceScoringService` | Fit-first ranking with org-tunable lane-fit floor (replit.md), customer-only fallback bucket | None observed |
| **LM Check-In Log** `/lm-checkin-history` | Logistics-manager check-in history | 🟢 REAL | `client/src/pages/lm-checkin-history.tsx`; `/api/internal/lm-checkin-history` | Reads `lm_checkin_history` | None observed |

### 2.4 Admin surfaces

All 18 admin items are 🟢 REAL — each backed by a real route and real query. Highlights:

| Surface | Notable evidence |
|---|---|
| **User Management** `/admin/users` | Full CRUD + role mgmt (Task #815) + bulk CSV |
| **Carrier Catalog** `/admin/carriers` | Lists carriers with sourcing perf via `CarrierIntelligenceScoringService` |
| **Monitored Mailboxes** `/admin/monitored-mailboxes` | Graph subscription mgmt (#230/#997), per-mailbox health, backfill triggers |
| **FC Rep Audit** `/admin/freight-capture-rep-audit` | Triage tool linking string "Rep" names from email to user accounts |
| **POD Intake** `/admin/pod-intake` | AR-mailbox pipeline (#589), unmatched-order linking, re-forwarding |
| **Freight Import Health** `/admin/available-freight/imports` | `load_fact` health monitor (#1041) |
| **Carrier Intel Admin** `/admin/carrier-intelligence` | Backfill, parity reports, manual refresh |
| **Webex Health** `/admin/webex-health` | Webex webhook subs + phone mappings |
| **Integrations Health** `/admin/integrations-health` | Live status of SONAR / Graph / Webex / ZoomInfo / OneDrive / TRAC / Stripe (#710) |
| **Endpoint Perf** `/admin/endpoint-perf` | p50/p95/p99 vs budget per route |
| **Financials** `/financials` | Org + per-rep financial reporting from `financial_uploads` |
| **Lane Analytics** `/historical-data` | Historical volume/pricing trends from `financial_loads` |
| **Coordinators Corner** `/coordinators-corner` | Aggregates scheduling/portal creds/missed calls |
| **PTO Passoff** `/pto-passoff` | Coverage handoffs + open-task reassignment |
| **Touchpoint History** `/touchpoint-history` | Org-wide touchpoint audit |
| **Notifications** `/notifications` | Full history with read/unread + deep links |
| **Feedback Inbox** `/feedback-inbox` | DNA Guru feedback, status updates, admin responses |
| **Sidebar Tooltips** `/admin/sidebar-tooltips` | Tooltip overrides (small-surface admin tool) |

---

## 3. What's trustworthy now

These are the surfaces where I would be comfortable telling a rep "this number is right":

- **Dashboard core widgets** (tasks, NBA cards, trending accounts, today's-5, award health) — modulo the `?? 0` masking caveat below.
- **1:1's** (sessions, topics, replies, action items, dev goals, AI summary, recap email).
- **Tasks** (CRUD, comments, notifications, lane-procurement attachment).
- **Goals** (CRUD, bulk-create, auto-progress for the 6 metric types, comments, leaderboard).
- **Team Performance** post-#1060 — KPI cards and the `Mine` scope.
- **Customers** (profile, owner attribution, touchpoint history, opportunities, quotes summary, real health score).
- **Customer Quotes** (Section 1100 contract is green; Mine-only honest empty-state; routing UI; hints panel; mark-outcome).
- **Conversations** (DROP-GATE removed, PERSIST-UNKNOWN in place, honest counts, AI summaries, suggested actions).
- **Lane Work Queue** (Task #1051 unified upload, ≥6/30d rule, 7-day grace).
- **Available Freight** (#1051 freshness pill, AVL forced to moved=false, fact-table reads).
- **Available Loads** (carrier ranking, lane-fit floor, customer-only fallback bucket).
- **All 18 admin surfaces.**

## 4. Belief-vs-reality gaps (biggest first)

These are the things that are real bugs, not philosophical concerns:

1. **`/api/1on1/prep-summary` `openTopics: 0` hardcoded** — `server/routes/coaching.ts:448`. Looks live, always zero. Manager prep is misleading. **Fix size:** small. Replace literal `0` with the actual `getOpenTopicsByPairing` count.

2. **`POST /api/tasks/:id/forward` is missing on the server** — `client/src/components/task-dialog.tsx:49,267` has the UI, but `server/routes/tasks.ts` never registers it. Click → 404. **Fix size:** small. Either implement the route or remove the UI affordance.

3. **Team Performance drill-down ignores `scope` query param** — `server/routes.ts:3674` re-derives the caller's tree regardless. Switching the page to "All Teams" and clicking a KPI card returns the wrong rep set. **Fix size:** small but required to avoid trust loss on a freshly-merged feature (#1060). Read `req.query.scope` in the detail handler exactly as the parent endpoint does.

4. **Goals don't revert from `completed` when manually corrected downward** — `client/src/pages/goals.tsx` auto-complete logic. Result: leaderboard counts a goal as won that is no longer met. **Fix size:** small. Add the inverse transition.

5. **`test:freight-capture-funnel` 23 failures + `test:lane-system-e2e` 4 failures have been red for multiple cycles.** This is "green CI is a lie" territory. The funnel test failures look like seed-data drift in expectations; the e2e failures are real cockpit/SSE regressions. **Fix size:** medium. Either repair or formally retire the suites — leaving them red trains the team to ignore CI failures, which is how the Schema-Drift incident this morning slipped through.

6. **Tasks have no recurring engine.** UI hints at recurrence; `recurring_lanes` is unrelated. Either ship recurrence or remove the implication.

7. **Goals have no historical snapshots.** "What was Rep A's margin progress at end-of-month?" cannot be answered after the next upload overwrites the source-of-truth. Either snapshot at month-end or document the limitation.

8. **Margin auto-tracking silently degrades to manual mode** when `users.financialRepId` doesn't match the Excel column (`goals.tsx:104`). User sees no warning. Add a per-row "auto-tracking is OFF — fix mapping" affordance.

9. **Customer financials match is fuzzy on `financialAlias`.** Missing alias = silent $0. Add a per-account "we couldn't match this account to financial data" affordance.

10. **Customer Quotes `Needs Routing` Mine-only uses `ILIKE` on to/cc email instead of the `quote_reps` mapping** (`server/services/customerQuotes.ts:2510`). Same label, different definition than the main list. Document or unify.

11. **`attachResponseTimes` is a per-row subquery** — works at current volume, will not at 10×. Move to terminal-state cache.

12. **`mark-outcome` idempotency is application-level**, not a DB unique constraint on terminal events. Race condition shaped.

13. **Dashboard `?? 0` / `?? []` masking** — empty state vs API failure look identical to the user. Add error-state rendering distinct from empty-state.

14. **Streak counter has a hardcoded 60d lookback** (`dashboard.ts:1311-1330`). Document or make configurable.

15. **Trending Accounts returns `[]` for "no upload" and "zero delta" identically.** Show "No financial data uploaded" explicitly in the no-upload case.

16. **Sonar Market Pulse silently falls back to empty when SONAR creds are absent.** Use Integrations Health visibility to render an explicit "credentials missing" banner instead of empty data.

## 5. Incubating (admin_preview) surfaces

These are explicitly hidden from non-admins and rendered visible-but-disabled for admins with an "In development" tag. They are NOT promised to users and NOT included in the parity matrix above. Most of them have real backing endpoints already, which is why they appear in the cmd-K palette for admins:

`/report/me` (My Scorecard), `/prospects` (Launchpad), `/freight-capture` (Freight Capture funnel), `/rfp-calendar`, `/email-intelligence`, `/proven-tactics`, `/playbook`, `/freight-triage`, `/coaching`, `/rep-scorecard`, `/ai-hub`, `/lane-inbox`, `/my-pods`, `/available-freight/capacity-matches`, `/carrier-hub`, `/phone-usage`, `/calls`, `/carrier-intelligence/scorecard`, `/carrier-intelligence/lane-pricing`, `/admin/carrier-intelligence/settings`.

If any of these get re-promoted to `active`, they need to go through the parity audit before flipping the flag.

## 6. Recommended remediation order

The priority is "things that lie to the user" before "things that don't scale":

| # | Item | Type | Size |
|---|---|---|---|
| 1 | Fix `/api/1on1/prep-summary` `openTopics: 0` hardcode (§4.1) | Trust | XS |
| 2 | Either implement `POST /api/tasks/:id/forward` or remove the UI (§4.2) | Trust | S |
| 3 | Make Team Performance drill-down respect `scope=all` (§4.3) | Trust | S |
| 4 | Add the goal auto-revert transition (§4.4) | Trust | S |
| 5 | Get `test:freight-capture-funnel` and `test:lane-system-e2e` to green or formally retire them (§4.5) | CI hygiene | M |
| 6 | Add the "auto-tracking is OFF — fix mapping" affordance to Goals (§4.8) | Trust | S |
| 7 | Add the "no financial alias" affordance to Customer profile (§4.9) | Trust | S |
| 8 | Reconcile `Needs Routing Mine-only` semantics (§4.10) | Trust | S |
| 9 | Replace Dashboard `?? 0` masking with explicit error-state rendering (§4.13) | Trust | M |
| 10 | Distinguish "no upload" vs "zero delta" in Trending Accounts (§4.15) | Trust | S |
| 11 | Add "credentials missing" banner to Sonar Market Pulse (§4.16) | Trust | S |
| 12 | Document or remove the "recurring tasks" implication (§4.6) | Honesty | S |
| 13 | Document or implement Goals historical snapshots (§4.7) | Honesty | M |
| 14 | Move `attachResponseTimes` to terminal-state cache (§4.11) | Scale | M |
| 15 | Add a DB unique constraint to make `mark-outcome` idempotency structural (§4.12) | Robustness | S |
| 16 | Document the 60d streak lookback or make it org-tunable (§4.14) | Polish | XS |

Items 1–4 are short and high-trust-impact and would be a clean first batch. Items 5 (red CI) is the biggest organizational hygiene win — every hour the suites stay red is an hour we're training the team to ignore real signals (cf. this morning's Schema-Drift Guard incident, which would have been caught if the migration had a regression test that ran in the CI suite the team actually trusts).

## 7. Constraints honored

- **Read-only:** no code edited during this audit.
- **No broad refactors proposed.**
- **Email plumbing not reopened** — the Section 30 contract and the DROP-GATE → PERSIST-UNKNOWN P0 fix are documented as trustworthy and out-of-scope for follow-up.
- **Uncertainty labeled** — every gap above cites a file:line or a test result; where I couldn't verify (e.g. the `oneOnOneReminderScheduler` was referenced but not deeply audited), it's noted.

---

*Companion machine-readable matrix: [`docs/production-parity-audit.csv`](./production-parity-audit.csv).*
