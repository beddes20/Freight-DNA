# OrgChart CRM

## Overview

OrgChart CRM is a transportation brokerage sales tool for building and managing organizational charts. It enables sales teams to track customer companies, contacts, reporting hierarchies, lanes, regions, freight spend, and spot bidding processes. The application follows a full-stack TypeScript architecture with a React frontend and Express backend.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter for client-side routing
- **State Management**: TanStack React Query for server state and caching
- **UI Components**: shadcn/ui component library built on Radix UI primitives
- **Styling**: Tailwind CSS with CSS variables for theming (light/dark mode support)
- **Build Tool**: Vite for development and production builds

The frontend follows a page-based structure under `client/src/pages/` with reusable components in `client/src/components/`. The main pages are Dashboard, Companies list, and Company detail (with org chart visualization).

### Backend Architecture
- **Framework**: Express 5 on Node.js
- **API Design**: RESTful JSON API with endpoints under `/api/`
- **Development**: Vite middleware integration for HMR during development
- **Production**: Static file serving from built assets

The server registers routes in `server/routes.ts` and uses a storage abstraction layer in `server/storage.ts` for database operations.

### Data Storage
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM with drizzle-zod for schema validation
- **Schema Location**: `shared/schema.ts` (shared between frontend and backend)
- **Migrations**: Drizzle Kit with push-based migrations (`npm run db:push`)

Core entities:
- `companies`: Customer accounts with name, industry, website, notes
- `contacts`: People within companies with hierarchical reporting structure, lanes, regions, freight spend, spot bidding process
- `users`: Authentication (username/password)

### Build System
- Custom build script in `script/build.ts` using esbuild for server bundling and Vite for client
- Server dependencies are selectively bundled to optimize cold start times
- Output goes to `dist/` directory with `dist/public/` for client assets

### Path Aliases
- `@/*` → `./client/src/*`
- `@shared/*` → `./shared/*`
- `@assets/*` → `./attached_assets/*`

## External Dependencies

### Database
- PostgreSQL via `pg` driver
- Connection string from `DATABASE_URL` environment variable

### UI Framework
- Radix UI primitives (dialog, dropdown, tabs, tooltip, etc.)
- Tailwind CSS for styling
- Lucide React for icons

### Form Handling
- React Hook Form with Zod resolver for validation
- Zod schemas generated from Drizzle schema via drizzle-zod

### Development Tools
- Replit-specific Vite plugins for error overlay, cartographer, and dev banner
- TypeScript with strict mode enabled