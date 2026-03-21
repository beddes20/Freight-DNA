# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a mini CRM application designed for transportation brokerage sales teams. It enables sales representatives to build and manage organizational charts for customer accounts, track contacts, reporting structures, shipping lanes, managed regions, freight spend, and spot bidding. Key functionalities include dedicated RFP and Award management with Excel upload and data analysis, aiming to streamline sales workflows and enhance customer relationship management. The system incorporates robust role-based access control (RBAC) for admins, national account managers, and account managers. The business vision is to significantly improve sales efficiency, strategic account penetration, and ultimately increase market share and revenue for transportation brokers.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application uses React, TypeScript, and Tailwind CSS with `shadcn/ui` for a modern, responsive design. It supports dark/light modes, features blue and green accent colors, a gradient hero banner, and KPI stat cards on the dashboard. Navigation is via a responsive sidebar, and interactive elements like confetti animations enhance user experience.

### Technical Implementations
- **Frontend**: React with TypeScript, TanStack Query for data fetching, and Wouter for routing.
- **Backend**: Express.js with TypeScript for API, authentication, and file processing.
- **Database**: PostgreSQL with Drizzle ORM.
- **Authentication**: Session-based authentication using `express-session`, `connect-pg-simple`, and `bcrypt` for password hashing. Role-based access control (RBAC) filters data visibility based on user roles (Admin, Director, National Account Manager, Account Manager). Directors oversee NAMs and AMs.
- **File Processing**: `xlsx` (SheetJS) for Excel/CSV parsing and `multer` for file uploads.
- **Mapping & Geocoding**: Leaflet for interactive maps (e.g., delivery heatmap), supported by custom server-side geocoding and Haversine distance calculations.
- **Data Models**: Key entities include Users, Companies, Contacts, RFPs, Awards, and Tasks, supporting hierarchical relationships and specific transportation data.
- **Key Features**:
    - **Company & Contact Management**: Full CRUD operations with transportation-specific fields and organizational chart visualization.
    - **RFP & Award Management**: Modules for managing RFPs and awards, including Excel upload for lane analysis.
    - **Lane Research & Assignment**: Identification and assignment of high-volume lanes from RFPs.
    - **Analytical Features**: Facility coverage gap analysis, lane pattern analysis, historical data analysis, top opportunities identification, proximity matches, and a lane matching portlet.
    - **User Management & Account Transfer**: Admin and NAM tools for user management, team hierarchy, and company reassignment.
    - **Global Search**: Live, debounced search across companies and users.
    - **OneDrive Sync**: Direct fetching of Excel files from OneDrive for financial data, eliminating manual uploads.
    - **Task Assignment**: Creation, assignment, and tracking of tasks with status, due dates, and links to accounts.
    - **Callouts / Trends Feed**: A shared communication feed for trends, callouts, and ideas, linkable to accounts and supporting threaded replies.
    - **1:1 Topics / Discussions**: A dashboard portlet for NAM-AM pairings to manage discussion points, with support for topics, tags, and threaded replies.
    - **Goals System**: NAMs set and track goals for AMs, including auto-tracked metrics (Contacts Added, Touchpoints) and manually updated ones (Load Count, Margin, Custom).
    - **Touchpoints**: Logging of contact interactions (Call, Email, Text, Site Visit) with recency tracking and "Contacts Needing Attention" alerts.
    - **PTO Passoff**: System for reps to create passoffs during PTO, detailing coverage, emergency contacts, and account-specific checklists for covering personnel.
    - **Account Intelligence**: Dedicated fields within company profiles for portal credentials, financial aliases, tendering process, spot process, dispatch email, account quirks, and process notes.
    - **Customer Scorecard**: Ability to upload and download scorecard documents directly on company profiles, secured by RBAC.
    - **File Attachments**: Generic attachment system for various entities (posts, 1:1 topics, touchpoints, tasks, scorecards), storing files as base64 with download functionality.
    - **Salesperson Linking**: Companies linked to sales users (`sales_person_id`), auto-populated from financial data uploads and manually overrideable.
    - **Quick Log Touch**: Streamlined logging of contact touchpoints from customer lists and company detail pages.
    - **Dashboard Alerts**: Contextual alerts for RFP deadlines, goal progress, missing goals, and pending 1:1 topics.
    - **Task from Cold Contacts**: Direct task creation for contacts needing attention from the dashboard.
    - **PTO Passoff Handback**: Functionality for PTO owners to close and return accounts upon their return.

## External Dependencies
- **PostgreSQL**: Database and session storage.
- **xlsx (SheetJS)**: Excel/CSV parsing.
- **multer**: File upload handling.
- **Leaflet**: Interactive mapping.
- **OneDrive API (Microsoft Graph API)**: Financial data synchronization.
- **node-cron**: Scheduling recurring jobs.
### Email
- **Primary provider**: Resend (`RESEND_API_KEY` Replit Secret) — recommended; works from cloud hosting
- **Fallback provider**: GoDaddy SMTP via `smtpout.secureserver.net:465` (SSL) — blocked by GoDaddy from cloud IPs; only works locally
- **From address**: `info@freight-dna.com` (env: `SMTP_FROM`)
- **Env vars**: `SMTP_HOST=smtpout.secureserver.net`, `SMTP_PORT=465`, `SMTP_FROM=info@freight-dna.com`, `SMTP_FROM_NAME` (all set in shared env)
- **Secrets**: `SMTP_PASSWORD` (GoDaddy password — kept for fallback), `RESEND_API_KEY` (Resend API key — set this to fix email)
- **Priority**: `emailService.ts` checks `RESEND_API_KEY` first; falls back to SMTP if not set
- **Domain verification**: `freight-dna.com` must be verified in Resend dashboard (add DNS records in GoDaddy)
- **Rep Report emails**: Weekly (Mon 7am cron) + Monthly (1st of month 7am cron) via `repReportScheduler.ts`
- **Template**: Styled HTML matching brand colors; built in `emailService.ts` → `buildRepReportEmail()`
- **Manual send**: `POST /api/report/rep/:userId/send-email` (button on report page)
- **Email config test**: `POST /api/admin/smtp/test` — admin-only; UI panel at bottom of User Management page
### Relationship Health & Pre-Call Planner
- **Health Score**: `GET /api/companies/:id/health-score` — computes a 0–100 score from 5 factors: Touchpoint Recency (30), Engagement Frequency (25), Contact Depth (20), RFP/Award Activity (15), Financial Data (10). Returns grade (Excellent/Good/Fair/At Risk) and color. Badge renders next to company name on detail page; clicking opens Pre-Call Brief.
- **Pre-Call Planner**: Modal (`client/src/components/pre-call-planner.tsx`) accessible from company detail header — shows financial snapshot, key contacts with last touch, last 5 touchpoints, open tasks, active RFPs/awards, account intelligence (quirks, spot process, tender style, DL email), and full health score factor breakdown. Includes print button.
- **Claims Portal Button**: `GET /api/config/claims-url` returns the `CLAIMS_PORTAL_URL` env var. Claims button appears in company detail header only when the env var is set; opens the claims portal in a new tab.
