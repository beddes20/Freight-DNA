/**
 * Sonar admin alerting (Task #465)
 *
 * Centralized notify-admins helper used by:
 *   - sonarDailyRefreshScheduler (daily pull returned no data)
 *   - sonarClient withDeadline (live lane calls exceeded budget)
 *
 * All notifications use the existing `notifications` table with
 * type="system". Dedup is by relatedId="<key>:<YYYY-MM-DD>" so each admin
 * gets at most one notification per category per day.
 */

import { storage } from "./storage";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function notifyAdminsOfSystemEvent(opts: {
  relatedIdPrefix: string;
  title: string;
  body: string;
  link?: string;
}): Promise<void> {
  try {
    const orgs = await storage.getOrganizations().catch(() => []);
    const dedupeKey = `${opts.relatedIdPrefix}:${todayKey()}`;
    for (const org of orgs) {
      const users = await storage.getUsers(org.id).catch(() => []);
      const admins = users.filter((u: any) => u.role === "admin");
      for (const admin of admins) {
        const seen = await storage
          .hasAnyNotification(admin.id, "system", dedupeKey)
          .catch(() => false);
        if (seen) continue;
        await storage
          .createNotification({
            userId: admin.id,
            type: "system",
            title: opts.title,
            body: opts.body,
            link: opts.link ?? "/api/sonar/health",
            relatedId: dedupeKey,
            read: false,
          })
          .catch((err: any) => {
            console.error(`[sonar-alert] notify failed: ${err?.message ?? err}`);
          });
      }
    }
  } catch (err: any) {
    console.error(`[sonar-alert] notify pipeline error: ${err?.message ?? err}`);
  }
}

// ── Lane-timeout aggregation ───────────────────────────────────────────────
//
// Live lane Sonar calls can timeout in bursts (e.g. when many cards refresh
// at once). We aggregate per-day, fire one admin notification once a daily
// threshold is crossed, then keep counting silently for the health endpoint.

const LANE_TIMEOUT_NOTIFY_THRESHOLD = 3;

interface LaneTimeoutDayState {
  date: string;
  count: number;
  samples: string[];
  notified: boolean;
}

let laneTimeoutsToday: LaneTimeoutDayState = {
  date: todayKey(),
  count: 0,
  samples: [],
  notified: false,
};

function rolloverIfNeeded(): void {
  const today = todayKey();
  if (laneTimeoutsToday.date !== today) {
    laneTimeoutsToday = { date: today, count: 0, samples: [], notified: false };
  }
}

export function recordLaneTimeout(label: string): void {
  rolloverIfNeeded();
  laneTimeoutsToday.count += 1;
  if (laneTimeoutsToday.samples.length < 5) laneTimeoutsToday.samples.push(label);

  if (
    !laneTimeoutsToday.notified &&
    laneTimeoutsToday.count >= LANE_TIMEOUT_NOTIFY_THRESHOLD
  ) {
    laneTimeoutsToday.notified = true;
    const samples = laneTimeoutsToday.samples.join(", ");
    void notifyAdminsOfSystemEvent({
      relatedIdPrefix: "sonar_lane_timeout",
      title: "Sonar lane pricing slow / timing out",
      body:
        `${laneTimeoutsToday.count} live lane Sonar call(s) exceeded their ` +
        `hard timeout today (e.g. ${samples}). Inspect /api/sonar/health to see ` +
        `whether the issue is auth, FreightWaves account entitlements, or upstream latency.`,
      link: "/api/sonar/health",
    });
  }
}

export function getLaneTimeoutStats(): LaneTimeoutDayState {
  rolloverIfNeeded();
  return { ...laneTimeoutsToday };
}

// ── Long-open breaker alert (Task #740) ────────────────────────────────────
//
// During business hours (Mon–Fri 07:00–19:00 America/Chicago) we want to
// know quickly if the SONAR circuit breaker has been open for ≥60 minutes —
// that's the threshold at which "the platform briefly hiccuped" turns into
// "real-time data is materially unavailable for our users."
//
// We track the breaker-open episode start time in this module so the alert
// fires once per episode (it resets when the breaker closes).

const LONG_OPEN_THRESHOLD_MS = 60 * 60 * 1000;

interface BreakerEpisode {
  openedAt: number;
  notified: boolean;
}

let currentEpisode: BreakerEpisode | null = null;

export function _resetBreakerEpisodeForTests(): void {
  currentEpisode = null;
}

/**
 * Returns true when `now` falls inside Mon–Fri 07:00–19:00 in
 * America/Chicago. Implemented with `Intl.DateTimeFormat` so daylight-saving
 * transitions are handled correctly without pulling in an extra dependency.
 */
export function isBusinessHoursCT(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "00";
  // `hour: "2-digit"` with `hour12: false` returns "00".."23".
  const hour = parseInt(hourStr, 10);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  return isWeekday && hour >= 7 && hour < 19;
}

/**
 * Polled periodically by the daily-refresh scheduler. Reads the current
 * breaker status and, if it's been open ≥60 min during business hours, fires
 * a one-shot admin alert for this open-episode.
 */
export async function checkBreakerLongOpen(
  breakerStatus: { isOpen: boolean; trippedAt: string | null; resumesAt: string | null },
  now: Date = new Date(),
): Promise<void> {
  if (!breakerStatus.isOpen) {
    currentEpisode = null;
    return;
  }

  const trippedMs = breakerStatus.trippedAt ? Date.parse(breakerStatus.trippedAt) : now.getTime();
  if (!currentEpisode || currentEpisode.openedAt !== trippedMs) {
    currentEpisode = { openedAt: trippedMs, notified: false };
  }

  if (currentEpisode.notified) return;
  if (now.getTime() - currentEpisode.openedAt < LONG_OPEN_THRESHOLD_MS) return;
  if (!isBusinessHoursCT(now)) return;

  currentEpisode.notified = true;
  const minutesOpen = Math.round((now.getTime() - currentEpisode.openedAt) / 60_000);
  await notifyAdminsOfSystemEvent({
    relatedIdPrefix: `sonar_breaker_long_open:${currentEpisode.openedAt}`,
    title: "SONAR circuit breaker open ≥60 min during business hours",
    body:
      `The FreightWaves SONAR circuit breaker has been open for ${minutesOpen} ` +
      `minutes (since ${new Date(currentEpisode.openedAt).toISOString()}). ` +
      `Live market data is currently being served from cached snapshots only — ` +
      `quote workbench / lane detail / NBA builder will see "Market Data ` +
      `Unavailable / Stale" pills until upstream recovers. ` +
      `Inspect /api/sonar/health for breaker resume time and call counters.`,
    link: "/api/sonar/health",
  });
}
