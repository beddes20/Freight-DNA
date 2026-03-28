import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import {
  TrendingUp, Users, Trophy, AlertCircle, Target,
  ArrowRight, BarChart2, Clock, Flame,
} from "lucide-react";
import {
  PROSPECT_STAGE_LABELS,
  PROSPECT_LOST_REASON_LABELS,
  type ProspectStage,
} from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

type AnalyticsData = {
  stageCounts: Record<string, number>;
  stageWeightedValues: Record<string, number>;
  stageTotalSpends: Record<string, number>;
  avgDaysInStage: Record<string, number>;
  lostReasonCounts: Record<string, number>;
  winRate: number;
  converted: number;
  totalClosed: number;
  totalWeighted: number;
  totalProspects: number;
  repStats: {
    ownerId: string;
    ownerName: string;
    prospectsOwned: number;
    activitiesLast30d: number;
    avgDealAge: number;
    conversionRate: number;
    converted: number;
  }[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ACTIVE_STAGES: ProspectStage[] = [
  "new_lead", "intro_scheduled", "intro_completed",
  "follow_up", "opportunity_sent", "first_load_won",
];

const STAGE_COLORS: Record<string, string> = {
  new_lead:         "bg-slate-400",
  intro_scheduled:  "bg-blue-400",
  intro_completed:  "bg-indigo-400",
  follow_up:        "bg-amber-400",
  opportunity_sent: "bg-orange-400",
  first_load_won:   "bg-emerald-500",
};

const STAGE_TEXT_COLORS: Record<string, string> = {
  new_lead:         "text-slate-600 dark:text-slate-400",
  intro_scheduled:  "text-blue-600 dark:text-blue-400",
  intro_completed:  "text-indigo-600 dark:text-indigo-400",
  follow_up:        "text-amber-600 dark:text-amber-400",
  opportunity_sent: "text-orange-600 dark:text-orange-400",
  first_load_won:   "text-emerald-600 dark:text-emerald-400",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function BarChart({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PipelineAnalyticsPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();

  const { data, isLoading, error } = useQuery<AnalyticsData>({
    queryKey: ["/api/prospects/analytics"],
    queryFn: async () => {
      const res = await fetch("/api/prospects/analytics", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (!user || !["admin", "sales_director"].includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="text-muted-foreground">Access restricted to sales directors and admins.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-80" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-muted-foreground">Failed to load analytics. Please try again.</p>
      </div>
    );
  }

  const activeStageCounts = ACTIVE_STAGES.map(s => data.stageCounts[s] ?? 0);
  const totalActive = activeStageCounts.reduce((a, b) => a + b, 0);
  const maxStageCount = Math.max(...activeStageCounts, 1);

  const totalLost = Object.values(data.lostReasonCounts).reduce((a, b) => a + b, 0);
  const maxLostReason = Math.max(...Object.values(data.lostReasonCounts), 1);

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto" data-testid="page-pipeline-analytics">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <BarChart2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            Pipeline Analytics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            All-time pipeline health, stage velocity, and rep performance.
          </p>
        </div>
        <button
          onClick={() => navigate("/prospects")}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          data-testid="link-back-to-pipeline"
        >
          ← Sales Pipeline
        </button>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="section-kpi-cards">
        <Card className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Prospects</p>
          <p className="text-3xl font-bold text-foreground" data-testid="kpi-total-prospects">{data.totalProspects}</p>
          <p className="text-xs text-muted-foreground">{totalActive} active</p>
        </Card>
        <Card className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Weighted Pipeline</p>
          <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400" data-testid="kpi-weighted-pipeline">
            {formatCurrency(data.totalWeighted)}
          </p>
          <p className="text-xs text-muted-foreground">active deals × probability</p>
        </Card>
        <Card className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Win Rate</p>
          <p className="text-3xl font-bold text-blue-600 dark:text-blue-400" data-testid="kpi-win-rate">{data.winRate}%</p>
          <p className="text-xs text-muted-foreground">{data.converted} converted · {data.totalClosed} closed</p>
        </Card>
        <Card className="p-4 space-y-1">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Sales Reps</p>
          <p className="text-3xl font-bold text-foreground" data-testid="kpi-rep-count">{data.repStats.length}</p>
          <p className="text-xs text-muted-foreground">with pipeline activity</p>
        </Card>
      </div>

      {/* ── Funnel + Pipeline Value ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Funnel */}
        <Card className="p-5 space-y-4" data-testid="section-funnel">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Pipeline Funnel</h2>
            <span className="text-xs text-muted-foreground ml-auto">{totalActive} active prospects</span>
          </div>
          <div className="space-y-3">
            {ACTIVE_STAGES.map((stage, i) => {
              const count = data.stageCounts[stage] ?? 0;
              const pct = totalActive > 0 ? Math.round((count / totalActive) * 100) : 0;
              const prevCount = i > 0 ? (data.stageCounts[ACTIVE_STAGES[i - 1]] ?? 0) : null;
              const convRate = prevCount != null && prevCount > 0
                ? Math.round((count / prevCount) * 100)
                : null;

              return (
                <div key={stage} className="space-y-1" data-testid={`funnel-row-${stage}`}>
                  {i > 0 && convRate !== null && (
                    <div className="flex items-center gap-1 pl-1 text-xs text-muted-foreground">
                      <ArrowRight className="h-3 w-3 shrink-0" />
                      <span>{convRate}% carried forward</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-medium w-36 shrink-0 ${STAGE_TEXT_COLORS[stage]}`}>
                      {PROSPECT_STAGE_LABELS[stage]}
                    </span>
                    <div className="flex-1">
                      <BarChart value={count} max={maxStageCount} color={STAGE_COLORS[stage]} />
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 w-14 justify-end">
                      <span className="text-sm font-semibold text-foreground">{count}</span>
                      <span className="text-xs text-muted-foreground">({pct}%)</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Pipeline Value by Stage */}
        <Card className="p-5 space-y-4" data-testid="section-pipeline-value">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Pipeline Value by Stage</h2>
          </div>
          <div className="space-y-2.5">
            {ACTIVE_STAGES.map(stage => {
              const raw = data.stageTotalSpends[stage] ?? 0;
              const weighted = data.stageWeightedValues[stage] ?? 0;
              const count = data.stageCounts[stage] ?? 0;
              if (count === 0 && raw === 0) return null;
              return (
                <div key={stage} className="flex items-center gap-3" data-testid={`value-row-${stage}`}>
                  <span className={`text-xs font-medium w-36 shrink-0 ${STAGE_TEXT_COLORS[stage]}`}>
                    {PROSPECT_STAGE_LABELS[stage]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-sm font-semibold text-foreground">{formatCurrency(weighted)}</span>
                      <span className="text-xs text-muted-foreground">weighted</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{formatCurrency(raw)} raw · {count} deal{count !== 1 ? "s" : ""}</div>
                  </div>
                </div>
              );
            }).filter(Boolean)}
          </div>
          <div className="border-t pt-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Total Weighted</span>
            <span className="text-base font-bold text-emerald-600 dark:text-emerald-400">
              {formatCurrency(data.totalWeighted)}
            </span>
          </div>
        </Card>
      </div>

      {/* ── Stage Velocity + Win/Loss ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Stage Velocity */}
        <Card className="p-5 space-y-4" data-testid="section-velocity">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Stage Velocity</h2>
            <span className="text-xs text-muted-foreground ml-auto">Days stuck in stage</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Stage</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Deals</th>
                  <th className="text-right py-2 text-xs font-medium text-muted-foreground">Days in Current Stage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {ACTIVE_STAGES.map(stage => {
                  const count = data.stageCounts[stage] ?? 0;
                  const avgDays = data.avgDaysInStage[stage] ?? 0;
                  const isBottleneck = avgDays > 30 && count > 0;
                  return (
                    <tr key={stage} data-testid={`velocity-row-${stage}`}>
                      <td className={`py-2.5 pr-4 font-medium text-xs ${STAGE_TEXT_COLORS[stage]}`}>
                        {PROSPECT_STAGE_LABELS[stage]}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-muted-foreground">{count}</td>
                      <td className="py-2.5 text-right">
                        {count > 0 ? (
                          <span className={`inline-flex items-center gap-1 font-semibold ${isBottleneck ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                            {isBottleneck && <Flame className="h-3 w-3" />}
                            {avgDays}d
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Measured from last stage transition.{" "}
            <Flame className="h-3 w-3 inline text-amber-500 mx-0.5" />
            Amber = bottleneck (&gt;30 days in current stage)
          </p>
        </Card>

        {/* Win / Loss Breakdown */}
        <Card className="p-5 space-y-4" data-testid="section-win-loss">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Win / Loss Breakdown</h2>
          </div>

          {/* Win Rate Banner */}
          <div className="rounded-lg bg-muted/50 p-3 flex items-center gap-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400" data-testid="win-rate-badge">{data.winRate}%</p>
              <p className="text-xs text-muted-foreground">Win Rate</p>
            </div>
            <div className="flex-1 grid grid-cols-2 gap-2 text-center text-sm">
              <div>
                <p className="font-semibold text-foreground">{data.converted}</p>
                <p className="text-xs text-muted-foreground">Won</p>
              </div>
              <div>
                <p className="font-semibold text-foreground">{data.totalClosed - data.converted}</p>
                <p className="text-xs text-muted-foreground">Lost / DQ'd</p>
              </div>
            </div>
          </div>

          {/* Lost Reasons */}
          {totalLost > 0 ? (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lost Reasons</p>
              {Object.entries(data.lostReasonCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([reason, count]) => {
                  const pct = Math.round((count / totalLost) * 100);
                  return (
                    <div key={reason} className="space-y-1" data-testid={`lost-reason-row-${reason}`}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {(PROSPECT_LOST_REASON_LABELS as Record<string, string>)[reason] ?? reason}
                        </span>
                        <span className="font-medium text-foreground">{count} ({pct}%)</span>
                      </div>
                      <BarChart value={count} max={maxLostReason} color="bg-red-400" />
                    </div>
                  );
                })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No closed deals yet.</p>
          )}
        </Card>
      </div>

      {/* ── Rep Leaderboard ── */}
      {data.repStats.length > 0 && (
        <Card className="p-5 space-y-4" data-testid="section-rep-leaderboard">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Rep Leaderboard</h2>
            <Badge variant="outline" className="ml-auto text-xs">Last 30d activities</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Rep</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Pipeline</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Activities (30d)</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Avg Age</th>
                  <th className="text-right py-2 text-xs font-medium text-muted-foreground">Win Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.repStats.map((rep, i) => (
                  <tr key={rep.ownerId} data-testid={`rep-row-${rep.ownerId}`}>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        {i === 0 && <Trophy className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                        <span className="font-medium text-foreground">{rep.ownerName}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <span className="font-semibold text-foreground">{rep.prospectsOwned}</span>
                      {rep.converted > 0 && (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 ml-1">+{rep.converted} won</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <span className={`font-semibold ${rep.activitiesLast30d === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                        {rep.activitiesLast30d}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right text-muted-foreground">
                      {rep.avgDealAge > 0 ? `${rep.avgDealAge}d` : "—"}
                    </td>
                    <td className="py-3 text-right">
                      {rep.converted > 0 || (rep.prospectsOwned - rep.converted) > 0 ? (
                        <Badge
                          variant="outline"
                          className={`text-xs ${rep.conversionRate >= 50 ? "border-emerald-500 text-emerald-600 dark:text-emerald-400" : rep.conversionRate > 0 ? "border-amber-500 text-amber-600 dark:text-amber-400" : "border-border text-muted-foreground"}`}
                        >
                          {rep.conversionRate}%
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
