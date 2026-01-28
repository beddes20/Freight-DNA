# OrgChart CRM - Transportation Brokerage Sales Tool

## Overview
A mini CRM application designed for transportation brokerage sales teams to build and manage organizational charts for their customer accounts. The application allows sales reps to track contacts, their reporting structure, lanes/regions they manage, freight spend, and spot bidding processes.

## Tech Stack
- **Frontend**: React with TypeScript, TanStack Query, Wouter routing
- **Backend**: Express.js with TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Styling**: Tailwind CSS with shadcn/ui components

## Project Structure
```
client/src/
  ├── components/
  │   ├── app-sidebar.tsx     # Main navigation sidebar
  │   ├── company-dialog.tsx  # Add/edit company modal
  │   ├── contact-dialog.tsx  # Add/edit contact modal
  │   ├── contact-list.tsx    # List view for contacts
  │   ├── org-chart.tsx       # Hierarchical org chart visualization
  │   └── theme-toggle.tsx    # Dark/light mode toggle
  ├── pages/
  │   ├── dashboard.tsx       # Overview with stats and recent activity
  │   ├── companies.tsx       # Company listing page
  │   └── company-detail.tsx  # Company detail with org chart
  └── App.tsx                 # Main app with routing

server/
  ├── routes.ts               # API endpoints
  └── storage.ts              # Database operations

shared/
  └── schema.ts               # Database schema and types
```

## Data Models

### Companies
- id, name, industry, website, notes

### Contacts
- id, companyId (FK), name, title, email, phone
- reportsToId (FK to self for org hierarchy)
- lanes (array of shipping lanes)
- regions (array of geographic regions)
- freightSpend (annual freight spend in dollars)
- spotBiddingProcess (description of their bidding process)
- notes

## Key Features
1. **Dashboard**: Overview of total companies, contacts, regions, and freight spend
2. **Company Management**: Create, edit, delete companies with industry and website info
3. **Contact Management**: Full CRUD for contacts with transportation-specific fields
4. **Org Chart**: Visual hierarchical display showing reporting relationships
5. **List View**: Alternative tabular view with search functionality
6. **Dark Mode**: Full dark/light theme support

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

## Development
- Run `npm run dev` to start the development server
- Run `npm run db:push` to sync database schema
- The app runs on port 5000
