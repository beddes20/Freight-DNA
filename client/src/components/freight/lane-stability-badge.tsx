// Task #871 — Lane stability badge.
//
// Surfaces the Stable / Volatile / Hot signal LWQ already computes on AF
// rows and on the Lane Cockpit header. The classifier lives on the
// server (laneCrossLinkService.classifyStability) so AF + LWQ + the
// cockpit cannot disagree.
//
// "Spot" is a UI-only fallback rendered when no recurring lane exists
// (i.e. the AF row has no LWQ counterpart) so reps see *something* in
// that column instead of a blank cell.

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type LaneStability = "stable" | "volatile" | "hot";

const TONE: Record<LaneStability, string> = {
  stable:   "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  volatile: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  hot:      "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};

const LABEL: Record<LaneStability, string> = {
  stable: "Stable",
  volatile: "Volatile",
  hot: "Hot",
};

const HINT: Record<LaneStability, string> = {
  stable: "Weekly load count is consistent (CV ≤ 0.3).",
  volatile: "Weekly load count swings (CV > 0.3) — stage capacity loosely.",
  hot: "Weekly load count is highly volatile (CV > 0.5) — pre-cover cautiously.",
};

export function LaneStabilityBadge({
  stability,
  testId,
}: {
  /** `null` renders the Spot fallback (no recurring counterpart). */
  stability: LaneStability | null;
  testId?: string;
}) {
  if (stability == null) {
    return (
      <Badge
        variant="outline"
        className="bg-muted text-muted-foreground border-border text-[10px]"
        data-testid={testId ?? "badge-lane-stability-spot"}
        data-stability="spot"
        title="No recurring history — treated as spot freight."
      >
        Spot
      </Badge>
    );
  }
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={`${TONE[stability]} text-[10px]`}
            data-testid={testId ?? `badge-lane-stability-${stability}`}
            data-stability={stability}
          >
            {LABEL[stability]}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-xs">
          {HINT[stability]}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
