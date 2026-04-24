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
The database schema includes tables for `lane_summary_cache`, `account_contact_suggestions`, `geographic_lane_patterns`, `email_conversation_threads`, `proven_tactics`, `account_reviews`, and Webex integration tables. `freight_opportunities` and `load_fact` are canonical sources for freight data. Performance optimization is achieved through dashboard query optimization, server-side caching, and in-memory caching. Engineering patterns include visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning is implemented to map senders to customers, using `quote_sender_mappings`. The Carrier Ranker now integrates history from both `financial_uploads` and `load_fact` for comprehensive carrier shortlisting.

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