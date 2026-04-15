/**
 * Lane Market Signal Badge
 *
 * Displays TRAC-derived directional signal (primary) and VOTRI % (supplementary)
 * for a lane (origin → destination).
 * Fetches from GET /api/sonar/lane-signals?origin=X&destination=Y.
 * Signal classification (hot/warm/cool) is TRAC forecast_index_value–based;
 * VOTRI % is shown as supplementary when available.
 *
 * Usage:
 *   <VotriBadge origin="Atlanta" destination="Dallas" />
 */

import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Radio } from "lucide-react";

interface LaneVotri {
  origin: string;
  destination: string;
  qualifier: string;
  votri: number | null;
  votriWoW: number | null;
  signal: "hot" | "warm" | "stable" | "cool" | null;
  timestamp: string;
  isStale: boolean;
  lastSuccessfulPull: string | null;
}

interface VotriBadgeProps {
  origin: string;
  destination: string;
  showTooltip?: boolean;
  className?: string;
  testId?: string;
}

const SIGNAL_STYLES: Record<string, string> = {
  hot:     "border-red-500/60 text-red-400 bg-red-500/10",
  warm:    "border-amber-500/50 text-amber-400 bg-amber-500/10",
  stable:  "border-blue-500/50 text-blue-400 bg-blue-500/10",
  cool:    "border-green-500/50 text-green-400 bg-green-500/10",
  none:    "border-gray-400/50 text-gray-400 bg-gray-500/10",
};

const SIGNAL_LABELS: Record<string, string> = {
  hot:     "Tightening",
  warm:    "Mild tightening",
  stable:  "Stable",
  cool:    "Softening",
  none:    "No signal",
};

export function VotriBadge({ origin, destination, showTooltip = true, className = "", testId }: VotriBadgeProps) {
  const { data, isLoading } = useQuery<{ signal: LaneVotri | null; tracSpotRpm: number | null }>({
    queryKey: ["/api/sonar/lane-signals", origin, destination],
    queryFn: () =>
      fetch(`/api/sonar/lane-signals?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`)
        .then(r => r.ok ? r.json() : { signal: null, tracSpotRpm: null }),
    staleTime: 4 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: !!(origin && destination),
  });

  if (isLoading) {
    return <Skeleton className="h-4 w-12 rounded-full" />;
  }

  const signal = data?.signal;
  const tracSpotRpm = data?.tracSpotRpm ?? null;

  if (!signal) {
    return (
      <Badge
        variant="outline"
        className={`text-[10px] py-0 px-1.5 gap-0.5 ${SIGNAL_STYLES.none} ${className}`}
        data-testid={testId ?? `badge-signal-${origin}-${destination}`}
      >
        <Radio className="w-2.5 h-2.5" />
        No signal
      </Badge>
    );
  }

  const sigKey = signal.signal ?? "none";
  const hasVotri = signal.votri !== null;

  const badge = (
    <Badge
      variant="outline"
      className={`text-[10px] py-0 px-1.5 gap-0.5 ${SIGNAL_STYLES[sigKey] ?? SIGNAL_STYLES.none} ${className}`}
      data-testid={testId ?? `badge-signal-${origin}-${destination}`}
    >
      <Radio className="w-2.5 h-2.5" />
      {sigKey !== "none" ? SIGNAL_LABELS[sigKey] : "No signal"}
      {tracSpotRpm !== null && (
        <span className="ml-0.5 opacity-80 font-mono">${tracSpotRpm.toFixed(2)}</span>
      )}
    </Badge>
  );

  if (!showTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="text-xs max-w-[280px] space-y-1.5 p-3">
        <div className="flex items-center justify-between gap-4">
          <span className="font-semibold">{origin} → {destination}</span>
          <span className={`text-[11px] font-bold ${
            sigKey === "hot" ? "text-red-400"
            : sigKey === "warm" ? "text-amber-400"
            : sigKey === "stable" ? "text-blue-400"
            : sigKey === "cool" ? "text-green-400"
            : "text-gray-400"
          }`}>{SIGNAL_LABELS[sigKey] ?? SIGNAL_LABELS.none}</span>
        </div>
        <div className="space-y-0.5 text-muted-foreground">
          <p>
            <span className="text-foreground font-medium">
              {sigKey !== "none" ? `Direction: ${SIGNAL_LABELS[sigKey]}` : "No directional signal"}
            </span>
            {" "}— TRAC forecast
          </p>
          {tracSpotRpm !== null && (
            <p>
              TRAC Spot Rate: <span className="text-foreground font-medium font-mono">${tracSpotRpm.toFixed(2)}/mi</span>
            </p>
          )}
          {hasVotri && (
            <p>
              VOTRI: {signal.votri!.toFixed(1)}%
              {signal.votriWoW !== null && (
                <span className={`ml-1 ${signal.votriWoW > 0 ? "text-red-400" : signal.votriWoW < 0 ? "text-green-400" : ""}`}>
                  ({signal.votriWoW > 0 ? "+" : ""}{signal.votriWoW.toFixed(1)} pp WoW)
                </span>
              )}
            </p>
          )}
          {!hasVotri && tracSpotRpm === null && (
            <p>
              Data unavailable{signal.lastSuccessfulPull ? ` — last updated ${new Date(signal.lastSuccessfulPull).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
            </p>
          )}
        </div>
        {sigKey !== "none" && (
          <p className="text-[10px] leading-relaxed">
            {sigKey === "hot"
              ? "Market is tight — TRAC forecasts capacity tightening. Outreach to this lane is high-priority."
              : sigKey === "warm"
              ? "Market shows mild tightening — monitor for further escalation."
              : sigKey === "stable"
              ? "Market is stable — no significant directional movement expected."
              : "Market is softening — good conditions for rate negotiation."}
          </p>
        )}
        {signal.isStale && (
          <p className="text-amber-400 text-[10px]">⚠ Data may be slightly delayed</p>
        )}
        <p className="text-[9px] text-muted-foreground/60">
          Source: FreightWaves TRAC + Sonar · {signal.qualifier}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Compact inline version — just the colored dot + signal label, no percentage.
 */
export function VotriSignalDot({ origin, destination, testId }: Omit<VotriBadgeProps, "showTooltip" | "className">) {
  const { data } = useQuery<{ signal: LaneVotri | null }>({
    queryKey: ["/api/sonar/lane-signals", origin, destination],
    queryFn: () =>
      fetch(`/api/sonar/lane-signals?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`)
        .then(r => r.ok ? r.json() : { signal: null }),
    staleTime: 4 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: !!(origin && destination),
  });

  const signal = data?.signal;
  if (!signal) return null;

  const sigKey = signal.signal ?? "none";
  const colorMap: Record<string, string> = { hot: "#ef4444", warm: "#f59e0b", stable: "#3b82f6", cool: "#22c55e", none: "#9ca3af" };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0 cursor-help"
          style={{ background: colorMap[sigKey] ?? colorMap.none }}
          data-testid={testId ?? `dot-votri-${origin}-${destination}`}
        />
      </TooltipTrigger>
      <TooltipContent className="text-xs p-2">
        <span className="font-semibold">{origin} → {destination}</span>
        <br />
        {sigKey !== "none" ? (
          <>
            {SIGNAL_LABELS[sigKey] ?? "No signal"}
            {signal.votri !== null && ` · VOTRI ${signal.votri.toFixed(1)}%`}
            {signal.votriWoW !== null && signal.votriWoW !== 0 && ` (${signal.votriWoW > 0 ? "+" : ""}${signal.votriWoW.toFixed(1)} pp WoW)`}
          </>
        ) : (
          <>Data unavailable{signal.lastSuccessfulPull ? ` — last updated ${new Date(signal.lastSuccessfulPull).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
