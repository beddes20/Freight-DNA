/**
 * tracService.ts — FreightWaves TRAC API client
 *
 * Endpoints:
 *   POST /v2/truckload/rates/trac           → spot rates
 *   POST /v2/truckload/rates/trac/forecast  → 14-day daily forecast
 *   POST /v2/truckload/rates/trac/statistics → monthly historical stats
 *   POST /v2/truckload/rates/contract       → contract rates + FSC
 */

const TRAC_BASE = "https://api.freightwaves.com";
const TOKEN = () => process.env.FREIGHTWAVES_TOKEN ?? "";

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-US", { hour12: true, hour: "numeric", minute: "2-digit", second: "2-digit" });
  console.log(`${t} [trac] ${msg}`);
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${TRAC_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`TRAC ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Build lane request payload */
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

/**
 * Fetch spot rates for the last 7 days.
 */
export async function fetchTracSpotRates(lanes: TracLaneInput[]): Promise<TracSpotResult[]> {
  if (!lanes.length) return [];
  const body = buildLaneBody(lanes, daysAgo(7), todayStr());
  const data = await tracPost("/v2/truckload/rates/trac", body) as { data?: unknown[] };
  const rows: TracSpotResult[] = [];
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? (data as unknown[]) : [];
  for (const lane of lanes) {
    const match = (arr as Record<string, unknown>[]).find(
      (r) => String(r.lane_id) === lane.lane_id || (r.origin === lane.origin && r.destination === lane.destination),
    );
    if (match) {
      rows.push({
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
      });
    } else {
      rows.push({ laneId: lane.lane_id, rpm: null, rpmHigh: null, rpmLow: null, rate: null, rateHigh: null, rateLow: null, confidenceScore: null, miles: null, totalLoadCount: null });
    }
  }
  return rows;
}

/**
 * Fetch 14-day daily forecast.
 */
export async function fetchTracForecast(lanes: TracLaneInput[]): Promise<{ laneId: string; days: TracForecastDay[] }[]> {
  if (!lanes.length) return [];
  const body = buildLaneBody(lanes, todayStr(), daysAhead(14));
  const data = await tracPost("/v2/truckload/rates/trac/forecast", body) as { data?: unknown };
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
}

/**
 * Fetch monthly historical statistics (last 30 + 90 days).
 */
export async function fetchTracStatistics(lanes: TracLaneInput[]): Promise<TracStatResult[]> {
  if (!lanes.length) return [];

  // Fetch 90-day monthly stats
  const body90 = buildLaneBody(lanes, daysAgo(90), todayStr());
  const body30 = buildLaneBody(lanes, daysAgo(30), todayStr());

  const [data90Raw, data30Raw] = await Promise.all([
    tracPost("/v2/truckload/rates/trac/statistics", { ...body90, aggregation: "monthly" }).catch(() => null),
    tracPost("/v2/truckload/rates/trac/statistics", { ...body30, aggregation: "monthly" }).catch(() => null),
  ]);

  return lanes.map((lane) => {
    const avg90 = extractAvgRpm(data90Raw, lane.lane_id, lane.origin, lane.destination);
    const avg30 = extractAvgRpm(data30Raw, lane.lane_id, lane.origin, lane.destination);
    return { laneId: lane.lane_id, avgRpm30d: avg30, avgRpm90d: avg90 };
  });
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
  // Average the avg_rpm values across months
  const months = Array.isArray(match.data) ? (match.data as Record<string, unknown>[]) : [];
  if (!months.length) return num(match.avg_rpm);
  const vals = months.map((m) => num(m.avg_rpm)).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Fetch contract rates for the last 30 days.
 */
export async function fetchTracContractRates(lanes: TracLaneInput[]): Promise<TracContractResult[]> {
  if (!lanes.length) return [];
  const body = buildLaneBody(lanes, daysAgo(30), todayStr());
  const data = await tracPost("/v2/truckload/rates/contract", body) as { data?: unknown };
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
}

/**
 * Full fetch for a single lane — all data types in parallel.
 */
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

/**
 * Fetch full data for multiple lanes with 200ms staggering if > 10 lanes.
 */
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
