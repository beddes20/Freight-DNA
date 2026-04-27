/**
 * Task #705 — Daily perf-budget breach notifier.
 *
 * Once per day, compares yesterday's p95 latency for each tracked endpoint —
 * per organization — against the budget in `perfBudgets.ts`. If a route
 * blew its p95 budget for an org, one notification is created for every
 * admin user *in that org* — but only if no breach notification for the
 * same `(orgId, routeKey)` pair has been written in the last 24h. That
 * throttle keeps the notifications feed clean when an endpoint is
 * persistently slow, and the per-org grouping prevents one tenant's perf
 * problems from spamming admins in unrelated orgs.
 *
 * The notification deep-links into `/admin/endpoint-perf` so the recipient
 * can drill into per-day p95 sparklines immediately.
 */
import cron from "node-cron";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "./storage";
import { endpointPerfSamples, notifications, users } from "@shared/schema";
import { ENDPOINT_BUDGETS } from "./perfBudgets";
import { getErrorMessage } from "./lib/errors";

const NOTIFICATION_TYPE = "perf_budget_breach";

interface BreachRow {
  organizationId: string;
  routeKey: string;
  budget: number;
  p95: number;
  requests: number;
}

function throttleKey(organizationId: string, routeKey: string): string {
  return `${organizationId}:${routeKey}`;
}

/**
 * Compute which (org, route) pairs blew their p95 budget over the look-back
 * window. Pure function over a DB read so it's easy to call from tests.
 *
 * Rows with a null organizationId (e.g. unauthenticated 401s) are ignored
 * — they aren't actionable for any tenant's admin.
 */
export async function findBudgetBreaches(lookbackHours = 24): Promise<BreachRow[]> {
  const since = new Date(Date.now() - lookbackHours * 3_600_000);
  const rows = await db
    .select({
      organizationId: endpointPerfSamples.organizationId,
      routeKey: endpointPerfSamples.routeKey,
      count: sql<number>`COUNT(*)::int`,
      p95: sql<number>`PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ${endpointPerfSamples.durationMs})::int`,
    })
    .from(endpointPerfSamples)
    .where(
      and(
        gte(endpointPerfSamples.createdAt, since),
        isNotNull(endpointPerfSamples.organizationId),
      ),
    )
    .groupBy(endpointPerfSamples.organizationId, endpointPerfSamples.routeKey);

  const breaches: BreachRow[] = [];
  for (const r of rows) {
    const budget = ENDPOINT_BUDGETS[r.routeKey];
    if (budget == null) continue;
    if (!r.organizationId) continue;
    const p95 = Number(r.p95) || 0;
    const requests = Number(r.count) || 0;
    // Require a small minimum sample size to avoid flapping on near-empty
    // days (e.g. weekends). 20 requests is enough for p95 to be stable.
    if (requests < 20) continue;
    if (p95 > budget) {
      breaches.push({
        organizationId: r.organizationId,
        routeKey: r.routeKey,
        budget,
        p95,
        requests,
      });
    }
  }
  return breaches;
}

/**
 * Returns the (org, route) pairs that have NOT been notified about in the
 * last `throttleHours` hours. Throttling on the composite key keeps one
 * tenant's persistently-slow endpoint from suppressing alerts for another
 * tenant on the same route.
 */
async function filterRecentlyNotified(
  pairs: Array<{ organizationId: string; routeKey: string }>,
  throttleHours = 24,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
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
  const eligible = new Set<string>();
  for (const p of pairs) {
    const key = throttleKey(p.organizationId, p.routeKey);
    if (!recent.has(key)) eligible.add(key);
  }
  return eligible;
}

/**
 * Run one breach-notification pass. Exposed so tests and a manual
 * "/admin/perf-budget-breach/run" trigger can invoke it without waiting
 * for cron.
 */
export async function runPerfBudgetBreachCheck(): Promise<{
  breaches: BreachRow[];
  notified: Array<{ organizationId: string; routeKey: string }>;
  adminCount: number;
}> {
  const breaches = await findBudgetBreaches(24);
  if (breaches.length === 0) {
    return { breaches: [], notified: [], adminCount: 0 };
  }

  const eligibleKeys = await filterRecentlyNotified(
    breaches.map((b) => ({ organizationId: b.organizationId, routeKey: b.routeKey })),
    24,
  );
  if (eligibleKeys.size === 0) {
    return { breaches, notified: [], adminCount: 0 };
  }

  // Fetch all admins once, then partition by org so each tenant only sees
  // its own breach notifications.
  const adminRows = await db
    .select({ id: users.id, organizationId: users.organizationId })
    .from(users)
    .where(eq(users.role, "admin"));
  if (adminRows.length === 0) {
    return { breaches, notified: [], adminCount: 0 };
  }
  const adminsByOrg = new Map<string, string[]>();
  for (const a of adminRows) {
    if (!a.organizationId) continue;
    const arr = adminsByOrg.get(a.organizationId) ?? [];
    arr.push(a.id);
    adminsByOrg.set(a.organizationId, arr);
  }

  const notified: Array<{ organizationId: string; routeKey: string }> = [];
  const inserts: Array<typeof notifications.$inferInsert> = [];
  let adminFanout = 0;
  for (const b of breaches) {
    const key = throttleKey(b.organizationId, b.routeKey);
    if (!eligibleKeys.has(key)) continue;
    const orgAdmins = adminsByOrg.get(b.organizationId) ?? [];
    if (orgAdmins.length === 0) continue;
    notified.push({ organizationId: b.organizationId, routeKey: b.routeKey });
    for (const adminId of orgAdmins) {
      inserts.push({
        userId: adminId,
        type: NOTIFICATION_TYPE,
        title: `Performance budget breached: ${b.routeKey}`,
        body: `p95 was ${b.p95}ms over the last 24h (budget: ${b.budget}ms, ${b.requests} requests). Investigate caches and slow joins.`,
        link: "/admin/endpoint-perf",
        relatedId: key,
      });
      adminFanout += 1;
    }
  }

  if (inserts.length > 0) {
    await db.insert(notifications).values(inserts);
  }
  return { breaches, notified, adminCount: adminFanout };
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
            `[perf-breach] ${r.breaches.length} breach(es); notified ${r.notified.length} (org,route) pair(s) × ${r.adminCount} admin notification(s)`,
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
