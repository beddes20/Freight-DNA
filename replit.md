# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application designed for transportation brokerage sales teams. Its primary goal is to boost efficiency, streamline sales workflows, and manage customer accounts, contacts, and shipping data. The platform aims to facilitate strategic account penetration through RFP and Award management, advanced analytics, and AI-powered tools, ultimately increasing revenue. It incorporates comprehensive role-based access control, AI-driven insights, automated processes, and real-time communication tools.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, utilizes blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The chosen theme includes a black sidebar/header with amber gold accents and the Value Truck logo. Shared UI primitives are used for consistent loading, empty, and error states.

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
-   **Conversations Inbox**: Org-scoped email thread management with AI summaries and suggested actions, featuring a hybrid real-time webhook and polling email sync model. Background jobs are observability-instrumented via `withHeartbeat()` (`server/lib/cronHeartbeat.ts`); the Capture Audit Status pill flags both standard staleness AND stuck-running corpses (a tick whose `lastStatus="running"` exceeds the per-job-class threshold from `getStuckRunningThresholdMs` — `max(intervalMs*3, 6 min)` for critical pipeline jobs, `max(intervalMs*5, 10 min)` for non-critical). Admins have manual recovery hatches: "Sync mail now", "Renew subscriptions now", and "Run AI batch now" buttons that bypass cron timing and trigger immediate ticks (each guarded against duplicate invocation). The `email_intelligence_batch` job is hardened against silent stalls with three layered protections: (1) every OpenAI `chat.completions.create` call passes `{ timeout: 60_000, maxRetries: 1 }` instead of the SDK's 10-min default, (2) a process-wide `_batchInFlight` mutex makes initial/cron/manual ticks share one slot — overlapping ticks log `skipping <source> tick: previous batch still running` instead of piling up, (3) every batch body races against `BATCH_WALL_CLOCK_MS = 5 * 60 * 1000` via `runWithWallClock()` (`server/emailIntelligenceScheduler.ts`). The wall clock uses **cooperative cancellation via AbortSignal**: on timeout the controller is aborted (canceling the in-flight OpenAI HTTP request, which honors `signal` in its RequestOptions) AND the batch loop checks `signal.aborted` between iterations to exit cleanly — so the orphaned body cannot keep running in the background and overlap with the next tick. The heartbeat row records `error: email_intelligence_batch exceeded 300000ms wall clock` and the in-flight flag is cleared so the next tick starts fresh. Test helpers `_isBatchInFlightForTests`, `_resetBatchInFlightForTests`, `_getBatchWallClockMsForTests`, `_runWithWallClockForTests`, and `_BatchTimeoutErrorForTests` are exported for regression coverage in `tests/email-sync-cadence.test.ts` (section 7b).
-   **Quote Lifecycle Autopilot**: Automates quote processing from email ingestion, outbound reply analysis, and no-response timeouts.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities.
-   **AI Intelligence Hub**: A unified dashboard for various AI-driven insights.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history synchronization, recording transcription with AI analysis, and real-time presence.
-   **Call Performance Hub**: Unified org-wide telephony page for managers.
-   **AI Center**: Consolidated admin module for managing AI agents, approvals, and adapters.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities.
-   **Won Load Autopilot**: Automates the conversion of won quotes into freight opportunities, triggering notifications and an approval modal.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot.
-   **Cross-Tab UX Layer**: Hover-card previews, deep-linking, SSE pub/sub for real-time updates across tabs, and a unified Lane Inbox feed with cross-tab navigation.
-   **Universal Flow Primitives**: Includes a command palette for quick actions and navigation, and a consistent `DetailDrawer` and `EntityLink` pattern.

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
## Architecture Clarifications (read before deleting anything)

### Auth boundary

-   In production (`NODE_ENV === "production"`), **Clerk is the only auth system**.
-   `server/auth.ts` always calls `clerkMiddleware()` first on every request, and `client/src/App.tsx` wraps the entire app in `<ClerkProvider>`.
-   The session + `password_reset_tokens` + bcrypt path inside `server/auth.ts` is wrapped in `if (!IS_PROD) { ... }` and exists **only** for: dev/test login, the `DEV_AUTH_BYPASS_USER_ID` developer convenience, and keeping the automated test suite working.
-   This is **not** "hybrid auth in production." Do **not** delete `server/auth.ts` thinking it is unused legacy production code — removing it will break local development and the test suite.

### Agent vs agentic layering

-   `server/agent/` is the **LLM tooling runtime**: prompts, tool dispatch, retrieval and memory primitives, the OpenAI client, persona, classifier, router. It is the lower-level library the AI features sit on top of.
-   `server/agentic/` is the **control plane / HITL / autonomy layer**: agent registry, autonomy levels, human-in-the-loop approvals, outcome tracking, AI Center routes.
-   They are **complementary layers, not "old vs new."** Many features depend on both — weekly account reviews, ValueIQ, conversation thread suggestions and summaries, and the AI Center all import from one or the other (and several from both).
-   Do **not** "pick a winner" and delete the other folder. Renaming either one is also risky because importers across `server/routes/`, `server/services/`, and the schedulers reference the directory names directly.

### AI Hub and "today" surfaces

-   `/ai-hub` is the **canonical AI user destination** (driven by `aiHubItem` in `client/src/lib/nav-items.ts` and rendered as `AiHubPage`).
-   `/daily-priorities`, `/admin/copilot-analytics`, and `/admin/ai-engagement` are **aliases** — all three already resolve to `AiHubPage` in `client/src/App.tsx` with the matching tab pre-selected via `resolveAiHubTab` (Task #742). Do not treat them as separate pages.
-   `/ai/*` (e.g. `/ai/agents`, `/ai/pods`, `/ai/admin`, `/ai/approvals`, `/ai/adapters`) is the **agentic control plane** (admin/ops surface for AI agents), **not** where reps do their daily work.
-   `/ai-intelligence-legacy` is a **defensive fallback** to the older AI page. Do **not** delete it without first measuring usage telemetry.
-   For "work my day" there are only **two real surfaces**: `/today` (`TodayQueuePage`) and `/dashboard` (`Dashboard`). The home route `/` reads the user's `prefersToday` preference in `HomeLandingRouter` and redirects accordingly. `/daily-priorities` is **not** a third "today" surface — it is the AI Hub alias described above.
