// Task #871 — Shared freshness pill for AF + LWQ.
//
// Pulled out of `available-freight.tsx` so the LWQ header (and any future
// surface) can render the IDENTICAL pill from the same data shape. The
// component is presentation-only — the page passes in the `signal` it
// already fetches; nothing here touches the network.

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface FreshnessProducerSignal {
  id: "won_load_autopilot" | "available_freight_importer" | "manual";
  label: string;
  lastEventAt: string | null;
  ageMinutes: number | null;
  count24h: number;
  healthState: "green" | "yellow" | "red";
}

export interface FreshnessSignal {
  overall: {
    healthState: "green" | "yellow" | "red";
    lastEventAt: string | null;
    ageMinutes: number | null;
  };
  producers: FreshnessProducerSignal[];
  thresholds: {
    greenMaxMinutes: number;
    yellowMaxMinutes: number;
    redMissingMinutes: number;
  };
}

function fmtAge(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "—";
  if (min < 60) return `${Math.max(0, Math.round(min))}m`;
  const h = min / 60;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// Tones match the original AF cockpit pill (subtle border + 10% bg).
export function freshnessHeaderPillTone(state: "green" | "yellow" | "red"): string {
  switch (state) {
    case "green":  return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "yellow": return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "red":    return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
  }
}

export function freshnessDotTone(state: "green" | "yellow" | "red"): string {
  switch (state) {
    case "green":  return "bg-emerald-500 animate-pulse";
    case "yellow": return "bg-amber-500";
    case "red":    return "bg-red-500";
  }
}

export function freshnessLabel(signal: FreshnessSignal | undefined): string {
  if (!signal) return "Freshness pending";
  const { ageMinutes, healthState, lastEventAt } = signal.overall;
  if (lastEventAt == null || ageMinutes == null) return "No ingestion in 24h";
  const word = healthState === "green" ? "Fresh" : healthState === "yellow" ? "Slowing" : "Stale";
  return `${word} · ${fmtAge(ageMinutes)} ago`;
}

/**
 * Compact freshness pill rendered in page headers. The popover content
 * lists each producer (Won-Load Autopilot / Excel importer / Manual) with
 * its last-event age and 24h count so reps can see where new freight is
 * coming from at a glance.
 */
export function FreshnessPill({
  signal,
  testId = "pill-freight-freshness",
  popoverTestId = "popover-freight-freshness",
}: {
  signal: FreshnessSignal | undefined;
  testId?: string;
  popoverTestId?: string;
}) {
  const state = signal?.overall.healthState ?? "red";
  const label = freshnessLabel(signal);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium hover:opacity-90 ${freshnessHeaderPillTone(state)}`}
          data-testid={testId}
          data-freshness-state={state}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${freshnessDotTone(state)}`} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3 text-xs" data-testid={popoverTestId}>
        <div className="font-semibold text-sm mb-2">Ingestion freshness</div>
        {!signal ? (
          <div className="text-muted-foreground">No signal available yet.</div>
        ) : (
          <>
            <div className="text-muted-foreground mb-2">
              Most recent event across all producers:{" "}
              {signal.overall.lastEventAt
                ? `${fmtAge(signal.overall.ageMinutes)} ago`
                : "none in 24h"}
            </div>
            <div className="divide-y divide-border">
              {signal.producers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between py-1.5"
                  data-testid={`row-freshness-producer-${p.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block h-2 w-2 rounded-full ${freshnessDotTone(p.healthState)}`} />
                    <span className="truncate">{p.label}</span>
                  </div>
                  <div className="text-muted-foreground tabular-nums whitespace-nowrap">
                    {p.lastEventAt ? `${fmtAge(p.ageMinutes)} ago` : "dark"}
                    <span className="ml-2 text-[10px]">({p.count24h}/24h)</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-border text-[10px] text-muted-foreground">
              Green ≤{signal.thresholds.greenMaxMinutes}m · Yellow ≤{signal.thresholds.yellowMaxMinutes}m · Red beyond
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
