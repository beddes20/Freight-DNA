# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application designed to enhance the efficiency and effectiveness of transportation brokerage sales teams. It provides tools for managing customer accounts, contacts, organizational charts, and shipping data. The application includes robust RFP and Award management, advanced analytics, and AI-powered features to streamline workflows, improve customer relationship management, boost sales, and facilitate strategic account penetration, ultimately increasing revenue for transportation brokers. It features comprehensive role-based access control (RBAC).

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application uses a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, features blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The theme incorporates a black sidebar/header with amber gold accents and the Value Truck logo.

### Technical Implementations
FreightDNA is built on a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. It uses session-based authentication with dynamic RBAC. Key features include:
-   **CRM**: CRUD for companies and contacts with organizational charts and various intelligence fields.
-   **RFP & Award Management**: AI-assisted Excel uploads for RFPs and awards.
-   **Advanced Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
-   **User & Team Management**: Administration, hierarchy, and account reassignment.
-   **Data Integration**: Global search, OneDrive sync, and file attachments.
-   **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
-   **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
-   **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution (logging touchpoints, creating tasks), and AI email drafting using GPT-4o-mini.
-   **Next Best Action (NBA)**: Recommendation engine based on freight data rules.
-   **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach and email tracking.
-   **Spot Quote Search External Layering**: TRAC market band promoted as primary pricing benchmark with internal won-quote band kept as calibration; load_fact lane traffic, Carrier Hub outreach list, and geographic corridor chip layered into search results via parallel, independently-degrading lookups; TRAC results cached 1hr per (lane,equipment).
-   **Visibility Model**: Role and collaboration-based access control for managers and account collaborators.
-   **Carrier Hub**: Centralized carrier intelligence, contact management, and Carrier Reliability Score.
-   **Rate Intelligence & Rep Coaching**: SONAR-driven benchmarks and GPT-4o coaching cards.
-   **Email Intelligence**: Customer contact capture from emails, two-way carrier email integration via Microsoft Graph, and inbound email intent signal extraction.
-   **Conversations Inbox**: Org-scoped email thread management with ownership, priority, and tracking.
-   **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities with AI-derived suggestions.
-   **AI Intelligence Hub**: Unified dashboard for Meeting Prep Briefs, Sentiment Tracking, Smart Follow-Up Timing, Relationship Health Coaching, Org Chart Gap Analysis, Warm Introduction Paths, Look-Alike Prospecting, Cross-Sell / Lane Gap Intelligence, Wallet Share Expansion Playbook, Win/Loss Pattern Engine, and Competitive Signal Detection.
-   **Automated Processes**: Auto-sync customer emails via Microsoft Graph, Tactical Learning Engine for successful response approaches, Quote Request SLA Alerting, and Auto Weekly Account Review generation.
-   **Webex Calling Integration**: Click-to-Call, call history sync, missed call NBA cards, recording transcription with AI analysis, and real-time presence indicators.
-   **AI Center**: Consolidated admin module for managing AI agents, approvals, pods, and adapters.

### System Design Choices
The database schema includes tables for `lane_summary_cache`, `account_contact_suggestions`, `geographic_lane_patterns`, `email_conversation_threads`, `proven_tactics`, and `account_reviews`, among others. The "Available Freight" sheet is the canonical source for `freight_opportunities` and `load_fact`, with specific rules for status mapping and deduplication. Performance is optimized using dashboard query optimization, server-side caching, and in-memory caching. Key engineering patterns include visibility expansion for secure data access, a multi-layered caching strategy, keyset pagination, rate-limited external calls, background workers for scheduled tasks, and webhook-driven reactivity.

## External Dependencies
-   **PostgreSQL**: Primary database.
-   **xlsx (SheetJS)**: For Excel and CSV parsing.
-   **multer**: For file uploads.
-   **Leaflet**: For interactive mapping.
-   **OneDrive API (Microsoft Graph API)**: For financial data synchronization.
-   **node-cron**: For scheduling recurring jobs.
-   **Resend / GoDaddy SMTP**: For sending emails.
-   **OpenAI (GPT-4o / GPT-4o-mini / Whisper)**: For AI-assisted features including RFP column mapping, lane gap insights, email drafting, lane coaching cards, AI Intelligence Hub features, and call transcription.
-   **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook and auto-sync of customer emails.
-   **FreightWaves SONAR**: For market rate benchmarking and lane capacity signals.
-   **Webex Calling API**: For click-to-call, CDR history sync, presence lookup, and recording download.
-   **FreightWaves TRAC**: Primary source for lane-level spot rates, forecasts, and directional market signals.
-   **ZoomInfo**: For contact intelligence.
-   **Clerk**: For authentication.