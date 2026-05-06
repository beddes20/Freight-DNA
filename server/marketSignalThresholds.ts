/**
 * Market Signal Threshold Configuration
 *
 * Single source of truth for all threshold values used by the Market Signal Engine.
 * All detection logic reads from this config — no magic numbers in the engine.
 *
 * To tune thresholds without code changes, modify the values here.
 */

export interface MarketSignalThresholdConfig {
  /** Rolling window (hours) in which recent events are counted for signal evaluation */
  evaluationWindowHours: number;
  /** Baseline lookback window (hours) to compute the expected baseline count */
  baselineLookbackHours: number;
  /** Minimum number of events in the recent window before a signal can fire */
  minEventCount: number;
  /** Minimum percent increase vs baseline to qualify as a demand surge */
  demandSurgeMinPctIncrease: number;
  /** Minimum number of distinct account IDs required (prevents single-account gaming) */
  distinctAccountFloor: number;
  /** Minimum number of distinct carrier IDs for capacity signals */
  distinctCarrierFloor: number;
  /** Cooldown duration (hours) before a signal re-activates after entering "cooling" */
  cooldownHours: number;
  /** Hours after which an active signal with no new evidence auto-resolves */
  autoResolveHours: number;
  /** Hours after which an active signal transitions to "cooling" if evidence weakens */
  coolingTransitionHours: number;
  /** Minimum confidence (0–1) for a signal to be created */
  minConfidence: number;
  /** Percent increase thresholds for severity levels */
  severity: {
    /** pct increase to reach "medium" severity */
    mediumPctThreshold: number;
    /** pct increase to reach "high" severity */
    highPctThreshold: number;
    /** pct increase to reach "critical" severity */
    criticalPctThreshold: number;
  };
  /** Imbalance detection: carrier capacity signal strength thresholds */
  imbalance: {
    /** Max confidence of a capacity signal that is considered "weak" for imbalance */
    weakCapacityConfidenceMax: number;
  };
}

export const MARKET_SIGNAL_THRESHOLDS: MarketSignalThresholdConfig = {
  evaluationWindowHours: 24,
  baselineLookbackHours: 168, // 7 days
  minEventCount: 5,
  demandSurgeMinPctIncrease: 20,
  distinctAccountFloor: 2,
  distinctCarrierFloor: 2,
  cooldownHours: 4,
  autoResolveHours: 72,
  coolingTransitionHours: 48,
  minConfidence: 0.3,
  severity: {
    mediumPctThreshold: 20,
    highPctThreshold: 50,
    criticalPctThreshold: 100,
  },
  imbalance: {
    weakCapacityConfidenceMax: 0.4,
  },
};
