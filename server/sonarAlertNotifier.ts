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
