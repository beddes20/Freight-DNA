# Launchpad

**Launchpad is the cold-prospect → onboarded-customer module of the FreightDNA platform.**
It owns the "top of funnel" — finding leads, qualifying them, working a deal, and graduating the winners into the operational CRM (companies, contacts, customer quotes, NBA). Everything downstream of "first load won" is owned by the rest of the platform; Launchpad's job is to feed that downstream cleanly.

---

## 1. Today — what we have

### 1.1 Surface
- **Route:** `/prospects` (kept under that URL for now; rebranded "Launchpad" in the sidebar).
- **Sidebar entry:** `client/src/lib/nav-items.ts` — label "Launchpad", `Crosshair` icon, currently in `admin_preview` visibility.
- **Page:** `client/src/pages/prospects.tsx` — three tabs:
  1. **Pipeline** — Kanban view (`PipelineSection`), cards grouped by stage.
  2. **Accounts** — list/table view.
  3. **Analytics** — exec-only stage funnel + win-rate (admin / sales_director).
- **Sub-components** (`client/src/pages/prospects/components/`):
  - `ProspectFormDialog` — create / edit a prospect.
  - `ProspectDetailSheet` — full detail drawer (activities, contacts, lanes, notes).
  - `ConvertDialog` — promote a prospect to a `companies` row.
  - `OwnershipRequestDialog` + `OwnershipRequestsAdminPanel` — request / approve account ownership.
  - `CrmSettingsDialog` — org-level Launchpad config (stage labels, defaults).

### 1.2 Roles
- `admin`, `sales`, `sales_director` (and admin-preview for everyone else, hidden by default).
- `sales` reps only see prospects they own. `admin` and `sales_director` see all prospects and the analytics tab.
- Gate: `server/routes/prospects.ts` (rep-scoped query when role is `sales`).

### 1.3 Data model (`shared/schema.ts`)
| Table | Purpose |
|---|---|
| `prospects` | Cold/warm leads. Carries `stage`, `owner_id`, `assigned_nam_id`, `converted_to_company_id`, `account_status`, intel/TMS columns. |
| `prospect_activities` | Timeline of calls, emails, notes against a prospect. |
| `prospect_contacts` | Contacts that belong to a prospect (separate from the production `contacts` table). |
| `crm_opportunities` | Sales deals — can be linked to either a `prospect_id` or a `company_id`. |
| `crm_ownership_requests` | Rep-to-rep / rep-to-admin requests to take over an account. |
| `crm_account_history` | Audit log of ownership / stage transitions. |

### 1.4 Lifecycle stages
Defined in `server/routes/prospects.ts`:
```
new_lead → qualifying → intro_scheduled → discovery → proposal
        → first_load_pending → first_load_won → (converted)
```
Plus terminal states: `lost`, `nurture`, `disqualified`.

### 1.5 Conversion flow (the handoff to the rest of the platform)
`POST /api/prospects/:id/convert` (`server/routes/prospects.ts`):
1. Insert a `companies` row (carrying `owner_rep_id` from the prospect's `owner_id`).
2. Migrate `prospect_contacts` → `contacts` (with `deleted_at IS NULL`).
3. Stamp `prospects.converted_to_company_id`.
4. Append an entry to `crm_account_history`.
5. Redirect the rep to `/companies/:newId`.

This is the single chokepoint where a Launchpad row becomes a "real" customer account.

### 1.6 Ownership requests
- Rep clicks **Request Ownership** on any account / prospect they don't own.
- Row written to `crm_ownership_requests` with `status='pending'`.
- Admin / sales_director approves or denies in `OwnershipRequestsAdminPanel`.
- On approve: `companies.owner_rep_id` (or `prospects.owner_id`) is rewritten and a `crm_account_history` row is appended.

---

## 2. Where Launchpad already touches the rest of DNA

| DNA surface | Touchpoint today |
|---|---|
| **Companies / Accounts** | `prospects.converted_to_company_id` FK; on convert, a `companies` row is created with `owner_rep_id` set. |
| **Contacts** | `prospect_contacts` migrate into the soft-delete-only `contacts` table (Task #1093). |
| **Customer Quotes** | A won email-derived quote can auto-create a `companies` row with `is_email_derived=true` (Task #1095). Those rows surface in **Admin → Email-Derived Companies** as candidates for Launchpad to claim and work. |
| **Email Ingestion** | Inbound mail with no matching account becomes a stub `companies` row (`is_email_derived=true`) — Launchpad is the natural place to triage those into real prospects. |
| **Account Ownership** | `companies.owner_rep_id` is the authoritative owner for the rest of the platform (routing, dashboards, NBA, leaderboards). Launchpad's convert + ownership-request flows are the only sanctioned writers besides the admin user-lifecycle paths. |
| **Dashboard / NBA** | A converted prospect immediately flows into the rep's My Work card, NBA cards, and Today's Priority Accounts via the standard `owner_rep_id` lookup. |
| **Customer Quotes ownership** | Once a company exists with `owner_rep_id`, the CQ enrichment chokepoint (`server/services/customerQuotes.ts`) attaches that rep to every inbound quote on the account. |

---

## 3. Future state — Launchpad as the CRM tracking module

**The vision:** Launchpad is the single surface a rep opens to answer "who do I hunt next, and where is every deal I'm working?" Everything from the first cold-call attempt to "first load booked" lives here. The moment a prospect ships their first load, control is handed to the operational CRM (Customers page, Customer Quotes, NBA), and Launchpad becomes the historical record of how that account was won.

### 3.1 Integration points to build out

```
┌─────────────────────────────────────────────────────────────────┐
│                          LAUNCHPAD                              │
│  cold lead → qualified → discovery → proposal → first load won  │
└────────────────┬────────────────────────────────────────────────┘
                 │
   ┌─────────────┼──────────────┬────────────────┬──────────────┐
   ▼             ▼              ▼                ▼              ▼
Email          Companies      Contacts       Customer        NBA /
ingestion      (owner_rep_id) (soft-delete)   Quotes         My Work
(is_email_     ← convert       ← migrate      ← first won     ← owner
 derived       from prospect   from prospect_  quote signals  drives
 stubs)        ─→              contacts        graduation     priorities
```

### 3.2 Phased roadmap (proposed — each phase is independently shippable)

**Phase L1 — Triage inbound stubs into Launchpad** *(closes the loop on `is_email_derived`)*
- A "Needs Routing" inbox inside Launchpad that lists every `companies` row where `is_email_derived=true` and `owner_rep_id IS NULL`.
- One-click actions: **Claim as my prospect**, **Assign to rep**, **Mark as noise**.
- Same chokepoint the admin `/admin/email-derived-companies` console uses today, just rep-facing.
- No new endpoints — reuses the Task #1095 flag and the existing claim path.

**Phase L2 — Unified activity timeline**
- Merge `prospect_activities`, `touchpoints`, `email_messages`, and `webex_call_analytics` into one timeline per prospect / account.
- Read-only at first; write-back stays in each source system.
- Enables an honest "last touch / next touch" calculation on every Launchpad card.

**Phase L3 — Lifecycle pinning to `companies.lifecycle_stage`**
- The `lifecycle_stage` column already exists (Task #1026 migration). Today Launchpad's prospect stages are stored only on the `prospects` row.
- On convert, mirror the final prospect stage into `companies.lifecycle_stage` so the rest of the platform (NBA, dashboard, customer-quotes triage) can reason about "new logo vs growth vs at-risk" without re-querying Launchpad.
- Single source of truth: Launchpad owns writes while the account is pre-conversion; once converted, ownership of the field passes to the operational CRM.

**Phase L4 — Bidirectional handoff with Customer Quotes**
- Today: a won email-derived quote can auto-create a `companies` row.
- Future: that same event also creates / promotes a `prospects` row in `first_load_won` stage so Launchpad's analytics correctly attribute every won customer to a hunter, even when the rep never manually worked the prospect.
- All routing stays on the existing CQ chokepoint (`server/services/customerQuotes.ts`) — no widening of CQ contracts.

**Phase L5 — Analytics parity with the dashboard**
- Per-rep funnel (`new_lead → first_load_won`) and stage-aging on the Analytics tab.
- Feeds into the existing manager dashboard (Top Opportunities, Leaderboard) as a new "Hunter Performance" panel, gated to managers (reuses the P1-S2 `isDashboardManagerLike` predicate).

**Phase L6 — Sidebar promotion**
- Once Phase L1–L3 are live and the surface is stable, flip `Launchpad` out of `admin_preview` so every rep with the `sales` role sees it by default.

### 3.3 Hard guardrails (do not regress)
Each integration phase must respect the existing stability contracts:
- **Customer Quotes** — no edits to `applyFilters` / `loadContext` / `enrich` / `attachResponseTimes` / `__none__` resolver (Section 1100 / 1100.8 / 1450).
- **Contacts** — soft-delete only; every new read must include `isNull(contacts.deletedAt)` (Section 1200).
- **Email-derived flag** — `is_email_derived` is set in exactly one production writer (the CQ won-quote handoff). New Launchpad writers must be flagged consistently (Section 1095).
- **User lifecycle** — all writes go through `storage.{classify,deactivate,…}User`; never raw `db.update(users)` (Section 1126.3).
- **Customers Tab Trust** — Launchpad must not bypass the `customersOnly` chokepoint when reading `companies` for the rest of the app (Section 1300).
- **Users Roster Trust** — picker / owner-assignment dropdowns continue to use the cleaned `getUsers` default (Section 1400).

### 3.4 What Launchpad will NOT own
- Day-to-day quoting on existing customers — that stays on `/customer-quotes`.
- Operational dispatch, load tracking, financials — those stay on the existing surfaces.
- AI Hub features — Launchpad consumes NBA cards and talking points but does not generate them.
- User / role administration — stays in `/admin/users`.

---

## 4. Open questions
1. **Naming convergence** — keep `/prospects` URL forever, or migrate to `/launchpad` once the brand is final?
2. **Account-status vs lifecycle-stage** — `prospects.account_status` and `companies.lifecycle_stage` overlap; one of them should become the single source of truth post-conversion.
3. **Fixture / demo prospects** — do we want a Launchpad-side analogue to the Users Roster Trust junk-suspect filter for `prospects` seeded by demo scripts?
4. **Ownership-request SLA** — should pending requests auto-escalate to a sales_director after N days?

---

## 5. References
- Sidebar entry: `client/src/lib/nav-items.ts`
- Page: `client/src/pages/prospects.tsx`
- Components: `client/src/pages/prospects/components/`
- Routes: `server/routes/prospects.ts`
- Schema: `shared/schema.ts` (`prospects`, `prospect_activities`, `prospect_contacts`, `crm_opportunities`, `crm_ownership_requests`, `crm_account_history`)
- Convert flow: `POST /api/prospects/:id/convert`
- Email-derived companies (handoff target): `docs/customers-tab-trust-contract.md`, `replit.md` Gotchas → "Email-Derived Companies (Task #1095)"
- Customer Quotes chokepoints (do not edit from Launchpad): `docs/customer-quotes-stability-contract.md`
- Contacts soft-delete contract: `replit.md` Gotchas → "Contacts are soft-delete only (Task #1093)"
