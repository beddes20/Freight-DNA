// Task #871 — Hidden-counts disclosure shared by AF + LWQ.
//
// AF already explains *why* the row count is small ("N hidden by status,
// M past pickup …"). The same disclosure now appears on LWQ so reps can
// see why a lane they expect isn't on the list (off-cycle, snoozed,
// missing contacts, etc) without having to dig through filters.
//
// Both surfaces feed the component the same `HiddenCountsSummary` shape;
// the surface-specific labels live here so a rename only touches one
// file.

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EyeOff } from "lucide-react";

export interface HiddenCountsRow {
  id: string;
  label: string;
  count: number;
}

export interface HiddenCountsSummary {
  /** Total in-scope rows BEFORE filtering. Drives the “N visible of M total” banner. */
  totalInScope: number;
  /** Rows currently visible (post-filter). */
  visible: number;
  /** Per-bucket counts. The component shows non-zero buckets only. */
  buckets: HiddenCountsRow[];
  /**
   * Task #971 — optional second top-level group ("Hidden by dedupe — last
   * import"). When present, AF renders a two-section disclosure: the
   * existing filter-side buckets, then a separate group sourced from the
   * Excel importer's run-level audit (collapsedByOrderKey,
   * unmatchedCustomers, expired, …) plus per-row entries for canonical
   * rows that absorbed a soft-merge (each carries `canonicalOpportunityId`
   * so the rep can jump to the row in-cockpit).
   */
  dedupeGroup?: {
    label: string;
    buckets: HiddenCountsRow[];
    subtitle?: string;
    mergedRows?: Array<{
      id: string;
      label: string;
      canonicalOpportunityId: string;
      mergedFromStableKey: string;
    }>;
  } | null;
}

/**
 * Sum the bucket counts. Exported so tests can lock the contract that
 * the disclosure total never disagrees with the sum of its parts.
 */
export function sumHiddenBuckets(summary: HiddenCountsSummary): number {
  return summary.buckets.reduce((acc, b) => acc + Math.max(0, b.count), 0);
}

// Task #967 — extended to Quotes + Conversations so the same trust signal
// ("N hidden of M total — here's why") appears on every ops tab.
export type HiddenCountsSurface = "lwq" | "af" | "quotes" | "conversations";

const SURFACE_NOUN: Record<HiddenCountsSurface, string> = {
  lwq: "lanes",
  af: "loads",
  quotes: "quotes",
  conversations: "threads",
};

export function HiddenCountsDisclosure({
  summary,
  surface,
  testId,
}: {
  summary: HiddenCountsSummary | null | undefined;
  surface: HiddenCountsSurface;
  testId?: string;
}) {
  if (!summary) return null;
  const hiddenTotal = Math.max(0, summary.totalInScope - summary.visible);
  if (hiddenTotal <= 0) return null;
  const nonZero = summary.buckets.filter(b => b.count > 0);
  const surfaceLabel = SURFACE_NOUN[surface];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/80"
          data-testid={testId ?? `disclosure-hidden-${surface}`}
          data-hidden-total={hiddenTotal}
        >
          <EyeOff className="h-3 w-3" />
          {hiddenTotal} hidden {surfaceLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3 text-xs" data-testid={`popover-hidden-${surface}`}>
        <div className="font-semibold text-sm mb-2">
          Showing {summary.visible} of {summary.totalInScope} {surfaceLabel}
        </div>
        {nonZero.length === 0 && !summary.dedupeGroup ? (
          <div className="text-muted-foreground">
            All in-scope {surfaceLabel} are visible.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Group 1 — Hidden by filters. Always shown when there are
                non-zero buckets. The label only appears when a second
                group is present so we don't add visual noise to the
                single-group case (LWQ / Quotes / Conversations). */}
            {nonZero.length > 0 && (
              <div className="divide-y divide-border" data-testid={`group-hidden-filters-${surface}`}>
                {summary.dedupeGroup ? (
                  <div className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Hidden by filters
                  </div>
                ) : null}
                {nonZero.map(b => (
                  <div
                    key={b.id}
                    className="flex items-center justify-between py-1.5"
                    data-testid={`row-hidden-bucket-${b.id}`}
                  >
                    <span className="truncate">{b.label}</span>
                    <span className="tabular-nums text-foreground" data-testid={`count-hidden-bucket-${b.id}`}>
                      {b.count}
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between py-1.5 mt-1 font-semibold">
                  <span>Total hidden</span>
                  <span className="tabular-nums" data-testid={`count-hidden-total-${surface}`}>
                    {hiddenTotal}
                  </span>
                </div>
              </div>
            )}
            {/* Group 2 — Hidden by dedupe (Task #971, AF-only today).
                Stable subtotal even when its buckets are empty so reps can
                see "0 collapsed today" and trust the importer is healthy. */}
            {summary.dedupeGroup && (
              <div data-testid={`group-hidden-dedupe-${surface}`}>
                <div className="pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {summary.dedupeGroup.label}
                </div>
                {summary.dedupeGroup.subtitle ? (
                  <div className="pb-1 text-[11px] text-muted-foreground">
                    {summary.dedupeGroup.subtitle}
                  </div>
                ) : null}
                <div className="divide-y divide-border">
                  {summary.dedupeGroup.buckets.length === 0 ? (
                    <div className="text-muted-foreground py-1.5">
                      No dedupe activity in the last import.
                    </div>
                  ) : (
                    summary.dedupeGroup.buckets.map(b => (
                      <div
                        key={b.id}
                        className="flex items-center justify-between py-1.5"
                        data-testid={`row-dedupe-bucket-${b.id}`}
                      >
                        <span className="truncate">{b.label}</span>
                        <span
                          className="tabular-nums text-foreground"
                          data-testid={`count-dedupe-bucket-${b.id}`}
                        >
                          {b.count}
                        </span>
                      </div>
                    ))
                  )}
                  <div className="flex items-center justify-between py-1.5 mt-1 font-semibold">
                    <span>Dedupe activity</span>
                    <span
                      className="tabular-nums"
                      data-testid={`count-dedupe-total-${surface}`}
                    >
                      {summary.dedupeGroup.buckets.reduce((acc, b) => acc + Math.max(0, b.count), 0)}
                    </span>
                  </div>
                </div>
                {summary.dedupeGroup.mergedRows && summary.dedupeGroup.mergedRows.length > 0 && (
                  <div className="mt-2 pt-2 border-t" data-testid={`group-dedupe-merged-rows-${surface}`}>
                    <div className="pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Soft-merged today ({summary.dedupeGroup.mergedRows.length})
                    </div>
                    <ul className="space-y-1">
                      {summary.dedupeGroup.mergedRows.slice(0, 8).map((m) => (
                        <li
                          key={m.id}
                          data-testid={`row-dedupe-merged-${m.canonicalOpportunityId}`}
                          data-canonical-opportunity-id={m.canonicalOpportunityId}
                          data-merged-from-stable-key={m.mergedFromStableKey}
                        >
                          <a
                            href={`#freight-opportunity-${m.canonicalOpportunityId}`}
                            className="block truncate text-[11px] text-foreground hover:underline"
                            data-testid={`link-dedupe-merged-${m.canonicalOpportunityId}`}
                          >
                            {m.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
