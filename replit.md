# FreightDNA - Transportation Brokerage Sales Tool

## Overview
FreightDNA is a specialized mini CRM application for transportation brokerage sales teams. Its purpose is to streamline sales workflows by managing customer accounts, organizational charts, contacts, and shipping data. It includes RFP and Award management with Excel upload and analytical tools. The system aims to enhance customer relationship management, drive sales efficiency, facilitate strategic account penetration, and increase revenue for transportation brokers, supported by robust role-based access control (RBAC).

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application uses React, TypeScript, Tailwind CSS, and `shadcn/ui` for a modern, responsive interface. It features dark/light mode, blue and green accent colors, a gradient hero banner, KPI stat cards, and a responsive sidebar. The theme includes a black sidebar/header with amber gold accents, the Value Truck logo, and mantras in the header.

### Technical Implementations
- **Frontend**: React, TypeScript, TanStack Query, Wouter.
- **Backend**: Express.js with TypeScript for API, authentication, and file processing.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication**: Session-based authentication using `express-session`, `connect-pg-simple`, `bcrypt`, and dynamic RBAC.
- **File Processing**: `xlsx` for Excel/CSV parsing and `multer` for uploads.
- **Mapping & Geocoding**: Leaflet, custom server-side geocoding, and Haversine distance calculations.
- **Core Features**:
    - **CRM**: CRUD for companies and contacts with org chart visualization.
    - **RFP & Award Management**: Modules for RFPs and awards, with AI-assisted Excel upload.
    - **Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
    - **User & Team Management**: Administration, hierarchy, and account reassignment.
    - **Data Integration**: Global search, OneDrive sync, and file attachments.
    - **Communication**: Task assignment, shared callouts/trends, and discussion topics.
    - **Goal Tracking**: For National Account Managers.
    - **Customer Interaction**: Touchpoint logging, recency tracking, and "Contacts Needing Attention" alerts.
    - **Account Intelligence**: Dedicated fields for operational details and portal credentials.
    - **Customer Scorecard**: Secure upload/download of scorecard documents.
    - **Dashboard**: Contextual alerts, goal progress, and role-specific insights.
    - **Momentum Score**: Automated company health/momentum scores (At Risk, Stable, Growth Ready, High Expansion), with detailed breakdown.
    - **AI-Powered Insights**: AI-generated talking points, health score narratives, touchpoint note summaries, proactive nudges via chatbot.
    - **AI Action Execution**: Chatbot supports OpenAI function calling for `log_touchpoint` and `create_task`.
    - **Shipping Modes**: Categorization and filtering.
    - **Relationship Freight Reporting**: Attributing freight loads to contacts.
    - **Relationship Advancement History**: Tracks changes in contact relationship bases.
    - **Greenfield Visibility**: Identifies "Unworked Accounts."
    - **Pre-call Planner**: Displays relationship intelligence on contact cards.
    - **Feedback Inbox**: Admins can respond to feedback with email notifications.
    - **Company Activity Timeline**: Unified chronological feed of events.
    - **Calendar**: RFP deadlines and task due dates.
    - **Rep Scorecard / Director Leaderboard**: Admin-only page for ranking reps.
    - **AI Email Drafting**: Generates personalized email drafts using GPT-4o-mini.
    - **NBA (Next Best Action) Phase 1**: Recommendation engine generating persistent cards based on freight data rules.
    - **Lane Carrier Outreach Workflow**: Assignable lane workflow with work queues, carrier contactability, and email sending/tracking.
    - **Stable Coverage System**: Computes per-lane coverage profiles from TMS history, tracks incumbent carriers, and broadens search modes.
    - **My Procurement**: Personal unified work surface for reps showing LWQ lane assignments and open award carrier procurement tasks.
    - **Carrier Hub (Phase 1)**: Central carrier intelligence layer with contact management, claimed lanes, and activity tracking.
    - **Rate Intelligence & Rep Coaching Engine** (Task #219): SONAR-driven lane rate benchmarks (4-hour TTL), `ratePositioning` computation layer (ABOVE/AT/BELOW market classifications with ±10% threshold), GPT-4o coaching cards per lane, Rate Positioning Panel on Intel page, Director portfolio rate exposure portlet, daily rate positioning email summary, and `get_lane_rate_positioning` chatbot tool.
    - **LWQ ↔ Carrier Hub Cross-Linking**: Provides explanations for ranked carrier suggestions and allows navigation to Carrier Hub profiles.
    - **Customer Contact Capture from Email**: Detects new people in account-linked email threads and surfaces lightweight contact suggestions. Suggestions shown on company People tab; count badge visible in the Customers list. Batch count API: `GET /api/internal/accounts/suggestion-counts`.
    - **Two-Way Carrier Email**: Outbound emails to carriers include a reply-to address routed through Microsoft Graph webhook; inbound replies matched to outreach logs.
    - **Customer Email Intelligence Pipeline**: Inbound emails to the central monitoring mailbox are now also matched against CRM contacts (via `contacts.email`). When a customer contact's email is recognized, an `email_messages` row is inserted and processed by the AI scheduler (every 10 min) to extract customer intent signals (pricing_request, objection, urgency_signal, new_opportunity, closed_won/lost_indicator, etc.). Signals are surfaced in the company Intel tab via `GET /api/companies/:id/email-signals`. New storage method: `getContactByEmailInOrg`. New webhook path: `matchInboundSenderToAccount`.
    - **Inbound Reply Surfaces**: Inbound carrier replies are surfaced across Lane Work Queue, My Procurement, and the sidebar with a `needsAction` distinction.
    - **Conversations Inbox** (`/conversations`): Org-scoped email conversation thread management with ownership, waiting-state (`waiting_on_us` / `waiting_on_them` / `resolved`), priority, and overdue tracking. Sidebar shows live badge count of threads waiting on the current user (`GET /api/internal/conversations/my-count`, polls every 90s).
    - **Geographic Lane Patterns** (Task #203): 20 baseline corridor patterns (Upper Midwest, Southeast, Texas→Midwest, etc.) stored in `geographic_lane_patterns`. `account_contact_lane_pattern_responsibilities` tracks which contacts own which corridors, with confidence scoring and NBA card firing at ≥70 confidence. UI on contact detail card.
    - **Today's Briefing & Recently Visited** (Task #205): Dashboard portlets for non-LM roles. Today's Briefing shows tasks due/overdue, at-risk accounts, contacts needing attention, and unread notifications. Recently Visited shows last 8 companies visited (via localStorage per-user, tracked in company-detail).
    - **Pinned Accounts & Copy-to-Clipboard** (Task #206): Up to 10 accounts can be starred/pinned per user (`pinned_companies` table). Pin button on customer cards and company detail header. Pinned Accounts portlet on dashboard. Copy buttons on portal credentials, contact email/phone in list and org-chart views.
    - **Quick Touchpoint Logger — FAB + Keyboard Shortcut** (Task #207): Floating "Log Touch" button (fixed bottom-right, hidden on dashboard). `Shift+T` keyboard shortcut via `LogTouchContext`. Keyboard shortcuts help popover in sidebar footer. Company-aware prefill when on a company detail page.
    - **Momentum Score Drop Notifications** (Task #208): In-app notifications when an account's momentum band drops. Weekly digest of band changes sent every Monday at 7:00 AM CT. Deduplication via `hasUnreadNotification`. Handled by `momentumNotifications.ts` and `momentumDropScheduler.ts`.
    - **Power User Tools** (Task #209): Global keyboard shortcuts (`/` or `⌘K` to search, `Shift+D/A/L` for nav). Saved filter views on Customers page (max 10, stored via `GET/PUT /api/users/saved-filters` using `storage.setSetting`). Bulk task actions (mark complete, reassign) on Tasks page and dashboard Tasks portlet.
    - **Collapsible Sidebar Icon-Only Mode** (Task #210): Desktop rail toggle button persists sidebar state to localStorage. Icon-only mode shows tooltips for nav items.
    - **UX Cleanup (Session)**: Sidebar decluttered — Touchpoint History, PTO Passoff, Coordinators Corner moved to Admin/Team section; Tools/Resources/Training moved to Help icon (?) dialog. "Lane Intelligence" nav item covers all 3 lane search pages with tab switcher (Lane Research | RFP Lane Search | Carrier Lane Search). Market Share card moved from Intel tab → Overview tab.
- **Carrier History & Ranking Contract**: Governs carrier ranking and TMS history display logic. Defines TMS field-name handling (title-case-with-spaces and camelCase), carrier name parsing (stripping payee codes), month normalization to "YYYY-MM", and an HQ proximity bonus for ranking.
- **Ranking Guarantee**: A 5-tier geo-aware system ensures TMS history outranks catalog-region-only carriers. Tiers: "exact", "nearby", "state_pair", "region", "none" with defined `fitScore` floor bands.
- **Shared History Source**: LWQ and Carrier Hub read from the same `financial_uploads.rows` JSONB source via a shared utility layer, ensuring consistency.

### DB Tables Added in Tasks #200–203
| Table | Purpose |
|---|---|
| `lane_summary_cache` | Pre-computed flat LeanItem rows for the LWQ work-queue (cache-first path). Populated by `scoreAllEligibleLanes` on startup (20s delay) and nightly at 3:00 AM CT. |
| `account_contact_suggestions` | Pending/accepted/ignored contact suggestions detected from email threads. |
| `geographic_lane_patterns` | Named corridor patterns (20 baseline rows seeded on startup). |
| `account_contact_lane_pattern_responsibilities` | Confidence-scored mappings of contact → corridor, with evidence keys and source types. |
| `email_conversation_threads` | Org-scoped carrier/account email conversation management (Task #202). |

### lane_summary_cache Warming Contract
- **On startup**: `scoreAllEligibleLanes` runs for each org 20 seconds after the server starts listening (non-blocking, errors per org are logged and swallowed).
- **Nightly**: NBA Phase 1 scheduler (3:00 AM CT) also calls `scoreAllEligibleLanes` for all orgs.
- **On assignment**: Assigning a lane owner also refreshes that lane's cache entry.
- **Fallback**: If the cache is empty (first-ever boot before warmup completes), the LWQ endpoint falls back to the full `getLaneWorkQueue` query automatically.

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
- **FreightWaves SONAR**: Market rate benchmarking (VCRPM1/VOTRI signals) with 4-hour TTL cache for lane rate intelligence.
