# Fixture User Cleanup — Contract

> **Purpose.** Lock in the first reversible step of the Fixture User
> Cleanup program (Task #1179 / FUC-P1-S1, 2026-05-18). Future steps
> grow this document with FUC-2, FUC-3 … as more operational surfaces
> opt in to the shared predicate.

## Canonical predicate

`server/lib/fixtureUsers.ts` exports a single helper, `isFixtureUser(u)`,
that returns `true` when any of the following are true:

- The user carries a Task #1126 Phase 1 lifecycle flag indicating
  non-operational status: `isFixture === true`, `isDemo === true`,
  `isQuarantined === true`, `isServiceAccount === true`,
  `isActive === false`, or `deletedAt != null`.
- The user's `username` matches an `@example.com` / `.test` / `.invalid`
  / `.localhost` / `.example` family suffix from
  `FIXTURE_MAILBOX_DOMAINS` in `server/lib/fixtureMailboxes.ts` (via
  `isFixtureMailboxAddress`).
- The user's `username` ends with a junk-domain suffix from
  `JUNK_DOMAIN_SUFFIXES` in `server/lib/userRosterClassification.ts`.
- The user's `username` or `name` matches a seed-script pattern from
  `SEED_NAME_PATTERNS` in `server/lib/userRosterClassification.ts`
  (e.g. `^wq\.test\.`, `^seed[._-]`, `^demo[._-]`, `^fixture[._-]`).

## Composition rule

The helper **composes**, never duplicates, the two pre-existing
pattern sources:

- `server/lib/fixtureMailboxes.ts` — `FIXTURE_MAILBOX_DOMAINS` /
  `isFixtureMailboxAddress` — also used by the write-time
  `assertNotFixtureEmail` boundary guard on `storage.createUser` and
  by the read-time junk filter in `storage.getUsers` (Users Roster
  Trust contract, UR-5).
- `server/lib/userRosterClassification.ts` — `JUNK_DOMAIN_SUFFIXES` /
  `SEED_NAME_PATTERNS` — also used by the Phase 0 read-only roster
  health classifier.

If a new pattern must be added, extend the upstream source list; do
**not** fork a parallel list inside `fixtureUsers.ts`.

## Production callsites (one, today)

`isFixtureUser` is imported in exactly **one** production file:

- `server/routes/dashboard.ts` — `GET /api/dashboard/margin-metrics`
  filters the AM-role user list through the predicate immediately
  after role + scope filtering and before margin mapping.

Section 1500 of `tests/code-quality-guardrails.test.ts` enforces this
no-widening rule. Adding a second callsite requires:

1. Updating Section 1500's allowlist.
2. Updating this document with the new surface + rationale.
3. Confirming the new surface is **operational** (not historical
   attribution — see "Out of scope" below).

## Out of scope (do NOT widen here)

These surfaces deliberately keep the legacy "every user" view. They
rely on historical attribution and / or have their own dedicated
contracts; the helper **must not** be wired into any of them as a
side effect of unrelated work:

- `server/services/customerQuotes.ts` — Customer Quotes Stability
  Contract (`docs/customer-quotes-stability-contract.md`,
  Section 1100). CQ chokepoints stay on the no-opts
  `storage.getUsers(orgId)` overload.
- `freight_daily_upload_fact` writers — Section 1051.
- Email ingestion (`processUserMailboxEmail`,
  `accountContactCaptureService`, `signatureContactSweep`) —
  Sections 1094 / 1095 + the `CONTACT_JOBS_ENABLED` kill switch.
- `contacts` reads / writes — Sections 1093 / 1200 (soft-delete only).
- User lifecycle write paths (`POST /api/admin/users/:id/{classify,
  deactivate, reactivate, soft-delete, restore}`) — Section 1126.3.
- Default `GET /api/users` lifecycle filter — Section 1126.4-API /
  Users Roster Trust contract (UR-1..UR-5).
- `/api/users/sales`, `/api/users/search`, `POST /api/users`,
  `PATCH /api/users/:id`, `DELETE /api/users/:id`.
- `GET /api/dashboard/am-comparison` and the rest of the NAM
  portlets.
- Goals leaderboard (`GET /api/goals/leaderboard`).
- Top Opportunities (Section 1140) — historical dismiss attribution
  needs the cleaned-roster fallback to "Unknown user".
- NBA engine, RFP scheduler, agent tools.
- `server/auth.ts` and login / session resolution.
- Webex / Microsoft Graph / Stripe seat counts.
- Contact jobs.

## Constraints

- **Zero writes.** The helper is pure; no `db.update`, `db.insert`,
  or `db.delete` anywhere.
- **No schema changes.** Composes existing columns + pattern sources.
- **No-arg `storage.getUsers(orgId)` overload is unchanged** —
  Subtask B / Users Roster Trust UR-2 invariant.

## Runtime + static enforcement

- `tests/fixture-users-helper.test.ts` — unit coverage for the
  helper (positive: `WQTest 73cb0c`, `wq.test.x@example.com`,
  `coe.test.y@example.com`, `is_fixture=true`, `is_demo=true`,
  `is_quarantined=true`, `is_service_account=true`, soft-deleted,
  `is_active=false`; negative: `@valuetruck.com` AM,
  `@coyote.com`-style AM).
- `tests/code-quality-guardrails.test.ts` Section 1500 — static
  asserts on the helper's composition + the single production
  callsite + the no-widening rule + the unchanged no-arg
  `storage.getUsers` overload signature.

## Rollback

Revert the `server/routes/dashboard.ts` import + filter call to
restore the original AM list. `server/lib/fixtureUsers.ts` and its
tests can stay dormant (or be deleted); either way the portlet
returns to pre-change behavior with no schema or data implications.
