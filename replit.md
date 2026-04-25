# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application for transportation brokerage sales teams. It aims to enhance efficiency, manage customer accounts, contacts, and shipping data, and improve customer relationship management. Key features include RFP and Award management, advanced analytics, and AI-powered tools to streamline workflows, boost sales, and facilitate strategic account penetration, ultimately increasing revenue. It includes comprehensive role-based access control.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, uses blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The theme includes a black sidebar/header with amber gold accents and the Value Truck logo.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. It uses session-based authentication with dynamic RBAC. Core functionalities include:
-   **CRM**: CRUD operations for companies and contacts, supporting organizational charts and intelligence fields.
-   **RFP & Award Management**: AI-assisted Excel uploads for RFPs and awards.
-   **Advanced Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Administration, hierarchy, and account reassignment.
-   **Data Integration**: Global search, OneDrive sync, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and AI email drafting.
-   **Next Best Action (NBA)**: Recommendation engine based on freight data rules.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: Integrates TRAC market bands, internal won-quote bands, `load_fact` lane traffic, Carrier Hub outreach lists, and geographic corridor chips into search results.
-   **Visibility Model**: Role and collaboration-based access control.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture from emails, two-way carrier email integration, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with ownership, priority, tracking, AI thread summaries, and suggested next actions.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities with AI-derived suggestions.
-   **AI Intelligence Hub**: Unified dashboard for Meeting Prep Briefs, Sentiment Tracking, Smart Follow-Up Timing, Relationship Health Coaching, Org Chart Gap Analysis, Warm Introduction Paths, Look-Alike Prospecting, Cross-Sell / Lane Gap Intelligence, Wallet Share Expansion Playbook, Win/Loss Pattern Engine, and Competitive Signal Detection.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history sync, missed call NBA cards, recording transcription with AI analysis, real-time presence, and voicemail management.
-   **AI Center**: Consolidated admin module for managing AI agents, approvals, pods, and adapters.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities, providing KPIs, ranked carrier chips, suggested buy rates, coverage, freshness, urgency scores, and bulk actions.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot to prevent schema drift.

### System Design Choices
The database schema includes tables for `lane_summary_cache`, `account_contact_suggestions`, `geographic_lane_patterns`, `email_conversation_threads`, `proven_tactics`, `account_reviews`, and the Webex full-coverage tables `webex_sync_state`, `webex_call_enrichment_jobs`, `webex_voicemails`, and `webex_inventory` (one generic table for devices/workspaces/locations/queues/hunt-groups), among others. `freight_opportunities` and `load_fact` are canonical sources for freight data, with specific rules for status mapping and deduplication. Performance optimization is achieved through dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion for secure data access, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented to map senders to customers, using `quote_sender_mappings`. The Carrier Ranker now integrates history from both `financial_uploads` and `load_fact` for comprehensive carrier shortlisting.

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

### Spot Quote Search drop-zone intake (Task #617)
The Customer Quotes page's `SpotQuoteSearch` component accepts a screenshot, `.eml`, or pasted email text dropped into its empty state. Backend service `server/services/spotQuoteIntake.ts` exposes `parseQuoteIntakeFromText` (reuses `parseQuoteEmail` from `quoteEmailIngestion.ts`) and `parseQuoteIntakeFromImage` (OpenAI `gpt-4o-mini` vision with JSON mode, 8 MB cap). Route `POST /api/customer-quotes/spot-intake` in `server/routes/customerQuotes.ts` accepts multipart (image/.eml) or JSON `{subject,body,rawText}`. Frontend wires the parsed fields into the lane inputs, shows amber "auto-filled" chips per field, and auto-runs the search when confidence ≥ 0.8 and the lane is complete. The summary card (with field chips and "What we read" disclosure) is rendered as a sibling of the empty-state Card so it persists after auto-search replaces the empty state with results. No changes to the background mailbox ingestion path.

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

### Unified Carrier Outreach Dedup (Task #631)
First in the sequenced #631–#641 plan to merge LWQ + Available Freight (AF)
workflows. `server/carrierContactLocks.ts` is the single source of truth for
"has this carrier been contacted on this lane recently?" Every outreach path —
LWQ bulk, LWQ ad-hoc, LWQ procurement, AF wave, AF auto-pilot, single-carrier —
both writes a `source_module`-tagged row to `carrier_outreach_logs` and reads
back via `findCarrierContactLocks` before sending. The 48h dedup window mirrors
`HIGH_FREQUENCY_CONFIG.outreachDedupWindowHours`. Match strategies are the
recurring `lane_id` (precise) and the `(company_id, LOWER(procurement_lane))`
pair (fuzzier, used when LWQ writes use a label and AF writes also have one).
Suppression chips on every surface render via `formatLockReason()` —
"Contacted 2h ago via Available Freight by Sara" — instead of opaque "48h
dedup". The catalog-carrier portion of `rankCarriersForLane` (carrierRankingService)
calls the helper once and prefers the rich reason over the legacy 14-day bench
"Recently contacted (X days ago)" string. Partial-row safety: when a procurement
batch row has `delivery_status='partial'`, only carriers whose per-recipient
status in `recipients` jsonb is a success ('sent','scheduled','delivered','opened')
get locked — failed sends in the same batch row do NOT lock the carrier.
`SendWaveOpts.sourceModule` is plumbed through `sendOpportunityWave` and the
`/api/freight-opportunities/:oppId/send` route auto-infers `"single_carrier"`
when `carrierRowIds.length === 1`. Tests:
`server/__tests__/carrierContactLocks.test.ts` (14 cases).

### Schema-Drift Guard (Task #574)
After `runMigrations()` runs at boot, `assertNoSchemaDrift()` (in `server/checkSchemaDrift.ts`) compares every Drizzle pgTable in `shared/schema.ts` against `information_schema` and fails loudly when code declares a table or column the live DB does not have. In production this exits the boot with a clear list of what's missing, so a feature that adds columns to the schema without the matching ALTER in `server/runMigrations.ts` cannot reach users (the failure mode that took down the Conversations tab in Tasks #532 and #533). Dev logs the same report but allows boot to continue. The same check is exposed as a CLI for CI: `tsx scripts/check-schema-drift.ts` (exits 1 on drift). Extra tables/columns in the DB are intentionally NOT flagged — only the code → DB direction matters.

## External Dependencies
-   **PostgreSQL**: Primary database.
-   **xlsx (SheetJS)**: Excel and CSV parsing.
-   **multer**: File uploads.
-   **Leaflet**: Interactive mapping.
-   **OneDrive API (Microsoft Graph API)**: Financial data synchronization.
-   **node-cron**: Scheduling recurring jobs.
-   **Resend / GoDaddy SMTP**: Email sending.
-   **OpenAI (GPT-4o / GPT-4o-mini / Whisper)**: AI-assisted features (RFP column mapping, lane gap insights, email drafting, lane coaching cards, AI Intelligence Hub, call transcription).
-   **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook and auto-sync of customer emails.
-   **FreightWaves SONAR**: Market rate benchmarking and lane capacity signals.
-   **Webex Calling API**: Click-to-call, CDR history sync, presence lookup, and recording download.
-   **FreightWaves TRAC**: Primary source for lane-level spot rates, forecasts, and directional market signals.
-   **ZoomInfo**: Contact intelligence.
-   **Clerk**: Authentication.