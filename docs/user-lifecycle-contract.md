# User Lifecycle Contract (Task #1126 Phase 1)

Combines the contracts from Steps 3, 4a-API, and 4a-UI.

---

## Step 3 — Lifecycle write paths (2026-05-07)

Admin-only, org-scoped routes registered in `server/routes/adminUserLifecycle.ts`:
- `POST /api/admin/users/:id/{classify,deactivate,reactivate,soft-delete,restore}`
- `GET /api/admin/users/:id/{lifecycle-events,impact}`

### Storage-only write rule
**All lifecycle column writes** (`is_active`, `is_service_account`, `is_demo`, `is_fixture`, `is_quarantined`, `deleted_at`, `deactivated_at`, …) MUST go through `storage.{classify,deactivate,reactivate,softDelete,restore}User` — **never** raw `db.update(users).set({ isActive… })`.

Those methods:
1. Row-lock the target with `SELECT … FOR UPDATE`
2. Snapshot `prev_state`
3. Apply the UPDATE
4. Insert a single `user_lifecycle_events` row in the same transaction

Audit rows must only be written from `server/storage.ts` (Section 1126.3 of `tests/code-quality-guardrails.test.ts` enforces this).

### Behavior pins
- **Restore returns the user to INACTIVE, not active** (caller must reactivate explicitly).
- **Service accounts cannot be promoted from a live user without also setting `isActive:false`** in the same `classify` call, and `reactivate` refuses while `is_service_account=true`.
- **Soft-delete refuses with HTTP 409 + impact preview** when the user has open ownership; `?force=true` overrides and is recorded in `next_state.force`.

### Schema
Requires `drizzle-kit push:pg` (migrations 0017 + 0018 from Step 1) before deploy.

### Out of scope (do NOT regress)
`server/auth.ts`, `GET /api/users` defaults, `DELETE /api/users/:id` contract, `PATCH /api/users/:id`, `client/src/pages/admin-users.tsx`, dashboards, goals, quotes, NBA, Webex, Stripe, contact-jobs — none of these read the new lifecycle flags yet (Step 4+).

---

## Step 4a-API — Default `GET /api/users` lifecycle filter (2026-05-07)

The default roster now hides rows where any of the following are true:
- `deleted_at IS NOT NULL`
- `is_active = false`
- `is_service_account = true`
- `is_quarantined = true`
- `is_demo = true`
- `is_fixture = true`

### Opt-in flags
Five opt-in query flags exist:
- `?includeInactive=true` — any caller
- `?includeDeleted=true` — **admin-only**
- `?includeServiceAccounts=true` — **admin-only**
- `?includeQuarantined=true` — **admin-only**
- `?includeDemo=true` — **admin-only**

The four admin-only flags are silently dropped + debug-logged for non-admins — never 403'd, so shared client code can keep passing them.

**There is no `includeFixture` knob — `is_fixture` rows stay excluded under every flag combination** (preserves the fixture-poisoning guard).

### Contract location
Lives on `storage.getUsers(orgId, filter?: UserListFilter)`. The no-arg overload keeps the legacy "every user" behavior for the two internal financial-uploads callers (`getFinancialUploadsForOrg`, `getLatestFinancialUploadForOrg`) so their historical scoping does not silently lose now-deactivated reps.

Section 1126.4 of `tests/code-quality-guardrails.test.ts` enforces the contract.

### Out of scope
`/api/users/sales`, `/api/users/search`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`, `server/auth.ts` / login, dashboards, leaderboards, goals, customer quotes, NBA, Webex/M365, Stripe seat counts, contact jobs — none consume the new default yet.

### Day-one caveat
Pages that resolve historical author names from `["/api/users"]` (notes, touchpoints, activity feeds) will fall back to "Unknown user" for soft-deleted authors; the proper fix is `formatUserAttribution` adoption in those surfaces (later sub-step).

---

## Step 4a-UI — User Management lifecycle tabs (2026-05-07)

`client/src/pages/admin-users.tsx` is the **only** consumer that opts into the 4a-API `include*` flags.

### Mapping
Admin-only segmented strip (`data-testid="lifecycle-tabs"`) maps:

| Tab label | Flag |
|---|---|
| Active | none |
| Inactive | `includeInactive` |
| Service accounts | `includeServiceAccounts` |
| Quarantined | `includeQuarantined` |
| Deleted | `includeDeleted` |

Non-admins never see the strip and always read `/api/users` (cleaned default).

### Cache
Per-tab cache slices keyed off `[usersUrl]`; create/edit/delete/bulk-import all flow through `invalidateAllUsersQueries()` (predicate matches any `/api/users` key, excluding sub-routes like `/api/users/sales`).

`includeDemo` is intentionally NOT wired here — no Demo tab; that's a future sub-step.

Section 1126.4-UI of `tests/code-quality-guardrails.test.ts` pins the mapping, the admin gate, the `[usersUrl]` queryKey, and the absence of legacy bare-key invalidations.

### Out of scope (do NOT regress)
Every other `/api/users` consumer (~24 files) keeps the bare `["/api/users"]` queryKey and inherits the cleaned default.
