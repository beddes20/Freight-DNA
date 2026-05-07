// Task #1109 — Sibling to LiveSyncPill that surfaces upstream-job
// freshness instead of SSE connection state. The two concepts are
// distinct (a stale screen with a live socket vs a fresh page with a
// dropped socket) and conflating them in one pill caused reps to trust
// stale data when the socket was green.

import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useCompanyDataFreshness,
  formatAgo,
  isStale,
  type DataFreshnessPayload,
  type FreshnessSource,
} from "@/hooks/useCompanyDataFreshness";

interface Props {
  companyId: string;
  testId?: string;
}

// Task #1109a — `health` reads `touchpoints.date` (user-entered, can be
// backdated), so the label says "Last touchpoint" rather than implying
// a background job ran recently.
const SOURCE_LABELS: Record<FreshnessSource, string> = {
  nba:        "Next Best Action",
  growth:     "Growth score",
  health:     "Last touchpoint",
  financials: "Financial sync",
};

function pickWorst(payload: DataFreshnessPayload): { source: FreshnessSource; ts: string | null; stale: boolean } {
  const sources: FreshnessSource[] = ["nba", "financials", "growth", "health"];
  let chosen: FreshnessSource = "nba";
  let chosenTs: string | null = payload.nba;
  let chosenStale = isStale(payload.nba, "nba");
  for (const src of sources) {
    const ts = payload[src];
    const stale = isStale(ts, src);
    if (stale && !chosenStale) {
      chosen = src; chosenTs = ts; chosenStale = stale; continue;
    }
    if (stale === chosenStale) {
      const a = ts ? new Date(ts).getTime() : 0;
      const b = chosenTs ? new Date(chosenTs).getTime() : 0;
      if ((ts === null && chosenTs !== null) || (ts !== null && chosenTs !== null && a < b)) {
        chosen = src; chosenTs = ts; chosenStale = stale;
      }
    }
  }
  return { source: chosen, ts: chosenTs, stale: chosenStale };
}

export function DataFreshnessPill({ companyId, testId }: Props): JSX.Element {
  const { data, isLoading, isError } = useCompanyDataFreshness(companyId);
  const rootTestId = testId ?? "pill-data-freshness";

  const summary = useMemo(() => (data ? pickWorst(data) : null), [data]);

  // Task #1109a — separate "unavailable" (fetch failed) from "stale" (real
  // upstream age). A network blip used to render amber/Stale; now it shows
  // a neutral grey "Freshness unavailable" so reps don't discount good data.
  const unavailable = !isLoading && (isError || !data || !summary);

  const label = (() => {
    if (isLoading) return "Checking…";
    if (unavailable) return "Freshness unavailable";
    if (!summary!.ts) return `${SOURCE_LABELS[summary!.source]} never run`;
    return `${SOURCE_LABELS[summary!.source]} ${formatAgo(summary!.ts) ?? "—"}`;
  })();

  const dotCls = (() => {
    if (isLoading) return "bg-muted-foreground animate-pulse";
    if (unavailable) return "bg-muted-foreground";
    if (summary!.stale) return "bg-amber-500";
    return "bg-emerald-500";
  })();

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={rootTestId}
            data-freshness-state={isLoading ? "loading" : unavailable ? "unavailable" : summary!.stale ? "stale" : "fresh"}
            data-freshness-stale={!unavailable && summary?.stale ? "true" : "false"}
            aria-label={label}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${dotCls}`} aria-hidden />
            <span data-testid={`${rootTestId}-label`}>Data: {label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="text-xs">
          <div className="font-medium mb-1" data-testid={`${rootTestId}-tooltip-title`}>Upstream data freshness</div>
          <div className="space-y-0.5 text-[11px]">
            {(["nba", "financials", "growth", "health"] as const).map(src => {
              const ts = data?.[src] ?? null;
              const stale = isStale(ts, src);
              return (
                <div key={src} data-testid={`${rootTestId}-tooltip-${src}`}>
                  <span className="text-muted-foreground">{SOURCE_LABELS[src]}:</span>{" "}
                  <span className={stale ? "text-amber-600 dark:text-amber-400" : ""}>
                    {ts ? `${formatAgo(ts)}${stale ? " · stale" : ""}` : "never"}
                  </span>
                </div>
              );
            })}
            <div className="mt-1 pt-1 border-t border-border/50 text-muted-foreground">
              Connection (live socket) is shown separately to the left.
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
