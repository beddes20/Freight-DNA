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
import { inArray, eq, sql } from "drizzle-orm";
import { db } from "../storage";
import {
  cronHeartbeats,
  nbaCards,
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
 * Phase 1.5 S7 — Data-driven NBA freshness.
 *
 * NBA does not heartbeat (the nightly Phase 1 engine in
 * `server/nbaPhase1Scheduler.ts` is not wrapped in `withHeartbeat`, and
 * we are explicitly NOT touching the scheduler in this slice). Instead
 * we mirror the Task #1109a NBA freshness precedent used by
 * `useCompanyDataFreshness`: derive freshness from the most recent
 * `nba_cards.created_at` per org with a 24h staleness threshold.
 *
 *   - ok       — latest card timestamp is within `staleAfterMs` (default 24h)
 *   - stale    — latest card timestamp exists but is older than threshold
 *   - unknown  — org has zero NBA cards OR the read failed (defensive)
 *
 * Source label is the literal string "nba_cards.createdAt" so the UI
 * can attribute the signal precisely (parallel to load_fact heartbeat
 * job names used by `getFreshnessForJobs`).
 *
 * NOTE: `nba_cards.created_at` is stored as `text` (ISO-8601), so we
 * pass it through Postgres `MAX()` — lexicographic max = chronological
 * max for ISO-8601 strings. Date.parse() then converts to ms.
 */
const NBA_FRESHNESS_SOURCE = "nba_cards.createdAt";
const NBA_DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export async function getFreshnessFromNbaCards(
  orgId: string,
  opts?: { staleAfterMs?: number },
): Promise<PortletFreshness> {
  const staleAfterMs = opts?.staleAfterMs ?? NBA_DEFAULT_STALE_MS;
  if (!orgId) return unknownFreshness(NBA_FRESHNESS_SOURCE);

  let latestIso: string | null;
  try {
    const rows = await db
      .select({ latest: sql<string | null>`MAX(${nbaCards.createdAt})` })
      .from(nbaCards)
      .where(eq(nbaCards.orgId, orgId));
    latestIso = rows[0]?.latest ?? null;
  } catch (err) {
    console.error("[portletFreshness] nba_cards read failed:", err);
    return unknownFreshness(NBA_FRESHNESS_SOURCE);
  }

  if (!latestIso) return unknownFreshness(NBA_FRESHNESS_SOURCE);

  const latestMs = Date.parse(latestIso);
  if (!Number.isFinite(latestMs)) {
    // Defensive: malformed timestamp string. Don't lie to reps with "ok".
    return unknownFreshness(NBA_FRESHNESS_SOURCE);
  }

  const ageMs = Date.now() - latestMs;
  const status: "ok" | "stale" = ageMs < staleAfterMs ? "ok" : "stale";

  const candidate: PortletFreshness = {
    source: NBA_FRESHNESS_SOURCE,
    status,
    lastUpdatedAt: new Date(latestMs).toISOString(),
    nextExpectedAt: null,
    consecutiveFailures: 0,
  };
  const parsed = portletFreshnessSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error("[portletFreshness] nba freshness failed schema:", parsed.error);
    return unknownFreshness(NBA_FRESHNESS_SOURCE);
  }
  return parsed.data;
}

/**
 * Phase 1.5 S8 — Data-driven freshness for monthly financial-upload-backed
 * portlets (Trending Accounts, Margin Metrics).
 *
 * Monthly uploads have no scheduler/heartbeat — the signal IS the upload
 * itself. Two honest inputs are available in every route handler that
 * already calls `storage.getLatestFinancialUploadForOrg`:
 *
 *   - `uploadedAt`     — ISO-8601 timestamp on `financial_uploads.uploadedAt`
 *   - `dataMonthKey`   — most recent "YYYY-MM" present in the upload rows
 *                         (already computed by both routes for math purposes)
 *
 * Status:
 *   - ok       — dataMonthKey is the calendar current month or one month back
 *                (typical "current upload + last full month" cadence)
 *   - stale    — dataMonthKey is two or more calendar months old
 *   - unknown  — no upload at all OR malformed inputs (defensive)
 *
 * `lastUpdatedAt` always carries the upload's own timestamp when present so
 * the banner can render "Last refresh: Xd ago".
 *
 * Pure / synchronous — no DB. Caller passes the data the route already has,
 * so this helper cannot break the primary payload.
 */
const FINANCIAL_UPLOAD_SOURCE = "financial_uploads.uploadedAt";

export function deriveFinancialUploadFreshness(opts: {
  uploadedAt?: string | null;
  dataMonthKey?: string | null;
  now?: Date;
}): PortletFreshness {
  const { uploadedAt, dataMonthKey } = opts;
  const now = opts.now ?? new Date();

  if (!uploadedAt && !dataMonthKey) return unknownFreshness(FINANCIAL_UPLOAD_SOURCE);

  const lastUpdatedAt = uploadedAt && Number.isFinite(Date.parse(uploadedAt))
    ? new Date(Date.parse(uploadedAt)).toISOString()
    : null;

  if (!dataMonthKey || !/^\d{4}-\d{2}$/.test(dataMonthKey)) {
    // No usable month-key → can't make an honest stale/ok call.
    return {
      source: FINANCIAL_UPLOAD_SOURCE,
      status: "unknown",
      lastUpdatedAt,
      nextExpectedAt: null,
      consecutiveFailures: 0,
    };
  }

  const [dy, dm] = dataMonthKey.split("-").map(Number);
  // Validate month bounds — "2026-13" matches the regex but is not a real
  // month. Reject defensively rather than silently rolling into next year.
  if (!Number.isFinite(dy) || !Number.isFinite(dm) || dm < 1 || dm > 12) {
    return {
      source: FINANCIAL_UPLOAD_SOURCE,
      status: "unknown",
      lastUpdatedAt,
      nextExpectedAt: null,
      consecutiveFailures: 0,
    };
  }
  const dataIdx = dy * 12 + (dm - 1);
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  const monthsBack = nowIdx - dataIdx;

  // Tolerate the typical "we don't have the in-progress month yet" case:
  // 0 = current calendar month, 1 = last calendar month → both ok.
  // 2+ = at least one full month is missing → stale.
  // negative (future-dated) = treat as ok; not our place to scold the data.
  const status: "ok" | "stale" = monthsBack >= 2 ? "stale" : "ok";

  const candidate: PortletFreshness = {
    source: FINANCIAL_UPLOAD_SOURCE,
    status,
    lastUpdatedAt,
    nextExpectedAt: null,
    consecutiveFailures: 0,
  };
  const parsed = portletFreshnessSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error("[portletFreshness] financial-upload freshness failed schema:", parsed.error);
    return unknownFreshness(FINANCIAL_UPLOAD_SOURCE);
  }
  return parsed.data;
}

/**
 * Format a "YYYY-MM" key into an "As of <Month YYYY> upload" trust label
 * for Trending Accounts / Margin Metrics. Returns null if the key is not
 * a parseable monthKey — caller should suppress the label rather than
 * render garbage.
 */
export function formatAsOfUploadLabel(monthKey?: string | null): string | null {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const [y, m] = monthKey.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const monthName = new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" });
  return `As of ${monthName} ${y} upload`;
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
