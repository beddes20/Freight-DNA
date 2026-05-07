# Customers Tab Deep Audit

**Date:** 2026-05-07
**Scope:** `/customers` page (`client/src/pages/customers.tsx`) and every backing
endpoint, table, service, and job that feeds it.
**Posture:** Read-first. **No code changes outside this document.** All
quarantine / hide / label / kill-switch work is captured in the
*Proposed follow-up tasks* appendix and must be spun out as separate tasks.

---

## 1. Tab purpose & users

`/customers` is the daily account-coverage surface for the FreightDNA sales
floor. It lists every customer account the viewer is permitted to see, with
ownership, financial performance (loads / margin / margin %), market-share
momentum, momentum/growth band, contact + suggestion counts, last-touch
recency, and quick actions (log touch, add contact, pin, archive).

**Primary users**
- **Sales / Account Managers** — work their book: who needs a touch today,
  who has dollars on the line, who is at risk.
- **National Account Managers / Directors / Sales Directors** — coverage and
  pipeline view across their reporting tree (filtered by team membership).
- **Admins** — full org view + access to email-derived cleanup, archive
  toggle, reassignment.

**Business outcome supported**
- Account coverage (no large account goes >30 days untouched).
- Growth (Momentum Score surfaces "primed to grow" and "at risk").
- Wallet share (market-share trend + financial loads/margin tied to TMS upload).
- Contact hygiene (suggested contacts, soft-delete-aware contact counts).

**"Good" looks like**
- Owners are accurate (canonical `ownerRepId`, not legacy `assignedTo`).
- Financials are real (every account that *has* moved freight in the last
  upload shows loads/margin; missing data renders as "no data", not "$0").
- Email-derived stub rows are hidden from the daily list (they live in the
  admin console).
- Momentum/Growth bands reflect the last 24h of touches and the last upload.
- Contact counts respect soft-delete (`deleted_at IS NULL`).

---

## 2. UI inventory (top-to-bottom walk of `client/src/pages/customers.tsx`)

| Element | Lines | Classification | Notes |
|---|---|---|---|
| Header (`Customers` / `Archived Accounts`) | 452–497 | Safe | Title swaps based on `showArchived`. |
| `toggle-show-email-derived` button | 466–476 | Safe | Refetches `/api/companies?includeEmailDerived=true`. Default off (Task #1095). |
| `button-toggle-archived` | 477–488 | Safe | Switches data source to a separately-keyed query. |
| `button-add-customer` | 489–494 | Safe | Opens `<CompanyDialog>`. Owner editing intentionally excluded (see comment 315–318 in `company-dialog.tsx`). |
| Saved filter chips | 500–523 | Safe | Persisted via `/api/users/saved-filters`, capped at 10. |
| Search input + `?q=` URL sync | 526–540, 169–178 | Safe | Search matches `name` or `industry`. |
| Filter bar (rep / industry / touch / mode) | 541–623 | **Needs validation** | Rep filter uses `assignedTo` (legacy) not `ownerRepId` — diverges from canonical owner column rendered on the card. |
| `sortBy` Select (loads/margin/ms/margin%/score) | 625–648 | **Misleading** | `getFinVal` returns `-1` for "no mapping" *and* for true zero (margin% only); rows with no financial mapping sink to bottom indistinguishably from real laggards. |
| `Save view` UI | 651–668 | Safe | |
| Skeleton state | 671–684 | Safe | |
| Card — Avatar + Archived/Email-derived badges | 695–714 | Safe | "Email-derived" badge only renders when toggle is on and row is flagged. |
| Card — Industry, Salesperson, **Account Owner** | 716–740 | **Needs validation** | Card shows `ownerRepId` ("Unassigned" when null). Rep filter still keys on `assignedTo`, so a user can be the owner but invisible to the rep filter. |
| Pin button | 745 | Safe | |
| Momentum badge / "Not Scored" pill | 747–779 | **Needs validation** | `score === 0` rendered as "Not Scored", but a real 0 score (deeply at-risk) collapses into the same UI. |
| Quick-touch / Quick-add-contact icon buttons | 780–808 | Safe | Quick-touch contact list comes from `allContacts` (server already enforces `isNull(deleted_at)`). |
| Contact count chip | 814–817 | **Needs validation** | Counts derived client-side from `/api/contacts`; correct *if* server respects soft-delete (gotcha #1 says it does). No badge visually distinguishes "soft-delete-aware" vs total. |
| "Org Chart" chip | 818–821 | **Misleading** | Static label, no link, no count. Looks like a metric but is a pure decorative tag. |
| `openTasks` "lanes need research" chip | 822–827 | Safe | |
| `pendingSuggestions` chip | 828–836 | **Needs validation** | Sourced from `/api/internal/accounts/suggestion-counts`, which scopes by `salesPersonId`; the card itself shows `ownerRepId`. Owner ≠ salesPersonId ≠ assignedTo, so the chip can show 0 for a card whose owner has plenty of pending suggestions, or vice versa. |
| `accountSummary` italics line | 844–847 | **Polluted** | Field is filled by AI summarisation paths and never invalidated by ownership / financial changes. Could be stale or drift from current state. |
| Financials block (loads / margin / margin%) | 850–894 | **Misleading** | When `getCompanyFinancials` returns null the block correctly renders "No financial data". **However**, when it returns a row whose `byMonth` map is missing the current month, it shows "No loads this month" — which masks rows where the heuristic match was wrong. Also: `marginPct` is hidden when `revenue === 0` even if margin is non-zero (legitimate prepay/fee scenarios). |
| Last-touch recency chip | 895–907 | Safe | Sourced from `/api/touchpoints/company-summary`, scoped to visible reps. |
| Empty state | 916–935 | Safe | |
| `<CompanyDialog>` | 937 | Safe | Strips `ownerRepId` (RBAC chokepoint enforced server-side too). |
| Quick log touch dialog | 939–1030 | Safe | Server invalidations cover `aiInsights/autoTask` background work. |
| Quick add contact dialog | 1033–1100 | Safe | |
| `<MomentumScoreDrawer>` | 1102–1108 | Safe | Loads on demand. |

Supporting components reviewed:
- `client/src/components/company-dialog.tsx` — explicitly excludes `ownerRepId`
  from this dialog (correct; owner has stricter RBAC). `assignedTo` and
  `salesPersonId` *are* editable here, so the three "owner-ish" fields are
  edited from three different surfaces.
- `client/src/components/momentum-score-drawer.tsx` — pure render of server
  breakdown, safe.
- `client/src/components/pin-button.tsx` — safe.
- `client/src/components/account-growth-portlet.tsx` — exports
  `GROWTH_BAND_STYLES` reused on the card; consumes `/api/growth-scores`.

---

## 3. Data + dependency map

| Endpoint | Route file | Storage call | Tables touched | Background job | Health |
|---|---|---|---|---|---|
| `GET /api/companies` | `server/routes/companies.ts:23` | `storage.getCompanies(orgId, { includeEmailDerived })` | `companies` | Email-derived autocreate via `customerQuotes.ts` won-quote AF handoff (Task #1095) | **healthy** — `is_email_derived` filter applied; archived filtered in route. |
| `GET /api/companies?includeArchived=true` | same | same | `companies` | none | **healthy** |
| `GET /api/contacts` | `server/routes.ts` (contacts) | `storage.getContacts(...)` and similar | `contacts` (with `isNull(deleted_at)` per gotcha #1 + Section 1200 guardrail) | `contactJobs` pipeline (kill switch `CONTACT_JOBS_ENABLED`) | **healthy** but **uncertain** — Section 1200 guards `getContact*`, but customer-facing count is derived from raw list. |
| `GET /api/financials/account-summary` | `server/routes/financials.ts:820` | `storage.getLatestFinancialUploadForOrg` | `financial_uploads.summaryRows` / `.rows` (legacy table) | `monthlyDataRefreshScheduler` (no — this only persists per-upload data; uploads are user-initiated) | **POLLUTED / DIVERGED** — endpoint reads from the **legacy `financial_uploads` table**, not from `freight_daily_upload_fact`. The replit.md "Unified Data Source" claim does not extend to this surface. |
| `GET /api/market-share/summary` | `server/routes.ts:2545` | `storage.getCompanies` + `storage.getAllMarketShareEntries` | `companies`, `market_share_entries` | Manual upload only; no scheduler. | **stale-prone** — no auto-refetch on the client (no `refetchInterval`), and no upload-freshness banner. |
| `GET /api/growth-scores` | `server/routes.ts:4797` | `storage.getGrowthScoresByOrg` + on-demand background recompute (cap 30 stale + all unscored per request) | `growth_scores`, `companies`, `touchpoints`, `contacts`, `freight_daily_upload_fact` (via `growthScoreCalculator`) | `growthScoreCalculator` (request-driven + page-load triggered) | **healthy-but-fragile** — recompute is opportunistic; if no one opens the page, scores can be >30 min stale. Polled at 90s on the client. |
| `GET /api/touchpoints/company-summary` | `server/routes.ts:5312` | `storage.getTouchpoints` + `storage.getCompanies` + `getVisibleRepUserIds` | `touchpoints`, `companies`, `users` | none | **healthy** — visibility-scoped per Task #525. No `refetchInterval` on the client. |
| `GET /api/internal/accounts/suggestion-counts` | `server/routes.ts:10123` | `storage.countPendingContactSuggestionsByOrg` | `account_contact_suggestions`, scoped by `salesPersonId` | Email-intelligence pipeline ingests suggestions | **divergence risk** — scoped by `salesPersonId`, not `ownerRepId` or `assignedTo`. |
| `GET /api/users/saved-filters` | `server/routes.ts` | `storage.getUserPrefs(...)` | `users.preferences` JSON | none | **healthy** |
| `GET /api/team-members` | `server/routes/companies.ts:132` | `storage.getUsers` | `users` | annotated with cockpit team (Task #970) | **healthy** |
| `GET /api/users/sales` | `server/routes.ts` | `storage.getUsers` filtered by role | `users` | none | **healthy** |
| `GET /api/research-tasks` | `server/routes.ts` | `storage.getResearchTasks` | `tasks` | none | **healthy** |
| `GET /api/companies/:id/growth-score` | `server/routes.ts` | `growthScoreCalculator` | many | request-driven | **healthy** |

Tables / external systems involved:
- `companies` (incl. `is_email_derived`, `owner_rep_id`, `assigned_to`, `sales_person_id`, `archived_at`, `financial_alias`, `shared_reps`)
- `contacts` (soft-delete via `deleted_at`)
- `financial_uploads` (**legacy**)
- `freight_daily_upload_fact` (Task #1051) — **NOT yet read by the Customers tab**
- `touchpoints`
- `growth_scores`
- `market_share_entries`
- `account_contact_suggestions`
- `users` / `pinned_companies` / `tasks`

---

## 4. Trust audit

| Concern | Status | Detail |
|---|---|---|
| Email-Derived hide on `/api/companies` | **Safe** | Server filter is `eq(companies.isEmailDerived, false)` unless `includeEmailDerived=true`. Toggle button correctly refetches. |
| Email-Derived hide on **other list endpoints** | **Safe** today, but **fragile** | `/api/market-share/summary`, `/api/growth-scores` (fallback path), and `/api/touchpoints/company-summary` all call `storage.getCompanies(orgId)` without `includeEmailDerived`, so they inherit the hide. *Risk:* any future caller passing `{ includeEmailDerived: true }` for a different reason would silently leak email-derived rows into these surfaces. No guardrail enforces "non-admin list endpoints must not enable the flag". |
| Backfill of legacy stub rows | **Polluted** | Per gotcha #1095, legacy email-derived rows pre-flag are NOT marked. The default Customers list **does** show them as if they were real customers. |
| Contacts soft-delete on Customers page | **Needs validation** | `/api/contacts` is enforced by Section 1200 of guardrails. Customers page maps `allContacts` → per-company count without re-checking. Trust depends entirely on the route; if a future route bypasses `isNull(contacts.deletedAt)`, the count silently inflates. |
| Account Owner column vs canonical owner | **Misleading** | Card displays `ownerRepId` (canonical, Task #1011), but the **rep filter** (`repFilter`) keys on `assignedTo` (legacy). Two different fields, two different definitions of "ownership". Sales-person chip uses a third field (`salesPersonId`). Reps will see "Unassigned" cards that filter into someone else's "rep" view. |
| Financial mapping (`financial_alias` + `String.includes` heuristic) | **Misleading** | `matchFinancials` uses bidirectional `includes` when name length ≥ 5. Examples of false matches likely in production: `"Acme"` matching `"Acme Holdings"` *and* `"Acme Trucking LLC"`; `"Apex"` matching `"Apex Steel"` and `"Apex Foods"`. When multiple matches collide they are silently aggregated into one row, masking the bug. |
| True-zero vs missing-mapping ambiguity | **Misleading** | `getFinVal` returns `-1` for "no mapping" and uses it for sort. The card UI renders "No financial data" only when there is *zero* match; an account that matched but has no rows for the current month renders as "No loads this month", which **looks identical** to a true zero-volume month. No "alias missing" / "needs mapping" badge exists. |
| Growth-score freshness | **Needs validation** | Polled every 90s on the client; recomputed on the server only when the endpoint is called and the score is >30 min stale (capped at 30 stale per request). If the page is open and no one navigates, all-unscored backfill happens, but stale-30+ is bounded — large books may not refresh in a single request. No "scores last calculated" chip in the UI. |
| Market-share freshness | **Misleading** | No client refetch interval; no server background job; data only changes when an admin uploads. UI shows current % with no "as of" date. Stale data is indistinguishable from current data. |
| Demo / seed / test orgs | **Polluted** | Visibility is `organizationId`-scoped only. There is no `is_demo` flag on `companies`, so a misrouted seed (or dev rows accidentally created in a real org) would show as live customers. The customer-quotes seed gate (`isDemoSeedEnabled`) is the only existing chokepoint and only covers `quote_*` tables. |
| Suggestion counts vs card owner | **Needs validation** | Counts route scopes by `salesPersonId`; card shows `ownerRepId`. Owner cardinality mismatch can cause "0 suggested" on cards a rep is actually accountable for, and visible chips on cards a rep does not own. |
| `accountSummary` decoration | **Polluted** | AI-written field with no recency badge; never invalidated by data changes. Can read as authoritative but be months out of date. |

---

## 5. Failure modes (observed or plausible)

1. **Stale upload, "$0" everywhere** — The TMS upload didn't run; `account-summary` returns its 15-min cache or an empty array; every card shows "No financial data" and reps assume the customer didn't ship. *Confused with: customer actually didn't ship.*
2. **Heuristic financial match collision** — Two distinct customers that share a 5+ char substring (`Acme Holdings` vs `Acme Trucking`) collapse into one summary row; both cards display the same loads/margin. *Confused with: real growth.*
3. **Missing financial alias** — A customer whose CRM name diverges from the TMS spelling (e.g. `Acme Logistics LLC` vs `ACME LOGISTICS`) shows "No financial data" forever; aliases were never set. *Confused with: lost account.*
4. **Email-derived stub from pre-Task-#1095 backfill** — Legacy stub row exists, `is_email_derived=false` (default), so it surfaces in the main Customers list with no industry, no contacts, no financials. *Confused with: stale CRM entry that should be archived.*
5. **Owner mismatch** — Card shows "Unassigned" (because `ownerRepId` is null), but `assignedTo` points to a real rep. The rep filter shows the card under that rep; the card UI shows it as orphaned. Reps don't trust the column.
6. **Deleted-owner user** — A user is removed; their `ownerRepId` references survive; cards show "Unassigned" or, depending on the lookup, blank. No nightly reconciliation.
7. **Suggestions chip drift** — Pending count shown is for `salesPersonId`, but rep manages by `ownerRepId`; chip count and rep workload don't align.
8. **Growth-score job stalled** — `growthScoreCalculator` errors silently for one tenant; scores stay at last-calculated value (or 0); the "Not Scored" pill is shown for hundreds of accounts. *Confused with: never opened those pages.*
9. **Market-share staleness** — Last upload was 3 months ago; trend arrows still show; reps assume current quarter momentum.
10. **Contacts vs suggestions confusion** — A card shows "5 contacts" and "3 suggested"; reps don't know whether the 3 are duplicates or net-new (no resolution UI is present from the list view).
11. **Dead "Org Chart" decoration** — Looks like a counter, isn't clickable, doesn't reflect anything.
12. **Duplicate companies from email ingestion** — Pre-#1095 created multiple stubs for the same domain; not deduped; show as separate cards.
13. **Touchpoint summary visibility leak / hide** — Director moves under a new manager, `getVisibleRepUserIds` re-scopes; counts drop overnight without explanation.

---

## 6. Root-cause surfaces

| Failure | Likely root | Confidence |
|---|---|---|
| 1. Stale upload | `server/routes/financials.ts:820` (15-min cache, no freshness echoed); upload pipeline (`server/services/freightDailyUploadFact.ts` is invoked on upload only). | **High** |
| 2. Heuristic collisions | `client/src/pages/customers.tsx:63-101` (`matchFinancials` includes-heuristic + silent aggregation). | **High** |
| 3. Missing alias | `client/src/pages/customers.tsx:103-141` (`getCompanyFinancials`); UI offers no "alias missing" affordance. Schema field: `companies.financialAlias`. | **High** |
| 4. Pre-#1095 stub rows | `server/services/customerQuotes.ts` won-quote AF handoff (only setter); legacy rows pre-flag are not backfilled. | **High** |
| 5. Owner mismatch | `client/src/pages/customers.tsx:394-435` `applyFilters` (filters on `assignedTo`); render at 730–740 (uses `ownerRepId`). Schema: `companies.ownerRepId` vs `companies.assignedTo`. | **High** |
| 6. Deleted-owner user | `server/storage.ts` `getUsers` returns active users only; `accountOwnerMap` falls through silently. | **Medium** |
| 7. Suggestion chip drift | `server/routes.ts:10123` scopes by `salesPersonId`; card uses `ownerRepId`. | **High** |
| 8. Growth-score job stall | `server/growthScoreCalculator.ts` + on-demand recompute path in `server/routes.ts:4797`. No health endpoint, no error surface. | **Medium** |
| 9. Market-share staleness | `server/routes.ts:2545` (no last-period banner) + market-share upload UI (admin-driven). | **High** |
| 10. Contacts vs suggestions confusion | `client/src/pages/customers.tsx:828-836` (chip) + `/api/internal/accounts/:id/contact-suggestions`. | **Medium** |
| 11. "Org Chart" dead chip | `client/src/pages/customers.tsx:818-821`. | **High** |
| 12. Duplicate companies | Email ingestion pipeline that auto-creates `companies` rows before #1095. | **Medium** |
| 13. Touchpoint visibility flip | `server/routes.ts:5312` (`getVisibleRepUserIds`). Behaviour is correct but not signalled. | **Medium** |

---

## 7. Cleanup plan (phased)

### Phase 1 — Visibility (no data changes, no destructive behaviour)
- Add a "no financial mapping" badge on cards where `getCompanyFinancials` returns null **and** the company name has any token of length ≥ 4 that didn't appear in `accountSummary` rows. Visible cue distinct from "No loads this month".
- Add a "scores last calculated" chip near the Momentum badge sourced from `growthScores[i].calculatedAt` (already returned by the API; just unused in the card).
- Add a "Market share as of …" chip on cards that have a market-share entry (data already in `lastPeriodLabel`).
- Add an admin-only count chip in the header: "X email-derived hidden" using `/api/companies?includeEmailDerived=true&countOnly=…` (or a dedicated stats endpoint) — no list change.
- Replace the static "Org Chart" tag with a real link to the company's org chart page (or remove it if no destination exists).

### Phase 2 — Data cleanup (one-shot scripts, behind admin tooling)
- Backfill `financial_alias` for the top 200 customers by upload volume using a name-similarity scoring tool (manual review queue, not auto-apply).
- Reconcile `ownerRepId` vs `assignedTo`: produce a CSV diff and let directors confirm a one-way merge into `ownerRepId`. No automatic flip.
- Soft-archive (set `archivedAt`) duplicate email-derived rows where another non-email-derived row with the same domain exists. Reversible.

### Phase 3 — Pipeline restoration / observability
- Verify and document `monthlyDataRefreshScheduler.ts` actually runs (cron heartbeat).
- Surface health endpoints (`/api/health/jobs`) and an admin dashboard chip per job (growth scores, market share, financial upload, email ingestion).
- Add an "Account-summary anchor" chip pulling the upload's most recent `shipDate` so reps know how fresh the underlying TMS data is.

### Phase 4 — Hardening (guardrails)
- Add a Section 1102 guardrail: every new list endpoint that calls `storage.getCompanies` must either (a) accept and forward `includeEmailDerived` from the request, or (b) be added to an explicit allow-list with a justifying comment.
- Add an alias-coverage % test: warn when fewer than X% of revenue-bearing TMS customer names map to a `companies` row.
- Add an orphan-fact-row test: warn when fact rows whose `customer` is missing from `companies` exceed Y% of revenue.
- Add a "deleted-owner" lint: companies whose `ownerRepId` references a user whose `archivedAt` is set.
- Tighten the `CONTACT_JOBS_ENABLED` kill switch (Task #1094) coverage on the Customers contact-count path.
- Add `is_email_derived` write-side enforcement: only `customerQuotes.ts` may set it true, enforced by a guardrail test.

### Phase 5 — UX trust
- Per-metric freshness chips (loads / margin / market share / momentum).
- "Why $0?" tooltip distinguishing "no mapping", "no rows for this month", "true zero", and "stale upload".
- Owner mismatch indicator (small ⚠︎ when `ownerRepId !== assignedTo`).
- Suggestion vs contact disambiguation in a single hover-card showing both lists side-by-side with "convert" / "ignore" actions.

---

## 8. First three Replit actions (safest, read-only or visibility-only)

All three default to **read-only investigation**. Anything that mutates rows
or hides currently-visible data must wait until the audit is reviewed.

### Action 1 — Read-only investigation queries (no code shipped)
**Posture:** safe / read-only / **do not republish yet**.
Use the `database` skill against the **production** db with explicit
read-only queries to quantify the audit's biggest unknowns:
1. Count of rows where `is_email_derived = true`.
2. Count of rows where `is_email_derived = false` AND `created_at > (Task #1095 cutoff)` AND `industry IS NULL` AND no `contacts` rows exist (proxy for legacy stubs that should have been flagged).
3. Count of `companies` where `owner_rep_id IS DISTINCT FROM assigned_to` (and neither is null).
4. Count of `companies` whose name does not appear in any `freight_daily_upload_fact.customer` (case-insensitive trim) — proxy for "missing alias / no mapping".
5. Count of `growth_scores` whose `calculated_at` is older than 24h.
6. Latest `ship_date` in `freight_daily_upload_fact` per org (upload freshness).

Outputs are pasted into a follow-up task description, not into code.

### Action 2 — Add read-only freshness chips (visibility-only frontend change behind a flag)
**Posture:** safe / read-only / **do not republish yet** (ship behind admin-preview gate first).
File targets:
- `client/src/pages/customers.tsx` — add chips next to existing card metrics
  for `growthScores[i].calculatedAt` and market-share `lastPeriodLabel`.
  Reuse the existing query payloads — no new endpoints.
- Gate behind `feature-visibility.ts` "admin_preview" so only admins see the
  chips while we validate the wording/positioning.
**No data, schema, or RBAC changes.** No filter changes. No hide.

### Action 3 — Replace the dead "Org Chart" decoration
**Posture:** safe / read-only / **do not republish yet** (gated under the same admin-preview wrapper as Action 2; broader rollout follows Phase 1 sign-off).
File targets:
- `client/src/pages/customers.tsx:818-821` — either remove the chip entirely
  or convert it into a real `<Link>` to the existing org-chart route.
**No backend change.** This is the lowest-risk visible cleanup that builds
trust without touching any data path.

---

## 9. Risks before republishing

The following changes **must not be deployed** without explicit sign-off from
the owners listed in `replit.md` gotchas and the existing stability contracts:

1. **`server/services/customerQuotes.ts`** — any change to `applyFilters`,
   `loadContext`, `enrich`, `attachResponseTimes`, or the `__none__` resolver
   requires updating `docs/customer-quotes-stability-contract.md` and the
   Section 1100 guardrails. The Customers tab indirectly depends on this
   service (it is the only sanctioned setter of `companies.is_email_derived`).
2. **Hard `db.delete(contacts)`** — forbidden in production code per gotcha #1.
   Soft-delete via `storage.deleteContact(id, { userId, reason })` is the only
   path. Section 1200 enforces.
3. **`freight_daily_upload_fact` ingest** (`server/services/freightDailyUploadFact.ts`) —
   protected by Section 1051 of guardrails. Any change to the normalizer,
   the `moved` classifier, or the writer changes Financials, Available Freight,
   *and* the Lane Work Queue simultaneously.
4. **New visibility default that hides currently-shown rows** — the audit
   identifies several "polluted" surfaces, but flipping a default
   (`is_email_derived` heuristic backfill, owner reconciliation, alias
   collisions) without director sign-off would silently shrink reps' books
   overnight. Phase 1 stays additive.
5. **`/api/companies` query-param contract** — `includeEmailDerived` and
   `includeArchived` are public to the frontend; any rename or repurposing
   needs a coordinated client release. Section 1095 guardrail.
6. **`companies.ownerRepId` writes** — only via PATCH `/api/companies/:id/owner`.
   Both `POST /api/companies` and the generic PATCH route already strip it;
   any audit follow-up must preserve this chokepoint.
7. **Deleting / archiving rows surfaced by this audit** — "polluted" does
   not mean "delete". Soft-archive only, reversible, behind admin tooling.

Reference contracts:
- `docs/customer-quotes-stability-contract.md`
- `docs/unified-replit-daily-upload.md`
- `tests/code-quality-guardrails.test.ts` Sections 1051, 1095, 1100, 1200.

---

## Owner-mismatch diff

- 2026-05-07 read-only diff of `companies` where `owner_rep_id IS DISTINCT FROM assigned_to` (both non-null), with inactive-user proxy and per-org / per-category counts: [`customers-owner-mismatch-20260507.md`](./customers-owner-mismatch-20260507.md) → CSV at [`exports/customers-owner-mismatch-20260507.csv`](./exports/customers-owner-mismatch-20260507.csv).

---

## Appendix — Proposed follow-up tasks

These are **proposals** for the planning agent. Do not create them from this
task. Each is intended to be a small, independently shippable unit.

1. **Customers Tab — Phase 1 visibility chips (admin preview)**
   Add freshness chips (growth-score calc time, market-share period,
   "no financial mapping" indicator) behind `admin_preview` flag. No data
   changes. Files: `client/src/pages/customers.tsx`, `client/src/components/account-growth-portlet.tsx`.

2. **Customers Tab — Replace dead "Org Chart" decoration**
   Either remove or wire the static chip on the Customers card to a real
   destination. File: `client/src/pages/customers.tsx:818-821`.

3. **Customers Tab — Owner column unification (read-only audit + diff CSV)**
   Produce a CSV of `companies` where `ownerRepId IS DISTINCT FROM
   assignedTo`. No writes. Add a director-only review surface.

4. **Customers Tab — Replace heuristic `String.includes` financial match**
   Replace `matchFinancials` with an exact-name + alias map; emit a
   "needs alias" badge for rows that fall through. Files: `client/src/pages/customers.tsx:63-141`.

5. **Customers Tab — Account-summary endpoint migration to `freight_daily_upload_fact`**
   Move `/api/financials/account-summary` off `financial_uploads.summaryRows`
   and onto the unified fact table to align with replit.md. Requires
   Section 1051 review. File: `server/routes/financials.ts:820`.

6. **Customers Tab — Backfill `is_email_derived` flag for legacy stub rows**
   One-shot script + admin review queue, reversible. Aligns with gotcha #1095.

7. **Customers Tab — Suggestion-count scope unification**
   Rescope `/api/internal/accounts/suggestion-counts` to use `ownerRepId`
   (or unify with `assignedTo`) so the chip aligns with the card's owner.
   File: `server/routes.ts:10123`.

8. **Section 1102 guardrail — `getCompanies` callers must respect `includeEmailDerived`**
   New guardrail test enforcing every list endpoint either forwards the
   flag or sits on an allow-list with a justifying comment.

9. **Customers Tab — Job health surface**
   Add `/api/health/jobs` exposing last-success / last-failure for
   `growthScoreCalculator`, `monthlyDataRefreshScheduler`, market-share
   refresh, and email-intelligence pipeline. Render an admin banner on
   `/customers` when any has been red for >24h.

10. **Customers Tab — Deleted-owner reconciliation lint**
    Nightly job + admin queue: companies whose `ownerRepId` points to an
    archived user. Surfaces "ownership orphans" instead of silently
    rendering them as "Unassigned".
