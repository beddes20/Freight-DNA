/**
 * Portlet Freshness helper (Dashboard Trust Pass — Phase 1.5).
 *
 * Reads cron_heartbeats and derives a PortletFreshness signal for scoped
 * dashboard endpoints (Award Health + Coverage Gaps wired in S2; NBA /
 * Trending / Margin / Relationship Advancement land in later slices).
 *
 * Lets the UI distinguish:
 *   - "no items today"        (status: "ok",      list empty)
 *   - "upstream stale/failed" (status: "stale",   show degraded banner)
 *   - "freshness unknown"     (status: "unknown", neutral grey — never escalate)
 *
 * Status derivation:
 *   - ok      — lastStatus === "success" AND consecutiveFailures === 0 AND
 *               (now - lastFinishedAt) < expectedIntervalMs * STALE_MULTIPLIER
 *   - stale   — heartbeat exists but lastStatus === "error", OR
 *               consecutiveFailures > 0, OR
 *               (now - lastFinishedAt) >= expectedIntervalMs * STALE_MULTIPLIER, OR
 *               lastFinishedAt is null (job has never completed a tick).
 *   - unknown — no rows for any of the supplied jobs, OR the heartbeat
 *               read itself errored. NEVER collapse unknown into stale —
 *               that misled reps in Task #1109a pilot.
 *
 * Composite ("worst-of") for portlets that depend on multiple jobs:
 *   stale > ok; among rows of the same status the OLDEST lastFinishedAt
 *   wins (and a null lastFinishedAt is treated as the worst possible age).
 *   `source` reports the job that drove the composite verdict so the UI
 *   can attribute the stale signal precisely.
 */
import { inArray } from "drizzle-orm";
import { db } from "../storage";
import {
  cronHeartbeats,
  portletFreshnessSchema,
  type PortletFreshness,
} from "../../shared/schema";
import type { JobName } from "./cronHeartbeat";

const STALE_MULTIPLIER = 2;

type HeartbeatRow = typeof cronHeartbeats.$inferSelect;

function unknownFreshness(source: string): PortletFreshness {
  return {
    source,
    status: "unknown",
    lastUpdatedAt: null,
    nextExpectedAt: null,
    consecutiveFailures: 0,
  };
}

function rowToFreshness(row: HeartbeatRow): PortletFreshness {
  const now = Date.now();
  const finishedAtMs = row.lastFinishedAt ? row.lastFinishedAt.getTime() : null;
  const ageMs = finishedAtMs == null ? null : now - finishedAtMs;
  const windowMs = row.expectedIntervalMs * STALE_MULTIPLIER;
  const failures = row.consecutiveFailures ?? 0;

  let status: "ok" | "stale" = "stale";
  if (
    row.lastStatus === "success" &&
    failures === 0 &&
    ageMs != null &&
    ageMs < windowMs
  ) {
    status = "ok";
  }

  return {
    source: row.jobName,
    status,
    lastUpdatedAt: row.lastFinishedAt ? row.lastFinishedAt.toISOString() : null,
    nextExpectedAt: row.nextExpectedAt ? row.nextExpectedAt.toISOString() : null,
    consecutiveFailures: failures,
  };
}

function pickWorst(a: PortletFreshness, b: PortletFreshness): PortletFreshness {
  // stale beats ok; null/missing lastUpdatedAt is "infinitely old".
  if (a.status === "stale" && b.status !== "stale") return a;
  if (b.status === "stale" && a.status !== "stale") return b;
  const aMs = a.lastUpdatedAt ? Date.parse(a.lastUpdatedAt) : -Infinity;
  const bMs = b.lastUpdatedAt ? Date.parse(b.lastUpdatedAt) : -Infinity;
  return aMs <= bMs ? a : b;
}

/**
 * Read the heartbeat for a single job and derive its freshness signal.
 * Throws "not implemented" until a later slice wires single-job portlets.
 */
export async function getFreshnessForJob(
  _jobName: JobName,
): Promise<PortletFreshness> {
  throw new Error("getFreshnessForJob: not implemented (Phase 1.5 S1 scaffold)");
}

/**
 * Composite freshness for a portlet that depends on multiple jobs (e.g.
 * Coverage Gaps reads from both load_fact_import_morning and
 * load_fact_import_afternoon). Returns the WORST status across the set
 * (stale > ok; oldest lastFinishedAt within a tier).
 *
 * Defensive: heartbeat read failures collapse to status="unknown" — this
 * helper must NEVER throw, so callers never need a try/catch to keep the
 * primary payload alive.
 */
export async function getFreshnessForJobs(
  jobNames: JobName[],
): Promise<PortletFreshness> {
  const sourceLabel = jobNames.join(",") || "(none)";
  if (jobNames.length === 0) return unknownFreshness(sourceLabel);

  let rows: HeartbeatRow[];
  try {
    rows = await db
      .select()
      .from(cronHeartbeats)
      .where(inArray(cronHeartbeats.jobName, jobNames as unknown as string[]));
  } catch (err) {
    console.error("[portletFreshness] heartbeat read failed:", err);
    return unknownFreshness(sourceLabel);
  }

  if (rows.length === 0) return unknownFreshness(sourceLabel);

  const composites = rows.map(rowToFreshness);
  const worst = composites.reduce(pickWorst);

  // Belt-and-suspenders: validate against the schema so a future drift in
  // the row → freshness mapping surfaces here, not in the client.
  const parsed = portletFreshnessSchema.safeParse(worst);
  if (!parsed.success) {
    console.error("[portletFreshness] derived freshness failed schema:", parsed.error);
    return unknownFreshness(sourceLabel);
  }
  return parsed.data;
}

/**
 * Batch-read heartbeats for many jobs in a single SELECT, used by
 * /api/dashboard/summary to avoid N+1. Returns one PortletFreshness per
 * input job name (status="unknown" when no row exists).
 * Throws "not implemented" until a later slice lands.
 */
export async function batchFreshness(
  _jobNames: JobName[],
): Promise<Record<string, PortletFreshness>> {
  throw new Error("batchFreshness: not implemented (Phase 1.5 S1 scaffold)");
}
