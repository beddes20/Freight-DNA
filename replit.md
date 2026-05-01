# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a mini CRM application designed for transportation brokerage sales teams. Its primary purpose is to manage customer accounts, contacts, and shipping data to boost sales efficiency and strategic account penetration. The project aims to increase revenue through robust role-based access control, AI-driven insights, automated workflows, and real-time communication tools, with a strong focus on RFP and Award management and advanced analytics.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application utilizes a modern, responsive UI built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It supports dark/light mode, features a black sidebar/header with amber gold accents, and includes the Value Truck logo. Key UI components are KPI stat cards, a responsive sidebar, and consistent UI primitives for managing loading, empty, and error states. AI features are primarily consolidated under `/ai-hub`, with additional aliases for specific functionalities.

### Technical Implementations
FreightDNA is structured with a React frontend, an Express.js backend, and a PostgreSQL database managed with Drizzle ORM. It implements session-based authentication coupled with dynamic Role-Based Access Control (RBAC). Core functionalities include comprehensive CRM operations, AI-assisted RFP and Award management via Excel uploads, and advanced analytics for lane research, coverage gaps, and wallet share analysis. The system supports user and team management, data integration via global search and OneDrive sync, and various communication and collaboration tools. AI-powered features encompass generating talking points, health score narratives, touchpoint summaries, proactive nudges, AI action execution, and email drafting. A Next Best Action (NBA) engine provides daily task recommendations, while the Lane Work Queue (LWQ) manages assignable lane workflows with carrier outreach and email tracking. Advanced features include external layering for spot quote searches, a visibility model for access control, a Carrier Hub for intelligence, and Rate Intelligence with AI coaching. Email Intelligence captures customer contacts, integrates two-way carrier emails, and extracts intent signals. An Org-scoped Conversations Inbox offers AI summaries and suggested actions using a hybrid sync approach. The Quote Lifecycle Autopilot automates quote processing, and Geographic Lane Patterns define corridor behaviors. Automated processes include email syncing, a Tactical Learning Engine, and auto-generated weekly account reviews. Webex Calling is integrated for telephony, and a Call Performance Hub provides manager oversight. An AI Center manages AI agents, and specialized cockpits handle available freight and won loads. Schema-Drift Guard ensures database consistency. The system also includes a Capture Leak Queue for managing missed emails and a Cross-Tab UX Layer for enhanced navigation and real-time updates. The Quote Request System has been overhauled for improved operator efficiency, including a detailed Task #850 implementation with refined display, filtering, and deep-linking capabilities. Leakage diagnostics and freshness improvements for conversation threads are also in place, alongside a Manager Leak Console for identifying and resolving operational inefficiencies. Self-healing mailbox ingestion ensures continuous email synchronization, and a daily snapshot scheduler populates manager KPIs.

### System Design Choices
The codebase adheres to a "zero-new-error" philosophy. Express handlers are designed with helpers for request parameter normalization. AI chat conversations are user-scoped, and the database schema is optimized for caching, contact suggestions, lane patterns, and email conversations. Key data sources are `freight_opportunities` and `load_fact`. Performance is enhanced through dashboard query optimization, server-side, and in-memory caching. Engineering patterns involve visibility expansion, multi-layered caching, keyset pagination, rate-limited external calls, background workers, and webhook-driven reactivity. Customer sender domain learning and Carrier Ranker integration are integral. An admin page (`/admin/integrations-health`) monitors external service health. LLM tooling is split into `server/agent/` for runtime and `server/agentic/` for control and autonomy layers.

## External Dependencies
-   **PostgreSQL**: Primary data store.
-   **SheetJS (xlsx)**: For Excel and CSV parsing.
-   **multer**: Handles file uploads.
-   **Leaflet**: Provides interactive mapping functionalities.
-   **OneDrive API (Microsoft Graph API)**: Synchronizes financial data.
-   **node-cron**: Schedules recurring tasks.
-   **Resend / GoDaddy SMTP**: Manages email sending.
-   **OpenAI (GPT-4o, GPT-4o-mini, Whisper)**: Powers AI-assisted features.
-   **Microsoft Graph API (Outlook)**: Facilitates two-way carrier email integration and customer email auto-sync.
-   **FreightWaves SONAR**: Offers market rate benchmarking and lane capacity insights.
-   **Webex Calling API**: Integrates telephony features.
-   **FreightWaves TRAC**: Provides spot rates, forecasts, and market signals.
-   **ZoomInfo**: Supplies contact intelligence.
-   **Clerk**: Manages authentication in production environments.