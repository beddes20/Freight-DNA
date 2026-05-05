# Customer Quotes & Account Ownership — Stability Contract

> **Purpose.** Lock in the production fixes shipped over the last several days
> in Customer Quotes, Account Ownership, and adjacent queue logic. This file
> is **a "don't break this" contract**, not background reading. Future work
> should reference each contract by ID before changing the listed files, and
> any deviation requires explicitly updating both this document and the
> matching guardrails in `tests/code-quality-guardrails.test.ts` (Section
> 1100).
>
> **Scope rule.** This contract only covers the **read / display / filter**
> layer for Customer Quotes and Account Ownership. It deliberately does **not**
> reopen the email-ingestion plumbing, the classifier, `routing_status`
> writers, the webhook path, or anything in `server/routes/graphWebhook.ts` /
> `server/services/emailClassifier*`. Treat those as out of scope here even
> when a contract reads from them.

---

## How to use this document

1. Before editing any file listed under **Source of truth**, find the matching
   contract below and read its **Must / Must not** rules.
2. If a change is unavoidable, update **both** this document and Section 1100
   of `tests/code-quality-guardrails.test.ts` in the same commit. The
   guardrail names are intentionally verbose so they show up in failure logs.
3. If a contract here conflicts with a new product requirement, **don't
   silently rewrite the contract**. Open a follow-up task that names the
   contract ID (e.g. "Modify CQ-2") and document the rationale.

---

## CQ-1 — "Mine Only" never silently lies

**Problem we fixed.** Reps mapped to no `QuoteRep` row used to see a generic
"No matches" empty state when they switched to Mine Only — indistinguishable
from "you have zero quotes today". This hid a configuration bug.

**Contract.**
- The service helper that resolves the rep scope returns the **`__none__`**
  sentinel (literal string) when the current user is a customer-facing role
  but has no `QuoteRep` mapping.
- `getActionQueue`, `getSnapshot`, and `getFunnel` in
  `server/services/customerQuotes.ts` **must** short-circuit on `__none__`
  and return an empty-but-valid shell (not a 403, not a generic empty page).
- Endpoints / clients **must** surface the unconfigured-rep condition
  honestly (the Quote Requests UI uses the `EmptyState` component with a
  dedicated test id; see `client/src/pages/quote-requests.tsx`).

**Source of truth.**
- `server/services/customerQuotes.ts` — `__none__` sentinel emission
  (~line 4894–4908) and short-circuits at the three callers
  (~lines 4945–4947, 5257–5263, 5995).
- Tests: `tests/customer-quotes-trust-hardening.test.ts`,
  `client/src/lib/__tests__/quoteRequestsHonestZeroState.test.ts`.

**Must NOT.**
- Replace the `__none__` short-circuit with a thrown error or 403.
- Hand-roll a `<div>No matches</div>` empty state in Quote Requests instead
  of the shared `EmptyState` component.
- Auto-fall-back to "show org-wide quotes" when the current user has no
  rep mapping — that hides the bug we just fixed.

---

## CQ-2 — Customer Quotes main queue is customer-only (single chokepoint)

**Problem we fixed.** Carrier-side rows (`auto_carrier`) and unclassified rows
(`needs_routing`) used to leak into the main Quote Opportunities feed, KPIs,
funnel, and CSV export, polluting rep-facing surfaces.

**Contract.**
- `applyFilters(rows, f, nonCustomerCustomerIds?, customerFacingRepIds?)` in
  `server/services/customerQuotes.ts` (line ~585) is the **single chokepoint**
  for all rep-facing reads. It drops:
  1. Customers whose `partyType !== "customer"` (via `nonCustomerCustomerIds`).
  2. Rows whose `routingStatus === "auto_carrier" || "needs_routing"`
     (line ~611, **unconditional** — no flag, no caller opt-out).
  3. Rows whose `repId` is non-null and not in `customerFacingRepIds`
     (line ~617, only when the set is provided; **null `repId` always falls
     through** so the Account Owner fallback in CQ-3 still resolves).
- Every rep-facing reader (`listQuotes`, `getSnapshot`, `getFunnel`,
  `exportCsv`) **must** call `applyFilters` and **must** pass both
  `nonCustomerIds` and `customerFacingRepIds`.
- The **Needs Routing** surface uses a dedicated path
  (`routing_status = 'needs_routing'` direct query) that intentionally
  re-includes the rows CQ-2 drops. That path is independent — do not collapse
  it into `applyFilters`.

**Source of truth.**
- `server/services/customerQuotes.ts:585–629` (chokepoint definition).
- `server/services/customerQuotes.ts:1308–1322` (`listQuotes` callsite).
- Tests: `tests/customer-quotes-customer-only-filter.test.ts` (15 assertions).

**Must NOT.**
- Add a new `routingStatus` value (e.g. `carrier_confirmed`) without adding
  it to the drop list at line ~611.
- Wrap `applyFilters` in a "raw" helper that bypasses the routing-status gate
  for "performance" or "edge case" reasons.
- Broaden the customer-only main queue by passing a partial argument set
  (e.g. omitting `customerFacingRepIds`) from a rep-facing reader.

**Intentional exceptions (do not "fix").**
- `getFunnelDiagnostics` (line ~5289) calls `applyFilters` **without**
  `customerFacingRepIds` on purpose: the Leakage / audit screen needs to see
  rows that the main queue hides so ops can detect mis-attribution. See CQ-6.

---

## CQ-3 — Account Owner is canonical, copy fields are deprecated

**Problem we fixed.** Display logic used to read `quote_customers.owner_rep_id`
(a denormalized cache) for the rep fallback. That field drifted from the CRM
master (`companies.ownerRepId`) and produced inconsistent owner names across
Quote Requests, Customers, and Intel surfaces.

**Contract.**
- `companies.ownerRepId` is the **single source of truth** for "who owns
  this account".
- `loadContext` in `server/services/customerQuotes.ts` builds
  `ownerRepNameByCustomerId` by joining `companies → users` (line ~1224 +
  ~1258–1268). This map is the only allowed source for the Account Owner
  display fallback.
- `enrich()` (line ~1113) reads `opts.ownerRepNameByCustomerId.get(r.customerId)`
  for the fallback (line ~1141 and ~1155). The deprecated
  `quote_customers.owner_rep_id` column **must not** be read for display
  inside `enrich()` — comment lock at line 1138.
- `companies.ownerRepId` is mutated **only** through
  `PATCH /api/companies/:id/owner` (RBAC-gated). The generic
  `PATCH /api/companies/:id` strips `ownerRepId` from its payload.

**Source of truth.**
- `server/services/customerQuotes.ts:1113–1156` (enrich fallback).
- `server/services/customerQuotes.ts:1224–1268` (canonical map build).
- `shared/schema.ts:52` (`companies.ownerRepId` definition).
- Tests: `tests/customer-quotes-display-resolution.test.ts`.

**Must NOT.**
- Read `customer.ownerRepId` (the `quote_customers` copy) inside `enrich()`
  to "simplify" the fallback.
- Add a write path to `companies.ownerRepId` outside the dedicated
  `/owner` endpoint.
- Re-introduce `assignedTo` or any other "shadow owner" concept on the
  Customers / Quote Requests display path.

**Intentional reader of `owner_rep_id` (do not "clean up").**
- `server/routes/customerQuotes.ts` lines ~366, 472–504, 543, 576 read
  `quote_customers.owner_rep_id` from a SQL join **for the attribution-debug
  surface only**. That is a different contract (audit transparency) from the
  display fallback in `enrich()`. Leave it alone.

---

## CQ-4 — Response-Time visibility is read-only derived

**Problem we fixed.** The Phase 1 Response-Time KPIs and the per-row
`firstReplyMinutes` cell are derived live from `email_messages`. We must not
let a future "optimization" cache the value back onto `quote_opportunities`,
because that opens a write path that bypasses the email pipeline.

**Contract.**
- `attachResponseTimes(orgId, rows)` in `server/services/customerQuotes.ts`
  (line ~1386) is the **only** place that fills `firstReplyMinutes`.
- The function body contains **only `db.execute(SELECT …)`** — no
  `db.insert`, `db.update`, `db.delete`, `db.upsert`. It mutates `rows`
  in-memory only.
- `firstQuoteMinutes` is derived in `enrich()` from the existing
  `responseTimeHours` column (line ~1172). No new column or write path is
  introduced for response-time visibility.

**Source of truth.**
- `server/services/customerQuotes.ts:1386–1422`.
- Tests: `tests/customer-quotes-attribution-endpoint.test.ts`.

**Must NOT.**
- Add a "cache" column on `quote_opportunities` for first-reply minutes.
- Move the SELECT into a CTE that also writes (e.g. `WITH x AS (UPDATE …)`).
- Call `attachResponseTimes` from any path that mutates DB state.

---

## CQ-5 — Customer-facing rep gate is null-passthrough

**Problem we fixed.** The original rep gate dropped every row whose `repId`
was not in the customer-facing set, including rows with `repId IS NULL`. That
hid every quote that needed the Account Owner fallback.

**Contract.**
- The third arm of `applyFilters` is:
  ```ts
  if (customerFacingRepIds && r.repId && !customerFacingRepIds.has(r.repId)) return false;
  ```
  The `r.repId &&` guard is **load-bearing**. It lets `repId IS NULL` rows
  fall through so CQ-3's Account Owner fallback can resolve them.

**Source of truth.**
- `server/services/customerQuotes.ts:617`.
- Tests: `tests/customer-quotes-customer-only-filter.test.ts` (the
  "null repId fallback" cases).

**Must NOT.**
- Refactor to `if (customerFacingRepIds && !customerFacingRepIds.has(r.repId)) return false;`
  — that drops every null-rep row.
- Introduce a "default rep" coercion before the gate runs (would defeat the
  Account Owner fallback).

---

## CQ-6 — Funnel diagnostics intentionally bypasses the rep gate

**Problem we fixed.** Originally `getFunnelDiagnostics` reused the same
filter as the main queue, which made the Leakage / audit screen blind to the
rows the main queue hides — defeating the screen's purpose.

**Contract.**
- `getFunnelDiagnostics` (line ~5289) calls
  `applyFilters(allOpps, effectiveFilters, nonCustomerIds)` with **only the
  third arg** (no `customerFacingRepIds`). That is intentional and must stay
  that way: ops needs to see mis-attributed rows in this screen.
- The non-customer (`nonCustomerIds`) gate is preserved because the audit
  screen is still scoped to "customer accounts", just not "customer-facing
  reps".

**Source of truth.**
- `server/services/customerQuotes.ts:5289`.

**Must NOT.**
- "Unify" the two callsites by adding `ctx.customerFacingRepIds` as the
  fourth argument here.
- Add a separate filter that re-applies the rep gate to diagnostic output.

---

## Fragile areas to call out explicitly

The contracts above are most likely to be broken by the following well-meant
refactors. Treat each as a **frozen** area through the next several days of
product work:

1. **`server/services/customerQuotes.ts` — `applyFilters` signature.**
   Adding a new optional argument or reordering existing ones risks silent
   miscompiles at callsites because three of the args are `Set<string>`.
   Prefer a named-options object if expansion is truly needed; do not change
   the positional shape without updating every caller in the same commit.

2. **`enrich()` Account Owner fallback (line ~1141 / ~1155).**
   Two read sites in one function. Both must use
   `opts.ownerRepNameByCustomerId`. A common mistake is to "consolidate"
   them by reading from the row's joined `customer.ownerRepId` (the
   deprecated copy field).

3. **The `__none__` sentinel.**
   It's a literal string, not an enum. Rename / typing changes risk dropping
   the equality check and silently re-introducing the empty-state lie. If
   you must type it, do so as a discriminated-union constant exported from
   the same file.

4. **`routing_status` literal list at line 611.**
   The drop list (`auto_carrier`, `needs_routing`) is a literal string
   comparison. Adding a new carrier-side or unsure status without updating
   this line is the single most likely way to leak carrier rows back into
   the customer queue. Any new `routing_status` value MUST be classified as
   customer-side or non-customer-side, with the latter added here.

5. **Two distinct "owner_rep_id" readers, one allowed and one forbidden.**
   - Allowed: `server/routes/customerQuotes.ts` attribution-debug route
     (reads `quote_customers.owner_rep_id` from a SQL alias as
     `owner_rep_id`).
   - Forbidden: any `customer.ownerRepId` read inside `enrich()` for
     display fallback.
   Future "dead-code removal" PRs that grep for `owner_rep_id` and delete
   them en masse will break the allowed reader. The guardrail in Section
   1100 scopes the forbid to `enrich()` only.

6. **`/api/auth/me` propagation (cross-reference, not a new contract).**
   The role-promotion fix shortened `staleTime` to 30 s and added explicit
   invalidation. This stays in `client/src/hooks/use-auth.ts` and
   `client/src/pages/admin-users.tsx`. Do not re-lengthen the staleTime
   while iterating on Customer Quotes — they share the auth refresh.

---

## Process recommendations for the next several days

While stabilization is in flight:

- **Treat as frozen** unless the task explicitly names a contract here:
  - `server/services/customerQuotes.ts` — `applyFilters`, `loadContext`,
    `enrich`, `attachResponseTimes`, `__none__` resolver.
  - `server/routes/customerQuotes.ts` — owner-fallback wiring (lines
    ~470–545) and the `/owner` PATCH route.
  - `client/src/pages/quote-requests.tsx` empty-state branches.
  - `client/src/pages/customer-quotes.tsx` (if/when it exists) data loaders.

- **New tasks must declare**: "Touches Customer Quotes contract: NONE / CQ-X".
  If "NONE", reviewers should reject any diff under the frozen files above.
  If "CQ-X", the diff must update this document and Section 1100 in the same
  commit.

- **Cleanup work is split out**, not bundled with product work. If you want
  to remove `quote_customers.owner_rep_id` permanently, that is its own
  task (with a migration), not a side-effect of an unrelated feature.

- **Email plumbing stays out of scope** for any task framed as "Customer
  Quotes" work. If a fix requires changes in `graphWebhook.ts`,
  `processUserMailboxEmail`, the classifier, or a `routing_status` writer,
  surface that in the task plan and split it into a separate task with its
  own contract review.

---

## Test surface that defends these contracts

| Contract | Static guardrail (`code-quality-guardrails.test.ts`) | Runtime test |
|----------|-----------------------------------------------------|--------------|
| CQ-1     | Section 10 (EmptyState in quote-requests) + Section 1100 (`__none__` short-circuits) | `customer-quotes-trust-hardening.test.ts`, `quoteRequestsHonestZeroState.test.ts` |
| CQ-2     | Section 1042 (Task #1042 routing-status drop) + Section 1100 | `customer-quotes-customer-only-filter.test.ts` |
| CQ-3     | Section 35 (Account Owner unification) + Section 1100 | `customer-quotes-display-resolution.test.ts` |
| CQ-4     | Section 34 (Phase 1 Response-Time read-only) + Section 1100 | `customer-quotes-attribution-endpoint.test.ts` |
| CQ-5     | Section 1100 (null-passthrough invariant)           | `customer-quotes-customer-only-filter.test.ts` |
| CQ-6     | Section 1100 (diagnostics omits rep gate)           | `freight-capture-funnel.test.ts` (audit visibility) |

Section 1100 is the consolidated "stability contract" guardrail block. It
exists so that if a future edit silently weakens any contract above, the
guardrail run fails with a message that names the contract ID.
