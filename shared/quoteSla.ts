/**
 * Customer Quotes — pure SLA helpers.
 *
 * Pending quotes have a 7-minute response SLA (mirrors the
 * `quoteRequestSlaService` cron threshold). This module computes a
 * per-quote `slaState` so the dashboard can render badges and the
 * Action Queue can sort breaching rows to the top — without persisting
 * a stale denormalized column on `quote_opportunities`.
 *
 * All math is pure and clock-injectable so the same code runs on the
 * server (when enriching the list payload) and on the client (when
 * the badge needs to tick over without a refetch).
 */
export type QuoteSlaState = "ok" | "warning" | "breached" | "na";

export interface QuoteSla {
  state: QuoteSlaState;
  /** Milliseconds since `requestDate`. Negative means future-dated (clamped to 0). */
  ageMs: number;
  /** Minutes since `requestDate`, rounded. Convenience for display. */
  minutesSinceRequest: number;
  /**
   * Milliseconds remaining until SLA breach. Negative once breached
   * (i.e. how far past). Always 0 when state === "na".
   */
  remainingMs: number;
  /** SLA threshold in minutes that produced this state. */
  slaMinutes: number;
}

/**
 * Default SLA = 7 minutes (matches QUOTE_SLA_MINUTES in
 * server/quoteRequestSlaService.ts). Warning band kicks in 2 min before
 * breach (i.e. at 5 min remaining or less).
 */
export const DEFAULT_QUOTE_SLA_MINUTES = 7;
export const DEFAULT_QUOTE_SLA_WARNING_MINUTES = 2;

/**
 * Compute the SLA state for a single quote.
 *
 * - `na` for any non-pending status (won/lost/expired/etc.) and for
 *   missing or invalid `requestDate`.
 * - `ok` while > warningMinutes remain to the threshold.
 * - `warning` once <= warningMinutes remain.
 * - `breached` once age exceeds the threshold.
 */
export function computeQuoteSla(
  requestDate: Date | string | number | null | undefined,
  outcomeStatus: string | null | undefined,
  opts: { now?: number; slaMinutes?: number; warningMinutes?: number } = {},
): QuoteSla {
  const slaMinutes = opts.slaMinutes ?? DEFAULT_QUOTE_SLA_MINUTES;
  const warningMinutes = opts.warningMinutes ?? DEFAULT_QUOTE_SLA_WARNING_MINUTES;

  const status = (outcomeStatus ?? "").toLowerCase();
  if (status !== "pending") {
    return { state: "na", ageMs: 0, minutesSinceRequest: 0, remainingMs: 0, slaMinutes };
  }
  if (requestDate == null) {
    return { state: "na", ageMs: 0, minutesSinceRequest: 0, remainingMs: 0, slaMinutes };
  }

  const reqMs = requestDate instanceof Date
    ? requestDate.getTime()
    : new Date(requestDate).getTime();
  if (!Number.isFinite(reqMs)) {
    return { state: "na", ageMs: 0, minutesSinceRequest: 0, remainingMs: 0, slaMinutes };
  }

  const now = opts.now ?? Date.now();
  const ageMs = Math.max(0, now - reqMs);
  const slaMs = slaMinutes * 60_000;
  const warnMs = warningMinutes * 60_000;
  const remainingMs = slaMs - ageMs;

  let state: QuoteSlaState;
  if (ageMs >= slaMs) state = "breached";
  else if (remainingMs <= warnMs) state = "warning";
  else state = "ok";

  return {
    state,
    ageMs,
    minutesSinceRequest: Math.floor(ageMs / 60_000),
    remainingMs,
    slaMinutes,
  };
}

/**
 * Format remainingMs as a compact badge label:
 *   "5m"     ok / warning  → minutes left
 *   "+12m"   breached      → minutes overdue (< 1 hour)
 *   "+3h"    breached      → hours overdue (< 1 day)
 *   "+30d"   breached      → days overdue
 *   "<1m"    sub-minute remaining (warning)
 *   ""       na
 *
 * Once a quote ages past an hour (or day), we promote the unit so the
 * badge stays compact. "+43464m" is unreadable; "+30d" is not.
 */
export function formatSlaBadge(sla: QuoteSla): string {
  if (sla.state === "na") return "";
  if (sla.state === "breached") {
    const overdueMs = Math.max(60_000, -sla.remainingMs);
    return `+${humanizeCompactDuration(overdueMs)}`;
  }
  const minutes = Math.floor(sla.remainingMs / 60_000);
  if (minutes <= 0) return "<1m";
  return humanizeCompactDuration(sla.remainingMs);
}

/**
 * Render a positive duration in ms as a compact badge token: "Nm" under
 * an hour, "Nh" under a day, otherwise "Nd". Values are floored so the
 * badge never overstates how much time has passed / is left.
 */
function humanizeCompactDuration(ms: number): string {
  const safe = Math.max(0, ms);
  const minutes = Math.floor(safe / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
