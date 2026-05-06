/**
 * tracAlertEngine.ts — Alert generation + driver text for TRAC rate intelligence
 */

import type { TracForecastDay } from "./tracService";

export type RateAlert = "spike" | "drop" | "reprice" | null;

export interface AlertResult {
  alert: RateAlert;
  reason: string | null;
}

/**
 * Generate a rate alert based on TRAC data.
 *
 * Logic:
 *   spike  — avg forecast RPM over next 7 days > today spot by 8%+
 *   drop   — avg forecast RPM over next 7 days < today spot by 5%+
 *   reprice — spot RPM > contract RPM by 10%+
 *   null   — no notable signal
 */
export function generateAlert(
  spotRpm: number | null,
  forecastDays: TracForecastDay[],
  contractRpm: number | null,
  avg90dRpm: number | null,
): AlertResult {
  if (!spotRpm) return { alert: null, reason: null };

  // Avg forecast RPM over next 7 days
  const next7 = forecastDays.slice(0, 7).map((d) => d.forecastRpm).filter((v): v is number => v !== null);
  const avgForecast7d = next7.length ? next7.reduce((a, b) => a + b, 0) / next7.length : null;

  if (avgForecast7d !== null) {
    const forecastDelta = (avgForecast7d - spotRpm) / spotRpm;
    if (forecastDelta >= 0.08) {
      const pct = (forecastDelta * 100).toFixed(0);
      return {
        alert: "spike",
        reason: `Rates forecast to rise ${pct}% over the next 7 days. Lock in carrier capacity now before the market tightens.`,
      };
    }
    if (forecastDelta <= -0.05) {
      const pct = (Math.abs(forecastDelta) * 100).toFixed(0);
      return {
        alert: "drop",
        reason: `Rates softening — down ~${pct}% over the next 7 days. Hold spot coverage and leverage the spot market.`,
      };
    }
  }

  // Reprice opportunity: spot > contract by 10%+
  if (contractRpm && contractRpm > 0) {
    const delta = (spotRpm - contractRpm) / contractRpm;
    if (delta >= 0.10) {
      const pct = (delta * 100).toFixed(0);
      return {
        alert: "reprice",
        reason: `Spot is running ${pct}% above contract on this lane — strong reprice opportunity with your shipper.`,
      };
    }
  }

  return { alert: null, reason: null };
}

/**
 * Generate plain-English driver text explaining the market dynamic.
 *
 * Uses the forecast_index_value array (positive = tightening, negative = loosening).
 */
/**
 * Derive a directional signal from TRAC forecast_index_value.
 * positive avg = tightening, negative = softening, near zero = stable
 */
export type TracDirection = "hot" | "warm" | "stable" | "cool";

export function tracDirectionSignal(
  forecastDays: TracForecastDay[],
): { direction: TracDirection | null; label: string; avgIndex: number | null } {
  const indexVals = forecastDays.slice(0, 7).map((d) => d.forecastIndexValue).filter((v): v is number => v !== null);
  const avgIndex = indexVals.length ? indexVals.reduce((a, b) => a + b, 0) / indexVals.length : null;

  if (avgIndex === null) return { direction: null, label: "No signal", avgIndex: null };
  if (avgIndex > 0.05) return { direction: "hot", label: "Tightening", avgIndex };
  if (avgIndex > 0.02) return { direction: "warm", label: "Mild tightening", avgIndex };
  if (avgIndex < -0.03) return { direction: "cool", label: "Softening", avgIndex };
  return { direction: "stable", label: "Stable", avgIndex };
}

/**
 * Fetch TRAC forecast for a lane pair and derive directional signal.
 * Returns "hot"/"warm"/"cool"/null based on forecast_index_value trend.
 */
export async function tracLaneDirectionSignal(
  origin: string,
  destination: string,
): Promise<TracDirection | null> {
  try {
    const { cityToKma } = await import("./kmaMapping");
    const { fetchTracForecast } = await import("./tracService");
    const origKma = cityToKma(origin);
    const destKma = cityToKma(destination);
    if (!origKma || !destKma) return null;
    const laneId = `${origKma.kma}-${destKma.kma}-VAN`;
    const results = await fetchTracForecast([{
      lane_id: laneId,
      origin: origKma.kma,
      origin_country_code: "USA",
      destination: destKma.kma,
      destination_country_code: "USA",
      equipment_type: "VAN",
    }]);
    const forecast = results[0]?.days ?? [];
    if (forecast.length === 0) return null;
    const { direction } = tracDirectionSignal(forecast);
    return direction;
  } catch {
    return null;
  }
}

export function generateDriverText(
  forecastDays: TracForecastDay[],
  spotRpm: number | null,
  avg90dRpm: number | null,
): string {
  const indexVals = forecastDays.slice(0, 7).map((d) => d.forecastIndexValue).filter((v): v is number => v !== null);
  const avgIndex = indexVals.length ? indexVals.reduce((a, b) => a + b, 0) / indexVals.length : null;

  if (avgIndex === null || spotRpm === null) {
    return "Insufficient market data for this lane — rates shown from available TRAC history.";
  }

  const vsAvg = avg90dRpm && avg90dRpm > 0 ? (spotRpm - avg90dRpm) / avg90dRpm : null;

  if (avgIndex > 0.08) {
    return "Capacity tightening — rejection rates rising in this corridor. Expect upward rate pressure over the coming week.";
  }
  if (avgIndex > 0.03) {
    return "Market showing mild tightening signals — carrier availability starting to contract in this lane.";
  }
  if (avgIndex < -0.05) {
    return "Rates softening — carriers adding capacity into the destination market. Favorable conditions for spot procurement.";
  }
  if (avgIndex < -0.02) {
    return "Slight market loosening — spot rates trending down modestly. Monitor weekly for continued softening.";
  }

  // Near 0 index — check vs 90-day avg
  if (vsAvg !== null && vsAvg >= 0.10) {
    return `Market stabilizing after recent surge — rates still running ~${(vsAvg * 100).toFixed(0)}% above the 90-day average. Elevated but plateauing.`;
  }
  if (vsAvg !== null && vsAvg <= -0.08) {
    return `Rates running ~${(Math.abs(vsAvg) * 100).toFixed(0)}% below 90-day average — soft market with solid spot buying opportunity.`;
  }

  return "Market stabilizing — rates near the 90-day average with no significant directional pressure this week.";
}
