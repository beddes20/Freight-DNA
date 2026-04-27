/**
 * Task #701 — Integration probe registry.
 *
 * Each external integration registers a probe function returning the
 * `IntegrationHealthSnapshot` shape. Probes default to "cheap" mode that
 * reads in-process state (last call timestamps, breaker state, env-var
 * presence, OAuth state) without issuing a live external call. The admin
 * "test now" button passes `{ liveProbe: true }` to force a real check
 * for integrations that support one (currently ZoomInfo).
 */

import { getSonarCircuitBreakerStatus, getSonarCallCounters } from "../sonarClient";
import { azureCredentialsConfigured } from "../graphService";
import { getMailReadConsentStatus } from "../graphSubscriptionService";
import { getWebexAuthState, webexNeedsReauth } from "../webexService";
import { testZoomInfoConnection } from "../zoominfo";

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

/**
 * Tiny in-process event bus the resilience helper writes to (Task #706).
 * Each integration calls `recordIntegrationEvent({ source, outcome,
 * errorMessage, breakerState })` after every external call so the probes
 * can read last-success / last-error / breaker hints without a DB round-trip.
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

/** Reset the in-process event bus. Test-only — never used by production code. */
export function _resetIntegrationEventsForTests(): void {
  lastEvents.clear();
}

/**
 * Returns the env-var name that an admin will most likely recognize as the
 * "primary credential" for a source. Used as the `reason` string when the
 * integration is reported as `disabled`. The actual configured-check uses
 * `envConfigured()` below, which mirrors the credential logic of each
 * real client (e.g. SONAR accepts either FREIGHTWAVES_TOKEN or the
 * SONAR_USERNAME/SONAR_PASSWORD pair; ZoomInfo uses CLIENT_ID/SECRET).
 */
function envKeyFor(source: IntegrationSource): string {
  switch (source) {
    case "sonar": return "FREIGHTWAVES_TOKEN";
    case "graph": return "OUTLOOK_CLIENT_ID";
    case "webex": return "WEBEX_CLIENT_ID";
    case "zoominfo": return "ZOOMINFO_CLIENT_ID";
    case "onedrive": return "OUTLOOK_CLIENT_ID";
    case "trac": return "FREIGHTWAVES_TOKEN";
    case "stripe": return "STRIPE_SECRET_KEY";
  }
}

/**
 * Per-source credential check. Mirrors the env-var logic of each real
 * client so the health console never reports `disabled` when the
 * underlying integration would actually authenticate successfully.
 *  - SONAR (`server/sonarClient.ts`): direct bearer (`FREIGHTWAVES_TOKEN`)
 *    OR username/password fallback (`SONAR_USERNAME` + `SONAR_PASSWORD`).
 *  - ZoomInfo (`server/zoominfo.ts`): OAuth2 client credentials
 *    (`ZOOMINFO_CLIENT_ID` + `ZOOMINFO_CLIENT_SECRET`).
 *  - All other sources: single primary env var from `envKeyFor()`.
 */
function envConfigured(source: IntegrationSource): boolean {
  switch (source) {
    case "sonar":
      return (
        !!process.env.FREIGHTWAVES_TOKEN ||
        (!!process.env.SONAR_USERNAME && !!process.env.SONAR_PASSWORD)
      );
    case "zoominfo":
      return !!process.env.ZOOMINFO_CLIENT_ID && !!process.env.ZOOMINFO_CLIENT_SECRET;
    default:
      return !!process.env[envKeyFor(source)];
  }
}

/**
 * Apply the rolling-event freshness rules to a snapshot. Returns
 * `degraded` when the breaker is open or when the most recent error is
 * within 5 minutes and there's no success in the last 30 minutes.
 */
function freshnessHealthState(source: IntegrationSource): {
  healthState: HealthState;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
  breakerState: "closed" | "open" | "half_open" | null;
  totals: { totalSuccess: number; totalError: number };
} {
  const ev = lastEvents.get(source);
  if (!ev) {
    return {
      healthState: envConfigured(source) ? "unknown" : "disabled",
      lastSuccessAt: null, lastErrorAt: null, lastErrorMessage: null,
      breakerState: null, totals: { totalSuccess: 0, totalError: 0 },
    };
  }
  const recentlySucceeded = !!ev.lastSuccessAt && (Date.now() - ev.lastSuccessAt.getTime()) < 30 * 60_000;
  const recentlyErrored = !!ev.lastErrorAt && (Date.now() - ev.lastErrorAt.getTime()) < 5 * 60_000;
  const breakerOpen = ev.breakerState === "open";
  const healthState: HealthState = breakerOpen
    ? "degraded"
    : recentlyErrored && !recentlySucceeded
      ? "degraded"
      : recentlySucceeded ? "healthy" : "unknown";
  return {
    healthState,
    lastSuccessAt: ev.lastSuccessAt,
    lastErrorAt: ev.lastErrorAt,
    lastErrorMessage: ev.lastErrorMessage,
    breakerState: ev.breakerState,
    totals: { totalSuccess: ev.totalSuccess, totalError: ev.totalError },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-integration probe implementations
// ──────────────────────────────────────────────────────────────────────────

async function probeSonar(_opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  if (!envConfigured("sonar")) {
    return {
      source: "sonar",
      connected: false,
      healthState: "disabled",
      detail: { reason: "FREIGHTWAVES_TOKEN (or SONAR_USERNAME + SONAR_PASSWORD) missing" },
    };
  }
  const breaker = getSonarCircuitBreakerStatus();
  const fresh = freshnessHealthState("sonar");
  const callBudget = getSonarCallCounters();
  // Breaker authoritative: if it's open, always degraded regardless of events.
  const healthState: HealthState = breaker.isOpen
    ? "degraded"
    : fresh.healthState;
  return {
    source: "sonar",
    connected: true,
    healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: breaker.isOpen
      ? `Circuit breaker tripped at ${breaker.trippedAt}; resumes ${breaker.resumesAt}`
      : fresh.lastErrorMessage,
    breakerState: breaker.isOpen ? "open" : (fresh.breakerState ?? "closed"),
    detail: { ...fresh.totals, breaker, callBudget },
  };
}

async function probeGraph(_opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  if (!azureCredentialsConfigured()) {
    return { source: "graph", connected: false, healthState: "disabled", detail: { reason: "Azure (Graph) credentials not configured" } };
  }
  const consent = getMailReadConsentStatus();
  const fresh = freshnessHealthState("graph");
  // Mail.Read consent missing or stale → degraded (the common in-prod failure).
  const consentDegraded = consent.status !== "granted";
  const healthState: HealthState = consentDegraded ? "degraded" : fresh.healthState;
  return {
    source: "graph",
    connected: true,
    healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: consentDegraded
      ? (consent.lastError ?? `Mail.Read consent: ${consent.status}`)
      : fresh.lastErrorMessage,
    breakerState: fresh.breakerState,
    detail: { ...fresh.totals, mailReadConsent: consent },
  };
}

async function probeOneDrive(_opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  // OneDrive flows through the same Azure app + Graph token. We keep a
  // separate source so the admin can see the file-sync state independently
  // from inbound mail consent.
  if (!azureCredentialsConfigured()) {
    return { source: "onedrive", connected: false, healthState: "disabled", detail: { reason: "Azure (OneDrive) credentials not configured" } };
  }
  const fresh = freshnessHealthState("onedrive");
  return {
    source: "onedrive",
    connected: true,
    healthState: fresh.healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: fresh.lastErrorMessage,
    breakerState: fresh.breakerState,
    detail: { ...fresh.totals },
  };
}

async function probeWebex(_opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  const auth = getWebexAuthState();
  if (!auth.configured) {
    return { source: "webex", connected: false, healthState: "disabled", detail: { reason: "Webex client credentials not configured" } };
  }
  const needsReauth = webexNeedsReauth();
  const fresh = freshnessHealthState("webex");
  const healthState: HealthState = needsReauth ? "degraded" : fresh.healthState;
  return {
    source: "webex",
    connected: !needsReauth && auth.hasRefreshToken,
    healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: needsReauth
      ? (auth.lastRefreshError ?? "Webex org token revoked or expired — admin needs to reconnect")
      : fresh.lastErrorMessage,
    breakerState: fresh.breakerState,
    detail: {
      ...fresh.totals,
      hasRefreshToken: auth.hasRefreshToken,
      accessTokenExpiresAt: auth.accessTokenExpiresAt,
      lastRefreshAt: auth.lastRefreshAt,
    },
  };
}

async function probeZoomInfo(opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  // Use the shared envConfigured() so this stays in lockstep with
  // server/zoominfo.ts (OAuth2 client credentials: CLIENT_ID + CLIENT_SECRET).
  if (!envConfigured("zoominfo")) {
    return {
      source: "zoominfo",
      connected: false,
      healthState: "disabled",
      detail: { reason: "ZOOMINFO_CLIENT_ID + ZOOMINFO_CLIENT_SECRET missing" },
    };
  }
  const fresh = freshnessHealthState("zoominfo");
  if (opts.liveProbe) {
    try {
      const ok = await testZoomInfoConnection();
      if (ok) recordIntegrationEvent({ source: "zoominfo", outcome: "success" });
      return {
        source: "zoominfo",
        connected: ok,
        healthState: ok ? "healthy" : "degraded",
        lastSuccessAt: ok ? new Date() : fresh.lastSuccessAt,
        lastErrorAt: ok ? fresh.lastErrorAt : new Date(),
        lastErrorMessage: ok ? null : "ZoomInfo authentication failed",
        breakerState: fresh.breakerState,
        detail: { ...fresh.totals, liveProbe: true },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordIntegrationEvent({ source: "zoominfo", outcome: "error", errorMessage: msg });
      return {
        source: "zoominfo", connected: false, healthState: "degraded",
        lastSuccessAt: fresh.lastSuccessAt, lastErrorAt: new Date(),
        lastErrorMessage: msg, breakerState: fresh.breakerState,
        detail: { ...fresh.totals, liveProbe: true },
      };
    }
  }
  return {
    source: "zoominfo",
    connected: true,
    healthState: fresh.healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: fresh.lastErrorMessage,
    breakerState: fresh.breakerState,
    detail: { ...fresh.totals },
  };
}

async function probeTrac(_opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  if (!envConfigured("trac")) {
    return { source: "trac", connected: false, healthState: "disabled", detail: { reason: "FREIGHTWAVES_TOKEN missing" } };
  }
  const fresh = freshnessHealthState("trac");
  return {
    source: "trac",
    connected: true,
    healthState: fresh.healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: fresh.lastErrorMessage,
    breakerState: fresh.breakerState,
    detail: { ...fresh.totals },
  };
}

async function probeStripe(_opts: ProbeOptions): Promise<IntegrationHealthSnapshot> {
  if (!envConfigured("stripe")) {
    return { source: "stripe", connected: false, healthState: "disabled", detail: { reason: "STRIPE_SECRET_KEY missing" } };
  }
  const fresh = freshnessHealthState("stripe");
  return {
    source: "stripe",
    connected: true,
    healthState: fresh.healthState,
    lastSuccessAt: fresh.lastSuccessAt,
    lastErrorAt: fresh.lastErrorAt,
    lastErrorMessage: fresh.lastErrorMessage,
    breakerState: fresh.breakerState,
    detail: { ...fresh.totals },
  };
}

const probes: Record<IntegrationSource, ProbeFn> = {
  sonar: probeSonar,
  graph: probeGraph,
  webex: probeWebex,
  zoominfo: probeZoomInfo,
  onedrive: probeOneDrive,
  trac: probeTrac,
  stripe: probeStripe,
};

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
