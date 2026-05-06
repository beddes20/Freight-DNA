import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ChevronDown, TrendingUp, DollarSign } from "lucide-react";

interface RulePerf {
  ruleType: string;
  firedCount: number;
  shownCount: number;
  actionedCount: number;
  classifiedCount: number;
  workedCount: number;
  partialCount: number;
  noResponseCount: number;
  outcomeRate: number;
  dollarMoved: number;
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

const RULE_LABEL: Record<string, string> = {
  stale_account: "Stale account",
  single_thread_risk: "Single-thread",
  recurring_lane_capacity: "Lane capacity",
  missed_inbound_call: "Missed call",
  relationship_decay: "Relationship",
  commitment_overdue: "Overdue commit",
};

function fmt$(v: number): string {
  if (!v) return "$0";
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 100) / 10}k`;
  return `$${Math.round(v)}`;
}

export function NbaRulePerformancePanel({ collapsed, onToggle }: Props) {
  const { data, isLoading } = useQuery<RulePerf[]>({
    queryKey: ["/api/nba/rule-performance"],
  });

  return (
    <Card data-testid="nba-rule-performance-panel">
      <CardHeader className="pb-3">
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-2 hover:opacity-80 transition-opacity"
          data-testid="button-toggle-nba-rule-perf"
        >
          {collapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-indigo-500" />
            NBA rule performance (engine learning)
          </CardTitle>
        </button>
      </CardHeader>
      {!collapsed && (
        <CardContent className="pt-0">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-muted-foreground py-3" data-testid="text-rule-perf-empty">
              No NBA rule activity yet.
            </p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <div className="grid grid-cols-[1fr_60px_70px_80px_70px_80px] gap-2 px-3 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide bg-muted/40">
                <div>Rule</div>
                <div className="text-right">Fired</div>
                <div className="text-right">Action%</div>
                <div className="text-right">Outcome%</div>
                <div className="text-right">Worked</div>
                <div className="text-right">$ moved</div>
              </div>
              <div className="divide-y">
                {data.map(r => (
                  <div
                    key={r.ruleType}
                    className="grid grid-cols-[1fr_60px_70px_80px_70px_80px] gap-2 px-3 py-2 text-sm items-center"
                    data-testid={`row-rule-${r.ruleType}`}
                  >
                    <span className="truncate">
                      <Badge variant="outline" className="text-[10px] mr-1">{RULE_LABEL[r.ruleType] ?? r.ruleType}</Badge>
                    </span>
                    <span className="text-right font-medium" data-testid={`rule-fired-${r.ruleType}`}>{r.firedCount}</span>
                    <span className="text-right" data-testid={`rule-action-rate-${r.ruleType}`}>
                      {r.firedCount > 0 ? `${Math.round((r.actionedCount / r.firedCount) * 100)}%` : "—"}
                    </span>
                    <span className="text-right" data-testid={`rule-outcome-rate-${r.ruleType}`}>
                      {r.classifiedCount > 0 ? `${Math.round(r.outcomeRate * 100)}%` : "—"}
                    </span>
                    <span className="text-right text-muted-foreground text-xs">
                      {r.workedCount}/{r.classifiedCount}
                    </span>
                    <span className="text-right font-semibold text-emerald-600 dark:text-emerald-400 text-xs flex items-center justify-end gap-0.5">
                      <DollarSign className="h-3 w-3" />{fmt$(r.dollarMoved).replace("$", "")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
