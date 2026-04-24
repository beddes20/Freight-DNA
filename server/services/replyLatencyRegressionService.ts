/**
 * Reply latency regression detector (Task #611).
 *
 * Reuses `fetchResponsePairs` + `buildWeeklyTrend` to evaluate, per rep, how
 * their most recent FULL ISO-week of customer email replies compares to their
 * own trailing baseline. When the latest week's p90 jumps significantly versus
 * the median of the trailing weeks AND the rep has enough replies in that
 * window to make the comparison meaningful, the rep is flagged.
 *
 * Why p90 + reply floor: the median often looks flat even when a rep's tail
 * gets ugly (one or two threads sat for half a day), and a single bad reply on
 * a low-volume week can swing both numbers wildly. Anchoring on p90 plus a
 * minimum reply count is the same defensiveness that `buildWeeklyTrend` uses
 * for the dashboard chart.
 *
 * Why the latest week is "the most recent COMPLETE ISO-week" rather than
 * just-now: ISO weeks are Monday-anchored, so a Tuesday cron run would be
 * comparing 1.5 days of activity against a 4-week baseline and produce false
 * positives on every rep. We shift to the previous Monday's ISO-week to make
 * the comparison apples-to-apples.
 *
 * Output is intentionally narrow (one row per flagged rep) so callers — the
 * scheduler that fires in-app notifications, plus admin diagnostics — don't
 * have to re-derive thresholds or week math.
 */

import { eq } from "drizzle-orm";
import { db, storage } from "../storage";
import { emailReplyLatencyRegressionSettings, type EmailReplyLatencyRegressionSettings } from "@shared/schema";
import {
  attributedSenderId,
  attributedSenderName,
  fetchResponsePairs,
  isoWeekParts,
  UNATTRIBUTED_SENDER_ID,
  type ResponsePair,
} from "./emailResponseTimeAnalyticsService";

export interface ReplyLatencyRegressionConfig {
  enabled: boolean;
  lookbackWeeks: number;
  p90RegressionPct: number;
  minReplies: number;
  businessHours: boolean;
}

export const DEFAULT_REGRESSION_CONFIG: ReplyLatencyRegressionConfig = {
  enabled: true,
  lookbackWeeks: 4,
  p90RegressionPct: 25,
  minReplies: 10,
  businessHours: true,
};

export async function loadRegressionConfig(orgId: string): Promise<ReplyLatencyRegressionConfig> {
  const rows = await db
    .select()
    .from(emailReplyLatencyRegressionSettings)
    .where(eq(emailReplyLatencyRegressionSettings.organizationId, orgId))
    .limit(1);
  if (rows.length === 0) return { ...DEFAULT_REGRESSION_CONFIG };
  return mergeConfig(rows[0]);
}

function mergeConfig(row: EmailReplyLatencyRegressionSettings): ReplyLatencyRegressionConfig {
  return {
    enabled: row.enabled,
    lookbackWeeks: clampInt(row.lookbackWeeks, 1, 12, DEFAULT_REGRESSION_CONFIG.lookbackWeeks),
    p90RegressionPct: clampInt(row.p90RegressionPct, 1, 1000, DEFAULT_REGRESSION_CONFIG.p90RegressionPct),
    minReplies: clampInt(row.minReplies, 1, 1000, DEFAULT_REGRESSION_CONFIG.minReplies),
    businessHours: row.businessHours,
  };
}

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Return the Monday (UTC, YYYY-MM-DD) of the most recent ISO-week that has
 * already fully ended relative to `now`. If `now` itself is a Monday, the
 * "most recent complete week" is the one that ended yesterday — so we still
 * walk back at least 7 days.
 */
export function previousCompleteIsoWeekStart(now: Date): string {
  const utcMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayNum = new Date(utcMid).getUTCDay() || 7; // 1..7 (Mon..Sun)
  // Monday of the current ISO-week:
  const currentMonday = utcMid - (dayNum - 1) * 86_400_000;
  // Step back one full week to get the last completed ISO-week.
  const prevMonday = currentMonday - 7 * 86_400_000;
  return new Date(prevMonday).toISOString().slice(0, 10);
}

export interface RepWeekStats {
  weekStart: string;
  count: number;
  p90Ms: number | null;
  medianMs: number | null;
}

export interface RepRegressionFlag {
  repId: string;
  repName: string;
  latest: RepWeekStats;
  baseline: {
    weeks: RepWeekStats[];
    p90Ms: number;
    medianMs: number | null;
    totalReplies: number;
  };
  /** Latest p90 ÷ baseline p90, expressed as a percent change ((new − old) / old × 100). */
  p90DeltaPct: number;
  /** Wall-clock vs business-hours basis the comparison was performed on. */
  businessHours: boolean;
}

interface EvaluateOptions {
  now?: Date;
  config?: Partial<ReplyLatencyRegressionConfig>;
}

/**
 * Group `pairs` by attributed sender (skipping the Unattributed sentinel) and
 * compute, per rep, the per-ISO-week stats indexed by the Monday of that week.
 * Pulled out so tests can exercise the bucketing without the DB layer.
 */
export function bucketWeeklyStatsByRep(
  pairs: ResponsePair[],
  businessHours: boolean,
): Map<string, { name: string; weeks: Map<string, { values: number[] }> }> {
  const out = new Map<string, { name: string; weeks: Map<string, { values: number[] }> }>();
  for (const p of pairs) {
    if (!p.outboundAt) continue;
    const ms = businessHours ? p.bizMs : p.wallMs;
    if (ms == null || ms < 0) continue;
    const id = attributedSenderId(p);
    if (id === UNATTRIBUTED_SENDER_ID) continue; // unattributed replies aren't a rep
    const { weekStart } = isoWeekParts(p.outboundAt);
    let entry = out.get(id);
    if (!entry) {
      entry = { name: attributedSenderName(p), weeks: new Map() };
      out.set(id, entry);
    }
    let bucket = entry.weeks.get(weekStart);
    if (!bucket) {
      bucket = { values: [] };
      entry.weeks.set(weekStart, bucket);
    }
    bucket.values.push(ms);
  }
  return out;
}

/**
 * Decide whether the latest week's stats represent a regression versus the
 * trailing baseline. Pure function so the policy is unit-testable without
 * running the full pipeline.
 */
export function evaluateRegressionDecision(
  latest: RepWeekStats,
  baselineP90Ms: number,
  config: Pick<ReplyLatencyRegressionConfig, "p90RegressionPct" | "minReplies">,
): { regressed: boolean; deltaPct: number } {
  if (latest.p90Ms == null) return { regressed: false, deltaPct: 0 };
  if (latest.count < config.minReplies) return { regressed: false, deltaPct: 0 };
  if (baselineP90Ms <= 0) return { regressed: false, deltaPct: 0 };
  const deltaPct = ((latest.p90Ms - baselineP90Ms) / baselineP90Ms) * 100;
  return { regressed: deltaPct >= config.p90RegressionPct, deltaPct };
}

/**
 * Pull the trailing window of customer email replies for `orgId`, group them
 * per rep × ISO-week, and return the reps whose latest-week p90 jumped past
 * the configured threshold. Reps with no replies in the latest week are
 * skipped silently — they don't have a "latest" week to regress on.
 */
export async function evaluateOrgRegressions(
  orgId: string,
  options: EvaluateOptions = {},
): Promise<{ config: ReplyLatencyRegressionConfig; latestWeekStart: string; flags: RepRegressionFlag[] }> {
  const baseConfig = await loadRegressionConfig(orgId);
  const config: ReplyLatencyRegressionConfig = { ...baseConfig, ...options.config };

  const now = options.now ?? new Date();
  const latestWeekStart = previousCompleteIsoWeekStart(now);

  if (!config.enabled) {
    return { config, latestWeekStart, flags: [] };
  }

  // Load enough history to cover the latest complete week PLUS the trailing
  // baseline. Add a 1-day buffer on each end so timezones and small clock
  // skew don't drop edge-of-week replies.
  const latestStartMs = new Date(`${latestWeekStart}T00:00:00Z`).getTime();
  const latestEndMs = latestStartMs + 7 * 86_400_000;
  const windowStartMs = latestStartMs - config.lookbackWeeks * 7 * 86_400_000 - 86_400_000;
  const windowEndMs = latestEndMs + 86_400_000;

  const pairs = await fetchResponsePairs({
    orgId,
    start: new Date(windowStartMs),
    end: new Date(windowEndMs),
    businessHours: config.businessHours,
  });

  const grouped = bucketWeeklyStatsByRep(pairs, config.businessHours);
  const flags: RepRegressionFlag[] = [];

  for (const [repId, { name, weeks }] of grouped) {
    const latestBucket = weeks.get(latestWeekStart);
    if (!latestBucket) continue; // no replies that week → nothing to regress on

    const latest: RepWeekStats = {
      weekStart: latestWeekStart,
      count: latestBucket.values.length,
      p90Ms: percentile(latestBucket.values, 90),
      medianMs: median(latestBucket.values),
    };

    // Walk back `lookbackWeeks` ISO-weeks (each 7d) and gather any week we
    // saw. The spec calls for a "trailing N-week baseline", so we require
    // the FULL window of baseline coverage — flagging a rep on the strength
    // of one or two noisy historical weeks would defeat the point of having
    // a baseline at all. A rep onboarded mid-quarter, or one returning from
    // an extended absence, is therefore excluded until they accrue the full
    // window of weekly coverage.
    const baselineWeeks: RepWeekStats[] = [];
    const baselineP90s: number[] = [];
    const baselineMedians: number[] = [];
    let baselineReplies = 0;
    for (let i = 1; i <= config.lookbackWeeks; i++) {
      const ws = new Date(latestStartMs - i * 7 * 86_400_000).toISOString().slice(0, 10);
      const bucket = weeks.get(ws);
      if (!bucket) continue;
      const p90 = percentile(bucket.values, 90);
      const med = median(bucket.values);
      baselineWeeks.push({ weekStart: ws, count: bucket.values.length, p90Ms: p90, medianMs: med });
      if (p90 != null) baselineP90s.push(p90);
      if (med != null) baselineMedians.push(med);
      baselineReplies += bucket.values.length;
    }
    if (baselineP90s.length < config.lookbackWeeks) continue;

    // Median of the trailing weekly p90s is more robust than mean when one
    // baseline week was unusually slow/fast — we want a STABLE benchmark to
    // compare the latest week against, not one that spikes with outliers.
    const baselineP90 = median(baselineP90s)!;
    const baselineMedian = median(baselineMedians);

    const decision = evaluateRegressionDecision(latest, baselineP90, config);
    if (!decision.regressed) continue;

    flags.push({
      repId,
      repName: name,
      latest,
      baseline: {
        weeks: baselineWeeks,
        p90Ms: baselineP90,
        medianMs: baselineMedian,
        totalReplies: baselineReplies,
      },
      p90DeltaPct: decision.deltaPct,
      businessHours: config.businessHours,
    });
  }

  // Worst-regressing reps first so the digest / inbox lists the most
  // attention-worthy items at the top.
  flags.sort((a, b) => b.p90DeltaPct - a.p90DeltaPct);

  return { config, latestWeekStart, flags };
}

/** Round duration in ms to a short human-readable string ("3h 12m", "47m"). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hours < 24) return min === 0 ? `${hours}h` : `${hours}h ${min}m`;
  const days = Math.floor(hours / 24);
  const hr = hours % 24;
  return hr === 0 ? `${days}d` : `${days}d ${hr}h`;
}

// Re-export storage so the scheduler can avoid an extra import line. Kept here
// because the scheduler is the only caller and storage already round-trips
// through this module via fetchResponsePairs.
export { storage };
