# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a specialized mini CRM application for transportation brokerage sales teams. Its purpose is to streamline sales workflows by managing customer accounts, organizational charts, contacts, and shipping data. It includes RFP and Award management with Excel upload and analytical tools. The system aims to enhance customer relationship management, drive sales efficiency, facilitate strategic account penetration, and increase revenue for transportation brokers, supported by robust role-based access control (RBAC).

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
    - **LWQ ↔ Carrier Hub Cross-Linking**: Provides explanations for ranked carrier suggestions and allows navigation to Carrier Hub profiles.
    - **Customer Contact Capture from Email**: Detects new people in account-linked email threads and surfaces lightweight contact suggestions.
    - **Two-Way Carrier Email**: Outbound emails to carriers include a reply-to address routed through Microsoft Graph webhook; inbound replies matched to outreach logs.
    - **Inbound Reply Surfaces**: Inbound carrier replies are surfaced across Lane Work Queue, My Procurement, and the sidebar with a `needsAction` distinction.
- **Carrier History & Ranking Contract**: Governs carrier ranking and TMS history display logic. Defines TMS field-name handling (title-case-with-spaces and camelCase), carrier name parsing (stripping payee codes), month normalization to "YYYY-MM", and an HQ proximity bonus for ranking.
- **Ranking Guarantee**: A 5-tier geo-aware system ensures TMS history outranks catalog-region-only carriers. Tiers: "exact", "nearby", "state_pair", "region", "none" with defined `fitScore` floor bands.
- **Shared History Source**: LWQ and Carrier Hub read from the same `financial_uploads.rows` JSONB source via a shared utility layer, ensuring consistency.

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization and reply webhook routing.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o-mini)**: For AI-assisted features (RFP column mapping, lane gap insights, email drafting).
- **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook subscription.