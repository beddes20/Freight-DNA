# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application for transportation brokerage sales teams. It streamlines sales workflows by managing customer accounts, organizational charts, contacts, and shipping data. The application includes RFP and Award management with Excel upload and advanced analytical tools. Its core purpose is to enhance customer relationship management, boost sales efficiency, facilitate strategic account penetration, and increase revenue for transportation brokers through robust role-based access control (RBAC).

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern and responsive user interface built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. It includes dark/light mode, blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The theme features a black sidebar/header with amber gold accents, the Value Truck logo, and mantras in the header.

### Technical Implementations
FreightDNA is built with a React frontend, an Express.js backend, and a PostgreSQL database utilizing Drizzle ORM. Authentication is session-based with dynamic RBAC.

Core features include:
- **CRM**: Comprehensive CRUD operations for companies and contacts, with organizational chart visualization.
- **RFP & Award Management**: Modules for managing RFPs and awards, enhanced with AI-assisted Excel uploads.
- **Advanced Analytics**: Tools for lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
- **User & Team Management**: Administration, hierarchy, and account reassignment with RBAC.
- **Data Integration**: Global search, OneDrive sync, and file attachments.
- **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
- **Customer Interaction**: Touchpoint logging, recency tracking, and alerts.
- **Account Intelligence**: Detailed operational fields and portal credentials storage.
- **Customer Scorecard**: Secure document management.
- **Dashboard**: Contextual alerts, goal progress, and role-specific insights.
- **Momentum Score**: Automated company health/momentum scores (At Risk, Stable, Growth Ready, High Expansion) with AI-powered insights and narratives.
- **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges via chatbot, and AI action execution for logging touchpoints and creating tasks.
- **AI Email Drafting**: Generates personalized email drafts using GPT-4o-mini, grounded in CRM/freight data, with voice profile analysis. Includes a feedback loop for user ratings and an admin-level email correction system.
- **Next Best Action (NBA)**: Recommendation engine providing persistent cards based on freight data rules.
- **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach, email sending/tracking.
- **Stable Coverage System**: Computes per-lane coverage profiles and tracks incumbent carriers.
- **My Procurement**: Unified work surface for reps showing LWQ lane assignments and open award carrier procurement tasks.
- **Carrier Hub**: Central carrier intelligence layer with contact management, claimed lanes, activity tracking, and a Carrier Reliability Score.
- **Rate Intelligence & Rep Coaching Engine**: SONAR-driven lane rate benchmarks, rate positioning computation, and GPT-4o coaching cards per lane.
- **Customer Contact Capture from Email**: Detects and suggests new contacts from email threads.
- **Two-Way Carrier Email**: Outbound emails with replies routed through Microsoft Graph webhook, matching inbound replies to outreach logs.
- **Customer Email Intelligence Pipeline**: Processes inbound emails to extract customer intent signals (e.g., pricing_request, urgency_signal).
- **Conversations Inbox**: Org-scoped email conversation thread management with ownership, waiting-state, priority, overdue tracking, archival (manual + auto-archive after 7 days resolved), cursor-based pagination, and search/date filtering for archived threads.
- **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities with confidence scoring, including AI-derived geography ownership suggestions.
- **AI Intelligence Hub**: A unified dashboard offering Meeting Prep Briefs, Sentiment Tracking, Smart Follow-Up Timing, Relationship Health Coaching, Org Chart Gap Analysis, Warm Introduction Paths, Look-Alike Prospecting, Cross-Sell / Lane Gap Intelligence, Wallet Share Expansion Playbook, Win/Loss Pattern Engine, and Competitive Signal Detection.
- **Auto-Sync Customer Emails**: Monitors individual Outlook mailboxes for NAMs & AMs via Microsoft Graph webhooks, automatically pulling and processing customer email threads for AI signal extraction.
- **Tactical Learning Engine**: Captures and surfaces successful response approaches for various email signals.
- **Quote Request SLA Alerting**: Real-time alerting when a customer sends a pricing/quote request. Email batch runs every 2 minutes; reps receive an urgent notification with a 7-minute countdown timer. If unread after 5 minutes, the rep's manager receives an escalation alert. Notification types: `quote_request_alert`, `quote_request_escalation`.
- **Webex Calling Integration**: Click-to-Call via `webextel://` deep links from contact cards, contact detail sheets, and pre-call planner. Call history sync creates touchpoints from Webex CDRs with deduplication. Missed inbound calls surface as NBA cards (`webex_missed_call`). Recording transcription via OpenAI Whisper with AI analysis pipeline. Real-time presence indicators (green/yellow/red dots) on contact phone numbers via batch presence API with 60s cache. Env vars: `WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_ORG_ID`.

### System Design Choices
Key database tables support core functionalities, including pre-computed lane data (`lane_summary_cache`), email-derived contact suggestions (`account_contact_suggestions`), defined corridor patterns (`geographic_lane_patterns`), contact-to-corridor mapping (`account_contact_lane_pattern_responsibilities`), email conversation management (`email_conversation_threads`), AI-inferred geography ownership (`contact_geography_suggestions`), proven tactical responses (`proven_tactics`), AI draft feedback (`draft_feedback`), email correction records (`sent_email_corrections`), and numerous tables for the AI Intelligence Hub features (e.g., `meeting_prep_briefs`, `contact_sentiment_tracking`, `monitored_mailboxes`).

### Performance Optimizations
- **Dashboard query optimization**: `getColdContacts` and `getMeaningfulOverdueContacts` use SQL LATERAL joins with LIMIT 20 instead of loading all contacts/touchpoints into memory. Reduced response time from 28-34s to <500ms.
- **Dashboard caching**: All four slow dashboard endpoints (`cold-contacts`, `meaningful-overdue`, `margin-metrics`, `relationship-summary`) use 10-15 minute server-side cache (via `server/cache.ts`).
- **Carrier ranking cache**: Per-lane in-memory cache with 3-min TTL in `laneCarrierOutreach.ts`.

## External Dependencies
- **PostgreSQL**: Primary database.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization and reply webhook routing.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o / GPT-4o-mini)**: For AI-assisted features (RFP column mapping, lane gap insights, email drafting, lane coaching cards, and all AI Intelligence Hub features).
- **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook subscription and auto-sync of customer emails.
- **FreightWaves SONAR**: For market rate benchmarking and lane VOTRI capacity signals. Uses 12-second rate limiter, circuit breaker (30-min cooldown on HTTP 451), DB-backed cache with 2-6 hour TTLs, and stale-fallback warm-up on cold start. National summary uses 3 API calls (OTRI, NTI, VCRPM1), market OTRI uses 1 call/market, lane VOTRI uses 1 call/lane. All numeric fields are nullable — when data is unavailable, the UI shows "—" with "Data unavailable — last updated [timestamp]" instead of fake numbers.
- **Webex Calling API**: Click-to-call deep links, CDR history sync, presence lookup, and recording download. Auth via OAuth client-credentials flow (`server/webexService.ts`).
- **TRAC API (FreightWaves)**: Primary source for lane-level spot rates, 3-week forecasts, and directional market signals. `tracDirectionSignal()` in `tracAlertEngine.ts` derives hot/warm/cool from `forecast_index_value` (replaces VOTRI's directional role). Used by getLaneSpotRate() and getLaneMarketRate() with null return when unavailable (no fake fallbacks).
