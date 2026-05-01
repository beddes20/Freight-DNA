# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application for transportation brokerage sales teams. It manages customer accounts, contacts, and shipping data to enhance sales efficiency and strategic account penetration. The platform aims to increase revenue through comprehensive role-based access control, AI-driven insights, automated processes, and real-time communication tools, particularly focusing on RFP and Award management and advanced analytics.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It includes dark/light mode, a black sidebar/header with amber gold accents, the Value Truck logo, KPI stat cards, and a responsive sidebar. Consistent UI primitives manage loading, empty, and error states. AI features are primarily accessed via `/ai-hub`, with aliases like `/daily-priorities`, `/admin/copilot-analytics`, and `/admin/ai-engagement`.

### Technical Implementations
FreightDNA uses a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. It employs session-based authentication with dynamic Role-Based Access Control (RBAC). Key features include:
-   **Core CRM**: CRUD operations for companies and contacts.
-   **RFP & Award Management**: AI-assisted Excel uploads for managing proposals and awards.
-   **Advanced Analytics**: Tools for lane research, coverage gap, lane pattern, historical data, and wallet share analysis.
-   **User & Team Management**: Administration, hierarchy, and account reassignment.
-   **Data Integration**: Global search, OneDrive sync, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and AI email drafting.
-   **Next Best Action (NBA)**: A recommendation engine for daily tasks.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: Integration of market bands, internal won-quote bands, lane traffic, Carrier Hub outreach, and geographic corridor chips.
-   **Visibility Model**: Role and collaboration-based access control.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture, two-way carrier email integration, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with AI summaries and suggested actions, using a hybrid real-time webhook and polling for synchronization.
-   **Quote Lifecycle Autopilot**: Automates quote processing, including email ingestion and outbound reply analysis.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities.
-   **AI Intelligence Hub**: Unified dashboard for AI-driven insights.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history, recording transcription with AI analysis, and real-time presence.
-   **Call Performance Hub**: Unified telephony page for managers.
-   **AI Center**: Admin module for managing AI agents, approvals, and adapters.
-   **Available Freight Cockpit**: Triage for freight opportunities.
-   **Won Load Autopilot**: Automates conversion of won quotes into freight opportunities.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot.
-   **Capture Leak Queue**: Manages missed inbound/orphan outbound emails with admin actions and analytics.
-   **Cross-Tab UX Layer**: Provides hover-card previews, deep-linking, SSE pub/sub, and a unified Lane Inbox.
-   **Universal Flow Primitives**: Command palette, `DetailDrawer`, and `EntityLink` patterns.
-   **Quote Request System**: The `/quote-requests` operator surface (Task #850) replaces the legacy `/customer-quotes` page; the old route now redirects. Page chrome includes a top bar (search, refresh, new quote), KPI strip (Open / Awaiting your reply / Past SLA / Won today / Auto-captured today), filter row (status chips, age chips, mine-only, free-email, sender-domain dropdown), and an automation-counters footer polled every 60s. The 9-column dense list wires to `/api/customer-quotes/list` and supports `includeSnoozed`, `mineOnly` (server-resolved to the requesting user's `quote_reps.id` via a `NO_REP_SENTINEL` so users without a rep mapping see nothing), keyboard nav (j/k focus, Enter open, [/] paging, Esc close, `/` focus search), and `?quote=<id>` deep-linking via `history.replaceState`. The sticky-header detail drawer renders lane / confidence / source-thread / pricing-intel / activity-timeline cards, an assignable rep avatar, a Won/Lost split button (manager + owner only), and quick actions wired to the five Task #849 endpoints (`attach-to`, `send-to-leak`, `snooze`, `reply`, autopilot override). Backend contracts and UI primitives (`ErrorBanner`, `EmptyState`) are guardrail-tested.
-   **Quote-Request Leakage Diagnostic**: Provides read-only leakage statistics for inbound customer email signals, categorizing them as `with_opportunity`, `in_leak_queue`, or `leaked`.
-   **Conversations Freshness**: Enhances UI freshness labels and sort comparators by using server-computed `lastEmailAt` and more accurate `lastIncomingAt`/`lastOutgoingAt` timestamps.
-   **Customer Quotes Display Resolution**: Improves rep and customer name resolution for better data clarity and consistency.
-   **Manager Leak Console (Task #872)**: Manager-only `/leak-console` page (admins, directors, sales directors, NAMs) surfacing four leak classes across Available Freight and the Lane Work Queue: (1) No-contactable under demand, (2) Unstable lanes still spot-deployed, (3) Recurring covered on spot, (4) Owned-but-untouched under pressure. Each panel renders a sortable lane list with evidence chips and one-click fix actions (Build bench, Reassign owner, Stabilize, Demote, Push to LWQ owner, Nudge owner). KPI tiles include 14-day sparklines fed by a daily snapshot table. Filters: owner / team / tier (A/B/C/new from `companies.estimatedFreightSpend`) / health (stable/volatile/hot from `recurringLanes.laneScoreFactors.volatilityPenalty`) / trailing window (7/14/30 days). Backend service `server/leakConsoleService.ts` powers panels and KPI rollup; routes in `server/routes/leakConsole.ts` (panel feed, KPI + snapshot upsert, fix-action, audit log) gated by `isManagerial`. Every fix click writes a `leak_console_audit` row; surfacing fixes also write a `carrier_outreach_logs` row tagged `leak_console_*` so the Lane Inbox renders the action. Header buttons added to LWQ and AF deep-link managers in. Pure helpers covered by `server/__tests__/leakConsole.test.ts` (29 node:test cases).
-   **Self-Healing Mailbox Ingestion (Task #867)**: A `mailbox_health_watchdog` cron (every minute) classifies each monitored mailbox as `healthy` / `degraded` / `unhealthy` from the freshness of `lastInboxNotificationAt`, `lastSentItemsNotificationAt`, `lastSyncAt`, and the `subscriptionExpiresAt` headroom; degraded/unhealthy mailboxes are auto-resubscribed via `renewSingleMailboxSubscription`. Polling cadence is adaptive (`pollCadenceSeconds`: 300 healthy, 60 degraded/unhealthy) and the delta-sync cron now runs every minute but gates per-mailbox on `now ≥ lastSyncAt + cadence`. `mailbox_health_alerts` (with a partial unique index on open rows) dedupes admin notifications. Live-sync events (`mailbox_inbound`, `mailbox_outbound`) are published from `graphWebhook` so conversations refresh in <1s. Admin surface: `GET /api/admin/mailbox-health` + `POST /api/admin/monitored-mailboxes/:id/resubscribe`, plus per-row health badge and Resubscribe button on `/admin/monitored-mailboxes`.

### System Design Choices
The codebase adheres to a zero-new-error standard. Express handlers use helpers for normalizing `req.params` and `req.query`. AI chat conversation endpoints are user-scoped. The database schema includes tables for caching, contact suggestions, lane patterns, email conversations, proven tactics, and Webex integration. `freight_opportunities` and `load_fact` are canonical freight data sources. Performance is optimized via dashboard query optimization, server-side, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning and Carrier Ranker integration (`financial_uploads`, `load_fact`) are implemented. An `/admin/integrations-health` page monitors external integrations. LLM tooling runtime is in `server/agent/`, with control plane and autonomy layers in `server/agentic/`. Local authentication bypass is available for development.

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
-   **Clerk**: Authentication (production).