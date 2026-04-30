/**
 * Task #849 §3.4 + §3.7 — shared aggregation surface for the
 * autopilot/leak-closure decision counters.
 *
 * Two endpoints feed off this:
 *   - GET /api/admin/conversations/leakage-stats        (Phase 2a tile)
 *   - GET /api/quote-requests/automation-counters       (post-2d operator strip)
 *
 * Both must agree on: window resolution, the underlying decision-bucket
 * source, and the dry-run vs live shape. Centralizing the math here is
 * the contract requirement ("DO NOT duplicate the SQL"; the counters
 * are an in-memory ring buffer in `quoteOpportunityFromSignalService`,
 * but the *resolution + shaping* is what we share here).
 */

import {
  getClosureCounters,
  isForwardClosureEnabled,
  type ClosureCounters,
} from "./quoteOpportunityFromSignalService";

export const CLOSURE_WINDOW_LABELS = ["today", "last_24h", "last_7d"] as const;
export type ClosureWindowLabel = typeof CLOSURE_WINDOW_LABELS[number];

export interface ClosureWindow {
  label: ClosureWindowLabel;
  startIso: string;
  endIso: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Resolve a window label to an absolute [startIso, endIso] interval
 * anchored at `now`. `today` is the calendar day in UTC up to `now`;
 * `last_24h` and `last_7d` are rolling lookbacks.
 */
export function resolveClosureWindow(
  label: ClosureWindowLabel,
  now: Date = new Date(),
): ClosureWindow {
  const end = now;
  let start: Date;
  switch (label) {
    case "today": {
      start = new Date(end);
      start.setUTCHours(0, 0, 0, 0);
      break;
    }
    case "last_24h":
      start = new Date(end.getTime() - DAY_MS);
      break;
    case "last_7d":
      start = new Date(end.getTime() - 7 * DAY_MS);
      break;
  }
  return {
    label,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export interface ComputedClosureCounters {
  organizationId: string;
  window: ClosureWindow;
  closureFlagEnabled: boolean;
  /**
   * Live counters that always exist regardless of flag state. When the
   * forward-closure flag is OFF, `created` and `attached` reflect any
   * pre-flag legacy decisions in the buffer (typically 0 in dev).
   */
  counters: {
    created: number;
    attached: number;
    skippedInternal: number;
    skippedLowConfidence: number;
    /** Only populated when `closureFlagEnabled === false`. */
    wouldCreate?: number;
    /** Only populated when `closureFlagEnabled === false`. */
    wouldAttach?: number;
    /** Only populated when `closureFlagEnabled === false`. */
    wouldSkippedLowConfidence?: number;
  };
}

/**
 * Compute the closure counters for a given org + window. Pure function
 * over the in-process decision ring buffer — no I/O.
 */
export function computeClosureCounters(
  organizationId: string,
  windowLabel: ClosureWindowLabel,
  now: Date = new Date(),
): ComputedClosureCounters {
  const window = resolveClosureWindow(windowLabel, now);
  const sinceMs = new Date(window.startIso).getTime();
  const raw: ClosureCounters = getClosureCounters(organizationId, sinceMs);
  const closureFlagEnabled = isForwardClosureEnabled();
  const counters: ComputedClosureCounters["counters"] = {
    created: raw.created,
    attached: raw.attached,
    skippedInternal: raw.skippedInternal,
    skippedLowConfidence: raw.skippedLowConfidence,
  };
  if (!closureFlagEnabled) {
    counters.wouldCreate = raw.wouldCreate;
    counters.wouldAttach = raw.wouldAttach;
    counters.wouldSkippedLowConfidence = raw.wouldSkippedLowConfidence;
  }
  return {
    organizationId,
    window,
    closureFlagEnabled,
    counters,
  };
}
