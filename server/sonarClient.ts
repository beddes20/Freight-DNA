/**
 * FreightWaves Sonar API Client
 *
 * Auth:  POST /credential/authenticate  { username, password }
 *        → { token, expiry }
 *
 * Data:  GET  /data/{INDEX}/{QUALIFIER}/{DATE}
 *        DATE format: YYYY-MM-DD   (omit for latest rolling value)
 *
 * Key tickers used:
 *   VOTRI.{ORIG_DEST}   Outbound Van Tender Rejection Index — lane-level (e.g. VOTRI.ATLDAL)
 *   OTRI.{MARKET}       Outbound Tender Rejection Index — market-level (e.g. OTRI.ATL)
 *   NTI.USA             National Truckload Index $/move (spot)
 *   VCRPM1.USA          Van Contract Rate $/mile
 *   NTIL.USA            NTI prior-week value (for WoW delta)
 *
 * Caching:
 *   VOTRI / OTRI        4-hour TTL  (lane & market rejection indices)
 *   NTI / VCRPM1        1-hour TTL  (national rate indices)
 *
 * Reliability:
 *   - Circuit breaker: on HTTP 451, enters 30-min cooldown (returns cached/fallback)
 *   - Request coalescing: duplicate in-flight requests share the same promise
 *   - DB-backed cache: survives restarts, no cold-start API stampede
 *
 * When credentials are absent or Sonar is unreachable all methods fall back
 * to the last-known cached value, or to seeded defaults with isStale = true.
 */

import { storage } from "./storage";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SonarToken {
  token: string;
  expiresAt: number; // unix ms
}

interface CacheEntry<T> {
  value: T;
  fetchedAt: number; // unix ms
  ttlMs: number;
}

function isFresh<T>(entry: CacheEntry<T>): boolean {
  return Date.now() - entry.fetchedAt < entry.ttlMs;
}

export interface NationalMarketSummary {
  otri: number | null;
  otriWoWDelta: number | null;
  ntiPerMove: number | null;
  ntiWoWDelta: number | null;
  ntiPerMile: number | null;
  ratesSpread: number | null;
  flatbedOtri: number | null;
  flatbedSignal: "hot" | "cool" | "neutral" | null;
  dieselPerGal: number | null;
  dieselMoMDelta: number | null;
  dieselSource: "eia" | "estimated" | null;
  timestamp: string;
  isStale: boolean;
  lastSuccessfulPull: string | null;
}

export interface MarketExtended {
  market: string;
  otri: number | null;
  otriWoW: number | null;
  votri: number | null;
  votriWoW: number | null;
  otvi: number | null;   // Outbound Tender Volume Index
  hai: number | null;    // Headhaul/Backhaul Imbalance Index
  signal: "hot" | "warm" | "stable" | "cool" | null;
}

export interface MarketOtri {
  market: string;
  otri: number | null;
  otriWoW: number | null;
  votri: number | null;
  votriWoW: number | null;
  signal: "hot" | "warm" | "stable" | "cool" | null;
  lastSuccessfulPull: string | null;
}

export interface LaneVotri {
  origin: string;
  destination: string;
  qualifier: string;     // e.g. "ATLDAL"
  votri: number | null;
  votriWoW: number | null;
  signal: "hot" | "warm" | "stable" | "cool" | null;
  timestamp: string;
  isStale: boolean;
  lastSuccessfulPull: string | null;
}

export interface LaneSpotRate {
  origin: string;
  destination: string;
  ratePerMile: number;
  confidence: "high" | "medium" | "low";
  timestamp: string;
}

export interface LaneMarketRate {
  origin: string;
  destination: string;
  marketRatePerMile: number | null;
  forecastDirection: "TIGHTENING" | "EASING" | "STABLE";
  forecastWeeklyRates: Array<{ week: number; ratePerMile: number }>;
  confidence: "high" | "medium" | "low";
  source: "lane" | "national_fallback";
  timestamp: string;
  isStale: boolean;
  lastSuccessfulPull: string | null;
}

// ── Config ────────────────────────────────────────────────────────────────────

const SONAR_BASE = "https://api.freightwaves.com";
const TOKEN_BUFFER_MS = 5 * 60 * 1000;
const VOTRI_TTL   = 6 * 60 * 60 * 1000;
const OTRI_TTL    = 6 * 60 * 60 * 1000;
const NTI_TTL     = 2 * 60 * 60 * 1000;
const EIA_TTL     = 24 * 60 * 60 * 1000;
const TRAC_MARKET_RATE_TTL = 6 * 60 * 60 * 1000;

const SONAR_RATE_LIMIT_INTERVAL_MS = 12_000;
let lastSonarCallAt = 0;
let _sonarQueueTail: Promise<void> = Promise.resolve();

// ── Circuit Breaker (451 rate-limit protection) ───────────────────────────────

const CIRCUIT_BREAKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
let circuitBreakerTrippedAt: number | null = null;
let circuitBreakerLoggedOnce = false;

function isCircuitBreakerOpen(): boolean {
  if (circuitBreakerTrippedAt === null) return false;
  if (Date.now() - circuitBreakerTrippedAt > CIRCUIT_BREAKER_COOLDOWN_MS) {
    log("Circuit breaker reset — resuming SONAR API calls");
    circuitBreakerTrippedAt = null;
    circuitBreakerLoggedOnce = false;
    return false;
  }
  return true;
}

function tripCircuitBreaker() {
  circuitBreakerTrippedAt = Date.now();
  const cooldownMinutes = Math.round(CIRCUIT_BREAKER_COOLDOWN_MS / 60000);
  log(`⚡ Circuit breaker TRIPPED — SONAR returned HTTP 451 (record limit exceeded). All SONAR calls will return cached/fallback data for ${cooldownMinutes} minutes.`);
}

export function getSonarCircuitBreakerStatus(): { isOpen: boolean; trippedAt: string | null; resumesAt: string | null } {
  if (circuitBreakerTrippedAt === null) return { isOpen: false, trippedAt: null, resumesAt: null };
  const resumesAt = new Date(circuitBreakerTrippedAt + CIRCUIT_BREAKER_COOLDOWN_MS);
  return {
    isOpen: Date.now() - circuitBreakerTrippedAt < CIRCUIT_BREAKER_COOLDOWN_MS,
    trippedAt: new Date(circuitBreakerTrippedAt).toISOString(),
    resumesAt: resumesAt.toISOString(),
  };
}

// ── Request Coalescing ────────────────────────────────────────────────────────

const inflightRequests = new Map<string, Promise<any>>();

async function coalescedSonarGet(path: string): Promise<any | null> {
  if (inflightRequests.has(path)) {
    return inflightRequests.get(path)!;
  }
  const promise = rawSonarGet(path).finally(() => {
    inflightRequests.delete(path);
  });
  inflightRequests.set(path, promise);
  return promise;
}

// ── EIA diesel cache ──────────────────────────────────────────────────────────

interface EiaDieselResult {
  pricePerGal: number;
  weekOverWeekDelta: number;
  fetchedAt: number;
}

let eiaDieselCache: EiaDieselResult | null = null;

// ── In-memory state ───────────────────────────────────────────────────────────

let cachedToken: SonarToken | null = null;
let nationalCache: CacheEntry<NationalMarketSummary> | null = null;
const otriCache  = new Map<string, CacheEntry<MarketOtri>>();
const votriCache = new Map<string, CacheEntry<LaneVotri>>();

// ── DB Cache Warm-up (runs once on first use) ──────────────────────────────────

let _dbCacheWarmupPromise: Promise<void> | null = null;

async function warmMemoryCacheFromDb(): Promise<void> {
  if (_dbCacheWarmupPromise) return _dbCacheWarmupPromise;
  _dbCacheWarmupPromise = doWarmMemoryCacheFromDb();
  return _dbCacheWarmupPromise;
}

async function doWarmMemoryCacheFromDb(): Promise<void> {
  try {
    const validRows = await storage.getValidCachedApiResponses("sonar");
    let loaded = 0;
    for (const row of validRows) {
      const key = row.cacheKey;
      const ttlMs = row.ttlSeconds * 1000;
      const fetchedAt = new Date(row.fetchedAt).getTime();

      if (key === "national_summary" && row.response) {
        nationalCache = { value: row.response as unknown as NationalMarketSummary, fetchedAt, ttlMs };
        lastKnownNational = row.response as unknown as NationalMarketSummary;
        loaded++;
      } else if (key.startsWith("otri:") && row.response) {
        const marketKey = key.replace("otri:", "");
        otriCache.set(marketKey, { value: row.response as unknown as MarketOtri, fetchedAt, ttlMs });
        loaded++;
      } else if (key.startsWith("votri:") && row.response) {
        const qualifier = key.replace("votri:", "");
        votriCache.set(qualifier, { value: row.response as unknown as LaneVotri, fetchedAt, ttlMs });
        loaded++;
      }
    }

    if (!lastKnownNational) {
      try {
        const allSonarRows = await storage.getAllCachedApiResponses("sonar");
        for (const row of allSonarRows) {
          if (row.cacheKey === "national_summary" && row.response) {
            lastKnownNational = row.response as unknown as NationalMarketSummary;
            if (!nationalCache) {
              const fetchedAt = new Date(row.fetchedAt).getTime();
              nationalCache = { value: { ...lastKnownNational, isStale: true }, fetchedAt, ttlMs: NTI_TTL };
            }
            break;
          }
        }
      } catch {}
    }

    if (loaded > 0) {
      log(`DB cache warm-up: loaded ${loaded} fresh entries into memory (no cold-start API stampede)`);
    }
  } catch (err: any) {
    log(`DB cache warm-up failed (non-fatal): ${err.message}`);
  }
}

// ── Auth mode health-check (logged once on first use) ─────────────────────────

let _authModeLogged = false;
function logAuthMode() {
  if (_authModeLogged) return;
  _authModeLogged = true;
  const directToken = process.env.FREIGHTWAVES_TOKEN;
  if (directToken) {
    log(`Auth mode: FREIGHTWAVES_TOKEN (direct bearer token, ${directToken.length} chars) — username/password auth skipped`);
  } else {
    const hasCredentials = !!(process.env.SONAR_USERNAME && process.env.SONAR_PASSWORD);
    log(`Auth mode: ${hasCredentials ? "username/password (SONAR_USERNAME + SONAR_PASSWORD)" : "no credentials configured — all Sonar calls will return fallback data"}`);
  }
}

// ── Lane pricing verification (logged once on first live lane data) ────────────

let _lanePricingVerified = false;
function logFirstLiveLane(entry: LaneVotri) {
  if (_lanePricingVerified) return;
  _lanePricingVerified = true;
  log(
    `Lane pricing verified (first live result): ${entry.qualifier} — ` +
    `VOTRI=${entry.votri?.toFixed(2) ?? "n/a"}% WoW=${entry.votriWoW !== null ? ((entry.votriWoW >= 0 ? "+" : "") + entry.votriWoW.toFixed(2)) : "n/a"}pp ` +
    `signal=${entry.signal ?? "none"} isStale=false`
  );
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [sonar] ${msg}`);
}

// ── Authentication ────────────────────────────────────────────────────────────

async function getSonarToken(): Promise<string | null> {
  logAuthMode();

  // Prefer direct bearer token when present — no auth call needed
  const directToken = process.env.FREIGHTWAVES_TOKEN;
  if (directToken) return directToken;

  // Fall back to username/password auth flow
  const username = process.env.SONAR_USERNAME;
  const password = process.env.SONAR_PASSWORD;
  if (!username || !password) return null;

  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_BUFFER_MS) {
    return cachedToken.token;
  }

  try {
    const resp = await fetch(`${SONAR_BASE}/credential/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      log(`Auth failed: ${resp.status} ${resp.statusText}`);
      return null;
    }
    const data = await resp.json() as { token?: string; expiry?: string; expires_in?: number };
    const token = data.token;
    if (!token) { log("No token in auth response"); return null; }

    // expiry is an ISO timestamp; fall back to 1-hour TTL
    const expiresAt = data.expiry
      ? new Date(data.expiry).getTime()
      : Date.now() + (data.expires_in ?? 3600) * 1000;

    cachedToken = { token, expiresAt };
    log("Auth token refreshed");
    return token;
  } catch (err: any) {
    log(`Auth error: ${err.message}`);
    return null;
  }
}

// ── HTTP helper (with circuit breaker + 451 handling) ─────────────────────────

async function sonarGet(path: string): Promise<any | null> {
  await warmMemoryCacheFromDb();

  if (isCircuitBreakerOpen()) {
    if (!circuitBreakerLoggedOnce) {
      circuitBreakerLoggedOnce = true;
      const status = getSonarCircuitBreakerStatus();
      log(`Circuit breaker OPEN — returning cached/fallback data for all SONAR calls until ${status.resumesAt}`);
    }
    return null;
  }

  return coalescedSonarGet(path);
}

function rateLimitedWait(): Promise<void> {
  const ticket = _sonarQueueTail.then(async () => {
    const elapsed = Date.now() - lastSonarCallAt;
    if (elapsed < SONAR_RATE_LIMIT_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, SONAR_RATE_LIMIT_INTERVAL_MS - elapsed));
    }
    lastSonarCallAt = Date.now();
  });
  _sonarQueueTail = ticket.catch(() => {});
  return ticket;
}

async function rawSonarGet(path: string): Promise<any | null> {
  const token = await getSonarToken();
  if (!token) return null;
  await rateLimitedWait();
  try {
    const resp = await fetch(`${SONAR_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
    });

    if (resp.status === 451) {
      tripCircuitBreaker();
      return null;
    }

    if (resp.status === 401) {
      cachedToken = null;
      const newToken = await getSonarToken();
      if (!newToken) return null;
      const resp2 = await fetch(`${SONAR_BASE}${path}`, {
        headers: { Authorization: `Bearer ${newToken}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (resp2.status === 451) {
        tripCircuitBreaker();
        return null;
      }
      if (!resp2.ok) { log(`GET ${path} → ${resp2.status}`); return null; }
      return await resp2.json();
    }
    if (!resp.ok) { log(`GET ${path} → ${resp.status}`); return null; }
    return await resp.json();
  } catch (err: any) {
    log(`GET ${path} error: ${err.message}`);
    return null;
  }
}

// ── Value extraction ──────────────────────────────────────────────────────────

function extractValue(data: any): number | null {
  if (data == null) return null;
  if (Array.isArray(data)) {
    const latest = data[data.length - 1];
    return typeof latest?.value === "number" ? latest.value : null;
  }
  if (Array.isArray(data?.data)) {
    const arr = data.data as Array<{ value?: number; timestamp?: string }>;
    if (arr.length === 0) return null;
    const latest = arr[arr.length - 1];
    return typeof latest?.value === "number" ? latest.value : null;
  }
  if (typeof data?.value === "number") return data.value;
  return null;
}

function extractPriorValue(data: any): number | null {
  const arr: any[] = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  if (arr.length < 2) return null;
  const prior = arr[arr.length - 2];
  return typeof prior?.value === "number" ? prior.value : null;
}

// ── City → Sonar market code lookup table ────────────────────────────────────

const CITY_TO_SONAR_CODE: Record<string, string> = {
  "atlanta":       "ATL",
  "dallas":        "DAL",
  "dfw":           "DAL",
  "fort worth":    "DAL",
  "los angeles":   "LAX",
  "la":            "LAX",
  "long beach":    "LAX",
  "chicago":       "CHI",
  "houston":       "HOU",
  "new york":      "NYC",
  "newark":        "NYC",
  "elizabeth":     "NYC",
  "memphis":       "MEM",
  "phoenix":       "PHX",
  "kansas city":   "KCY",
  "detroit":       "DET",
  "seattle":       "SEA",
  "portland":      "POR",
  "miami":         "MIA",
  "Jacksonville":  "JAX",
  "jacksonville":  "JAX",
  "charlotte":     "CLT",
  "columbus":      "CMH",
  "cleveland":     "CLE",
  "cincinnati":    "CIN",
  "indianapolis":  "IND",
  "nashville":     "NSH",
  "minneapolis":   "MSP",
  "st. louis":     "STL",
  "saint louis":   "STL",
  "denver":        "DEN",
  "salt lake city":"SLC",
  "reno":          "RNO",
  "sacramento":    "SAC",
  "fresno":        "FRS",
  "san francisco": "SFO",
  "oakland":       "SFO",
  "san jose":      "SFO",
  "albuquerque":   "ABQ",
  "el paso":       "ELP",
  "san antonio":   "SAT",
  "austin":        "AUS",
  "laredo":        "LRD",
  "new orleans":   "NOL",
  "birmingham":    "BHM",
  "greenville":    "GSP",
  "spartanburg":   "GSP",
  "raleigh":       "RDU",
  "durham":        "RDU",
  "greensboro":    "GSO",
  "richmond":      "RIC",
  "baltimore":     "BWI",
  "philadelphia":  "PHL",
  "boston":        "BOS",
  "hartford":      "HFD",
  "pittsburgh":    "PIT",
  "buffalo":       "BUF",
  "louisville":    "LOU",
  "lexington":     "LEX",
  "knoxville":     "KNX",
  "charleston":    "CHS",  // SC
  "savannah":      "SAV",
  "orlando":       "ORL",
  "tampa":         "TPA",
  "omaha":         "OMA",
  "des moines":    "DSM",
  "milwaukee":     "MKE",
  "grand rapids":  "GRR",
  "st. paul":      "MSP",
  "fargo":         "FAR",
  "sioux falls":   "SFN",
  "spokane":       "GEG",
  "boise":         "BOI",
  "las vegas":     "LVN",
  "tucson":        "TUS",
  "oklahoma city": "OKC",
  "tulsa":         "TUL",
  "little rock":   "LIT",
  "jackson":       "JAN",
  "shreveport":    "SHV",
  "wichita":       "ICT",
  "topeka":        "TOP",
  "springfield":   "SPI",  // IL
};

function cityToMarketCode(city: string): string {
  const normalized = city
    .toLowerCase()
    .trim()
    .replace(/,?\s+[a-z]{2}$/, "")
    .replace(/[^a-z ]/g, "")
    .trim();
  return CITY_TO_SONAR_CODE[normalized]
    ?? CITY_TO_SONAR_CODE[city.toLowerCase().trim()]
    ?? normalized.toUpperCase().replace(/\s+/g, "").slice(0, 3).padEnd(3, "X");
}

// ── VOTRI qualifier builder ───────────────────────────────────────────────────

export function buildVotriQualifier(origin: string, destination: string): string {
  return `${cityToMarketCode(origin)}${cityToMarketCode(destination)}`;
}

export function cityToOtriMarket(city: string): string {
  return cityToMarketCode(city);
}

// ── Signal thresholds ─────────────────────────────────────────────────────────

function votriSignal(votri: number): "hot" | "warm" | "cool" {
  if (votri >= 20) return "hot";
  if (votri >= 8)  return "warm";
  return "cool";
}

function otriSignal(otri: number): "hot" | "warm" | "cool" {
  if (otri >= 20) return "hot";
  if (otri >= 8)  return "warm";
  return "cool";
}

// ── DB cache write-through helpers ──────────────────────────────────────────────

function persistToDbCache(key: string, value: unknown, ttlMs: number) {
  storage.setCachedApiResponse(key, value, Math.round(ttlMs / 1000), "sonar").catch(() => {});
}

// ── EIA Diesel Price Fetch ────────────────────────────────────────────────────

async function fetchEiaDieselPrice(): Promise<EiaDieselResult | null> {
  if (eiaDieselCache && Date.now() - eiaDieselCache.fetchedAt < EIA_TTL) {
    return eiaDieselCache;
  }

  try {
    const url = "https://api.eia.gov/v2/petroleum/pri/gnd/data/" +
      "?frequency=weekly" +
      "&data[0]=value" +
      "&facets[series][]=EMD_EPD2D_PTE_NUS_DPG" +
      "&sort[0][column]=period" +
      "&sort[0][direction]=desc" +
      "&length=2" +
      "&out=json";

    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      log(`EIA diesel fetch failed: ${resp.status}`);
      return null;
    }
    const json = await resp.json() as { response?: { data?: Array<{ period: string; value: string | number }> } };
    const rows = json?.response?.data ?? [];

    if (rows.length === 0) {
      log("EIA diesel: no data rows returned");
      return null;
    }

    const latest = parseFloat(String(rows[0]?.value ?? "0")) || 0;
    const prior  = rows.length > 1 ? (parseFloat(String(rows[1]?.value ?? "0")) || 0) : latest;
    const wowDelta = Math.round((latest - prior) * 1000) / 1000;

    const result: EiaDieselResult = { pricePerGal: latest, weekOverWeekDelta: wowDelta, fetchedAt: Date.now() };
    eiaDieselCache = result;
    log(`EIA diesel: $${latest}/gal, WoW ${wowDelta >= 0 ? "+" : ""}${wowDelta}`);
    return result;
  } catch (err: any) {
    log(`EIA diesel error: ${err.message}`);
    return null;
  }
}

export async function getEiaDieselPrice(): Promise<EiaDieselResult | null> {
  return fetchEiaDieselPrice();
}

// ── OTVI + HAI fetch for a market ─────────────────────────────────────────────

async function fetchOtviHai(marketCode: string): Promise<{ otvi: number | null; hai: number | null }> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [otviData, haiData] = await Promise.all([
    sonarGet(`/data/OTVI/${marketCode}/${yesterday}/${today}`),
    sonarGet(`/data/HAI/${marketCode}/${yesterday}/${today}`),
  ]);
  return {
    otvi: extractValue(otviData) !== null ? Math.round((extractValue(otviData) as number) * 100) / 100 : null,
    hai:  extractValue(haiData)  !== null ? Math.round((extractValue(haiData)  as number) * 100) / 100 : null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getNationalMarketSummary(): Promise<NationalMarketSummary> {
  await warmMemoryCacheFromDb();

  if (nationalCache && isFresh(nationalCache)) {
    return nationalCache.value;
  }

  const fallback = buildFallbackNational();

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

  const [otriData, ntiData, vcrpmData] = await Promise.all([
    sonarGet(`/data/OTRI/USA/${weekAgo}/${today}`),
    sonarGet(`/data/NTI/USA/${weekAgo}/${today}`),
    sonarGet(`/data/VCRPM1/USA/${weekAgo}/${today}`),
  ]);

  const otri  = extractValue(otriData);
  const otriP = extractPriorValue(otriData);
  const nti   = extractValue(ntiData);
  const ntiP  = extractPriorValue(ntiData);
  const vcrpm = extractValue(vcrpmData);

  if (nti === null && otri === null) {
    log("National market data unavailable — returning null fields (no fake data)");
    return fallback;
  }

  const ratesSpread  = (nti !== null && vcrpm !== null && vcrpm > 0)
    ? Math.round(((nti > 100 ? nti / 500 : nti) - vcrpm) * 100) / 100
    : null;

  const eiaDiesel = await fetchEiaDieselPrice();

  const summary: NationalMarketSummary = {
    otri:          otri,
    otriWoWDelta:  otri !== null && otriP !== null ? Math.round((otri - otriP) * 100) / 100 : null,
    ntiPerMove:    nti,
    ntiWoWDelta:   nti !== null && ntiP !== null ? Math.round((nti - ntiP) * 100) / 100 : null,
    ntiPerMile:    vcrpm,
    ratesSpread,
    flatbedOtri:   otri,
    flatbedSignal: otri !== null ? (otri > 25 ? "hot" : otri > 12 ? "neutral" : "cool") : null,
    dieselPerGal:  eiaDiesel?.pricePerGal ?? null,
    dieselMoMDelta: eiaDiesel?.weekOverWeekDelta ?? null,
    dieselSource:  eiaDiesel ? "eia" : null,
    timestamp:     new Date().toISOString(),
    isStale:       false,
    lastSuccessfulPull: new Date().toISOString(),
  };

  nationalCache = { value: summary, fetchedAt: Date.now(), ttlMs: NTI_TTL };
  lastKnownNational = summary;
  persistToDbCache("national_summary", summary, NTI_TTL);
  log(`National: OTRI=${summary.otri}% NTI=$${summary.ntiPerMove}`);
  return summary;
}

let lastKnownNational: NationalMarketSummary | null = null;
function buildFallbackNational(): NationalMarketSummary {
  if (lastKnownNational) return {
    otri: null,
    otriWoWDelta: null,
    ntiPerMove: null,
    ntiWoWDelta: null,
    ntiPerMile: null,
    ratesSpread: null,
    flatbedOtri: null,
    flatbedSignal: null,
    dieselPerGal: null,
    dieselMoMDelta: null,
    dieselSource: null,
    timestamp: new Date().toISOString(),
    isStale: true,
    lastSuccessfulPull: lastKnownNational.timestamp,
  };
  return {
    otri: null,
    otriWoWDelta: null,
    ntiPerMove: null,
    ntiWoWDelta: null,
    ntiPerMile: null,
    ratesSpread: null,
    flatbedOtri: null,
    flatbedSignal: null,
    dieselPerGal: null,
    dieselMoMDelta: null,
    dieselSource: null,
    timestamp: new Date().toISOString(),
    isStale: true,
    lastSuccessfulPull: null,
  };
}

export async function getMarketOtris(markets: string[]): Promise<MarketOtri[]> {
  if (markets.length === 0) return [];
  await warmMemoryCacheFromDb();

  const cached: MarketOtri[] = [];
  const uncached: string[] = [];

  for (const market of markets) {
    const key = market.toLowerCase();
    const entry = otriCache.get(key);
    if (entry && isFresh(entry)) {
      cached.push(entry.value);
    } else {
      uncached.push(market);
    }
  }

  const fetched: MarketOtri[] = [];
  const BATCH_SIZE = 3;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const batch = uncached.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (market) => {
      const code = cityToMarketCode(market);
      const todayM = new Date().toISOString().slice(0, 10);
      const weekAgoM = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

      const otriData = await sonarGet(`/data/OTRI/${code}/${weekAgoM}/${todayM}`);
      const otri = extractValue(otriData);
      const otriPrior = extractPriorValue(otriData);
      const otriWoW = otri !== null && otriPrior !== null ? Math.round((otri - otriPrior) * 100) / 100 : null;

      const entry: MarketOtri = {
        market,
        otri,
        otriWoW,
        votri:    null,
        votriWoW: null,
        signal: otri !== null ? otriSignal(otri) : null,
        lastSuccessfulPull: otri !== null ? new Date().toISOString() : (otriCache.get(market.toLowerCase())?.value.lastSuccessfulPull ?? null),
      };
      const key = market.toLowerCase();
      otriCache.set(key, { value: entry, fetchedAt: Date.now(), ttlMs: OTRI_TTL });
      persistToDbCache(`otri:${key}`, entry, OTRI_TTL);
      return entry;
    }));
    fetched.push(...batchResults);
  }

  return [...cached, ...fetched];
}

export async function getMarketOtrisExtended(markets: string[]): Promise<MarketExtended[]> {
  if (markets.length === 0) return [];
  const baseResults = await getMarketOtris(markets);
  return baseResults.map((base) => ({
    market: base.market,
    otri: base.otri,
    otriWoW: base.otriWoW,
    votri: base.votri,
    votriWoW: base.votriWoW,
    otvi: null,
    hai: null,
    signal: base.signal,
  }));
}

export async function getMarketOtri(market: string): Promise<MarketOtri> {
  const results = await getMarketOtris([market]);
  return results[0] ?? { market, otri: null, otriWoW: null, votri: null, votriWoW: null, signal: null, lastSuccessfulPull: null };
}

export async function getNationalRates(): Promise<{ ntiPerMove: number | null; ntiPerMile: number | null; isStale: boolean }> {
  const summary = await getNationalMarketSummary();
  return {
    ntiPerMove: summary.ntiPerMove,
    ntiPerMile: summary.ntiPerMile,
    isStale: summary.isStale,
  };
}

export async function getMarketOtriHistory(
  market: string,
  days: number = 7,
): Promise<Array<{ timestamp: string; value: number }>> {
  const code = cityToMarketCode(market);
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const data = await sonarGet(`/data/OTRI/${code}/${startDate}/${endDate}`);
  if (!data) return [];
  const arr: unknown[] = Array.isArray(data) ? data : (Array.isArray((data as Record<string, unknown>).data) ? (data as Record<string, unknown>).data as unknown[] : []);
  return (arr as Array<Record<string, unknown>>)
    .filter(d => typeof d.value === "number" && typeof d.timestamp === "string")
    .map(d => ({ timestamp: d.timestamp as string, value: d.value as number }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getLaneVotriHistory(
  origin: string,
  destination: string,
  days: number = 7,
): Promise<Array<{ timestamp: string; value: number }>> {
  const qualifier = buildVotriQualifier(origin, destination);
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const data = await sonarGet(`/data/VOTRI/${qualifier}/${startDate}/${endDate}`);
  if (!data) return [];
  const arr: unknown[] = Array.isArray(data) ? data : (Array.isArray((data as Record<string, unknown>).data) ? (data as Record<string, unknown>).data as unknown[] : []);
  return (arr as Array<Record<string, unknown>>)
    .filter(d => typeof d.value === "number" && typeof d.timestamp === "string")
    .map(d => ({ timestamp: d.timestamp as string, value: d.value as number }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export async function getLaneVotri(origin: string, destination: string): Promise<LaneVotri> {
  await warmMemoryCacheFromDb();

  const qualifier = buildVotriQualifier(origin, destination);
  const cached = votriCache.get(qualifier);
  if (cached && isFresh(cached)) return cached.value;

  const todayL = new Date().toISOString().slice(0, 10);
  const weekAgoL = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const data = await sonarGet(`/data/VOTRI/${qualifier}/${weekAgoL}/${todayL}`);
  const rawVotri = extractValue(data);
  const priorVotri = extractPriorValue(data);

  const isStale = rawVotri === null;
  const votri    = rawVotri;
  const votriWoW = rawVotri !== null && priorVotri !== null
    ? Math.round((rawVotri - priorVotri) * 100) / 100
    : null;

  const entry: LaneVotri = {
    origin,
    destination,
    qualifier,
    votri,
    votriWoW,
    signal: rawVotri !== null ? votriSignal(rawVotri) : null,
    timestamp: new Date().toISOString(),
    isStale,
    lastSuccessfulPull: rawVotri !== null ? new Date().toISOString() : (cached?.value.lastSuccessfulPull ?? null),
  };

  votriCache.set(qualifier, { value: entry, fetchedAt: Date.now(), ttlMs: VOTRI_TTL });
  if (!isStale) {
    persistToDbCache(`votri:${qualifier}`, entry, VOTRI_TTL);
  }

  if (!entry.isStale) logFirstLiveLane(entry);

  return entry;
}

export async function getLaneVotrisBatch(
  lanes: Array<{ origin: string; destination: string }>,
): Promise<Map<string, LaneVotri>> {
  const results = new Map<string, LaneVotri>();
  await Promise.all(
    lanes.map(async ({ origin, destination }) => {
      const votri = await getLaneVotri(origin, destination);
      results.set(buildVotriQualifier(origin, destination), votri);
    }),
  );
  return results;
}

export async function getLaneVotriFresh(origin: string, destination: string): Promise<LaneVotri> {
  const qualifier = buildVotriQualifier(origin, destination);
  votriCache.delete(qualifier);
  return getLaneVotri(origin, destination);
}

export async function getLaneVotrisBatchFresh(
  lanes: Array<{ origin: string; destination: string }>,
): Promise<Map<string, LaneVotri>> {
  const results = new Map<string, LaneVotri>();
  await Promise.all(
    lanes.map(async ({ origin, destination }) => {
      const votri = await getLaneVotriFresh(origin, destination);
      results.set(buildVotriQualifier(origin, destination), votri);
    }),
  );
  return results;
}

export async function getLaneSpotRate(origin: string, destination: string): Promise<LaneSpotRate | null> {
  const origCode = cityToMarketCode(origin);
  const destCode = cityToMarketCode(destination);

  try {
    const { fetchTracSpotRates } = await import("./tracService");
    const laneId = `${origCode}-${destCode}-VAN`;
    const lane = {
      lane_id: laneId,
      origin: origCode,
      origin_country_code: "USA",
      destination: destCode,
      destination_country_code: "USA",
      equipment_type: "VAN" as const,
    };

    const spots = await fetchTracSpotRates([lane]);
    const spot = spots[0];
    if (spot?.rpm !== null && spot?.rpm !== undefined && spot.rpm > 0) {
      return {
        origin,
        destination,
        ratePerMile: Math.round(spot.rpm * 100) / 100,
        confidence: spot.confidenceScore !== null && spot.confidenceScore >= 70 ? "high" : "medium",
        timestamp: new Date().toISOString(),
      };
    }
  } catch {}

  const national = await getNationalMarketSummary();
  const votri = await getLaneVotri(origin, destination);
  if (national.ntiPerMile === null) return null;
  const baseRate = national.ntiPerMile > 0 ? national.ntiPerMile : 0;
  if (baseRate <= 0) return null;
  const premium = votri.signal === "hot" ? 0.08 : votri.signal === "warm" ? 0.03 : 0;
  const ratePerMile = Math.round(baseRate * (1 + premium) * 100) / 100;

  return {
    origin,
    destination,
    ratePerMile,
    confidence: "low",
    timestamp: new Date().toISOString(),
  };
}

export async function getAvgVotriWoW(
  lanes: Array<{ origin: string; destination: string }>,
): Promise<number | null> {
  if (lanes.length === 0) return null;
  const votris = await getLaneVotrisBatch(lanes);
  const deltas = Array.from(votris.values()).map(v => v.votriWoW).filter((d): d is number => d !== null);
  if (deltas.length === 0) return null;
  return Math.round((deltas.reduce((s, d) => s + d, 0) / deltas.length) * 100) / 100;
}

// ── Lane Market Rate (TRAC benchmark + 3-week forecast) ───────────────────────

const laneMarketRateCache = new Map<string, CacheEntry<LaneMarketRate>>();

export async function getLaneMarketRate(origin: string, destination: string): Promise<LaneMarketRate> {
  const qualifier = buildVotriQualifier(origin, destination);
  const cacheKey = `lmr:${qualifier}`;
  const cached = laneMarketRateCache.get(cacheKey);
  if (cached && isFresh(cached)) return cached.value;

  const origCode = cityToMarketCode(origin);
  const destCode = cityToMarketCode(destination);

  const [national, laneVotri] = await Promise.all([
    getNationalMarketSummary(),
    getLaneVotri(origin, destination),
  ]);

  const nationalRate = (national.ntiPerMile !== null && national.ntiPerMile > 0) ? national.ntiPerMile : null;

  let marketRatePerMile: number;
  let source: "lane" | "national_fallback";
  let forecastDirection: "TIGHTENING" | "EASING" | "STABLE" = "STABLE";
  let weeklyRateChange = 0;

  try {
    const { fetchTracSpotRates, fetchTracForecast } = await import("./tracService");
    const laneId = `${origCode}-${destCode}-VAN`;
    const lane = {
      lane_id: laneId,
      origin: origCode,
      origin_country_code: "USA",
      destination: destCode,
      destination_country_code: "USA",
      equipment_type: "VAN" as const,
    };

    const [spots, forecasts] = await Promise.all([
      fetchTracSpotRates([lane]).catch(() => []),
      fetchTracForecast([lane]).catch(() => []),
    ]);

    const spot = spots[0];
    if (spot?.rpm !== null && spot?.rpm !== undefined && spot.rpm > 0) {
      marketRatePerMile = Math.round(spot.rpm * 100) / 100;
      source = "lane";

      const days = forecasts[0]?.days ?? [];
      const next7 = days.slice(0, 7).map(d => d.forecastRpm).filter((v): v is number => v !== null);
      if (next7.length > 0) {
        const avgForecast = next7.reduce((a, b) => a + b, 0) / next7.length;
        const delta = (avgForecast - spot.rpm) / spot.rpm;
        if (delta > 0.02) {
          forecastDirection = "TIGHTENING";
          weeklyRateChange = Math.min(delta / 2, 0.03);
        } else if (delta < -0.02) {
          forecastDirection = "EASING";
          weeklyRateChange = Math.max(delta / 2, -0.025);
        }
      }

      log(`Lane TRAC spot for ${qualifier}: $${marketRatePerMile.toFixed(2)}/mi [${forecastDirection}]`);
    } else {
      throw new Error("No TRAC spot data");
    }
  } catch {
    source = "national_fallback";
    if (nationalRate === null) {
      const emptyResult: LaneMarketRate = {
        origin, destination,
        marketRatePerMile: null,
        forecastDirection: "STABLE",
        forecastWeeklyRates: [],
        confidence: "low",
        source: "national_fallback",
        timestamp: new Date().toISOString(),
        isStale: true,
        lastSuccessfulPull: null,
      };
      laneMarketRateCache.set(cacheKey, { value: emptyResult, fetchedAt: Date.now(), ttlMs: TRAC_MARKET_RATE_TTL });
      return emptyResult;
    }
    marketRatePerMile = nationalRate;
    if (!laneVotri.isStale && laneVotri.votri !== null) {
      const votriPremium = laneVotri.signal === "hot" ? 0.05 : laneVotri.signal === "warm" ? 0.02 : 0;
      marketRatePerMile = Math.round(nationalRate * (1 + votriPremium) * 100) / 100;
    }

    try {
      const { tracLaneDirectionSignal } = await import("./tracAlertEngine");
      const tracSignal = await tracLaneDirectionSignal(origin, destination);
      if (tracSignal === "hot" || tracSignal === "warm") {
        forecastDirection = "TIGHTENING";
        weeklyRateChange = tracSignal === "hot" ? 0.02 : 0.01;
      } else if (tracSignal === "cool") {
        forecastDirection = "EASING";
        weeklyRateChange = -0.015;
      }
    } catch {
      // TRAC direction unavailable — keep STABLE default
    }
  }

  const forecastWeeklyRates = [1, 2, 3].map(week => ({
    week,
    ratePerMile: Math.round(marketRatePerMile * Math.pow(1 + weeklyRateChange, week) * 100) / 100,
  }));

  const nowIso = new Date().toISOString();
  const result: LaneMarketRate = {
    origin,
    destination,
    marketRatePerMile,
    forecastDirection,
    forecastWeeklyRates,
    confidence: source === "lane" ? "high" : laneVotri.isStale ? "low" : "medium",
    source,
    timestamp: nowIso,
    isStale: laneVotri.isStale && source === "national_fallback",
    lastSuccessfulPull: marketRatePerMile !== null ? nowIso : (laneVotri.lastSuccessfulPull ?? null),
  };

  laneMarketRateCache.set(cacheKey, { value: result, fetchedAt: Date.now(), ttlMs: TRAC_MARKET_RATE_TTL });
  log(`Lane market rate: ${qualifier} → $${marketRatePerMile.toFixed(2)}/mi [${forecastDirection}] source=${source}`);
  return result;
}

export async function getLaneMarketRatesBatch(
  lanes: Array<{ origin: string; destination: string }>,
): Promise<Map<string, LaneMarketRate>> {
  const results = new Map<string, LaneMarketRate>();
  await Promise.all(
    lanes.map(async ({ origin, destination }) => {
      const rate = await getLaneMarketRate(origin, destination);
      results.set(buildVotriQualifier(origin, destination), rate);
    }),
  );
  return results;
}
