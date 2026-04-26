# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application designed for transportation brokerage sales teams. Its primary purpose is to enhance efficiency, manage customer accounts, contacts, and shipping data, and improve overall customer relationship management. The platform aims to streamline workflows, boost sales, and facilitate strategic account penetration through features like RFP and Award management, advanced analytics, and AI-powered tools, ultimately increasing revenue. It includes comprehensive role-based access control.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, utilizes blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The chosen theme includes a black sidebar/header with amber gold accents and the Value Truck logo.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. It employs session-based authentication with dynamic Role-Based Access Control (RBAC). Key functionalities include:
-   **CRM**: Comprehensive CRUD operations for companies and contacts, supporting organizational charts and intelligence fields.
-   **RFP & Award Management**: AI-assisted Excel uploads for RFPs and awards.
-   **Advanced Analytics**: Capabilities for lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Features for administration, hierarchy management, and account reassignment.
-   **Data Integration**: Global search, OneDrive synchronization, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and AI email drafting.
-   **Next Best Action (NBA)**: A recommendation engine driven by freight data rules.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: Integration of TRAC market bands, internal won-quote bands, `load_fact` lane traffic, Carrier Hub outreach lists, and geographic corridor chips into search results.
-   **Visibility Model**: Role and collaboration-based access control for data.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture from emails, two-way carrier email integration, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with ownership, priority, tracking, AI summaries, and suggested next actions.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities with AI-derived suggestions.
-   **AI Intelligence Hub**: A unified dashboard providing Meeting Prep Briefs, Sentiment Tracking, Smart Follow-Up Timing, Relationship Health Coaching, Org Chart Gap Analysis, Warm Introduction Paths, Look-Alike Prospecting, Cross-Sell / Lane Gap Intelligence, Wallet Share Expansion Playbook, Win/Loss Pattern Engine, and Competitive Signal Detection.
-   **Automated Processes**: Auto-sync customer emails, Tactical Learning Engine, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history synchronization, missed call NBA cards, recording transcription with AI analysis, real-time presence, and voicemail management.
-   **AI Center**: A consolidated admin module for managing AI agents, approvals, pods, and adapters.
-   **Available Freight Cockpit**: A triage cockpit for freight opportunities, providing KPIs, ranked carrier chips, suggested buy rates, coverage, freshness, urgency scores, and bulk actions.
-   **Schema-Drift Guard**: Compares Drizzle schema against `information_schema` at boot to prevent schema drift.
-   **Cross-Tab UX Layer**: Hover-card previews on cross-link chips, "Find loads this carrier could cover" deep-link from Carrier Hub into Available Freight, claimed-lane scoring boost in the AF carrier picker, in-process SSE pub/sub (`/api/live-sync/stream`) that invalidates React Query keys across open tabs (Available Freight, Lane Work Queue, Carrier Hub, Customer Quotes), and a unified Lane Inbox feed (`/lane-inbox`) aggregating recent events from all four surfaces.

### System Design Choices
The codebase typechecks cleanly (`npx tsc --noEmit` is zero-error baseline). All Express handlers normalize untyped `req.params` / `req.query` strings through the `pStr` / `qStr` / `qOptStr` helpers in `server/lib/req.ts` rather than reading `req.params.x` directly. The AI chat conversation endpoints under `server/replit_integrations/chat` and `audio` are user-scoped (every read/write checks `chatConversations.userId === currentUser.id`) to prevent cross-user data leaks.

The database schema includes tables for `lane_summary_cache`, `account_contact_suggestions`, `geographic_lane_patterns`, `email_conversation_threads`, `proven_tactics`, `account_reviews`, and Webex integration tables. `freight_opportunities` and `load_fact` serve as canonical sources for freight data, with defined rules for status mapping and deduplication. Performance optimization is achieved through dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion for secure data access, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented to map senders to customers, using `quote_sender_mappings`. The Carrier Ranker integrates history from both `financial_uploads` and `load_fact`.

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