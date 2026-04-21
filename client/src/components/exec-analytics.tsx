import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp, TrendingDown, Minus, Users, Trophy, AlertCircle, Target,
  ArrowRight, BarChart2, Clock, Flame, Building2,
  Snowflake, UserCheck, DollarSign, Monitor, Smartphone, Phone, Headphones,
} from "lucide-react";
import {
  PROSPECT_STAGE_LABELS,
  PROSPECT_LOST_REASON_LABELS,
  type ProspectStage,
} from "@shared/schema";
import { CallQualityPanel } from "@/components/call-quality-scorecard";

// ─── Types ────────────────────────────────────────────────────────────────────

type RepBreakdown = { repId: string; repName: string; count: number };

type RepStat = {
  ownerId: string;
  ownerName: string;
  prospectsOwned: number;
  activitiesInRange: number;
  avgDealAge: number;
  conversionRate: number;
  converted: number;
};

type KpiGroup = { total: number; prevTotal: number; trend: number; byRep: RepBreakdown[] };

type ExecDashData = {
  prospecting: KpiGroup;
  dormant: KpiGroup;
  activeCustomers: KpiGroup;
  closedWonCFY: KpiGroup;
  closedWonRevByRepRange: { repName: string; amount: number }[];
  closedWonRevByRepCFY: { repName: string; amount: number }[];
  emailsToLeadsByRep: { repName: string; count: number }[];
  stageCounts: Record<string, number>;
  stageWeightedValues: Record<string, number>;
  stageTotalSpends: Record<string, number>;
  totalWeighted: number;
  avgDaysInStage: Record<string, number>;
  lostReasonCounts: Record<string, number>;
  winRate: number;
  converted: number;
  totalClosed: number;
  totalProspects: number;
  repStats: RepStat[];
  stageVelocity: { stage: string; avgDays: number; count: number }[];
  conversionByRep: { repName: string; rate: number; converted: number; total: number }[];
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

const DATE_RANGES = [
  { label: "This Month", value: "month" },
  { label: "Last Month", value: "last_month" },
  { label: "QTD", value: "qtd" },
  { label: "YTD", value: "ytd" },
] as const;
type DateRange = typeof DATE_RANGES[number]["value"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Mini donut chart (SVG) ───────────────────────────────────────────────────

const DONUT_COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1",
];

function DonutChart({ data, total }: { data: RepBreakdown[]; total: number }) {
  const size = 80;
  const cx = size / 2;
  const cy = size / 2;
  const r = 28;
  const innerR = 18;

  if (total === 0) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <div className="rounded-full bg-muted/40" style={{ width: r * 2, height: r * 2, border: "4px solid hsl(var(--muted))" }} />
      </div>
    );
  }

  let angle = -Math.PI / 2;
  const slices = data.slice(0, 8).map((item, i) => {
    const pct = item.count / total;
    const startAngle = angle;
    const endAngle = angle + pct * 2 * Math.PI;
    angle = endAngle;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const xi1 = cx + innerR * Math.cos(endAngle);
    const yi1 = cy + innerR * Math.sin(endAngle);
    const xi2 = cx + innerR * Math.cos(startAngle);
    const yi2 = cy + innerR * Math.sin(startAngle);

    const largeArc = pct > 0.5 ? 1 : 0;

    return (
      <path
        key={item.repId}
        d={`M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${xi1} ${yi1} A ${innerR} ${innerR} 0 ${largeArc} 0 ${xi2} ${yi2} Z`}
        fill={DONUT_COLORS[i % DONUT_COLORS.length]}
        opacity={0.9}
      />
    );
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices}
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fontSize="13" fontWeight="700" fill="currentColor" className="fill-foreground">
        {total}
      </text>
    </svg>
  );
}

// ─── KPI Card with donut ──────────────────────────────────────────────────────

function KpiCard({
  title,
  icon: Icon,
  iconColor,
  data,
  total,
  trend,
  trendLabel,
}: {
  title: string;
  icon: React.ElementType;
  iconColor: string;
  data: RepBreakdown[];
  total: number;
  trend: number;
  trendLabel: string;
}) {
  const isUp = trend > 0;
  const isDown = trend < 0;
  const trendColor = isUp ? "text-emerald-600 dark:text-emerald-400" : isDown ? "text-red-500 dark:text-red-400" : "text-muted-foreground";
  const trendSign = isUp ? "+" : "";

  return (
    <Card className="p-4 space-y-3" data-testid={`kpi-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</p>
      </div>
      <div className="flex items-center gap-4">
        <DonutChart data={data} total={total} />
        <div className="flex-1 space-y-1 min-w-0">
          {data.slice(0, 4).map((item, i) => (
            <div key={item.repId} className="flex items-center gap-1.5 text-xs min-w-0">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
              />
              <span className="truncate text-muted-foreground flex-1">{item.repName.split(" ")[0]}</span>
              <span className="font-semibold text-foreground shrink-0">{item.count}</span>
            </div>
          ))}
          {data.length > 4 && (
            <p className="text-[10px] text-muted-foreground">+{data.length - 4} more</p>
          )}
        </div>
      </div>
      {/* Trend indicator */}
      <div className={`flex items-center gap-1 text-xs ${trendColor}`} data-testid={`kpi-trend-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        {isUp ? <TrendingUp className="h-3 w-3" /> : isDown ? <TrendingDown className="h-3 w-3" /> : <Minus className="h-3 w-3" />}
        <span>{trendSign}{trend} vs {trendLabel}</span>
      </div>
    </Card>
  );
}

// ─── Horizontal Bar Chart ─────────────────────────────────────────────────────

function HorizontalBarChart({
  title,
  data,
  valueFormat = "number",
  color = "bg-emerald-500",
}: {
  title: string;
  data: { label: string; value: number }[];
  valueFormat?: "number" | "currency";
  color?: string;
}) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <Card className="p-4 space-y-3" data-testid={`bar-chart-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No data yet</p>
      ) : (
        <div className="space-y-2.5">
          {data.map(item => {
            const pct = max > 0 ? Math.max(4, (item.value / max) * 100) : 0;
            return (
              <div key={item.label} className="space-y-0.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate max-w-[60%]">{item.label}</span>
                  <span className="font-semibold text-foreground shrink-0 ml-2">
                    {valueFormat === "currency" ? formatCurrency(item.value) : item.value}
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${color}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─── Rep Personal Analytics (non-admin/director) ──────────────────────────────

type RepPersonalData = {
  accountsByStatus: { label: string; count: number }[];
  openOpportunityCount: number;
  openOpportunityValue: number;
  activityThisMonth: number;
  activityLastMonth: number;
  totalAccounts: number;
};

export function RepPersonalAnalytics() {
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery<RepPersonalData>({
    queryKey: ["/api/prospects/my-analytics"],
    queryFn: async () => {
      const res = await fetch("/api/prospects/my-analytics", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Failed to load personal analytics.</p>
      </div>
    );
  }

  const activityDelta = data.activityThisMonth - data.activityLastMonth;

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto" data-testid="section-rep-personal-analytics">
      <div>
        <h2 className="text-lg font-bold text-foreground">My Pipeline Overview</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Your accounts, opportunities, and activity this month.</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4 space-y-1" data-testid="kpi-my-accounts">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">My Accounts</p>
          <p className="text-2xl font-bold text-foreground">{data.totalAccounts}</p>
          <p className="text-xs text-muted-foreground">in pipeline</p>
        </Card>
        <Card className="p-4 space-y-1" data-testid="kpi-open-opportunities">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Open Opportunities</p>
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{data.openOpportunityCount}</p>
          {data.openOpportunityValue > 0 && (
            <p className="text-xs text-muted-foreground">{formatCurrency(data.openOpportunityValue)} est. value</p>
          )}
        </Card>
        <Card className="p-4 space-y-1" data-testid="kpi-activity-this-month">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Activities This Month</p>
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{data.activityThisMonth}</p>
          <p className="text-xs text-muted-foreground">
            {activityDelta >= 0 ? "+" : ""}{activityDelta} vs last month
          </p>
        </Card>
        <Card className="p-4 space-y-1" data-testid="kpi-activity-last-month">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Last Month</p>
          <p className="text-2xl font-bold text-foreground">{data.activityLastMonth}</p>
          <p className="text-xs text-muted-foreground">activities logged</p>
        </Card>
      </div>

      {/* Accounts by status */}
      <Card className="p-4 space-y-3" data-testid="section-accounts-by-status">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          My Accounts by Stage
        </p>
        {data.accountsByStatus.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts in your pipeline yet.</p>
        ) : (
          <div className="space-y-2.5">
            {data.accountsByStatus.map(row => {
              const pct = data.totalAccounts > 0 ? Math.max(4, (row.count / data.totalAccounts) * 100) : 0;
              return (
                <div key={row.label} className="space-y-0.5" data-testid={`status-row-${row.label}`}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="font-semibold text-foreground">{row.count}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Exec Dashboard ───────────────────────────────────────────────────────────

export function ExecAnalyticsDashboard() {
  const { user } = useAuth();
  const [dateRange, setDateRange] = useState<DateRange>("month");

  const { data, isLoading, error } = useQuery<ExecDashData>({
    queryKey: ["/api/prospects/exec-analytics", dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/exec-analytics?range=${dateRange}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (!user || !["admin", "sales_director"].includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground">Access restricted to sales directors and admins.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-36" />)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-64" /><Skeleton className="h-64" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-muted-foreground">Failed to load analytics. Please try again.</p>
      </div>
    );
  }

  const activeStageCounts = ACTIVE_STAGES.map(s => data.stageCounts[s] ?? 0);
  const totalActive = activeStageCounts.reduce((a, b) => a + b, 0);
  const maxStageCount = Math.max(...activeStageCounts, 1);
  const totalLost = Object.values(data.lostReasonCounts).reduce((a, b) => a + b, 0);

  const rangeLabel = DATE_RANGES.find(dr => dr.value === dateRange)?.label ?? "This Month";
  const prevRangeLabel = dateRange === "last_month" ? "month prior"
    : dateRange === "qtd" ? "prev quarter"
    : dateRange === "ytd" ? "YTD last year"
    : "last month";

  return (
    <div className="p-6 space-y-8 max-w-7xl mx-auto" data-testid="page-exec-analytics">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <BarChart2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            Executive Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Pipeline health, rep performance, and conversion metrics.</p>
        </div>
        {/* Date range filter */}
        <div className="flex items-center gap-1 border rounded-md overflow-hidden" data-testid="date-range-filter">
          {DATE_RANGES.map(dr => (
            <button
              key={dr.value}
              onClick={() => setDateRange(dr.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                dateRange === dr.value
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground"
              }`}
              data-testid={`date-range-${dr.value}`}
            >
              {dr.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="section-exec-kpi-cards">
        <KpiCard
          title="Prospecting Accounts"
          icon={Snowflake}
          iconColor="text-blue-500"
          data={data.prospecting.byRep}
          total={data.prospecting.total}
          trend={data.prospecting.trend}
          trendLabel={prevRangeLabel}
        />
        <KpiCard
          title="Dormant Accounts"
          icon={Clock}
          iconColor="text-amber-500"
          data={data.dormant.byRep}
          total={data.dormant.total}
          trend={data.dormant.trend}
          trendLabel={prevRangeLabel}
        />
        <KpiCard
          title="Active Customers"
          icon={UserCheck}
          iconColor="text-emerald-500"
          data={data.activeCustomers.byRep}
          total={data.activeCustomers.total}
          trend={data.activeCustomers.trend}
          trendLabel={prevRangeLabel}
        />
        <KpiCard
          title="Closed Won CFY"
          icon={Trophy}
          iconColor="text-amber-500"
          data={data.closedWonCFY.byRep}
          total={data.closedWonCFY.total}
          trend={data.closedWonCFY.trend}
          trendLabel="same date last year"
        />
      </div>

      {/* ── Revenue Charts ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <HorizontalBarChart
          title={`Closed Won Revenue by Rep — ${rangeLabel}`}
          data={(data.closedWonRevByRepRange ?? []).map(d => ({ label: d.repName, value: d.amount }))}
          valueFormat="currency"
          color="bg-emerald-500"
        />
        <HorizontalBarChart
          title="Closed Won Revenue by Rep — CFY"
          data={data.closedWonRevByRepCFY.map(d => ({ label: d.repName, value: d.amount }))}
          valueFormat="currency"
          color="bg-blue-500"
        />
      </div>

      {/* ── Activity + Funnel ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <HorizontalBarChart
          title={`Emails to Leads by Rep — ${rangeLabel}`}
          data={data.emailsToLeadsByRep.map(d => ({ label: d.repName, value: d.count }))}
          valueFormat="number"
          color="bg-violet-500"
        />

        {/* Pipeline Funnel */}
        <Card className="p-5 space-y-4" data-testid="section-exec-funnel">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm text-foreground">Opportunities by Stage</h2>
            <span className="text-xs text-muted-foreground ml-auto">{totalActive} active</span>
          </div>
          <div className="space-y-2.5">
            {ACTIVE_STAGES.map((stage, i) => {
              const count = data.stageCounts[stage] ?? 0;
              const pct = totalActive > 0 ? Math.round((count / totalActive) * 100) : 0;
              const prevCount = i > 0 ? (data.stageCounts[ACTIVE_STAGES[i - 1]] ?? 0) : null;
              const convRate = prevCount != null && prevCount > 0
                ? Math.round((count / prevCount) * 100) : null;
              return (
                <div key={stage} className="space-y-0.5" data-testid={`exec-funnel-row-${stage}`}>
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
                    <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${STAGE_COLORS[stage]}`}
                        style={{ width: `${maxStageCount > 0 ? Math.max(2, (count / maxStageCount) * 100) : 0}%` }}
                      />
                    </div>
                    <div className="flex items-center gap-1 shrink-0 w-14 justify-end">
                      <span className="text-sm font-semibold text-foreground">{count}</span>
                      <span className="text-xs text-muted-foreground">({pct}%)</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* ── Pipeline Value by Stage ── */}
      <Card className="p-5 space-y-4" data-testid="section-exec-pipeline-value">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold text-sm text-foreground">Pipeline Value by Stage</h2>
          {data.totalWeighted > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">
              {formatCurrency(data.totalWeighted)} total weighted
            </span>
          )}
        </div>
        {ACTIVE_STAGES.every(s => !data.stageCounts[s]) ? (
          <p className="text-sm text-muted-foreground text-center py-4">No active pipeline in this range.</p>
        ) : (
          <div className="space-y-2.5">
            {ACTIVE_STAGES.map(stage => {
              const raw = data.stageTotalSpends[stage] ?? 0;
              const weighted = data.stageWeightedValues[stage] ?? 0;
              const count = data.stageCounts[stage] ?? 0;
              if (count === 0 && raw === 0) return null;
              return (
                <div key={stage} className="flex items-center gap-3" data-testid={`exec-value-row-${stage}`}>
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
        )}
      </Card>

      {/* ── Stage Velocity + Conversion by Rep ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Stage Velocity */}
        <Card className="p-5 space-y-4" data-testid="section-exec-velocity">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm text-foreground">Stage Velocity</h2>
            <span className="text-xs text-muted-foreground ml-auto">Avg days per stage</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Stage</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Accounts</th>
                  <th className="text-right py-2 text-xs font-medium text-muted-foreground">Avg Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {ACTIVE_STAGES.map(stage => {
                  const count = data.stageCounts[stage] ?? 0;
                  const avgDays = data.avgDaysInStage[stage] ?? 0;
                  const isBottleneck = avgDays > 30 && count > 0;
                  return (
                    <tr key={stage} data-testid={`exec-velocity-row-${stage}`}>
                      <td className={`py-2.5 pr-4 font-medium text-xs ${STAGE_TEXT_COLORS[stage]}`}>
                        {PROSPECT_STAGE_LABELS[stage]}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-muted-foreground text-xs">{count}</td>
                      <td className="py-2.5 text-right text-xs">
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
            <Flame className="h-3 w-3 inline text-amber-500 mx-0.5" />
            Amber = bottleneck (&gt;30 days in current stage)
          </p>
        </Card>

        {/* Conversion Rate by Rep */}
        <Card className="p-5 space-y-4" data-testid="section-exec-conversion">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm text-foreground">Conversion Rate by Rep</h2>
            <span className="text-xs text-muted-foreground ml-auto">Prospect → Closed Won</span>
          </div>
          {data.repStats.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No rep data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Rep</th>
                    <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Accounts</th>
                    <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Won</th>
                    <th className="text-right py-2 text-xs font-medium text-muted-foreground">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.repStats.map((rep, i) => (
                    <tr key={rep.ownerId} data-testid={`exec-conv-row-${rep.ownerId}`}>
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-1.5">
                          {i === 0 && <Trophy className="h-3 w-3 text-amber-500 shrink-0" />}
                          <span className="text-xs font-medium text-foreground">{rep.ownerName}</span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4 text-right text-xs text-muted-foreground">{rep.prospectsOwned}</td>
                      <td className="py-2.5 pr-4 text-right text-xs text-emerald-600 dark:text-emerald-400 font-medium">{rep.converted}</td>
                      <td className="py-2.5 text-right">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${rep.conversionRate >= 50 ? "border-emerald-500 text-emerald-600 dark:text-emerald-400" : rep.conversionRate > 0 ? "border-amber-500 text-amber-600 dark:text-amber-400" : "border-border text-muted-foreground"}`}
                        >
                          {rep.conversionRate}%
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {/* ── Win / Loss Summary ── */}
      <Card className="p-5" data-testid="section-exec-win-loss">
        <div className="flex items-center gap-2 mb-4">
          <Trophy className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold text-sm text-foreground">Win / Loss Summary</h2>
          <span className="text-xs text-muted-foreground ml-auto">{rangeLabel}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-3 rounded-lg bg-muted/40">
            <p className="text-2xl font-bold text-foreground" data-testid="exec-win-rate">{data.winRate}%</p>
            <p className="text-xs text-muted-foreground">Win Rate</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/40">
            <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{data.converted}</p>
            <p className="text-xs text-muted-foreground">Converted</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/40">
            <p className="text-2xl font-bold text-foreground">{data.totalClosed - data.converted}</p>
            <p className="text-xs text-muted-foreground">Lost / DQ'd</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/40">
            <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{data.totalProspects}</p>
            <p className="text-xs text-muted-foreground">Total Prospects</p>
          </div>
        </div>

        {totalLost > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lost Reasons</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {Object.entries(data.lostReasonCounts).sort(([, a], [, b]) => b - a).map(([reason, count]) => (
                <div key={reason} className="flex items-center justify-between text-xs bg-muted/40 rounded px-2 py-1.5" data-testid={`exec-lost-reason-${reason}`}>
                  <span className="text-muted-foreground">
                    {(PROSPECT_LOST_REASON_LABELS as Record<string, string>)[reason] ?? reason}
                  </span>
                  <span className="font-semibold text-foreground ml-2">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* ── Admin-only: Webex Device Usage ── */}
      {user?.role === "admin" && <DeviceUsageAdminPanel />}

      {/* ── Rep Leaderboard ── */}
      {data.repStats.length > 0 && (
        <Card className="p-5 space-y-4" data-testid="section-exec-rep-leaderboard">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-semibold text-sm text-foreground">Rep Leaderboard</h2>
            <Badge variant="outline" className="ml-auto text-xs">{rangeLabel} activities</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Rep</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Accounts</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Activities</th>
                  <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Avg Age</th>
                  <th className="text-right py-2 text-xs font-medium text-muted-foreground">Win Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.repStats.map((rep, i) => (
                  <tr key={rep.ownerId} data-testid={`exec-rep-row-${rep.ownerId}`}>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        {i === 0 && <Trophy className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                        <span className="font-medium text-sm text-foreground">{rep.ownerName}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <span className="font-semibold text-foreground">{rep.prospectsOwned}</span>
                      {rep.converted > 0 && (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400 ml-1">+{rep.converted} won</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right">
                      <span className={`font-semibold ${rep.activitiesInRange === 0 ? "text-muted-foreground" : "text-foreground"}`}>
                        {rep.activitiesInRange}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right text-muted-foreground text-sm">
                      {rep.avgDealAge > 0 ? `${rep.avgDealAge}d` : "—"}
                    </td>
                    <td className="py-3 text-right">
                      {(rep.converted > 0 || rep.prospectsOwned > 0) ? (
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

      <CallQualityPanel />
    </div>
  );
}

// ─── Admin-only: Webex Device & Workspace Usage (Task #319) ──────────────────

type DeviceUsageRep = {
  userId: string;
  userName: string;
  webexDisplayName: string | null;
  totalCalls: number;
  deskAppCalls: number;
  mobileCalls: number;
  deskPhoneCalls: number;
  otherCalls: number;
  headsetCalls: number;
  lastCallAt: string | null;
};

type DeviceUsageDevice = {
  id: string;
  displayName: string;
  product: string | null;
  productType: string | null;
  type: string | null;
  mac: string | null;
  connectionStatus: string | null;
  lastUsedAt: string | null;
  daysSinceLastUse: number | null;
  unused: boolean;
  assignedUserId: string | null;
  assignedUserName: string | null;
  workspaceId?: string | null;
};

type DeviceUsageResponse = {
  days: number;
  totalCalls: number;
  truncated: boolean;
  perRep: DeviceUsageRep[];
  devices: DeviceUsageDevice[];
  managers: { id: string; name: string }[];
};

const USAGE_DAY_RANGES = [7, 14, 30, 60, 90] as const;

function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function relativeDays(days: number | null): string {
  if (days === null) return "Never";
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

export function DeviceUsageAdminPanel() {
  const [days, setDays] = useState<number>(30);
  const [managerId, setManagerId] = useState<string>("");

  const { data, isLoading, error, refetch, isFetching } = useQuery<DeviceUsageResponse>({
    queryKey: ["/api/webex/device-usage", days, managerId],
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days) });
      if (managerId) params.set("managerId", managerId);
      const res = await fetch(`/api/webex/device-usage?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Card className="p-5 space-y-4" data-testid="section-webex-device-usage">
      <div className="flex items-center gap-2 flex-wrap">
        <Monitor className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold text-sm text-foreground">Webex Device Usage</h2>
        <Badge variant="outline" className="text-[10px]">Admin only</Badge>
        <span className="text-xs text-muted-foreground ml-auto">
          Last {days} days · {data?.totalCalls ?? 0} calls
          {data?.truncated ? " (capped)" : ""}
        </span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 border rounded-md overflow-hidden" data-testid="device-usage-range-filter">
          {USAGE_DAY_RANGES.map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                days === d ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"
              }`}
              data-testid={`device-usage-range-${d}`}
            >
              {d}d
            </button>
          ))}
        </div>
        {data && data.managers.length > 0 && (
          <select
            value={managerId}
            onChange={(e) => setManagerId(e.target.value)}
            className="text-xs border rounded-md px-2 py-1.5 bg-background"
            data-testid="device-usage-team-filter"
          >
            <option value="">All teams</option>
            {data.managers.map(m => (
              <option key={m.id} value={m.id}>{m.name}'s team</option>
            ))}
          </select>
        )}
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-xs px-2 py-1.5 border rounded-md hover:bg-muted text-muted-foreground disabled:opacity-50"
          data-testid="button-device-usage-refresh"
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-32" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-destructive py-2" data-testid="device-usage-error">
          <AlertCircle className="h-4 w-4" />
          <span>{(error as Error).message || "Failed to load device usage."}</span>
        </div>
      ) : !data ? null : (
        <>
          {/* Per-rep breakdown */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Per-rep device mix
            </p>
            {data.perRep.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3" data-testid="device-usage-empty-reps">
                No attributed Webex calls in this window.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Rep</th>
                      <th className="text-right py-2 pr-3 text-xs font-medium text-muted-foreground">Calls</th>
                      <th className="text-right py-2 pr-3 text-xs font-medium text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Monitor className="h-3 w-3" />Desk App</span>
                      </th>
                      <th className="text-right py-2 pr-3 text-xs font-medium text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Smartphone className="h-3 w-3" />Mobile</span>
                      </th>
                      <th className="text-right py-2 pr-3 text-xs font-medium text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />Desk Phone</span>
                      </th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Headphones className="h-3 w-3" />Headset</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.perRep.map(rep => {
                      const headsetPct = pct(rep.headsetCalls, rep.totalCalls);
                      const headsetFlag = rep.totalCalls >= 10 && headsetPct < 30;
                      return (
                        <tr key={rep.userId} data-testid={`device-usage-rep-${rep.userId}`}>
                          <td className="py-2.5 pr-4">
                            <div className="text-xs font-medium text-foreground">{rep.userName}</div>
                            {rep.webexDisplayName && rep.webexDisplayName !== rep.userName && (
                              <div className="text-[10px] text-muted-foreground">{rep.webexDisplayName}</div>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-xs text-foreground tabular-nums">{rep.totalCalls}</td>
                          <td className="py-2.5 pr-3 text-right text-xs tabular-nums">
                            <span className="text-foreground">{pct(rep.deskAppCalls, rep.totalCalls)}%</span>
                            <span className="text-muted-foreground ml-1">({rep.deskAppCalls})</span>
                          </td>
                          <td className="py-2.5 pr-3 text-right text-xs tabular-nums">
                            <span className="text-foreground">{pct(rep.mobileCalls, rep.totalCalls)}%</span>
                            <span className="text-muted-foreground ml-1">({rep.mobileCalls})</span>
                          </td>
                          <td className="py-2.5 pr-3 text-right text-xs tabular-nums">
                            <span className="text-foreground">{pct(rep.deskPhoneCalls, rep.totalCalls)}%</span>
                            <span className="text-muted-foreground ml-1">({rep.deskPhoneCalls})</span>
                          </td>
                          <td className="py-2.5 text-right text-xs tabular-nums">
                            <span
                              className={headsetFlag ? "text-amber-600 dark:text-amber-400 font-semibold inline-flex items-center gap-1" : "text-foreground"}
                              title={headsetFlag ? "Low headset usage — may indicate audio quality issues" : undefined}
                            >
                              {headsetFlag && <Flame className="h-3 w-3" />}
                              {headsetPct}%
                            </span>
                            <span className="text-muted-foreground ml-1">({rep.headsetCalls})</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[11px] text-muted-foreground mt-2">
                  <Flame className="h-3 w-3 inline text-amber-500 mx-0.5" />
                  Amber = under 30% headset usage across 10+ calls — flag for call quality review.
                </p>
              </div>
            )}
          </div>

          {/* Provisioned devices */}
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 mt-3">
              Provisioned devices ({data.devices.length})
            </p>
            {data.devices.length === 0 ? (
              <p className="text-sm text-muted-foreground py-3" data-testid="device-usage-empty-devices">
                No provisioned devices found for this org.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Device</th>
                      <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Assigned to</th>
                      <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Product</th>
                      <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Last used</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.devices.map(d => (
                      <tr key={d.id} data-testid={`device-usage-device-${d.id}`}>
                        <td className="py-2.5 pr-4 text-xs text-foreground">
                          {d.displayName}
                          {d.mac && <div className="text-[10px] text-muted-foreground font-mono">{d.mac}</div>}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                          {d.assignedUserName ?? (d.workspaceId ? "Workspace" : "—")}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                          {d.product ?? d.productType ?? d.type ?? "—"}
                        </td>
                        <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                          {relativeDays(d.daysSinceLastUse)}
                        </td>
                        <td className="py-2.5 text-right">
                          {d.unused ? (
                            <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600 dark:text-amber-400">
                              Unused 30d+
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] border-emerald-500 text-emerald-600 dark:text-emerald-400">
                              Active
                            </Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
