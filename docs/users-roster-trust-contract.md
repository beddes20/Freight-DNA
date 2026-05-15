# Users Roster — Trust Contract

> **Purpose.** Lock in the production behavior shipped in Users Trust
> Cleanup Subtask B (2026‑05‑15). This file is **a "don't break this"
> contract**, not background reading. Future work should reference each
> contract by ID before changing the listed files, and any deviation
> requires updating both this document and Section 1400 of
> `tests/code-quality-guardrails.test.ts` in the same commit.
>
> **Scope rule.** This contract covers **only** the read / display /
> filter layer for the `/admin/users` roster and the shared
> `GET /api/users` route. It deliberately does **not** reopen Customer
> Quotes, the `freight_daily_upload_fact` writers, the inbound-email
> pipeline (`processUserMailboxEmail`), contacts soft-delete plumbing,
> the user lifecycle write paths (Section 1126.3), `server/auth.ts`,
> `DELETE /api/users/:id`, RBAC role tables, or seat-counting
> integrations (Stripe / Webex / M365). Those remain governed by their
> own contracts and are listed as **Non‑surfaces** below.
>
> **Companion docs.**
> - `docs/users-bucket-audit-2026-05-15.md` — the per‑org audit
>   (192 users across 18 orgs → 138 leakage rows; Value Truck
>   107/160 = `wq.test.*@example.com` / `coe.test.*@example.com`)
>   that motivated Subtask B.
> - `replit.md` Gotcha "Users Roster Trust (Subtask B, 2026‑05‑15)" —
>   the prompt-time pin of the same invariants.

---

## How to use this document

1. Before editing any file listed under **Source of truth**, find the
   matching contract below and read its **Must / Must NOT** rules.
2. If a change is unavoidable, update **both** this document and
   Section 1400 of `tests/code-quality-guardrails.test.ts` in the same
   commit.
3. If a contract here conflicts with a new product requirement, **don't
   silently rewrite the contract**. Open a follow‑up task that names
   the contract ID (e.g. "Modify UR‑2") and document the rationale.

---

## UR‑1 — Default `GET /api/users` hides junk‑pattern usernames

**Problem we fixed.** Pre‑Subtask B, the `/admin/users` default roster
returned 160 rows for Value Truck, of which 107 (~67%) were
`wq.test.*@example.com` / `coe.test.*@example.com` seed‑script
identities with zero activity and never‑logged‑in. Reps could not
trust the list — even role=admin rows were synthetic `WQTest XXXXXX`
fixtures.

**Contract.**
- The junk‑pattern exclusion is implemented as a single optional
  predicate inside `storage.getUsers(orgId, filter?: UserListFilter)`,
  applied **only** when `filter` is provided AND
  `filter.includeJunkSuspects !== true`.
- The predicate is `NOT (LOWER(username) LIKE <p>)` for every `<p>` in
  `FIXTURE_MAILBOX_LIKE_PATTERNS` (`@example.com` / `.org` / `.net` +
  RFC 6761 reserved TLDs `@invalid` / `.invalid` / `@localhost` /
  `.localhost` / `@test` / `.test` / `@example` / `.example` /
  `@test.local` / `@local.test`).
- `client/src/pages/admin-users.tsx` continues to use the default
  filter (no flags) for the "Active" lifecycle tab. The new admin‑only
  "Junk suspects" tab maps to `?includeJunkSuspects=true`.

**Source of truth.**
- `server/storage.ts` — `UserListFilter` interface (~L508), `getUsers`
  filter‑overload impl (~L2078‑L2090), `FIXTURE_MAILBOX_LIKE_PATTERNS`
  import (~L8).
- `server/lib/fixtureMailboxes.ts` — the canonical pattern list shared
  with `assertNotFixtureEmail`.
- `client/src/pages/admin-users.tsx` — `LIFECYCLE_TABS` (~L1514),
  `buildUsersUrlForLifecycle` (~L1523), `useQuery` with custom
  `queryFn` (~L1564‑L1573), badge JSX (~L1752‑L1759).

**Must NOT.**
- Inline a raw `LIKE '%@example.com'` literal anywhere inside
  `getUsers` — Section 1400 rejects exactly that. Drive every junk
  literal off `FIXTURE_MAILBOX_LIKE_PATTERNS` so the read‑time view
  and the write‑time `assertNotFixtureEmail` boundary guard cannot
  drift (UR‑5).
- Apply the exclusion to the no‑opts overload (UR‑2).
- Move the predicate into a chokepoint that runs even when the filter
  is absent (e.g. unconditionally inside `getUsers`, inside
  `auth.ts` resolution, inside `getUserById`).

---

## UR‑2 — No‑opts `storage.getUsers(orgId)` overload is preserved

**Problem we fixed.** Internal scoping callers (Customer Quotes,
financial‑uploads org‑rep resolution, leaderboards, Top
Opportunities, dashboards, NBA, RFP scheduler, agent tools) read
`storage.getUsers(orgId)` to enumerate every historical author /
owner. Silently filtering junk rows here would have lost
attribution for any historical row authored by a now‑classified‑junk
user — the same trust regression the program is closing, but
inverted.

**Contract.**
- The bare `storage.getUsers(orgId)` overload is **unchanged** by
  Subtask B. It returns every row in the org, including rows the
  filter overload would hide (junk‑pattern, inactive, deleted,
  service, quarantined, demo, **and** fixture).
- Subtask B's exclusion lives **only** in the
  `storage.getUsers(orgId, filter)` branch.

**Source of truth.**
- `server/storage.ts` — both `getUsers` overloads.

**Must NOT.**
- Add the junk‑pattern exclusion to the no‑opts overload — historical
  attribution depends on the legacy "every user" view.
- Migrate any internal caller (CQ, financial uploads, leaderboards,
  Top Opps, dashboards, NBA) from the no‑opts overload to the filter
  overload as a side effect of unrelated work. Each such migration
  needs its own approval and contract update because the cleaned view
  loses attribution.

---

## UR‑3 — Admin override is opt‑in, never 403, and silently dropped for non‑admins

**Problem we fixed.** Section 1126.4‑API (Step 4a) established the
"silent‑drop" pattern for admin‑gated `include*` flags so shared
client code can keep passing speculative flags without breaking on
non‑admin sessions. UR‑3 mirrors that pattern verbatim — `?include
JunkSuspects=true` is admin‑only, but a non‑admin caller never sees a
403; the flag is dropped and a single debug log line is emitted.

**Contract.**
- `GET /api/users` reads `req.query.includeJunkSuspects === "true"`
  into the `requested` block.
- The admin gate is `callerIsAdmin && requested.includeJunkSuspects`,
  identical to the four Section 1126.4 sensitive flags
  (`includeDeleted` / `includeServiceAccounts` /
  `includeQuarantined` / `includeDemo`).
- When the exclusion is in effect (`!filter.includeJunkSuspects`),
  the route emits `X-Users-Junk-Hidden-Count: <N>`, computed via a
  second `storage.getUsers(orgId, { …filter, includeJunkSuspects:
  true })` call so the count is parity‑scoped to whatever lifecycle
  tab the admin is currently on.
- `client/src/pages/admin-users.tsx` reads the header into
  `hiddenJunkCount` state and renders an amber badge inside
  `data-testid="text-junk-suspects-hidden-count"` on the "Junk
  suspects" tab label whenever the count is > 0 and the active tab is
  not already `junk_suspects`.

**Source of truth.**
- `server/routes.ts` — `GET /api/users` handler (~L780‑L850).
- `client/src/pages/admin-users.tsx` — custom `queryFn` capturing the
  header (~L1564‑L1573) and badge JSX (~L1752‑L1759).

**Must NOT.**
- 403 a non‑admin who passes `includeJunkSuspects=true`. Silent‑drop
  is the contract — shared client code passes flags speculatively.
- Compute the disclosure count from a different cohort (e.g. ignoring
  the lifecycle filter); the count must match what the admin would
  see by clicking the "Junk suspects" tab from their current tab.
- Remove the `try { … } catch {}` guard around the second `getUsers`
  call. The header is non‑essential disclosure; a header lookup must
  never break the route.

---

## UR‑4 — Customer Quotes / historical attribution surfaces must NOT use `includeJunkSuspects`

**Problem we fixed.** CQ‑2 / CQ‑5 (Customer Quotes Stability
Contract, Section 1100) require that the customer‑quotes service
joins users by id without any `includeJunkSuspects`‑style narrowing.
Other historical attribution surfaces (notes authorship, touchpoint
authorship, activity feeds, Top Opportunities dismiss attribution
under Section 1140) have the same property — a soft‑junk‑flagged
user who authored historical content still needs their attribution
resolved.

**Contract.**
- `server/services/customerQuotes.ts` **must not** reference
  `includeJunkSuspects` anywhere. It reads `storage.getUsers(orgId)`
  via the no‑opts overload exclusively.
- The historical‑attribution surfaces (notes, touchpoints, activity
  feeds, Section 1140 dismiss attribution) inherit the no‑opts
  overload and therefore do not need to be modified by Subtask B.

**Source of truth.**
- `server/services/customerQuotes.ts` — every `getUsers(` call.

**Must NOT.**
- Pass `includeJunkSuspects` (true *or* false) from the CQ service.
- Migrate any historical‑attribution surface to the filter overload
  without an explicit cross‑contract review (UR‑2 + the CQ stability
  contract + Section 1140).

---

## UR‑5 — Junk‑pattern list comes from one shared constant

**Problem we fixed.** A duplicated literal list ("the read‑time
filter says `@example.com` / `@test` / …; the write‑time guard says
the same thing") is a silent drift hazard — adding a new RFC reserved
TLD to one and not the other would let writes through that the read
view hides (or vice versa).

**Contract.**
- Both the read‑time predicate (`storage.getUsers` filter overload)
  and the write‑time boundary guard (`assertNotFixtureEmail` called
  from `storage.createUser`) source their pattern list from
  `FIXTURE_MAILBOX_LIKE_PATTERNS` / `FIXTURE_MAILBOX_DOMAINS` in
  `server/lib/fixtureMailboxes.ts`.
- `getUsers` builds its `LIKE` clauses by mapping over
  `FIXTURE_MAILBOX_LIKE_PATTERNS`. No raw `'%@example.com'` literal
  appears anywhere inside the `getUsers` impl.

**Source of truth.**
- `server/lib/fixtureMailboxes.ts` — the canonical lists.
- `server/storage.ts` — `import { … FIXTURE_MAILBOX_LIKE_PATTERNS }`
  + the `.map(p => sql\`${lowered} LIKE ${p}\`)` builder.

**Must NOT.**
- Inline a raw `'%@example.com'` (or any other suffix literal) inside
  `getUsers`. Section 1400 asserts the absence of that exact
  pattern.
- Fork the list (e.g. add a new "junk‑classifier" constant elsewhere
  in `server/lib/`). Extend `FIXTURE_MAILBOX_LIKE_PATTERNS` itself if
  the boundary guard agrees.

---

## Non‑surfaces (out of scope — do NOT regress here)

These files / surfaces are **not** governed by this contract. They
have their own contracts; touching them as part of any Users Roster
work requires the matching declaration on those contracts:

- `server/services/customerQuotes.ts` — Customer Quotes Stability
  Contract (`docs/customer-quotes-stability-contract.md`,
  Section 1100).
- `freight_daily_upload_fact` writers anywhere under
  `server/services/` / `server/routes/financials.ts` — Section 1051.
- `server/services/processUserMailboxEmail` and adjacent
  inbound‑email helpers (`server/accountContactCaptureService.ts`,
  `server/services/signatureContactSweep.ts`) — Section 1094 (the
  `CONTACT_JOBS_ENABLED` kill switch) and Section 1095 (email‑derived
  companies flag).
- `contacts` reads / writes — Section 1200 (soft‑delete only) and
  Section 1093 (the contacts‑soft‑delete migration).
- User lifecycle write paths (`POST /api/admin/users/:id/{classify,
  deactivate, reactivate, soft-delete, restore}`) — Section 1126.3.
- Default `GET /api/users` lifecycle filter (the four sensitive
  flags + `includeInactive` semantics) — Section 1126.4‑API.
- User Management lifecycle tabs strip — Section 1126.4‑UI.
- `server/auth.ts` / login / session resolution — none of these
  consume the new filter; they read `storage.getUsers(orgId)` via the
  no‑opts overload.
- `DELETE /api/users/:id`, `PATCH /api/users/:id`, `POST /api/users`,
  `/api/users/sales`, `/api/users/search` — none consume
  `includeJunkSuspects`.
- Top Opportunities surfaces — Section 1140 (freight‑data freshness
  pill states + manager‑only dismiss attribution).
- Customers tab trust contract — Section 1300.
- Stripe / Webex / Microsoft Graph seat counts — none consume the
  new filter.

---

## Runtime tests pinning this contract

- `tests/users-roster-trust-contract.test.ts` — 6 cases / 12
  assertions against a sandboxed org: UR‑1 (`@example.com` excluded
  from default), UR‑2 (`wq.test.*@example.com` excluded from default),
  UR‑3 (`@valuetruck.com` included in default), UR‑4
  (`includeJunkSuspects:true` returns all three real + junk),
  UR‑5 (no‑opts overload returns all four including the
  `is_fixture=true` row), UR‑6 (`is_fixture=true` excluded under
  every combo — Section 1126 invariant).
- `tests/code-quality-guardrails.test.ts` Section 1400 — static
  asserts on the `UserListFilter` declaration, the `getUsers` branch,
  the shared‑constant import, the absence of inlined literals, the
  route's read / admin‑gate / forward / header emission, the admin
  UI's tab + URL mapping + badge, the CQ‑untouched guarantee, and
  the existence of this document + the matching `replit.md` Gotcha
  entry + the runtime contract test.

---

## Future work pointer

The audit (`docs/users-bucket-audit-2026-05-15.md`) classifies
defaults‑visible users into six buckets (`real_active`,
`real_inactive`, `uncertain`, `likely_junk`, `likely_demo_fixture`,
`likely_service_shared_inbox`). Subtask B addresses **only** the
`likely_junk` cohort that ships with a fixture‑mailbox suffix —
the conservative subset where false positives are essentially
impossible. The remaining buckets (the 35 `uncertain`
`@valuetruck.com` employees with no login / no activity, the 45
`likely_demo_fixture` rows in Demo / Fixture Guard / Hero Loop test
orgs, the 0 `likely_service_shared_inbox` rows today) are left for
a separate classification program. When that program is approved for
implementation, this document will grow new contracts (UR‑6+) to pin
the new invariants. Until then, the current contract is the entire
contract.
