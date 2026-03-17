# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
OrgChart CRM is a mini CRM application designed for transportation brokerage sales teams. Its primary purpose is to empower sales representatives to efficiently build and manage organizational charts for their customer accounts, track key contacts, and monitor their reporting structures. The system also facilitates tracking of shipping lanes, managed regions, freight spend, and spot bidding processes. A significant feature set includes dedicated RFP (Request for Proposal) and Award management functionalities, supported by Excel upload and data analysis capabilities for RFPs. The application aims to streamline sales workflows, enhance customer relationship management in the transportation sector, and provide data-driven insights for sales opportunities. It incorporates robust role-based access control (RBAC) to ensure data security and appropriate access levels for admin, national account managers, and account managers. The business vision is to provide a comprehensive, intuitive tool that significantly improves sales efficiency and strategic account penetration for transportation brokers, thereby increasing market share and revenue.

## User Preferences
I prefer clear and concise information. I like iterative development with regular updates. Please ask for my approval before implementing any major architectural changes or significant feature modifications. I value clean code and well-documented solutions.

## System Architecture

### UI/UX Decisions
The application utilizes a modern, responsive design built with React, TypeScript, and Tailwind CSS, leveraging `shadcn/ui` components for a consistent and polished look. It supports both dark and light modes, with blue and green accent colors providing a distinct brand identity. The dashboard features a gradient hero banner and KPI stat cards with intuitive icons. Navigation is handled by a responsive sidebar. Interactive elements like confetti animations are used to enhance user experience during key actions.

### Technical Implementations
- **Frontend**: React with TypeScript, using TanStack Query for data fetching and Wouter for client-side routing.
- **Backend**: Express.js with TypeScript, handling API endpoints, authentication, and file processing.
- **Database**: PostgreSQL with Drizzle ORM for type-safe database interactions.
- **Authentication**: Session-based authentication using `express-session`, `connect-pg-simple` for session storage in PostgreSQL, and `bcrypt` for password hashing. Role-based access control (RBAC) is implemented across all data and functionalities, filtering visibility based on user roles (Admin, Director, National Account Manager, Account Manager). Directors sit above NAMs in the hierarchy and can see data for all NAMs and AMs reporting to them.
- **File Processing**: `xlsx` (SheetJS) is used for parsing Excel/CSV files, and `multer` for handling file uploads, particularly for RFP and financial data.
- **Mapping & Geocoding**: Leaflet (direct integration, not `react-leaflet`) is used for interactive maps, specifically for a delivery heatmap. Custom geocoding logic (`server/geocoding.ts`) with pre-stored US city/state coordinates and Haversine distance calculations supports spatial analysis.
- **Data Models**: Key entities include Users (with role and manager hierarchy), Companies (assigned to account managers), Contacts (with reporting structures, lanes, regions, freight spend), RFPs (with detailed lane analysis and status tracking), Awards, and Tasks.
- **Key Features**:
    - **Company & Contact Management**: Full CRUD operations with detailed transportation-specific fields.
    - **Organizational Chart Visualization**: Hierarchical display of contact reporting structures.
    - **RFP & Award Management**: Dedicated modules with Excel upload for analysis, including automatic extraction of high-volume lanes.
    - **Lane Research & Assignment**: Functionality to research and assign ownership for high-volume lanes identified from RFPs.
    - **Analytical Features**:
        - **Facility Coverage Gap Analysis**: Identifies uncovered facilities from RFPs compared to existing contact coverages.
        - **Lane Pattern Analysis**: Analyzes top corridors, shipping/receiving hubs, and state-to-state volume.
        - **Historical Data Analysis**: Provides insights into delivery destination frequency, "hot zones," and historical lane corridors.
        - **Top Opportunities**: An intelligent engine cross-referencing delivery destinations with RFP lane origins to identify potential sales opportunities.
        - **Proximity Matches**: Identifies delivery zones within a 75-mile radius of customer RFP pickup origins.
        - **Lane Matching Portlet**: Overlaps historical freight network data with customer RFP lanes to identify backhaul and delivery opportunities.
    - **User Management**: Admin and National Account Manager interfaces for user CRUD operations and team hierarchy management.
    - **Account Transfer**: Functionality for admins and NAMs to reassign companies to different account managers.
    - **Global Search**: A live, debounced search across companies and users.
    - **OneDrive Sync**: For financial uploads, allowing direct fetching of Excel files from a specified OneDrive share link, eliminating manual upload.
    - **Task Assignment**: Create, assign, and track tasks with status cycling (open → in_progress → completed), due dates with color-coded badges (red=overdue, amber=today, yellow=soon), link to accounts. "My Tasks" portlet on dashboard; per-account tasks portlet on company detail page.
    - **Callouts / Trends Feed**: Shared communication feed where all users can post trends, callouts, and ideas. Posts can optionally be linked to a company account and tagged (Trend/Callout/Idea). Threaded replies under each post. Dashboard portlet shows recent callouts across all users; company detail portlet shows callouts tied to that specific account. Authors and admins can delete callouts and replies.
    - **1:1 Topics / Discussions**: A dashboard portlet for NAM↔AM pairings to maintain a running list of discussion points. Both sides can add topics with optional tags (Action Item, Question, FYI, Follow-up), mark topics as discussed, and close sessions (which archives them and carries pending topics forward). AMs see their single pairing with their manager; NAMs see tabs for each direct report; admins see all pairings. Data model: `oneOnOneSessions` and `oneOnOneTopics` tables. Component: `client/src/components/one-on-one-portlet.tsx`.
    - **Goals System**: NAMs set goals for their AMs with metrics (New Contacts, Touchpoints, Load Count, Margin). Contacts Added and Touchpoints are auto-tracked; Load Count and Margin are manually updated. Inline comments per goal. Data model: `goals` and `goalComments` tables. Page: `client/src/pages/goals.tsx`.
    - **Touchpoints**: Log interactions with contacts (Call, Email, Text, Site Visit) with date and optional note. Contact cards show last touch recency badge (green/amber/red) and weekly count. Org chart contacts have a color-coded recency dot. Company detail shows touchpoints summary card + activity feed. Dashboard shows "Contacts Needing Attention" portlet for contacts untouched 30+ days. Clickable contact cards open a ContactDetailSheet with full details, touchpoint history, and quick log. Data model: `touchpoints` table. Component: `client/src/components/contact-detail-sheet.tsx`.
    - **PTO Passoff**: When a rep is going on PTO, they create a "passoff" with date range, who is covering, and emergency contact. Per-account checklist cards capture: priority level (High/Medium/Low), spot freight handler, key customer contact, open items/follow-ups, process notes (account quirks), and active RFPs/bids. The covering person gets a dedicated "I'm Covering" tab and can acknowledge each account. Admins/directors see all active passoffs. Data model: `ptoPassoffs` and `ptoPassoffItems` tables. Page: `client/src/pages/pto-passoff.tsx`.
    - **Customer Scorecard**: Each company profile has a dedicated "Customer Scorecard" card in the right sidebar. Users can upload and download scorecard documents (PDFs, Word, Excel, images) directly on the account page. Files are stored via the attachments system with entityType `"scorecard"` and the company ID as the entityId. Access is controlled by the same RBAC rules as company access.
    - **File Attachments**: Supports attaching files (PDFs, Word docs, Excel/CSV, images) to feed posts, 1:1 discussion topics, contact touchpoints, tasks, and customer scorecards. Files are stored as base64 in the `attachments` table. Max 10MB per file. Download-only (no inline preview). Attachments can be deleted individually (hover to reveal trash icon with inline confirm). Reusable component: `client/src/components/file-attachment.tsx` exports `FileAttachmentUpload`, `FileAttachmentList`, and `uploadPendingFiles`. API routes: `POST /api/attachments`, `GET /api/attachments`, `GET /api/attachments/:id/download`, `DELETE /api/attachments/:id`. Express JSON body limit set to 15mb.
    - **Financial Alias**: Companies have an optional `financial_alias` field (stored in `companies.financial_alias`) to specify an alternate name for matching against uploaded financial/account-summary data. Editable inline on the company detail page. Falls back to `company.name` if no alias is set. Matching logic checks alias first in both `customers.tsx` and `company-detail.tsx`.
    - **Quick Log Touch**: Customer list cards and company detail page header both have a "Log Touch" phone icon button. Opens a compact dialog with contact picker + touch type selector (Call/Email/Text/Site Visit). Submits immediately to `/api/contacts/:id/touchpoints`.
    - **Dashboard Alerts**: Dashboard shows contextual alert cards: (1) RFP Deadlines Approaching — red card listing RFPs due within 14 days with days-remaining badges; (2) Goals Need Attention — amber card on the 15th+ of the month showing goals under 50% progress with mini progress bars; (3) Monthly Goals Not Set — existing NAM alert for missing AM goals; (4) 1:1 Pending Topics badge — numeric badge on the 1:1 portlet showing open undiscussed topics count.
    - **Task from Cold Contacts**: "Contacts Needing Attention" dashboard portlet rows show a "+" button on hover. Clicking opens the task dialog pre-filled with "Follow up with [Contact Name]" and the company pre-selected.
    - **PTO Passoff Handback**: Active passoffs show a "Close & Return Accounts" button (green outline) for the passoff owner. Clicking sets `status = "closed"` via PATCH `/api/pto-passoffs/:id`.

## External Dependencies
- **PostgreSQL**: Primary database for all application data and session storage.
- **xlsx (SheetJS)**: For parsing and processing Excel/CSV file uploads.
- **multer**: Middleware for handling multi-part form data, primarily for file uploads.
- **Leaflet**: JavaScript library for interactive maps, used for visualizing delivery densities.
- **OneDrive API (Microsoft Graph API)**: Utilized for fetching Excel files from OneDrive shared links for financial data synchronization.
- **node-cron**: Used for scheduling recurring jobs (monthly goal alerts, monthly data refresh).

## Schedulers
- **Monthly Goal Scheduler** (`server/monthlyGoalScheduler.ts`): Runs daily at 8 AM (configurable via `MONTHLY_GOAL_CRON` env var). On the first business day of each month, creates goal-setting reminders for NAMs.
- **Monthly Data Refresh Scheduler** (`server/monthlyDataRefreshScheduler.ts`): Runs daily at 7 AM (configurable via `MONTHLY_DATA_REFRESH_CRON` env var). On the first business day of each month, automatically triggers the OneDrive sync. On failure, sets `monthly_sync_failed` flag in `app_settings` and notifies admins. A dismissible banner appears on the admin dashboard when a sync failure has occurred. The flag is cleared when a manual sync or upload succeeds, or when an admin dismisses the alert. The shared `performOneDriveSync()` function is used by both the scheduler and the manual sync API route.