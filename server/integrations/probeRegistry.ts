/**
 * Task #701 — Integration probe registry.
 *
 * Each external integration registers a probe function returning the
 * `IntegrationHealthSnapshot` shape. Probes default to "cheap" mode that
 * reads in-process state (last call timestamps, breaker state) without
 * issuing a live external call. The admin "test now" button passes
 * `{ liveProbe: true }` to force a real check.
 */

export const INTEGRATION_SOURCES = [
  "sonar",
  "graph",
  "webex",
  "zoominfo",
  "onedrive",
  "trac",
  "stripe",
] as const;
export type IntegrationSource = typeof INTEGRATION_SOURCES[number];

export type HealthState = "healthy" | "degraded" | "unknown" | "disabled";

export interface IntegrationHealthSnapshot {
  source: IntegrationSource;
  connected: boolean;
  healthState: HealthState;
  lastSuccessAt?: Date | null;
  lastErrorAt?: Date | null;
  lastErrorMessage?: string | null;
  breakerState?: "closed" | "open" | "half_open" | null;
  detail?: Record<string, unknown> | null;
}

export interface ProbeOptions { liveProbe?: boolean }
export type ProbeFn = (opts: ProbeOptions) => Promise<IntegrationHealthSnapshot>;

const probes: Record<IntegrationSource, ProbeFn> = {
  sonar: defaultProbe.bind(null, "sonar"),
  graph: defaultProbe.bind(null, "graph"),
  webex: defaultProbe.bind(null, "webex"),
  zoominfo: defaultProbe.bind(null, "zoominfo"),
  onedrive: defaultProbe.bind(null, "onedrive"),
  trac: defaultProbe.bind(null, "trac"),
  stripe: defaultProbe.bind(null, "stripe"),
};

/**
 * Tiny in-process event bus the resilience helper writes to (Task #706).
 * Each integration calls `recordIntegrationEvent({ source, outcome,
 * latencyMs, error })` after every external call so the probes can read
 * last-success / last-error / breaker hints without a DB round-trip.
 */
const lastEvents = new Map<IntegrationSource, {
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  breakerState: "closed" | "open" | "half_open" | null;
  totalSuccess: number;
  totalError: number;
}>();

export function recordIntegrationEvent(input: {
  source: IntegrationSource;
  outcome: "success" | "error" | "breaker_open";
  errorMessage?: string | null;
  breakerState?: "closed" | "open" | "half_open" | null;
}): void {
  const cur = lastEvents.get(input.source) ?? {
    lastSuccessAt: null, lastErrorAt: null, lastErrorMessage: null,
    breakerState: null, totalSuccess: 0, totalError: 0,
  };
  const now = new Date();
  if (input.outcome === "success") {
    cur.lastSuccessAt = now;
    cur.totalSuccess += 1;
  } else {
    cur.lastErrorAt = now;
    cur.lastErrorMessage = input.errorMessage ?? null;
    cur.totalError += 1;
  }
  if (input.breakerState !== undefined) cur.breakerState = input.breakerState;
  lastEvents.set(input.source, cur);
}

async function defaultProbe(source: IntegrationSource, _opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  const ev = lastEvents.get(source);
  if (!ev) {
    return {
      source,
      connected: !!process.env[envKeyFor(source)],
      healthState: process.env[envKeyFor(source)] ? "unknown" : "disabled",
      detail: { reason: "no events yet" },
    };
  }
  const recentlySucceeded = ev.lastSuccessAt && (Date.now() - ev.lastSuccessAt.getTime()) < 30 * 60_000;
  const recentlyErrored = ev.lastErrorAt && (Date.now() - ev.lastErrorAt.getTime()) < 5 * 60_000;
  const breakerOpen = ev.breakerState === "open";
  const healthState: HealthState = breakerOpen
    ? "degraded"
    : recentlyErrored && !recentlySucceeded
      ? "degraded"
      : recentlySucceeded ? "healthy" : "unknown";
  return {
    source,
    connected: true,
    healthState,
    lastSuccessAt: ev.lastSuccessAt,
    lastErrorAt: ev.lastErrorAt,
    lastErrorMessage: ev.lastErrorMessage,
    breakerState: ev.breakerState,
    detail: { totalSuccess: ev.totalSuccess, totalError: ev.totalError },
  };
}

function envKeyFor(source: IntegrationSource): string {
  switch (source) {
    case "sonar": return "SONAR_API_KEY";
    case "graph": return "OUTLOOK_CLIENT_ID";
    case "webex": return "WEBEX_CLIENT_ID";
    case "zoominfo": return "ZOOMINFO_USERNAME";
    case "onedrive": return "OUTLOOK_CLIENT_ID";
    case "trac": return "TRAC_BEARER_TOKEN";
    case "stripe": return "STRIPE_SECRET_KEY";
  }
}

export function registerProbe(source: IntegrationSource, fn: ProbeFn): void {
  probes[source] = fn;
}

export async function runAllProbes(): Promise<IntegrationHealthSnapshot[]> {
  const out = await Promise.allSettled(
    INTEGRATION_SOURCES.map((s) => withTimeout(probes[s]({ liveProbe: false }), 4_000)),
  );
  return out.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      source: INTEGRATION_SOURCES[i],
      connected: false,
      healthState: "unknown" as const,
      lastErrorMessage: String((r as PromiseRejectedResult).reason ?? "probe failed"),
    };
  });
}

export async function runOneProbe(source: IntegrationSource, opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  return await withTimeout(probes[source](opts), 8_000);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("probe timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
