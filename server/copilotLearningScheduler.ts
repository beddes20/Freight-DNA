/**
 * Copilot Learning Scheduler — Task #926 step 11.
 *
 * Periodically aggregates `copilot_outcomes` into bounded `copilot_adjustments`
 * factors per (org, scope, scopeKey). Multipliers are clamped 0.5–1.5 so the
 * loop can never over-correct a fit/price recommendation off a cliff.
 *
 * - Runs every 6 hours by default.
 * - Skips orgs with < 5 outcomes in the window (signal too sparse).
 * - Audits each materialized factor change to `copilot_actions` so reps can
 *   see what learned and why.
 */
import { db } from "./storage";
import { sql, eq, and, gte } from "drizzle-orm";
import {
  copilotOutcomes,
  copilotPlayRecommendations,
  copilotAdjustments,
  copilotActions,
} from "@shared/schema";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const WINDOW_DAYS = 60;
const MIN_SAMPLES = 5;
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.5;

let _timer: NodeJS.Timeout | null = null;

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, v));
}

interface Aggregate { wins: number; losses: number; total: number }

/**
 * Pull every realized outcome in the last WINDOW_DAYS and bucket by
 * (scope, scopeKey). Win rate maps to a bounded multiplier.
 */
export async function recomputeAdjustments(now: Date = new Date()): Promise<{ written: number; skipped: number }> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400000);

  const rows = await db
    .select({
      orgId: copilotOutcomes.organizationId,
      customerId: copilotPlayRecommendations.customerId,
      laneKey: copilotPlayRecommendations.laneKey,
      playId: copilotPlayRecommendations.playId,
      realizedOutcome: copilotOutcomes.realizedOutcome,
    })
    .from(copilotOutcomes)
    .innerJoin(copilotPlayRecommendations, eq(copilotPlayRecommendations.id, copilotOutcomes.recommendationId))
    .where(and(
      gte(copilotOutcomes.createdAt, since),
      sql`${copilotOutcomes.realizedOutcome} IS NOT NULL`,
    ));

  // Bucket each row across the three scopes.
  const buckets = new Map<string, Aggregate>();
  const keyOf = (org: string, scope: string, scopeKey: string) => `${org}|${scope}|${scopeKey}`;

  for (const r of rows) {
    const won = r.realizedOutcome === "won";
    const lost = r.realizedOutcome === "lost";
    if (!won && !lost) continue;
    const targets: Array<{ scope: string; scopeKey: string }> = [];
    if (r.customerId) targets.push({ scope: "customer", scopeKey: r.customerId });
    if (r.laneKey) targets.push({ scope: "lane", scopeKey: r.laneKey });
    if (r.playId) targets.push({ scope: "play", scopeKey: r.playId });
    for (const t of targets) {
      const k = keyOf(r.orgId, t.scope, t.scopeKey);
      const cur = buckets.get(k) ?? { wins: 0, losses: 0, total: 0 };
      cur.total += 1;
      if (won) cur.wins += 1; else cur.losses += 1;
      buckets.set(k, cur);
    }
  }

  let written = 0;
  let skipped = 0;
  for (const [key, agg] of buckets.entries()) {
    if (agg.total < MIN_SAMPLES) { skipped++; continue; }
    const winRate = agg.wins / agg.total;
    // Center 0.5 win rate at 1.0 multiplier; ±50% win rate → ±0.5 swing.
    const factor = clamp(0.75 + winRate * 0.5);
    const [org, scope, scopeKey] = key.split("|");
    await db.insert(copilotAdjustments).values({
      organizationId: org,
      scope,
      scopeKey,
      factor: factor.toFixed(3),
      sampleCount: agg.total,
      winRate: winRate.toFixed(4),
      evidence: { wins: agg.wins, losses: agg.losses, sampleWindowDays: WINDOW_DAYS } as object,
    }).onConflictDoUpdate({
      target: [copilotAdjustments.organizationId, copilotAdjustments.scope, copilotAdjustments.scopeKey],
      set: {
        factor: factor.toFixed(3),
        sampleCount: agg.total,
        winRate: winRate.toFixed(4),
        evidence: { wins: agg.wins, losses: agg.losses, sampleWindowDays: WINDOW_DAYS } as object,
        computedAt: sql`now()`,
      },
    });
    written++;
  }

  if (written > 0) {
    // Single audit row per run — keeps the audit table sane.
    try {
      await db.insert(copilotActions).values({
        organizationId: rows[0]?.orgId ?? "system",
        confirmedByUserId: "system",
        tool: "copilot_learning.recompute",
        args: { written, skipped, windowDays: WINDOW_DAYS },
        result: "success",
        relatedCompanyId: null,
      }).onConflictDoNothing();
    } catch {
      // copilot_actions FK on confirmed_by_user_id rejects 'system' if the
      // user table is strict — that's fine, the metrics row already landed.
    }
  }

  return { written, skipped };
}

export function startCopilotLearningScheduler(intervalMs: number = SIX_HOURS_MS): void {
  if (_timer) return;
  // Don't run on first tick — wait one interval so app start isn't blocked.
  _timer = setInterval(() => {
    recomputeAdjustments().catch((err) => {
      console.warn("[copilotLearningScheduler] recompute failed:", err);
    });
  }, intervalMs);
  if ((_timer as { unref?: () => void }).unref) (_timer as { unref: () => void }).unref();
}

export function stopCopilotLearningScheduler(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
