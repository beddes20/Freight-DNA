/**
 * tracService.ts — FreightWaves TRAC API client
 *
 * Endpoints:
 *   POST /v2/truckload/rates/trac           → spot rates
 *   POST /v2/truckload/rates/trac/forecast  → 14-day daily forecast
 *   POST /v2/truckload/rates/trac/statistics → monthly historical stats
 *   POST /v2/truckload/rates/contract       → contract rates + FSC
 *
 * Caching (DB-backed, survives restarts):
 *   Spot rates:   1-hour TTL
 *   Forecasts:    4-hour TTL
 *   Contract:     4-hour TTL
 *   Statistics:   24-hour TTL
 */

import { storage } from "./storage";
import { resilientFetch } from "./lib/httpRetry";

const TRAC_BASE = "https://api.freightwaves.com";
const TOKEN = () => process.env.FREIGHTWAVES_TOKEN ?? "";

const TRAC_SPOT_TTL_S     = 1 * 60 * 60;      // 1 hour
const TRAC_FORECAST_TTL_S = 4 * 60 * 60;      // 4 hours
const TRAC_CONTRACT_TTL_S = 4 * 60 * 60;      // 4 hours
const TRAC_STATS_TTL_S    = 24 * 60 * 60;     // 24 hours

const tracMemoryCache = new Map<string, { data: unknown; fetchedAt: number; ttlMs: number }>();

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour12: true, hour: "numeric", minute: "2-digit", second: "2-digit" });
  console.log(`${t} [trac] ${msg}`);
}

function getTracMemoryCache(key: string): unknown | null {
  const entry = tracMemoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > entry.ttlMs) {
    tracMemoryCache.delete(key);
    return null;
  }
  return entry.data;
}

function setTracMemoryCache(key: string, data: unknown, ttlMs: number) {
  tracMemoryCache.set(key, { data, fetchedAt: Date.now(), ttlMs });
}

async function getTracDbCache(key: string): Promise<unknown | null> {
  try {
    const row = await storage.getCachedApiResponse(key);
    if (row) {
      setTracMemoryCache(key, row.response, row.ttlSeconds * 1000);
      return row.response;
    }
  } catch {}
  return null;
}

function persistTracToDb(key: string, data: unknown, ttlSeconds: number) {
  storage.setCachedApiResponse(key, data, ttlSeconds, "trac").catch(() => {});
}

function buildTracCacheKey(type: string, lanes: TracLaneInput[]): string {
  const laneKeys = lanes.map(l => `${l.origin}-${l.destination}-${l.equipment_type}`).join("|");
  return `trac:${type}:${laneKeys}`;
}

function remapLaneIds<T extends { laneId: string }>(cached: T[], lanes: TracLaneInput[]): T[] {
  return lanes.map((lane, i) => {
    if (i < cached.length) return { ...cached[i], laneId: lane.lane_id };
    const normalizedKey = `${lane.origin}-${lane.destination}-${lane.equipment_type}`;
    const match = cached.find(c => {
      const parts = c.laneId.split("-");
      if (parts.length >= 3) {
        return `${parts[0]}-${parts[1]}-${parts.slice(2).join("-")}` === normalizedKey;
      }
      return false;
    });
    if (match) return { ...match, laneId: lane.lane_id };
    return cached[i] as T;
  }).filter(Boolean);
}

const inflightTracRequests = new Map<string, Promise<unknown>>();

async function coalescedTracFetch<T>(cacheKey: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const memCached = getTracMemoryCache(cacheKey);
  if (memCached !== null) return memCached as T;

  const dbCached = await getTracDbCache(cacheKey);
  if (dbCached !== null) return dbCached as T;

  if (inflightTracRequests.has(cacheKey)) {
    return inflightTracRequests.get(cacheKey) as Promise<T>;
  }

  const promise = fetcher().then(result => {
    const ttlMs = ttlSeconds * 1000;
    setTracMemoryCache(cacheKey, result, ttlMs);
    persistTracToDb(cacheKey, result, ttlSeconds);
    return result;
  }).finally(() => {
    inflightTracRequests.delete(cacheKey);
  });

  inflightTracRequests.set(cacheKey, promise);
  return promise;
}

export interface TracLaneInput {
  lane_id: string;
  origin: string;            // KMA code e.g. "SLC"
  origin_country_code: string;
  destination: string;       // KMA code e.g. "LAX"
  destination_country_code: string;
  equipment_type: "VAN" | "REEFER" | "FLATBED";
}

export interface TracSpotResult {
  laneId: string;
  rpm: number | null;
  rpmHigh: number | null;
  rpmLow: number | null;
  rate: number | null;
  rateHigh: number | null;
  rateLow: number | null;
  confidenceScore: number | null;
  miles: number | null;
  totalLoadCount: number | null;
}

export interface TracForecastDay {
  date: string;               // YYYY-MM-DD
  forecastRpm: number | null;
  forecastIndexValue: number | null;
}

export interface TracStatResult {
  laneId: string;
  avgRpm30d: number | null;
  avgRpm90d: number | null;
}

export interface TracContractResult {
  laneId: string;
  contractRpm: number | null;
  contractRate: number | null;
  contractFscRpm: number | null;
  contractConfidenceScore: number | null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function daysAhead(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function tracPost(path: string, body: object): Promise<unknown> {
  const token = TOKEN();
  if (!token) throw new Error("FREIGHTWAVES_TOKEN not configured");

  // Task #706 — shared resilience helper handles timeout, retry, and breaker
  // per the "trac" policy in server/lib/httpRetry.ts.
  const res = await resilientFetch("trac", () => fetch(`${TRAC_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }), { timeoutMs: 15_000 });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TRAC ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function buildLaneBody(
  lanes: TracLaneInput[],
  startDate: string,
  endDate: string,
): object {
  return {
    start_date: startDate,
    end_date: endDate,
    lanes,
  };
}

function rawFetchSpotRates(lanes: TracLaneInput[]): Promise<TracSpotResult[]> {
  const body = buildLaneBody(lanes, daysAgo(7), todayStr());
  return tracPost("/v2/truckload/rates/trac", body).then((data: any) => {
    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? (data as unknown[]) : [];
    return lanes.map((lane) => {
      const match = (arr as Record<string, unknown>[]).find(
        (r) => String(r.lane_id) === lane.lane_id || (r.origin === lane.origin && r.destination === lane.destination),
      );
      if (match) {
        return {
          laneId: lane.lane_id,
          rpm: num(match.rpm),
          rpmHigh: num(match.rpm_high),
          rpmLow: num(match.rpm_low),
          rate: num(match.rate),
          rateHigh: num(match.rate_high),
          rateLow: num(match.rate_low),
          confidenceScore: num(match.confidence_score),
          miles: num(match.miles),
          totalLoadCount: num(match.total_load_count),
        };
      }
      return { laneId: lane.lane_id, rpm: null, rpmHigh: null, rpmLow: null, rate: null, rateHigh: null, rateLow: null, confidenceScore: null, miles: null, totalLoadCount: null };
    });
  });
}

export async function fetchTracSpotRates(lanes: TracLaneInput[]): Promise<TracSpotResult[]> {
  if (!lanes.length) return [];
  const cacheKey = buildTracCacheKey("spot", lanes);
  const result = await coalescedTracFetch<TracSpotResult[]>(cacheKey, TRAC_SPOT_TTL_S, () => rawFetchSpotRates(lanes));
  return remapLaneIds(result, lanes);
}

function rawFetchForecast(lanes: TracLaneInput[]): Promise<{ laneId: string; days: TracForecastDay[] }[]> {
  const body = buildLaneBody(lanes, todayStr(), daysAhead(14));
  return tracPost("/v2/truckload/rates/trac/forecast", body).then((data: any) => {
    const raw = Array.isArray(data?.data) ? (data.data as Record<string, unknown>[]) : Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    return lanes.map((lane) => {
      const match = raw.find(
        (r) => String(r.lane_id) === lane.lane_id || (r.origin === lane.origin && r.destination === lane.destination),
      );
      const dayArr = Array.isArray(match?.data) ? (match!.data as Record<string, unknown>[]) : [];
      const days: TracForecastDay[] = dayArr.map((d) => ({
        date: String(d.data_timestamp ?? d.date ?? "").slice(0, 10),
        forecastRpm: num(d.forecast_rpm_trac),
        forecastIndexValue: num(d.forecast_index_value),
      }));
      return { laneId: lane.lane_id, days };
    });
  });
}

export async function fetchTracForecast(lanes: TracLaneInput[]): Promise<{ laneId: string; days: TracForecastDay[] }[]> {
  if (!lanes.length) return [];
  const cacheKey = buildTracCacheKey("forecast", lanes);
  const result = await coalescedTracFetch<{ laneId: string; days: TracForecastDay[] }[]>(cacheKey, TRAC_FORECAST_TTL_S, () => rawFetchForecast(lanes));
  return remapLaneIds(result, lanes);
}

function rawFetchStatistics(lanes: TracLaneInput[]): Promise<TracStatResult[]> {
  const body90 = buildLaneBody(lanes, daysAgo(90), todayStr());
  const body30 = buildLaneBody(lanes, daysAgo(30), todayStr());

  return Promise.all([
    tracPost("/v2/truckload/rates/trac/statistics", { ...body90, aggregation: "monthly" }).catch(() => null),
    tracPost("/v2/truckload/rates/trac/statistics", { ...body30, aggregation: "monthly" }).catch(() => null),
  ]).then(([data90Raw, data30Raw]) => {
    return lanes.map((lane) => {
      const avg90 = extractAvgRpm(data90Raw, lane.lane_id, lane.origin, lane.destination);
      const avg30 = extractAvgRpm(data30Raw, lane.lane_id, lane.origin, lane.destination);
      return { laneId: lane.lane_id, avgRpm30d: avg30, avgRpm90d: avg90 };
    });
  });
}

export async function fetchTracStatistics(lanes: TracLaneInput[]): Promise<TracStatResult[]> {
  if (!lanes.length) return [];
  const cacheKey = buildTracCacheKey("stats", lanes);
  const result = await coalescedTracFetch<TracStatResult[]>(cacheKey, TRAC_STATS_TTL_S, () => rawFetchStatistics(lanes));
  return remapLaneIds(result, lanes);
}

function extractAvgRpm(data: unknown, laneId: string, origin: string, dest: string): number | null {
  if (!data) return null;
  const arr = Array.isArray((data as Record<string, unknown>)?.data)
    ? ((data as Record<string, unknown>).data as Record<string, unknown>[])
    : Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const match = arr.find(
    (r) => String(r.lane_id) === laneId || (r.origin === origin && r.destination === dest),
  );
  if (!match) return null;
  const months = Array.isArray(match.data) ? (match.data as Record<string, unknown>[]) : [];
  if (!months.length) return num(match.avg_rpm);
  const vals = months.map((m) => num(m.avg_rpm)).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function rawFetchContractRates(lanes: TracLaneInput[]): Promise<TracContractResult[]> {
  const body = buildLaneBody(lanes, daysAgo(30), todayStr());
  return tracPost("/v2/truckload/rates/contract", body).then((data: any) => {
    const arr = Array.isArray(data?.data)
      ? (data.data as Record<string, unknown>[])
      : Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    return lanes.map((lane) => {
      const match = arr.find(
        (r) => String(r.lane_id) === lane.lane_id || (r.origin === lane.origin && r.destination === lane.destination),
      );
      return {
        laneId: lane.lane_id,
        contractRpm: match ? num(match.rpm) : null,
        contractRate: match ? num(match.rate) : null,
        contractFscRpm: match ? num(match.fuel_surcharge_rpm) : null,
        contractConfidenceScore: match ? num(match.confidence_score) : null,
      };
    });
  });
}

export async function fetchTracContractRates(lanes: TracLaneInput[]): Promise<TracContractResult[]> {
  if (!lanes.length) return [];
  const cacheKey = buildTracCacheKey("contract", lanes);
  const result = await coalescedTracFetch<TracContractResult[]>(cacheKey, TRAC_CONTRACT_TTL_S, () => rawFetchContractRates(lanes));
  return remapLaneIds(result, lanes);
}

export interface FullLaneData {
  laneId: string;
  spot: TracSpotResult;
  forecast: TracForecastDay[];
  stats: TracStatResult;
  contract: TracContractResult;
}

export async function fetchFullLane(
  origin: string,
  destination: string,
  equipment: "VAN" | "REEFER" | "FLATBED" = "VAN",
): Promise<FullLaneData | null> {
  const laneId = `${origin}-${destination}-${equipment}`;
  const lane: TracLaneInput = {
    lane_id: laneId,
    origin,
    origin_country_code: "USA",
    destination,
    destination_country_code: "USA",
    equipment_type: equipment,
  };

  try {
    const [spots, forecasts, stats, contracts] = await Promise.all([
      fetchTracSpotRates([lane]).catch(() => [] as TracSpotResult[]),
      fetchTracForecast([lane]).catch(() => [] as { laneId: string; days: TracForecastDay[] }[]),
      fetchTracStatistics([lane]).catch(() => [] as TracStatResult[]),
      fetchTracContractRates([lane]).catch(() => [] as TracContractResult[]),
    ]);

    return {
      laneId,
      spot: spots[0] ?? { laneId, rpm: null, rpmHigh: null, rpmLow: null, rate: null, rateHigh: null, rateLow: null, confidenceScore: null, miles: null, totalLoadCount: null },
      forecast: forecasts[0]?.days ?? [],
      stats: stats[0] ?? { laneId, avgRpm30d: null, avgRpm90d: null },
      contract: contracts[0] ?? { laneId, contractRpm: null, contractRate: null, contractFscRpm: null, contractConfidenceScore: null },
    };
  } catch (err: unknown) {
    log(`fetchFullLane ${origin}→${destination} error: ${(err as Error).message}`);
    return null;
  }
}

export async function fetchFullLaneBatch(
  inputs: Array<{ origin: string; destination: string; equipment: "VAN" | "REEFER" | "FLATBED"; laneId: string }>,
): Promise<FullLaneData[]> {
  if (!inputs.length) return [];

  const tracLanes: TracLaneInput[] = inputs.map((i) => ({
    lane_id: i.laneId,
    origin: i.origin,
    origin_country_code: "USA",
    destination: i.destination,
    destination_country_code: "USA",
    equipment_type: i.equipment,
  }));

  log(`Fetching TRAC data for ${tracLanes.length} lanes…`);

  const delay = tracLanes.length > 10
    ? new Promise((r) => setTimeout(r, 200))
    : Promise.resolve();

  const [spots, forecasts, stats, contracts] = await Promise.all([
    delay.then(() => fetchTracSpotRates(tracLanes)).catch(() => [] as TracSpotResult[]),
    fetchTracForecast(tracLanes).catch(() => [] as { laneId: string; days: TracForecastDay[] }[]),
    fetchTracStatistics(tracLanes).catch(() => [] as TracStatResult[]),
    fetchTracContractRates(tracLanes).catch(() => [] as TracContractResult[]),
  ]);

  return tracLanes.map((lane) => ({
    laneId: lane.lane_id,
    spot: spots.find((s) => s.laneId === lane.lane_id) ?? { laneId: lane.lane_id, rpm: null, rpmHigh: null, rpmLow: null, rate: null, rateHigh: null, rateLow: null, confidenceScore: null, miles: null, totalLoadCount: null },
    forecast: forecasts.find((f) => f.laneId === lane.lane_id)?.days ?? [],
    stats: stats.find((s) => s.laneId === lane.lane_id) ?? { laneId: lane.lane_id, avgRpm30d: null, avgRpm90d: null },
    contract: contracts.find((c) => c.laneId === lane.lane_id) ?? { laneId: lane.lane_id, contractRpm: null, contractRate: null, contractFscRpm: null, contractConfidenceScore: null },
  }));
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}
