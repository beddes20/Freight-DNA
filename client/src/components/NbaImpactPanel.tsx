import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, CheckCircle2, DollarSign, ChevronRight, ChevronDown, Activity } from "lucide-react";

export interface NbaImpactSummary {
  daysBack: number;
  fired: number;
  viewed: number;
  actioned: number;
  dismissed: number;
  snoozed: number;
  expired: number;
  conversionRate: number;
  outcomesWorked: number;
  outcomesNoResponse: number;
  dollarMoved: number;
  byRule: Array<{
    ruleType: string;
    fired: number;
    actioned: number;
    conversionRate: number;
    worked: number;
    dollarMoved: number;
  }>;
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

const RULE_LABEL: Record<string, string> = {
  stale_account: "Stale account",
  single_thread_risk: "Single-thread risk",
  recurring_lane_capacity: "Recurring lane capacity",
  missed_inbound_call: "Missed inbound call",
  relationship_decay: "Relationship decay",
  commitment_overdue: "Overdue commitment",
};

function fmt$(v: number): string {
  if (!v) return "$0";
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 100) / 10}k`;
  return `$${Math.round(v)}`;
}

export function NbaImpactPanel({ collapsed, onToggle }: Props) {
  const { data, isLoading } = useQuery<NbaImpactSummary>({
    queryKey: ["/api/nba/my-impact"],
  });

  return (
    <Card data-testid="nba-impact-panel">
      <CardHeader className="pb-3">
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-2 hover:opacity-80 transition-opacity"
          data-testid="button-toggle-nba-impact"
        >
          {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-amber-500" />
            Your NBA impact
          </CardTitle>
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {data ? "this month" : ""}
          </span>
        </button>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-16 w-full" /></div>
          ) : !data || data.fired === 0 ? (
            <p className="text-sm text-muted-foreground py-3" data-testid="text-nba-impact-empty">
              No NBAs fired for you this month.
            </p>
          ) : (
            <div className="space-y-3">
              {/* Top metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-md border p-2" data-testid="metric-fired">
                  <div className="text-xs text-muted-foreground">Fired</div>
                  <div className="text-lg font-bold">{data.fired}</div>
                  <div className="text-[10px] text-muted-foreground">{data.viewed} viewed</div>
                </div>
                <div className="rounded-md border p-2" data-testid="metric-conversion">
                  <div className="text-xs text-muted-foreground">Conversion</div>
                  <div className="text-lg font-bold flex items-center gap-1">
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                    {Math.round(data.conversionRate * 100)}%
                  </div>
                  <div className="text-[10px] text-muted-foreground">{data.actioned} actioned</div>
                </div>
                <div className="rounded-md border p-2" data-testid="metric-worked">
                  <div className="text-xs text-muted-foreground">Worked</div>
                  <div className="text-lg font-bold flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    {data.outcomesWorked}
                  </div>
                  <div className="text-[10px] text-muted-foreground">{data.outcomesNoResponse} no response</div>
                </div>
                <div className="rounded-md border p-2" data-testid="metric-dollar-moved">
                  <div className="text-xs text-muted-foreground">$ moved</div>
                  <div className="text-lg font-bold flex items-center gap-1">
                    <DollarSign className="h-3.5 w-3.5 text-emerald-500" />
                    {fmt$(data.dollarMoved)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">attributed</div>
                </div>
              </div>

              {/* Per-rule conversion */}
              {data.byRule.length > 0 && (
                <div className="border rounded-md">
                  <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b">
                    Per-rule conversion
                  </div>
                  <div className="divide-y">
                    {data.byRule.map(r => (
                      <div key={r.ruleType} className="flex items-center gap-2 px-3 py-2 text-sm" data-testid={`row-rule-${r.ruleType}`}>
                        <span className="flex-1 truncate">{RULE_LABEL[r.ruleType] ?? r.ruleType}</span>
                        <Badge variant="outline" className="text-[10px]">{r.fired} fired</Badge>
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold w-12 text-right">
                          {Math.round(r.conversionRate * 100)}%
                        </span>
                        <span className="text-muted-foreground w-16 text-right text-xs">{fmt$(r.dollarMoved)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
