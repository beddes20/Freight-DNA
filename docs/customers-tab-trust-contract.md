# Customers Tab — Trust Contract

> **Purpose.** Lock in the production behavior shipped in Customers Trust
> Cleanup Subtask B (2026‑05‑15). This file is **a "don't break this"
> contract**, not background reading. Future work should reference each
> contract by ID before changing the listed files, and any deviation
> requires updating both this document and Section 1300 of
> `tests/code-quality-guardrails.test.ts` in the same commit.
>
> **Scope rule.** This contract covers **only** the read / display / filter
> layer for the Customers tab and the shared `GET /api/companies` route. It
> deliberately does **not** reopen Customer Quotes, the
> `freight_daily_upload_fact` writers, the inbound-email pipeline
> (`processUserMailboxEmail`), or contacts soft-delete plumbing. Those
> remain governed by their own contracts (Sections 1100, 1051, 1095, 1094,
> 1126, 1140, 1200) and are listed as **Non‑surfaces** below.
>
> **Companion docs.**
> - `docs/customers-bucket-audit-2026-05-15.md` — the per‑org audit (A–G
>   buckets, 304 default-visible rows on Value Truck → 246 in Bucket D)
>   that motivated Subtask B.
> - `replit.md` Gotcha "Customers Tab Trust (Subtask B, 2026‑05‑15)" —
>   the prompt-time pin of the same invariants.

---

## How to use this document

1. Before editing any file listed under **Source of truth**, find the
   matching contract below and read its **Must / Must NOT** rules.
2. If a change is unavoidable, update **both** this document and Section
   1300 of `tests/code-quality-guardrails.test.ts` in the same commit.
3. If a contract here conflicts with a new product requirement, **don't
   silently rewrite the contract**. Open a follow-up task that names the
   contract ID (e.g. "Modify CT‑2") and document the rationale. The
   future classification program (design captured in the Subtask C′
   write-up) is the natural home for any rule changes that touch the
   `customersOnly` predicate.

---

## CT‑1 — Customers tab is the **only** opt‑in caller

**Problem we fixed.** Pre‑Subtask B, the Customers page rendered ~304
rows for Value Truck of which 246 (~81%) were Bucket D thin stubs — rows
with no owner, no contacts, no freight history, and no enrichment
columns. Reps could not trust the list.

**Contract.**
- The Bucket D thin‑stub filter is implemented as a single optional
  predicate inside `storage.getCompanies(orgId, opts?: { customersOnly?:
  boolean; includeEmailDerived?: boolean })`, applied **only** when
  `opts.customersOnly === true`.
- `client/src/pages/customers.tsx` — the **only** opt‑in caller — sends
  `?customersOnly=true` by default. The admin‑only chip
  `data-testid="toggle-show-all-accounts"` (gated by
  `isAdminPreviewViewer`) drops the param so the route returns the
  legacy full list.
- The query key `["/api/companies", { includeEmailDerived, customersOnly
  }]` keeps the cleaned and full views in separate cache slices.

**Source of truth.**
- `server/storage.ts` — IStorage signature for `getCompanies` (~L587),
  implementation (~L2499‑L2548), `freightDailyUploadFact` import (~L14),
  cache key segment `:co=${0|1}`.
- `client/src/pages/customers.tsx` — `showAllAccounts` state
  (~L218‑L219), `useQuery` fetch (~L327‑L346), admin chip (~L611‑L637).

**Must NOT.**
- Add a default-on `customersOnly` for any other caller (server-side or
  client-side). The only opt‑in caller today is the Customers page.
- Move the thin‑stub predicate into a chokepoint that runs even when
  `customersOnly !== true` (e.g. unconditionally inside `getCompanies`,
  inside `getVisibleCompanyIds`, or inside `getCompanyInOrg`).
- Drop the `if (!showAllAccounts) params.set("customersOnly", "true")`
  line in `customers.tsx`. That single line is the entire opt‑in.

---

## CT‑2 — Route default must NOT narrow other consumers

**Problem we fixed.** A first cut of Subtask B defaulted
`customersOnly=true` at the `GET /api/companies` route whenever
`includeArchived` and `includeEmailDerived` were absent. The architect
review (FAIL) flagged that ~60 other client consumers (dashboard,
dialogs, company-detail tabs, contact pickers, NBA, etc.) and ~30
internal `storage.getCompanies` callers (auth, CQ, NBA, leaderboards,
freight-fact writers, RFP scheduler, agent tools) all rely on the legacy
full list — the route default would have silently narrowed every one of
them. The fix flipped to **strict opt‑in**.

**Contract.**
- `GET /api/companies` computes `customersOnly` **only** from explicit
  `?customersOnly=true`. There is no other default branch:
  ```ts
  const customersOnly = qStr(req.query.customersOnly) === "true";
  ```
- Internal `storage.getCompanies(orgId)` no‑opts call sites preserve the
  legacy "every row" behavior. CQ chokepoints, freight-fact writers,
  NBA, leaderboards, auth visibility, etc. are all unaffected.
- The route forwards `customersOnly` and `includeEmailDerived` into
  `storage.getCompanies` and emits a `X-Customers-Hidden-Count` response
  header **only** when `customersOnly=true` is in effect.

**Source of truth.**
- `server/routes/companies.ts` — `GET /api/companies` handler
  (~L33‑L112).

**Must NOT.**
- Re‑introduce a route-level default that fires `customersOnly` when
  other flags are absent. The Section 1300 guardrail rejects the exact
  regex pattern that would do this; bypassing it is the regression we
  are protecting against.
- Forward `customersOnly` to `storage.getCompanies` as anything other
  than the explicit `?customersOnly=true` boolean.
- Move the `X-Customers-Hidden-Count` header out of the
  `customersOnly`-gated branch (the count is meaningless when the
  filter is off).

---

## CT‑3 — In‑app disclosure stays honest

**Problem we fixed.** Hiding rows without telling reps how many were
hidden would be a silent narrowing — exactly the trust failure mode the
program is closing.

**Contract.**
- The route emits `X-Customers-Hidden-Count: <N>` whenever
  `customersOnly=true` is in effect. The header is computed from a
  second `storage.getCompanies(..., { customersOnly: false })` call
  scoped to the same `includeEmailDerived` flag, so the count reflects
  the same audit cohort the admin chip would surface.
- `client/src/pages/customers.tsx` reads the header into
  `hiddenThinCount` state and renders it inside
  `data-testid="text-thin-accounts-hidden-count"`.

**Source of truth.**
- `server/routes/companies.ts` — header emission (~L69‑L86).
- `client/src/pages/customers.tsx` — header read + disclosure span.

**Must NOT.**
- Replace the disclosure span with a non‑testid element or remove the
  header read — Section 1300 asserts both.
- Compute the hidden count from a different cohort (e.g. ignoring
  `includeEmailDerived`); the count must match what the admin would see
  by flipping the chip.

---

## CT‑4 — Customer Quotes chokepoints stay on the legacy view

**Problem we fixed.** CQ-2 / CQ-5 (Customer Quotes Stability Contract,
Section 1100) require that the customer-quotes service join companies
by name without any `customersOnly`-style narrowing. Widening the
narrowing into CQ would silently drop unmatched-customer quotes.

**Contract.**
- `server/services/customerQuotes.ts` **must not** call
  `storage.getCompanies(...)` with a `customersOnly` argument. It calls
  the no‑opts overload exclusively.

**Source of truth.**
- `server/services/customerQuotes.ts` — every `getCompanies(` call.

**Must NOT.**
- Pass `customersOnly` (true *or* false) from the CQ service. The
  no‑opts overload is the contract.
- Reach into the new thin-stub predicate from any CQ helper. CQ joins
  are name‑based per the CQ stability contract.

---

## Non‑surfaces (out of scope — do NOT regress here)

These files are **not** governed by this contract. They have their own
contracts; touching them as part of any Customers‑tab work requires the
matching declaration on those contracts:

- `server/services/customerQuotes.ts` — Customer Quotes Stability
  Contract (`docs/customer-quotes-stability-contract.md`, Section 1100).
- `freight_daily_upload_fact` writers anywhere under `server/services/`
  / `server/routes/financials.ts` — Section 1051.
- `server/services/processUserMailboxEmail` and adjacent inbound-email
  helpers (`server/accountContactCaptureService.ts`,
  `server/services/signatureContactSweep.ts`) — Section 1094 (the
  `CONTACT_JOBS_ENABLED` kill switch) and Section 1095 (email-derived
  companies flag).
- `contacts` reads / writes — Section 1200 (soft-delete only) and
  Section 1093 (the contacts-soft-delete migration).
- Top Opportunities surfaces — Section 1140 (freight-data freshness
  pill states + manager-only dismiss attribution).
- User lifecycle reads / writes — Section 1126.

---

## Runtime tests pinning this contract

- `tests/customers-tab-trust-contract.test.ts` — 8 cases against a
  sandboxed org: Bucket D excluded when `customersOnly=true`, Bucket B
  included, Bucket D + active contact included (EXISTS-contacts branch),
  `customersOnly=false` returns both, no‑opts call returns the legacy
  full list, and `is_email_derived` 4a/4b/4c interactions.
- `tests/code-quality-guardrails.test.ts` Section 1300 — static asserts
  on the IStorage signature, the impl predicate, the route's strict
  opt‑in, the absence of any default-narrowing, the header emission,
  the customers.tsx opt‑in line, the queryKey shape, the disclosure
  span, the CQ-untouched guarantee, and the existence of this document
  + the matching `replit.md` Gotcha entry.

---

## Future work pointer

The full classification model (design only, no code) is captured in the
Subtask C′ design write‑up (`company_type`, `created_via`,
`created_by_user_id`, `carrier_id`, audit table, backfill strategy,
staged rollout). When that program is approved for implementation, the
`customersOnly` predicate will be extended to consult `company_type`,
and Section 1300 + this document will grow new contracts (CT‑5+) to
pin the new invariants. Until then, the current contract is the entire
contract.
