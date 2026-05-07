# Dashboard Phase 2 — Strategic Track Recommendation

**Status:** planning · **Prepared:** 2026-05-07 · **Decision-owner:** Dashboard / Trust surface
**Prerequisite reading:** [`docs/dashboard-trust-contract.md`](./dashboard-trust-contract.md)

---

## A. Where the dashboard stands now (post-Phase-1.5)

Phase 1.5 closed the *surface honesty* gap: every dashboard portlet now
either carries a real freshness signal, an explicit empty-state, an
explicit degraded-input indicator, or a documented opt-out sentinel.
The trust primitives (`decidePortletState`, `PortletStateBanner`,
`AsOfLabel`, `PipelineHealthStrip`) are pinned by guardrail Sections
1500–1503 and a developer-facing contract doc is in place.

What that **did not** fix:

1. The data underneath several "honest" surfaces is still joined by
   fuzzy `.includes()` on a `companies.financialAlias` *single text
   column* — the surface is honest, the join is coin-flippy.
   (`server/routes/dashboard.ts` L203, L215.)
2. The dev environment cannot actually exercise the trust strip end-to-end
   because `cron_heartbeats` (and several other tables / columns) are
   missing in dev — every scheduler heartbeat write silently fails. In
   production this works; in dev we are flying blind on the very signal
   we just documented.
3. `client/src/pages/dashboard.tsx` is 2,762 lines with 26 inline role
   gates and hand-built `?directorId=` query-string assembly across 4+
   queries. Cognitive load is high but the surface is *functional* —
   not the urgent risk.

The next strategic track has to choose which of these three threads to
pull, knowing that the dashboard's near-term reputation is staked on
**continuing to deliver honest signals**, not on layout polish.

---

## B. Comparison of the three candidate tracks

### Track 1 — Data-model / source-of-truth cleanup

| Dimension | Detail |
|---|---|
| Problem solved | Replaces fuzzy alias / lane-string matching with a strict, auditable resolver. Today, an "Award Health" portlet with a green freshness pill can still be joining yesterday's accurate data on `name.toLowerCase().includes(otherName.toLowerCase())`. The pill is honest; the row is a phantom. |
| Why it matters now | Phase 1.5 raised rep expectations — they are about to start *trusting* the dashboard numbers. The first time a rep clicks into an Award Health row and finds it's the wrong customer, the whole trust contract takes a hit. This is the natural "honest data" extension of "honest signals". |
| User pain removed | Phantom accounts in financials, false positives in Award Health / Coverage Gaps, mis-attributed loads in trending. |
| Key files / tables / jobs | `server/routes/dashboard.ts` (alias matching at L203/L215), `companies.financialAlias` (single text column → should be a table), `server/growthScoreCalculator.ts`, `server/nextBestActionEngine.ts`, `server/healthAlertScheduler.ts`, `server/dailyDigestScheduler.ts`, `server/services/copilot/copilotEntityResolution.ts`, parallel `normName` defs in `carrierScorecardService.ts` and `nbaPhase1Engine.ts` (drift risk). |
| Risk level | **Medium-high** — touches every read path that resolves a financial customer name. |
| Blast radius | Wide *but* mostly read-side. Phased migration (introduce alias table, dual-read window, cut over readers, deprecate column) keeps it bounded. |
| Reversibility | High during dual-read; low after cutover (need a backfill job to reverse). |
| Sequencing complexity | Medium — needs a tiny prerequisite (one-command dev schema push, see §C) so the work is testable. |

### Track 2 — Dashboard simplification / layout pass

| Dimension | Detail |
|---|---|
| Problem solved | `dashboard.tsx` is 2,762 lines with 26 inline role gates; `selectedDirectorId` is plumbed by hand into 4+ queries; some role bundles (`AmPortlets` / `NamPortlets` / `DirectorPortlets`) exist but dashboard.tsx still composes inline. Cognitive load for future maintainers. |
| Why it matters now | It doesn't, yet. The surface works, reps have just learned the new trust signals (don't disrupt them mid-adoption), and the existing role bundles already give us a refactor seam when we want one. |
| User pain removed | Mostly *engineer* pain. Some rep pain around director-filter discoverability. |
| Key files | `client/src/pages/dashboard.tsx` (the 2,762-line monolith), `client/src/pages/dashboard/AmPortlets.tsx` / `NamPortlets.tsx` / `DirectorPortlets.tsx`, `client/src/pages/dashboard/Phase2Portlets.tsx`. |
| Risk level | Low (UI-only) but high *user-facing* risk if shipped too soon — reorganizing right after a trust retrofit dilutes the gains. |
| Blast radius | UI only. |
| Reversibility | High. |
| Sequencing complexity | Low *technically*, but should follow Track 1: extracting an alias resolver out of dashboard.ts is a natural precondition for sane layout work. |

### Track 3 — Pipeline / scheduler hardening

| Dimension | Detail |
|---|---|
| Problem solved | Several dev-environment tables/columns are missing (`users.clerk_user_id`, `email_messages.provider_message_id`, `mailbox_metadata.last_inbox_notification_at`, `recurring_lanes.is_manual`, **`cron_heartbeats` table entirely**), causing every scheduler heartbeat write to fail silently in dev and 4 workflows to be permanently red. In prod this works. The broader ambition would be to add heartbeats + freshness sources to dashboard-adjacent jobs that don't yet expose them. |
| Why it matters now | The narrow piece — restoring schema parity in dev — is a real blocker: it prevents end-to-end testing of any Track 1 work and means the trust strip cannot be exercised against the actual scheduler heartbeats. The broader piece (more jobs, more observability) is largely invisible to reps until prod actually breaks. |
| User pain removed | None directly today (prod is fine). Indirectly: enables future trust-signal work and unblocks dev test feedback loops. |
| Key files / jobs | `migrations/`, `drizzle.config.ts`, the existing scheduler files (`server/availableFreightScheduler.ts`, `server/loadFactScheduler.ts`, `server/healthAlertScheduler.ts`, `server/services/mailboxWatchdogService.ts`, `server/lib/cronHeartbeat.ts`, `cron_heartbeats` table). Already captured by **Task #1129 (PROPOSED): "Make schema updates safe to apply with one command"**. |
| Risk level | Low (the prereq slice) → Medium (the broader heartbeat-everywhere ambition). |
| Blast radius | The narrow slice: dev only. Broader: server-wide. |
| Reversibility | High for the narrow slice. |
| Sequencing complexity | Trivial for the narrow slice. The broader work is a multi-week investment with low rep-visible payoff in the near term. |

---

## C. Recommended Phase 2 track

**Primary: Track 1 — Data-model / source-of-truth cleanup**, with a
**tiny Track 3 prerequisite** (the existing PROPOSED Task #1129 alone —
*not* the broader pipeline ambition).

### Why Track 1 first

1. **Throughline continuity.** Phase 1.5's promise was "the dashboard
   tells the truth." We made the *signals* honest. The next honest
   thing to do is make the *joins* honest — the same trust contract,
   one layer deeper.
2. **Reps are about to start trusting these numbers.** The first
   phantom-customer experience after Phase 1.5 is a credibility crater.
   Closing the alias-matching gap is the highest-marginal-trust
   investment available.
3. **It's the only track with a concrete, in-code, today-visible
   risk.** Tracks 2 and 3 are about *future* pain. Track 1's risk
   already exists at `server/routes/dashboard.ts` L203 and L215.
4. **It naturally prepares Track 2.** Extracting the alias resolver
   out of `dashboard.ts` shrinks the 2,762-line monolith and gives
   the layout pass a cleaner surface to refactor against.

### Why a tiny Track 3 prerequisite

The 4 failing workflows are *all* dev-DB schema drift (verified —
`clerk_user_id`, `provider_message_id`, `last_inbox_notification_at`,
`is_manual`, `cron_heartbeats`). Without Task #1129 ("one-command
schema push") landed first, any Track 1 service-layer work cannot be
verified end-to-end in dev. This is one task, scope already proposed,
**not** the start of a broader scheduler-hardening sprint.

### What we should explicitly *not* do yet

- **Do not start Track 2 (layout pass) yet.** The dashboard works.
  Reorganizing right after a trust retrofit dilutes the trust gains
  and is better done after Track 1 reduces the relevant code surface.
- **Do not pursue the broader Track 3 ambition** (heartbeats for every
  remaining job, observability surfaces). The schedulers that power
  the trust strip already have the freshness signals they need;
  expanding observability for jobs that don't surface on the dashboard
  is a low rep-visible payoff today.
- **Do not bundle.** Pick one. Track 1 with the #1129 prereq is the
  full scope.

---

## D. Next 4 tasks in execution order

### Task #P2.0 (= existing proposed Task #1129) — One-command dev schema push

- **Diagnosis:** Dev DB drifted from `shared/schema.ts`. 4 workflows
  red, every dev request to `/api/auth/me` 500s (`column
  "clerk_user_id" does not exist`), `mailboxWatchdogService` throws
  unhandled rejections every minute, `cron_heartbeats` writes silently
  fail. Without parity, no Track 1 service change is verifiable.
- **Files / tables:** `migrations/`, `drizzle.config.ts`,
  `package.json` script entry, dev DB.
- **Order rationale:** Strict prerequisite. Everything below assumes
  a green dev environment.
- **Risks / rollout:** Low — schema push is well-understood. Add a
  reconciliation script per the `post_merge_setup` skill so the next
  task agent merge auto-runs it.

### Task #P2.1 — Promote `companies.financialAlias` to a proper alias table

- **Planning artifact (2026-05-07):** Full design + 7-step phased
  rollout plan now lives in
  [`docs/company-financial-aliases-plan.md`](./company-financial-aliases-plan.md).
  Implementation has not started — that doc is the contract P2.2+
  builds against.
- **Diagnosis:** Aliases live as a single denormalized text column on
  `companies`, which forces every consumer to do bidirectional
  substring matching. A real `company_financial_aliases` table makes
  the matching exact, the provenance auditable, and the quarantine
  surface possible.
- **Files / tables:** `shared/schema.ts` (new `company_financial_aliases`
  table: `companyId`, `orgId`, `alias`, `aliasNormalized`, `source`
  enum {`migration`,`admin`,`heuristic`}, `confirmedBy`, `confirmedAt`,
  `createdAt`), Drizzle migration, backfill script that splits the
  existing column. Keep the column denormalized for one release.
- **Order rationale:** Schema first; no resolver work makes sense
  without the table.
- **Risks / rollout:** Medium. Phased: (a) add table + backfill, (b)
  dual-read window where readers consult both, (c) cut readers over,
  (d) deprecate the column. Pin the dual-read invariant in a new
  guardrail section.

### Task #P2.2 — Strict alias resolver service + replace `.includes()` callers

- **Diagnosis:** Replace bidirectional `.includes()` matching at
  `server/routes/dashboard.ts` L203/L215 (and the parallel `normName`
  helpers in `nbaPhase1Engine.ts` / `carrierScorecardService.ts`)
  with a single `resolveCompanyByFinancialAlias(orgId, rawName)`
  service. Resolution order: exact match → confirmed-alias match →
  **quarantine** (do not silently best-guess).
- **Files:** new `server/services/aliasResolver.ts` + tests;
  call-site replacements in `server/routes/dashboard.ts`,
  `server/growthScoreCalculator.ts`, `server/nextBestActionEngine.ts`,
  `server/healthAlertScheduler.ts`, `server/dailyDigestScheduler.ts`,
  `server/chatbot.ts`, `server/services/copilot/copilotEntityResolution.ts`.
  Delete the duplicate `normName` definitions.
- **Order rationale:** Depends on P2.1 (the table exists), unblocks
  P2.4 (quarantine surface).
- **Risks / rollout:** Medium-high. Will surface previously-hidden
  mismatches as quarantine entries — **expect an initial spike**.
  Land behind a per-org feature flag; compare resolver output against
  the legacy matcher in shadow mode for one week before flipping.

### Task #P2.3 — Lane-string normalization for Coverage Gaps / Award Health

- **Diagnosis:** Coverage Gaps and Award Health currently match lanes
  via ad-hoc `toLowerCase().replace()` plus ILIKE. Same fuzzy-match
  problem class, smaller blast radius. Single
  `normalizeLane(origin, destination, equipment)` helper + a small
  city-alias lookup, used by both endpoints.
- **Files:** new `server/services/laneNormalize.ts`, callers in
  `server/routes/dashboard.ts` (award-health and coverage-gaps
  handlers).
- **Order rationale:** Same pattern as P2.2, lower risk; landing it
  second proves the pattern at smaller scale and validates the
  guardrail.
- **Risks / rollout:** Low-medium. Pin a guardrail section forbidding
  inline `toLowerCase().replace()` lane matching in dashboard
  handlers.

### Task #P2.4 — Phantom-quarantine surface in Admin

- **Diagnosis:** When P2.2's resolver puts a row in quarantine
  ("alias unknown"), Admin needs a way to see, classify, and confirm
  or reject it. Re-use the existing `/admin/email-derived-companies`
  console pattern (Task #1095) — same shape: list view + per-row
  promote/discard actions.
- **Files:** new `client/src/pages/admin/financial-alias-quarantine.tsx`,
  matching `server/routes/adminFinancialAliasQuarantine.ts`,
  navigation entry.
- **Order rationale:** Closes the loop. Without it, P2.2's "do not
  silently best-guess" rule means the data simply disappears —
  unacceptable for a freight-finance flow.
- **Risks / rollout:** Low. Mirrors a known good pattern.

---

## E. What to defer / not do yet

| Defer | Why |
|---|---|
| Track 2 layout pass (whole) | Reps are still adopting the new trust signals. Reorganizing now dilutes those gains. Track 1 also shrinks `dashboard.ts` enough to make a future layout pass cleaner. |
| Director-filter discoverability redesign | A real UX improvement, but it's currently *functional*, and decoupling `selectedDirectorId` from the four hand-built `?directorId=` query strings is a Track 2 sub-task. Defer with Track 2. |
| Broader Track 3 (heartbeats / observability for non-dashboard jobs) | Low rep-visible payoff. The trust strip's three signals (financials / NBA / freight) already have heartbeats; expanding to non-dashboard jobs is invisible to reps and competes for capacity with Track 1. |
| Replacing the parallel `normName` definitions outside dashboard scope (carrier scorecard, NBA Phase 1) | Touch only the dashboard-reachable callers in P2.2. The carrier-scorecard/NBA-Phase-1 helpers should migrate next, but as their own slice — not coupled to the dashboard cleanup. |
| Email-derived companies cleanup | Already governed by Task #1095. Keep separate. |
| Lane string normalization beyond Coverage / Award (e.g. recurring lanes, LWQ) | Out of dashboard scope. Could be a follow-on track once the pattern proves out. |

---

## F. Risks of bundling too much at once

1. **P2.2 will surface previously-hidden mismatches.** Bundling it
   with a layout pass would mix a quarantine spike with a UI
   reshuffle and make root-cause attribution impossible.
2. **Schema migrations need a quiet week.** P2.1 introduces a new
   table that 7+ services will eventually read from. Don't ship it
   in the same release as a layout refactor — if a freshness signal
   regresses, we need a clean bisect surface.
3. **Trust contract debt.** Each new Track 1 task should extend
   `docs/dashboard-trust-contract.md` and add a guardrail section
   (1504+) before merge. Bundling makes this discipline harder.
4. **Dev-environment risk.** Without P2.0 (Task #1129) landing first,
   all of P2.1–P2.4 are blind-deployed. Do not skip the prereq.
5. **Capacity dilution.** Track 1 alone is 4 tasks across server +
   schema + admin UI. Adding even "small" Track 2 polish in parallel
   will turn a 2-week slice into a 4-week slice with diluted trust
   signal.

---

## Appendix — Evidence that grounded this plan

- Fuzzy alias matching: `server/routes/dashboard.ts` L203, L215
  (`cn === norm || cn.includes(norm) || norm.includes(cn)`).
- Single-column alias storage: `shared/schema.ts` L38
  (`financialAlias: text("financial_alias")`).
- Parallel `normName` helpers: `server/carrierScorecardService.ts`
  L252, `server/nbaPhase1Engine.ts` L105, plus the inline `normN` in
  `server/routes/dashboard.ts` L1544.
- Dashboard.tsx size: 2,762 lines; 26 inline role gates; 4 hand-built
  `?directorId=` query strings.
- Failing workflows root cause (all dev-DB drift):
  `column "clerk_user_id" does not exist`,
  `column "provider_message_id" does not exist`,
  `column "last_inbox_notification_at" does not exist`,
  `column "is_manual" does not exist`,
  `relation "cron_heartbeats" does not exist`.
- `mailboxWatchdogService` is throwing **unhandled promise rejections
  every minute** in dev because of the `last_inbox_notification_at`
  drift — visible in `Start application` logs.
- `cron_heartbeats` table missing in dev means every scheduler
  heartbeat write silently fails, which would prevent end-to-end
  testing of any trust-signal work.
- Existing **Task #1129 (PROPOSED)** "Make schema updates safe to
  apply with one command" already captures the prereq scope.
