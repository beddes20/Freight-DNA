/**
 * Task #701 — Tiny "degraded" pill that any rate / email / contact widget
 * can drop into its header. Reads `/api/integrations/health/:source` and
 * renders nothing while healthy/unknown so it has zero visual cost when
 * everything is fine.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle } from "lucide-react";

interface Props {
  source: "sonar" | "graph" | "webex" | "zoominfo" | "onedrive" | "trac" | "stripe";
  label?: string;
}

interface Snapshot {
  source: string;
  healthState: "healthy" | "degraded" | "unknown" | "disabled";
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
}

export function IntegrationDegradedPill({ source, label }: Props) {
  const { data } = useQuery<Snapshot>({
    queryKey: ["/api/integrations/health", source],
    queryFn: async () => {
      const r = await fetch(`/api/integrations/health/${source}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (!data || data.healthState !== "degraded") return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/40 gap-1 cursor-help"
            data-testid={`pill-degraded-${source}`}
          >
            <AlertTriangle className="h-3 w-3" />
            {label ?? source} degraded
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-xs max-w-xs">
            <p className="font-semibold">{label ?? source} is responding slowly or failing.</p>
            {data.lastErrorMessage && <p className="mt-1 text-muted-foreground break-words">{data.lastErrorMessage}</p>}
            <p className="mt-1 text-muted-foreground">Numbers shown may be stale.</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
