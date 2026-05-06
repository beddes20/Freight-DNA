# SONAR Data Surfaces — Audit (Task #740)

This document inventories every UI, scheduler, email, NBA pipeline, and AI tool
that consumes FreightWaves SONAR (and its TRAC sibling) data. For each surface
we list:

| Field | Meaning |
|-------|---------|
| **Surface** | The user-visible feature or background job. |
| **Caller tag** | The `withSonarCaller` tag attached to live calls so they show up in `/api/sonar/health` and the Integrations Health Console. |
| **Cache strategy** | Which `sonarClient` cache the surface relies on. |
| **Live-call budget** | Whether this surface is allowed to trigger a live (cache-miss) SONAR call. |
| **Empty / stale UX** | What the user sees when the breaker is open, the daily snapshot is missing, or the lane is unsupported. |

The single source of truth for the in-process caches is
`server/sonarClient.ts`:

- `nationalCache` — 25 h TTL, refreshed by the **daily refresh scheduler** at
  04:30 CT.
- `otriCache` (per-market) — 25 h TTL, refreshed by the same scheduler for the
  top 15 markets.
- `votriCache` (per-lane) — 6 h TTL, on-demand from quote / lane / NBA paths.
- `laneMarketRateCache` (TRAC + forecast) — 6 h TTL, same on-demand callers.
- `eiaDieselCache` — 24 h TTL, the only EIA fetch (not SONAR).

All callers honour `getSonarCircuitBreakerStatus()`: when the shared breaker is
open, `sonarGet` short-circuits to `null` and the caller falls back to the
cached value (with `isStale: true`) or returns the documented "no data" shape.

---

## Live-call budget

Only the following surfaces are allowed to trigger a *live* (cache-miss) SONAR
call. Everything else is **hard-blocked** by `sonarGet` — the call returns
`null`, the `budgetSkipped` counter is bumped, and the surface falls back to a
cached snapshot or an explicit "Market data unavailable / Stale" pill.

| Allowed surface | Caller tag (`ALLOWED_LIVE_CALLERS`) | Why |
|-----------------|--------------------------------------|-----|
| Quote workbench / spot quote search | `ui:quote-workbench` (via `pricing:blend`) | A quote is a brand-new lane the system may not yet have a fresh VOTRI / TRAC rate for. |
| Lane detail (`/api/sonar/lane-signals`) | `ui:lane-detail` | Single-lane drill-down is necessarily on-demand. |
| NBA Phase 1 builder | `scheduler:nba-phase1` | The builder needs a per-lane VOTRI WoW snapshot once per cycle. |
| Daily refresh scheduler | `scheduler:daily-refresh` | One pull per 24 h to seed the national + top-market caches. |
| Admin "test now" probe | `admin:probe` | Manual button on the Integrations Health Console. |
| `/api/sonar/health` self-test | `admin:health` | Health endpoint may issue a single lane probe. |

Every other surface is cache-only. The per-caller call counters in
`/api/sonar/health.callBudget` expose:
- `budgetSkipped` — a non-allowed caller hit a cache miss and was forced to
  return null (expected for `ui:lane-signals`, `ui:market-pulse`, AI tools
  without a warm bundle, etc.).
- `unexpectedLiveCallers[]` — any caller tag with `live > 0` outside the
  allowed list. This list should always be empty in production.

---

## Surface inventory

### UI

| Surface | Caller tag | Cache strategy | Live budget | Empty / stale UX |
|---------|------------|----------------|-------------|------------------|
| `client/src/pages/intel.tsx` (Intel Dashboard) | `ui:intel-dashboard` | Reads `getOrComputeSonarBundle()` (90-second per-org bundle cache wrapping the `national`, `marketOtris`, and `votriByQualifier` caches). | No new calls — bundles read from the daily snapshot. | `IntegrationDegradedPill source="sonar"` in header; per-row `⚠ Stale` badge from `votri.isStale`. |
| `client/src/components/sonar-market-pulse.tsx` | `ui:market-pulse` (route `/api/sonar/market-pulse`) | National cache + role-specific market OTRI bundle. | Cache-only; admin role hits `getSonarCircuitBreakerStatus()` for the `marketDataLimited` flag. | Header banner `Market data unavailable — last updated <ts>` when `pulse.isStale`. |
| `client/src/components/intel-snapshot-portlet.tsx` | `ui:intel-snapshot` | National + per-market OTRI from cache. | Cache-only. | `IntegrationDegradedPill`. |
| `client/src/pages/dashboard/DirectorPortlets.tsx` | `ui:director-portlet` | Bundle reused across admin/director roles. | Cache-only. | `marketDataLimited` flag → text override. |
| `client/src/pages/customers.tsx` (Lane heat) | `ui:lane-signals` | `getLaneVotrisBatch` from cache. | Cache-only — `ui:lane-signals` is **not** in `ALLOWED_LIVE_CALLERS`, so any cache-miss gets `budgetSkipped` and the row falls back to a stale pill. | `votri.isStale` → grey "—" instead of a number. |
| `client/src/components/market-share-portlet.tsx` & `market-share-card.tsx` | `ui:market-share` | National summary only. | Cache-only. | Card shows `Market data unavailable`. |
| `client/src/components/sonar-votri-badge.tsx` | (rendering only) | Reads `votri.isStale` from server payload. | n/a. | Renders a slate "Stale" pill instead of the heat color. |
| `client/src/components/lane-signals/useLaneSignals.ts` | `ui:lane-signals` | Batched lane VOTRI fetch via `/api/sonar/lane-signals`. | Cache-first; lane-detail drill-down is on-demand and counts toward the live budget. | Returns `signal=null` + `isStale=true`; consumer renders a degraded pill. |
| `client/src/pages/company-detail/tabs/RfpTab.tsx` | `ui:rfp-tab` | National + per-lane VOTRI from cache. | Cache-only. | RFP card shows `Market data unavailable` row instead of a synthetic delta. |
| Spot Quote Search (`SpotQuoteSearch.tsx`) | `ui:quote-workbench` | National + lane VOTRI + lane market rate. | **Allowed** — fresh on quote create. | "Market data unavailable" empty state when the lane has no TRAC + national fallback is null. |

### Schedulers

| Surface | Caller tag | Cadence | Live budget | Notes |
|---------|------------|---------|-------------|-------|
| `sonarDailyRefreshScheduler` | `scheduler:daily-refresh` | 04:30 CT daily + boot if no success in 26 h. | **Allowed** — the only scheduled live pull for the national + top-market snapshots. | Fires admin notification on null result. |
| `nbaPhase1Scheduler` | `scheduler:nba-phase1` | 05:00 CT daily, after the daily refresh. | **Allowed** — uses `getLaneVotrisBatchFresh` for lane VOTRI WoW deltas. | `getAvgVotriWoW` aggregates with cache-first reads. |
| `intelEmailScheduler` (daily) | `email:daily-intel` | 07:00 CT weekday. | Cache-only — reads the national and per-market OTRI snapshots seeded by the daily refresh. | Honest "Market data unavailable" inline banner when null; new "📊 SONAR call summary" row pulled from the call counter ledger. |
| `intelEmailScheduler` (bi-weekly scorecard) | `email:biweekly-scorecard` | Every other Monday 07:30 CT. | Cache-only. | Same fallback behaviour as daily. |
| `marketSignalEngine` / `marketSignalScheduler` | n/a (no SONAR) | — | — | Reads `market_events` only; not a SONAR consumer. |

### NBA + Pricing

| Surface | Caller tag | Cache strategy | Live budget | Notes |
|---------|------------|----------------|-------------|-------|
| `pricingBlendService.getBlendedRate` → `sonarTracPricingClient.getSonarLanePricing` | `pricing:blend` (calls under the workbench / cockpit / carrier-intelligence-scoring entry points inherit it) | TRAC + lane market rate cache. | **Allowed indirectly** — when a quote workbench, freight opportunity cockpit, or carrier ranking job needs a fresh blend it counts under this tag. | Returns `legs.sonar.source = "national_fallback"` with low confidence when TRAC has no lane data; UI shows the source on the score breakdown. |
| `routes/freightOpportunityCockpit` | `ui:freight-opp-cockpit` | Cached lane VOTRI / market rate via `getBlendedRate`. | Cache-only — relies on the workbench tag for new lanes. | UI flag `marketDataLimited` mirrored when `isStale`. |
| `routes/carrierIntelligenceScoring` | `ui:carrier-ranking` | `getBlendedRate` from cache for ranking. | Cache-only. | Score card surfaces `sonarSparseBumpAmount` and the `sonar_weight_auto_bumped` trace when history is sparse. |
| `routes/valueiq` (`/api/valueiq/health`) | `admin:valueiq-health` | Reads `getSonarCircuitBreakerStatus()` only — no live call. | Cache-only. | Admin diagnostic. |

### Admin / probes

| Surface | Caller tag | Notes |
|---------|------------|-------|
| `/api/sonar/health` | `admin:health` | Exposes auth mode, daily-pull status, breaker, the lane probe (ATL→DAL by default), the lane-timeout aggregator, and the new per-caller call counter ledger. |
| `/api/admin/integrations/health/sonar/test` | `admin:probe` | Live SONAR probe behind the "Test now" button. |
| `client/src/pages/admin-integrations-health.tsx` | (UI only) | Renders the SONAR detail block including today's calls, by-caller breakdown, breaker state, and the daily pull summary. |

### AI tools (server/agent/tools.ts)

| Tool | Caller tag | Empty / stale UX |
|------|------------|------------------|
| `query_national_rates` | `ai:query_national_rates` | Header reads `FreightWaves Sonar — National Pulse ⚠ Stale` when `pulse.isStale`; each individual line falls back to `unavailable` when the field is null. Throws → `Sonar national data temporarily unavailable.` |
| `query_market_otri` | `ai:query_market_otri` | When the market exists in cache but every metric is null, returns `Sonar market — <market>: no live OTRI/VOTRI data available right now.` |
| `query_lane_signal` | `ai:query_lane_signal` | If TRAC direction, TRAC spot, and VOTRI are all unavailable, returns `Market data unavailable for this lane.` |
| `get_rate_positioning_summary` | `ai:rate-positioning` (cached helper) | Falls back to `No rate positioning data available.` |

---

## Health endpoint shape

`GET /api/sonar/health` (admin or rep) now returns:

```json
{
  "status": "ok|degraded|down",
  "dailyAgeHours": 12.7,
  "laneTimeouts": { "date": "...", "count": 0, "samples": [], "notified": false },
  "callBudget": {
    "today": {
      "date": "2026-04-27",
      "totals": { "live": 18, "coalesced": 4, "cacheHits": 612, "breakerSkipped": 0, "budgetSkipped": 7, "errors": 0 },
      "cacheHitRatio": 0.961,
      "byCaller": {
        "scheduler:daily-refresh": { "live": 16, "coalesced": 0, "cacheHits": 0,  "breakerSkipped": 0, "budgetSkipped": 0, "errors": 0 },
        "scheduler:nba-phase1":    { "live": 2,  "coalesced": 4, "cacheHits": 41, "breakerSkipped": 0, "budgetSkipped": 0, "errors": 0 },
        "ui:lane-signals":         { "live": 0,  "coalesced": 0, "cacheHits": 0,  "breakerSkipped": 0, "budgetSkipped": 7, "errors": 0 }
      },
      "unexpectedLiveCallers": [],
      "allowedLiveCallers": ["admin:health","admin:probe","pricing:blend","scheduler:daily-refresh","scheduler:nba-phase1","ui:lane-detail","ui:quote-workbench"]
    },
    "yesterday": { ... }
  },
  "authMode": "bearer_token",
  "circuitBreaker": { "isOpen": false, "trippedAt": null, "resumesAt": null },
  "daily": { "lastRunAt": "...", "lastSuccessAt": "...", "marketsAttempted": 15, "marketsOk": 15 },
  "national": { "ok": true, "isStale": false, "fetchedAt": "...", "sample": { ... } },
  "laneProbe": { "qualifier": "ATLDAL", "ok": true, "isStale": false, "elapsedMs": 421, "sample": { ... } }
}
```

The same `callBudget` block is included in the SONAR probe `detail` object so
the Integrations Health Console can render it without a second round-trip.

---

## Alerting

| Trigger | Channel | Dedupe |
|---------|---------|--------|
| Daily refresh returned no national + zero per-market data. | Admin notification (`type=system`, link `/api/sonar/health`). | One per day. |
| ≥3 lane live-calls timed out today. | Admin notification. | One per day. |
| **NEW** — Breaker has been open ≥60 min during business hours (Mon–Fri 07:00–19:00 CT). | Admin notification. | Once per breaker-open episode. |
| Daily intel email body contains a `📊 SONAR yesterday` summary row whenever the previous day's call ledger is non-empty. | Email. | One per day. |
