# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a mini CRM application for transportation brokerage sales teams. Its primary purpose is to empower sales representatives to efficiently manage customer accounts, build organizational charts, track contacts, and oversee shipping-related data such as lanes, regions, freight spend, and spot bidding. The system includes dedicated RFP and Award management with Excel upload and analytical capabilities. The overarching goal is to streamline sales workflows, enhance customer relationship management, and ultimately drive increased sales efficiency, strategic account penetration, and revenue growth for transportation brokers. It features robust role-based access control (RBAC) for various management levels.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application utilizes React, TypeScript, and Tailwind CSS with `shadcn/ui` to deliver a modern and responsive user interface. It incorporates dark/light mode switching, uses blue and green accent colors, features a gradient hero banner, and displays KPI stat cards on the dashboard. Navigation is managed through a responsive sidebar, complemented by interactive elements like confetti animations. The theme predominantly features a black sidebar/header with amber gold accents, specific branding elements like the Value Truck logo, and mantras displayed in the top header.

### Technical Implementations
- **Frontend**: Built with React, TypeScript, TanStack Query for data fetching, and Wouter for routing.
- **Backend**: An Express.js server developed with TypeScript handles API requests, authentication, and file processing.
- **Database**: PostgreSQL is used as the primary data store, managed with Drizzle ORM.
- **Authentication**: The system employs session-based authentication using `express-session`, `connect-pg-simple`, and `bcrypt` for secure password hashing. Role-based access control (RBAC) dynamically filters data visibility based on user roles (Admin, Director, National Account Manager, Account Manager, Logistics Manager, Logistics Coordinator).
- **File Processing**: Excel and CSV parsing are handled by `xlsx` (SheetJS), while `multer` is used for file uploads.
- **Mapping & Geocoding**: Interactive maps are powered by Leaflet, integrated with custom server-side geocoding and Haversine distance calculations for features like delivery heatmaps.
- **Data Models**: Core entities include Users, Companies, Contacts, RFPs, Awards, and Tasks, designed to support hierarchical relationships and specific transportation industry data.
- **Key Features**:
    - **CRM Capabilities**: Comprehensive CRUD operations for company and contact management, including organizational chart visualization and transportation-specific fields.
    - **RFP & Award Management**: Modules for managing RFPs and awards, featuring Excel upload with AI-assisted column mapping.
    - **Analytical Tools**: Includes lane research, facility coverage gap analysis, lane pattern analysis, historical data analysis, top opportunities identification, and a lane matching portlet. Wallet share calculation is dynamically presented based on RFP data or estimated spend.
    - **User and Team Management**: Tools for user administration, team hierarchy management, and company reassignment, along with features for PTO passoff and account handback.
    - **Data Integration & Sync**: Global search functionality, OneDrive synchronization for financial data, and a system for attaching files to various entities.
    - **Communication & Collaboration**: Task assignment and tracking, a shared callouts/trends feed, and 1:1 discussion topics between managers and their reports.
    - **Goal Setting & Tracking**: A system for National Account Managers (NAMs) to set and track goals for Account Managers (AMs), including automated and manual metrics.
    - **Customer Interaction Tracking**: Logging of contact touchpoints (calls, emails, texts, site visits) with recency tracking, "Contacts Needing Attention" alerts, and the ability to mark "meaningful" conversations.
    - **Account Intelligence**: Dedicated fields within company profiles for critical operational and financial details, including portal credentials, tendering processes, and account quirks.
    - **Customer Scorecard**: Secure upload and download of customer scorecard documents.
    - **Dashboard Enhancements**: Contextual alerts for RFP deadlines, goal progress, and pending 1:1 topics, along with specialized dashboard portlets for LMs, AMs, and NAMs, providing role-specific insights and metrics.
    - **AI-Powered Insights**: AI-generated talking points for lane gap insights, incorporating account context for enhanced daily brief emails and chatbot prompts. Includes: AI health score narrative (2-sentence GPT-4o-mini "why" explanation shown in company detail and pre-call planner), AI touchpoint note summary (auto-summarizes last 5 touchpoint notes in pre-call planner), proactive nudge alerts in DNA Guru chatbot (goals behind, cold contacts, urgent RFPs, tasks due today), and lane gap priority scoring (High/Medium/Low badges on corridor rows ranked by volume, multi-RFP presence, award status, and count).
    - **DNA Guru Action Execution**: Chatbot supports OpenAI function calling for `log_touchpoint` (call/email/text/site_visit) and `create_task` actions — AI proposes inline confirmation cards, user confirms to execute against the CRM.
    - **Health and Momentum Scoring**: Automated calculation of company health and momentum scores based on various interaction and activity factors.
    - **Shipping Mode Management**: Categorization and filtering of companies by shipping modes (LTL, FTL, Drayage, IMDL).
    - **Relationship Freight Reporting**: `contact_lane_attributions` table lets reps assign lane patterns (origin/dest state+city) to individual contacts. Freight loads from financial uploads are then matched and attributed to each contact's relationship base level (1st/2nd/3rd/Home Run). Portlets appear on the dashboard and on each company's overview tab, showing loads, margin, contracted %, and spot % per level. The `ContactLaneManager` component in contact detail sheets handles add/remove of lane attributions.
    - **Relationship Advancement History**: `contact_base_history` table tracks every base change (from/to/who/when). History logs on every PATCH /contacts/:id when relationshipBase changes, and is displayed as a timeline in the contact detail sheet.
    - **Dashboard Consolidation**: Single `/api/dashboard-relationship-summary` endpoint replaces 3 separate relationship API calls on the dashboard. `RelationshipDashboardSection` wrapper passes pre-fetched data to both portlets via props, eliminating redundant queries.
    - **Greenfield Visibility**: Coverage portlet shows "Unworked Accounts" count — companies with no contacts assigned to any relationship base level.
    - **Pre-call Planner Relationship Intel**: Contact cards in the pre-call planner now display relationship base badge (1st/2nd/3rd/HR), lane count, loads, and margin sourced from the company's freight summary.
    - **Feedback Inbox Admin Responses**: Admins can type a response to any feedback submission. Response is saved, displayed in the inbox, and the submitter is notified by email (using their username as the email address).
    - **Contact Data Completeness Nudge**: Contact cards in the People tab show amber warning badges for missing email, missing phone, or never-contacted status, prompting reps to fill in data gaps.
    - **Company Activity Timeline**: Unified chronological feed at the top of each company's Activity tab, interleaving touchpoints and tasks sorted newest-first with icon-coded event types.
    - **RFP & Task Calendar**: Monthly calendar page (`/rfp-calendar`) showing RFP deadlines (red) and task due dates (blue) with an "Upcoming Deadlines" sidebar panel for 60-day lookahead. Accessible to all users from the Pipeline section in the sidebar.
    - **Rep Scorecard / Director Leaderboard**: Director/admin-only page (`/rep-scorecard`) showing all reps ranked by weekly touchpoints with goal progress bars, breakdown cards per rep, and sortable columns. Backed by `/api/rep-scorecard` endpoint. Accessible from the Pipeline section.
    - **AI Email Drafting**: "Draft for me" button in the email compose dialog calls `POST /api/ai/draft-email`. Generates a personalized draft using GPT-4o-mini with contact context (title, interests, next steps, relationship level) and recent touchpoint notes.

## External Dependencies
- **PostgreSQL**: Used for database management and session storage.
- **xlsx (SheetJS)**: Employed for parsing Excel and CSV files.
- **multer**: Handles file uploads.
- **Leaflet**: Provides interactive mapping capabilities.
- **OneDrive API (Microsoft Graph API)**: Facilitates synchronization of financial data.
- **node-cron**: Used for scheduling recurring jobs, such as report generation and daily digest emails.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails, with Resend as the primary and GoDaddy SMTP as a fallback.
- **OpenAI (GPT-4o-mini)**: Integrated for AI-assisted features like RFP column mapping suggestions, lane gap insights, and AI-generated "Priority for Today" in daily briefs.