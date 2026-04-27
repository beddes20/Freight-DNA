# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application designed for transportation brokerage sales teams to enhance efficiency, manage customer accounts, contacts, and shipping data. It aims to streamline workflows, boost sales, and facilitate strategic account penetration through RFP and Award management, advanced analytics, and AI-powered tools, ultimately increasing revenue. The platform includes comprehensive role-based access control.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, utilizes blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The chosen theme includes a black sidebar/header with amber gold accents and the Value Truck logo.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM, employing session-based authentication with dynamic Role-Based Access Control (RBAC). Key functionalities include:
-   **CRM**: Comprehensive CRUD for companies and contacts, supporting organizational charts.
-   **RFP & Award Management**: AI-assisted Excel uploads for RFPs and awards.
-   **Advanced Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Administration, hierarchy management, and account reassignment.
-   **Data Integration**: Global search, OneDrive synchronization, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and AI email drafting.
-   **Next Best Action (NBA)**: A recommendation engine driven by freight data rules, surfaced in a "Daily Priorities Workspace" at `/daily-priorities` with real-time updates and keyboard navigation.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking, featuring optimized carrier ranking and persistent filter state.
-   **Spot Quote Search External Layering**: Integration of market bands, internal won-quote bands, lane traffic data, Carrier Hub outreach lists, and geographic corridor chips.
-   **Visibility Model**: Role and collaboration-based access control for data.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture, two-way carrier email integration, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with AI summaries and suggested actions.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities.
-   **AI Intelligence Hub**: A unified dashboard providing various AI-driven insights like Meeting Prep Briefs, Sentiment Tracking, and Relationship Health Coaching.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history synchronization, missed call NBA cards, recording transcription with AI analysis, and real-time presence.
-   **Call Performance Hub**: Unified org-wide telephony page at `/calls` for managers, presenting pace cards, trendlines, and quality scorecards.
-   **AI Center**: A consolidated admin module for managing AI agents, approvals, and adapters.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities, providing KPIs, ranked carrier chips, suggested buy rates, and bulk actions.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot.
-   **Cross-Tab UX Layer**: Hover-card previews, deep-linking, SSE pub/sub for real-time updates across tabs, and a unified Lane Inbox feed. Cross-tab navigation between the four lane surfaces (Available Freight, Lane Work Queue, Carrier Hub, Lane Inbox) uses a shared `<CrossTabBreadcrumb />` (`client/src/components/freight/cross-tab-breadcrumb.tsx`) that renders a single-hop breadcrumb when the URL carries a `?from=<sourceSlug>` query param (and an optional `&fromQuery=<encoded>` capturing the source page's filter state). Cross-link chips append these params via the `appendCrossTabFromParam` helper so the back-link restores the source page's query/filter context. Direct visits (no `from` param) render nothing — no extra vertical space.

### System Design Choices
The codebase maintains a zero-error typecheck baseline. All Express handlers normalize `req.params` and `req.query` using helpers. AI chat conversation endpoints are user-scoped to prevent data leaks. The database schema includes tables for caching, contact suggestions, lane patterns, email conversations, proven tactics, and Webex integration. `freight_opportunities` and `load_fact` are canonical freight data sources. Performance is optimized via dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented, and the Carrier Ranker integrates history from `financial_uploads` and `load_fact`.

#### Shared loading / empty / error UI primitives
Pages and cards use three shared primitives so loading, empty, and error states feel consistent:
-   **`<Skeleton />`** (`@/components/ui/skeleton`) — shimmer placeholder. Compose multiple skeletons that mirror the final layout.
-   **`<EmptyState />`** (`@/components/ui/empty-state`) — friendly explanation with optional icon, title, description, and action button (`onClick` or `href`). Supports a `compact` variant for inline contexts (table rows, small cards). Always pass `testId` for e2e selectors.
-   **`<ErrorBanner />`** (`@/components/ui/error-banner`) — alias re-export of the existing `QueryError` component (`client/src/components/query-error.tsx`). Renders an amber banner with retry button; supports a `compact` variant. Wire `onRetry={() => refetch()}` so users recover without a page reload.

Surfaces standardized in Task #694: `/daily-priorities`, `/customer-quotes` (snapshot/list error + empty filtered table), `/lane-inbox`, `/lanes/work-queue`, plus `CallActivityTrendline`, `CallPaceCard`, `CallQualityPanel`, `CallQualityPortlet`, and `CallQualityDrillIn` on `/calls`. Future pages should import from `@/components/ui/empty-state` and `@/components/ui/error-banner` rather than hand-rolling empty divs or destructive banners. Section 10 of `tests/code-quality-guardrails.test.ts` enforces presence of these components and their wiring on the standardized surfaces.

#### Sidebar AI grouping (Task #693)
The sidebar consolidates the three AI-related entries — **Today's Priorities** (`/daily-priorities`), **ValueIQ** (`/valueiq`), and **AI Center** (`/ai`) — under a single collapsible **AI** group in `client/src/components/app-sidebar.tsx` (`aiItems` array). Each entry keeps its own role list (`DAILY_PRIORITIES_ROLES`, `VALUEIQ_ROLES`, `AI_CENTER_ROLES`), so role gating is unchanged. The group is open by default and persists its expand/collapse state in `localStorage` under the key `sidebar-ai-open`. Today's Priorities still renders the green NBA daily-workspace badge inside the new group; Customer Quotes keeps its amber stale-followup badge in Customer-Facing. Email Intelligence intentionally stays in Customer-Facing because it is an inbox surface, not an AI workspace.

#### Reusable handler helpers (Task #695)
Express routes use a small, enforced set of helpers so request parsing, auth, and error handling stay uniform across the ~50 route modules:
-   **`requireUser`** (`server/auth.ts`) — middleware that runs `requireAuth` then resolves and attaches the current `User` to `req.user`. Routes use `app.get(path, requireUser, async (req, res) => …)` and read `req.user!` directly instead of repeating `getCurrentUser` + null-check blocks (~110 boilerplate blocks were collapsed). The Express `Request` type is augmented in `server/auth.ts` so `req.user` is fully typed across the codebase.
-   **`pStr`, `qStr`, `qOptStr`, `qStrArr`, `qInt`, `qBool`, `extractListFilters`** (`server/lib/req.ts`) — typed accessors for `req.params` and `req.query`. They normalize the unknown / `string | string[]` shape Express returns, throw `400` on missing required values, and (for `qInt` / `qBool`) coerce + validate. `extractListFilters({ search, status, … })` is the canonical one-liner for list endpoints. Raw `req.params.X` / `req.query.X` reads are banned in route files.
-   **`getErrorMessage`** (`server/lib/errors.ts`) — already required in catch blocks; legacy patterns like `(err as Error).message` and `err instanceof Error ? err.message : ''` are now also banned in route files.

Sections 11 (directory-wide route hygiene — scans every file under `server/routes/**` for raw param/query reads and legacy error patterns) and 12 (helper presence — verifies `extractListFilters`, `qInt`, `qBool`, the `requireUser` middleware, and the `Request.user` augmentation all exist) of `tests/code-quality-guardrails.test.ts` enforce these conventions on every commit.

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