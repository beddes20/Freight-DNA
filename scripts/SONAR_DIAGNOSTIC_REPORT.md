# SONAR API Integration Diagnostic Report — Task #254

**Date:** 2026-04-16
**Scope:** FreightWaves SONAR + Perplexity Sonar end-to-end verification

---

## Executive Summary

| Layer | Status | Notes |
|---|---|---|
| Auth (FREIGHTWAVES_TOKEN) | PASS | 431-char bearer token configured & accepted |
| `getNationalMarketSummary()` | DEGRADED | SONAR account hits HTTP 451 on `/data/NTI/USA` and `/data/OTRI/USA` |
| `getMarketOtris()` | DEGRADED | Per-market `OTRI.<MKT>` tickers return HTTP 403 "not entitled" |
| `getLaneVotri()` / batch | DEGRADED | Per-lane `VOTRI.<QUAL>` tickers return HTTP 403; circuit breaker trips on 451s |
| `getLaneMarketRate()` | PASS (fallback) | Falls back to `national_fallback` cleanly |
| `buildVotriQualifier()` | PASS | Atlanta+Dallas → ATLDAL ✓ |
| `getPerplexityMarketContext()` | NOT CONFIGURED | `PERPLEXITY_API_KEY` env var missing → returns `null` (no fake data) |
| Express routes (HTTP) | PASS | All 5 routes return HTTP 200 with proper degraded payloads |
| Circuit breaker | PASS | Trips on HTTP 451; 30-min cooldown enforced |
| Caching layer | BUG FOUND + FIXED | Null-payload poisoning eliminated; verified clean post-fix |

**Root cause of degraded data:** the connected FreightWaves SONAR account does not have entitlements for the requested tickers. This is an **account/subscription issue**, not a code bug. All code paths handle the failure modes correctly (no fake data, isStale flagged, circuit breaker engages).

---

## 1. Direct SONAR API Probes (raw curl)

```
GET /data/OTRI/USA/<weekAgo>/<today>      → 451 "would exceed your maximum record limits"
GET /data/NTI/USA/<weekAgo>/<today>       → 451 "would exceed your maximum record limits"
GET /data/VCRPM1/USA/<weekAgo>/<today>    → 200 [] (empty array)
GET /data/OTRI.ATL/<weekAgo>/<today>      → 403 "not entitled to ticker $OTRI.ATL"
GET /data/OTRI.DAL/<weekAgo>/<today>      → 403 "not entitled to ticker $OTRI.DAL"
GET /data/VOTRI.ATLDAL/<weekAgo>/<today>  → 403 "not entitled to ticker $VOTRI.ATLDAL"
```

**Action required (non-code):** contact `cs@gosonar.com` / FreightWaves sales to expand ticker entitlements and raise the record-limit cap. Until then, all SONAR-derived metrics surface as `null` with `isStale: true`.

---

## 2. Express Route HTTP Probes (post-fix)

| # | Method | Route | HTTP | Latency | Sample (truncated) |
|---|---|---|---|---|---|
| 1 | GET | `/api/sonar/market-pulse` | **200** | 10 ms | `{"otri":null,"ntiPerMove":null,…,"isStale":true,"marketDataLimited":true,"marketDataResumesAt":"2026-04-16T17:40:16Z"}` |
| 2 | GET | `/api/sonar/market-otris?markets=Atlanta,Dallas,Chicago,Los%20Angeles` | **200** | 13 ms | `{"otris":[{"market":"Atlanta","otri":null,"signal":null,…},{"market":"Dallas",…},…]}` |
| 3 | GET | `/api/sonar/lane-signals?origin=Atlanta&destination=Dallas` | **200** | 451 ms | `{"signal":{"qualifier":"ATLDAL","votri":null,"isStale":true,…},"tracSpotRpm":null}` |
| 4 | POST | `/api/sonar/lane-signals/batch` (2 lanes) | **200** | 271 ms | `{"signals":[{"qualifier":"ATLDAL",…},{"qualifier":"CHILAX",…}]}` |
| 5 | GET | `/api/intel` | **200** | 20.3 s | 398 KB JSON aggregate (rep list, market+lane signals, momentum) |

All routes are publicly reachable, return well-formed JSON, surface circuit-breaker state where relevant (`marketDataLimited`/`marketDataResumesAt`), and tolerate the upstream SONAR degradation without throwing.

---

## 3. Server-Side Function Diagnostic (post-fix)

Source: `scripts/test-sonar-apis.ts`, results captured at `/tmp/sonar-test-postfix.log`.

```
========== RESULTS SUMMARY (POST-FIX) ==========
STATUS  TIME       TEST                        NOTE
PASS       1ms     getNationalMarketSummary cache    2nd call 1ms (1st 24289ms) — cache HIT
PASS       0ms     buildVotriQualifier               got ATLDAL
PASS       1ms     getLaneVotrisBatch                0/4 live (degraded but well-formed)
WARN   24289ms     getNationalMarketSummary          All metrics null; lastSuccessfulPull=null  ← SONAR 451
WARN       1ms     getMarketOtris                    0/4 markets returned live OTRI values     ← SONAR 403
WARN       0ms     getLaneVotri                      qualifier=ATLDAL VOTRI=null stale=true    ← SONAR 403
WARN      22ms     getLaneMarketRate                 $null/mi source=national_fallback         ← graceful fallback
WARN       1ms     getPerplexityMarketContext        PERPLEXITY_API_KEY not configured
WARN       0ms     circuitBreaker                    OPEN — tripped on 451, resumes in 30 min

Total: 9  PASS: 3  WARN: 6  FAIL: 0
```

**Pre-fix vs post-fix delta:**
- Pre-fix: 2 PASS / 7 WARN. Warm national call took **36 027 ms** (cache miss — null payload had been persisted then expired in-memory while DB still held nulls, causing repeat live-fetch).
- Post-fix: 3 PASS / 6 WARN. Warm national call now **1 ms** (clean cache HIT on the in-process value; null payload no longer pollutes DB).

---

## Bugs Found & Fixed

### Bug #1 — Null-data cache poisoning (CRITICAL, FIXED)

**Symptom:** When SONAR returned errors, the OTRI per-market handler and the national-summary handler both persisted the resulting all-null payloads to `api_response_cache` for 6 h / 2 h respectively. On the next request, the cache served the null payload and the system never re-attempted SONAR until the TTL expired.

**Evidence:** `SELECT count(*) FROM api_response_cache WHERE source='sonar' AND response->>'otri' IS NULL AND response->>'votri' IS NULL;` returned **694** poisoned rows.

**Fix applied** (`server/sonarClient.ts`):
- `getMarketOtris()`: only call `persistToDbCache()` when `otri !== null`.
- `getNationalMarketSummary()`: only persist when at least one of `otri`, `ntiPerMove`, `ntiPerMile` is non-null.
- (Pre-existing) `getLaneVotri()` already guarded with `if (!isStale)` — no change needed.

**Cleanup:** purged all 694 poisoned rows from `api_response_cache` and verified post-fix that no further null rows have appeared (`sonar_rows = 0`). In-memory caches still populate to prevent rate-limit stampede within the same process.

### Issue #2 — `PERPLEXITY_API_KEY` not configured (NON-BLOCKING)

`getPerplexityMarketContext()` correctly returns `null` when the key is absent, and downstream code (`/api/intel`) tolerates a null context. Add the secret if Perplexity-driven market commentary is desired.

---

## Test Harness

- Script: `scripts/test-sonar-apis.ts` — typed `Timed<T>` helper, no `any`/`as any` shortcuts on call sites, file-logging to survive backgrounding.
- Run: `npx tsx scripts/test-sonar-apis.ts` (writes results to `/tmp/sonar-test.log`).
- Coverage: env check, national summary (cold + warm), market OTRIs (4 markets), lane VOTRI single + batch, lane market rate, Perplexity context, circuit-breaker status.

Route-level probes were executed via curl against the running dev server; results are tabulated in section 2 above.

---

## Conclusion

**Code health: PASS.** The SONAR integration is structurally sound — auth works, rate limiting works, the circuit breaker trips correctly on 451, fallbacks degrade gracefully without inventing data, and all five Express routes respond with well-formed JSON.

**Data health: DEGRADED, external.** All null/stale responses trace to the SONAR subscription's missing ticker entitlements and exceeded record limits. Resolve with the FreightWaves account team.

**Code fix delivered & verified:** null payloads no longer poison the persistent DB cache; once entitlements are restored, the system will start returning live data immediately rather than waiting out a 6-hour stale-null TTL.
