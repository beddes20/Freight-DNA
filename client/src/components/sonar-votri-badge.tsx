/**
 * Sonar VOTRI Badge
 *
 * Displays Van Outbound Tender Rejection Index for a lane (origin → destination).
 * Hot ≥20%, Warm 8–20%, Cool <8%.
 * Fetches from GET /api/sonar/lane-signals?origin=X&destination=Y.
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
  votri: number;
  votriWoW: number;
  signal: "hot" | "warm" | "cool";
  timestamp: string;
  isStale: boolean;
}

interface VotriBadgeProps {
  origin: string;
  destination: string;
  showTooltip?: boolean;
  className?: string;
  testId?: string;
}

const SIGNAL_STYLES = {
  hot:  "border-red-500/60 text-red-400 bg-red-500/10",
  warm: "border-amber-500/50 text-amber-400 bg-amber-500/10",
  cool: "border-green-500/50 text-green-400 bg-green-500/10",
};

const SIGNAL_LABELS = {
  hot:  "🔴 Hot",
  warm: "🟡 Warm",
  cool: "🟢 Cool",
};

export function VotriBadge({ origin, destination, showTooltip = true, className = "", testId }: VotriBadgeProps) {
  const { data, isLoading } = useQuery<{ signal: LaneVotri | null }>({
    queryKey: ["/api/sonar/lane-signals", origin, destination],
    queryFn: () =>
      fetch(`/api/sonar/lane-signals?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`)
        .then(r => r.ok ? r.json() : { signal: null }),
    staleTime: 4 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: !!(origin && destination),
  });

  if (isLoading) {
    return <Skeleton className="h-4 w-12 rounded-full" />;
  }

  const signal = data?.signal;
  if (!signal) return null;

  const badge = (
    <Badge
      variant="outline"
      className={`text-[10px] py-0 px-1.5 gap-0.5 ${SIGNAL_STYLES[signal.signal]} ${className}`}
      data-testid={testId ?? `badge-votri-${origin}-${destination}`}
    >
      <Radio className="w-2.5 h-2.5" />
      VOTRI {signal.votri.toFixed(0)}%
      {signal.signal !== "cool" && (
        <span className="ml-0.5 opacity-75">
          {signal.votriWoW > 0 ? "▲" : signal.votriWoW < 0 ? "▼" : ""}
        </span>
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
            signal.signal === "hot" ? "text-red-400"
            : signal.signal === "warm" ? "text-amber-400"
            : "text-green-400"
          }`}>{SIGNAL_LABELS[signal.signal]}</span>
        </div>
        <div className="space-y-0.5 text-muted-foreground">
          <p>
            <span className="text-foreground font-medium">VOTRI: {signal.votri.toFixed(1)}%</span>
            {" "}— Van Outbound Tender Rejection Index
          </p>
          <p>
            Week-over-week: <span className={signal.votriWoW > 0 ? "text-red-400" : signal.votriWoW < 0 ? "text-green-400" : ""}>
              {signal.votriWoW > 0 ? "+" : ""}{signal.votriWoW.toFixed(1)} pp
            </span>
          </p>
        </div>
        <p className="text-[10px] leading-relaxed">
          {signal.signal === "hot"
            ? "Market is tight — carriers rejecting frequently. Capacity scarce, rates rising. Outreach to this lane is high-priority."
            : signal.signal === "warm"
            ? "Market is active — moderate rejection. Normal booking lead times. Monitor for tightening."
            : "Market is cool — carriers accepting freight. Good capacity and leverage for negotiating rates."}
        </p>
        {signal.isStale && (
          <p className="text-amber-400 text-[10px]">⚠ Data may be slightly delayed</p>
        )}
        <p className="text-[9px] text-muted-foreground/60">
          Source: FreightWaves Sonar · {signal.qualifier}
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

  const colorMap = { hot: "#ef4444", warm: "#f59e0b", cool: "#22c55e" };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0 cursor-help"
          style={{ background: colorMap[signal.signal] }}
          data-testid={testId ?? `dot-votri-${origin}-${destination}`}
        />
      </TooltipTrigger>
      <TooltipContent className="text-xs p-2">
        <span className="font-semibold">{origin} → {destination}</span>
        <br />
        VOTRI {signal.votri.toFixed(1)}% — {SIGNAL_LABELS[signal.signal]}
        {signal.votriWoW !== 0 && ` (${signal.votriWoW > 0 ? "+" : ""}${signal.votriWoW.toFixed(1)} pp WoW)`}
      </TooltipContent>
    </Tooltip>
  );
}
