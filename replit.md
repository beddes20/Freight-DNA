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
-   **Cross-Tab UX Layer**: Hover-card previews, deep-linking, SSE pub/sub for real-time updates across tabs, and a unified Lane Inbox feed.

### System Design Choices
The codebase maintains a zero-error typecheck baseline. All Express handlers normalize `req.params` and `req.query` using helpers. AI chat conversation endpoints are user-scoped to prevent data leaks. The database schema includes tables for caching, contact suggestions, lane patterns, email conversations, proven tactics, and Webex integration. `freight_opportunities` and `load_fact` are canonical freight data sources. Performance is optimized via dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented, and the Carrier Ranker integrates history from `financial_uploads` and `load_fact`.

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