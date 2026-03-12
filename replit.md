# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
A mini CRM application designed for transportation brokerage sales teams to build and manage organizational charts for their customer accounts. The application allows sales reps to track contacts, their reporting structure, lanes/regions they manage, freight spend, and spot bidding processes. Includes separate RFP and Award management with Excel upload and data analysis for RFPs. Features role-based access control (RBAC) with admin, national account manager, and account manager roles.

## Tech Stack
- **Frontend**: React with TypeScript, TanStack Query, Wouter routing
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Styling**: Tailwind CSS with shadcn/ui components
- **Auth**: express-session + connect-pg-simple + bcrypt (email/password login)
- **File Processing**: xlsx (SheetJS) for Excel/CSV parsing, multer for file uploads
- **Mapping**: Leaflet (direct, no react-leaflet) with dynamic import for interactive delivery heatmap
- **Geocoding**: Custom `server/geocoding.ts` with ~600+ US city coordinates + state centers + haversine distance

## Project Structure
```
client/src/
  ├── components/
  │   ├── app-sidebar.tsx     # Main navigation sidebar (with user info + logout + admin link)
  │   ├── award-dialog.tsx    # Add/edit award modal
  │   ├── company-dialog.tsx  # Add/edit company modal (with "Assign To" for admins)
  │   ├── contact-dialog.tsx  # Add/edit contact modal
  │   ├── contact-list.tsx    # List view for contacts
  │   ├── org-chart.tsx       # Hierarchical org chart visualization
  │   ├── research-lane-dialog.tsx # "Research Lane Owner" modal for assigning AM
  │   ├── rfp-dialog.tsx      # Add/edit RFP modal
  │   └── theme-toggle.tsx    # Dark/light mode toggle
  ├── hooks/
  │   └── use-auth.ts         # Auth hook (login/register/logout/current user)
  ├── pages/
  │   ├── admin-users.tsx     # Admin user management page (CRUD users, roles, managers)
  │   ├── dashboard.tsx       # Overview with stats and "My Customers" links
  │   ├── company-detail.tsx  # Company detail with org chart + RFP & Awards button + high-volume lanes
  │   ├── customers.tsx       # Customer listing with contact counts and research task badges
  │   ├── login.tsx           # Login/register page
  │   ├── rfp-awards.tsx      # RFP & Awards page with Excel upload
  │   ├── research-tasks.tsx  # Research tasks overview page
  │   ├── financials.tsx      # Numbers page: financial KPIs + upload management (admin/NAM only)
  │   ├── historical-data.tsx # Historical Data page: delivery density by city/state, hot zones (admin/NAM only)
  │   └── top-opportunities.tsx # Top Opportunities page: matched RFP lanes vs hot delivery destinations (all users)
  └── App.tsx                 # Main app with routing + auth gating

server/
  ├── auth.ts                 # Auth middleware, session setup, role-based visibility
  ├── routes.ts               # API endpoints (incl. file upload, user management)
  └── storage.ts              # Database operations

shared/
  └── schema.ts               # Database schema and types
```

## Data Models

### Users
- id, username (email), password (bcrypt hashed), name
- role: "admin" | "national_account_manager" | "account_manager"
- managerId (FK to self for team hierarchy)

### Companies
- id, name, industry, website, notes
- assignedTo (FK to users - which account manager owns this company)
- portalUrl, portalUsername, portalPassword (customer portal login credentials)

### Contacts
- id, companyId (FK), name, title, email, phone
- relationshipBase (baseball-themed: 1st base, 2nd base, 3rd base, homerun)
- reportsToId (FK to self for org hierarchy)
- lanes (array of shipping lanes)
- regions (array of geographic regions)
- freightSpend (annual freight spend in dollars)
- spotBiddingProcess (description of their bidding process)
- interests, notes

### RFPs (separate entity)
- id, companyId (FK), title, status (pending/submitted)
- value, dueDate, notes
- fileName, fileData (JSON: { rows[], highVolumeLanes[] } from Excel upload)
- laneCount, totalVolume, originStates[], destinationStates[]
- High-volume lanes (>50 annual shipments) are auto-extracted and stored in fileData.highVolumeLanes
- Each high-volume lane can have a `status` (open/contact_added/researched) and `contactId` stored in the fileData JSON

### Awards (separate entity)
- id, companyId (FK), title, value, awardDate
- lanes (array), notes

## RBAC (Role-Based Access Control)
- **Admin**: Full access to everything; can manage users, assign companies, see all data
- **National Account Manager**: Sees own companies + companies assigned to their direct/indirect reports (account managers underneath them)
- **Account Manager**: Sees only companies assigned to them
- First user to register automatically gets admin role
- Auth: session-based with PostgreSQL session store
- All `/api/` routes (except `/api/auth/*`) require authentication
- Company list, contacts, RFPs, awards, and research tasks are all filtered by role visibility

## Key Features
1. **Dashboard**: Gradient hero banner, KPI stat cards with colored icons, "My Customers" quick links, "Top Contacts by Freight Spend" leaderboard
2. **Company Management**: Create, edit, delete companies with industry and website info; admin can assign to any user
3. **Contact Management**: Full CRUD for contacts with transportation-specific fields; confetti celebration animation on save
4. **Org Chart**: Visual hierarchical display showing reporting relationships
5. **RFP Management**: Separate RFP tracking with Excel drag-and-drop upload + data analysis
6. **Award Management**: Separate award tracking for won business
7. **Excel Upload**: Drag-and-drop Excel/CSV files to auto-create RFPs with lane analysis; animated loading spinner during upload
8. **Dark/Light Mode**: Theme toggle in sidebar footer; full dark/light theme support with blue and green accent colors
9. **Lane Research & Assignment**: High-volume lanes table with "Assign Lane to Planner" button; opens "Research Lane Owner" modal with pre-filled lane data + decision-maker contact form; saves contact and marks lane status (Open → Contact Added → Researched); confetti animation on save
10. **Research Tasks Page**: Dedicated sidebar page showing all open/completed research tasks across all RFPs with filtering and search
11. **Loading Spinners**: All save/upload/delete buttons show animated spinner + text during pending operations
12. **Responsive Design**: Mobile-first padding (p-4 sm:p-6), responsive grid layouts across all pages
13. **Export to Excel**: Company detail page exports org chart + contacts + high-volume lanes to .xlsx
14. **Facility Coverage Gap Analysis**: Company detail page shows all unique facilities (origins/destinations) from RFP lanes, cross-referenced against existing contacts' lanes/regions; gaps (uncovered facilities) are highlighted in red with "Find Planner" button; covered facilities shown in green with assigned contact name
15. **Lane Pattern Analysis**: Company detail page with tabbed analysis: Top Corridors (highest-volume origin→destination pairs, with Multi-RFP badges), Shipping/Receiving Hubs (facilities appearing as both origins and destinations with inbound/outbound breakdown), State Corridors (state-to-state volume with visual bar chart)
16. **User Management**: Admin + NAM page for CRUD operations on users; admins see all users/all roles; NAMs see/create/edit/delete only their Account Managers (role and manager fields hidden for NAM-created users); sidebar shows "My Team" for NAMs
17. **Authentication**: Email/password login with session persistence; login/register page with gradient branding
18. **Account Transfer**: Company detail page has "Transfer Account" button (visible to admins and NAMs); opens dialog to reassign company to another user; admins can assign to anyone, NAMs can only assign within their team
19. **Customer Portal Information**: Company detail page shows a portal info card (URL, username, password) near the top action buttons; inline editable with password reveal toggle; stored in DB
20. **Historical Data Page**: `/historical-data` — delivery destination frequency ranked by weekly load count; "hot zones" (5+ loads/week) highlighted in orange; summary stats (total loads, unique destinations, hot zone count); search filter. Admin/NAM only.
21. **Top Opportunities Page**: `/top-opportunities` — intelligent opportunity engine that cross-references delivery destinations (where we drop trucks) against RFP lane origins (where shippers need pickups); each opportunity card shows destination, weekly frequency, and all matched RFP lanes (company, RFP title, lane corridor, volume, rate, equipment); visible to all users.
22. **Global Search**: Search bar in top header searches across accounts (companies), account managers, and NAMs by name; live dropdown grouped by type; navigates to company detail or rep page on selection; debounced with abort on new keystroke.
23. **Historical Data Tabs**: Historical Data page has 4 tabs — (1) Overview: hot zones + all destinations ranked by avg weekly loads; (2) Lane Corridors: top origin→destination pairs from dispatch data sorted by total loads, searchable table; (3) Density Map: interactive Leaflet map with blue circles (deliveries) and green circles (pickups) scaled by volume; (4) Proximity Matches: delivery zones within 75 miles of customer RFP pickup origins, expandable zone cards showing matched companies/RFPs with exact distance and assigned rep.
24. **Lane Matching Portlet**: Company detail page portlet showing where our historical freight network overlaps with a customer's RFP lanes (75-mile radius). Two toggle views: "Our Deliveries → Their Pickups" (where we drop trucks near customer's RFP pickup origins) and "Their Deliveries → Our Pickups" (where customer needs delivery near our historical pickup locations — backhaul opportunities). Shows customer lane, matched city, distance badge, weekly loads, and RFP source.
25. **OneDrive Sync**: Numbers page has "OneDrive Sync" card (admin/NAM visible). Admin can save a OneDrive share link (stored in `app_settings` table). "Sync from OneDrive" button fetches the latest Excel file from OneDrive via the shares API, parses it with xlsx, and saves as a new financial upload — no manual download/re-upload needed. Requires the OneDrive file to be shared with "Anyone with the link can view" permissions.

## UI Components
- `client/src/components/confetti.tsx` - Confetti celebration animation (useConfetti hook)
- `client/src/components/theme-toggle.tsx` - Dark/light mode toggle button
- Blue + green gradient branding throughout (sidebar logo, dashboard hero, stat cards)

## API Endpoints
### Auth
- `POST /api/auth/register` - Register new user (first user = admin)
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Users (admin only)
- `GET /api/users` - List all users
- `POST /api/users` - Create user
- `PATCH /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user

### Companies (filtered by role)
- `GET /api/companies` - List visible companies
- `POST /api/companies` - Create company
- `GET /api/companies/:id` - Get company details
- `PATCH /api/companies/:id` - Update company
- `DELETE /api/companies/:id` - Delete company
- `GET /api/companies/:id/contacts` - Get contacts for company
- `POST /api/companies/:id/contacts` - Create contact

### Contacts (filtered by role)
- `GET /api/contacts` - List all visible contacts
- `PATCH /api/contacts/:id` - Update contact
- `DELETE /api/contacts/:id` - Delete contact

### RFPs (filtered by role)
- `GET /api/rfps` - List visible RFPs
- `POST /api/rfps` - Create RFP manually
- `POST /api/rfps/upload` - Upload Excel/CSV and create RFP with analysis
- `PATCH /api/rfps/:id` - Update RFP
- `DELETE /api/rfps/:id` - Delete RFP
- `PATCH /api/rfps/:id/lanes/:laneIndex/status` - Update high-volume lane research status

### Awards (filtered by role)
- `GET /api/awards` - List visible awards
- `POST /api/awards` - Create award
- `PATCH /api/awards/:id` - Update award
- `DELETE /api/awards/:id` - Delete award

### Settings & Sync
- `GET /api/settings/onedrive-url` - Get stored OneDrive share URL (admin/NAM)
- `PATCH /api/settings/onedrive-url` - Save OneDrive share URL (admin only)
- `POST /api/financials/sync-onedrive` - Fetch Excel from OneDrive and create financial upload (admin only)

### Analysis
- `GET /api/research-tasks` - Get visible research tasks across all RFPs
- `GET /api/companies/:id/facility-coverage` - Facility coverage gap analysis for a company
- `GET /api/companies/:id/lane-patterns` - Lane pattern analysis (corridors, hubs, state corridors)
- `GET /api/historical-data-summary` - Delivery destination density (weekly load counts, hot zones) from all financial_uploads
- `GET /api/historical-lane-corridors` - Top origin→destination pairs ranked by load count (max 200)
- `GET /api/historical-heatmap` - Geocoded delivery and pickup density points for map rendering
- `GET /api/proximity-matches` - Delivery zones within 75 miles of customer RFP pickup origins with company/rep info
- `GET /api/opportunities` - Cross-reference hot delivery destinations vs RFP lane origins; returns matched opportunity cards sorted by delivery frequency
- `GET /api/search?q=` - Global search across companies and users (AM/NAM roles)

## Development
- Run `npm run dev` to start the development server
- Run `npm run db:push` to sync database schema
- The app runs on port 5000
