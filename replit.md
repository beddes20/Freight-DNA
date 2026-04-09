# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a specialized mini CRM application for transportation brokerage sales teams. It streamlines sales workflows by managing customer accounts, organizational charts, contacts, and shipping data such as lanes, regions, freight spend, and spot bidding. The system includes RFP and Award management with Excel upload and analytical tools. Its main purpose is to enhance customer relationship management, drive sales efficiency, facilitate strategic account penetration, and increase revenue for transportation brokers, supported by robust role-based access control (RBAC).

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
    - **CRM**: CRUD operations for companies and contacts, with org chart visualization.
    - **RFP & Award Management**: Modules for RFPs and awards, with AI-assisted Excel upload.
    - **Analytics**: Lane research, facility coverage gap analysis, lane pattern analysis, historical data, and wallet share.
    - **User & Team Management**: Administration, hierarchy, and account reassignment.
    - **Data Integration**: Global search, OneDrive sync, and file attachments.
    - **Communication**: Task assignment, shared callouts/trends, and discussion topics.
    - **Goal Tracking**: For National Account Managers to track goals for Account Managers.
    - **Customer Interaction**: Touchpoint logging, recency tracking, and "Contacts Needing Attention" alerts.
    - **Account Intelligence**: Dedicated fields for operational details and portal credentials.
    - **Customer Scorecard**: Secure upload/download of scorecard documents.
    - **Dashboard**: Contextual alerts, goal progress, and role-specific insights.
    - **Momentum Score**: Automated company health/momentum scores (At Risk, Stable, Growth Ready, High Expansion), with a detailed breakdown drawer on company profiles and customer lists.
    - **AI-Powered Insights**: AI-generated talking points, health score narratives, touchpoint note summaries, and proactive nudges via chatbot.
    - **AI Action Execution**: Chatbot supports OpenAI function calling for `log_touchpoint` and `create_task`.
    - **Shipping Modes**: Categorization and filtering by shipping modes.
    - **Relationship Freight Reporting**: Attributing freight loads to contacts and relationship bases.
    - **Relationship Advancement History**: Tracks changes in contact relationship bases.
    - **Greenfield Visibility**: Identifies "Unworked Accounts."
    - **Pre-call Planner**: Displays relationship intelligence on contact cards.
    - **Feedback Inbox**: Admins can respond to feedback with email notifications.
    - **Company Activity Timeline**: Unified chronological feed of events.
    - **Calendar**: RFP deadlines and task due dates.
    - **Rep Scorecard / Director Leaderboard**: Admin-only page for ranking reps.
    - **AI Email Drafting**: Generates personalized email drafts using GPT-4o-mini.
    - **NBA (Next Best Action) Phase 1**: Recommendation engine generating persistent cards based on freight data rules (e.g., Load Decline, Single-Thread Risk, Stale Account).
    - **Lane Carrier Outreach Workflow**: Assignable lane workflow with work queues, carrier contactability, and email sending/tracking.
    - **Stable Coverage System**: Computes per-lane coverage profiles (Stable/Watch/Unstable) from TMS history, tracks incumbent carriers, and broadens search modes.
    - **My Procurement**: Personal unified work surface for reps at `/my-procurement`, showing LWQ lane assignments and open award carrier procurement tasks.
    - **Carrier Hub (Phase 1)**: Central carrier intelligence layer with contact management, claimed lanes, and activity tracking.
    - **LWQ ↔ Carrier Hub Cross-Linking**: Provides explanations for ranked carrier suggestions and allows navigation to Carrier Hub profiles.

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o-mini)**: For AI-assisted features (RFP column mapping, lane gap insights, email drafting).