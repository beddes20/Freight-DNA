/**
 * Task #673 — Freight Capture Funnel.
 *
 * Sliceable funnel visualization for quote opportunities. Stages:
 *   Request Received → Quoted → Follow-up Sent → Booked / Won
 * with parallel-exit metrics for Lost and Stale / No Response.
 *
 * Driven by /api/customer-quotes/funnel — server applies role-based
 * scoping (account_managers see only their own data) and the same
 * filter shape used by the snapshot endpoint.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Inbox, Quote, Send, Trophy, XCircle, Clock, TrendingDown, AlertCircle } from "lucide-react";

type StageKey = "received" | "quoted" | "followup" | "won" | "lost" | "stale";

type FunnelStage = {
  key: StageKey;
  label: string;
  count: number;
  conversionPct: number | null;
  shareOfReceivedPct: number;
};

type FunnelLossReason = { reasonId: string | null; label: string; count: number };

type FunnelPerformerRow = {
  id: string;
  label: string;
  total: number;
  won: number;
  lost: number;
  winRate: number;
  avgQuoted: number;
};

type FunnelResult = {
  stages: FunnelStage[];
  summary: {
    totalReceived: number;
    totalQuoted: number;
    totalWon: number;
    totalLost: number;
    totalStale: number;
    quoteToBookPct: number;
    winRatePct: number;
    avgResponseTimeHours: number;
    followUpCompliancePct: number;
  };
  lossReasons: FunnelLossReason[];
  performers: {
    lanes: FunnelPerformerRow[];
    customers: FunnelPerformerRow[];
    reps: FunnelPerformerRow[];
  };
  scopedToRepId: string | null;
};

export type FunnelFilters = {
  customerId?: string;
  startDate?: string;
  endDate?: string;
  equipment?: string;
  repId?: string;
  outcomeStatus?: string;
  laneSearch?: string;
};

interface Props {
  filters: FunnelFilters;
}

const STAGE_ICONS: Record<StageKey, JSX.Element> = {
  received: <Inbox className="h-4 w-4" />,
  quoted: <Quote className="h-4 w-4" />,
  followup: <Send className="h-4 w-4" />,
  won: <Trophy className="h-4 w-4" />,
  lost: <XCircle className="h-4 w-4" />,
  stale: <Clock className="h-4 w-4" />,
};

const STAGE_TONE: Record<StageKey, string> = {
  received: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  quoted: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30",
  followup: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  won: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  lost: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  stale: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
};

const SEQUENTIAL_STAGES: StageKey[] = ["received", "quoted", "followup", "won"];
const EXIT_STAGES: StageKey[] = ["lost", "stale"];

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  return `${h.toFixed(1)}h`;
}

function buildQueryString(filters: FunnelFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function FreightCaptureFunnel({ filters }: Props): JSX.Element {
  const qs = buildQueryString(filters);
  const queryKey = useMemo(() => ["/api/customer-quotes/funnel", filters] as const, [filters]);

  const { data, isLoading, isError, error } = useQuery<FunnelResult>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/funnel${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(`Funnel request failed (${res.status})`);
      return res.json() as Promise<FunnelResult>;
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="funnel-loading">
        <Skeleton className="h-24 w-full bg-card" />
        <Skeleton className="h-48 w-full bg-card" />
        <Skeleton className="h-64 w-full bg-card" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card data-testid="funnel-error">
        <CardContent className="p-6 flex items-center gap-2 text-rose-600 dark:text-rose-400">
          <AlertCircle className="h-4 w-4" />
          <span>Could not load funnel: {error instanceof Error ? error.message : "Unknown error"}</span>
        </CardContent>
      </Card>
    );
  }

  const sequential = data.stages.filter(s => (SEQUENTIAL_STAGES as string[]).includes(s.key));
  const exits = data.stages.filter(s => (EXIT_STAGES as string[]).includes(s.key));
  const maxLossCount = data.lossReasons.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <div className="space-y-4" data-testid="funnel-root">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2" data-testid="funnel-kpis">
        <SummaryKpi label="Received" value={data.summary.totalReceived.toString()} testId="funnel-kpi-received" />
        <SummaryKpi label="Quoted" value={data.summary.totalQuoted.toString()} testId="funnel-kpi-quoted" />
        <SummaryKpi label="Won" value={data.summary.totalWon.toString()} testId="funnel-kpi-won" />
        <SummaryKpi label="Quote → Book" value={fmtPct(data.summary.quoteToBookPct)} testId="funnel-kpi-quote-to-book" />
        <SummaryKpi label="Win rate" value={fmtPct(data.summary.winRatePct)} sub="of decided" testId="funnel-kpi-win-rate" />
        <SummaryKpi label="Avg response" value={fmtHours(data.summary.avgResponseTimeHours)} testId="funnel-kpi-avg-response" />
      </div>

      {/* Funnel stages */}
      <Card data-testid="funnel-stages-card">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Capture funnel</CardTitle>
            {data.scopedToRepId && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide" data-testid="funnel-scoped-badge">
                Scoped to your quotes
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5" data-testid="funnel-stages">
            {sequential.map(s => (
              <FunnelBar key={s.key} stage={s} totalReceived={data.summary.totalReceived} />
            ))}
          </div>
          <div className="border-t border-border pt-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Exit paths</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {exits.map(s => (
                <FunnelBar key={s.key} stage={s} totalReceived={data.summary.totalReceived} variant="exit" />
              ))}
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground pt-1" data-testid="funnel-followup-summary">
            Follow-up compliance: <span className="text-foreground font-medium tabular-nums">{fmtPct(data.summary.followUpCompliancePct)}</span>
            {" · "}Stale / no-response: <span className="text-foreground font-medium tabular-nums">{data.summary.totalStale}</span>
          </div>
        </CardContent>
      </Card>

      {/* Loss reasons + Performers */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-4">
        <Card data-testid="funnel-loss-reasons-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-rose-500" /> Why we lose
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data.lossReasons.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center" data-testid="funnel-loss-empty">
                No losses in this slice. Nice.
              </div>
            ) : (
              <ul className="space-y-1.5" data-testid="funnel-loss-list">
                {data.lossReasons.map(r => {
                  const widthPct = maxLossCount > 0 ? (r.count / maxLossCount) * 100 : 0;
                  return (
                    <li key={r.reasonId ?? "__none__"} className="text-xs" data-testid={`funnel-loss-row-${r.reasonId ?? "none"}`}>
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-foreground truncate">{r.label}</span>
                        <span className="text-muted-foreground tabular-nums shrink-0">{r.count}</span>
                      </div>
                      <div className="h-1.5 bg-muted/60 rounded-full overflow-hidden">
                        <div className="h-full bg-rose-500/70" style={{ width: `${widthPct}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card data-testid="funnel-performers-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Best & worst performers</CardTitle>
          </CardHeader>
          <CardContent>
            <PerformerTabs performers={data.performers} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface SummaryKpiProps { label: string; value: string; sub?: string; testId: string; }

function SummaryKpi({ label, value, sub, testId }: SummaryKpiProps): JSX.Element {
  return (
    <div className="rounded p-2.5 bg-card border border-border" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums text-foreground mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

interface FunnelBarProps {
  stage: FunnelStage;
  totalReceived: number;
  variant?: "stage" | "exit";
}

function FunnelBar({ stage, totalReceived, variant = "stage" }: FunnelBarProps): JSX.Element {
  const widthPct = totalReceived > 0 ? Math.max(2, (stage.count / totalReceived) * 100) : 0;
  const barTone = variant === "exit"
    ? "bg-amber-500/40 dark:bg-amber-400/40"
    : "bg-amber-500 dark:bg-amber-400";
  return (
    <div className="space-y-1" data-testid={`funnel-stage-${stage.key}`}>
      <div className="flex items-center justify-between text-xs">
        <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border ${STAGE_TONE[stage.key]}`}>
          {STAGE_ICONS[stage.key]}
          <span className="font-medium">{stage.label}</span>
        </div>
        <div className="flex items-center gap-3 text-foreground/90 tabular-nums">
          <span className="font-semibold" data-testid={`funnel-stage-count-${stage.key}`}>{stage.count.toLocaleString()}</span>
          {stage.conversionPct !== null && (
            <span className="text-muted-foreground text-[11px]" data-testid={`funnel-stage-conv-${stage.key}`}>
              {fmtPct(stage.conversionPct)} {variant === "exit" ? "of quoted" : "vs prior"}
            </span>
          )}
        </div>
      </div>
      <div className="h-2 bg-muted/60 rounded-full overflow-hidden">
        <div className={`h-full ${barTone}`} style={{ width: `${widthPct}%` }} />
      </div>
    </div>
  );
}

interface PerformerTabsProps {
  performers: FunnelResult["performers"];
}

function PerformerTabs({ performers }: PerformerTabsProps): JSX.Element {
  const [tab, setTab] = useState<"lanes" | "customers" | "reps">("lanes");
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
      <TabsList className="h-8 mb-2" data-testid="funnel-performers-tabs">
        <TabsTrigger value="lanes" className="text-xs h-7" data-testid="tab-performers-lanes">Lanes</TabsTrigger>
        <TabsTrigger value="customers" className="text-xs h-7" data-testid="tab-performers-customers">Customers</TabsTrigger>
        <TabsTrigger value="reps" className="text-xs h-7" data-testid="tab-performers-reps">Reps</TabsTrigger>
      </TabsList>
      <TabsContent value="lanes"><PerformerTable rows={performers.lanes} firstColLabel="Lane" testId="performers-table-lanes" /></TabsContent>
      <TabsContent value="customers"><PerformerTable rows={performers.customers} firstColLabel="Customer" testId="performers-table-customers" /></TabsContent>
      <TabsContent value="reps"><PerformerTable rows={performers.reps} firstColLabel="Rep" testId="performers-table-reps" /></TabsContent>
    </Tabs>
  );
}

interface PerformerTableProps {
  rows: FunnelPerformerRow[];
  firstColLabel: string;
  testId: string;
}

function PerformerTable({ rows, firstColLabel, testId }: PerformerTableProps): JSX.Element {
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground py-6 text-center" data-testid={`${testId}-empty`}>No data in this slice.</div>;
  }
  // Best = highest win rate; Worst = lowest win rate (among rows with at least one decided outcome).
  const decided = rows.filter(r => r.won + r.lost > 0);
  const sortedByWin = decided.slice().sort((a, b) => b.winRate - a.winRate);
  const best = sortedByWin.slice(0, 5);
  const worst = sortedByWin.slice().reverse().slice(0, 5);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid={testId}>
      <PerformerSubTable title="Best" rows={best} firstColLabel={firstColLabel} testId={`${testId}-best`} />
      <PerformerSubTable title="Worst" rows={worst} firstColLabel={firstColLabel} testId={`${testId}-worst`} />
    </div>
  );
}

interface PerformerSubTableProps {
  title: string;
  rows: FunnelPerformerRow[];
  firstColLabel: string;
  testId: string;
}

function PerformerSubTable({ title, rows, firstColLabel, testId }: PerformerSubTableProps): JSX.Element {
  return (
    <div data-testid={testId}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">No decided outcomes.</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1 pr-2 font-medium">{firstColLabel}</th>
              <th className="py-1 px-1 text-right font-medium">Total</th>
              <th className="py-1 px-1 text-right font-medium">Won</th>
              <th className="py-1 pl-1 text-right font-medium">Win %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-b border-border/60 last:border-0" data-testid={`${testId}-row-${r.id}`}>
                <td className="py-1 pr-2 truncate max-w-[140px] text-foreground">{r.label}</td>
                <td className="py-1 px-1 text-right tabular-nums text-muted-foreground">{r.total}</td>
                <td className="py-1 px-1 text-right tabular-nums text-foreground">{r.won}</td>
                <td className="py-1 pl-1 text-right tabular-nums text-foreground">{fmtPct(r.winRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && rows[0].avgQuoted > 0 && (
        <div className="text-[10px] text-muted-foreground mt-1 text-right">Top avg quoted: {fmtMoney(rows[0].avgQuoted)}</div>
      )}
    </div>
  );
}
