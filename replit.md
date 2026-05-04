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

### Workflow OS — Adoption Status & Bake Window (May 2026)
The Workflow OS spec (`docs/workflow-os-spec.md`) defines the canonical owner + pickup-scope filter contract, URL serialization, and stale-suppression behavior used across rep-facing work surfaces. Three surfaces are now on the canonical primitives (`OwnerFilterSelect`, `PickupScopeSelect`, `StaleCountChip`, savedViews helpers, shared queryKey shape):
-   **Available Freight (AF)** — original behavioral reference (Task #900).
-   **Lane Work Queue (LWQ)** — adopted in Task #917; `tests/code-quality-guardrails.test.ts` Section 26 pins conformance.
-   **Available Loads (AL)** — adopted in Task #918; `tests/code-quality-guardrails.test.ts` Section 27 pins conformance.

**Bake / stability window in effect on AF + LWQ + AL.** No new UX changes on these three surfaces during the bake. Acceptable changes are limited to: regressions, correctness fixes, and conformance gaps. Two known follow-ups are explicitly carved out and remain in scope during the bake:
-   AL `am_book` mode currently returns zero matches because `load_fact.customer` is text with no FK to companies. Reps still get `me` / `all` / `unassigned` / `specific`. A narrow follow-up will add a `customerName → company` resolver.
-   AL `BulkActionBar` adoption is deferred to Task #902 (outreach workspace rollout); the conformance exemption is documented in `client/src/lib/workflow-os/__tests__/conformance.test.ts`.

### Quote Pipeline Observability (Task #952 — May 2026)
Every email→quote attempt is now durably recorded so silent drops are no longer possible. The new `quote_pipeline_drops` table captures all five skip reasons (`outbound`, `duplicate`, `unparseable` from ingestion; `classifier_miss`, `exception` from the inline classifier) along with sender, subject, snapshot, and confidence. The recording is best-effort — a metrics-write failure can NEVER block customer-quote capture (try/catch in both helpers). Admin operator console at `/admin/quote-pipeline-health` exposes a 24-hour funnel (received → classified → captured), top drop reasons, and an actionable drops queue with one-click reprocess + resolve. The mailbox watchdog runs `runQuotePipelineHealthCheck` every tick and pages on two stable alert keys (`quote_pipeline_zero_capture`, `quote_pipeline_classifier_outage`) gated by `QUOTE_PIPELINE_CONSECUTIVE_TICKS` to avoid blip-driven noise. SSE freshness is end-to-end pinned: `quoteEmailIngestion.publish("customer_quote", opp.id)` → `quote-requests.tsx useLiveSync(["customer_quote", "email_thread"])`. Conformance is locked in `tests/code-quality-guardrails.test.ts` Section 29 (18 assertions). Files: `shared/schema.ts` (table + `QUOTE_PIPELINE_DROP_REASONS`), `server/routes/quotePipelineHealth.ts` (5 endpoints), `client/src/pages/admin-quote-pipeline-health.tsx`, `server/services/{quoteEmailIngestion,inlineEmailClassifier,mailboxWatchdogService}.ts`.

### Context Notes v1 — Anchored Collaboration (May 2026)
Task #950 introduces **context notes**: short, anchored, in-platform notes a rep can attach to a quote request, conversation thread, available-freight item, lane (LWQ), customer, or carrier so a teammate can pick up the work without leaving the surface. Each note has an action type (FYI / question / please review / please handle / decision needed), an open → acknowledged → resolved lifecycle, and an audit log. @-mentions fan out through the existing `notifications` table as `context_note_mention` / `context_note_reply` (surfaced in the bell + `/notifications` "Mentions" filter), and any note can be **converted into a task** in one click — the convert flow stamps `convertedTaskId` on the note and auto-resolves it. Schema lives in `shared/schema.ts` (4 tables); server in `server/contextNotes/{anchors,repo}.ts` + `server/routes/contextNotes.ts` (mounted at `/api/context-notes`); shared client primitives in `client/src/components/context-notes/` (always imported from the barrel — enforced by `scripts/check-context-notes-imports.ts`). Spec + ADR: `docs/context-notes.md`. Tests: `tests/context-notes.test.ts`. Load anchor reveal is deferred to v1.1 (no canonical load detail route yet).

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