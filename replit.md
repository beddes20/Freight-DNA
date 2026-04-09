# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a specialized mini CRM application designed for transportation brokerage sales teams. Its core purpose is to streamline sales workflows by enabling efficient management of customer accounts, organizational charts, contacts, and shipping-related data including lanes, regions, freight spend, and spot bidding. The system supports dedicated RFP and Award management with Excel upload and analytical tools. The overarching vision is to enhance customer relationship management, drive sales efficiency, facilitate strategic account penetration, and ultimately increase revenue for transportation brokers. It incorporates robust role-based access control (RBAC) to support various management levels.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application features a modern and responsive user interface built with React, TypeScript, Tailwind CSS, and `shadcn/ui`. Key design elements include dark/light mode switching, blue and green accent colors, a gradient hero banner, KPI stat cards on the dashboard, and a responsive sidebar for navigation. The theme utilizes a black sidebar/header with amber gold accents, incorporates the Value Truck logo, and displays mantras in the top header.

### Technical Implementations
- **Frontend**: React, TypeScript, TanStack Query for data fetching, and Wouter for routing.
- **Backend**: Express.js server developed with TypeScript for API requests, authentication, and file processing.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication**: Session-based authentication using `express-session`, `connect-pg-simple`, and `bcrypt` for password hashing, with dynamic Role-Based Access Control (RBAC) for data visibility.
- **File Processing**: `xlsx` (SheetJS) for Excel/CSV parsing and `multer` for file uploads.
- **Mapping & Geocoding**: Leaflet for interactive maps, integrated with custom server-side geocoding and Haversine distance calculations.
- **Core Features**:
    - **CRM**: Comprehensive CRUD for companies and contacts, including org chart visualization and transportation-specific fields.
    - **RFP & Award Management**: Modules for managing RFPs and awards, with AI-assisted Excel upload and column mapping.
    - **Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data analysis, and wallet share calculation.
    - **User & Team Management**: Administration tools, team hierarchy management, and account reassignment.
    - **Data Integration**: Global search, OneDrive synchronization for financial data, and file attachment capabilities.
    - **Communication**: Task assignment, shared callouts/trends feed, and 1:1 discussion topics.
    - **Goal Tracking**: System for National Account Managers to set and track goals for Account Managers.
    - **Customer Interaction**: Logging of contact touchpoints with recency tracking and "Contacts Needing Attention" alerts.
    - **Account Intelligence**: Dedicated fields for operational details and portal credentials within company profiles.
    - **Customer Scorecard**: Secure upload and download of customer scorecard documents.
    - **Dashboard**: Contextual alerts for deadlines, goal progress, and role-specific insights.
    - **Momentum Score**: Renamed "Account Growth Score" → "Momentum Score" in the UI. Clickable badge on company detail and customer list cards opens a right-side breakdown drawer. Drawer shows: large score + band badge + last-updated date, per-bucket breakdown (Touchpoint Health 25pts, Activity Trend 8pts, Relationship Depth 20pts, Volume Signal 20pts, Lane Breadth 15pts, RFP & Opportunity 5pts) each with a progress bar and sub-driver bullets, penalty components (−8 no touch 45d, −7 no meaningful convo 90d, −5 no 3rd/HR, −3 overdue task), and top signals list. Server `GrowthScoreResult` now returns `breakdown: MomentumBreakdown` from `computeGrowthScore`. Endpoint `/api/companies/:id/growth-score` always freshly computes when breakdown is absent.
    - **AI-Powered Insights**: AI-generated talking points for lane gap insights, AI health score narratives, AI touchpoint note summaries, and proactive nudges via a chatbot.
    - **AI Action Execution**: Chatbot supports OpenAI function calling for `log_touchpoint` and `create_task`.
    - **Scoring**: Automated company health and momentum scores, and an Account Growth Score with categorization (At Risk, Stable, Growth Ready, High Expansion).
    - **Shipping Modes**: Categorization and filtering of companies by shipping modes.
    - **Relationship Freight Reporting**: Attributing freight loads to individual contacts and their relationship base levels.
    - **Relationship Advancement History**: Tracks changes in contact relationship bases.
    - **Dashboard Consolidation**: Optimized dashboard data fetching.
    - **Greenfield Visibility**: Identifies "Unworked Accounts."
    - **Pre-call Planner**: Displays relationship intelligence on contact cards.
    - **Feedback Inbox**: Admins can respond to feedback with email notifications.
    - **Contact Data Completeness**: Nudges for missing contact data.
    - **Company Activity Timeline**: Unified chronological feed of events.
    - **Calendar**: RFP deadlines and task due dates calendar.
    - **Rep Scorecard / Director Leaderboard**: Director/admin-only page for ranking reps by activity.
    - **AI Email Drafting**: Generates personalized email drafts using GPT-4o-mini.
    - **NBA (Next Best Action) Phase 1**: Recommendation engine generating persistent cards for reps based on freight data rules (e.g., Load Decline, Single-Thread Risk, Stale Account).
    - **Lane Carrier Outreach Workflow**: Assignable lane workflow with work queues, carrier contactability, and email sending/tracking.
    - **Stable Coverage System (Task #157)**: Per-lane coverage profiles computed from TMS history, classifying lanes as Stable/Watch/Unstable (≥70%/40–69%/<40% top-carrier concentration). Includes incumbent carrier tracking, score-floor boost for incumbents in ranked suggestions, broaden-search mode, manual override/confirm, and a Coverage tab in CarrierOutreachPanel.
    - **My Procurement**: Personal unified work surface at `/my-procurement` for each rep. Shows two buckets in one view: (1) LWQ lane assignments (`recurring_lanes.ownerUserId = me`, `resolvedAt IS NULL`) and (2) open award `carrier_procurement` tasks (`tasks.assignedTo = me`, `status = 'open'`). API: `GET /api/my-procurement`. Includes "Mark Done" actions (resolves lane / closes task) and deep-links: LWQ lanes → `/lanes/work-queue?laneId=`, Award tasks → `/rfp-awards?awardId=&tab=lanes`. Route file: `server/routes/myProcurement.ts` (does NOT touch high-risk surfaces). Sidebar nav item: "My Procurement" (Briefcase icon) in the Lane Tools section.
    - **Carrier Hub (Phase 1)**: Central carrier intelligence layer with contact management, claimed lanes, and activity tracking.
    - **LWQ ↔ Carrier Hub Cross-Linking**: "Why this carrier" explanations on each ranked carrier suggestion (primary signal, claimed-lane-match badge, prior-positive-outreach badge). "View carrier profile" link on each card navigates to Carrier Hub via `?carrierId=`. Carrier Hub "Lanes" tab includes "Best Lanes Right Now" section (top-10 recommended active lanes scored by equipment/region/claimed-lane fit) with "Open in Lane Work Queue" cross-links (`?laneId=`). Both pages accept URL params to auto-open the relevant drawer.

## Development Guardrails

### High-Risk Shared Surfaces
The following files are high-traffic and have had documented merge conflicts. Any task or agent that touches them must diff against the most recent main-branch state before making changes, and must NOT create a parallel implementation that shadows the existing one.

| File | Why it's high-risk | Canonical commit |
|------|-------------------|------------------|
| `server/routes/laneCarrierOutreach.ts` | Email prompt logic; multiple tasks have overwritten house-style prompt changes | `edbaed9` |
| `server/laneOutreachEmailBuilder.ts` | Shared fallback email builder; task #166 shipped it with all banned phrases intact | `edbaed9` |
| `client/src/components/CarrierOutreachPanel.tsx` | Has its own local fallbackBody; must not diverge from server fallback tone | `edbaed9` |
| `client/src/pages/company-detail/tabs/ActivityTab.tsx` | Deep component with touchpoint history section; missed refactor call site caused crash | `f91bc34` |
| `shared/laneFormatters.ts` | Used by both server and client; normalization logic must stay in sync | `edbaed9` |

### Lane Outreach Email Generation — Canonical Behavior
The following rules are the source of truth and must be preserved by all future tasks that touch email generation:

**Relationship history gate (`hasVerifiedHistory`)**
- `hasVerifiedHistory = !!carrier.payeeCode` — set only for carriers sourced from TMS financial data
- `!!carrierId` alone is NOT sufficient — being in the carrier catalog does not imply prior business
- Do NOT generate "we've run freight together" copy unless `hasVerifiedHistory` is true

**Banned phrases — must never appear in AI prompt output or fallback text**
- `carrier bench`, `we value our relationship`, `ongoing coverage`, `reaching out about`
- `love to connect`, `I'd love to`, `would love to`, `top of mind`
- `lane runs consistently`, `this lane runs consistently`, `keep you in mind`
- `corridor` (do not append "corridor" after a lane display string)
- Decimal load averages like `5.10 loads/week` (use `formatWeeklyLoadRange()` instead)

**Equipment normalization**
- Always pass `lane.equipmentType` through `normalizeEquipmentType()` before including in any prompt or email body
- Short unknown codes (e.g. `"po"`, `"dv"`, `"rf"`) must be mapped to human-readable terms

**Lane formatting**
- Always use `formatLaneDisplay(origin, originState, destination, destinationState)` from `shared/laneFormatters.ts`
- Do NOT concatenate raw city/state strings directly into prompts or email bodies

**Fallback path**
- Server fallback: `buildFallbackEmail()` in `server/laneOutreachEmailBuilder.ts` — single canonical implementation
- Client fallback: `fallbackBody` in `CarrierOutreachPanel.tsx` — must match the same tone as server fallback
- Never create a third parallel fallback implementation

**Tests**
- `tests/lane-formatters.test.ts` — 84 tests covering formatters, equipment normalization, and fallback email generation including banned-phrase audit
- `tests/guardrails.test.ts` — static analysis that checks actual source files for banned phrases, stale function calls, and implementation divergence
- Both must pass before any merge that touches the above files

### Refactor Safety Rules
Any global rename of a shared helper (e.g. `timeAgo` → `formatTimeAgo`) must:
1. Search for ALL call sites with `grep` before and after the change
2. Verify results include the deep/nested sections: ActivityTab touchpoint history, CarrierOutreachPanel History tab, Carrier Hub views
3. Add or update a test that would fail if the old name were called anywhere

### End-to-End Smoke Check Requirements
Before merging any task that touches the high-risk files above, verify:
- **Activity tab**: Open a company → click Activity tab → no "Something went wrong" error
- **CarrierOutreachPanel History tab**: Open LWQ → open a lane → click History tab → records visible (not blank)
- **Lane outreach generation**: Generate at least one draft email → verify no banned phrases in subject or body

### Source Visibility (Carrier Catalog / Hub)
- Admin Catalog (`/admin/carriers`) has a Source filter dropdown and color-coded source badges — implemented in `d62f4d6`
- Carrier Hub drawer shows friendly source labels (`Lane Upload · DAT Load Board`) instead of raw channel codes — implemented in `d62f4d6`
- These must survive any future task that touches `admin-carriers.tsx` or `carrier-hub.tsx`

### Momentum Score (Customer Cards)
- Customers page shows a Momentum Score pill in the top-right of each card header — implemented in `ec770ca`
- Uses `GROWTH_BAND_STYLES` from `account-growth-portlet.tsx`
- `data-testid="badge-momentum-header-{companyId}"` — hidden when no score
- Must survive any future task that touches `customers.tsx`

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o-mini)**: For AI-assisted features like RFP column mapping, lane gap insights, and email drafting.