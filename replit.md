# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application designed to enhance the efficiency and effectiveness of transportation brokerage sales teams. It provides tools for managing customer accounts, contacts, organizational charts, and shipping data. The application includes robust RFP and Award management, advanced analytics, and AI-powered features to streamline workflows, improve customer relationship management, boost sales, and facilitate strategic account penetration, ultimately increasing revenue for transportation brokers. It features comprehensive role-based access control (RBAC).

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application uses a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, features blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The theme incorporates a black sidebar/header with amber gold accents and the Value Truck logo.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. It uses session-based authentication with dynamic RBAC. Key features include:
-   **CRM**: CRUD for companies and contacts with organizational charts and various intelligence fields.
-   **RFP & Award Management**: AI-assisted Excel uploads for RFPs and awards.
-   **Advanced Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Administration, hierarchy, and account reassignment.
-   **Data Integration**: Global search, OneDrive sync, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution (logging touchpoints, creating tasks), and AI email drafting using GPT-4o-mini.
-   **Next Best Action (NBA)**: Recommendation engine based on freight data rules.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: TRAC market band promoted as primary pricing benchmark with internal won-quote band kept as calibration; load_fact lane traffic, Carrier Hub outreach list, and geographic corridor chip layered into search results via parallel, independently-degrading lookups; TRAC results cached 1hr per (lane,equipment).
-   **Visibility Model**: Role and collaboration-based access control for managers and account collaborators.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture from emails, two-way carrier email integration via Microsoft Graph, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with ownership, priority, and tracking. Detail pane includes a Smarter Conversations smart pane: AI thread summary (cached + regenerate), suggested next-action card (one-click handler, dismiss, "wrong" feedback), and a per-thread audit timeline (collapsible). Backed by `conversation_thread_summaries`, `conversation_thread_suggestions`, and `conversation_thread_events` tables. Thread list supports a per-user persistent "Group by" toggle (None / Account / Carrier) with collapsible group headers showing open count, highest priority, oldest waiting age, and unread count; header checkbox bulk-selects all threads in the group, and unlinked threads collect at the bottom. Suggestion feedback (Task #552) is rolled up nightly into `conversation_suggestion_feedback_stats` (per org/account/action_type) and consulted at suggest-time to downweight actions a rep already marked "wrong" within the last 7 days.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities with AI-derived suggestions.
-   **AI Intelligence Hub**: Unified dashboard for Meeting Prep Briefs, Sentiment Tracking, Smart Follow-Up Timing, Relationship Health Coaching, Org Chart Gap Analysis, Warm Introduction Paths, Look-Alike Prospecting, Cross-Sell / Lane Gap Intelligence, Wallet Share Expansion Playbook, Win/Loss Pattern Engine, and Competitive Signal Detection.
-   **Automated Processes**: Auto-sync customer emails via Microsoft Graph, Tactical Learning Engine for successful response approaches, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history sync (~13mo backfill), missed call NBA cards, recording transcription with AI analysis, real-time presence, voicemail metadata + audio, and snapshot syncs for workspaces / locations / call queues / hunt groups / devices / admin reports. Detailed-call enrichment is a tracked queue with retries; admin Webex Health panel shows per-user scopes, last-sync per data type, backfill progress, and recent API failures (Task #466).
-   **AI Center**: Consolidated admin module for managing AI agents, approvals, pods, and adapters.

### System Design Choices
The database schema includes tables for `lane_summary_cache`, `account_contact_suggestions`, `geographic_lane_patterns`, `email_conversation_threads`, `proven_tactics`, `account_reviews`, and the Webex full-coverage tables `webex_sync_state`, `webex_call_enrichment_jobs`, `webex_voicemails`, and `webex_inventory` (one generic table for devices/workspaces/locations/queues/hunt-groups), among others. The "Available Freight" sheet is the canonical source for `freight_opportunities` and `load_fact`, with specific rules for status mapping and deduplication. Performance is optimized using dashboard query optimization, server-side caching, and in-memory caching. Key engineering patterns include visibility expansion for secure data access, a multi-layered caching strategy, keyset pagination, rate-limited external calls, background workers for scheduled tasks, and webhook-driven reactivity.

### Customer-name backfill (Task #587)
A one-time database backfill normalizes legacy TMS code-prefixed customer
labels (e.g. "BLOOSACA - Bloom Energy", "VERTFOFL-Vertiv Mexico",
"CTSI C/O Rheem WH 1827") into clean display names. Lives at
`scripts/backfill-customer-names.ts` and rewrites `companies.name`,
`recurring_lanes.company_name`, and `lane_summary_cache.company_name`
through `formatCustomerName` from `shared/laneFormatters.ts`. Idempotent:
re-running on a cleaned database is a no-op (logged as `updated=0`).
Was executed against the dev database on 2026-04-24 (1,155 rows updated).
Production has not yet been migrated. **Do not re-run unsupervised** — write
operations should be done via `DATABASE_URL="$PRODUCTION_DATABASE_URL"
npx tsx scripts/backfill-customer-names.ts` once per environment, after
which the post-run audit confirms zero rows still match
`^[A-Za-z0-9]{4,}\s+[-–—]\s+`. `freight_opportunities` has no
denormalized `company_name` column — it inherits cleaned values via
`company_id → companies.id`, and the script's audit cross-checks that join.

### Available Freight Cockpit (Task #601)
The flat freight queue at `/available-freight` is now a triage cockpit.
Backend lives in `server/routes/freightOpportunityCockpit.ts`:
`GET /api/freight-opportunities/cockpit` returns KPI strip + per-row payload
(top-3 ranked carrier chips, suggested buy via `getBlendedRate`, coverage,
freshness minutes, customer/owner/SLA/lane enrichment, urgency score). Urgency
= pickup-proximity × customer-tier × lane-score with bonuses for coverage gaps,
empty shortlists, and stale generations (`computeCockpitUrgency`, pure +
unit-tested). Customer tier is derived from
`companies.estimatedFreightSpend` via `deriveCustomerTier` (≥$1M platinum, ≥$500K
gold, ≥$100K silver, >0 bronze) since the table has no explicit tier column.
`POST /api/freight-opportunities/bulk-action` handles approve / snooze /
dismiss / reassign / mark_covered / send_top — `send_top` re-uses
`sendOpportunityWave` so guardrails + audit pipeline are not bypassed.
Saved views (`freight_opportunity_saved_views`) and per-user prefs
(`user_freight_cockpit_prefs`) are scoped by `(orgId, userId)` for
defense-in-depth on PATCH/DELETE. The hourly auto-pilot scheduler in
`server/freightOpportunityAutoPilot.ts` picks up policies with
`autoSendEnabled` at the configured CT hour and sends top-N waves per
company, respecting `autoSendMaxPerDay` via `autoSendLastRunAt`. Tests:
`server/__tests__/freightOpportunityCockpit.test.ts` (24 passing — urgency
scoring incl. tier × lane multipliers, saved-view persistence, auto-pilot
guardrails, bulk-send audit).

### Shared inbox / Microsoft Graph webhook (Task #549)
Production inbound email is wired through Microsoft Graph change notification subscriptions on a shared M365 mailbox (`OUTLOOK_REPLY_EMAIL`). `OUTLOOK_WEBHOOK_SECRET` is a hard requirement in every environment — both the per-rep webhook (`server/routes/graphWebhook.ts`) and the shared-mailbox webhook (`server/routes/laneCarrierOutreach.ts`) refuse to process payloads without it, and `server/graphSubscriptionService.ts` refuses to register subscriptions without it. The Monitored Mailboxes admin page hosts a `ReadinessChecklistCard` backed by `GET /api/internal/admin/monitored-mailboxes/readiness` that surfaces 8 go-live gates (Azure creds, reply mailbox, APP_BASE_URL, webhook secret, Mail.Read consent, ≥1 enrolled mailbox, recent sync, no draining failures). End-to-end coverage lives in `tests/shared-inbox-webhook-e2e.test.ts` (registered as the `test:shared-inbox` validation command). IT setup is documented in `docs/shared-inbox-go-live-runbook.md`.

### Customer Quotes Sender-Domain Learning (Customer Quotes #3)
When a rep manually moves a quote out of the "Unknown — needs review"
bucket into a real customer (single PATCH or bulk reassign), we record
a sender→customer mapping in `quote_sender_mappings`. Business-domain
senders create one row per (org, sender_domain); free-mail senders
(gmail/yahoo/etc) create one row per (org, sender_email) so a personal
gmail address doesn't route every other gmail user to the same
customer. At ingest, `ingestQuoteFromEmail` calls `lookupMapping`
BEFORE the heuristic resolver — email match wins over domain match,
and free-mail senders never fall back to a domain match. Schema
enforces "exactly one of email/domain" via CHECK + two partial unique
indexes (one per scope). Service: `server/services/quoteSenderMappings.ts`
(extractSenderInfo / lookupMapping / upsertManualMapping / bumpHit /
listMappings / deleteMapping / learnFromReassign). Admin UI is
`client/src/components/SenderMappingsDialog.tsx`, gated to
admin/director/sales_director and reachable from the Customer Quotes
header next to Margin Floors. Routes:
`GET/DELETE /api/customer-quotes/sender-mappings[/:id]`. Learning
failures NEVER roll back a reassign — every learn call is wrapped in
try/catch and logged. Tests:
`server/__tests__/quoteSenderMappings.test.ts` (17 cases covering
parse, upsert, lookup, learnFromReassign, plus the gmail collision
guard).

### Schema-Drift Guard (Task #574)
After `runMigrations()` runs at boot, `assertNoSchemaDrift()` (in `server/checkSchemaDrift.ts`) compares every Drizzle pgTable in `shared/schema.ts` against `information_schema` and fails loudly when code declares a table or column the live DB does not have. In production this exits the boot with a clear list of what's missing, so a feature that adds columns to the schema without the matching ALTER in `server/runMigrations.ts` cannot reach users (the failure mode that took down the Conversations tab in Tasks #532 and #533). Dev logs the same report but allows boot to continue. The same check is exposed as a CLI for CI: `tsx scripts/check-schema-drift.ts` (exits 1 on drift). Extra tables/columns in the DB are intentionally NOT flagged — only the code → DB direction matters.

## External Dependencies
-   **PostgreSQL**: Primary database.
-   **xlsx (SheetJS)**: For Excel and CSV parsing.
-   **multer**: For file uploads.
-   **Leaflet**: For interactive mapping.
-   **OneDrive API (Microsoft Graph API)**: For financial data synchronization.
-   **node-cron**: For scheduling recurring jobs.
-   **Resend / GoDaddy SMTP**: For sending emails.
-   **OpenAI (GPT-4o / GPT-4o-mini / Whisper)**: For AI-assisted features including RFP column mapping, lane gap insights, email drafting, lane coaching cards, AI Intelligence Hub features, and call transcription.
-   **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook and auto-sync of customer emails.
-   **FreightWaves SONAR**: For market rate benchmarking and lane capacity signals.
-   **Webex Calling API**: For click-to-call, CDR history sync, presence lookup, and recording download.
-   **FreightWaves TRAC**: Primary source for lane-level spot rates, forecasts, and directional market signals.
-   **ZoomInfo**: For contact intelligence.
-   **Clerk**: For authentication.