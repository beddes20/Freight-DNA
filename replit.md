# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application for transportation brokerage sales teams. Its core purpose is to enhance efficiency, manage customer accounts, contacts, and shipping data, and streamline sales workflows. The platform aims to facilitate strategic account penetration through RFP and Award management, advanced analytics, and AI-powered tools, ultimately increasing revenue. It includes comprehensive role-based access control, AI-driven insights, automated processes, and real-time communication tools.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, utilizes blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The chosen theme includes a black sidebar/header with amber gold accents and the Value Truck logo. Shared UI primitives (`<Skeleton />`, `<EmptyState />`, `<ErrorBanner />`) are used for consistent loading, empty, and error states.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM, employing session-based authentication with dynamic Role-Based Access Control (RBAC). Key functionalities include:
-   **CRM**: Comprehensive CRUD for companies and contacts.
-   **RFP & Award Management**: AI-assisted Excel uploads.
-   **Advanced Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Administration, hierarchy management, and account reassignment.
-   **Data Integration**: Global search, OneDrive synchronization, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and AI email drafting.
-   **Next Best Action (NBA)**: A recommendation engine for daily priorities.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: Integration of market bands, internal won-quote bands, lane traffic data, Carrier Hub outreach lists, and geographic corridor chips.
-   **Visibility Model**: Role and collaboration-based access control for data.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture, two-way carrier email integration, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with AI summaries and suggested actions. Email sync uses a hybrid model: real-time webhook push from Microsoft Graph as the primary path, plus a polling safety net so freshness is guaranteed regardless of webhook health.
    -   **Polling cadence**: `mailboxDeltaSyncService.initDeltaSyncScheduler()` runs `cron.schedule("*/5 * * * *", ...)` so every enabled monitored mailbox is pulled via Graph delta query every 5 minutes (clock-anchored, survives restarts). Each cycle is guarded by a `_cycleInFlight` mutex so a slow run can't pile up on the next tick. Boot kicks an immediate cycle 30s after start so a fresh restart doesn't have to wait 5 minutes. Admins can press the new "Sync mail now" button on the Capture Audit Status pill (`POST /api/internal/admin/conversations/sync-mailboxes-now`) to trigger an immediate cycle. The previous `setInterval(15min)` was replaced because it both ran too slowly for sales' freshness requirement and reset on every workflow restart.
    -   **Webhook subscription renewal**: Graph mailbox subscriptions are renewed by a separate `node-cron` schedule running every 6 hours (clock-anchored, survives workflow restarts), and the boot pass proactively renews anything expiring within 24 hours rather than only re-registering already-expired subs. Admins can hit the "Renew subscriptions now" button in the Capture Audit Status pill (`POST /api/internal/admin/conversations/renew-mailbox-subscriptions`) to recover instantly without waiting for the next cron tick. This combination eliminates the recurring "Webhook unhealthy" pill that used to appear whenever the app restarted more than once per 48h (the previous `setInterval(..., 48h)` renewer would reset on every restart and never fire before the 70h subscription TTL expired).
    -   **Why both layers exist**: Microsoft Graph webhooks are near-instantaneous (mail arrives in seconds) but can silently fail (subscription expired, transient delivery error, restart timing). The 5-minute poll guarantees that even in the worst case — every webhook completely broken — no mailbox goes more than ~5 minutes without a refresh. Both paths share idempotent ingestion (`processUserMailboxEmailForDelta` deduplicates on provider message id) so racing a webhook push and a poll for the same message is safe.
    -   **Cron heartbeat layer (never-fail-again pass)**: Every recurring background job in the email pipeline writes a heartbeat row to `cron_heartbeats` via `withHeartbeat()` (`server/lib/cronHeartbeat.ts`). The Capture Audit Status pill reads `storage.getStaleCronHeartbeats(1.5)` and surfaces any job whose `nextExpectedAt + 50%` has passed without a tick — admins now see "renewer hasn't run in 9 hours" before it turns into a red Webhook Unhealthy pill. All schedulers (`mailbox_delta_sync_poll`, `email_intelligence_batch`, `graph_user_mailbox_renewal`, `graph_shared_mailbox_renewal`, `graph_shared_mailbox_activation_retry`, `reply_capture_self_heal_sweep`) are clock-anchored `node-cron` jobs — every previous `setInterval(...)` in a cron-like role was converted because workflow restarts reset the interval clock and could mask a dead scheduler indefinitely. SONAR breaker long-open monitor and PAFOE wave dispatcher were also converted for consistency. Regression test `tests/email-sync-cadence.test.ts` locks in the cadences, the `_cycleInFlight` mutex, and the `providerMessageId` dedupe.
    -   **Audit pill rollup (red vs amber tiers)**: The aggregate status reserves red ("unhealthy") for failures that materially break sales: any non-zero `webhookFailureCount` OR staleness in a `CRITICAL_EMAIL_PIPELINE_JOBS` member (`mailbox_delta_sync_poll`, `email_intelligence_batch`, `reply_capture_self_heal_sweep`). Other email-pipeline-job staleness — e.g., a 6-hour subscription renewer that's a few minutes late — surfaces as amber ("recovering") instead. The previous rule treated any stale heartbeat as red and produced a recurring false-positive Webhook Unhealthy pill on restart, even when Graph subscriptions were fine (they survive ~70h and tolerate one missed renewer tick).
    -   **Quote Lifecycle Autopilot** (Task #803, three coordinated automations marked with `auto:` actor strings on `quote_events`): (A) `ingestQuoteFromEmail` flags an opp's `needsNewContactReview` JSONB column when an inbound quote arrives from a known customer DOMAIN but a NEW sender email — surfaced as a "New contact at {Customer}" Add/Dismiss strip above the Quote Opportunities table (`NewContactReviewStrip.tsx` + `GET /api/customer-quotes/new-contact-reviews` + `POST /api/customer-quotes/quote/:id/new-contact-review`); resolution writes an `auto:new_sender` event. (B) `applyOutboundReplyToOpenQuote` (`outboundQuoteAutoQuote.ts`) hooked into the outbound branch of `graphWebhook.ts` runs a gpt-4o-mini extractor on rep replies; confident `(quotedAmount, confidence>=medium)` results flip the quote to outcomeStatus `quoted` (new in `QUOTE_OUTCOME_STATUSES`) with quotedAmount + 7-day validThrough and an `auto:outbound_reply` event; uncertain extracts drop a timeline note. Idempotent on `payload->>'providerMessageId'`. (C) `quoteNoResponseSweep.ts` runs every 15 minutes (`JOB_NAMES.quoteNoResponseSweep`, `withHeartbeat`-wrapped node-cron) closing pending opps whose last event is older than the per-org `agent_org_settings.quote_no_response_timeout_hours` (default 2h) AND have no fresher inbound reply on the source thread; writes an `auto:no_response_timeout` event with outcomeStatus `no_response`. Re-opened opps get a one-window grace period to prevent thrash. A daily summary alert in `getSnapshot` (customerQuotes.ts) rolls up the last 24h of `auto:%` events plus pending prompts into a single Operational Alerts row. Tests: `server/__tests__/quoteAutopilot.test.ts`.
    -   **Quote ingest in the cron path**: `runEmailIntelligenceBatch` extracts AI signals AND runs the Customer Quotes pipeline inline (mirrors `processEmailMessage`'s ingest block): `ingestQuoteFromEmail` + `applyClosedWonToOpenQuote` + `applyClosedLostToOpenQuote` with `isWonLanguage`/`isLostLanguage` detection, gated on `direction === "inbound" && actorType === "customer"`, all fault-isolated. Without this, the cron path classified emails as `pricing_request` but never wrote `quote_opportunity` rows — leading to the "Customer Quotes empty for 12 hours despite emails flowing" outage. `backfillQuotesFromEmails(orgId, {sinceDays})` is the recovery lever for any future gap.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities.
-   **AI Intelligence Hub**: A unified dashboard for various AI-driven insights, consolidating chat-style AI surfaces under a single "AI" sidebar entry.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history synchronization, recording transcription with AI analysis, and real-time presence.
-   **Call Performance Hub**: Unified org-wide telephony page for managers.
-   **AI Center**: Consolidated admin module for managing AI agents, approvals, and adapters.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities.
-   **Won Load Autopilot**: Automates the conversion of won quotes into freight opportunities, triggering notifications and an un-dismissible approval modal for logistics manager assignment and rate adjustments.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot.
-   **Cross-Tab UX Layer**: Hover-card previews, deep-linking, SSE pub/sub for real-time updates across tabs, and a unified Lane Inbox feed with cross-tab navigation.
-   **Universal Flow Primitives**: Includes a command palette for quick actions and navigation, and a consistent `DetailDrawer` and `EntityLink` pattern for displaying entity details and previews throughout the application.

### System Design Choices
The codebase maintains a zero-error typecheck baseline. Express handlers normalize `req.params` and `req.query` using helpers. AI chat conversation endpoints are user-scoped. The database schema includes tables for caching, contact suggestions, lane patterns, email conversations, proven tactics, and Webex integration. `freight_opportunities` and `load_fact` are canonical freight data sources. Performance is optimized via dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented, and the Carrier Ranker integrates history from `financial_uploads` and `load_fact`. A dedicated `/admin/integrations-health` page provides live status for external integrations, polling health probes and notifying administrators of degraded services. Reusable handler helpers enforce consistent request parsing, authentication, and error handling.

## External Dependencies
-   **PostgreSQL**: Primary database.
-   **xlsx (SheetJS)**: Excel and CSV parsing.
-   **multer**: File uploads.
-   **Leaflet**: Interactive mapping.
-   **OneDrive API (Microsoft Graph API)**: Financial data synchronization.
-   **node-cron**: Scheduling recurring jobs.
-   **Resend / GoDaddy SMTP**: Email sending.
-   **OpenAI (GPT-4o / GPT-4o-mini / Whisper)**: AI-assisted features.
-   **Microsoft Graph API (Outlook)**: Two-way carrier email and auto-sync of customer emails.
-   **FreightWaves SONAR**: Market rate benchmarking and lane capacity signals.
-   **Webex Calling API**: Telephony integration.
-   **FreightWaves TRAC**: Spot rates, forecasts, and market signals.
-   **ZoomInfo**: Contact intelligence.
-   **Clerk**: Authentication.