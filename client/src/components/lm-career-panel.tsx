import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import {
  Package, DollarSign, TrendingUp, CheckCircle2, Circle,
  GraduationCap, ChevronRight, Target, Truck, RefreshCw,
} from "lucide-react";

type Milestone = { id: string; text: string; completed: boolean };

type CarrierMetrics = {
  totalLoads: number;
  uniqueCarriers: number;
  repeatCarrierLoads: number;
  repeatPct: number;
  preferredCarriers: number;
  topCarriers: { carrier: string; loads: number; isRepeat: boolean }[];
  curMonthKey?: string;
};

function fmtMoney(n: number) {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export function LmCareerPanel() {
  const { user } = useAuth();
  const { toast } = useToast();

  const { data: accountSummary = [] } = useQuery<any[]>({
    queryKey: ["/api/financials/account-summary", "current"],
    queryFn: async () => {
      const res = await fetch("/api/financials/account-summary?period=current", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: dispatcherSummary = [] } = useQuery<any[]>({
    queryKey: ["/api/financials/dispatcher-summary", "current"],
    queryFn: async () => {
      const res = await fetch("/api/financials/dispatcher-summary?period=current", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: carrierMetrics, isLoading: carrierLoading } = useQuery<CarrierMetrics>({
    queryKey: ["/api/dashboard/lm-carrier-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/lm-carrier-metrics", { credentials: "include" });
      if (!res.ok) return { totalLoads: 0, uniqueCarriers: 0, repeatCarrierLoads: 0, repeatPct: 0, preferredCarriers: 0, topCarriers: [] };
      return res.json();
    },
    refetchInterval: 120000,
  });

  const { data: criteria = [] } = useQuery<any[]>({
    queryKey: ["/api/promotion/criteria"],
  });

  const { data: milestonesData, isLoading: milestonesLoading } = useQuery<{ milestones: Milestone[] }>({
    queryKey: ["/api/lm-milestones", user?.id],
    queryFn: async () => {
      const res = await fetch(`/api/lm-milestones/${user?.id}`, { credentials: "include" });
      if (!res.ok) return { milestones: [] };
      return res.json();
    },
    enabled: !!user?.id,
  });

  const milestones = milestonesData?.milestones || [];

  const saveMilestones = useMutation({
    mutationFn: (updated: Milestone[]) =>
      apiRequest("PUT", `/api/lm-milestones/${user?.id}`, { milestones: updated }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/lm-milestones", user?.id] }),
    onError: () => toast({ variant: "destructive", description: "Failed to save milestone update." }),
  });

  function toggleMilestone(id: string) {
    const updated = milestones.map(m => m.id === id ? { ...m, completed: !m.completed } : m);
    saveMilestones.mutate(updated);
  }

  const financialRepId = (user as any)?.financialRepId;

  const salespersonStats = (accountSummary as any[])
    .filter(row => row.salespersonId === financialRepId)
    .reduce((acc: any, row: any) => ({
      loads: acc.loads + (row.totalLoads || 0),
      margin: acc.margin + (row.totalMargin || 0),
      revenue: acc.revenue + (row.totalRevenue || 0),
    }), { loads: 0, margin: 0, revenue: 0 });

  const dispatcherRow = (dispatcherSummary as any[]).find(
    d => financialRepId && d.dispatcherName?.toLowerCase().includes(financialRepId.toLowerCase())
  );
  const dispatcherStats = dispatcherRow
    ? { loads: dispatcherRow.totalLoads, margin: dispatcherRow.totalMargin, revenue: dispatcherRow.totalRevenue }
    : null;

  const stats = salespersonStats.loads > 0 ? salespersonStats : (dispatcherStats ?? { loads: 0, margin: 0, revenue: 0 });
  const marginPct = stats.revenue > 0 ? (stats.margin / stats.revenue) * 100 : 0;

  const lmCriteria = criteria.filter((c: any) => c.fromRole === "logistics_manager" || c.toRole === "account_manager");
  const criteriaToUse = lmCriteria.length > 0 ? lmCriteria : criteria.filter((c: any) => c.fromRole === "account_manager");

  const completedMilestones = milestones.filter(m => m.completed).length;
  const totalMilestones = milestones.length;

  const repeatPct = carrierMetrics?.repeatPct ?? 0;
  const preferredCarriers = carrierMetrics?.preferredCarriers ?? 0;
  const topCarriers = carrierMetrics?.topCarriers ?? [];

  if (!user) return null;

  return (
    <div className="space-y-4">
      {/* Operational Stats Row — 4 cards */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {[
          { label: "Loads This Month", value: stats.loads.toLocaleString(), icon: Truck, color: "text-blue-500", bg: "bg-blue-50 dark:bg-blue-950/40", testId: "loads-this-month" },
          { label: "Margin This Month", value: fmtMoney(stats.margin), icon: DollarSign, color: "text-green-500", bg: "bg-green-50 dark:bg-green-950/40", testId: "margin-this-month" },
          { label: "Margin %", value: `${marginPct.toFixed(1)}%`, icon: TrendingUp, color: "text-amber-500", bg: "bg-amber-50 dark:bg-amber-950/40", testId: "margin-pct" },
          {
            label: "Repeat Carrier Rate",
            value: carrierLoading ? "—" : `${repeatPct.toFixed(1)}%`,
            subValue: carrierLoading ? null : `${preferredCarriers} preferred`,
            icon: RefreshCw,
            color: repeatPct >= 50 ? "text-green-500" : repeatPct >= 25 ? "text-amber-500" : "text-red-500",
            bg: repeatPct >= 50 ? "bg-green-50 dark:bg-green-950/40" : repeatPct >= 25 ? "bg-amber-50 dark:bg-amber-950/40" : "bg-red-50 dark:bg-red-950/40",
            testId: "repeat-carrier-rate",
          },
        ].map(stat => (
          <Card key={stat.label} className="overflow-hidden">
            <CardContent className="p-4">
              <div className="flex flex-col gap-2">
                <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${stat.bg}`}>
                  <stat.icon className={`h-4 w-4 ${stat.color}`} />
                </div>
                <div className="text-xl font-bold" data-testid={`text-lm-stat-${stat.testId}`}>
                  {stat.value}
                </div>
                {'subValue' in stat && stat.subValue && (
                  <p className="text-xs text-muted-foreground -mt-1">{stat.subValue}</p>
                )}
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {/* Path to AM — Promotion Criteria */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <GraduationCap className="h-4 w-4 text-amber-500" />
              Path to Account Manager
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {criteriaToUse.length === 0 ? (
              <p className="text-xs text-muted-foreground">No promotion criteria set yet. Ask your manager to configure them.</p>
            ) : (
              criteriaToUse.map((c: any) => {
                const loadPass = c.minLoadCount ? stats.loads >= c.minLoadCount : null;
                const marginPass = c.minMarginPct ? marginPct >= parseFloat(c.minMarginPct) : null;
                return (
                  <div key={c.id} className="space-y-2">
                    {c.minLoadCount != null && (
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className={`shrink-0 h-5 w-5 rounded-full flex items-center justify-center ${loadPass ? "bg-green-100 dark:bg-green-950/40" : "bg-muted"}`}>
                            {loadPass
                              ? <CheckCircle2 className="h-3 w-3 text-green-600" />
                              : <Circle className="h-3 w-3 text-muted-foreground" />
                            }
                          </div>
                          <span className="text-xs truncate">Min {c.minLoadCount} loads/month</span>
                        </div>
                        <Badge variant={loadPass ? "default" : "secondary"} className="shrink-0 text-xs">
                          {stats.loads} / {c.minLoadCount}
                        </Badge>
                      </div>
                    )}
                    {c.minMarginPct != null && (
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <div className={`shrink-0 h-5 w-5 rounded-full flex items-center justify-center ${marginPass ? "bg-green-100 dark:bg-green-950/40" : "bg-muted"}`}>
                            {marginPass
                              ? <CheckCircle2 className="h-3 w-3 text-green-600" />
                              : <Circle className="h-3 w-3 text-muted-foreground" />
                            }
                          </div>
                          <span className="text-xs truncate">Min {parseFloat(c.minMarginPct).toFixed(1)}% margin</span>
                        </div>
                        <Badge variant={marginPass ? "default" : "secondary"} className="shrink-0 text-xs">
                          {marginPct.toFixed(1)}% / {parseFloat(c.minMarginPct).toFixed(1)}%
                        </Badge>
                      </div>
                    )}
                    {c.notes && (
                      <p className="text-xs text-muted-foreground pl-7">{c.notes}</p>
                    )}
                  </div>
                );
              })
            )}
            <Link href="/report/me">
              <Button variant="outline" size="sm" className="w-full mt-2 text-xs" data-testid="button-view-report-card">
                View Full Report Card
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Top Repeat Carriers */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-blue-500" />
              Top Carriers This Month
            </CardTitle>
          </CardHeader>
          <CardContent>
            {carrierLoading ? (
              <div className="space-y-2">
                {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : topCarriers.length === 0 ? (
              <p className="text-xs text-muted-foreground">No carrier data available for this month.</p>
            ) : (
              <div className="space-y-1.5">
                {topCarriers.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-2" data-testid={`carrier-row-${i}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                      <span className="text-xs truncate font-medium">{c.carrier}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs font-semibold tabular-nums">{c.loads}</span>
                      {c.isRepeat ? (
                        <Badge variant="secondary" className="text-xs px-1 py-0 h-4 text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-950/40 border-0">repeat</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs px-1 py-0 h-4 text-muted-foreground">1×</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Development Milestones */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Target className="h-4 w-4 text-blue-500" />
                My Development Milestones
              </CardTitle>
              {totalMilestones > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {completedMilestones}/{totalMilestones}
                </Badge>
              )}
            </div>
            {totalMilestones > 0 && (
              <Progress value={(completedMilestones / totalMilestones) * 100} className="h-1.5 mt-1" />
            )}
          </CardHeader>
          <CardContent>
            {milestonesLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
              </div>
            ) : milestones.length === 0 ? (
              <div className="py-4 text-center">
                <Target className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">No milestones set yet.</p>
                <p className="text-xs text-muted-foreground">Your manager will add development goals here.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {milestones.map(m => (
                  <button
                    key={m.id}
                    onClick={() => toggleMilestone(m.id)}
                    className="w-full flex items-start gap-2.5 text-left hover:bg-muted/50 rounded-md p-1.5 transition-colors group"
                    data-testid={`button-milestone-toggle-${m.id}`}
                    disabled={saveMilestones.isPending}
                  >
                    <div className={`shrink-0 mt-0.5 h-4 w-4 rounded-full border-2 flex items-center justify-center transition-colors ${m.completed ? "border-green-500 bg-green-500" : "border-muted-foreground/40 group-hover:border-primary"}`}>
                      {m.completed && <CheckCircle2 className="h-3 w-3 text-white" />}
                    </div>
                    <span className={`text-xs leading-relaxed ${m.completed ? "line-through text-muted-foreground" : ""}`}>
                      {m.text}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
