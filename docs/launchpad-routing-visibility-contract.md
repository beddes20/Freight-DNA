# Launchpad Routing Visibility Contract (L1.1, 2026-05-18)

## Purpose

The Launchpad **Needs Routing** inbox (`client/src/pages/prospects/components/RoutingSection.tsx`) must show **manager-like roles** the unowned, `is_email_derived=true` companies that the inbound-email pipeline auto-created so they can claim, reassign, or archive them. Before L1.1, `getVisibleCompanyIds(currentUser)` in `server/auth.ts` filtered out every unowned company for non-admins, so the queue was empty for the very directors / NAMs / sales_directors who do the assigning work.

L1.1 widens that visibility — but only inside a **strict opt-in code path**, only for **manager-like roles**, and only for the **unowned + email-derived + unarchived** slice. Every other consumer of `getVisibleCompanyIds` is byte-for-byte unchanged.

## Manager-like role set

The widening applies only to these three non-admin roles:

```
director
national_account_manager
sales_director
```

Admins already get `null` (every company) from `getVisibleCompanyIds` and don't need the widening. `sales`, `account_manager`, `logistics_manager`, and `logistics_coordinator` are deliberately excluded — they cannot see unowned accounts via this code path. The role set matches the existing `PATCH /api/companies/:id/owner` allow-list so the people who can *see* the queue are exactly the people who can *act* on it.

## Contract surface

### Server — `server/auth.ts`

1. **Type:** `CompanyVisibilityOptions = { includeUnroutedEmailDerived?: boolean }` is exported.
2. **`getVisibleCompanyIds(user, options?)`** accepts the optional second argument. The no-arg call is the legacy contract — all ~60 existing callers keep their byte-for-byte behavior.
3. When `options.includeUnroutedEmailDerived === true` AND the caller's role is in `{director, national_account_manager, sales_director}`, the function builds the set of company IDs where:
   - `isEmailDerived === true`, AND
   - `getCanonicalCompanyOwnerId(c) === null` (i.e. `ownerRepId ?? assignedTo ?? salesPersonId` all null), AND
   - `archivedAt` is null
   That set is then **unioned** into the role-specific result. The widening is monotone non-decreasing per user: no caller ever loses access via this option.
4. The `logistics_manager → manager` cascade does **NOT** propagate the option. Logistics seats are explicitly out of scope.
5. **`canAccessCompany(user, companyId, options?)`** mirrors the signature and forwards the option into `getVisibleCompanyIds`. The no-arg call is the legacy contract.

### Server — `server/routes/companies.ts`

1. **`GET /api/companies`** reads `?includeUnroutedEmailDerived=true` and threads it into `getVisibleCompanyIds`.
2. **Silent-drop pattern** (mirrors §1126.4 / §1400 / §1300): non-manager callers passing the flag get it stripped server-side and a single `[routing-visibility] non-manager <userId> role=<role> sent includeUnroutedEmailDerived=true; ignoring` debug log is emitted. **Never 403** — a shared client must be safe to pass the flag.
3. **`PATCH /api/companies/:id/owner`** passes `{ includeUnroutedEmailDerived: true }` into `canAccessCompany`. The existing role-gate (admin/director/NAM/sales_director) already restricts who can call the route; passing the flag lets `canAccessCompany` see the row for those roles. Other roles are blocked by the role-gate before reaching `canAccessCompany`.
4. **`POST /api/companies/:id/archive`** passes `{ includeUnroutedEmailDerived: true }` into `canAccessCompany`. Same rationale — only manager roles benefit (the flag is a no-op for sales/logistics in `getVisibleCompanyIds`).

### Client — `client/src/pages/prospects/components/RoutingSection.tsx`

1. Component-local `ROUTING_MANAGER_ROLES = {admin, director, national_account_manager, sales_director}` gates both queries and the action buttons. Non-managers see a `banner-routing-readonly` info card and no rows.
2. The companies query fetches `GET /api/companies?includeEmailDerived=true&includeUnroutedEmailDerived=true`.
3. Inbox post-filter is `isEmailDerived === true && !ownerRepId && !assignedTo && !salesPersonId && !archivedAt`, mirroring `getCanonicalCompanyOwnerId() === null`.

### Client — `client/src/pages/prospects.tsx`

1. Tab visibility (`canRouteAccounts`) gates the routing tab on the same four-role set.
2. URL-tampering (`?tab=routing` from a non-manager) silently falls back to the default tab.

## Out of scope (do NOT regress here)

This contract authorizes **only** the read-side widening for `includeUnroutedEmailDerived` and the two action-path uses of the same flag on `PATCH /owner` + `POST /archive`. Nothing else in `getVisibleCompanyIds` or `canAccessCompany` changes.

The following remain bound by their existing contracts and **must not be widened by this change**:

- `server/services/customerQuotes.ts` (CQ stability contract, Section 1100) — does not pass `includeUnroutedEmailDerived`.
- `freight_daily_upload_fact` writers (Section 1051).
- Email ingestion `processUserMailboxEmail` (Sections 1094/1095).
- Contacts read paths (Sections 1093/1200).
- User lifecycle writers (Section 1126.3) and default `GET /api/users` filter (Section 1126.4-API/UI).
- Users Roster Trust (Section 1400) and Customers Tab Trust (Section 1300).
- Top Opportunities (Section 1140).
- NBA, dashboards, leaderboards, goals, RFP scheduler, agentic tools — all keep the legacy `getVisibleCompanyIds(user)` no-arg call.
- Stripe / Webex / M365 seat counts and RBAC role tables.

## Why opt-in (not a new endpoint)

A dedicated `GET /api/companies/unrouted` would duplicate the `ownerUserId` / `ownerName` enrichment, the cache layer, the `X-Customers-Hidden-Count` header, and the `includeArchived` filter. A new option threaded through the existing helper keeps a single source of truth for the company list while gating the visibility widening to one explicit caller.

## Pinned by

`tests/code-quality-guardrails.test.ts` Section 1600.
