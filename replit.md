# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
A mini CRM application designed for transportation brokerage sales teams to build and manage organizational charts for their customer accounts. The application allows sales reps to track contacts, their reporting structure, lanes/regions they manage, freight spend, and spot bidding processes. Includes separate RFP and Award management with Excel upload and data analysis for RFPs.

## Tech Stack
- **Frontend**: React with TypeScript, TanStack Query, Wouter routing
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Styling**: Tailwind CSS with shadcn/ui components
- **File Processing**: xlsx (SheetJS) for Excel/CSV parsing, multer for file uploads

## Project Structure
```
client/src/
  ├── components/
  │   ├── app-sidebar.tsx     # Main navigation sidebar
  │   ├── award-dialog.tsx    # Add/edit award modal
  │   ├── company-dialog.tsx  # Add/edit company modal
  │   ├── contact-dialog.tsx  # Add/edit contact modal
  │   ├── contact-list.tsx    # List view for contacts
  │   ├── org-chart.tsx       # Hierarchical org chart visualization
  │   ├── research-lane-dialog.tsx # "Research Lane Owner" modal for assigning AM
  │   ├── rfp-dialog.tsx      # Add/edit RFP modal
  │   └── theme-toggle.tsx    # Dark/light mode toggle
  ├── pages/
  │   ├── dashboard.tsx       # Overview with stats and "My Customers" links
  │   ├── companies.tsx       # Company listing page
  │   ├── company-detail.tsx  # Company detail with org chart + RFP & Awards button + high-volume lanes
  │   ├── customers.tsx       # Customer listing with contact counts and research task badges
  │   ├── rfp-awards.tsx      # RFP & Awards page with Excel upload
  │   └── research-tasks.tsx  # Research tasks overview page
  └── App.tsx                 # Main app with routing

server/
  ├── routes.ts               # API endpoints (incl. file upload)
  └── storage.ts              # Database operations

shared/
  └── schema.ts               # Database schema and types
```

## Data Models

### Companies
- id, name, industry, website, notes

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

## Key Features
1. **Dashboard**: "My Customers" with clickable company links
2. **Company Management**: Create, edit, delete companies with industry and website info
3. **Contact Management**: Full CRUD for contacts with transportation-specific fields
4. **Org Chart**: Visual hierarchical display showing reporting relationships
5. **RFP Management**: Separate RFP tracking with Excel drag-and-drop upload + data analysis
6. **Award Management**: Separate award tracking for won business
7. **Excel Upload**: Drag-and-drop Excel/CSV files to auto-create RFPs with lane analysis
8. **Dark Mode**: Full dark/light theme support
9. **Lane Research & Assignment**: High-volume lanes table with "Assign to Account Manager" button; opens "Research Lane Owner" modal with pre-filled lane data + decision-maker contact form; saves contact and marks lane status (Open → Contact Added → Researched)
10. **Research Tasks Page**: Dedicated sidebar page showing all open/completed research tasks across all RFPs with filtering and search

## API Endpoints
- `GET /api/companies` - List all companies
- `POST /api/companies` - Create company
- `GET /api/companies/:id` - Get company details
- `PATCH /api/companies/:id` - Update company
- `DELETE /api/companies/:id` - Delete company
- `GET /api/companies/:id/contacts` - Get contacts for company
- `POST /api/companies/:id/contacts` - Create contact
- `GET /api/contacts` - List all contacts
- `PATCH /api/contacts/:id` - Update contact
- `DELETE /api/contacts/:id` - Delete contact
- `GET /api/rfps` - List all RFPs
- `POST /api/rfps` - Create RFP manually
- `POST /api/rfps/upload` - Upload Excel/CSV and create RFP with analysis
- `PATCH /api/rfps/:id` - Update RFP
- `DELETE /api/rfps/:id` - Delete RFP
- `GET /api/awards` - List all awards
- `POST /api/awards` - Create award
- `PATCH /api/awards/:id` - Update award
- `DELETE /api/awards/:id` - Delete award
- `PATCH /api/rfps/:id/lanes/:laneIndex/status` - Update high-volume lane research status
- `GET /api/research-tasks` - Get all research tasks across all RFPs

## Development
- Run `npm run dev` to start the development server
- Run `npm run db:push` to sync database schema
- The app runs on port 5000
