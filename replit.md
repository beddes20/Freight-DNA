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
    - **Carrier Hub (Phase 1)**: Central carrier intelligence layer with contact management, claimed lanes, and activity tracking.

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o-mini)**: For AI-assisted features like RFP column mapping, lane gap insights, and email drafting.