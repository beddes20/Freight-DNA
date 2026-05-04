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
      <PopoverContent align="start" className="w-72 p-3 text-xs" data-testid={`popover-hidden-${surface}`}>
        <div className="font-semibold text-sm mb-2">
          Showing {summary.visible} of {summary.totalInScope} {surfaceLabel}
        </div>
        {nonZero.length === 0 ? (
          <div className="text-muted-foreground">
            All in-scope {surfaceLabel} are visible.
          </div>
        ) : (
          <div className="divide-y divide-border">
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
            <div className="flex items-center justify-between py-1.5 mt-1 border-t border-border font-semibold">
              <span>Total hidden</span>
              <span className="tabular-nums" data-testid={`count-hidden-total-${surface}`}>
                {hiddenTotal}
              </span>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
