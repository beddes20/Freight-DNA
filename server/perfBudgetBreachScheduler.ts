/**
 * Task #705 — Daily perf-budget breach notifier.
 *
 * Once per day, compares yesterday's p95 latency for each tracked endpoint
 * against the budget in `perfBudgets.ts`. If a route blew its p95 budget,
 * one notification is created for every admin user — but only if no
 * breach notification for the same route has been written in the last 24h.
 * That throttle keeps the notifications feed clean when an endpoint is
 * persistently slow.
 *
 * The notification deep-links into `/admin/endpoint-perf` so the recipient
 * can drill into per-day p95 sparklines immediately.
 */
import cron from "node-cron";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./storage";
import { endpointPerfSamples, notifications, users } from "@shared/schema";
import { ENDPOINT_BUDGETS } from "./perfBudgets";
import { getErrorMessage } from "./lib/errors";

const NOTIFICATION_TYPE = "perf_budget_breach";

interface BreachRow {
  routeKey: string;
  budget: number;
  p95: number;
  requests: number;
}

/**
 * Compute which tracked routes blew their p95 budget over the look-back
 * window. Pure function over a DB read so it's easy to call from tests.
 */
export async function findBudgetBreaches(lookbackHours = 24): Promise<BreachRow[]> {
  const since = new Date(Date.now() - lookbackHours * 3_600_000);
  const rows = await db
    .select({
      routeKey: endpointPerfSamples.routeKey,
      count: sql<number>`COUNT(*)::int`,
      p95: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
    })
    .from(endpointPerfSamples)
    .where(gte(endpointPerfSamples.createdAt, since))
    .groupBy(endpointPerfSamples.routeKey);

  const breaches: BreachRow[] = [];
  for (const r of rows) {
    const budget = ENDPOINT_BUDGETS[r.routeKey];
    if (budget == null) continue;
    const p95 = Number(r.p95) || 0;
    const requests = Number(r.count) || 0;
    // Require a small minimum sample size to avoid flapping on near-empty
    // days (e.g. weekends). 20 requests is enough for p95 to be stable.
    if (requests < 20) continue;
    if (p95 > budget) {
      breaches.push({ routeKey: r.routeKey, budget, p95, requests });
    }
  }
  return breaches;
}

/**
 * Returns the route keys that have NOT been notified about in the last
 * `throttleHours` hours. Used to keep the feed quiet when an endpoint is
 * persistently slow.
 */
async function filterRecentlyNotified(
  routeKeys: string[],
  throttleHours = 24,
): Promise<string[]> {
  if (routeKeys.length === 0) return [];
  const since = new Date(Date.now() - throttleHours * 3_600_000);
  const rows = await db
    .select({ relatedId: notifications.relatedId })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, NOTIFICATION_TYPE),
        gte(notifications.createdAt, since),
      ),
    );
  const recent = new Set<string>();
  for (const r of rows) {
    if (r.relatedId) recent.add(r.relatedId);
  }
  return routeKeys.filter((k) => !recent.has(k));
}

/**
 * Run one breach-notification pass. Exposed so tests and a manual
 * "/admin/perf-budget-breach/run" trigger can invoke it without waiting
 * for cron.
 */
export async function runPerfBudgetBreachCheck(): Promise<{
  breaches: BreachRow[];
  notified: string[];
  adminCount: number;
}> {
  const breaches = await findBudgetBreaches(24);
  if (breaches.length === 0) {
    return { breaches: [], notified: [], adminCount: 0 };
  }

  const notifiable = await filterRecentlyNotified(
    breaches.map((b) => b.routeKey),
    24,
  );
  if (notifiable.length === 0) {
    return { breaches, notified: [], adminCount: 0 };
  }

  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"));
  if (admins.length === 0) {
    return { breaches, notified: [], adminCount: 0 };
  }

  const breachesByKey = new Map(breaches.map((b) => [b.routeKey, b]));
  const inserts: Array<typeof notifications.$inferInsert> = [];
  for (const routeKey of notifiable) {
    const b = breachesByKey.get(routeKey);
    if (!b) continue;
    for (const a of admins) {
      inserts.push({
        userId: a.id,
        type: NOTIFICATION_TYPE,
        title: `Performance budget breached: ${routeKey}`,
        body: `p95 was ${b.p95}ms over the last 24h (budget: ${b.budget}ms, ${b.requests} requests). Investigate caches and slow joins.`,
        link: "/admin/endpoint-perf",
        relatedId: routeKey,
      });
    }
  }

  if (inserts.length > 0) {
    await db.insert(notifications).values(inserts);
  }
  return { breaches, notified: notifiable, adminCount: admins.length };
}

let scheduled: ReturnType<typeof cron.schedule> | null = null;

/**
 * Wire the daily breach check into the cron scheduler. Runs at 7:30am CT
 * every day — late enough that yesterday's data is settled, early enough
 * that admins see the alert before the morning standup.
 */
export function initPerfBudgetBreachScheduler(): void {
  if (scheduled) return;
  scheduled = cron.schedule(
    "30 7 * * *",
    () => {
      runPerfBudgetBreachCheck()
        .then((r) => {
          if (r.breaches.length === 0) {
            console.log("[perf-breach] no budget breaches in last 24h");
            return;
          }
          console.log(
            `[perf-breach] ${r.breaches.length} breach(es); notified ${r.notified.length} route(s) × ${r.adminCount} admin(s)`,
          );
        })
        .catch((err) => {
          console.error("[perf-breach] check failed:", getErrorMessage(err));
        });
    },
    { timezone: "America/Chicago" },
  );
  console.log("[perf-breach] scheduler initialized (daily 7:30am CT)");
}
