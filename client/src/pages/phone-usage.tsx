import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Phone, PhoneIncoming, PhoneOutgoing, Clock, Users,
  TrendingUp, TrendingDown, AlertCircle, Trophy, Moon,
  ChevronRight, ExternalLink,
} from "lucide-react";

type Rep = {
  userId: string;
  name: string;
  managerId: string | null;
  count: number;
  inbound: number;
  outbound: number;
  baselineAvgPerDay: number;
  deltaPct: number;
  flag: "spike" | "drop" | null;
};

type Team = { managerId: string; managerName: string; repCount: number };

type UsageReport = {
  range: string;
  startISO: string;
  endISO: string;
  kpis: {
    totalCalls: number;
    inboundCalls: number;
    outboundCalls: number;
    avgCallsPerRep: number;
    pctAfterHours: number;
    afterHoursCalls: number;
    totalReps: number;
    repsWithActivity: number;
  };
  heatmap: number[][];
  reps: Rep[];
  teams: Team[];
};

const RANGES = [
  { label: "Today", value: "today" },
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
] as const;

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALLOWED_ROLES = ["admin", "sales_director", "director", "national_account_manager"];

function formatPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n}%`;
}

function HeatmapCell({ value, max }: { value: number; max: number }) {
  // Tailwind-friendly opacity ramp using inline style; emerald base color.
  const intensity = max > 0 ? Math.min(1, value / max) : 0;
  const bg = value === 0
    ? "transparent"
    : `rgba(16, 185, 129, ${0.15 + intensity * 0.75})`;
  return (
    <div
      className="h-6 w-full border border-border/40 rounded-sm flex items-center justify-center text-[9px] font-medium text-foreground/80"
      style={{ backgroundColor: bg }}
      title={`${value} call${value === 1 ? "" : "s"}`}
      data-testid={`heatmap-cell-${value}`}
    >
      {value > 0 ? value : ""}
    </div>
  );
}

type RepCall = {
  touchpointId: string;
  cdrId: string | null;
  timestamp: string;
  direction: "inbound" | "outbound" | "";
  durationMinutes: number | null;
  companyId: string | null;
  companyName: string | null;
  contactId: string | null;
  contactName: string | null;
  sentiment: string | null;
};

type RepCallsResponse = {
  userId: string;
  repName: string;
  range: string;
  startISO: string;
  endISO: string;
  totalCalls: number;
  calls: RepCall[];
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function RepCallsDialog({
  rep,
  range,
  managerId,
  open,
  onOpenChange,
}: {
  rep: Rep | null;
  range: string;
  managerId: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const enabled = open && !!rep;
  const { data, isLoading, error } = useQuery<RepCallsResponse>({
    queryKey: ["/api/webex/usage-report/rep-calls", rep?.userId ?? "", range, managerId],
    queryFn: async () => {
      const qs = new URLSearchParams({ userId: rep!.userId, range });
      if (managerId !== "all") qs.set("managerId", managerId);
      const res = await fetch(`/api/webex/usage-report/rep-calls?${qs.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled,
  });

  const rangeLabel = RANGES.find(r => r.value === range)?.label ?? range;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col" data-testid="dialog-rep-calls">
        <DialogHeader>
          <DialogTitle data-testid="text-dialog-title">
            {rep?.name ?? "Rep"} — Calls ({rangeLabel})
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${data.totalCalls} Webex call${data.totalCalls === 1 ? "" : "s"} in the selected window.`
              : "Loading call history…"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-auto">
          {isLoading && (
            <div className="space-y-2 py-2" data-testid="state-rep-calls-loading">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          )}

          {error && !isLoading && (
            <div className="flex flex-col items-center justify-center py-10 gap-3" data-testid="state-rep-calls-error">
              <AlertCircle className="h-8 w-8 text-destructive" />
              <p className="text-sm text-muted-foreground">Failed to load this rep's calls.</p>
            </div>
          )}

          {data && !isLoading && data.calls.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-10" data-testid="text-no-rep-calls">
              No Webex calls attributed to this rep in the selected window.
            </p>
          )}

          {data && !isLoading && data.calls.length > 0 && (
            <table className="w-full text-sm" data-testid="table-rep-calls">
              <thead>
                <tr className="border-b border-border sticky top-0 bg-background">
                  <th className="text-left py-2 pr-3 text-xs font-medium text-muted-foreground">When</th>
                  <th className="text-left py-2 pr-3 text-xs font-medium text-muted-foreground">Direction</th>
                  <th className="text-left py-2 pr-3 text-xs font-medium text-muted-foreground">Contact / Account</th>
                  <th className="text-right py-2 pr-3 text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="py-2 text-xs font-medium text-muted-foreground"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {data.calls.map(call => {
                  const isInbound = call.direction === "inbound";
                  const isOutbound = call.direction === "outbound";
                  const dirIcon = isInbound
                    ? <PhoneIncoming className="h-3.5 w-3.5 text-blue-500" />
                    : isOutbound
                    ? <PhoneOutgoing className="h-3.5 w-3.5 text-emerald-500" />
                    : <Phone className="h-3.5 w-3.5 text-muted-foreground" />;
                  const dirLabel = isInbound ? "Inbound" : isOutbound ? "Outbound" : "—";
                  return (
                    <tr key={call.touchpointId} data-testid={`row-rep-call-${call.touchpointId}`}>
                      <td className="py-2 pr-3 whitespace-nowrap text-foreground" data-testid={`text-call-time-${call.touchpointId}`}>
                        {formatTimestamp(call.timestamp)}
                      </td>
                      <td className="py-2 pr-3" data-testid={`text-call-direction-${call.touchpointId}`}>
                        <span className="inline-flex items-center gap-1.5 text-xs">
                          {dirIcon}
                          {dirLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3" data-testid={`text-call-party-${call.touchpointId}`}>
                        <div className="flex flex-col">
                          <span className="text-foreground">{call.contactName ?? "Unknown contact"}</span>
                          {call.companyName && (
                            <span className="text-xs text-muted-foreground">{call.companyName}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right text-muted-foreground whitespace-nowrap" data-testid={`text-call-duration-${call.touchpointId}`}>
                        {call.durationMinutes != null ? `${call.durationMinutes} min` : "—"}
                      </td>
                      <td className="py-2 text-right">
                        {call.companyId ? (
                          <Link
                            href={`/companies/${call.companyId}`}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            data-testid={`link-call-company-${call.touchpointId}`}
                          >
                            Open <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : (
                          // Touchpoints can lack a company in edge cases — fall back to
                          // the touchpoint history page so every row stays linkable.
                          <Link
                            href={`/touchpoint-history?focus=${call.touchpointId}`}
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            data-testid={`link-call-touchpoint-${call.touchpointId}`}
                          >
                            View <ExternalLink className="h-3 w-3" />
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PhoneUsagePage() {
  const { user } = useAuth();
  const [range, setRange] = useState<typeof RANGES[number]["value"]>("7d");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [drillRep, setDrillRep] = useState<Rep | null>(null);

  const { data, isLoading, error } = useQuery<UsageReport>({
    queryKey: ["/api/webex/usage-report", range, teamFilter],
    queryFn: async () => {
      const qs = new URLSearchParams({ range });
      if (teamFilter !== "all") qs.set("managerId", teamFilter);
      const res = await fetch(`/api/webex/usage-report?${qs.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const heatmapMax = useMemo(() => {
    if (!data) return 0;
    let m = 0;
    for (const row of data.heatmap) for (const v of row) if (v > m) m = v;
    return m;
  }, [data]);

  if (!user || !ALLOWED_ROLES.includes(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
        <AlertCircle className="h-10 w-10 text-muted-foreground" />
        <p className="text-muted-foreground">Access restricted to leadership roles.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto" data-testid="page-phone-usage">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Phone className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            Phone Usage
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Org-wide Webex call activity, after-hours patterns, and rep volume trends.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Team filter */}
          <select
            value={teamFilter}
            onChange={(e) => setTeamFilter(e.target.value)}
            className="text-xs h-8 px-2 rounded border bg-background text-foreground"
            data-testid="select-team-filter"
          >
            <option value="all">All teams</option>
            {data?.teams.map(t => (
              <option key={t.managerId} value={t.managerId}>
                {t.managerName} ({t.repCount})
              </option>
            ))}
          </select>
          {/* Date range */}
          <div className="flex items-center gap-1 border rounded-md overflow-hidden" data-testid="date-range-filter">
            {RANGES.map(r => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  range === r.value
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground"
                }`}
                data-testid={`date-range-${r.value}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-24" />)}
          </div>
          <Skeleton className="h-72" />
          <Skeleton className="h-80" />
        </div>
      )}

      {error && !isLoading && (
        <div className="flex flex-col items-center justify-center h-48 gap-3" data-testid="state-error">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-muted-foreground">Failed to load phone usage report.</p>
        </div>
      )}

      {data && !isLoading && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3" data-testid="section-kpi-strip">
            <Card className="p-4 space-y-1" data-testid="kpi-total-calls">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
                <Phone className="h-3.5 w-3.5" /> Total Calls
              </div>
              <p className="text-2xl font-bold text-foreground">{data.kpis.totalCalls}</p>
              <p className="text-xs text-muted-foreground">
                {data.kpis.repsWithActivity} of {data.kpis.totalReps} reps active
              </p>
            </Card>

            <Card className="p-4 space-y-1" data-testid="kpi-inbound">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
                <PhoneIncoming className="h-3.5 w-3.5 text-blue-500" /> Inbound
              </div>
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{data.kpis.inboundCalls}</p>
              <p className="text-xs text-muted-foreground">
                {data.kpis.totalCalls > 0
                  ? `${Math.round((data.kpis.inboundCalls / data.kpis.totalCalls) * 100)}% of total`
                  : "—"}
              </p>
            </Card>

            <Card className="p-4 space-y-1" data-testid="kpi-outbound">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
                <PhoneOutgoing className="h-3.5 w-3.5 text-emerald-500" /> Outbound
              </div>
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{data.kpis.outboundCalls}</p>
              <p className="text-xs text-muted-foreground">
                {data.kpis.totalCalls > 0
                  ? `${Math.round((data.kpis.outboundCalls / data.kpis.totalCalls) * 100)}% of total`
                  : "—"}
              </p>
            </Card>

            <Card className="p-4 space-y-1" data-testid="kpi-avg-per-rep">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
                <Users className="h-3.5 w-3.5" /> Avg / Rep
              </div>
              <p className="text-2xl font-bold text-foreground">{data.kpis.avgCallsPerRep}</p>
              <p className="text-xs text-muted-foreground">over selected range</p>
            </Card>

            <Card className="p-4 space-y-1" data-testid="kpi-after-hours">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wide">
                <Moon className="h-3.5 w-3.5 text-amber-500" /> After-Hours
              </div>
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{data.kpis.pctAfterHours}%</p>
              <p className="text-xs text-muted-foreground">
                {data.kpis.afterHoursCalls} call{data.kpis.afterHoursCalls === 1 ? "" : "s"} outside 8a–6p / weekends
              </p>
            </Card>
          </div>

          {/* Heatmap */}
          <Card className="p-5 space-y-3" data-testid="section-heatmap">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold text-foreground">Call Volume Heatmap</h2>
              <span className="text-xs text-muted-foreground ml-auto">Day-of-week × Hour-of-day</span>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[680px]">
                {/* Hour header */}
                <div className="grid gap-0.5" style={{ gridTemplateColumns: "40px repeat(24, 1fr)" }}>
                  <div></div>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="text-[9px] text-center text-muted-foreground">
                      {h % 3 === 0 ? h : ""}
                    </div>
                  ))}
                </div>
                {/* Rows */}
                {DAY_LABELS.map((dow, dowIdx) => (
                  <div
                    key={dow}
                    className="grid gap-0.5 mt-0.5"
                    style={{ gridTemplateColumns: "40px repeat(24, 1fr)" }}
                    data-testid={`heatmap-row-${dow.toLowerCase()}`}
                  >
                    <div className="text-[10px] text-muted-foreground flex items-center pr-1">{dow}</div>
                    {data.heatmap[dowIdx].map((value, hour) => (
                      <HeatmapCell key={hour} value={value} max={heatmapMax} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>Less</span>
              <div className="flex items-center gap-0.5">
                {[0.15, 0.35, 0.55, 0.75, 0.9].map(o => (
                  <div
                    key={o}
                    className="h-3 w-4 rounded-sm border border-border/40"
                    style={{ backgroundColor: `rgba(16, 185, 129, ${o})` }}
                  />
                ))}
              </div>
              <span>More</span>
              <span className="ml-auto">Peak cell: {heatmapMax} call{heatmapMax === 1 ? "" : "s"}</span>
            </div>
          </Card>

          {/* Rep ranking */}
          <Card className="p-5 space-y-3" data-testid="section-rep-ranking">
            <div className="flex items-center gap-2">
              <Trophy className="h-4 w-4 text-amber-500" />
              <h2 className="font-semibold text-foreground">Rep Call Volume</h2>
              <Badge variant="outline" className="ml-auto text-xs">vs 30-day avg</Badge>
            </div>
            {data.reps.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6" data-testid="text-no-reps">
                No call activity in the selected range.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-4 text-xs font-medium text-muted-foreground">Rep</th>
                      <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground">Calls</th>
                      <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground hidden md:table-cell">Inbound</th>
                      <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground hidden md:table-cell">Outbound</th>
                      <th className="text-right py-2 pr-4 text-xs font-medium text-muted-foreground hidden md:table-cell">30d Avg/Day</th>
                      <th className="text-right py-2 text-xs font-medium text-muted-foreground">Δ vs Baseline</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {data.reps.map((rep, i) => {
                      const isUp = rep.deltaPct > 0;
                      const isDown = rep.deltaPct < 0;
                      const trendColor = rep.flag === "spike"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : rep.flag === "drop"
                        ? "text-red-500 dark:text-red-400"
                        : isUp
                        ? "text-emerald-600 dark:text-emerald-400"
                        : isDown
                        ? "text-muted-foreground"
                        : "text-muted-foreground";
                      // Drop-off rows have count=0 but still warrant a drill-down so
                      // leaders can confirm "yep, truly zero calls in window."
                      const canDrill = true;
                      return (
                        <tr
                          key={rep.userId}
                          onClick={() => canDrill && setDrillRep(rep)}
                          onKeyDown={(e) => {
                            if (!canDrill) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setDrillRep(rep);
                            }
                          }}
                          tabIndex={canDrill ? 0 : -1}
                          role={canDrill ? "button" : undefined}
                          aria-label={canDrill ? `View calls for ${rep.name}` : undefined}
                          title={canDrill ? "View this rep's calls" : "No calls in selected window"}
                          className={canDrill ? "cursor-pointer hover:bg-muted/50 focus:bg-muted/50 outline-none" : ""}
                          data-testid={`row-rep-${rep.userId}`}
                        >
                          <td className="py-2.5 pr-4">
                            <div className="flex items-center gap-2">
                              {i === 0 && rep.count > 0 && <Trophy className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                              <span className="font-medium text-foreground">{rep.name}</span>
                              {canDrill && (
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 ml-0.5" aria-hidden="true" />
                              )}
                              {rep.flag === "spike" && (
                                <Badge variant="outline" className="text-[10px] border-emerald-500 text-emerald-600 dark:text-emerald-400" data-testid={`badge-spike-${rep.userId}`}>
                                  spike
                                </Badge>
                              )}
                              {rep.flag === "drop" && (
                                <Badge variant="outline" className="text-[10px] border-red-500 text-red-500 dark:text-red-400" data-testid={`badge-drop-${rep.userId}`}>
                                  drop-off
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="py-2.5 pr-4 text-right font-semibold text-foreground" data-testid={`text-count-${rep.userId}`}>
                            {rep.count}
                          </td>
                          <td className="py-2.5 pr-4 text-right text-muted-foreground hidden md:table-cell">{rep.inbound}</td>
                          <td className="py-2.5 pr-4 text-right text-muted-foreground hidden md:table-cell">{rep.outbound}</td>
                          <td className="py-2.5 pr-4 text-right text-muted-foreground hidden md:table-cell">
                            {rep.baselineAvgPerDay > 0 ? rep.baselineAvgPerDay : "—"}
                          </td>
                          <td className={`py-2.5 text-right ${trendColor}`} data-testid={`text-delta-${rep.userId}`}>
                            <span className="inline-flex items-center gap-1 font-semibold">
                              {isUp ? <TrendingUp className="h-3 w-3" /> : isDown ? <TrendingDown className="h-3 w-3" /> : null}
                              {rep.baselineAvgPerDay > 0 || rep.count > 0 ? formatPct(rep.deltaPct) : "—"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Spikes/drop-offs flagged when a rep has ≥5 calls in their 30-day baseline and the current window deviates by ≥50%.
            </p>
          </Card>
        </>
      )}

      <RepCallsDialog
        rep={drillRep}
        range={range}
        managerId={teamFilter}
        open={!!drillRep}
        onOpenChange={(next) => { if (!next) setDrillRep(null); }}
      />
    </div>
  );
}
