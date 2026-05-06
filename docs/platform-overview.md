# FreightDNA — Platform Overview

**Owner:** Freight-DNA, LLC (Value Truck Transportation Brokerage)
**Last refreshed:** May 2026
**Live URL:** https://freight-dna.com
**Repo entrypoints:** `client/` (frontend), `server/` (backend), `shared/schema.ts` (data model)

This document is the single in-depth reference for what FreightDNA is, what it
does, how it's wired together, and where each capability lives in the codebase.
It is intentionally written for both new engineers joining the project and for
operators / managers who need a complete map of the platform.

If something here drifts from the code, the code wins — but please update this
file in the same commit. The shorter `replit.md` at the repo root is the
agent-facing summary; this file is the human-facing deep dive.

---

## 1. What FreightDNA Is

FreightDNA is an AI-augmented mini-CRM purpose-built for transportation
brokerage sales teams. It replaces the spreadsheet + email + TMS-search workflow
with a single rep-facing surface that:

- Tracks **customers, contacts, lanes, opportunities, quotes, RFPs, awards,
  and carriers** with rich history and visibility controls.
- **Listens to every rep mailbox** (Outlook via Microsoft Graph) and turns
  inbound email into structured customer quotes, freight opportunities,
  carrier replies, and intent signals.
- Runs an **AI layer** on top of that data to surface the next best action,
  draft replies, score quotes, recommend carriers, summarize threads, and
  generate weekly account reviews.
- Gives managers a **real-time view of pipeline, response time, call activity,
  goals, 1:1s, and rep performance**.
- Integrates with **FreightWaves SONAR/TRAC, ZoomInfo, Webex Calling, and
  OneDrive** to pull in market context, contact intel, telephony, and
  financials.

The product north star is **"every rep knows the next best action and never
misses an inbound opportunity."**

---

## 2. Tech Stack

| Layer            | Technology                                                                |
| ---------------- | ------------------------------------------------------------------------- |
| Frontend         | React 18, TypeScript, Vite, Tailwind, `shadcn/ui`, Wouter routing         |
| Data fetching    | TanStack Query v5 (object form), SSE for live updates                     |
| Backend          | Node.js + Express (TypeScript), single process serving API + Vite SSR     |
| Database         | PostgreSQL via Drizzle ORM (`shared/schema.ts` is the source of truth)    |
| Auth             | Clerk (production) + session-based fallback; org-scoped RBAC overlay      |
| AI               | OpenAI (GPT-4o, GPT-4o-mini, Whisper), Anthropic (selective)              |
| Email            | Microsoft Graph (Outlook), Resend, GoDaddy SMTP                           |
| Telephony        | Webex Calling API                                                         |
| Market data      | FreightWaves SONAR + TRAC                                                 |
| Contact intel    | ZoomInfo                                                                  |
| File ingestion   | multer + SheetJS (xlsx), OneDrive sync                                    |
| Real-time        | SSE pub/sub at `/api/live-sync/stream`                                    |
| Scheduling       | `node-cron` (≈30 schedulers, see §10)                                     |
| Mapping          | Leaflet                                                                   |
| Hosting          | Replit Autoscale (12 vCPU / 4 GB RAM / 3 max), `freight-dna.com` domain   |

**Theme:** black sidebar/header with amber-gold accents, Value Truck logo,
dark/light mode toggle, responsive layout.

---

## 3. Top-Level Repo Map

```
client/                React + Vite frontend
  src/
    pages/             ~100 route-level pages (one per top-level surface)
    components/        Reusable UI (cards, dialogs, KPI tiles, sidebar, etc.)
    lib/
      nav-items.ts     Single source of truth for sidebar + cmd-K palette
      queryClient.ts   apiRequest helper, default fetcher
    hooks/             use-toast, use-live-sync, use-feature-visibility, ...
server/                Express API + background workers
  routes.ts            Legacy monolith of route handlers (~10k LoC)
  routes/              ~70 domain-scoped route modules (newer code)
  services/            ~80 business-logic services (mostly pure, testable)
  storage.ts           IStorage interface + Postgres impl (~12k LoC)
  agent/               LLM runtime helpers
  agentic/             Control + autonomy layers for AI agents
  *Scheduler.ts        cron entrypoints (one file per scheduler)
shared/
  schema.ts            Drizzle schema, insert schemas, enums (~8k LoC, ~131 tables)
  types/               Shared TS contracts between client + server
docs/                  Spec + audit + runbook documents (you are here)
migrations/            drizzle-kit generated SQL migrations
tests/                 tsx + Playwright integration tests
tools/                 One-off scripts (backfill, exporters, repair tools)
attached_assets/       User-uploaded assets (images, briefs, screenshots)
```

---

## 4. Data Model (131 Postgres tables)

The schema is large; here it is grouped by domain. Every table is defined in
`shared/schema.ts` with a paired `insertXSchema` (drizzle-zod) and exported
`InsertX` / `X` types. **This is the source of truth — do not duplicate column
listings in this doc.**

### 4.1 Core CRM
`organizations`, `users`, `companies`, `contacts`, `pinned_companies`,
`company_collaborators`, `crm_account_history`, `crm_opportunities`,
`crm_ownership_requests`, `account_growth_scores`, `company_outreach_policies`,
`contact_base_history`.

### 4.2 Touchpoints, Tasks, Goals, 1:1s
`touchpoints`, `tasks`, `task_comments`, `goals`, `goal_comments`,
`development_goals`, `weekly_commitments`, `one_on_one_sessions`,
`one_on_one_topics`, `one_on_one_topic_replies`, `personal_alerts`,
`forced_focus`.

### 4.3 Email & Conversations (Inbound Capture Layer)
`email_messages`, `email_conversation_threads`, `email_conversation_read_states`,
`email_signals`, `email_outcome_links`, `customer_email_identities`,
`sender_routing_rules`, `conversation_saved_views`, `graph_tenant_consent`.

### 4.4 Quote Lifecycle
`quote_opportunities`, `quote_customers`, `quote_carriers`, `quote_reps`,
`quote_events`, `quote_lane_groups`, `quote_pricing_settings`,
`quote_outcome_reasons`, `quote_pattern_alerts`, `quote_pipeline_drops`,
`quote_saved_views`.

### 4.5 Freight Opportunities & Available Loads
`freight_opportunities`, `freight_opportunity_audit`,
`freight_opportunity_capture_failures`, `freight_opportunity_carriers`,
`freight_opportunity_responses`, `freight_opportunity_rate_history`,
`freight_opportunity_saved_views`, `freight_outreach_templates`,
`freight_daily_upload_fact`, `load_fact`, `load_fact_history`,
`load_fact_import_audit`.

### 4.6 Lanes & Lane Intelligence
`recurring_lanes`, `lane_carriers`, `lane_carrier_interest`,
`lane_coverage_profiles`, `lane_coverage_profile_carriers`,
`lane_rate_history`, `lane_summary_cache`, `intel_lane_rates`,
`intel_tracked_lanes`, `geographic_lane_patterns`, `contact_lane_attributions`,
`truck_postings`, `truck_load_matches`.

### 4.7 Carrier Hub / Carrier Intelligence
`carriers`, `carrier_contacts`, `carrier_overrides`, `carrier_claimed_lanes`,
`carrier_lane_fit`, `carrier_lane_outcomes`, `carrier_lane_outcome_event_keys`,
`carrier_outreach_logs`, `carrier_intel_suggestions`,
`carrier_email_suggestions`, `carrier_quote_events`, `carrier_recommendation`,
`carrier_market_nbas`, `carrier_scorecard_fact`, `carrier_import_batches`,
`vendor_routed`.

### 4.8 RFP & Awards
`rfps`, `awards`, `market_share_entries`.

### 4.9 NBA / Copilot / Agentic
`nba_cards`, `nba_card_events`, `nba_card_outcomes`,
`copilot_recommendations`, `chat_conversations`, `chat_messages`,
`opportunity_logs`, `feature_flags`, `app_settings`, `app_suggestions`.

### 4.10 Notes & Collaboration
`context_notes`, `context_note_events`, `context_note_mentions`,
`context_note_replies`, `feed_posts`, `feed_post_reactions`,
`internal_posts`, `callouts`, `callout_reactions`.

### 4.11 Telephony & Calls
`missed_inbound_calls` plus `webex_*` tables (call activity, agent state) used
by `server/routes/webex.ts`.

### 4.12 Financials & Uploads
`financial_uploads`, `freight_daily_upload_fact` (also doubles as the unified
upload fact — see Task #1051), `load_fact`, `load_fact_history`,
`load_fact_import_audit`.

### 4.13 Market Signals & Sonar
`market_events`, `market_signals`.

### 4.14 PTO, Promotion, Career Progression
`pto_passoffs`, `pto_passoff_items`, `promotion_criteria`,
`promotion_nominations`, `report_card_snapshots`.

### 4.15 Operations / Health / Audit
`leak_console_audit`, `leak_console_daily_snapshot`, `cron_heartbeats`,
`lm_daily_checks`, `attachments`, `tool_links`, `sidebar_tooltips`,
`notifications`, `password_reset_tokens`, `demo_requests`,
`prospects`, `prospect_activities`, `prospect_contacts`.

### Schema rules (locked)
1. Always extend `shared/schema.ts` first; client + server both import from
   `@shared/schema`.
2. Pair every table with `createInsertSchema(table).omit({...})` for validation.
3. Array columns use `text().array()` (method form), never `array(text())`.
4. Production schema is migrated via Replit's Publish flow (it diffs dev → prod
   automatically). For ad-hoc dev resets: `npm run db:push`. Never edit
   `drizzle.config.ts`.

---

## 5. API Surface (≈808 endpoints across ~70 route modules)

Endpoints are split between the legacy `server/routes.ts` monolith and newer
domain modules in `server/routes/`. All endpoints follow `apiRequest()` /
TanStack Query conventions on the client and validate input via Zod.

### 5.1 Top namespaces by endpoint count
| Prefix                         | Count | Purpose                                                  |
| ------------------------------ | ----- | -------------------------------------------------------- |
| `/api/internal`                | 60    | Health, capture-audit, ops endpoints                     |
| `/api/customer-quotes`         | 55    | Customer Quotes lifecycle, presets, response times       |
| `/api/admin`                   | 43    | Admin consoles (users, agents, copilot, etc.)            |
| `/api/companies`               | 41    | Company CRUD, touchpoints, history, ownership            |
| `/api/webex`                   | 29    | Telephony, calls, agent state, missed call routing       |
| `/api/agent`                   | 28    | LLM agent runtime + tool execution                       |
| `/api/freight-opportunities`   | 25    | Available Freight cockpit, capture, responses            |
| `/api/copilot`                 | 23    | DNA Copilot recommendations + documents                  |
| `/api/ai-intelligence`         | 21    | AI summaries, narratives, talking points, drafting       |
| `/api/dashboard`               | 19    | Dashboard tiles + KPIs                                   |
| `/api/prospects`               | 18    | Launchpad / prospect intake                              |
| `/api/lanes`                   | 17    | Lane work queue, lane story, lane carriers              |
| `/api/analytics`               | 17    | Pipeline, performance, response-time analytics           |
| `/api/valueiq`                 | 15    | ValueIQ surfaces                                         |
| `/api/financials`              | 15    | Financial + unified upload + freshness pill              |
| `/api/playbook`                | 14    | Playbook plays + analytics                               |
| `/api/nba`                     | 14    | NBA daily workspace + card events                        |
| `/api/carrier-hub`             | 14    | Carrier Hub                                              |
| `/api/1on1` / `/api/one-on-one`| 27    | 1:1 sessions, prep, action items, dev goals              |
| `/api/intel`                   | 13    | Intel lane research                                      |
| `/api/context-notes`           | 13    | Context notes (create, mention, convert-to-task)         |
| `/api/recurring-lanes`         | 10    | LWQ + recurring lane qualification                       |
| `/api/agentic`                 | 10    | Agent autonomy layer (approvals, runs)                   |
| Other (`/api/users`, `/api/tasks`, `/api/rfps`, `/api/goals`, ...) | <10 each | Long tail of CRUD endpoints |

### 5.2 Request conventions
- All mutations use `apiRequest("POST"|"PATCH"|"DELETE", url, body)`.
- All queries use `useQuery({ queryKey: ['/api/...', maybeId] })` with the
  default fetcher. Hierarchical keys must use array form so cache invalidation
  works.
- Error envelope: `{ "error": "message" }` with appropriate HTTP status.
- All identifying URL params are normalized at the top of each handler
  ("zero-new-error" philosophy).
- SSE: `GET /api/live-sync/stream` — used by `LiveSyncPill`, real-time
  inbox updates, NBA refresh, etc.

---

## 6. Front-End Surfaces (~100 pages)

Pages live in `client/src/pages/`. The sidebar + cmd-K palette are driven by
`client/src/lib/nav-items.ts` — keep that file in sync when adding routes.

### 6.1 Dashboard & Daily Flow
- `/` Dashboard — `dashboard.tsx`
- `/today` — Today queue
- `/daily-priorities` — NBA-driven priority list
- `/notifications`, `/feedback-inbox`

### 6.2 Customers / CRM
- `/customers`, `/rep-customers`, `/companies/:id`
- `/contact-suggestions`
- `/touchpoint-history`
- `/prospects` (Launchpad), `/top-opportunities`

### 6.3 Quotes & Conversations
- `/customer-quotes` — Customer Quotes board (chokepoint = customer-only)
- `/quote-cockpit`, `/quote-requests`, `/quote-requests/:id`
- `/conversations` — production inbox
- `/conversations-v2` — admin/director-gated cockpit prototype (Task #1081)
- `/email-intelligence`
- `/lane-inbox`

### 6.4 Freight & Lanes
- `/available-freight`, `/available-freight/:id`,
  `/available-freight/capacity-matches`
- `/freight-capture`, `/freight-triage`
- `/lanes/work-queue` (LWQ), `/lanes/story/:laneSignature`
- `/historical-data` — lane analytics
- `/intel`, `/research-tasks`

### 6.5 Carrier Side
- `/carrier-hub`
- `/carrier-intelligence/available-loads`
- `/carrier-intelligence/lane-pricing`
- `/carrier-intelligence/scorecard`
- `/carrier-lane-search`
- `/my-procurement`
- `/capacity-matches`

### 6.6 RFPs & Awards
- `/rfp-awards`, `/rfp-calendar`, `/rfp-lane-search`

### 6.7 Tasks, Goals, 1:1s, Coaching
- `/tasks`, `/goals`, `/one-on-one`, `/coaching`
- `/lm-checkin-history`, `/proven-tactics`, `/playbook`,
  `/playbook/analytics`, `/training`

### 6.8 Reports & Analytics
- `/report/me`, `/report/:userId`, `/rep-scorecard`, `/rep-reports-roster`
- `/team-performance`, `/team-performance/detail/:metric`
- `/pipeline-analytics`, `/financials`

### 6.9 Telephony
- `/calls`, `/phone-usage`

### 6.10 AI Surfaces
- `/ai-hub` — canonical surface for AI features
- `/ai-intelligence`, `/ai-agent`, `/ai-center`
- `/ai/agents`, `/ai/agents/:slug`, `/ai/admin`, `/ai/approvals`,
  `/ai/adapters`, `/ai/pods`
- `/copilot/documents/:docId` — DNA Copilot

### 6.11 Operations
- `/coordinators-corner`, `/pto-passoff`, `/my-pods`, `/pods`
- `/leak-console`
- `/tools`, `/profile`, `/settings/ai-assistant`

### 6.12 Admin Consoles (`adminItems` in nav-items.ts)
- `/admin/users`, `/admin/carriers`, `/admin/monitored-mailboxes`
- `/admin/freight-capture-rep-audit`, `/admin/pod-intake`
- `/admin/integrations-health`, `/admin/webex-health`
- `/admin/quote-pipeline-health`, `/admin/freight-conversion-failures`
- `/admin/available-freight/imports`
- `/admin/carrier-intelligence` + `/scoring` + `/imports` + `/settings`
- `/admin/freight-outreach-templates`, `/admin/lane-engine`
- `/admin/copilot-analytics`, `/admin/endpoint-perf`
- `/admin/ai-engagement`, `/admin/ai-permissions`
- `/admin/sidebar-tooltips`, `/admin/hero-slice`

### 6.13 Public / Auth
- `/landing`, `/login`, `/reset-password`, `/privacy`, `/terms`,
  `/checkout/success`

### 6.14 UI primitives & rules
- All shadcn imports use the `@/` alias.
- All interactive elements carry a `data-testid` (`{action}-{target}` or
  `{type}-{id}` for dynamic lists).
- Dark mode: explicit `dark:` variants on every visual property unless using a
  theme-bound utility class.
- Use `@assets/...` to import attached files into the bundle.

---

## 7. Roles & Permissions

Defined in `shared/roles.ts` and gated per nav item via `roles?: string[]`.
Common role sets (from `nav-items.ts`):

- `SALES_ROLES` = admin, director, national_account_manager, account_manager,
  sales, sales_director
- `PROSPECTS_ROLES` = admin, sales, sales_director
- `DAILY_PRIORITIES_ROLES` = admin, director, NAM, AM, sales, sales_director
- `CARRIER_INTEL_ROLES` = admin, director, NAM, logistics_manager,
  logistics_coordinator, sales_director
- `CARRIER_INTEL_SETTINGS_ROLES` = admin, director only
- `ADMIN_GROUP_ROLES` = admin, director, NAM, sales, sales_director

Sidebar entries support `status: "active" | "admin_preview" | "hidden"` for
incubating surfaces (visible-but-disabled for admins, hidden for everyone
else). The cmd-K palette ignores `status` so admins can still jump to preview
surfaces directly.

Visibility expansion (which accounts/lanes a user can see) is enforced
server-side in `server/storage.ts` and feeds every CRM query.

---

## 8. Key Product Subsystems

### 8.1 Customer Quotes (chokepoint = customer-only)
Stability contract locked in `docs/customer-quotes-stability-contract.md`
(CQ-1..CQ-6) and enforced by Section 1100 of
`tests/code-quality-guardrails.test.ts`. Touching `applyFilters`, `loadContext`,
`enrich`, `attachResponseTimes`, or the `__none__` resolver in
`server/services/customerQuotes.ts` requires updating both files in the same
commit. Honest "Mine Only" empty state, customer-only main queue,
`companies.ownerRepId` as canonical owner, read-only response-time derivation,
null-passthrough on the rep gate, intentional diagnostics bypass.

### 8.2 Conversations Inbox
Org-scoped, AI-summarized, suggested-actions surface backed by a hybrid
sync approach (delta sync + webhook). The newer `/conversations-v2` (Task
#1081) is admin-gated and prototypes a cockpit-style layout. Inbound email
preservation contract is locked in `server/routes/graphWebhook.ts`
(`processUserMailboxEmail`) — the legacy `DROP-GATE` early-return was removed
in a P0 incident fix; rows for unknown senders persist with
`linkedAccountId = NULL` and emit a `[user-mailbox] PERSIST-UNKNOWN` log line.
Only true Outlook `@removed` tombstones early-return now. Section 30 of the
guardrails locks this contract.

### 8.3 Available Freight Cockpit
- One unified upload table (`freight_daily_upload_fact`) — see Task #1051.
- Order numbers and "Won from Customer Quote" badge per Task #1078; locked
  by Section 1078 of guardrails.
- Owner + pickup-scope filter contract from `docs/workflow-os-spec.md`.

### 8.4 Lane Work Queue (LWQ)
- Eligibility: ≥6 moved loads in the rolling last 30 days, with a 7-day
  grace via `recurring_lanes.lastEligibleAt`.
- Each row carries `movesLast30Days`, `lastMovedAt`, `qualificationReason`,
  `supportingCustomers`, `recentCarriers`.
- Shared `UnifiedUploadFreshnessPill` across Financials / Available Freight
  / LWQ. See `docs/unified-replit-daily-upload.md`. Section 1051 locks it.

### 8.5 NBA (Next Best Action) Engine
Daily task recommendations with card events + outcomes. Feeds the Daily
Priorities surface and the Today queue. Outcomes are classified via
`server/nbaOutcomeClassifier.ts` (15-min cron).

### 8.6 Carrier Intelligence + Ranker
- Lane fit + carrier profile are primary; customer history is secondary.
- Org-tunable lane-fit floor via `ScoringThresholds.minLaneFitForTopRank`
  (default 50); `PUT /api/admin/carrier-intelligence/scoring` updates it.
- Customer-history boost is `+5 base + 1/load (cap 10)`.
- Rec engine blend: `0.65·fit + 0.35·perf` (loads ≥3) / `0.80/0.20` (new).
- Carriers below floor split into `customerOnlyFallback` bucket.
- AI top-5 re-sort applies the canonical bench → claimed → fallback →
  score comparator (no naive score sort).
- Bench-win carriers excluded from fallback flag.

### 8.7 Email Intelligence Layer
Captures customer contacts, integrates two-way carrier emails, extracts intent
signals, and feeds the Quote Pipeline. Lives in `server/services/emailFacts/`,
`server/services/inlineEmailClassifier.ts`,
`server/services/quoteEmailIngestion.ts`,
`server/services/quoteOpportunityFromSignalService.ts`. See
`docs/email-intelligence-layer.md` and `docs/email-intelligence-map.md`.

### 8.8 Quote Lifecycle Autopilot + Pipeline Observability
Automates quote processing. `quote_pipeline_drops` captures every email-to-quote
attempt status; the admin operator console at `/admin/quote-pipeline-health`
surfaces drops with replay/resolve actions.

### 8.9 Webex Calling
Two-way Webex integration (`server/routes/webex.ts`) — call activity, missed
inbound call routing (`missed_inbound_calls`), agent state, weekly trendline,
and Call Performance Hub at `/calls`. Renewal crons at `/5`, `/30`, `/15`,
`:17` minute marks.

### 8.10 DNA Copilot
Document ingestion → AI extraction → recommendation pipeline.
`server/services/copilot/`, `server/routes/copilot.ts`,
`server/routes/copilotIntelligence.ts`. Admin queue at
`/admin/copilot/documents/queue`.

### 8.11 Context Notes
Anchored, in-platform collaboration: notes attached to companies/contacts/
lanes/quotes with action types, lifecycle, mentions (`@user`), and
convert-to-task. See `docs/context-notes.md`.

### 8.12 Workflow OS
Defines canonical owner + pickup-scope filter contracts, URL serialization,
and stale-suppression behavior across rep-facing work surfaces (Available
Freight, LWQ, Available Loads). Trust/consistency layer includes
`LiveSyncPill`, `rowVersionAt` + `applyRowVersionGuard`, owner-scope grammar,
`HiddenCountsDisclosure`, `EmptyStateRecovery`. See `docs/workflow-os-spec.md`.

### 8.13 Hero Loop (email → load → quote → award)
Cross-tab UX layer linking the inbound email all the way through to a won
load. See `docs/hero-loop-email-to-load.md`. Recent UX fixes locked by
Section 1077.

### 8.14 Manager Surfaces
Team Performance + drill-down (`?scope=all|mine` URL param honored end-to-end
per Task #1075), 1:1s with prep summary (`countOpenTopicsForAm` is the source
of truth), Goals (auto-revert to `active` when `currentValue` drops below
`target` per Task #1075), Tasks Forward affordance (`POST /api/tasks/:id/forward`).

### 8.15 Capture Leak Queue
Manages missed inbound emails. Surfaced in `/leak-console` and the Manager
Leak Console; backed by `leak_console_audit` + `leak_console_daily_snapshot`.

### 8.16 Schema-Drift Guard
Enforces dev/prod schema parity at boot via `server/runMigrations.ts`.

---

## 9. AI / LLM Architecture

| Folder              | Responsibility                                                |
| ------------------- | ------------------------------------------------------------- |
| `server/agent/`     | Runtime: tool execution, prompts, model routing               |
| `server/agentic/`   | Control + autonomy: approvals, run history, agent definitions |
| `server/services/copilot/` | Document ingestion + extraction                        |
| `server/services/aiIntelligenceService.ts` | Talking points, narratives, summaries  |
| `server/services/inlineEmailClassifier.ts` | Inline email→intent classifier        |

User-visible AI features:
- Talking points & health-score narratives (per company / per contact)
- Touchpoint summaries
- Proactive nudges (`personal_alerts`)
- AI-drafted emails
- Account-review composer (weekly auto-generated, `accountReviewComposer.ts`)
- DNA Copilot doc Q&A
- Suggested 1:1 topics
- Conversation thread summary + suggested actions
- Quote pricing recommendation (`quotePricingRecommendation.ts`)
- Lane Story narrative (`laneStory.ts`)

All AI chat conversations are user-scoped (per `chat_conversations`).

---

## 10. Background Workers (cron)

≈30 schedulers configured. Each writes to `cron_heartbeats` for monitoring at
`/admin/integrations-health`.

| Schedule          | File                                              | Purpose                                              |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `* * * * *`       | `quoteRequestSlaService.ts`                       | Quote SLA tick                                       |
| `* * * * *`       | `emailIntelligenceScheduler.ts`                   | Inline email classifier (2-min recovery cron)        |
| `* * * * *`       | `services/mailboxWatchdogService.ts`              | Mailbox health watchdog                              |
| `* * * * *`       | `services/mailboxDeltaSyncService.ts`             | Per-mailbox delta sync                               |
| `*/2 * * * *`     | `pafoeWaveScheduler.ts`                           | Proactive freight outreach waves                     |
| `*/5 * * * *`     | `sonarDailyRefreshScheduler.ts` (rolling)         | Sonar rolling pull                                   |
| `*/5 * * * *`     | `services/conversationReplyCaptureService.ts`     | Reply self-heal capture                              |
| `*/5 * * * *`     | `routes/webex.ts` (×2)                            | Webex call activity + agent state                    |
| `*/15 * * * *`    | `playOutcomeWindowScheduler.ts`                   | Play outcome window classifier                       |
| `*/15 * * * *`    | `nbaOutcomeClassifier.ts`                         | NBA card outcome classification                      |
| `*/15 * * * *`    | `routes/webex.ts`                                 | Webex SSO/token health                               |
| `*/15 * * * *`    | `services/quoteNoResponseSweep.ts`                | Quote no-response sweep                              |
| `*/30 * * * *`    | `routes/webex.ts`                                 | Webex extended health                                |
| `:17 * * * *`     | `routes/webex.ts`                                 | Hourly webex reconciliation                          |
| `:19 * * * *`     | `graphSubscriptionService.ts`                     | Graph subscription renewal sweep (hourly)            |
| `:13 */6 * * *`   | `graphSubscriptionService.ts`                     | Bulk subscription renewal (every 6h)                 |
| `:7 */6 * * *`    | `graphSubscriptionService.ts`                     | Subscription audit                                   |
| `:20 */6 * * *`   | `quoteLostStreakScheduler.ts`                     | Lost-streak detection                                |
| `0 0,6,12,18 * * *` | `marketSignalScheduler.ts`                      | Market signals refresh (4×/day)                      |
| `30 4 * * *`      | `sonarDailyRefreshScheduler.ts`                   | Sonar daily snapshot                                 |
| `30 7 * * 1-5`    | `lmCheckinScheduler.ts`                           | LM morning check-in (weekdays)                       |
| `0 16 * * 1-5`    | `lmCheckinScheduler.ts`                           | LM end-of-day check-in (weekdays)                    |
| `0 7 * * 1-5`     | `intelEmailScheduler.ts`                          | Daily intel digest (weekdays)                        |
| `30 7 * * 1`      | `intelEmailScheduler.ts`                          | Weekly intel digest (Monday)                         |
| `0 8 * * *`       | `ptoReturnScheduler.ts`                           | PTO return processing                                |
| `0 8 * * *`       | `healthAlertScheduler.ts`                         | Daily integration health alert                       |
| `0 9 * * *`       | `services/quoteNoResponseSweep.ts`                | Daily no-response report                             |
| `0 3 * * *`       | `routes.ts` (legacy)                              | Daily snapshot scheduler                             |
| `0 3 * * *` / `0 5 * * *` | `nbaPhase1Scheduler.ts`                   | NBA generation passes                                |

---

## 11. Integrations

| Integration            | What it powers                                             | Secrets                              |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Microsoft Graph (Outlook) | Two-way email sync, customer email auto-capture, mailbox watchdog | `OUTLOOK_*`, `graph_tenant_consent` |
| OneDrive (Graph)       | Financial spreadsheet sync                                  | shares Outlook tenant                |
| Resend                 | Outbound transactional email                                | `RESEND_API_KEY`                     |
| GoDaddy SMTP           | Outbound rep email fallback                                 | `SMTP_PASSWORD`                      |
| OpenAI                 | GPT-4o, GPT-4o-mini, Whisper                                | (managed integration)                |
| Anthropic              | Selective Claude usage                                      | (managed integration)                |
| FreightWaves SONAR     | Lane capacity insights, market benchmarks                   | (env)                                |
| FreightWaves TRAC      | Spot rates, forecasts, market signals                       | (env)                                |
| ZoomInfo               | Contact intelligence enrichment                             | `ZOOMINFO_*`                         |
| Webex                  | Calling, agent state, missed-call routing                   | `WEBEX_*`                            |
| Clerk                  | Auth in production                                          | `CLERK_*`                            |
| Stripe                 | Billing (managed integration)                               | (managed)                            |

Integration health is monitored at `/admin/integrations-health` with daily
alert (`healthAlertScheduler.ts` 8 AM).

---

## 12. Operations Runbook

### 12.1 Local development
```
npm install
npm run dev          # starts Express + Vite on one port
npm run check        # typecheck (workflow: typecheck)
npm run db:push      # apply schema to dev DB (drizzle-kit)
```

Env vars are managed by Replit Secrets (see `replit.md` for the list). The
`Start application` workflow runs `npm run dev`.

### 12.2 Production deploy
- Deploys via Replit Publish UI; production at `freight-dna.com`.
- Publish flow diffs dev schema → prod and applies migrations.
- Autoscale: 12 vCPU / 4 GB RAM / 3 max instances, North America.
- If publish fails with *"Failed to fetch PostgreSQL major version for
  development database"* → dev DB host is unreachable. Run `kill 1` in the
  workspace Shell to recycle the container; then republish.

### 12.3 When dev DB host (`helium`) is unreachable
1. Open the Shell tab in the workspace.
2. `kill 1` (recycles the workspace container; reconnects the new DB host).
3. Wait for reconnect, confirm with `printenv DATABASE_URL` (host should NOT
   be `helium`).
4. Restart the `Start application` workflow if not auto-restarted.

### 12.4 Production logs
- Use the agent `fetch_deployment_logs` tool, or open the Replit Publishing
  → Logs tab.
- Healthy signal: regular `/api/notifications 200/304`, delta-sync messages,
  `webex/status 200`.
- 401s on `/api/live-sync/stream` are normal (SSE auth challenge).

### 12.5 Common alerts
- **Mailbox watchdog: `<email> not found in tenant`** → user deleted/renamed
  in M365. Update or remove from `monitored_mailboxes`.
- **Email→quote pipeline classification lag** → check OpenAI flakiness
  (`[emailIntelligence] extraction error`); the 2-min recovery cron drains it.
- **Webex auth lapsed** → re-authorize at `/admin/webex-health`.

### 12.6 Test / quality gates
- `tests/code-quality-guardrails.test.ts` — 30+ sections of locked
  contracts (CQ-1..CQ-6, Section 1051, 1075, 1077, 1078, etc.).
- `tests/freight-capture-funnel.test.ts`
- `tests/cockpit-hardening.test.ts`
- `tests/lane-system-e2e.spec.cjs` — Playwright (4 workers)
- `tests/shared-inbox-webhook-e2e.test.ts`
- `tests/storage-integration.test.ts`

Each is registered as a workflow; run with `restart_workflow` or directly via
`npx tsx ...` / `npx playwright test ...`.

---

## 13. Locked Contracts (do not break without paired guardrail update)

| Section | Contract                                                                  |
| ------- | ------------------------------------------------------------------------- |
| 30      | Inbound email preservation (`processUserMailboxEmail` PERSIST-UNKNOWN)    |
| 1051    | Unified ReplitDailyUpload — financials/AF/LWQ share `freight_daily_upload_fact` |
| 1075    | UI Trust micro-batch (1:1 prep, task forward, team perf scope, goals revert) |
| 1077    | Hero Loop UX trust fixes                                                   |
| 1078    | AF order numbers + "Won from Customer Quote" badge (no fingerprint loadKey surfaced) |
| 1081    | `/conversations-v2` admin prototype gating                                 |
| 1100    | Customer Quotes stability (CQ-1..CQ-6)                                     |

Touching any code these sections cover requires editing both the production
file *and* the matching guardrail section in the same commit.

---

## 14. Where to Look First

| Question                                          | Start here                                            |
| ------------------------------------------------- | ----------------------------------------------------- |
| What does column X mean?                          | `shared/schema.ts`                                    |
| Where is endpoint `/api/X`?                       | `server/routes/X.ts` then `server/routes.ts`          |
| What pages use endpoint X?                        | `rg "'/api/X'" client/src`                            |
| Why is the sidebar hiding this for me?            | `client/src/lib/nav-items.ts` + role gates            |
| Why isn't an inbound email becoming a quote?      | `quote_pipeline_drops` + `/admin/quote-pipeline-health` |
| Why is mailbox X unhealthy?                       | `/admin/monitored-mailboxes` + watchdog logs          |
| Why is a rep missing from a manager surface?      | Visibility expansion in `server/storage.ts`           |
| What runs at 3 AM?                                | §10 above                                             |
| Where's the AI system prompt?                     | `server/agent/`                                       |
| What contract did I just break?                   | `tests/code-quality-guardrails.test.ts`               |

---

## 15. Glossary

- **AM** — Account Manager
- **NAM** — National Account Manager
- **LM** — Logistics Manager (operations side)
- **LWQ** — Lane Work Queue
- **NBA** — Next Best Action
- **AF** — Available Freight
- **AVL** — Available (loads) sheet on the daily upload
- **CQ** — Customer Quotes
- **PAFOE** — Proactive Freight Outreach
- **TRAC / SONAR** — FreightWaves rate + market data products
- **Hero Loop** — the email → load → quote → award user journey
- **Workflow OS** — shared owner + pickup-scope grammar across rep surfaces
- **Chokepoint** — a contract that forces all reads/writes through one code path
- **Pillar** — a UI primitive (`LiveSyncPill`, `UnifiedUploadFreshnessPill`,
  `HiddenCountsDisclosure`, `EmptyStateRecovery`) shared across surfaces
- **Hero Slice** — the auto-assigned starter dataset for a brand-new rep

---

*If you're a new engineer: read this file end-to-end, then `replit.md`,
then `docs/workflow-os-spec.md` and `docs/customer-quotes-stability-contract.md`.
You'll have ~80% of the platform's mental model in 30 minutes.*
