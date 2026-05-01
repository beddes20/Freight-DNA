/**
 * Evidence chip — Task #926 step 9.
 *
 * Renders a single evidence reference as a clickable chip. Hover reveals
 * the full label; clicking opens the linked entity (lane, scorecard,
 * carrier, etc) when an `href` is present.
 */
import { Link } from "wouter";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, FileText, BarChart3, Truck, TrendingUp, Hash } from "lucide-react";

export interface Evidence {
  kind: string;
  id?: string;
  label: string;
  value?: string | number;
  href?: string;
  updatedAt?: string;
}

const ICON_BY_KIND: Record<string, typeof FileText> = {
  lane_rate_history: TrendingUp,
  recurring_lane: Hash,
  carrier_scorecard_fact: Truck,
  account_growth_score: BarChart3,
};

export function EvidenceChip({ evidence }: { evidence: Evidence }) {
  const Icon = ICON_BY_KIND[evidence.kind] ?? FileText;
  const inner = (
    <Badge
      variant="outline"
      className="font-normal text-xs gap-1 cursor-help hover:bg-accent"
      data-testid={`chip-evidence-${evidence.kind}-${evidence.id ?? "nodisp"}`}
    >
      <Icon className="h-3 w-3" />
      <span className="truncate max-w-[18rem]">{evidence.label}</span>
      {evidence.href ? <ExternalLink className="h-3 w-3 opacity-60" /> : null}
    </Badge>
  );
  const wrapped = evidence.href ? (
    <Link href={evidence.href} className="no-underline">
      {inner}
    </Link>
  ) : inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{wrapped}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="font-medium">{evidence.kind.replace(/_/g, " ")}</div>
        <div>{evidence.label}</div>
        {evidence.updatedAt ? <div className="text-muted-foreground">{evidence.updatedAt}</div> : null}
      </TooltipContent>
    </Tooltip>
  );
}
