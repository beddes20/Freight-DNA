// Phase 1.5 S6 — Portlet visibility decision helper.
//
// Given a portlet's row count and an optional freshness signal (from
// shared/schema.PortletFreshness), decides which surface the portlet
// should render:
//
//   "rows"     — show the actual portlet rows (count > 0).
//   "hidden"   — hide entirely; the upstream is healthy and there's
//                truly nothing to show today (current legacy behavior).
//   "stale"    — render an amber degraded banner; upstream looks
//                unhealthy and we cannot prove the empty list is real.
//   "unknown"  — render a neutral grey "freshness unavailable" banner;
//                we cannot verify upstream state. NEVER escalate to
//                stale (Task #1109a — misled reps in pilot).
//
// Pure function, dependency-free, easy to unit-test under vitest.

export type PortletState = "rows" | "hidden" | "stale" | "unknown";

export interface PortletFreshnessLike {
  status: "ok" | "stale" | "unknown";
  source?: string;
  lastUpdatedAt?: string | null;
  nextExpectedAt?: string | null;
  consecutiveFailures?: number;
}

export function decidePortletState(
  rowCount: number,
  freshness: PortletFreshnessLike | null | undefined,
): PortletState {
  if (rowCount > 0) return "rows";
  // Empty result. The freshness verdict decides whether to hide
  // (healthy → "nothing today") or surface a banner.
  if (!freshness) return "hidden"; // legacy callers / pre-S3 servers
  if (freshness.status === "stale") return "stale";
  if (freshness.status === "unknown") return "unknown";
  return "hidden"; // status === "ok"
}
