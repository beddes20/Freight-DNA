# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application designed to enhance the efficiency and sales workflows of transportation brokerage sales teams. It focuses on managing customer accounts, contacts, and shipping data, facilitating strategic account penetration through RFP and Award management, advanced analytics, and AI-powered tools. The platform aims to increase revenue by providing comprehensive role-based access control, AI-driven insights, automated processes, and real-time communication tools.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application utilizes a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, features a black sidebar/header with amber gold accents, incorporates the Value Truck logo, KPI stat cards, and a responsive sidebar. Consistent loading, empty, and error states are managed through shared UI primitives. The primary AI user destination is `/ai-hub`, with `/daily-priorities`, `/admin/copilot-analytics`, and `/admin/ai-engagement` serving as aliases that resolve to the `AiHubPage`.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. It employs session-based authentication with dynamic Role-Based Access Control (RBAC). Key features include:
-   **CRM**: CRUD operations for companies and contacts.
-   **RFP & Award Management**: AI-assisted Excel uploads.
-   **Advanced Analytics**: Lane research, coverage gap analysis, lane pattern analysis, historical data, and wallet share.
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
-   **Conversations Inbox**: Org-scoped email thread management with AI summaries and suggested actions. Email synchronization uses a hybrid real-time webhook and polling model, with robust background job monitoring and recovery mechanisms.
-   **Quote Lifecycle Autopilot**: Automates quote processing, including email ingestion and outbound reply analysis.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities.
-   **AI Intelligence Hub**: A unified dashboard for various AI-driven insights.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history synchronization, recording transcription with AI analysis, and real-time presence.
-   **Call Performance Hub**: Unified org-wide telephony page for managers.
-   **AI Center**: Consolidated admin module for managing AI agents, approvals, and adapters.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities.
-   **Won Load Autopilot**: Automates the conversion of won quotes into freight opportunities, triggering notifications and an approval modal.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot.
-   **Capture Leak Queue**: Manages missed inbound/orphan outbound emails with admin actions for review, manual quote creation, attaching orphan outbounds to existing quotes, and analytics. Attach action writes a paired `quote_events` (`actor='manual_leak_attach'`) + `capture_leak_reviews` (`decision='attached'`) audit row, decrements the diagnostics counter in lock-step, and surfaces an "attached" segment in the analytics mix; gated to admin/director/sales_director with an in-process mutex preventing duplicate-attach races.
-   **Cross-Tab UX Layer**: Provides hover-card previews, deep-linking, SSE pub/sub for real-time updates, and a unified Lane Inbox feed with cross-tab navigation.
-   **Universal Flow Primitives**: Includes a command palette for quick actions and navigation, and consistent `DetailDrawer` and `EntityLink` patterns.
-   **Quote Requests post-2d UX/IA spec + backend contract**: `docs/quote-requests-tab-post-2d-spec.md` is the UX/IA design contract for the operator surface that replaces `customer-quotes.tsx` once Phase 2b/2c/2d are stable. `docs/quote-requests-tab-post-2d-backend-contract.md` is the locked backend implementation contract for Task #849. Three Canvas mockups in `artifacts/mockup-sandbox/src/components/mockups/quote-requests-post-2d/` (`PopulatedList.tsx`, `RowAndDetailDrawer.tsx`, `EmptyState.tsx`) visualize populated list, detail drawer, and empty state. **Backend contract status (Task #849):** S1 ownership gate (`assertCanMutateQuote`) and S2-S6 endpoints are now LIVE. The five new write paths are: `POST /api/customer-quotes/quote/:id/attach-to` (re-attach gated to admin/director/sales_director, mutex `_attachQuoteInFlight`, paired `quote_events`/`capture_leak_reviews` audit), `POST /api/customer-quotes/quote/:id/send-to-leak` (mutex `_sendToLeakInFlight`, optional sender suppression via `findOrCreateSentToLeakReason`/`quote_sender_mappings.suppressed`, ingestion-side short-circuit lives in `quoteOpportunityFromSignalService.processOneSignal` via `findSuppressionMapping`), `PATCH /api/customer-quotes/quote/:id/snooze` (`SNOOZE_MAX_FUTURE_MS = 14 days`, NULL clears), `GET /api/quote-requests/automation-counters` (gated to admin/director/sales_director, `AUTOMATION_COUNTERS_TTL_MS = 30s` Cache-Control), and `POST /api/email-conversations/:threadId/reply` (resolves via `resolveSmartPaneTarget`, derives from-mailbox from latest inbound, refuses with `from_mailbox_not_monitored` 422 if not on `monitored_mailboxes`, sends via `sendOutlookEmail` and immediately `applyMessageToThread`). §3.7 leakage-stats classifier amendment (`OR EXISTS qo.source_reference = e.provider_message_id`) is present in BOTH `computeWindow` and `computeTopLeakingDomains` CTEs. All invariants are fenced by Section 17 of `tests/code-quality-guardrails.test.ts` (19 assertions). Task #850 (UI build) is now unblocked.
-   **Quote-Request Leakage Diagnostic (Phase 2a — "Make the leak visible.")**: Read-only `GET /api/admin/conversations/leakage-stats` endpoint surfaces, for the requesting admin's org, the % of inbound customer `pricing_request` / `quote_request` email signals (last 24h, last 7d) that failed to materialize a tracked `quote_opportunities` row AND weren't acknowledged via `capture_leak_reviews`. Categorization is mutually exclusive with priority `with_opportunity > in_leak_queue > leaked`; opportunity link is detected via either `email_signals.linked_opportunity_id` or `quote_opportunities.source_reference = email_messages.provider_message_id`. Powers a new "Quote-request leakage" tile on `/admin/integrations-health` (refreshes 60s) showing two window cards + top-10 leaking sender domains. Gated to admin/director/sales_director; org-isolated via `email_messages.org_id`. Drives no automation — exists so we can watch the rate for a few normal business days before Phase 2b (forward closure) is turned on. Regression test `tests/conversations-leakage-stats.test.ts` validates bucket math, window monotonicity, and exact match to an independent SQL aggregate.
-   **Conversations Freshness (Phase 1 — "Stop lying about freshness.")**: User-facing freshness labels and sort comparators in the Conversations / Quote Requests UI no longer read `email_conversation_threads.updated_at` (a row-touched-by-anything clock bumped by background workers — diagnostic showed 87% of bumps were noise, avg drift +134h). The list endpoint now ships a server-computed `lastEmailAt = MAX(email_messages.provider_sent_at)` per thread (single batched aggregate per page) plus the existing `lastIncomingAt` / `lastOutgoingAt` denorm columns. Thread rows render two precise timestamps ("Customer replied …" / "You replied …"), `applyMessageToThread` now anchors the denorm columns to `message.providerSentAt` instead of wall-clock `now()`, and a one-time idempotent backfill in `runMigrations` heals legacy rows from `MAX(provider_sent_at)` per direction. A guardrail in `tests/code-quality-guardrails.test.ts` (Section 15) and a regression test (`tests/conversations-freshness-regression.test.ts`) fence the seam.
-   **Customer Quotes Display Resolution**: Rep name resolution is layered: (1) source email `to_email` → `users.username` → `users.name` for email-ingested quotes (bypasses funnel-eligibility hiding when the linked user is AM/NAM), (2) `quote_reps.userId` → `users.name`, (3) `quote_reps.email` → `users.username` → `users.name`, (4) `quote_reps.name`, (5) "Unassigned" only as last-resort empty state. Customer name display upgrades sluggified `quote_customers.name` strings to canonical CRM `companies.name` via a conservative two-tier match (exact normalized → prefix-uniqueness with ≥3 char extension); ambiguous prefixes and near-misses are intentionally left as-is. `findOrCreateRep` now persists `quote_reps.user_id` on insert and self-heals existing rows on access. A `runMigrations` boot-time backfill links any orphan `quote_reps` whose email matches a customer-facing `users.username`.

### System Design Choices
The codebase maintains a zero-new-error standard for new work, with existing TypeScript errors being tracked for future resolution. Express handlers use helpers for normalizing `req.params` and `req.query`. AI chat conversation endpoints are user-scoped. The database schema includes tables for caching, contact suggestions, lane patterns, email conversations, proven tactics, and Webex integration. `freight_opportunities` and `load_fact` serve as canonical freight data sources. Performance is optimized through dashboard query optimization, server-side, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented, and the Carrier Ranker integrates history from `financial_uploads` and `load_fact`. A dedicated `/admin/integrations-health` page monitors external integrations. `server/agent/` provides the LLM tooling runtime, while `server/agentic/` handles the control plane and autonomy layers; both are complementary. For development and testing, a specific `if (!IS_PROD)` block in `server/auth.ts` allows for local authentication bypass, separate from the production Clerk authentication.

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