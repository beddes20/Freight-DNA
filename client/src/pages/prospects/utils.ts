import { CLOSED_STAGES } from "./types";
import type { EnrichedProspect } from "./types";

export function daysAgo(dateStr: string | Date): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

export function isOverdue(dateStr?: string | null): boolean {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date(new Date().toDateString());
}

export function isDueToday(dateStr?: string | null): boolean {
  if (!dateStr) return false;
  return dateStr === new Date().toISOString().split("T")[0];
}

export function isStale(prospect: EnrichedProspect, thresholdDays = 14): boolean {
  if (CLOSED_STAGES.includes(prospect.stage as any)) return false;
  return daysAgo(prospect.updatedAt as unknown as string) >= thresholdDays;
}

export function parseSpend(s?: string | null): number {
  if (!s) return 0;
  return parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
}

export function weightedValue(p: EnrichedProspect): number {
  const spend = parseSpend(p.estimatedSpend);
  const prob = p.dealProbability != null ? p.dealProbability / 100 : 0.5;
  return spend * prob;
}

export function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
