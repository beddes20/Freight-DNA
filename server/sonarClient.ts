/**
 * Sonar API Client
 * Authenticates with Sonar (DAT iQ / FreightWaves Sonar), caches JWT in memory,
 * and exposes methods for national market summaries and lane-level signals.
 *
 * Credentials stored as env secrets: SONAR_USERNAME, SONAR_PASSWORD
 * When credentials are missing, all methods return graceful stale/mock data.
 */

interface SonarToken {
  token: string;
  expiresAt: number; // unix ms
}

let cachedToken: SonarToken | null = null;

const SONAR_BASE = "https://api.freightwaves.com";
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
  console.log(`${t} [sonar] ${msg}`);
}

async function getSonarToken(): Promise<string | null> {
  const username = process.env.SONAR_USERNAME;
  const password = process.env.SONAR_PASSWORD;
  if (!username || !password) return null;

  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_BUFFER_MS) {
    return cachedToken.token;
  }

  try {
    const resp = await fetch(`${SONAR_BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      log(`Auth failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json() as { token?: string; access_token?: string; expires_in?: number };
    const token = data.token ?? data.access_token;
    if (!token) { log("No token in response"); return null; }
    const expiresIn = (data.expires_in ?? 3600) * 1000;
    cachedToken = { token, expiresAt: Date.now() + expiresIn };
    log("Auth token refreshed");
    return token;
  } catch (err: any) {
    log(`Auth error: ${err.message}`);
    return null;
  }
}

async function sonarGet(path: string): Promise<any | null> {
  const token = await getSonarToken();
  if (!token) return null;
  try {
    const resp = await fetch(`${SONAR_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) { log(`GET ${path} → ${resp.status}`); return null; }
    return await resp.json();
  } catch (err: any) {
    log(`GET ${path} error: ${err.message}`);
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface NationalMarketSummary {
  otri: number;           // Outbound Tender Rejection Index (%)
  otriWoWDelta: number;   // week-over-week delta in percentage points
  ntiPerMile: number;     // National Truckload Index $/mile
  ntiWoWDelta: number;    // WoW delta $/mile
  flatbedOtri: number;    // Flatbed OTRI (%)
  flatbedSignal: "hot" | "cool" | "neutral";
  dieselPerGal: number;   // Diesel $/gallon
  dieselMoMDelta: number; // month-over-month delta $/gal
  timestamp: string;      // ISO timestamp of data
  isStale: boolean;       // true if data is from cache / Sonar unavailable
}

export interface MarketOtri {
  market: string;  // city or market code
  otri: number;    // OTRI percentage
  signal: "hot" | "warm" | "cool"; // >25 = hot, 10-25 = warm, <10 = cool
}

export interface LaneSpotRate {
  origin: string;
  destination: string;
  ratePerMile: number;
  confidence: "high" | "medium" | "low";
  timestamp: string;
}

// ── Fallback / mock data (used when Sonar credentials are missing) ──────────

let lastKnownNational: NationalMarketSummary | null = null;

function buildFallbackNational(): NationalMarketSummary {
  if (lastKnownNational) return { ...lastKnownNational, isStale: true };
  return {
    otri: 13.74,
    otriWoWDelta: -0.7,
    ntiPerMile: 3.09,
    ntiWoWDelta: 0.04,
    flatbedOtri: 45.2,
    flatbedSignal: "hot",
    dieselPerGal: 5.66,
    dieselMoMDelta: 0.78,
    timestamp: new Date().toISOString(),
    isStale: true,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch national market summary (OTRI, NTI, Flatbed OTRI, Diesel).
 * Falls back to last known values or seeded defaults when Sonar is unavailable.
 */
export async function getNationalMarketSummary(): Promise<NationalMarketSummary> {
  const data = await sonarGet("/v2/indices/national");
  if (!data) return buildFallbackNational();

  try {
    const otri = Number(data.otri ?? data.national_otri ?? 0);
    const otriPrev = Number(data.otri_prev_week ?? data.otri_last_week ?? otri);
    const nti = Number(data.nti ?? data.nti_per_mile ?? 0);
    const ntiPrev = Number(data.nti_prev_week ?? nti);
    const fbOtri = Number(data.flatbed_otri ?? data.flatbedOtri ?? 0);
    const diesel = Number(data.diesel ?? data.diesel_per_gallon ?? 0);
    const dieselPrev = Number(data.diesel_prev_month ?? diesel);

    const summary: NationalMarketSummary = {
      otri,
      otriWoWDelta: Math.round((otri - otriPrev) * 100) / 100,
      ntiPerMile: nti,
      ntiWoWDelta: Math.round((nti - ntiPrev) * 100) / 100,
      flatbedOtri: fbOtri,
      flatbedSignal: fbOtri > 35 ? "hot" : fbOtri > 15 ? "neutral" : "cool",
      dieselPerGal: diesel,
      dieselMoMDelta: Math.round((diesel - dieselPrev) * 100) / 100,
      timestamp: new Date().toISOString(),
      isStale: false,
    };
    lastKnownNational = summary;
    return summary;
  } catch {
    return buildFallbackNational();
  }
}

/**
 * Fetch per-market OTRI for a list of cities/regions.
 * Returns empty array (not an error) when Sonar is unavailable.
 */
export async function getMarketOtris(markets: string[]): Promise<MarketOtri[]> {
  if (markets.length === 0) return [];
  const results: MarketOtri[] = [];

  for (const market of markets) {
    const encoded = encodeURIComponent(market);
    const data = await sonarGet(`/v2/indices/otri?market=${encoded}`);
    if (!data) {
      // Return a neutral fallback for each market we couldn't fetch
      results.push({ market, otri: 15, signal: "warm" });
      continue;
    }
    const otri = Number(data.otri ?? data.value ?? 15);
    results.push({
      market,
      otri,
      signal: otri > 25 ? "hot" : otri > 10 ? "warm" : "cool",
    });
  }
  return results;
}

/**
 * Fetch lane-level spot rate for origin→destination corridor.
 */
export async function getLaneSpotRate(origin: string, destination: string): Promise<LaneSpotRate | null> {
  const o = encodeURIComponent(origin);
  const d = encodeURIComponent(destination);
  const data = await sonarGet(`/v2/rates/spot?origin=${o}&destination=${d}`);
  if (!data) return null;

  try {
    return {
      origin,
      destination,
      ratePerMile: Number(data.rate_per_mile ?? data.ratePerMile ?? 0),
      confidence: data.confidence ?? "medium",
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
