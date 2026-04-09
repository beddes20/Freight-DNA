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

## Carrier History & Ranking Contract (locked April 2026)

This contract governs all carrier ranking and TMS history display logic. It is non-negotiable: any future change to carrier ranking or history extraction **must** preserve these guarantees.

### TMS Field-Name Handling

TMS JSONB rows (stored in `financial_uploads.rows`) use **title-case-with-spaces** field names, not camelCase. Both formats must be supported simultaneously.

| Canonical meaning | TMS (real uploads) | Legacy / demo |
|---|---|---|
| Origin city | `"Origin"` | `"shipperCity"`, `"Shipper city"` |
| Origin state | `"Origin state"` | `"shipperState"`, `"Shipper state"` |
| Destination city | `"Destination"` | `"consigneeCity"`, `"Consignee city"` |
| Destination state | `"Destination state"` | `"consigneeState"`, `"Consignee state"` |
| Carrier name | `"Carrier"` | `"carrier"`, `"carrierName"` |
| Month | `"Month"` | `"month"` |

**Rule**: Always call `readTmsField(row, ...candidates)` with the title-case key listed **before** the camelCase fallback. The function skips empty/null values and returns the first non-empty match.

### Carrier Name Parsing

TMS carrier fields use the format `"PAYCODE - CARRIER NAME"` (e.g., `"DHAMLIAZ - DHAMI CARRIER LLC"`).

- `parseCarrierName(raw)` — strips the payee-code prefix and returns the human-readable name (`"Dhami Carrier LLC"`).
- `parsePayeeCode(raw)` — extracts the payee code prefix (`"DHAMLIAZ"`). Returns `null` if the format does not match (i.e., the carrier was not stored with a payee code).

Never match carrier names against TMS data using the raw field value. Always pass through `parseCarrierName()` first.

### Month Normalization

TMS month fields arrive as `"2026 M03"` (year + space + M + zero-padded month). The canonical internal format is `"YYYY-MM"`.

- `normalizeTmsMonth(raw)` — converts all known formats to `"YYYY-MM"`:
  - `"2026 M03"` → `"2026-03"` (real TMS format)
  - `"2025 M9"` → `"2025-09"` (single-digit month zero-padded)
  - `"2025-10"` → `"2025-10"` (already canonical, pass-through)
  - `"2025-10-15"` → `"2025-10"` (ISO date truncated)
  - `null` / `undefined` / `""` → `""` (safe empty return)

All recency scoring and `lastUsedMonth` values must be in canonical `"YYYY-MM"` form.

### Ranking Guarantee

A carrier that has **confirmed exact-lane TMS history** (same origin city + destination city) **must** receive a higher `fitScore` than a carrier with no TMS history on that lane, regardless of catalog region or equipment attributes. Specifically:

- `historyMatch = "exact"` → `fitScore` in the 80–100 range.
- `historyMatch = "similar"` (same origin/destination state corridor) → `fitScore` in the 50–79 range.
- `historyMatch = "region"` (catalog region match, no TMS history) → `fitScore` in the 1–49 range.
- `historyMatch = "none"` → `fitScore = 0`.

This means `exact > similar > region > none` is a hard ordering invariant. No scoring tweak may ever invert it.

### Shared History Source (LWQ ↔ Carrier Hub)

Both the Lane Work Queue ranking and the Carrier Hub activity feed read from the **same source**: `financial_uploads.rows` JSONB, via the same utility layer. They are not allowed to diverge.

- LWQ uses `rankCarriersForLane()` in `server/carrierRankingService.ts`.
- Carrier Hub uses `buildCarrierTmsHistory()` in `server/routes/carrierHub.ts`, which applies the same helpers.
- Carrier Hub matches by **payee code** (exact) OR **normalized name** (fuzzy), in that priority order.

If a carrier has TMS history visible in LWQ suggestions, the same history must be visible in its Carrier Hub activity panel, and vice versa.

### Helper Functions & Test Coverage

All helpers are exported from `server/carrierRankingService.ts`:

| Export | Purpose |
|---|---|
| `readTmsField(row, ...keys)` | Multi-key field reader with title-case-first priority |
| `parseCarrierName(raw)` | Strips `PAYCODE - ` prefix from carrier field |
| `parsePayeeCode(raw)` | Extracts payee code; returns `null` if no prefix |
| `normalizeTmsMonth(raw)` | Converts TMS month format to `"YYYY-MM"` |
| `extractCity(raw)` | Lowercases and strips state suffix from `"CITY, ST"` strings |

Regression coverage lives in `tests/carrier-history-extraction.test.ts` (45 assertions). This file must pass before any merge that touches carrier ranking or TMS history extraction. Run with:

```
npx tsx tests/carrier-history-extraction.test.ts
```

All three test suites must stay green at all times:
- `npx tsx tests/guardrails.test.ts` — 55 assertions (shared surface integrity)
- `npx tsx tests/my-procurement.test.ts` — 20 assertions (My Procurement contract)
- `npx tsx tests/carrier-history-extraction.test.ts` — 45 assertions (this contract)

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o-mini)**: For AI-assisted features (RFP column mapping, lane gap insights, email drafting).