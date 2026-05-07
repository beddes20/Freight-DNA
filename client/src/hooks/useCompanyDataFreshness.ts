// Task #1109 — Per-company data-freshness payload.
//
// Single read-only fetch shared by every freshness pill / line on the
// Company Profile. Returns last-success timestamps for the four
// upstream sources we surface today. No recomputation — pure SELECT.

import { useQuery } from "@tanstack/react-query";

export type FreshnessSource = "nba" | "growth" | "health" | "financials";

export interface DataFreshnessPayload {
  nba: string | null;
  growth: string | null;
  health: string | null;
  financials: string | null;
}

export const FRESHNESS_THRESHOLDS_MS: Record<FreshnessSource, number> = {
  nba:        24 * 60 * 60 * 1000,
  growth:     7 * 24 * 60 * 60 * 1000,
  health:     7 * 24 * 60 * 60 * 1000,
  financials: 7 * 24 * 60 * 60 * 1000,
};

export function useCompanyDataFreshness(companyId: string, enabled: boolean = true) {
  return useQuery<DataFreshnessPayload>({
    queryKey: ["/api/companies", companyId, "data-freshness"],
    enabled: enabled && !!companyId,
    staleTime: 60 * 1000,
  });
}

export function formatAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function isStale(iso: string | null, source: FreshnessSource): boolean {
  if (!iso) return true;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts > FRESHNESS_THRESHOLDS_MS[source];
}
