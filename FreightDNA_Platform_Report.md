# FreightDNA — Platform Report
**Date:** April 26, 2026  
**Version:** Current main branch (commit `3f76c3d`)

---

## 1. Platform Overview

FreightDNA is a specialized mini-CRM built for transportation brokerage sales teams. It centralizes account management, contact intelligence, freight data, carrier operations, and AI-driven sales tooling into a single platform. The goal is to compress the sales cycle, improve account penetration, and surface the next best action for every rep at every moment.

---

## 2. Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Wouter routing |
| Backend | Node.js, Express.js, TypeScript |
| Database | PostgreSQL via Drizzle ORM |
| Auth | Clerk (session-based, with RBAC overlay) |
| AI | OpenAI GPT-4o / GPT-4o-mini / Whisper |
| Email | Microsoft Graph API (Outlook), Resend, GoDaddy SMTP |
| Real-Time | Server-Sent Events (SSE) pub/sub (`/api/live-sync/stream`) |
| Scheduling | node-cron |
| File Uploads | multer + SheetJS (xlsx) |
| Mapping | Leaflet |
| External Data | FreightWaves SONAR, FreightWaves TRAC, ZoomInfo, Webex Calling API, OneDrive (Microsoft Graph) |

**Theme:** Black sidebar/header with amber gold accents, Value Truck logo, responsive layout with dark/light mode support.

---

## 3. Codebase Scale

| Artifact | Count / Size |
|---|---|
| Route modules (`server/routes/*.ts`) | 51 modules |
| Test files (`tests/`) | 33 files (`.ts` + `.cjs`) |
| `shared/schema.ts` | ~5,620 lines |
| `server/routes.ts` (orchestrator) | ~9,597 lines |
| `server/storage.ts` exported methods | 16 top-level exports |

---

## 4. Feature Surface

### 4.1 CRM Core
- Full CRUD for companies and contacts, including organizational chart structure and intelligence fields
- Onboarding milestone tracking per account
- Pinned companies and shared rep assignments
- Touchpoint logging, recency tracking, and engagement alerts
- Global search across companies, contacts, and lanes

### 4.2 RFP & Award Management
- Excel/CSV upload for RFPs with AI-assisted column mapping (GPT-4o)
- Award lane parsing and wallet share upload
- Rate limiting on all upload endpoints (`aiPreviewRateLimit`, `bulkImportRateLimit`)

### 4.3 Analytics & Intelligence
- Lane research and facility coverage gap analysis
- Lane pattern analysis and historical freight data review
- Wallet share tracking and expansion playbooks
- High-frequency lane detection
- Win/loss pattern engine

### 4.4 AI-Powered Features
- AI-generated talking points and health score narratives
- Touchpoint summaries and proactive nudges
- AI email drafting with context from account history
- Meeting prep briefs
- Sentiment tracking and smart follow-up timing
- Relationship health coaching cards
- Org chart gap analysis and warm introduction paths
- Look-alike prospecting
- Cross-sell / lane gap intelligence
- Competitive signal detection

### 4.5 Next Best Action (NBA)
- Rule-based recommendation engine driven by freight data
- Missed call NBA cards (Webex integration)
- Proactive opportunity surfacing

### 4.6 Lane Work Queue (LWQ)
- Assignable lane workflow with status tracking
- Carrier outreach integrated directly into lane records
- Email tracking per lane
- Virtualized list rendering for large queues

### 4.7 Available Freight Cockpit
- Triage cockpit for inbound freight opportunities
- KPI header cards, ranked carrier chips, suggested buy rates
- Coverage, freshness, and urgency scores
- Bulk actions and make-recurring capability
- SSE-driven refresh pill for live updates

### 4.8 Carrier Hub
- Centralized carrier intelligence and contact management
- Carrier Reliability Score
- "Find loads this carrier could cover" deep-link into Available Freight
- Carrier history ingested from both `financial_uploads` and `load_fact`
- Two-way carrier email integration via Microsoft Graph webhook

### 4.9 Conversations Inbox
- Org-scoped email thread management
- Ownership assignment, priority flags, read/unread tracking
- AI summaries and suggested next actions per thread
- Monitored mailboxes with historical backfill
- Inbound email intent signal extraction
- Customer sender domain learning (`quote_sender_mappings`)

### 4.10 Spot Quote Search
- TRAC market bands layered into search results
- Internal won-quote bands
- `load_fact` lane traffic signals
- Carrier Hub outreach lists
- Geographic corridor chips

### 4.11 Webex Calling Integration
- Click-to-Call from contact records
- CDR (call history) synchronization
- Real-time presence lookup
- Recording download and transcription via Whisper
- AI analysis of transcribed calls
- Voicemail management

### 4.12 Geographic Lane Patterns
- Corridor pattern definitions
- Contact responsibility tracking per corridor
- AI-derived contact-to-lane suggestions

### 4.13 AI Intelligence Hub
A unified dashboard providing 11 intelligence cards:
Meeting Prep Briefs, Sentiment Tracking, Smart Follow-Up Timing, Relationship Health Coaching, Org Chart Gap Analysis, Warm Introduction Paths, Look-Alike Prospecting, Cross-Sell / Lane Gap Intelligence, Wallet Share Expansion Playbook, Win/Loss Pattern Engine, Competitive Signal Detection.

### 4.14 AI Center (Admin)
- Consolidated admin module for AI agent management
- Approval workflows for AI actions
- Pod management and adapter configuration

### 4.15 Rate Intelligence & Rep Coaching
- SONAR-driven lane benchmarks
- GPT-4o coaching cards per lane and per rep
- Call trendline analytics

### 4.16 Automated Processes
- Auto-sync customer emails (Microsoft Graph)
- Tactical Learning Engine (proven tactics library)
- Quote Request SLA alerting
- Auto-generated weekly account reviews

### 4.17 Cross-Tab UX Layer
- Hover-card previews on cross-link chips across all surfaces
- SSE pub/sub (`/api/live-sync/stream`) invalidates React Query keys across open browser tabs for: Available Freight, Lane Work Queue, Carrier Hub, Customer Quotes
- Lane Inbox feed (`/lane-inbox`) aggregates recent events from all four surfaces

---

## 5. Data Architecture

### Key Tables
| Table | Purpose |
|---|---|
| `companies` | Core account records |
| `contacts` | People associated with companies |
| `freight_opportunities` | Inbound freight triage (canonical) |
| `load_fact` | Historical lane traffic (canonical) |
| `lane_summary_cache` | Precomputed lane analytics |
| `account_contact_suggestions` | AI-derived contact-role recommendations |
| `geographic_lane_patterns` | Corridor patterns and responsibilities |
| `email_conversation_threads` | Inbox thread records |
| `proven_tactics` | Tactical learning entries |
| `account_reviews` | Auto-generated weekly reviews |
| `quote_sender_mappings` | Maps email senders to customer accounts |
| Webex tables | CDR, presence, recordings |

### Design Principles
- **Org isolation**: All company and contact reads are scoped to the requesting user's organization. Cross-org reads return `undefined`; cross-org updates return `null` and produce no mutations.
- **Visibility model**: Role and collaboration-based access control layered on top of org isolation.
- **No schema drift**: Schema-Drift Guard compares the Drizzle schema against `information_schema` at boot.
- **Caching**: Multi-layer — server-side in-memory cache, dashboard query optimization, keyset pagination for large datasets.
- **Background workers**: node-cron jobs for email sync, SLA alerting, and account review generation.
- **Webhook-driven reactivity**: Microsoft Graph webhooks trigger inbox sync; SSE drives cross-tab invalidation.

---

## 6. Security & Code Quality

### Authentication & Authorization
- Clerk handles identity; session tokens validated on every request
- Dynamic RBAC: roles enforced at the route layer via `canAccessCompany` and equivalent guards
- AI chat conversation endpoints are fully user-scoped (`chatConversations.userId === currentUser.id`) — no cross-user data leaks

### Input Safety
- All Express handlers normalize `req.params` and `req.query` strings through `pStr` / `qStr` / `qOptStr` helpers in `server/lib/req.ts` — no raw string reads
- Zod schemas from `drizzle-zod` validate all request bodies before they reach storage

### Rate Limiting
- `aiPreviewRateLimit` on `/api/rfps/upload`
- `bulkImportRateLimit` on `/api/awards/parse-lanes` and `/api/companies/:id/market-share/upload`
- Separate rate limiter middleware in `server/lib/rateLimiter.ts`

### Known Open Item
- ~54 pre-existing TypeScript errors remain in `npm run check` in files not touched this session (primarily `err?.message` on `unknown` catch variables in routes.ts non-company sections, `sonar.ts`, `valueiq.ts`, `marketSignals.ts`). These do not affect runtime behavior. Planned fix: replace with `getErrorMessage(err)` from `server/lib/errors.ts`.

---

## 7. Route Architecture

Routes are organized as modular Express registrations. Each feature area has its own file in `server/routes/`:

| Module | Feature Area |
|---|---|
| `companies.ts` | Company CRUD, org chart, milestones, market share |
| `contacts.ts` | Contact CRUD, org suggestions |
| `conversations.ts` | Inbox threads, ownership, AI summaries |
| `carrierHub.ts` | Carrier intelligence, contacts, scoring |
| `laneCarrierOutreach.ts` | LWQ carrier outreach |
| `freightOpportunityCockpit.ts` | Available Freight triage |
| `loadFact.ts` | Historical lane traffic |
| `aiIntelligence.ts` | AI Intelligence Hub cards |
| `aiCenter.ts` | AI agent admin |
| `callIntelligence.ts` | Webex transcription analysis |
| `webex.ts` | Click-to-call, CDR, presence |
| `sonar.ts` | SONAR rate benchmarks |
| `coaching.ts` | Rep coaching cards |
| `emailIntelligence.ts` | Email signal extraction |
| `emailDrafting.ts` | AI email composition |
| `financials.ts` | OneDrive sync, financial uploads |
| `dashboard.ts` | KPI aggregation |
| `agentic.ts` | AI action execution |
| `agentAdmin.ts`, `agentAnalytics.ts` | AI Center admin |
| `laneInbox.ts` | Unified lane event feed |
| `liveSync.ts` | SSE pub/sub stream |
| + 30 additional modules | Tasks, goals, notifications, playbook, procurement, prospects, etc. |

`server/routes.ts` orchestrates all 51 modules and houses routes not yet extracted.

---

## 8. Test Suite

| Test File | Coverage Area |
|---|---|
| `code-quality-guardrails.test.ts` | 86 assertions across 8 sections: auth guards, param normalization, org scoping, rate limits, AI safety, chat ownership |
| `storage-integration.test.ts` | 24 live-DB tests: Companies CRUD, cross-org isolation, Contacts CRUD, Pinned Companies |
| `idor-guardrails.test.ts` | IDOR attack surface checks |
| `guardrails.test.ts` | General security pattern checks |
| `shared-inbox-webhook-e2e.test.ts` | End-to-end Microsoft Graph webhook flow |
| `carrier-ranking-*.test.ts` | Carrier ranker logic (accepted intel, recency, overhaul) |
| `lane-work-queue.test.ts` | LWQ workflow |
| `lane-switchboard.spec.cjs` | Lane switcher parsing |
| `won-quote-*.test.ts / .spec.cjs` | Won quote → AF / LWQ handoff |
| `af-*.spec.cjs` | Available Freight cockpit behavior |
| `mailbox-historical-backfill.test.ts` | Inbox backfill logic |
| `email-signal-consumers.test.ts` | Email intent extraction |
| `my-procurement.test.ts` | Procurement outreach flow |
| `performance.test.ts` | Query performance benchmarks |
| + 13 additional test files | Carrier import, formatters, sharing, sessions, etc. |

### Validation Commands (CI)
| Command | What It Checks |
|---|---|
| `typecheck` (`npm run check`) | TypeScript compilation (zero-error baseline target) |
| `guardrails` | 86 code-quality assertions |
| `storage-integration` | 24 live-DB storage layer assertions |

---

## 9. External Integrations

| Integration | Purpose |
|---|---|
| **OpenAI** (GPT-4o / GPT-4o-mini / Whisper) | RFP column mapping, lane insights, email drafting, coaching cards, AI hub, call transcription |
| **Microsoft Graph — Outlook** | Two-way carrier email (webhook), auto-sync customer emails, monitored mailboxes |
| **Microsoft Graph — OneDrive** | Financial data synchronization |
| **FreightWaves SONAR** | Market rate benchmarking, lane capacity signals |
| **FreightWaves TRAC** | Spot rates, forecasts, directional market signals |
| **Webex Calling API** | Click-to-call, CDR sync, presence, recording download |
| **ZoomInfo** | Contact intelligence enrichment |
| **Clerk** | Authentication and identity management |
| **Resend / GoDaddy SMTP** | Transactional email sending |
| **Stripe** | Payments (installed, integration available) |

---

## 10. User Preferences & Development Guidelines

- Ask before any major architectural change or significant feature modification
- Clean code is a priority — no `as any`, typed return values, normalized param access
- Iterative development with regular updates preferred
- `replit.md` is the authoritative source for architecture decisions and is kept current after each session
