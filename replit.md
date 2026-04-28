# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application designed for transportation brokerage sales teams. Its primary purpose is to enhance efficiency, manage customer accounts, contacts, and shipping data, thereby streamlining workflows and boosting sales. The platform aims to facilitate strategic account penetration through RFP and Award management, advanced analytics, and AI-powered tools, ultimately increasing revenue. It includes comprehensive role-based access control and offers capabilities like AI-driven insights, automated processes, and real-time communication tools.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, utilizes blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The chosen theme includes a black sidebar/header with amber gold accents and the Value Truck logo. Shared UI primitives (`<Skeleton />`, `<EmptyState />`, `<ErrorBanner />`) are used for consistent loading, empty, and error states.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM, employing session-based authentication with dynamic Role-Based Access Control (RBAC). Key functionalities include:
-   **CRM**: Comprehensive CRUD for companies and contacts, supporting organizational charts.
-   **RFP & Award Management**: AI-assisted Excel uploads.
-   **Advanced Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Administration, hierarchy management, and account reassignment.
-   **Data Integration**: Global search, OneDrive synchronization, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and AI email drafting.
-   **Next Best Action (NBA)**: A recommendation engine driven by freight data rules, surfaced in a "Daily Priorities Workspace".
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: Integration of market bands, internal won-quote bands, lane traffic data, Carrier Hub outreach lists, and geographic corridor chips.
-   **Visibility Model**: Role and collaboration-based access control for data.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture, two-way carrier email integration, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with AI summaries and suggested actions. Graph mailbox subscriptions are renewed by a `node-cron` schedule running every 6 hours (clock-anchored, survives workflow restarts), and the boot pass proactively renews anything expiring within 24 hours rather than only re-registering already-expired subs. Admins can hit the new "Renew subscriptions now" button in the Capture Audit Status pill (`POST /api/internal/admin/conversations/renew-mailbox-subscriptions`) to recover instantly without waiting for the next cron tick. This combination eliminates the recurring "Webhook unhealthy" pill that used to appear whenever the app restarted more than once per 48h (the previous `setInterval(..., 48h)` renewer would reset on every restart and never fire before the 70h subscription TTL expired).
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities.
-   **AI Intelligence Hub**: A unified dashboard providing various AI-driven insights.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history synchronization, recording transcription with AI analysis, and real-time presence.
-   **Call Performance Hub**: Unified org-wide telephony page for managers.
-   **AI Center**: A consolidated admin module for managing AI agents, approvals, and adapters.
-   **AI Hub** (Task #742): Single tabbed page at `/ai-hub` consolidating the chat-style AI surfaces (Today's Priorities, ValueIQ, AI Center, AI Engagement, Copilot Analytics) under one sidebar entry "AI". Tab visibility is role-gated per surface; the union of every tab's role list (`AI_HUB_ANY_TAB_ROLES`) controls whether the sidebar row appears at all. The five legacy URLs (`/daily-priorities`, `/valueiq`, `/ai`, `/admin/ai-engagement`, `/admin/copilot-analytics`) all resolve to the hub with the matching tab pre-selected via `resolveAiHubTab(pathname, search)` — no redirects, no breaking bookmarks. Composition-only: each tab mounts the existing page component unchanged. Email Intelligence (`/email-intelligence`) and Contact Suggestions (`/contact-suggestions`) were initially folded into the hub but were promoted back to standalone Customer-Facing sidebar entries because they're domain analytics dashboards rather than chat surfaces.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot.
-   **Cross-Tab UX Layer**: Hover-card previews, deep-linking, SSE pub/sub for real-time updates across tabs, and a unified Lane Inbox feed with cross-tab navigation.
-   **Universal Flow Primitives** (de-siloing pass):
    -   **Command palette** (`client/src/components/command-palette.tsx`): cmd-K (or `/`) anywhere opens a `CommandDialog` with Recents → Actions (Log touchpoint, New task, New quote, Toggle dark mode, Sign out) → Go-to (every visible nav destination, derived from `client/src/lib/nav-items.ts` — single source consumed by both palette and `app-sidebar.tsx`) → live `/api/search` results. Recents persist in `localStorage.cmdk_recents_v1`. Mounted globally in `App.tsx`; `global-search.tsx` is now just a search-shaped trigger that calls `openCommandPalette()`.
    -   **DetailDrawer + EntityLink** (`client/src/components/detail-drawer.tsx`, `client/src/components/entity-link.tsx`): every customer / carrier / lane reference, anywhere in the app, should be wrapped in `<EntityLink kind="customer|carrier|lane" id name>`. Hover (400ms) shows a tiny preview card; click opens an in-place right-rail drawer (`Sheet side="right" w-[480px]`, max stack depth 2); Cmd/Ctrl-click navigates to the full page. Drawer body content is contributed per-kind via `registerDrawerRenderer()` (e.g., `customer-drawer-body.tsx` registers the customer body with overview / open quotes / recent touchpoints sections). Provider mounted once at app root.
    -   **Badge vs Bell rule**: the header bell (`notification-bell.tsx`) is the single attention stream — popover ships filter chips (All · Tasks · Quotes · Lanes · AI · Conversations · System; mapping table `TYPE_TO_FILTER`) and a "View all in Inbox" link to `/notifications`. Per-row sidebar counts (e.g., Customer Quotes pill) are NOT attention signals — they are navigational state hints describing what's inside that page. New PRs introducing a sidebar badge must justify it as page-state, not as a notification surface.

### System Design Choices
The codebase maintains a zero-error typecheck baseline. Express handlers normalize `req.params` and `req.query` using helpers. AI chat conversation endpoints are user-scoped. The database schema includes tables for caching, contact suggestions, lane patterns, email conversations, proven tactics, and Webex integration. `freight_opportunities` and `load_fact` are canonical freight data sources. Performance is optimized via dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented, and the Carrier Ranker integrates history from `financial_uploads` and `load_fact`. A dedicated `/admin/integrations-health` page provides live status for external integrations, polling health probes and notifying administrators of degraded services. Reusable handler helpers (`requireUser`, `pStr`, `qStr`, etc.) enforce consistent request parsing, authentication, and error handling across routes.

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