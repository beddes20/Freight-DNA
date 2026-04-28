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
-   **Email Intelligence**: Customer contact capture, two-way carrier email integration, inbound email intent signal extraction, and conversations inbox with AI summaries and suggested actions. Email sync uses a hybrid model of real-time webhooks and 5-minute polling for reliability.
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