# Customers & Quotes Guardrail Hardening (2026‑05‑15)

> **Purpose.** Lock in the four guardrail-regex updates shipped in the
> Customers & Quotes Guardrail Hardening program (2026‑05‑15). This
> file is **a "don't break this" contract**, not background reading.
> Future work should reference each fix by ID before changing the
> listed files, and any deviation requires updating both this document
> and Section 1450 of `tests/code-quality-guardrails.test.ts` in the
> same commit.
>
> **Scope rule.** This program is **hardening‑only** — zero production
> code changed. The four failing guardrail assertions in
> `tests/code-quality-guardrails.test.ts` were stale regexes written
> before legitimate refactors hardened the underlying code. The
> current production code is the new canonical state; this program
> updates the regexes to match while preserving (and in two cases
> *strengthening*) the contracts.
>
> **Non‑surfaces** are listed at the bottom — none of those files were
> touched and none can be touched as part of any future revision to
> this contract without first updating its own contract.

---

## How to use this document

1. Before editing any of the four protected sites listed under
   **Source of truth**, find the matching fix below and read its
   **Must / Must NOT** rules.
2. If a change is unavoidable, update **both** this document and
   Section 1450 of `tests/code-quality-guardrails.test.ts` in the same
   commit.
3. The four older assertions in Sections 1142 / 1143 are deliberately
   relaxed to accept the canonical shapes — Section 1450 is the
   **binding** cross-file contract. Tightening 1142 / 1143 back to
   their original literal regexes is the regression we are protecting
   against.

---

## Audit — the four originally‑failing assertions

| ID | Failing assert | Section | Gap | Fix |
|---|---|---|---|---|
| H‑1 | `routes/customerQuotes.ts — PATCH response surfaces _handoff alongside the quote detail` | 1142 | Regex demanded `{ ...detail, _handoff: handoff }`; current code is `{ ...detail, handoff, _handoff: handoff }` (Task #1153 added the canonical `handoff` field). | Update regex to accept the dual-key shape. **Section 1153 already pins each key independently** — net contract effect: zero. |
| H‑2 | `server/auth.ts — getVisibleCompanyIds uses the canonical owner-coalesce` | 1143 | Regex demanded the literal coalesce inlined; current code calls `getCanonicalCompanyOwnerId(c)` from `server/lib/companyOwner.ts`. | Accept either inline literal **OR** helper call. Pin the helper's literal contents (Section 1450). |
| H‑3 | `client/src/pages/customers.tsx — uses the canonical owner-coalesce in BOTH applyFilters and OwnerLabel` | 1143 | Regex demanded exactly 2 inline coalesces; 2 of 3 sites now have an `(company as any).ownerUserId ??` prefix (server-attached precomputed owner). | Allow optional `ownerUserId` prefix; expect ≥2. |
| H‑4 | `customers.tsx — amUsers useMemo resolved` | 1143 | Outer regex demanded deps `[teamMembers]`; current deps are `[teamMembers, showAdminOwned]` (Task #1141 admin-owned toggle). | Allow extra deps; inner asserts (`role !== "admin"`, `isActive !== false`) unchanged. |

---

## H‑1 — Customer-quotes PATCH response carries BOTH `handoff` and `_handoff`

**Problem we fixed.** Section 1142 (originally one of the markWon
toast asserts) shipped before Task #1153 added the canonical
`handoff` field. The route code evolved to `{ ...detail, handoff,
_handoff: handoff }` and Section 1153 began pinning each key with
stricter, more explicit asserts — but Section 1142's older regex was
never updated and started rejecting the canonical state.

**Contract.**
- The PATCH `/api/customer-quotes/quote/:id` response body MUST be
  `res.json({ ...detail, handoff, _handoff: handoff })`.
- The canonical client reader is `resolveMarkWonHandoff` in
  `client/src/lib/customerQuotes.ts`, which prefers `r.handoff` and
  falls back to `r._handoff` (Section 1153 binds this precedence —
  reversing it breaks both new-server-old-client AND new-server-new-
  client, exactly the alias-drift regression Section 1153 protects
  against).
- The `_handoff` alias is a **one-release** compatibility shim — it
  exists so an old client paired with a new server still gets the
  Won-toast branching. Removing it before old clients are upgraded
  silently degrades the toast to "Quote updated".

**Source of truth.**
- `server/routes/customerQuotes.ts` — `res.json({ ...detail, handoff,
  _handoff: handoff })` (~L985), with the Task #1153 comment block
  immediately above it (~L979‑L984).
- `client/src/lib/customerQuotes.ts` — `resolveMarkWonHandoff`.

**Must / Must NOT.**
- **Must** keep both keys present until the one-release compatibility
  window for `_handoff` is closed. Closing the window requires
  removing **both** Section 1142's regex AND Section 1153's `_handoff`
  assertion in the same commit, plus a new client-version-floor check.
- **Must NOT** add a third key to the spread in a position that
  changes the relative order of `handoff` and `_handoff` — Section
  1142's regex is positional.
- **Must NOT** drop the `handoff` field while keeping `_handoff` —
  that reverses the canonical/alias relationship `resolveMarkWon
  Handoff` enforces.

---

## H‑2 — `server/auth.ts` delegates owner resolution to the canonical helper

**Problem we fixed.** Section 1143 originally demanded that the
canonical owner-coalesce literal `c.ownerRepId ?? c.assignedTo ?? (c
as any).salesPersonId ?? null` appear inline inside
`getVisibleCompanyIds`. A subsequent refactor (the right move) pulled
the chain into a shared helper `getCanonicalCompanyOwnerId` in
`server/lib/companyOwner.ts` so auth.ts and route payloads could
consume one rule. The helper docstring explicitly references this
section.

**Contract.**
- `server/auth.ts` MUST import `getCanonicalCompanyOwnerId` from
  `./lib/companyOwner` and call it from `getVisibleCompanyIds` (the
  current canonical state).
- An inline literal coalesce inside `getVisibleCompanyIds` is **also**
  acceptable as a future rollback path — Section 1143's relaxed
  assert accepts both shapes. The binding cross-file contract lives
  in Section 1450.
- `server/lib/companyOwner.ts` is the **single source of truth** for
  the precedence `ownerRepId → assignedTo → salesPersonId → null`.
  Reordering or dropping a column in the helper forks every
  downstream visibility / label rule.

**Source of truth.**
- `server/lib/companyOwner.ts` — the canonical helper export
  (~L17‑L22) and the docstring referencing this section.
- `server/auth.ts` — the import (~L12 region) and `getVisible
  CompanyIds`'s `ownerOf = (c) => getCanonicalCompanyOwnerId(c)`
  delegate (~L520).

**Must / Must NOT.**
- **Must NOT** add a divergent owner-coalesce anywhere else in the
  codebase. Every read-side coalesce must call the helper.
- **Must NOT** silently rename or move `getCanonicalCompanyOwnerId`
  without updating Section 1450 + this contract.
- **Must NOT** widen the helper's parameter type to skip a column
  (e.g. drop `salesPersonId` from the `Pick<…>`); the third column is
  nearly empty in prod but is the historical fall-through that some
  legacy seed orgs still depend on.

---

## H‑3 — `client/src/pages/customers.tsx` prefers server-attached `ownerUserId` then the canonical chain

**Problem we fixed.** Section 1143 originally demanded exactly 2
inline coalesces (one in `applyFilters`, one in the `OwnerLabel`
parent). The server now attaches a precomputed `ownerUserId` to the
`/api/companies` payload (resolved against the FULL users list
including soft-deleted historical owners). The client prefers the
server-attached value when present and falls through to the canonical
chain when absent — strictly safer than the bare client-side
coalesce, because the bare chain can't resolve owners that have been
soft-deleted from the active roster.

**Contract.**
- The 2 sites (`applyFilters` ~L504‑L508, `OwnerLabel` parent
  ~L918‑L922) MUST use the prefixed shape:
  ```ts
  (company as any).ownerUserId
    ?? company.ownerRepId
    ?? company.assignedTo
    ?? (company as any).salesPersonId
    ?? null
  ```
- The hidden-count `useMemo` at ~L556 retains the bare chain — that
  count is a UX hint, not the visibility gate, and the bare chain is
  cheap and adequate there.
- `customers.tsx` MUST continue to fall through to the canonical
  chain when `ownerUserId` is null/undefined (older cached payloads
  may not have it attached).

**Source of truth.**
- `client/src/pages/customers.tsx` — the three coalesce sites
  (`applyFilters` ~L504, hidden-count `useMemo` ~L556, `OwnerLabel`
  parent ~L918).

**Must / Must NOT.**
- **Must NOT** drop the `ownerUserId` prefix from the two prefixed
  sites — soft-deleted historical owners stop resolving to the right
  attribution.
- **Must NOT** add the prefix to the hidden-count `useMemo` — that's
  fine to leave on the bare chain (it's not a visibility gate).
- **Must NOT** reorder `ownerRepId / assignedTo / salesPersonId` — the
  precedence is the canonical contract pinned in Section 1450.

---

## H‑4 — `amUsers` picker drops admins (default) and deactivated reps

**Problem we fixed.** Section 1143's outer `amUsersRx` demanded a
deps array of exactly `[teamMembers]`. Task #1141 added the
leadership "Show Admin-Owned" toggle, which legitimately requires
`showAdminOwned` in the deps array — without it, the picker goes
stale when leadership flips the toggle.

**Contract.**
- The `amUsers` `useMemo` MUST live on `teamMembers` plus zero or
  more extra deps (e.g. `showAdminOwned`).
- The picker MUST exclude admins by default (`u.role !== "admin"`
  appears verbatim in the predicate); the leadership `showAdminOwned`
  toggle is allowed to widen the predicate (`u.role !== "admin" ||
  showAdminOwned`).
- The picker MUST exclude deactivated reps (`u.isActive !== false`
  appears verbatim) even though they remain in `accountOwnerMap` for
  historical-owner label resolution.

**Source of truth.**
- `client/src/pages/customers.tsx` — `amUsers` `useMemo` ~L470‑L474.

**Must / Must NOT.**
- **Must NOT** drop `u.isActive !== false` — deactivated reps would
  reappear in the picker and silently re-leak the bucket Section 1126
  closed.
- **Must NOT** invert the default to admins-in-by-default. The
  leadership toggle is opt-in; reversing the default re-introduces
  the same "admins as assignable owners" trust regression.

---

## Non‑surfaces (out of scope — do NOT regress here)

These files / surfaces are **not** governed by this contract. They
have their own contracts; touching them as part of any CQ Guardrail
Hardening work requires the matching declaration on those contracts:

- `server/services/customerQuotes.ts` — Customer Quotes Stability
  Contract (`docs/customer-quotes-stability-contract.md`,
  Section 1100). This program did NOT touch any of the CQ
  chokepoints (`applyFilters`, `loadContext`, `enrich`,
  `attachResponseTimes`, the `__none__` resolver, the won-quote AF
  handoff classifier). Section 1153 pins the handoff payload
  contract; this program updated only the older Section 1142 regex
  that matched the same code less precisely.
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
- Default `GET /api/users` lifecycle filter — Section 1126.4‑API.
- User Management lifecycle tabs strip — Section 1126.4‑UI.
- Users Roster Trust contract (`includeJunkSuspects` opt-in) —
  Section 1400 / `docs/users-roster-trust-contract.md`.
- Customers Tab Trust contract (`customersOnly` opt-in) — Section
  1300 / `docs/customers-tab-trust-contract.md`.
- Top Opportunities — Section 1140.
- `server/auth.ts` business logic — only the Section 1143 / 1450
  guardrails were updated to recognize the helper refactor; auth
  semantics (manager / sales / sales_director / logistics_manager
  visibility branches, `isSharedRep`, collaborator unioning) were
  NOT touched.
- Schema, RBAC role tables, Stripe / Webex / M365 seat counts.

---

## Runtime tests pinning this contract

- `tests/code-quality-guardrails.test.ts` — the binding asserts:
  - **Section 1142** (relaxed) — PATCH response dual-key shape.
  - **Section 1143** (relaxed) — auth.ts inline-literal-OR-helper,
    customers.tsx ≥2 prefix-optional coalesces, amUsers useMemo with
    extra-dep tolerance, plus the in-section
    `server/lib/companyOwner.ts` literal-contents pin.
  - **Section 1153** (binding for handoff payload) — separately pins
    each of `handoff` and `_handoff: handoff` with stricter
    assertions; Section 1142 is now a less-precise duplicate kept
    only because removing it would lose its surrounding context for
    the markWon toast asserts.
  - **Section 1450** (this program's binding contract) — 13 positive
    asserts: helper export + literal contents, auth.ts import +
    helper-call, dual-key handoff response, `ownerUserId`-prefixed
    customers chain + canonical fall-through, amUsers admin/inactive
    exclusion, this docs file + the replit.md Gotcha existence pins.

No new runtime test was added. The four originally-failing assertions
were *already* runtime tests in spirit — pinning the canonical state
of files that ship today. Section 1450 is the cross-file binding
contract; the older Sections 1142/1143 remain as relaxed compatibility
checks so future contributors can find the historical context.

---

## Future work pointer

Two natural follow-ups (not in scope for this program):

1. **Close the `_handoff` compatibility window.** Once the client
   release floor crosses the Task #1153 cut, remove `_handoff` from
   the PATCH response, drop Section 1153's `_handoff` assert, and
   remove Section 1142's PATCH-shape regex entirely (its surrounding
   context for the markWon toast asserts can be retained via Section
   1153 alone). This contract document gains a "compat-window
   closed" note.

2. **Migrate the Customers `applyFilters` hidden-count `useMemo` to
   the prefixed shape.** Today it intentionally uses the bare chain
   because it's a UX hint, not a visibility gate. If the server's
   `ownerUserId` attachment becomes universally trustworthy (no older
   cached payloads in flight), the hidden-count can adopt the prefix
   too — at which point Section 1143's `customersMatches >= 2` could
   be tightened to `=== 3`. Until then, the current contract is the
   entire contract.
