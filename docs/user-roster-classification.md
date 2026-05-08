# User Roster Classification (Task #1126, Phase 0)

This document describes the heuristic rules the read-only User Roster Health
snapshot uses to bin every user in an organization into one of six buckets.
The rules are implemented in `server/lib/userRosterClassification.ts` and
exposed through:

- `GET /api/admin/roster-health` — bucket counts + up to 50 example rows per
  bucket (Phase 0 hard cap; cleanup buckets sort by `reviewPriority` desc,
  real buckets sort by `totalActivity` desc; admins use the CSV export below
  for the full list)
- `GET /api/admin/roster-health/export?bucket=<name>` — full CSV of one
  bucket

Both endpoints are admin-only and org-scoped. **Zero writes** — no
`db.update`, no `db.insert`, no `db.delete`. The snapshot is cached
in-process for 60 seconds per organization.

## Phase 0 contract

This snapshot is a **heuristic audit overlay**, not durable user state.

- Roster Health is read-only and side-effect-free.
- Buckets MUST NOT gate roster visibility, RBAC, leaderboards, headcount,
  Stripe seat counts, Webex / M365 routing, or any destructive action.
- No delete / deactivate / hide / impersonation logic may be driven directly
  from these heuristics. The user must look at the panel and confirm.
- Bucket assignment can change between two consecutive snapshots if the
  underlying activity changes — never persist the bucket itself.

If a downstream feature needs durable state (e.g. "exclude service accounts
from leaderboards"), that requires the Phase 1 columns proposed below — not
a read against this snapshot.

## Buckets

| Bucket | When it applies |
| --- | --- |
| `likely_junk` | Username matches a junk pattern (e.g. `%example%`, `%test%`, `+test@`, `asdf@`, `foo@`, `mailinator.com`) **AND** zero downstream activity. |
| `likely_demo_fixture` | Username/name matches a known seed-script pattern (`seed-`, `wq.test.*`, `am.123@`, …) **OR** the org's slug/name marks it as a demo/fixture org. |
| `likely_service_shared_inbox` | Username starts with a shared-inbox local-part (`rfq@`, `tenders@`, `noreply@`, `info@`, `dispatch@`, `inbox+`, `+team@`, …). |
| `real_active` | Logged in within the last 90 days **AND** has non-zero downstream activity. |
| `real_inactive` | No login in the last 90 days **AND** no recent login activity, but has historical downstream activity. |
| `uncertain` | Anything that doesn't cleanly fit. The deliberate safety valve — used liberally rather than guessing. |

### Rule precedence

Rules are applied in the following order; the first match wins:

1. **`likely_junk`** — junk username pattern AND `totalActivity === 0`.
2. **`likely_service_shared_inbox`** — service / shared-inbox local-part.
3. **`likely_demo_fixture`** — demo org slug, or seed-script username/name.
4. **`real_active`** — last login ≤ 90 days AND `totalActivity > 0`.
5. **`real_inactive`** — last login > 90 days (or never) AND `totalActivity > 0`.
6. **`uncertain`** — fallthrough. Includes "junk-looking but has activity"
   and "no login + no activity + no pattern" cases.

### `reason` (returned per user)

A single short tag summarising why the row landed in its bucket. Kept for
back-compat with the existing CSV consumers.

- `junk_email_pattern`
- `service_inbox_pattern`
- `demo_org_slug`
- `seed_script_username`
- `recent_login_and_activity`
- `historical_activity_only`
- `junk_pattern_but_has_activity`
- `no_login_no_activity_no_pattern`

## Signals (per user)

`signals: string[]` is the catalogue of **every** heuristic that fired for
the user, independent of which bucket won. A `real_active` user can still
carry e.g. `no-fin-rep-id` so reviewers see the data-quality footnote. Tag
names are stable identifiers safe to use in `data-testid` and CSV columns.

| Signal | Means |
| --- | --- |
| `username:test-pattern` | Login matches a generic test pattern (e.g. `_test@`, `.test@`, `_demo@`, `qwerty…`, `xxx@`). |
| `username:plus-test` | Login is a `+test@` plus-tag address. |
| `username:mailinator` | Login domain is `mailinator.com`. |
| `username:junk-domain` | Login ends with another known junk suffix (`.test`, `.example`, `.localhost`, `@example.com`, `@yopmail.com`, …). |
| `username:bare-junk-localpart` | Login has no `@` and is one of `test`, `demo`, `asdf`, `foo`, `bar`, `qwerty`, `abc`, `xxx` (with or without trailing digits). |
| `local-part:noreply` | Login starts with `noreply@` / `no-reply@` / `donotreply@` / `do-not-reply@`. |
| `local-part:<prefix>` | Login starts with another shared-inbox local part (`rfq`, `tenders`, `bids`, `quotes`, `info`, `support`, `sales`, `ops`, `dispatch`, `logistics`, `shipping`, `inbox`, `team`, `hello`, `contact`, `billing`, `ar`, `ap`). |
| `local-part:shared-inbox` | Login matches a `+team@` / `+rfq@` / `+tenders@` / `inbox+…` / `rfq+…` plus-tag pattern. |
| `seed:wq.test` | Lane-work-queue test fixture (e.g. `wq.test.am1`). |
| `seed:am.NNN` / `seed:director.NNN` / `seed:lm.NNN` | Numeric-suffix seed users (`am.123@`, `director.7@`, `lm.4@`). |
| `seed:fixture-pattern` | Other recognised seed pattern (`seed_…`, `demo_…`, `fixture_…`, `test_user_…`). |
| `org:demo-or-fixture` | The user's org slug or name matches a demo / fixture / seed pattern. |
| `zero-activity` | `totalActivity === 0` across all sources below. |
| `last-login:never` | `users.last_login_at IS NULL`. |
| `last-login:>180d` | Last login is older than 180 days. |
| `created:<7d-no-activity` | Account created in the last 7 days but still has zero activity. |
| `no-manager` | `users.manager_id IS NULL` — not in the org chart. |
| `no-fin-rep-id` | `users.financial_rep_id` is null/blank — not bound to financial uploads. |

## `reviewPriority` (0..100)

Used to sort cleanup buckets so the most obviously bad rows surface first
instead of the most-active rows. Computed as:

- `+30` per cleanup-positive signal: every `username:*`, `local-part:*`,
  `seed:*`, `org:demo-or-fixture`, `zero-activity`, `last-login:never`,
  `last-login:>180d`, `created:<7d-no-activity`.
- `−40` if `totalActivity > 0` (any non-zero downstream activity).
- `−20` if there is a recent login (≤ 90 days, the same window the
  classifier already uses for `real_active`).

Clamped to `[0, 100]`. Pure data-quality signals (`no-manager`,
`no-fin-rep-id`) carry no `reviewPriority` weight — they appear as badges
only.

### Bucket sort order

| Bucket(s) | Sort |
| --- | --- |
| `likely_junk`, `likely_demo_fixture`, `likely_service_shared_inbox`, `uncertain` | `reviewPriority` DESC, `totalActivity` ASC, `createdAt` DESC, `name` ASC |
| `real_active`, `real_inactive` | `totalActivity` DESC, `name` ASC |

## Activity summary

For each user we compute the following per-source counts, batched as one
query per source table:

| Field | Source |
| --- | --- |
| `notesAuthored` | `context_notes` where `author_id = user.id` and `org_id = user.organizationId` |
| `touchpoints` | `touchpoints` where `logged_by_id = user.id` |
| `ownedCompanies` | `companies` where `assigned_to = user.id` and `organization_id = user.organizationId` |
| `ownedOpportunities` | `crm_opportunities` where `created_by_id = user.id` and `organization_id = user.organizationId` |
| `assignedTasks` | `tasks` where `assigned_to = user.id` |
| `freightRows` | Count of `freight_daily_upload_fact` rows whose `customer` matches (case-insensitively) the `name` or `financial_alias` of a `companies` row whose `assigned_to` is this user. Attribution flows through company ownership — not directly through `users.financialRepId` — to mirror how the dashboard / goals routes already roll freight margin up to a rep, and to avoid fabricating a per-rep count when no such column exists on the fact table. |

`totalActivity` is the sum of the above. Any value `> 0` qualifies as
"non-zero downstream activity" for bucket selection.

## Known blind spots

These are real gaps in the Phase 0 classifier. Reviewers should treat the
panel as an audit aid, not as ground truth.

- **No per-rep freight activity from `users.financialRepId`.** Freight
  attribution goes through `companies.assignedTo` (see the `freightRows`
  row above). A user who has a `financialRepId` set but owns no company
  will read as zero-freight even if margin is being booked under their rep
  code in `financial_uploads`.
- **Demo-org detection is regex on slug/name.** Orgs with a "real-looking"
  slug used for demos won't be flagged at the org level; only their
  individual users with seed-pattern names will be caught.
- **Soft-deleted users do not exist yet on `users`.** There is no
  `deleted_at` column today, so the panel cannot distinguish "account was
  intentionally retired" from "account was always junk." Phase 1 closes
  this gap.
- **`is_service_account` does not exist yet.** Shared inboxes are detected
  by login local-part only. A real human whose login happens to match
  `sales@` or `info@` will be mis-labelled until Phase 1 lets admins
  override.
- **Activity counts ignore deletions.** A user who logged 500 historical
  notes that have since been hard-deleted will read as zero-activity.
- **Recent-login heuristic depends on `users.last_login_at` being kept
  fresh** by the auth path. SSO bypasses or background-job impersonation
  paths can leave it stale.
- **Plus-tag aliases.** Real users sometimes use `firstname+role@` plus
  tags that look like service inboxes; these will pick up
  `local-part:shared-inbox` even though the human is real.

## Phase 1 schema proposal (NOT this task)

When the schema flags land they are intended to map onto these buckets so
the snapshot can be replaced by deterministic queries. **None of these
columns exist today** — this section is design-only.

### Proposed additive columns on `users`

| Column | Type | Purpose |
| --- | --- | --- |
| `is_active` | `boolean NOT NULL DEFAULT true` | Soft-disable login + assignment without losing history. Drives default `GET /api/users` filter. |
| `deleted_at` | `timestamptz NULL` | Soft-delete tombstone (mirrors the `contacts` pattern from Task #1093). Restore = clear. |
| `deleted_by` | `uuid NULL → users.id` | Audit. |
| `delete_reason` | `text NULL` | Free-form (e.g. `roster-cleanup:likely_junk`). |
| `is_demo` | `boolean NOT NULL DEFAULT false` | Marks a user inside a demo org or seeded as demo. |
| `is_fixture` | `boolean NOT NULL DEFAULT false` | Test / seed fixture (e.g. `wq.test.*`). Excluded from production reporting. |
| `is_service_account` | `boolean NOT NULL DEFAULT false` | Shared inbox / automation principal. Excluded from leaderboards & seat counts. Stays "active." |
| `is_quarantined` | `boolean NOT NULL DEFAULT false` | Suspicious but undecided — hidden from dropdowns but kept in admin views. |
| `user_source` | `text NULL` | Provenance: `clerk`, `seed`, `bulk-import`, `email-derived`, `manual-admin`. |
| `last_activity_at` | `timestamptz NULL` | Denormalized `max(notes/touchpoints/companies/opps/tasks/freight)`. Backs the classifier and the UI without per-render scans. |

### Bucket → flag mapping (one-to-many)

| Phase 0 bucket | Likely Phase 1 flags set (after admin confirmation) |
| --- | --- |
| `likely_junk` | `is_active = false` + `deleted_at = now()` + `delete_reason = 'roster-cleanup:junk'` |
| `likely_demo_fixture` | `is_demo = true` and/or `is_fixture = true`; `is_active = false` if found in a production org |
| `likely_service_shared_inbox` | `is_service_account = true` (kept active, excluded from leaderboards & seats) |
| `real_active` | no flag changes |
| `real_inactive` | candidate for `is_active = false` after `last_activity_at` threshold + admin sign-off |
| `uncertain` | `is_quarantined = true` until reviewed |

### Cross-tab dependencies to design around in Phase 1

These are the surfaces that any future delete / deactivate / hide logic
based on these flags MUST account for. They are also why Phase 0 is strict
read-only.

1. **Org chart** — `users.managerId` references; deactivating a manager
   orphans direct reports.
2. **RBAC team scoping** — director / NAM scoping uses `managerId` chains
   to compute "my team." A flipped flag silently widens or narrows scope.
3. **Financial attribution** — `users.financialRepId` is keyed into
   `freight_daily_upload_fact` via name / alias mapping (see
   `server/routes/dashboard.ts`, `server/routes/goals.ts`). Deactivation
   must not drop margin attribution.
4. **Team performance / leaderboards** — must filter `is_service_account`
   and `deleted_at IS NOT NULL`.
5. **Webex / M365** — mailbox bindings reference `users.id`; soft-delete
   must keep historical email/call linkage intact.
6. **Clerk identity** — `clerk_user_id` linkage; soft-delete should not
   silently free up the same Clerk user for re-creation without an admin
   reset.
7. **Stripe seat counts** — billed seats must exclude
   `is_service_account`, `deleted_at IS NOT NULL`, and (in non-demo orgs)
   `is_demo`.
8. **Contact promotion / signature sweep** — `assignedTo` writers
   (already gated by `CONTACT_JOBS_ENABLED`) must skip non-active users.

## Phase 1 step 2 — observational backfill (`tools/backfill-user-lifecycle.ts`)

Phase 1 step 1 added the lifecycle columns; this step populates the two
**observational** ones (`user_source`, `last_activity_at`) so the
classifier and future admin UI have richer per-user context. The script
is **strictly observational** — it never writes `is_active`,
`is_service_account`, `is_demo`, `is_fixture`, `is_quarantined`, or any
of the `deleted_*` / `deactivated_*` columns.

**Run modes**

```
npx tsx tools/backfill-user-lifecycle.ts                # all orgs, DRY-RUN
npx tsx tools/backfill-user-lifecycle.ts --apply        # all orgs, write
npx tsx tools/backfill-user-lifecycle.ts --org=<uuid>   # one org, DRY-RUN
```

Idempotent: the UPDATE uses `IS DISTINCT FROM` on both columns, so a
re-run with no new activity is a no-op.

**`user_source` derivation (conservative on purpose)**

| Evidence | Value written |
| --- | --- |
| `clerk_user_id IS NOT NULL` | `clerk` |
| `username` matches `^(wq\|am)\.test\.`, `^am\.\d+`, or ends in `@mailinator.com` | `seed` |
| anything else | `unknown` |

`bulk-import`, `email-derived`, and `manual-admin` remain valid future
values (they're documented in the schema column purpose) but the script
never writes them — there's no durable marker on `users` today and the
stop rule says classify as `unknown` rather than guess.

**`last_activity_at` derivation**

`GREATEST(...)` of these per-user maxes, computed in Postgres:

- `MAX(context_notes.created_at)` where `author_id = u.id`
- `MAX(touchpoints.created_at)` where `logged_by_id = u.id`
- `MAX(crm_opportunities.updated_at)` where `created_by_id = u.id`
- `MAX(tasks.created_at)` where `assigned_to = u.id`

**Known blind spots (not contributing to `last_activity_at`)**

- `companies.assigned_to` — no per-assignment timestamp on the column.
- `freight_daily_upload_fact` — no FK to `users`; the Roster Health
  freight signal is a heuristic name/alias join via `financial_rep_id`
  and would conflate organic freight with a user's own work if rolled
  into a personal "last activity" stamp.
- `users.last_login_at` — login is its own axis. Phase 0 already reads
  it directly; folding it into `last_activity_at` would mask reps who
  log in but do nothing.

**No behavior changes from this step.** Nothing in the runtime reads
`user_source` or `last_activity_at` yet; both are observability fields
for the next admin UI / classifier work.

---

## Phase 1 Step 3 — Admin lifecycle write paths

Step 3 ships the **server-side** write paths only. There are no UI
buttons yet, and no read-side filters consume the new flags (auth,
`GET /api/users` defaults, dashboards, dropdowns, Stripe seats,
Webex, contact-jobs all behave exactly as before — that migration is
Step 4+).

All routes are admin-only AND org-scoped. The route layer enforces
`requireAuth + isAdmin`; the storage layer ALSO enforces the
org-scope so a future caller cannot bypass the route. Storage writes
are transactional: `SELECT … FOR UPDATE` snapshots `prev_state`,
the `users` UPDATE applies, and a single `user_lifecycle_events`
row is inserted in the same transaction.

### Routes

| Method + path | Body | Effect | Audit `event` |
| --- | --- | --- | --- |
| `POST /api/admin/users/:id/classify` | `{ isServiceAccount?, isDemo?, isFixture?, isQuarantined?, isActive?, reason? }` | Sets non-destructive classification flags. Refuses `isServiceAccount=true` on a live, non-demo, non-fixture user unless `isActive:false` is set in the same call. Idempotent — no audit row if nothing changed. | `classify` |
| `POST /api/admin/users/:id/deactivate` | `{ reason }` (required) | `is_active=false`, `deactivated_at=now()`, `deactivated_by=actor`, `deactivation_reason=reason`. Idempotent 200 (no duplicate audit row) when already inactive. Cannot deactivate yourself. | `deactivate` |
| `POST /api/admin/users/:id/reactivate` | `{ reason? }` | `is_active=true`, clears `deactivated_*`. **Refuses** if `deleted_at IS NOT NULL` (must `restore` first) or `is_service_account=true` (must clear via `classify` first). | `reactivate` |
| `POST /api/admin/users/:id/soft-delete?force=true` | `{ reason }` (required) | `deleted_at=now()`, `deleted_by=actor`, `delete_reason=reason`, also forces `is_active=false`. Refuses with HTTP 409 + impact preview unless `?force=true` when the user has any open ownership (companies.assignedTo / ownerRepId / salesPersonId, open opportunities, open tasks). The audit row carries `force: true` in `next_state` when overridden. Cannot soft-delete yourself. | `soft_delete` |
| `POST /api/admin/users/:id/restore` | `{ reason? }` | Clears `deleted_*`. **Per the design rule, the user is left INACTIVE** (`is_active` stays false). Caller must follow up with `reactivate` to make them a live employee. Response carries `_restoredToInactive: true` so the future admin UI never has to re-derive that. | `restore` |
| `GET /api/admin/users/:id/lifecycle-events?limit=100` | — | Org-scoped read of `user_lifecycle_events` for the target user, newest first, with actor name resolved via LEFT JOIN. Limit clamped to `[1, 500]`. | — |
| `GET /api/admin/users/:id/impact` | — | Read-only blast-radius preview: per-axis counts of owned companies (assignedTo, ownerRepId, salesPersonId), open opportunities (`outcome IS NULL`), open tasks (`status NOT IN done/closed/cancelled/completed`), 30-day touchpoint count, and `lastActivityAt` (max of `users.lastActivityAt`, `context_notes.createdAt`, `touchpoints.createdAt`, `tasks.createdAt`). Returns `softDeleteWouldBlock: boolean` — the same flag the soft-delete route checks. | — |

### HTTP status mapping

The storage layer raises `UserLifecycleError(code, message, meta?)`,
which the route layer maps as:

| Storage code | HTTP | Notes |
| --- | --- | --- |
| `NOT_FOUND` | 404 | Target user not in caller's organization |
| `IMPACT_BLOCK` | 409 | Soft-delete refused; response body carries the `meta.impact` payload |
| `CONFLICT` | 409 | Reactivate refused for soft-deleted user |
| `GUARD` | 400 | Missing required field, service-account guard, self-target |

### What Step 3 deliberately does NOT do

- **No reads change.** `GET /api/users`, `requireAuth`, dashboards,
  dropdowns, leaderboards, Stripe seat counts, contact-jobs gate,
  email pipeline — all unchanged.
- **No UI.** `client/src/pages/admin-users.tsx` is untouched. Admin
  UI lands in Step 5 alongside the read-side filter migration.
- **No rewrite of `DELETE /api/users/:id`.** The legacy hard-delete
  route stays on its existing contract; replacing it is Step 6.
- **No auto-classification.** Every flag flip is a deliberate admin
  action with an explicit `reason`.
- **No cascading ownership rebind.** Soft-delete only flips the user
  row. The impact endpoint surfaces the count so admins can rebind
  ownership manually before forcing the delete.

---

## Phase 1 Step 4a-API — Default `GET /api/users` filter

Step 4a-API is the first read-side change. It updates **only** the
default `GET /api/users` roster so admins, managers, and assignee
pickers stop seeing service accounts, deactivated employees,
soft-deleted rows, quarantined rows, demo seeds, and fixture seeds in
the same pane. UI changes (admin tabs) are deferred to Step 4a-UI.

### Default filter (no flags)

In addition to the existing org-id scope, `getUsers(orgId, {})`
applies:

```
deleted_at IS NULL
AND COALESCE(is_active, true)         = true
AND COALESCE(is_service_account,false)= false
AND COALESCE(is_quarantined, false)   = false
AND COALESCE(is_demo, false)          = false
AND COALESCE(is_fixture, false)       = false   -- always; not opt-in
```

`COALESCE(is_active, true)` keeps legacy seeds (rows whose lifecycle
columns were never backfilled) visible by default — matching the
design doc and avoiding a silent disappearance of the existing roster
on day-one.

### Include flags

| Query flag | Effect | Caller gate |
| --- | --- | --- |
| `?includeInactive=true` | Drops the `is_active=true` clause | any caller |
| `?includeDeleted=true` | Drops the `deleted_at IS NULL` clause | **admin only** |
| `?includeServiceAccounts=true` | Drops the service-account clause | **admin only** |
| `?includeQuarantined=true` | Drops the quarantined clause | **admin only** |
| `?includeDemo=true` | Drops the demo clause | **admin only** |
| `?includeManagers=true` | Pre-existing role-chain knob | unchanged |

`is_fixture` rows stay excluded under **every** combination — there is
no `includeFixture` knob. The fixture-poisoning guard in
`assertNotFixtureEmail` and the monitored-mailbox roll-up depend on
this.

### Non-admin handling of admin-only flags

A non-admin caller passing any of `includeDeleted`,
`includeServiceAccounts`, `includeQuarantined`, or `includeDemo` does
**not** receive a 403. The flag is silently dropped and a
`[users-roster] non-admin <id> sent admin-gated include flags=…`
debug line is emitted. Rationale: shared frontend code may speculatively
forward whatever flags the page state holds; rejecting the request
would break unrelated callers.

`includeInactive` is the one flag a non-admin manager may legitimately
need (offboarding handoff reviews), so it is forwarded as-is.

### What Step 4a-API does NOT change

- `/api/users/sales`, `/api/users/search`, `/api/users/streak`,
  `/api/users/saved-filters` — sibling routes keep their existing
  behavior. Aligning them is a future sub-step.
- `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`
  — write paths are untouched.
- `server/auth.ts`, login, session, `requireAuth` — unchanged. A
  deactivated user can still log in today; that gate moves in Step 4b.
- Internal callers `getFinancialUploadsForOrg` and
  `getLatestFinancialUploadForOrg` keep using the no-arg
  `storage.getUsers(orgId)` overload so their historical scoping does
  not silently lose now-deactivated reps.
- Dashboards, leaderboards, goals, customer quotes, NBA, Webex/M365,
  Stripe seat counts, contact jobs — none consume the new default;
  Phase 1 Step 4 sub-steps will migrate them one surface at a time.
- Admin-users UI tabs are deferred to **Step 4a-UI** so the API change
  can be verified in isolation.

### Known cross-tab behavior on day-one

Any client query keyed on `["/api/users"]` is now strictly smaller by
default. The 24 in-tree consumers (dashboard, rep-customers, prospects,
leak-console, daily-priorities, ai-agent, IntelTab, available-freight,
my-procurement, ContextNote* threads, response-time-tab,
forced-focus-dialog, carrier-procurement-workspace,
admin-monitored-mailboxes, rep-reports-roster, prospects/CrmSettingsDialog,
etc.) all use the response as a name/avatar lookup or assignee picker —
both of which intentionally want the cleaned roster. The one caveat is
**historical attribution** (e.g. "who created this note 8 months ago?"):
if the original author has been soft-deleted, the lookup will miss and
the UI falls back to "Unknown user". The proper fix is
`formatUserAttribution` adoption in those surfaces, which is its own
later sub-step. Until soft-deletes actually start writing in production,
the practical impact is zero.

---

## Phase 1 Step 4a-UI — User Management lifecycle tabs (2026-05-07)

Wires the 4a-API `include*` flags into the **only** consumer that should
opt into them: `client/src/pages/admin-users.tsx`. Every other tab in the
app continues to read the cleaned default roster.

**Tab → flag mapping** (admin only):

| Tab               | URL                                              | Flag |
|-------------------|--------------------------------------------------|------|
| Active (default)  | `/api/users`                                     | _(none — default cleaned roster)_ |
| Inactive          | `/api/users?includeInactive=true`                | `includeInactive` |
| Service accounts  | `/api/users?includeServiceAccounts=true`         | `includeServiceAccounts` |
| Quarantined       | `/api/users?includeQuarantined=true`             | `includeQuarantined` |
| Deleted           | `/api/users?includeDeleted=true`                 | `includeDeleted` |

Out of scope for 4a-UI:

- `includeDemo` is intentionally **not** wired in this step. There is no
  Demo tab and no UI knob; admins who need to inspect demo rows must call
  the API directly until a future step adds the tab.
- `is_fixture` rows have no opt-in by 4a-API contract — same here.
- Non-admins never see the lifecycle strip and never get include flags
  forwarded; their `usersUrl` is hard-coded to `/api/users`.

**Cache key:** the `useQuery` key is `[usersUrl]`, so each tab gets its
own cache slice. All four create / edit / delete / bulk-import sites in
`admin-users.tsx` route through `invalidateAllUsersQueries()`, which
predicate-matches every key starting with `/api/users` (excluding sub-
routes like `/api/users/sales`) so a write refreshes every cached tab.

**TODO (later sub-step):** add an e2e test asserting each tab fires the
correct request URL. Section 1126.4-UI of `tests/code-quality-guardrails.test.ts`
already pins the source-level mapping.
