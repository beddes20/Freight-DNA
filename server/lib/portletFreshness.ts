/**
 * Portlet Freshness helper (Dashboard Trust Pass — Phase 1.5, S1 scaffolding).
 *
 * Reads cron_heartbeats and derives a PortletFreshness signal for scoped
 * dashboard endpoints (NBA, Coverage Gaps, Award Health, Trending, Margin,
 * Relationship Advancement). Lets the UI distinguish:
 *   - "no items today"        (status: "ok",      list empty)
 *   - "upstream stale/failed" (status: "stale",   show degraded banner)
 *   - "freshness unknown"     (status: "unknown", neutral grey — never escalate)
 *
 * Status derivation (lands in a later PR):
 *   - ok      — lastStatus === "success" AND (now - lastFinishedAt) < intervalMs * 2
 *   - stale   — heartbeat exists but lastStatus === "error", OR
 *               consecutiveFailures > 0, OR
 *               (now - lastFinishedAt) >= intervalMs * 2
 *   - unknown — no row, OR the heartbeat read itself errored
 *               (defensive — never collapse unknown into stale; see Task #1109a)
 *
 * THIS FILE IS SCAFFOLDING — signatures only, no logic yet. Implementation
 * lands in Phase 1.5 step S3+ once we've wrapped the missing schedulers in
 * withHeartbeat() and have real heartbeat rows to read against. Nothing in
 * the codebase imports these helpers yet.
 */
import type { PortletFreshness } from "../../shared/schema";
import type { JobName } from "./cronHeartbeat";

/**
 * Read the heartbeat for a single job and derive its freshness signal.
 * Throws "not implemented" until S3 lands.
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
 * (oldest lastFinishedAt / highest failure count).
 * Throws "not implemented" until S3 lands.
 */
export async function getFreshnessForJobs(
  _jobNames: JobName[],
): Promise<PortletFreshness> {
  throw new Error("getFreshnessForJobs: not implemented (Phase 1.5 S1 scaffold)");
}

/**
 * Batch-read heartbeats for many jobs in a single SELECT, used by
 * /api/dashboard/summary to avoid N+1. Returns one PortletFreshness per
 * input job name (status="unknown" when no row exists).
 * Throws "not implemented" until S3 lands.
 */
export async function batchFreshness(
  _jobNames: JobName[],
): Promise<Record<string, PortletFreshness>> {
  throw new Error("batchFreshness: not implemented (Phase 1.5 S1 scaffold)");
}
