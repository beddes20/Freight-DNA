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
 * When credentials are absent or Sonar is unreachable all methods fall back
 * to the last-known cached value, or to seeded defaults with isStale = true.
 */

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
  otri: number;
  otriWoWDelta: number;
  ntiPerMove: number;
  ntiWoWDelta: number;
  ntiPerMile: number;
  ratesSpread: number | null;
  flatbedOtri: number;
  flatbedSignal: "hot" | "cool" | "neutral";
  dieselPerGal: number;
  dieselMoMDelta: number;
  timestamp: string;
  isStale: boolean;
}

export interface MarketOtri {
  market: string;
  otri: number;
  otriWoW: number;     // OTRIW — market-level outbound tender rejection WoW delta
  votri: number | null;
  votriWoW: number | null; // VOTRIW — van outbound tender rejection WoW delta (used for Intel trend direction)
  signal: "hot" | "warm" | "cool";
}

export interface LaneVotri {
  origin: string;
  destination: string;
  qualifier: string;     // e.g. "ATLDAL"
  votri: number;         // current week %
  votriWoW: number;      // WoW delta pp
  signal: "hot" | "warm" | "cool";
  timestamp: string;
  isStale: boolean;
}

export interface LaneSpotRate {
  origin: string;
  destination: string;
  ratePerMile: number;
  confidence: "high" | "medium" | "low";
  timestamp: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

const SONAR_BASE = "https://api.freightwaves.com";
const TOKEN_BUFFER_MS = 5 * 60 * 1000;
const VOTRI_TTL = 4 * 60 * 60 * 1000;
const OTRI_TTL  = 4 * 60 * 60 * 1000;
const NTI_TTL   = 1 * 60 * 60 * 1000;

// ── In-memory state ───────────────────────────────────────────────────────────

let cachedToken: SonarToken | null = null;
let nationalCache: CacheEntry<NationalMarketSummary> | null = null;
const otriCache  = new Map<string, CacheEntry<MarketOtri>>();
const votriCache = new Map<string, CacheEntry<LaneVotri>>();

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
    `VOTRI=${entry.votri.toFixed(2)}% WoW=${entry.votriWoW >= 0 ? "+" : ""}${entry.votriWoW.toFixed(2)}pp ` +
    `signal=${entry.signal} isStale=false`
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

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function sonarGet(path: string): Promise<any | null> {
  const token = await getSonarToken();
  if (!token) return null;
  try {
    const resp = await fetch(`${SONAR_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (resp.status === 401) {
      // Token may have been revoked — clear cache and retry once
      cachedToken = null;
      const newToken = await getSonarToken();
      if (!newToken) return null;
      const resp2 = await fetch(`${SONAR_BASE}${path}`, {
        headers: { Authorization: `Bearer ${newToken}` },
        signal: AbortSignal.timeout(12_000),
      });
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

/**
 * Sonar /data/{INDEX}/{QUALIFIER} returns something like:
 *   { data: [{ timestamp: "...", value: 12.34 }] }
 * or
 *   { value: 12.34 }
 */
function extractValue(data: any): number | null {
  if (data == null) return null;
  // Array response
  if (Array.isArray(data)) {
    const latest = data[data.length - 1];
    return typeof latest?.value === "number" ? latest.value : null;
  }
  // data.data array
  if (Array.isArray(data?.data)) {
    const arr = data.data as Array<{ value?: number; timestamp?: string }>;
    if (arr.length === 0) return null;
    const latest = arr[arr.length - 1];
    return typeof latest?.value === "number" ? latest.value : null;
  }
  // Flat object
  if (typeof data?.value === "number") return data.value;
  return null;
}

/**
 * Extract the prior-period value (second-to-last data point) for WoW delta.
 */
function extractPriorValue(data: any): number | null {
  const arr: any[] = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  if (arr.length < 2) return null;
  const prior = arr[arr.length - 2];
  return typeof prior?.value === "number" ? prior.value : null;
}

// ── City → Sonar market code lookup table ────────────────────────────────────
//
// Sonar VOTRI qualifiers are 3-letter market codes, NOT simple first-3 of city name.
// e.g. Los Angeles → LAX, Chicago → CHI, Dallas → DAL, etc.
// Unknown cities fall back to first-3-letters heuristic (will return no data from Sonar).

const CITY_TO_SONAR_CODE: Record<string, string> = {
  // Major US freight markets
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
  // Strip state suffix (", TX" / ", CA" / " TX" / " CA"), trailing punctuation, and normalize
  const normalized = city
    .toLowerCase()
    .trim()
    .replace(/,?\s+[a-z]{2}$/, "")   // remove trailing state abbreviation e.g. "Atlanta, GA"
    .replace(/[^a-z ]/g, "")         // remove punctuation
    .trim();
  return CITY_TO_SONAR_CODE[normalized]
    ?? CITY_TO_SONAR_CODE[city.toLowerCase().trim()]
    ?? normalized.toUpperCase().replace(/\s+/g, "").slice(0, 3).padEnd(3, "X");
}

// ── VOTRI qualifier builder ───────────────────────────────────────────────────

/** Build a VOTRI ticker qualifier from two city/market names.
 *  e.g. ("Atlanta", "Dallas") → "ATLDAL"
 *  Uses the city→Sonar market code lookup table; falls back to first-3 letters. */
export function buildVotriQualifier(origin: string, destination: string): string {
  return `${cityToMarketCode(origin)}${cityToMarketCode(destination)}`;
}

/** Build an OTRI market ticker from a city name.
 *  e.g. "Atlanta" → "ATL" for the OTRI.ATL ticker. */
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * National market summary — NTI.USA + OTRI.USA + VCRPM1.USA.
 * Falls back to last known or seeded defaults on failure.
 */
export async function getNationalMarketSummary(): Promise<NationalMarketSummary> {
  if (nationalCache && isFresh(nationalCache)) {
    return nationalCache.value;
  }

  const fallback = buildFallbackNational();

  // Include today's date for explicit snapshot reads.
  // Using a 2-day window (yesterday → today) ensures we always get at least one data point
  // even if today's data hasn't been published yet.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  const [ntiData, otriData, vcrpmData, otriWData, ntiWData, ratesData] = await Promise.all([
    sonarGet(`/data/NTI/USA/${yesterday}/${today}`),
    sonarGet(`/data/OTRI/USA/${yesterday}/${today}`),
    sonarGet(`/data/VCRPM1/USA/${yesterday}/${today}`),
    sonarGet(`/data/OTRIW/USA/${yesterday}/${today}`),
    sonarGet(`/data/NTIW/USA/${yesterday}/${today}`),
    sonarGet(`/data/RATES/USA/${yesterday}/${today}`),
  ]);

  const nti   = extractValue(ntiData);
  const ntiP  = extractPriorValue(ntiData);
  const otri  = extractValue(otriData);
  const otriP = extractPriorValue(otriData);
  const vcrpm = extractValue(vcrpmData);
  const otriW = extractValue(otriWData);
  const ntiW  = extractValue(ntiWData);
  const rates = extractValue(ratesData);

  if (nti === null && otri === null) {
    log("National market data unavailable — using fallback");
    return fallback;
  }

  const resolvedNti  = nti   ?? fallback.ntiPerMove;
  const resolvedVcrp = vcrpm ?? fallback.ntiPerMile;
  const ratesSpread  = rates !== null ? Math.round(rates * 100) / 100 : null;

  const summary: NationalMarketSummary = {
    otri:          otri  ?? fallback.otri,
    otriWoWDelta:  otriW !== null ? Math.round(otriW * 100) / 100
                 : otri !== null && otriP !== null ? Math.round((otri - otriP) * 100) / 100
                 : fallback.otriWoWDelta,
    ntiPerMove:    resolvedNti,
    ntiWoWDelta:   ntiW !== null ? Math.round(ntiW * 100) / 100
                 : nti !== null && ntiP !== null ? Math.round((nti - ntiP) * 100) / 100
                 : fallback.ntiWoWDelta,
    ntiPerMile:    resolvedVcrp,
    ratesSpread,
    flatbedOtri:   otri  ?? fallback.flatbedOtri,
    flatbedSignal: otri !== null ? (otri > 25 ? "hot" : otri > 12 ? "neutral" : "cool") : fallback.flatbedSignal,
    dieselPerGal:  fallback.dieselPerGal,
    dieselMoMDelta: fallback.dieselMoMDelta,
    timestamp:     new Date().toISOString(),
    isStale:       false,
  };

  nationalCache = { value: summary, fetchedAt: Date.now(), ttlMs: NTI_TTL };
  lastKnownNational = summary;
  log(`National: OTRI=${summary.otri}% NTI=$${summary.ntiPerMove}`);
  return summary;
}

let lastKnownNational: NationalMarketSummary | null = null;
function buildFallbackNational(): NationalMarketSummary {
  if (lastKnownNational) return { ...lastKnownNational, isStale: true };
  return {
    otri: 13.74,
    otriWoWDelta: -0.7,
    ntiPerMove: 3090,
    ntiWoWDelta: 15,
    ntiPerMile: 2.28,
    ratesSpread: null,
    flatbedOtri: 18.5,
    flatbedSignal: "neutral",
    dieselPerGal: 3.72,
    dieselMoMDelta: -0.04,
    timestamp: new Date().toISOString(),
    isStale: true,
  };
}

/**
 * Fetch OTRI for a list of markets (city names → market codes resolved heuristically).
 * Uses 4-hour TTL per-market cache.
 */
export async function getMarketOtris(markets: string[]): Promise<MarketOtri[]> {
  if (markets.length === 0) return [];
  const results: MarketOtri[] = [];

  await Promise.all(markets.map(async (market) => {
    const key = market.toLowerCase();
    const cached = otriCache.get(key);
    if (cached && isFresh(cached)) {
      results.push(cached.value);
      return;
    }

    const code = cityToMarketCode(market);
    // 2-day window for snapshot reads so we always get at least one data point
    const todayM = new Date().toISOString().slice(0, 10);
    const ydayM  = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const [otriData, otriWData, votriData, votriWData] = await Promise.all([
      sonarGet(`/data/OTRI/${code}/${ydayM}/${todayM}`),
      sonarGet(`/data/OTRIW/${code}/${ydayM}/${todayM}`),
      sonarGet(`/data/VOTRI/${code}/${ydayM}/${todayM}`),
      sonarGet(`/data/VOTRIW/${code}/${ydayM}/${todayM}`),
    ]);
    const otri = extractValue(otriData) ?? 15;
    const otriWoW = extractValue(otriWData) ?? 0;
    const votri = extractValue(votriData);
    const votriW = extractValue(votriWData);

    const entry: MarketOtri = {
      market,
      otri,
      otriWoW:  Math.round(otriWoW * 100) / 100,
      votri:    votri  !== null ? Math.round(votri  * 100) / 100 : null,
      votriWoW: votriW !== null ? Math.round(votriW * 100) / 100 : null,
      signal: otriSignal(otri),
    };
    otriCache.set(key, { value: entry, fetchedAt: Date.now(), ttlMs: OTRI_TTL });
    results.push(entry);
  }));

  return results;
}

/**
 * Fetch OTRI for a single market (city name → market code via lookup table).
 * Singular convenience wrapper around getMarketOtris.
 */
export async function getMarketOtri(market: string): Promise<MarketOtri> {
  const results = await getMarketOtris([market]);
  return results[0] ?? { market, otri: 15, otriWoW: 0, votri: null, votriWoW: null, signal: "warm" };
}

/**
 * Fetch national rates (NTI $/move, VCRPM1 $/mile) — named alias for clarity.
 */
export async function getNationalRates(): Promise<{ ntiPerMove: number; ntiPerMile: number; isStale: boolean }> {
  const summary = await getNationalMarketSummary();
  return {
    ntiPerMove: summary.ntiPerMove,
    ntiPerMile: summary.ntiPerMile,
    isStale: summary.isStale,
  };
}

/**
 * Fetch OTRI history for a market using Sonar date-range endpoint.
 * Returns array of { timestamp, value } sorted oldest→newest.
 */
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

/**
 * Fetch VOTRI history for a single lane using Sonar date-range endpoint.
 * Returns array of { timestamp, value } sorted oldest→newest.
 */
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

/**
 * Fetch VOTRI for a single lane.
 * Uses 4-hour TTL per-qualifier cache.
 */
export async function getLaneVotri(origin: string, destination: string): Promise<LaneVotri> {
  const qualifier = buildVotriQualifier(origin, destination);
  const cached = votriCache.get(qualifier);
  if (cached && isFresh(cached)) return cached.value;

  // Fetch VOTRI (current rejection rate) and VOTRIW (true weekly WoW delta) in parallel.
  // VOTRIW.{QUALIFIER} returns the week-over-week change in van tender rejection rate.
  // Falling back to prior-datapoint diff only if VOTRIW is unavailable.
  // 2-day window ensures we always get at least one data point even if today's not yet published.
  const todayL = new Date().toISOString().slice(0, 10);
  const ydayL  = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [data, votriWData] = await Promise.all([
    sonarGet(`/data/VOTRI/${qualifier}/${ydayL}/${todayL}`),
    sonarGet(`/data/VOTRIW/${qualifier}/${ydayL}/${todayL}`),
  ]);
  const rawVotri = extractValue(data);
  const rawVotriW = extractValue(votriWData);

  // isStale = true when the API returned nothing (network failure) or returned no data point
  // for this qualifier (unknown lane). Both cases should not be presented as "cool" market data.
  const isStale = rawVotri === null;
  const votri    = rawVotri ?? 0;
  const votriWoW = rawVotriW !== null
    ? Math.round(rawVotriW * 100) / 100
    : rawVotri !== null
      ? Math.round((rawVotri - (extractPriorValue(data) ?? rawVotri)) * 100) / 100
      : 0;

  const entry: LaneVotri = {
    origin,
    destination,
    qualifier,
    votri,
    votriWoW,
    signal: isStale ? "cool" : votriSignal(votri),
    timestamp: new Date().toISOString(),
    isStale,
  };

  votriCache.set(qualifier, { value: entry, fetchedAt: Date.now(), ttlMs: VOTRI_TTL });

  // Log first successful live lane result for end-to-end verification
  if (!entry.isStale) logFirstLiveLane(entry);

  return entry;
}

/**
 * Fetch VOTRI for multiple lanes in parallel (batch, respects cache).
 */
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

/**
 * Fetch lane-level spot rate proxy.
 * Since Sonar doesn't expose per-lane $/mile in the public endpoint,
 * we synthesize from VOTRI + NTI national baseline.
 */
export async function getLaneSpotRate(origin: string, destination: string): Promise<LaneSpotRate | null> {
  const [votri, national] = await Promise.all([
    getLaneVotri(origin, destination),
    getNationalMarketSummary(),
  ]);

  const baseRate = national.ntiPerMile > 0 ? national.ntiPerMile : 2.28;
  // Tight market premium: +8% if hot, +3% if warm
  const premium = votri.signal === "hot" ? 0.08 : votri.signal === "warm" ? 0.03 : 0;
  const ratePerMile = Math.round(baseRate * (1 + premium) * 100) / 100;

  return {
    origin,
    destination,
    ratePerMile,
    confidence: votri.isStale ? "low" : "medium",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Convenience: compute average VOTRI WoW delta across a set of lanes.
 * Used by the NBA engine to detect market tightening / loosening.
 */
export async function getAvgVotriWoW(
  lanes: Array<{ origin: string; destination: string }>,
): Promise<number | null> {
  if (lanes.length === 0) return null;
  const votris = await getLaneVotrisBatch(lanes);
  const deltas = Array.from(votris.values()).map(v => v.votriWoW);
  if (deltas.length === 0) return null;
  return Math.round((deltas.reduce((s, d) => s + d, 0) / deltas.length) * 100) / 100;
}
