# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application designed for transportation brokerage sales teams. Its primary purpose is to streamline sales workflows by managing customer accounts, organizational charts, contacts, and shipping data. It includes RFP and Award management with Excel upload and advanced analytical tools. The system aims to enhance customer relationship management, drive sales efficiency, facilitate strategic account penetration, and increase revenue for transportation brokers through robust role-based access control (RBAC).

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application utilizes React, TypeScript, Tailwind CSS, and `shadcn/ui` to deliver a modern and responsive user interface. Key UI elements include dark/light mode, blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The theme features a black sidebar/header with amber gold accents, the Value Truck logo, and mantras in the header.

### Technical Implementations
The system is built with a React frontend, an Express.js backend, and a PostgreSQL database with Drizzle ORM. Authentication is session-based with dynamic RBAC. Core features include comprehensive CRM functionalities, RFP and Award management with AI assistance, and advanced analytics for lane research, facility coverage, and wallet share.

Key functionalities include:
- **CRM**: CRUD operations for companies and contacts, organizational chart visualization.
- **RFP & Award Management**: Modules for managing RFPs and awards, with AI-assisted Excel uploads.
- **Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
- **User & Team Management**: Administration, hierarchy, and account reassignment with RBAC.
- **Data Integration**: Global search, OneDrive sync, and file attachments.
- **Communication & Collaboration**: Task assignment, shared insights, and discussion topics.
- **Customer Interaction**: Touchpoint logging, recency tracking, and alerts for contacts needing attention.
- **Account Intelligence**: Detailed operational fields and portal credentials storage.
- **Customer Scorecard**: Secure document upload/download.
- **Dashboard**: Contextual alerts, goal progress, and role-specific insights.
- **Momentum Score**: Automated company health/momentum scores (At Risk, Stable, Growth Ready, High Expansion) with AI-powered insights and narratives.
- **AI-Powered Features**: AI-generated talking points, health score narratives, touchpoint summaries, proactive nudges via chatbot, and AI action execution for logging touchpoints and creating tasks.
- **AI Email Drafting**: Generates personalized email drafts using GPT-4o-mini, grounded in CRM/freight data, with voice profile analysis.
- **Next Best Action (NBA)**: Recommendation engine generating persistent cards based on freight data rules.
- **Lane Work Queue (LWQ)**: Assignable lane workflow with carrier outreach, email sending/tracking.
- **Stable Coverage System**: Computes per-lane coverage profiles and tracks incumbent carriers.
- **My Procurement**: Personal unified work surface for reps showing LWQ lane assignments and open award carrier procurement tasks.
- **Carrier Hub**: Central carrier intelligence layer with contact management, claimed lanes, and activity tracking, including a Carrier Reliability Score.
- **Rate Intelligence & Rep Coaching Engine**: SONAR-driven lane rate benchmarks, rate positioning computation, and GPT-4o coaching cards per lane.
- **Customer Contact Capture from Email**: Detects and suggests new contacts from email threads.
- **Two-Way Carrier Email**: Outbound emails with reply-to addresses routed through Microsoft Graph webhook, matching inbound replies to outreach logs.
- **Customer Email Intelligence Pipeline**: Processes inbound emails to extract customer intent signals (e.g., pricing_request, urgency_signal), surfaced in the company Intel tab.
- **Conversations Inbox**: Org-scoped email conversation thread management with ownership, waiting-state, priority, and overdue tracking.
- **Geographic Lane Patterns**: Defines corridor patterns and tracks contact responsibilities with confidence scoring.
- **Today's Briefing & Recently Visited**: Dashboard portlets for tasks, at-risk accounts, and recent activity.
- **Pinned Accounts & Copy-to-Clipboard**: User-specific pinned accounts and quick copy actions.
- **Quick Touchpoint Logger**: Floating action button and keyboard shortcut for logging touchpoints.
- **Momentum Score Drop Notifications**: In-app and weekly digest notifications for momentum band changes.
- **Power User Tools**: Global keyboard shortcuts, saved filter views, and bulk task actions.
- **Collapsible Sidebar**: Icon-only mode with tooltips.
- **Win/Loss Pattern Dashboard**: Analytics page (`/email-intelligence`) surfacing org-wide email signal patterns, urgency tracking, and win/loss patterns.
- **Urgency Response Tracker**: Monitors and tracks unresponded urgency signals from customer emails.
- **Carrier History & Ranking Contract**: Governs carrier ranking and TMS history display logic.
- **Contact Geography Ownership Graph** (Task #225): AI-derived geography ownership layer that infers which contacts own which geographies from email threads and load history. New `contact_geography_suggestions` table stores AI-inferred region/lane assignments with confidence scores and source evidence. Email intelligence scheduler runs geography inference after signal extraction. API endpoints: `GET /api/internal/accounts/:id/geography-suggestions`, `POST /api/internal/geography-suggestions/:id/accept|reject|dismiss`. Accepting updates the contact's `regions` and `lanes` arrays. "Geography Ownership" section on People tab shows confirmed assignments, pending AI suggestions as reviewable cards, and prompts for contacts with no data.
- **Tactical Learning Engine**: Captures which response approaches lead to wins. `proven_tactics` table stores tactics linked to email signals and outcomes with success rates. Only "won" tactics are surfaced during AI email drafting. API endpoints: `GET /api/internal/proven-tactics`, `GET /api/internal/proven-tactics/stats`, `GET /api/internal/proven-tactics/for-signal?signalType=`, `POST /api/internal/proven-tactics`, `POST /api/internal/proven-tactics/:id/outcome`. Frontend page at `/proven-tactics` with KPI cards, filterable tactic list, expandable cards with example responses, and outcome recording (won/lost).

### DB Tables Added in Tasks #200–203, #225, Tactical Learning
| Table | Purpose |
|---|---|
| `lane_summary_cache` | Pre-computed flat LeanItem rows for the LWQ work-queue (cache-first path). Populated by `scoreAllEligibleLanes` on startup (20s delay) and nightly at 3:00 AM CT. |
| `account_contact_suggestions` | Pending/accepted/ignored contact suggestions detected from email threads. |
| `geographic_lane_patterns` | Named corridor patterns (20 baseline rows seeded on startup). |
| `account_contact_lane_pattern_responsibilities` | Confidence-scored mappings of contact → corridor, with evidence keys and source types. |
| `email_conversation_threads` | Org-scoped carrier/account email conversation management (Task #202). |
| `contact_geography_suggestions` | AI-inferred geography (region/lane) ownership per contact, with confidence scores, source evidence, and approval workflow (Task #225). |
| `proven_tactics` | Response approaches linked to email signals/outcomes with success rates. Seeded with 8 demo tactics. Surfaced during AI email drafting. |

### DB Tables
Key database tables support core functionalities, including `lane_summary_cache` for pre-computed lane data, `account_contact_suggestions` for email-derived contact suggestions, `geographic_lane_patterns` for defined corridors, `account_contact_lane_pattern_responsibilities` for contact-to-corridor mapping, and `email_conversation_threads` for managing email conversations.

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization and reply webhook routing.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o / GPT-4o-mini)**: For AI-assisted features (RFP column mapping, lane gap insights, email drafting, lane coaching cards).
- **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook subscription.
- **FreightWaves SONAR**: For market rate benchmarking and lane rate intelligence.