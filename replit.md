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
    - **Customer Contact Capture from Email (Task #201)**: Detects new people in account-linked email threads and surfaces lightweight contact suggestions on the company/account detail People tab. Reps can Add, Add + Role, Ignore, Snooze (7 days), or Never Suggest. Accepting creates or updates a contact record with `sourceType=email_capture`. Generic/shared inboxes (billing, ops, support, etc.) are captured but flagged with lower confidence. Deduplication prevents multiple suggestions for the same account + email. Wired into the email intelligence scheduler as a non-blocking step. Schema: `account_contact_suggestions` table with unique constraint on (accountId, emailAddress); `contacts` table extended with `lastSeenAt`, `sourceType`, `roleType`, `status`, `isPrimary`. API: GET/POST routes at `/api/internal/accounts/:accountId/contact-suggestions`.
    - **Two-Way Carrier Email (Task #183)**: Outbound emails to carriers include a reply-to address routed through Microsoft Graph webhook. Inbound replies are matched to outreach logs, stored, and surfaced in the CarrierOutreachPanel with a reply thread view. Reply status tracked per log (`replied`, `reply_snippet`, `replied_at`, `reply_message_id`).
    - **Inbound Reply Surfaces (Task #184)**: Inbound carrier replies are surfaced across Lane Work Queue, My Procurement, and the sidebar with a `needsAction` distinction. `needsAction = hotCount > 0 AND no open follow-up task`. Two visual states: ⚡ bright green "Needs Action" (unactioned hot reply) vs. muted green (already actioned). Sidebar badge counts only unactioned lanes. Auto follow-up tasks are created for `available_now` and `available_next_week` classifications only; the task description includes the inbound reply snippet. See approved spec below.

## Inbound Reply Auto-Task Spec (locked April 2026)

This governs `ensureHotFollowUpTask` in `server/routes/laneCarrierOutreach.ts`. These rules were explicitly confirmed by the product owner and must not be changed without re-approval.

| Rule | Behavior |
|---|---|
| **Trigger** | `available_now` and `available_next_week` only. `needs_follow_up` does NOT trigger a task — too broad, would create noise. |
| **Deduplication** | Per-open-task: while any open (non-closed) follow-up task exists, skip creation. After closure, new qualifying replies from the same carrier on the same lane CAN create a new task. |
| **Needs Action clearing** | Task creation = actioned. No secondary explicit action log required. |
| **Event key** | Prefer `carrier_hot_event:{interestId}` when interest ID is known; fall back to `carrier_hot:{laneId}:{carrierId}`. |
| **Reply snippet** | Included as a quoted block in the task description so the assignee can see the carrier's reply without opening the full thread. |

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

### HQ Proximity Bonus (additive tie-breaker, added April 2026)

The `carriers.city` and `carriers.state` fields represent each carrier's home-base HQ. After the 5-tier history scoring and equipment/region signals, an additive bonus is applied:

| Condition | Bonus |
|---|---|
| HQ within 75 miles of **both** origin and destination | +10 |
| HQ within 75 miles of **one** endpoint (origin or destination) | +7 |
| HQ **state** matches origin or destination state (beyond 75 miles) | +4 |

- Bonus is computed via `cityDistanceMiles()` using the same 75-mile radius constant (`NEARBY_RADIUS_MILES`).
- Catalog-only carriers with an HQ proximity bonus but no other signals are promoted to `historyMatch = "region"` so they survive the visibility guard.
- TMS-only carriers (no catalog entry) receive `hqCity: null, hqState: null, hqProximityBonus: 0`.
- `RankedCarrier` exposes `hqCity`, `hqState`, and `hqProximityBonus` for UI display.
- The bonus reason is appended to `fitReason` (e.g. `"HQ near origin (within 75mi of Phoenix, Az)"`).

### Ranking Guarantee (5-tier geo-aware system, locked April 2026)

Carriers with confirmed TMS history **must** outrank catalog-region-only carriers. The five tiers and their guaranteed `fitScore` floor bands are:

| `historyMatch` | Meaning | Floor band |
|---|---|---|
| `"exact"` | Loads on this exact city pair | 60–100 (≥10 loads → 85, ≥5 → 75, >0 → 60) |
| `"nearby"` | Both endpoints within 75 miles of lane | 48–100 (≥10 loads → 72, ≥5 → 62, >0 → 48) |
| `"state_pair"` | Same origin-state → dest-state corridor | 35–100 (≥10 loads → 45, ≥5 → 40, >0 → 35) |
| `"region"` | Catalog region/equipment match, no TMS history | 1–34 |
| `"none"` | No matching signals | 0 |

Hard ordering invariant: `exact > nearby > state_pair > region > none`. No scoring tweak may ever invert it.

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
- `npx tsx tests/guardrails.test.ts` — 43 assertions (shared surface integrity)
- `npx tsx tests/my-procurement.test.ts` — 20 assertions (My Procurement contract)
- `npx tsx tests/carrier-history-extraction.test.ts` — 45 assertions (this contract)

## External Dependencies
- **PostgreSQL**: Primary database and session store.
- **xlsx (SheetJS)**: For Excel and CSV parsing.
- **multer**: For file uploads.
- **Leaflet**: For interactive mapping.
- **OneDrive API (Microsoft Graph API)**: For financial data synchronization and reply webhook routing.
- **node-cron**: For scheduling recurring jobs.
- **Resend / GoDaddy SMTP**: For sending transactional and report emails.
- **OpenAI (GPT-4o-mini)**: For AI-assisted features (RFP column mapping, lane gap insights, email drafting).
- **Microsoft Graph API (Outlook)**: Two-way carrier email via webhook subscription; inbound replies matched to outreach logs.
