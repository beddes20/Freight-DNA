/**
 * Task #1027 (LWQ B) — Strategic priority composite for the Lane Work Queue.
 *
 * This module is **pure**. It does not import the database, storage, or any
 * I/O — every input is provided by the caller. A guardrail in
 * `tests/code-quality-guardrails.test.ts` (Section 1027) enforces this so
 * the function stays trivially unit-testable and safe to call inside hot
 * request paths.
 *
 * The composite blends five axes, each normalized to 0–100, then weighted
 * by org-tunable weights from `LaneStrategicWeights`:
 *
 *   • Customer value         — YTD revenue + estimated freight spend.
 *   • Relationship freshness — days since the last touchpoint with the
 *                              account (older ⇒ higher priority for the
 *                              account owner).
 *   • Lane outcome history   — prior covered loads on the lane signature
 *                              (have we won here before? — small boost).
 *   • Tactical signal        — Hot/Warm signal + avg loads/week + the
 *                              existing tactical `laneScore`.
 *   • Lifecycle stage        — early stages get a floor; operationalized
 *                              lanes are heavily downweighted in the
 *                              rep queue (work belongs to ops, not LWQ).
 *
 * The function returns the composite score plus a per-component
 * explanation payload that downstream surfaces (Task D row reason chip)
 * render verbatim.
 */

import type { LaneLifecycleStage } from "@shared/laneLifecycle";

export interface LaneStrategicWeights {
  customerValue: number;
  freshness: number;
  outcomeHistory: number;
  tactical: number;
  lifecycle: number;
  // Cap inputs — used to normalize raw values into 0–100. Tunable so a
  // smaller brokerage can lower `customerValueCap` and a high-volume
  // brokerage can raise `avgLoadsCap` without code changes.
  customerValueCap: number; // dollars; revenue/spend at or above this → 100
  freshnessStaleDays: number; // days since touch at which freshness is 100
  avgLoadsCap: number; // loads/week at which the tactical sub-axis maxes
  outcomeBoostPerLoad: number; // 0–100 contribution per prior covered load
}

export const DEFAULT_LANE_STRATEGIC_WEIGHTS: LaneStrategicWeights = {
  customerValue: 0.30,
  freshness: 0.15,
  outcomeHistory: 0.10,
  tactical: 0.30,
  lifecycle: 0.15,
  customerValueCap: 1_000_000,
  freshnessStaleDays: 30,
  avgLoadsCap: 5,
  outcomeBoostPerLoad: 20,
};

export interface LaneStrategicLaneInputs {
  laneScore: number | null | undefined;
  avgLoadsPerWeek: number | string | null | undefined;
  isHighFrequency: boolean;
}

export interface LaneStrategicCustomerInputs {
  ytdRevenue: number | null | undefined;
  estimatedFreightSpend: number | null | undefined;
  /**
   * 0–1 multiplier derived from existing on-company strategic signals
   * (e.g. fraction of `companies.onboardingMilestones` complete, or
   * presence of `sharedReps`). Boosts the customer-value sub-score by
   * up to +25% so a fully-operationalized strategic account outranks a
   * same-revenue prospect. Optional — defaults to 0 when caller omits.
   */
  strategicTierBoost?: number | null;
}

export interface LaneStrategicSignalInputs {
  /**
   * Count of "hot" carrier replies on this lane (interestStatus IN
   * 'available_now' | 'available_next_week'). Sourced from
   * `lane_carrier_interest`, NOT proxied through lifecycle stage.
   */
  hotReplyCount: number;
  /**
   * Days since the last touchpoint *by the account owner specifically*
   * (touchpoints filtered by `logged_by_id = companies.owner_rep_id`).
   * Falls back to any-rep touchpoint when no owner is assigned. Null =
   * unknown / never.
   */
  daysSinceOwnerTouchpoint: number | null | undefined;
  /** Count of prior covered loads on this lane signature (companyId × lane). */
  priorCoveredLoads: number;
}

export interface LaneStrategicComponent {
  /** Stable label — also used to find `topReason` and rendered by the UI. */
  label: string;
  /** Raw 0–100 sub-score for this axis. */
  score: number;
  /** Effective contribution to the final score: `score * weight`. */
  contribution: number;
}

export interface LaneStrategicResult {
  score: number; // 0–100
  components: LaneStrategicComponent[];
  /** Label of the highest-contributing component. */
  topReason: string;
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

const toNumber = (v: number | string | null | undefined, fallback = 0): number => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Customer value: log-scaled max(YTD revenue, estimated spend) capped, with
 * an additive +0..+25 boost driven by the existing on-company "strategic
 * tier" signal (see `LaneStrategicCustomerInputs.strategicTierBoost`). The
 * boost lets a fully-operationalized strategic account rank above a same-
 * revenue prospect without changing the underlying revenue curve.
 */
function scoreCustomerValue(c: LaneStrategicCustomerInputs, cap: number): number {
  const v = Math.max(toNumber(c.ytdRevenue), toNumber(c.estimatedFreightSpend));
  const boost = clamp(toNumber(c.strategicTierBoost), 0, 1) * 25;
  if (v <= 0 || cap <= 0) return clamp(boost, 0, 100);
  // log1p so the curve rewards growing accounts without letting a single
  // mega-customer suppress every other lane to zero.
  const ratio = Math.log1p(v) / Math.log1p(cap);
  return clamp(ratio * 100 + boost, 0, 100);
}

/** Older last-touchpoint ⇒ higher priority. Null = never touched ⇒ max. */
function scoreFreshness(daysSince: number | null | undefined, staleDays: number): number {
  if (daysSince === null || daysSince === undefined) return 100;
  if (staleDays <= 0) return 0;
  return clamp((daysSince / staleDays) * 100, 0, 100);
}

function scoreOutcomeHistory(priorCoveredLoads: number, perLoad: number): number {
  return clamp(priorCoveredLoads * perLoad, 0, 100);
}

/**
 * Tactical = avg(hot-reply intensity, normalized-loads-per-week, laneScore).
 * Hot intensity is sourced from real `lane_carrier_interest` rows
 * (interestStatus IN 'available_now' | 'available_next_week') — 1 hot
 * reply ⇒ 70, 2 ⇒ 90, 3+ ⇒ 100. No replies but high-frequency lane
 * still gets a 50 floor so a brand-new HF lane isn't tactically dead.
 */
function scoreTactical(
  lane: LaneStrategicLaneInputs,
  signals: LaneStrategicSignalInputs,
  avgLoadsCap: number,
): number {
  const hotN = Math.max(0, Math.floor(signals.hotReplyCount || 0));
  const hotPart = hotN >= 3 ? 100 : hotN === 2 ? 90 : hotN === 1 ? 70 : (lane.isHighFrequency ? 50 : 25);
  const loadsRaw = toNumber(lane.avgLoadsPerWeek);
  const loadsPart = avgLoadsCap > 0 ? clamp((loadsRaw / avgLoadsCap) * 100, 0, 100) : 0;
  const lanePart = clamp(toNumber(lane.laneScore), 0, 100);
  return (hotPart + loadsPart + lanePart) / 3;
}

const LIFECYCLE_PRIORITY: Record<LaneLifecycleStage, number> = {
  detected: 20,
  qualified: 60,
  assigned: 80,
  contactable: 80,
  contacted: 70,
  engaged: 90,
  // Operationalized lanes are owned by Ops and should drop in the rep queue.
  operationalized: 10,
};

function scoreLifecycle(stage: LaneLifecycleStage | null | undefined): number {
  if (!stage) return 30;
  return LIFECYCLE_PRIORITY[stage] ?? 30;
}

/**
 * Compute the strategic priority for a single lane. Pure function — no
 * DB, no clock. All weights are validated by the caller (see
 * `server/laneStrategicWeights.ts`).
 */
export function computeLaneStrategicPriority(
  lane: LaneStrategicLaneInputs,
  customer: LaneStrategicCustomerInputs,
  signals: LaneStrategicSignalInputs,
  lifecycle: LaneLifecycleStage | null | undefined,
  weights: LaneStrategicWeights = DEFAULT_LANE_STRATEGIC_WEIGHTS,
): LaneStrategicResult {
  const subScores: Array<{ label: string; score: number; weight: number }> = [
    { label: "Customer value", score: scoreCustomerValue(customer, weights.customerValueCap), weight: weights.customerValue },
    { label: "Relationship freshness", score: scoreFreshness(signals.daysSinceOwnerTouchpoint, weights.freshnessStaleDays), weight: weights.freshness },
    { label: "Lane outcome history", score: scoreOutcomeHistory(signals.priorCoveredLoads, weights.outcomeBoostPerLoad), weight: weights.outcomeHistory },
    { label: "Tactical signal", score: scoreTactical(lane, signals, weights.avgLoadsCap), weight: weights.tactical },
    { label: "Lifecycle stage", score: scoreLifecycle(lifecycle), weight: weights.lifecycle },
  ];

  const components: LaneStrategicComponent[] = subScores.map(s => ({
    label: s.label,
    score: Math.round(s.score * 100) / 100,
    contribution: Math.round(s.score * s.weight * 100) / 100,
  }));

  const totalWeight = subScores.reduce((acc, s) => acc + s.weight, 0);
  const weightedSum = subScores.reduce((acc, s) => acc + s.score * s.weight, 0);
  const score = totalWeight > 0 ? clamp(weightedSum / totalWeight, 0, 100) : 0;

  // topReason = component with the largest effective contribution.
  let top = components[0];
  for (const c of components) if (c.contribution > top.contribution) top = c;

  return {
    score: Math.round(score * 100) / 100,
    components,
    topReason: top.label,
  };
}
