/**
 * Lane Scoring Service
 *
 * Computes a 0–100 score for each recurring lane based on:
 *   - Load consistency (weeksActive / lookbackWeeks)
 *   - Average weekly volume
 *   - Company tier / strategic importance
 *   - Absence of preferred carrier program
 *   - Eligibility confidence
 *   - Actual margin % derived from financial upload row data
 *   - Week-over-week load count volatility (coefficient of variation)
 */

import type { RecurringLane } from "@shared/schema";
import type { IStorage } from "./storage";
import { LANE_CONFIG } from "./recurringLaneCapacityEngine";

export interface ScoreFactors {
  consistencyScore: number;   // 0–25: how consistently the lane runs
  volumeScore: number;        // 0–20: avg loads per week relative to benchmark
  confidenceBonus: number;    // 0–15: eligibility confidence
  tierBonus: number;          // 0–15: account tier / estimated spend
  noPreferredCarrierBonus: number; // 0–15: lane has no preferred carrier program
  marginSignal: number;       // 0–10: based on actual avg margin % from history
  volatilityPenalty: number;  // 0–(-10): coefficient of variation of weekly load counts
  total: number;              // 0–100
  summary: string;
  avgMarginPct: number | null;   // underlying margin data for transparency
  weeklyLoadCV: number | null;   // underlying CV for transparency
}

// ── Helpers (mirrored from recurringLaneCapacityEngine to avoid circular dep) ──

function normStr(s: unknown): string {
  return (s ?? "").toString().trim().toLowerCase();
}

function getWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  if (isNaN(d.getTime())) return "";
  const year = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7);
  return `${year}-${String(weekNum).padStart(2, "0")}`;
}

function getWeekKeys(weeksBack: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = getWeekKey(d.toISOString().split("T")[0]);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Fetch actual margin and volatility signals for a lane by scanning financial upload rows.
 * Falls back to null values if no matching data is found.
 */
async function fetchLaneHistorySignals(
  lane: RecurringLane,
  storage: IStorage,
): Promise<{ avgMarginPct: number | null; weeklyLoadCV: number | null }> {
  try {
    const uploads = await storage.getFinancialUploadsForOrg(lane.orgId);
    const laneOrigin = normStr(lane.origin);
    const laneDest = normStr(lane.destination);
    const targetWeeks = getWeekKeys(LANE_CONFIG.lookbackWeeks);

    const marginValues: number[] = [];
    const weekCounts: Map<string, number> = new Map(targetWeeks.map(wk => [wk, 0]));

    for (const upload of uploads) {
      const rows = (upload.rows as any[]) ?? [];
      for (const row of rows) {
        const origin = normStr(row.shipperCity ?? row.originCity ?? row.origin ?? row.shipper_city ?? "");
        const dest = normStr(row.consigneeCity ?? row.destinationCity ?? row.destination ?? row.consignee_city ?? "");
        if (origin !== laneOrigin || dest !== laneDest) continue;

        // Margin: try various field names
        const rawMargin = row.margin ?? row.marginPct ?? row.margin_pct ?? row.grossMarginPct ?? row.gross_margin_pct;
        if (rawMargin !== undefined && rawMargin !== null && rawMargin !== "") {
          const m = Number(rawMargin);
          if (!isNaN(m)) marginValues.push(m);
        }

        // Weekly load count for volatility
        const shipDate = String(row.shipDate ?? row.ship_date ?? row.pickupDate ?? row.pickup_date ?? row.date ?? "");
        if (shipDate) {
          const wk = getWeekKey(shipDate);
          if (weekCounts.has(wk)) {
            weekCounts.set(wk, (weekCounts.get(wk) ?? 0) + 1);
          }
        }
      }
    }

    const avgMarginPct = marginValues.length > 0
      ? marginValues.reduce((a, b) => a + b, 0) / marginValues.length
      : null;

    const counts = Array.from(weekCounts.values());
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    let weeklyLoadCV: number | null = null;
    if (mean > 0 && counts.length >= 2) {
      const variance = counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;
      weeklyLoadCV = Math.sqrt(variance) / mean;
    }

    return { avgMarginPct, weeklyLoadCV };
  } catch {
    return { avgMarginPct: null, weeklyLoadCV: null };
  }
}

/**
 * Optionally enrich a rule-based lane score with an AI-computed adjustment (0–100)
 * and an AI-generated insight string. Returns null on any error.
 */
async function getAIScoreAdjustment(
  lane: RecurringLane,
  ruleScore: number,
  avgMarginPct: number | null,
  weeklyLoadCV: number | null,
  avgLoadsPerWeek: number,
): Promise<{ aiScore: number; aiInsight: string } | null> {
  try {
    const { callAI } = await import("./aiHelpers");
    const marginNote = avgMarginPct !== null ? `Average margin: ${avgMarginPct.toFixed(1)}%.` : "Margin data unavailable.";
    const volatilityNote = weeklyLoadCV !== null ? `Weekly load CV: ${(weeklyLoadCV * 100).toFixed(0)}%.` : "Volatility data unavailable.";
    const prompt = `You are a logistics capacity analyst. Score this lane opportunity 0–100 for carrier outreach priority and provide a 1-sentence insight.

Lane: ${lane.origin} → ${lane.destination} (${lane.equipmentType ?? "any equipment"})
Customer: ${lane.companyName ?? "Unknown"}
Avg loads/week: ${avgLoadsPerWeek}
Weeks active in lookback: ${lane.weeksActive ?? 0} / ${lane.lookbackWeeks ?? 4}
${marginNote} ${volatilityNote}
Rule-based score: ${ruleScore}/100
Strategic account: ${lane.companyId ? "yes" : "unknown"}

Respond ONLY with JSON: {"score": <0-100>, "insight": "<one sentence>"}`;

    const raw = await callAI(prompt, 120);
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    if (typeof parsed.score === "number" && typeof parsed.insight === "string") {
      return { aiScore: Math.max(0, Math.min(100, Math.round(parsed.score))), aiInsight: parsed.insight };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute a lane score for a single recurring lane.
 */
export async function scoreLane(
  lane: RecurringLane,
  storage: IStorage,
): Promise<{ score: number; factors: ScoreFactors }> {
  const lookback = lane.lookbackWeeks ?? LANE_CONFIG.lookbackWeeks;
  const weeksActive = lane.weeksActive ?? 0;
  const avgLoadsPerWeek = Number(lane.avgLoadsPerWeek ?? 0);

  const sc = LANE_CONFIG.scoring;

  // 1. Consistency: how many of the lookback weeks were active (0–maxConsistencyPts)
  const consistencyRatio = lookback > 0 ? weeksActive / lookback : 0;
  const consistencyScore = Math.round(consistencyRatio * sc.maxConsistencyPts);

  // 2. Volume: benchmark at volumeBenchmarkLoadsPerWeek = maxVolumePts; scale linearly
  const volumeScore = Math.min(sc.maxVolumePts, Math.round((avgLoadsPerWeek / sc.volumeBenchmarkLoadsPerWeek) * sc.maxVolumePts));

  // 3. Confidence bonus
  const confidenceBonus =
    lane.eligibilityConfidence === "high"   ? sc.confidenceHigh :
    lane.eligibilityConfidence === "medium" ? sc.confidenceMedium : sc.confidenceLow;

  // 4. Company tier bonus — strategic account importance via estimated freight spend
  let tierBonus = 0;
  if (lane.companyId) {
    try {
      const company = await storage.getCompany(lane.companyId);
      if (company) {
        const spend = Number(company.estimatedFreightSpend ?? 0);
        if (spend >= sc.tierHighThreshold) tierBonus = sc.tierHigh;
        else if (spend >= sc.tierMediumThreshold) tierBonus = sc.tierMedium;
        else if (spend > 0) tierBonus = sc.tierLow;
      }
    } catch {
      // ignore — non-critical
    }
  }

  // 5. No preferred carrier program bonus
  const noPreferredCarrierBonus = lane.hasPreferredCarrierProgram ? 0 : sc.noPreferredCarrierBonus;

  // 6. Fetch actual margin and volatility signals from financial history
  const { avgMarginPct, weeklyLoadCV } = await fetchLaneHistorySignals(lane, storage);

  // 7. Margin signal: actual avg margin % from history; fallback to load density proxy
  let marginSignal: number;
  if (avgMarginPct !== null) {
    marginSignal =
      avgMarginPct >= sc.marginHighPct   ? sc.marginHigh :
      avgMarginPct >= sc.marginMediumPct ? sc.marginMedium :
      avgMarginPct >= sc.marginLowPct    ? sc.marginLow : sc.marginMinimal;
  } else {
    // Proxy: high load volume implies margin leverage from committed rates
    marginSignal =
      avgLoadsPerWeek >= 4 ? sc.marginProxyHigh :
      avgLoadsPerWeek >= 3 ? sc.marginProxyMedium :
      avgLoadsPerWeek >= 2 ? sc.marginProxyLow : 0;
  }

  // 8. Volatility penalty: coefficient of variation of weekly load counts
  //    High CV = erratic lane = less reliable capacity commitment opportunity
  let volatilityPenalty: number;
  if (weeklyLoadCV !== null) {
    volatilityPenalty =
      weeklyLoadCV > sc.volatilityHighThreshold ? sc.volatilityHighPenalty :
      weeklyLoadCV > sc.volatilityMedThreshold  ? sc.volatilityMedPenalty : 0;
  } else {
    // Fallback: penalize lanes barely at minimum threshold
    const atMinimumThreshold =
      weeksActive === LANE_CONFIG.requiredWeeks &&
      avgLoadsPerWeek <= LANE_CONFIG.minLoadsPerWeek;
    volatilityPenalty = atMinimumThreshold ? sc.minimumThresholdPenalty : 0;
  }

  const ruleTotal = Math.min(100, Math.max(0,
    consistencyScore + volumeScore + confidenceBonus + tierBonus +
    noPreferredCarrierBonus + marginSignal + volatilityPenalty
  ));

  // AI enrichment: blend rule-based score with AI-computed score (configurable weights from LANE_CONFIG)
  // Falls back gracefully to rule-based only if AI is unavailable or fails.
  const aiResult = await getAIScoreAdjustment(lane, ruleTotal, avgMarginPct, weeklyLoadCV, avgLoadsPerWeek);
  const total = aiResult
    ? Math.min(100, Math.max(0, Math.round(sc.aiBlendRuleWeight * ruleTotal + sc.aiBlendAiWeight * aiResult.aiScore)))
    : ruleTotal;

  const factors: ScoreFactors = {
    consistencyScore,
    volumeScore,
    confidenceBonus,
    tierBonus,
    noPreferredCarrierBonus,
    marginSignal,
    volatilityPenalty,
    total,
    avgMarginPct,
    weeklyLoadCV,
    summary: buildScoreSummary({
      consistencyScore, volumeScore, confidenceBonus, tierBonus, noPreferredCarrierBonus,
      marginSignal, volatilityPenalty, total,
      weeksActive, lookback, avgLoadsPerWeek, avgMarginPct, weeklyLoadCV,
      aiInsight: aiResult?.aiInsight ?? null,
    }),
  };

  return { score: total, factors };
}

function buildScoreSummary(f: {
  consistencyScore: number; volumeScore: number; confidenceBonus: number;
  tierBonus: number; noPreferredCarrierBonus: number; marginSignal: number;
  volatilityPenalty: number; total: number;
  weeksActive: number; lookback: number; avgLoadsPerWeek: number;
  avgMarginPct: number | null; weeklyLoadCV: number | null;
  aiInsight: string | null;
}): string {
  const parts: string[] = [];
  if (f.weeksActive === f.lookback) {
    parts.push(`Lane ran every week for the past ${f.lookback} weeks`);
  } else {
    parts.push(`Active ${f.weeksActive} of ${f.lookback} weeks`);
  }
  parts.push(`Avg ${f.avgLoadsPerWeek} loads/week`);
  if (f.tierBonus >= 10) parts.push("High-value strategic account");
  if (f.noPreferredCarrierBonus > 0) parts.push("No preferred carrier program — outreach opportunity");
  if (f.avgMarginPct !== null) {
    if (f.marginSignal >= 7) parts.push(`Strong margin history (avg ${f.avgMarginPct.toFixed(1)}%)`);
    else if (f.marginSignal >= 4) parts.push(`Moderate margin history (avg ${f.avgMarginPct.toFixed(1)}%)`);
    else parts.push(`Low margin history (avg ${f.avgMarginPct.toFixed(1)}%) — room to improve`);
  } else if (f.marginSignal >= 7) {
    parts.push("High load density — strong margin leverage opportunity");
  }
  if (f.weeklyLoadCV !== null && f.volatilityPenalty < 0) {
    parts.push(`Erratic week-over-week volume (CV ${(f.weeklyLoadCV * 100).toFixed(0)}%) — monitor for consistency`);
  } else if (f.weeklyLoadCV === null && f.volatilityPenalty < 0) {
    parts.push("Lane is at minimum threshold — monitor for consistency");
  }
  if (f.aiInsight) parts.push(`AI: ${f.aiInsight}`);
  return parts.join(". ") + ".";
}

/**
 * Score all eligible lanes for an org and persist the scores.
 */
export async function scoreAllEligibleLanes(
  orgId: string,
  storage: IStorage,
): Promise<void> {
  const lanes = await storage.getEligibleRecurringLanes(orgId);
  const now = new Date().toISOString();

  for (const lane of lanes) {
    try {
      const { score, factors } = await scoreLane(lane, storage);
      await storage.updateRecurringLane(lane.id, {
        laneScore: score,
        laneScoreFactors: factors as Record<string, unknown>,
        lastScoredAt: now,
      });
    } catch (err) {
      console.error(`[laneScoringService] Error scoring lane ${lane.id}:`, err);
    }
  }
}
