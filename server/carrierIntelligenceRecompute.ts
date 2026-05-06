/**
 * Carrier intelligence nightly recompute orchestrator (Task #369).
 *
 * Runs the three idempotent rebuilds in order:
 *   1. carrier_scorecard_fact   — needs realized history only
 *   2. lane_rate_history        — needs realized history only
 *   3. carrier_recommendation   — needs the two above + Sonar pricing
 *
 * Called from:
 *   - the load_fact PowerBI importer (post-success hook)
 *   - the admin "rebuild now" route
 *   - a nightly cron (initialized in server/index.ts via initLoadFactScheduler).
 *
 * Per-org mutex prevents two concurrent rebuilds (e.g. the scheduler kicking
 * off while an admin manually triggers one). Recommendations are bounded to a
 * reasonable batch size so a 5k-load Available queue doesn't melt Sonar.
 */

import { recomputeCarrierScorecards } from "./carrierScorecardService";
import { recomputeLaneRateHistory } from "./laneRateHistoryService";
import { recomputeRecommendationsForOrg } from "./carrierRecommendationEngine";

const inFlight = new Map<string, Promise<RecomputeSummary>>();

export interface RecomputeSummary {
  orgId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scorecardsWritten: number;
  laneRowsWritten: number;
  recommendations: { processed: number; failed: number };
  error?: string;
}

export interface RecomputeOptions {
  /** Skip recommendations (just scorecard + lane history). */
  skipRecommendations?: boolean;
  /** Cap on how many Available loads to score in this pass. */
  maxRecommendationLoads?: number;
}

export async function recomputeCarrierIntelligence(orgId: string, opts: RecomputeOptions = {}): Promise<RecomputeSummary> {
  const existing = inFlight.get(orgId);
  if (existing) return existing;
  const promise = doRecompute(orgId, opts).finally(() => {
    if (inFlight.get(orgId) === promise) inFlight.delete(orgId);
  });
  inFlight.set(orgId, promise);
  return promise;
}

async function doRecompute(orgId: string, opts: RecomputeOptions): Promise<RecomputeSummary> {
  const startedAt = new Date();
  const summary: RecomputeSummary = {
    orgId,
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    scorecardsWritten: 0,
    laneRowsWritten: 0,
    recommendations: { processed: 0, failed: 0 },
  };
  try {
    const [scorecards, laneRows] = await Promise.all([
      recomputeCarrierScorecards(orgId),
      recomputeLaneRateHistory(orgId),
    ]);
    summary.scorecardsWritten = scorecards;
    summary.laneRowsWritten = laneRows;

    if (!opts.skipRecommendations) {
      summary.recommendations = await recomputeRecommendationsForOrg(orgId, { maxLoads: opts.maxRecommendationLoads });
    }
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
  } finally {
    const finishedAt = new Date();
    summary.finishedAt = finishedAt.toISOString();
    summary.durationMs = finishedAt.getTime() - startedAt.getTime();
    console.log(`[carrier-intel-recompute] org=${orgId} duration=${summary.durationMs}ms scorecards=${summary.scorecardsWritten} laneRows=${summary.laneRowsWritten} recs=${summary.recommendations.processed}/${summary.recommendations.processed + summary.recommendations.failed}${summary.error ? ` ERROR=${summary.error}` : ""}`);
  }
  return summary;
}
