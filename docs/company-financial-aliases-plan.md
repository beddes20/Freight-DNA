# `company_financial_aliases` — Design + Migration Plan (Task P2.1)

**Status:** planning · **Prepared:** 2026-05-07 · **Author surface:** Dashboard / Trust
**Prerequisite:** P2.0 (dev DB schema parity) — DONE
**Implements:** Track 1 of [`docs/dashboard-phase2-plan.md`](./dashboard-phase2-plan.md) §D, Task P2.1
**Trust contract:** [`docs/dashboard-trust-contract.md`](./dashboard-trust-contract.md)

> **Scope of this document.** Design and rollout artifact only. **No SQL is
> executed.** **No join logic changes.** Implementation lands in P2.2+.

---

## A. Diagnosis — current alias-join risk

### A.1 How aliases are stored today

```ts
// shared/schema.ts L38
export const companies = pgTable("companies", {
  ...
  financialAlias: text("financial_alias"),   // ← single comma-separated text column
  ...
});
```

Aliases live as a **single denormalized comma-separated text blob** on the
`companies` row. Every consumer that needs to bind a financial-system
customer name back to a CRM company has to:

1. Read `companies.financialAlias`,
2. `split(",")`,
3. trim + `normalize()` each token (`s.toLowerCase().replace(/[^a-z0-9]/g, "")`),
4. compare with **bidirectional `.includes()` substring matching** against
   names coming out of `freight_daily_upload_fact` rows / financial uploads.

There is **no provenance**, **no per-alias confirmation state**, **no
audit trail**, and **no quarantine path**. An alias added by a heuristic
import is indistinguishable from one a human admin confirmed.

### A.2 Where the bidirectional `.includes()` actually fires

Six confirmed call sites today (verified via `rg`). Each one matches a
financial customer name against `companies.name` + split aliases using
substring containment in either direction:

| # | Site | Surface | Match shape | Risk |
|---|------|---------|-------------|------|
| 1 | `server/routes/dashboard.ts:200-204` (`resolveCompany`) | **Trending Accounts** | `cn === norm \|\| cn.includes(norm) \|\| norm.includes(cn)` | Phantom: a delta tagged "ACME" can resolve to "ACME Logistics" or vice versa, attributing the swing to the wrong CRM company. |
| 2 | `server/routes/dashboard.ts:213-216` (scoped-aliases filter) | **Trending Accounts (scope)** | `sa.includes(d.alias) \|\| d.alias.includes(sa)` | Wider than intended scope — a director may see a delta that "fuzzy belongs" to a company outside their team. |
| 3 | `server/routes/dashboard.ts:797-812` (`buildMetrics` rep-name fallback) | **Margin Metrics** | `normalize(k).includes(nameNorm) \|\| nameNorm.includes(normalize(k))` | Wrong rep gets credited for margin. (This is the **rep-name** fuzzy match — same pattern, different axis.) |
| 4 | `server/routes/dashboard.ts:1172-1180` (`byCustomer` lookup) | **Opportunity Leaderboard / Potential Margin** | `Object.entries(byCustomer).find(([k]) => k.includes(aliasNorm) \|\| aliasNorm.includes(k))` | Phantom: potential margin attributed to wrong company. |
| 5 | `server/routes/dashboard.ts:1272-1289` (`byCustomer` cur/prior) | **Churn Risk** | `k.includes(alias) \|\| alias.includes(k)` | Phantom churn alerts on the wrong account; missed real churn. |
| 6 | `server/routes/dashboard.ts:1543-1601` (inline `normN` + alias loop) | **Award Health** | exact-equality on normalized form, but feeds off the same comma-split alias blob | Award marked "stalled" because the financial rows live under a different (unaliased) name. |

Plus three indirect dependents that read aliases as a comma-split list
without bidirectional `.includes()`, but still without provenance:

| Site | Surface | Notes |
|------|---------|-------|
| `server/routes.ts:2388-2389` | shipping volume / activity rollups | exact-match-only; safer but still no audit |
| `server/routes.ts:2744-2745`, `4716-4717` | account-summary helpers | same as above |
| `server/routes.ts:7321,7515,7730,8223` (`companyNameMap`) | NBA / engagement rollups | builds a name+alias array; downstream callers do their own matching |
| `server/services/customerQuotes.ts` (won-quote AF handoff) | won-quote → AF customer binding | currently uses name- and `financialAlias`-equality; covered by the CQ stability contract — **out of scope for P2.1** (read carefully, do not break) |
| `server/routes/companies.ts:716-718, 749-764` | `/api/companies/:id/data-freshness` + `/financial-mapping-health` | reads alias to compute mapping-health counts; pure SELECTs, surface for Profile Safety Labels |
| `server/runMigrations.ts:148` | bootstrap migration | seeds `financial_alias = name` where empty; legacy ergonomics |
| `server/chatbot.ts:539,654,739` | LLM context strings | informational only |
| `client/src/pages/company-detail.tsx:271`, `customers.tsx:105`, `rep-customers.tsx:62` | UI display + client-side fuzzy match | mirrors the same pattern in the browser |
| `scripts/audits/company-detail-header-trust.ts:314` | audit script | already classifies "FUZZY_HIGH" / "FUZZY_LOW" / "NO_MATCH_BUT_HAS_FREIGHT" buckets — **a nascent quarantine taxonomy already exists in audit form** |

### A.3 What goes wrong — the risk in plain language

- **Phantom customers in financial portlets.** `ACME` and `ACME Logistics`
  are different companies but bidirectional `.includes()` will collapse
  them. Trending Accounts, Margin Metrics, Opportunity Leaderboard, Churn
  Risk, and Award Health can all attribute a load, a margin dollar, or a
  drop to the wrong CRM row. Phase 1.5 made the freshness pill honest,
  but the row underneath can still be a phantom.
- **Silent best-guessing.** When zero CRM company exactly matches a
  financial customer, current code "best guesses" with substring contains
  rather than surfacing the unresolved row to a human. There is no path
  to triage.
- **No provenance.** A heuristic import that wrote `financialAlias =
  "ACME"` is indistinguishable from a human admin confirming `"ACME
  Logistics" → "ACME LLC"`. We can't differentiate trustworthy from
  guessed aliases.
- **No reversibility.** Editing the comma-blob is destructive — there's
  no record of who added a token, when, or why.
- **Drift across helpers.** `normN` is redefined inline in
  `dashboard.ts:1544`, in `nbaPhase1Engine.ts:105`, and in
  `carrierScorecardService.ts:252`. A future schema or normalization
  change has to touch all three (or quietly drift).
- **Audit script already knows.** `scripts/audits/company-detail-header-trust.ts`
  is *already* generating CSV reports with `FUZZY_HIGH` / `FUZZY_LOW` /
  `NO_MATCH_BUT_HAS_FREIGHT` buckets — humans are already bucketing the
  problem, just on a one-off basis. P2.1 turns that audit into a live
  data model.

---

## B. Proposed `company_financial_aliases` schema (in prose)

A row per `(org, alias)` pair tied to one CRM company, with explicit
provenance and confirmation state. Keep the existing
`companies.financialAlias` column **untouched** for one full release —
this is the dual-write/dual-read safety net.

### B.1 Columns

| Column | Type | Required | Meaning |
|---|---|---|---|
| `id` | `varchar` (uuid) | yes | Primary key. Stable so admin actions / audit trails can reference it. |
| `org_id` | `varchar` (FK → `organizations.id`) | yes | Multi-tenant isolation. Mirrors every other tenant-scoped table. |
| `company_id` | `varchar` (FK → `companies.id`, `ON DELETE CASCADE`) | yes | The CRM company this alias resolves to. Cascade so deleting a company also deletes its aliases (no orphan aliases pointing at a deleted row). |
| `alias` | `text` | yes | The raw, human-readable alias as it appears in the financial system / upload. Preserved verbatim for display + audit. |
| `alias_normalized` | `text` | yes | The result of the canonical normalize step (`s.toLowerCase().replace(/[^a-z0-9]/g, "")`). This is the column we **index and equality-match on**. Stored, not computed at query time, so the normalize fn lives in exactly one place. |
| `source` | `text` (enum-via-check) | yes | Provenance. Allowed values, in initial v1: `"legacy_column"` (backfilled from `companies.financialAlias`), `"admin"` (a user confirmed it via the alias quarantine console — P2.4), `"financial_upload"` (auto-derived from a financial upload row), `"heuristic"` (auto-derived by a future fuzzy-match suggester, *suggested only, not authoritative*), `"migration"` (created by a one-shot data migration). |
| `confirmed_by_user_id` | `varchar` (FK → `users.id`, `ON DELETE SET NULL`, nullable) | no | Set when a human admin confirms the alias in the quarantine console. Null for unconfirmed/auto-derived rows. The presence of this column is what makes `source='heuristic'` rows distinguishable from `source='admin'` rows. |
| `confirmed_at` | `timestamp` (nullable) | no | When the human confirmation happened. Nullable in the same situations as `confirmed_by_user_id`. |
| `created_at` | `timestamp` (default `now()`) | yes | Standard. |
| `created_by_user_id` | `varchar` (FK → `users.id`, `ON DELETE SET NULL`, nullable) | no | Whoever (human or system process) caused the row to come into existence. Nullable because backfill / migration rows have no human author. |
| `updated_at` | `timestamp` (default `now()`, updated on write) | yes | Standard. |
| `notes` | `text` (nullable) | no | Free-text reason a human might attach when confirming or rejecting. Especially useful for "rejected, this alias actually belongs to *X*". |

### B.2 Indexes & uniqueness

| Index | Purpose |
|---|---|
| `unique (org_id, alias_normalized)` (partial: `WHERE source != 'heuristic'`) | One **authoritative** alias per org. A heuristic *suggestion* is allowed to coexist with a confirmed mapping (so the quarantine surface can show "we suggested X, admin confirmed Y") but two confirmed mappings for the same normalized alias is an error. |
| `index (org_id, company_id)` | Primary read path: "give me all aliases for this company in this org". Used by the resolver when serializing a company row. |
| `index (org_id, alias_normalized)` | Primary read path: "given a financial customer name, what CRM company does it map to?". Hot path for every dashboard portlet. |
| `index (org_id, source) WHERE source = 'heuristic' AND confirmed_by_user_id IS NULL` | Powers the P2.4 quarantine surface: "show me the unresolved aliases waiting for human review". |

### B.3 Invariants worth pinning in a guardrail

The existing `tests/code-quality-guardrails.test.ts` is the right home
for these — they should land as Section 1200+ alongside the contacts
soft-delete contract.

1. **No new code path may write to `companies.financial_alias` without
   *also* writing to `company_financial_aliases`** during the dual-write
   window (Step 3 below).
2. **No new SELECT may match against `companies.financial_alias` via
   `.includes()`** — must call the resolver instead.
3. **`alias_normalized` must always equal `normalizeAlias(alias)`** for
   the canonical normalize fn — enforced in app code, not by a DB
   constraint, so writes go through the resolver service rather than raw
   `db.insert`. Guardrail flags any `db.insert(companyFinancialAliases)`
   that bypasses the service.
4. **`company.organizationId === alias.org_id`** at insert/update time —
   prevents cross-tenant aliasing.

---

## C. Migration / rollout steps

Phased, reversible, with an explicit dual-read window so a regression
never silently disappears a row from a financial portlet.

### Step 1 — Add table, no readers, no writers

- Drizzle migration: create `company_financial_aliases` per §B.
- Add to `shared/schema.ts` with insert / select schemas.
- Storage interface (`server/storage.ts`): add CRUD methods
  `getCompanyFinancialAliases(orgId, opts)`, `createCompanyFinancialAlias(input)`,
  `updateCompanyFinancialAlias(id, patch)`, `deleteCompanyFinancialAlias(id)`.
- **No call sites change.** No reader, no writer wired up. The table is
  empty.
- Reversibility: `DROP TABLE` is safe — nothing depends on it.

### Step 2 — Backfill from `companies.financial_alias`

- One-shot script (`tools/backfill-company-financial-aliases.ts`,
  pattern: `tools/backfill-incident-window.ts`) that, per org:
  1. Reads every `companies` row with non-null `financial_alias`.
  2. Splits on `,`, trims each token.
  3. For each non-empty token, inserts a `company_financial_aliases`
     row with:
     - `alias` = raw token
     - `alias_normalized` = `normalizeAlias(token)`
     - `source = 'legacy_column'`
     - `created_by_user_id = NULL`
  4. Skips duplicates (same `org_id` + `alias_normalized` already
     present), so the script is **idempotent** and safe to re-run.
- Also: insert a self-row `(alias = company.name, source =
  'legacy_column')` so the resolver doesn't need a special case for "the
  company's own name". This mirrors the current code pattern that uses
  `[normalize(c.name)]` as the fallback alias set.
- Reversibility: `DELETE FROM company_financial_aliases WHERE source =
  'legacy_column'`.

### Step 3 — Dual-read resolver, no caller migration yet

- New service `server/services/aliasResolver.ts` exposes
  `resolveCompanyByFinancialAlias(orgId, rawName, opts)` (see §D).
- **Internally** the resolver consults the new table first, then falls
  back to scanning `companies.financial_alias` (the legacy code path,
  copy-pasted into the resolver so we have one well-tested code path
  rather than two diverging ones). The legacy fallback is wrapped in a
  `legacyFallbackUsed` boolean returned to callers — initially nobody
  reads it, but it's the basis for Step 5's shadow telemetry.
- **No call sites change yet.** Resolver is dormant.
- Reversibility: delete the file.

### Step 4 — Dual-write at every alias-write site

Inventory of write sites that touch `companies.financial_alias` today
(from §A.2):

- `server/routes/companies.ts:280-282` (PATCH a company's alias from the
  UI).
- `server/routes.ts:980` (CSV import — sets alias from the
  `financial_alias` column of an imported sheet).
- `server/runMigrations.ts:148` (bootstrap: seeds
  `financial_alias = name`).
- `server/services/customerQuotes.ts` won-quote AF handoff (per replit.md
  "Customer Quotes & Account Ownership" Gotcha — this code path is
  **stability-contract-locked**; treat it as out-of-scope for the
  alias-write change in P2.1, but the resolver in §D still reads its
  output).

Each non-locked write site is wrapped to also write the equivalent rows
to `company_financial_aliases` (with `source = 'admin'` for the UI PATCH
and `source = 'financial_upload'` for the CSV import). Failures to write
the new table are **logged but not fatal** in this step — we don't want
to break the UI PATCH path while the new table is settling.

- Reversibility: each write site is gated by a tiny helper
  `writeAliasMirror(orgId, companyId, aliases)`; remove the call to
  revert.

### Step 5 — Shadow mode (per-org flag, off by default)

- Add an org-scoped feature flag `alias_resolver_shadow_enabled`
  (mirrors the `profile_safety_labels_enabled` flag pattern from Task
  #1109).
- When enabled for an org: every dashboard handler that calls
  `resolveCompanyByFinancialAlias` also runs the **legacy fuzzy
  matcher** in parallel and emits a structured log line whenever the two
  disagree:
  - `[alias-shadow] org=… name="ACME" legacy=companyA new=companyB action=mismatch`
  - `[alias-shadow] org=… name="ACME" legacy=companyA new=null action=new-quarantines`
  - `[alias-shadow] org=… name="ACME" legacy=null new=companyA action=new-resolves`
- Run shadow for **at least one full upload cycle (one week)** per org
  before flipping. The `[alias-shadow]` log lines are the
  pre-cutover review surface for the team.
- Reversibility: turn the flag off.

### Step 6 — Cutover (per-org flag flip)

- Replace each `.includes()` matching site (the six in §A.2) with a
  call to `resolveCompanyByFinancialAlias(...)`.
- For orgs with `alias_resolver_shadow_enabled = true` AND a clean
  shadow week (no unresolved disagreements), flip a second flag
  `alias_resolver_authoritative = true`.
- When `authoritative = true`: the resolver no longer falls back to
  `companies.financial_alias`. Unresolved → quarantine (P2.4 surface),
  *not* a best-guess match.
- Default for new orgs: `authoritative = false` until the shadow window
  has passed.
- Reversibility: flip the flag back. The legacy column is still being
  written to, so the fallback path is still warm.

### Step 7 — Deprecate the legacy column

- After 2 release cycles with `authoritative = true` org-wide and zero
  shadow mismatches:
  - Stop writing `companies.financial_alias` (Step 4 mirrors collapse
    into a single write to the new table).
  - Add a guardrail forbidding any new read of `companies.financial_alias`.
  - Eventually: drop the column in a separate migration (a release
    cycle later, so old running pods don't crash).
- Reversibility (during deprecation period): the column still exists and
  the backfill script can re-populate it from
  `company_financial_aliases` if needed.

---

## D. `resolveCompanyByFinancialAlias` — high-level behavior

A single service, replacing six in-line copies of the same logic.

### D.1 Signature (described, not coded)

```
resolveCompanyByFinancialAlias({
  orgId,                       // required — tenant isolation
  rawFinancialName,            // the customer string from a financial-upload row
  authoritative?: boolean      // when true: no legacy fallback, unresolved → quarantine
}) =>
  | { status: "resolved",      companyId, matchSource: "exact" | "alias" | "legacy_fallback", aliasId?: string }
  | { status: "unresolved",    quarantineSuggestionId?: string }
  | { status: "ambiguous",     candidateCompanyIds: string[], quarantineSuggestionId: string }
```

### D.2 Decision tree

1. **Normalize once.** `n = normalizeAlias(rawFinancialName)`. (Empty
   string → `unresolved` immediately, no DB hit.)
2. **Exact CRM-name match.** Look for a `companies` row in `orgId` with
   `normalize(name) = n`. If exactly one → `resolved`,
   `matchSource: "exact"`. If two or more → `ambiguous`.
3. **Authoritative alias match.** Look up
   `company_financial_aliases` for `(org_id = orgId, alias_normalized =
   n, source != 'heuristic')`.
   - 0 hits → next step.
   - 1 hit → `resolved`, `matchSource: "alias"`, `aliasId = …`.
   - 2+ hits → `ambiguous` (this should be impossible given the partial
     unique index, but the resolver still handles it defensively and
     surfaces a quarantine suggestion).
4. **Heuristic alias match (suggestion only).** Look up
   `company_financial_aliases` for `(org_id, alias_normalized = n,
   source = 'heuristic', confirmed_by_user_id IS NULL)`. If exactly one
   → `unresolved` *with* `quarantineSuggestionId` set so the admin
   surface can pre-fill the suggested mapping. (Heuristic rows never
   resolve on their own; they always require human confirmation.)
5. **Legacy fallback (only when `authoritative = false`).** Run the
   existing comma-split + bidirectional `.includes()` matcher against
   `companies.financial_alias`. Emit a `[alias-resolver] used-legacy
   org=… name="…"` log line. If matched → `resolved`, `matchSource:
   "legacy_fallback"`. If not matched → `unresolved`.
6. **Authoritative + nothing matched →** `unresolved`. The caller MUST
   NOT then call `.includes()` themselves — the resolver is the only
   matcher. The unresolved row should be recorded as a quarantine
   candidate (P2.4) so a human can confirm or reject.

### D.3 What the resolver explicitly never does

- **Never** does bidirectional `.includes()` matching. That's the bug
  we're retiring.
- **Never** silently best-guesses. A `resolved` result either came from
  exact normalization equality or from an explicitly-confirmed alias row.
- **Never** writes from the read path. Heuristic alias creation happens
  in a separate, batched job (out of scope for P2.1 — surfaces in P2.2 +
  P2.4).
- **Never** swallows ambiguity. `ambiguous` is a first-class result
  shape; the caller must decide what to do with it (today: surface as a
  Profile Safety Label / quarantine row, never just pick the first).

### D.4 Tie-back to the trust contract

- **No phantom customers** in any portlet that goes through the
  resolver (closes the §A.3 risk).
- **Quarantine surface (P2.4)** receives every `unresolved` and every
  `ambiguous` result, so reps see *zero* fewer rows than today — the
  same data is preserved, just routed to a triage path instead of a
  best-guess match.
- **Profile Safety Labels (Task #1109)** keep working unchanged: the
  `/api/companies/:id/financial-mapping-health` endpoint will eventually
  switch from "ILIKE on `customer` not bound by name- or
  financialAlias-equality" to "rows whose resolver result is anything
  other than `resolved` for this `companyId`" — but that swap lands in
  P2.2/P2.4, not here.

---

## E. Endpoints / joins that will move to the new resolver

In execution order (this defines the surface area for P2.2 and P2.3 —
no code changes happen in P2.1):

### E.1 First wave — direct `.includes()` callers (P2.2)

| Endpoint / job | File · line(s) | Current join shape | Resolver-era shape | Guardrail |
|---|---|---|---|---|
| `GET /api/dashboard/trending-accounts` | `server/routes/dashboard.ts:197-219` | bidirectional `.includes()` on `companies.financialAlias`; fuzzy scope filter | replace `resolveCompany(alias)` with `resolveCompanyByFinancialAlias`; scope filter becomes a set-membership check on `aliases.company_id` | Section 15xx-A: forbid `.includes()` on `financialAlias` in `dashboard.ts` |
| `GET /api/dashboard/margin-metrics` | `server/routes/dashboard.ts:797-812` | rep-name fuzzy fallback (different axis from financial alias, but same anti-pattern) | extract a parallel `resolveRepByName(orgId, rawName)` (out-of-scope here, file as P2.2b) | Same guardrail section |
| `GET /api/dashboard/opportunity-leaderboard` | `server/routes/dashboard.ts:1172-1180` | per-company `byCustomer` lookup with bidirectional `.includes()` | `resolveCompanyByFinancialAlias` per row of the financial summary, group by resolved `companyId` | Section 15xx-B |
| `GET /api/dashboard/churn-risk` | `server/routes/dashboard.ts:1272-1289` | same `byCustomer` shape, two months | same swap; aggregate cur/prior loads keyed by resolved `companyId` | Section 15xx-B |
| `GET /api/dashboard/award-health` | `server/routes/dashboard.ts:1543-1601` | normalized exact-match against alias-blob; `hasFinancialData` boolean uses inline `normN` | `hasFinancialData` becomes `any rows resolve to award.companyId`; `recentLoads` aggregate over rows whose `resolved.companyId === award.companyId` | Section 15xx-B |
| `tools/backfill-incident-window.ts` (currently uses `companyNameMap` shape) | `server/routes.ts:7321/7515/7730/8223` callers | builds `[name, ...aliases]` arrays | callers receive a resolver instead | Section 15xx-C |

### E.2 Second wave — financial-upload write/ingest paths (P2.2 / P2.3)

| Endpoint / job | File | Notes |
|---|---|---|
| Won-quote AF customer binding | `server/services/customerQuotes.ts` | **Stability-contract locked** (replit.md Customer Quotes Gotcha). This site reads aliases for binding; in P2.2 the read switches to the resolver but the binding semantics MUST remain unchanged. Section 1100 of guardrails enforces. |
| Financial upload row ingestion | `server/services/freightDailyUploadFact.ts` (or wherever new rows are inserted into `freight_daily_upload_fact`) | Each new row gets a resolved `companyId` via the resolver at ingest time. `unresolved` rows are written with `companyId = NULL` (matches the existing PERSIST-UNKNOWN pattern for inbound emails) **and** generate a `company_financial_aliases` row with `source = 'heuristic'` if a high-confidence suggestion exists. |
| `/api/companies/:id/financial-mapping-health` | `server/routes/companies.ts:749-764` | Read-only route powering Task #1109 financial freshness pill. Switches from "ILIKE customer not bound by name- or financialAlias-equality" → "count of `freight_daily_upload_fact` rows for this org whose resolver result is `resolved → this companyId`". |

### E.3 Third wave — display & UX surfaces (P2.4)

| Endpoint / surface | File | Notes |
|---|---|---|
| `client/src/pages/company-detail.tsx:271-272`, `customers.tsx:105-106`, `rep-customers.tsx:62` | client | Replace client-side comma-split logic with a server-provided `aliases: { id, alias, source, confirmedAt }[]` field on the company API response. Source of truth moves out of the browser. |
| Admin alias quarantine console | `client/src/pages/admin/financial-alias-quarantine.tsx` (NEW) | P2.4 deliverable. Mirrors `/admin/email-derived-companies` (Task #1095) — list of `unresolved` / `heuristic` rows with per-row Confirm / Reject / Reassign actions. |
| `server/chatbot.ts:539,654,739` | LLM context | Cosmetic — switch from `c.financialAlias` blob to `aliases.map(a => a.alias).join(", ")`. No semantic change. |
| `scripts/audits/company-detail-header-trust.ts` | audit | Becomes redundant once §C Step 6 cutover completes — the live quarantine surface IS the audit. Keep the script around for one release as a sanity check, then archive. |

### E.4 Explicitly **out of scope for P2.1's downstream tasks**

Captured here so future task agents don't bundle them:

- The parallel `normName` definitions in `nbaPhase1Engine.ts` and
  `carrierScorecardService.ts` — they are not dashboard-reachable
  callers. Migrating them belongs to a separate slice (per
  `dashboard-phase2-plan.md` §E "Defer").
- Lane-string normalization (Coverage Gaps / Award Health lane fuzzy
  match) — same pattern class but a separate axis. Already filed as
  P2.3 with its own helper `server/services/laneNormalize.ts`.
- Email-derived companies cleanup (Task #1095) — adjacent but
  independently governed; do not bundle.
- Carrier-name aliasing — same pattern class on a different table; out
  of dashboard scope.

---

## Appendix — Evidence index (for reviewers)

- **Schema today:** `shared/schema.ts:38` (`financialAlias: text("financial_alias")`).
- **Bidirectional `.includes()` call sites:** `server/routes/dashboard.ts` lines 200-204, 213-216, 797-812, 1172-1180, 1272-1289.
- **Inline normalize helper (one of three copies in the codebase):** `server/routes/dashboard.ts:1544` (`normN`).
- **Indirect alias-blob readers:** `server/routes.ts:2388-2389, 2744-2745, 4716-4717, 7321, 7515, 7730, 8223`; `server/routes/companies.ts:716-718, 749-764, 280-282`; `server/chatbot.ts:539, 654, 739`; `client/src/pages/company-detail.tsx:271-272`, `customers.tsx:105-106`, `rep-customers.tsx:62`.
- **Existing audit-bucket taxonomy** that this design generalizes into a live data model: `scripts/audits/company-detail-header-trust.ts:175` (the `FUZZY_HIGH` / `FUZZY_LOW` / `NO_MATCH_BUT_HAS_FREIGHT` comment).
- **Stability-contract sites that constrain P2.2's surface:** `server/services/customerQuotes.ts` (CQ contract — replit.md), `server/routes/companies.ts:716-764` (Profile Safety Labels — Task #1109).
- **Migration pattern reference** for the backfill script: `tools/backfill-incident-window.ts`.
- **Flag pattern reference** for Step 5 shadow mode: Task #1109 `profile_safety_labels_enabled` and Task #1095 `is_email_derived` opt-in toggle.
