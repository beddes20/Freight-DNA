# Dashboard Trust Contract

**Status:** active · **Owner:** Dashboard / Trust surface · **Last updated:** 2026-05-07
**Pinned by:** `tests/code-quality-guardrails.test.ts` Sections 1500 / 1501 / 1502 (and Section 1503 — doc discoverability)

This document is the single place a future engineer or agent should open
to understand what is intentionally trust-hardened on the AM / NAM /
Director dashboard, what is intentionally **not**, and which patterns
must be preserved when adding or modifying a portlet.

It is intentionally compact. If a rule lives only in a Slack thread or a
PR description, it does not exist — encode it here or in a guardrail
section.

---

## 1. Why this exists

The dashboard mixes signals with very different reliability:

- some come from a single upstream job with a real `lastUpdatedAt`
- some are *merged* from multiple client queries with no shared timestamp
- some are derived from rep-entered data (touchpoints, contacts) where
  "freshness" is meaningless or even misleading
- some are intentionally empty until the rep takes action

Pre-trust-hardening, all of these surfaces looked equally confident.
That cost rep trust. The contract below ensures that future changes
preserve the distinction between **"we know"**, **"we know it's stale"**,
**"we don't know"**, and **"one of the inputs failed"** — and never
collapses the latter three into a misleading "all clear".

---

## 2. Trust primitives

These are the only trust primitives a new portlet should reach for. Do
not invent parallel ones.

| Primitive | Source file | What it does |
|---|---|---|
| `PortletState` | `client/src/lib/portletState.ts` | Discriminated state: `"rows" \| "hidden" \| "stale" \| "unknown"`. |
| `decidePortletState(rows, freshness)` | `client/src/lib/portletState.ts` | The **only** sanctioned way to map `(rows, freshness)` → `PortletState`. Critically: an empty list with `freshness.status === "unknown"` collapses to `"unknown"`, **never** to `"stale"`. |
| `PortletFreshness` | `shared/schema.ts` (canonical Zod-derived type; `client/src/lib/portletState.ts` exports a structurally-compatible `PortletFreshnessLike` for the state mapper) | `{ status: "ok" \| "stale" \| "unknown"; lastUpdatedAt?: string; source?: string }`. The single shape every freshness-aware endpoint must return. |
| `PortletStateBanner` | `client/src/components/dashboard/PortletStateBanner.tsx` | Renders the amber stale banner / neutral grey unknown banner. The only sanctioned banner for empty-with-context. |
| `AsOfLabel` | `client/src/components/dashboard/AsOfLabel.tsx` | Renders the "As of <Month YYYY> upload" / "Data may be stale — last monthly refresh …" / "Freshness unavailable" trio for monthly-upload-backed surfaces. |
| `PipelineHealthStrip` | `client/src/components/dashboard/PipelineHealthStrip.tsx` | Compact top-of-page summary aggregating the three trustworthy freshness signals modeled by `DashboardHealth`: `financials` (financial-uploads job), `nba` (recommendations / `nba_cards.createdAt`), and `freight` (load-fact import heartbeats). Read-only; never invents trust the underlying primitives don't already expose. |

### 2.1 Inviolable rules

1. **`unknown` must never be presented as `stale`.** Stale (amber) is a
   *positive* claim that we know the data is old. Unknown (neutral grey)
   is "we cannot verify freshness". Collapsing the two re-introduces
   the trust gap the contract closed. Pinned by Section 1500.
2. **Empty + non-trust-aware = empty.** A portlet with no rows and no
   freshness signal renders the rep-friendly empty state — never an
   amber banner, never a fabricated "as of" line.
3. **Intentional silent / structural empties require an inline comment.**
   If a list is allowed to render nothing without an empty state (e.g.
   the row is structurally hidden by the surrounding layout), the call
   site needs a `// allow: <reason>` comment so the empty-state pin
   knows it's deliberate.
4. **Non-freshness-aware portlets need a documented opt-out.** Any
   dashboard portlet that does *not* call `decidePortletState` must
   carry the literal sentinel comment

   ```
   // dashboard-portlet-no-freshness: <one-paragraph justification>
   ```

   at the top of its file. The justification must say *why* there is
   no honest single freshness signal (typically: rep-entered inputs, or
   merged-multi-query with no shared timestamp). Pinned by Section 1500.
5. **Merged-multi-query portlets must surface degraded inputs.** Any
   portlet that merges N independent client queries must accept the
   parent's `isError` flags and render an explicit "results may be
   incomplete" indicator when any of them fail, plus an explicitly
   distinct empty-state when degraded. The reference implementation
   is `AccountsDriftingPortlet.degradedSources` (Section 1502).

### 2.2 Empty-state clarity

For surfaces where the **empty list is itself the desirable state**
(Today's Five and Cold Contacts), the empty branch must:

- be explicitly rendered (not silently `&&`-gated away)
- carry a stable `data-testid="empty-<surface>"`
- use "All clear" copy or equivalent positive phrasing

Pinned by Section 1501.

---

## 3. Surface inventory

The current dashboard surfaces and what trust signal each one carries.

| Surface | Source file | Trust signal | Freshness source / opt-out reason | Role gate |
|---|---|---|---|---|
| Sync Alert | `client/src/components/dashboard/SyncAlert.tsx` (rendered top-of-dashboard) | Visible system banner | Live `/api/integrations/health` poll — surfaces real connector failures | All relevant roles (AM, NAM, Director) |
| Award Health | `client/src/pages/dashboard/AwardHealthPortlet.tsx` | `decidePortletState` + `PortletStateBanner` | `freshness` from `/api/dashboard/award-health` (real `lastUpdatedAt` from the freight-daily-upload job) | **AM only** (gated by `{isAm && ...}` in `dashboard.tsx`) |
| Coverage Gaps | `client/src/pages/dashboard/CoverageGapsPortlet.tsx` | `decidePortletState` + `PortletStateBanner` | `freshness` from `/api/dashboard/coverage-gaps` (same upstream as Award Health) | **AM only** (gated by `{isAm && ...}` in `dashboard.tsx`) |
| NBA Cards | `client/src/components/NbaDashboardPanel.tsx` | `decidePortletState` + `PortletStateBanner` | `freshness` from `/api/nba/cards` (NBA generator job timestamp) | AM (primary), NAM (secondary) |
| Trending Accounts | `AmPortlets.tsx` / `NamPortlets.tsx` / `DirectorPortlets.tsx` (each role bundle has its own scoped block) | `AsOfLabel` | `/api/dashboard/trending-accounts` upload-as-of label (each role queries its own scoped variant; the Director query also takes a `directorId` filter) | **AM, NAM, and Director** all have a Trending block — adding a new role must explicitly choose whether to include one. |
| Margin Metrics | `client/src/pages/dashboard.tsx` (margin block, rendered via the role portlet bundles) | `AsOfLabel` | `freight_daily_upload_fact` upload-as-of label | NAM / Director |
| Pipeline Health Strip | `client/src/components/dashboard/PipelineHealthStrip.tsx` | Aggregates the `DashboardHealth` triad: `financials`, `nba` (recommendations), and `freight` | Pure read of the three primitives — invents nothing | AM / NAM / Director |
| Today's Five | `client/src/pages/dashboard.tsx` | Empty-state clarity (Section 1501) | Rep-derived "next 5 actions" — empty IS the desired state when the rep is caught up. No upstream freshness signal would be honest. | AM |
| Cold Contacts | `client/src/pages/dashboard.tsx` | Empty-state clarity (Section 1501) | Derived from `touchpoints` (rep-entered, can be backdated). Empty = no overdue contacts. | AM |
| AccountsDriftingPortlet | `client/src/pages/dashboard/Phase2Portlets.tsx` | `degradedSources` indicator (Section 1502). **Opted out** of freshness primitive. | Merges three independent queries (`stale-accounts` / `cold-contacts` / `meaningful-overdue`) with no shared upstream timestamp. The positive path can't honestly carry a single freshness signal — but the **degraded** path now does. | AM |
| Relationship Advancement | `client/src/pages/dashboard/Phase2Portlets.tsx` | None (rep-entered) | Reads `contacts.relationshipBase` + `nextSteps` — entirely rep-curated. Same opt-out paragraph as AccountsDrifting (shared file header). | AM |
| Growth Calls | `client/src/pages/dashboard/Phase2Portlets.tsx` | None (opportunity-derived) | Derived from `opportunity-leaderboard` which doesn't currently expose a job timestamp. Same opt-out paragraph. | AM |

If you add a row, also update the file header comment(s) it references
and the relevant guardrail section.

---

## 4. Role-gate model for trust surfaces

Role gates are computed once near the top of `client/src/pages/dashboard.tsx`
from `currentUser?.role`:

- `isAm`        — `account_manager`
- `isNam`       — `national_account_manager` | `sales`
- `isDirector`  — `admin` | `director` | `sales_director`
- `isLmRole`    — `logistics_manager` | `logistics_coordinator` (typically gates *out* of attention/freshness surfaces — they consume the load board, not the trust strip)
- `isAdmin`     — `admin`

Trust-surface rules:

- A freshness-aware portlet must respect the role gate of whatever
  endpoint it calls (e.g. NBA is AM-primary; Award Health is broader).
- Hiding a portlet for a role is **not** an honesty problem — the trust
  contract only governs what is *shown*. Hidden surfaces have no
  contract obligations.
- Adding a new role must not *implicitly* unhide a portlet — every
  `isAm && <Portlet/>` style gate is the explicit allow-list.

---

## 5. When you add or modify a dashboard surface

Pre-flight checklist:

- [ ] Is this surface freshness-aware?
  - **Yes** → use `decidePortletState` + `PortletStateBanner` + `PortletFreshness`. Do not render bespoke amber banners.
  - **No** → add the `// dashboard-portlet-no-freshness: <reason>` sentinel at the top of the file and link the relevant guardrail section.
- [ ] Does this surface merge multiple client queries?
  - **Yes** → accept the parent's `isError` flags via a `degradedSources`-style prop and render a degraded-input indicator + a distinct degraded-empty branch (see `AccountsDriftingPortlet`, Section 1502).
- [ ] Is empty the desired state?
  - **Yes** → render an explicit "All clear" empty branch with `data-testid="empty-<surface>"` (see Section 1501). Never silently `&&`-gate the surface away.
- [ ] Does this surface need a new role gate?
  - Compute it once in `dashboard.tsx`, then use the boolean — never inline `currentUser?.role === "..."` checks at render sites.
- [ ] Update this doc's surface inventory (§3) and add/extend the
      relevant guardrail section in `tests/code-quality-guardrails.test.ts`.

---

## 6. Pinned guardrail sections

| Section | File | Pins |
|---|---|---|
| 1500 | `tests/code-quality-guardrails.test.ts` | Freshness envelope: `unknown` ≠ `stale`, opt-out sentinel comment is required, `decidePortletState` is the only state mapper. |
| 1501 | `tests/code-quality-guardrails.test.ts` | Empty-state clarity for Today's Five + Cold Contacts (explicit empty branch, "All clear" copy, stable testids). |
| 1502 | `tests/code-quality-guardrails.test.ts` | AccountsDrifting degraded-input contract (`degradedSources` prop, distinct degraded-empty testid, dashboard.tsx `isError` capture for all three queries). |
| 1503 | `tests/code-quality-guardrails.test.ts` | This doc's discoverability: file exists, opt-out sentinels in `Phase2Portlets.tsx` and `PipelineHealthStrip.tsx` reference it. |

---

## 7. Out-of-scope (intentionally not freshness-driven today)

The following are **deliberately** not on the freshness-primitive
contract. Re-opening any of them is a contract change and needs an
update to this doc + the relevant guardrail section, not just a code
change:

- **Email-facts derivation.** No honest single timestamp exists
  upstream; the email-derived companies path is governed by Task
  #1095, not by this contract.
- **Drifting positive-path freshness.** Three independent queries with
  no shared upstream timestamp. The degraded-input contract (Section
  1502) is the agreed-upon honest replacement.
- **Relationship Advancement / Growth Calls.** Rep-entered or
  opportunity-derived inputs without a job timestamp.

If a real upstream timestamp ever appears for any of these, migrate to
`decidePortletState` + `PortletStateBanner` and remove the opt-out
sentinel — don't bolt freshness on alongside.
