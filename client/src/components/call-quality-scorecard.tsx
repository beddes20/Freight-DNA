import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  PhoneCall, Activity, AlertTriangle, RefreshCw, Volume2, Clock, ChevronRight, X,
} from "lucide-react";

// ─── Types matching /api/webex/call-quality/scorecard ──────────────────

export type CallQualityRep = {
  userId: string;
  repName: string;
  totalCalls: number;
  connectedCalls: number;
  outboundCalls: number;
  outboundConnectedCalls: number;
  connectRate: number;
  outboundConnectRate: number;
  avgTalkSecondsPerConnected: number;
  totalTalkSeconds: number;
  totalHoldSeconds: number;
  totalSilenceSeconds: number;
  holdRatio: number;
  deadAirRatio: number;
  callsPerDay: number;
  afterHoursRate: number;
  avgMos: number | null;
  avgJitterMs: number | null;
  avgPacketLossPct: number | null;
  gradeMix: { A: number; B: number; C: number; D: number };
  activeDays: number;
  attentionScore: number;
};

export type CallQualityScorecard = {
  days: number;
  team: {
    totalCalls: number;
    connectedCalls: number;
    outboundCalls: number;
    outboundConnectedCalls: number;
    totalTalkSeconds: number;
    totalHoldSeconds: number;
    totalSilenceSeconds: number;
    afterHoursCalls: number;
    connectRate: number;
    outboundConnectRate: number;
    avgMos: number | null;
    avgJitterMs: number | null;
    avgPacketLossPct: number | null;
    repCount: number;
  };
  reps: CallQualityRep[];
};

export type CallQualityCall = {
  id: string;
  call_id: string;
  user_id: string | null;
  rep_name: string | null;
  direction: string | null;
  remote_number: string | null;
  start_time: string | null;
  duration_seconds: number;
  answered: boolean;
  talk_time_seconds: number;
  hold_time_seconds: number;
  silence_seconds: number;
  mos_score: string | null;
  jitter_ms: string | null;
  packet_loss_pct: string | null;
  quality_grade: string | null;
  after_hours: boolean;
  contact_name: string | null;
  company_name: string | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────

function formatPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function formatSeconds(v: number | null | undefined): string {
  if (v == null || !isFinite(v) || v <= 0) return "—";
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatNumber(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return "—";
  return v.toFixed(digits);
}

function gradeColor(grade: string | null | undefined): string {
  switch (grade) {
    case "A": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/40";
    case "B": return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/40";
    case "C": return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40";
    case "D": return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/40";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

function attentionColor(score: number): string {
  if (score >= 40) return "text-red-600 dark:text-red-400";
  if (score >= 25) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

// ─── Portlet (Coordinators Corner) ─────────────────────────────────────

/**
 * Compact portlet for the Coordinators Corner Hub. Shows up to 5 reps
 * who need the most coaching attention, ranked by attention score, with
 * a one-click link to the full Exec Analytics panel.
 */
export function CallQualityPortlet({ days = 30, topN = 5 }: { days?: number; topN?: number }) {
  const { data, isLoading, isError, refetch } = useQuery<CallQualityScorecard>({
    queryKey: ["/api/webex/call-quality/scorecard", days],
    queryFn: async () => {
      const res = await fetch(`/api/webex/call-quality/scorecard?days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load scorecard");
      return res.json();
    },
  });

  const top = (data?.reps ?? []).slice(0, topN);
  const hasData = !isLoading && (data?.team.totalCalls ?? 0) > 0;

  return (
    <Card data-testid="card-call-quality-portlet">
      <CardHeader className="pb-2 flex flex-row items-center gap-2">
        <div className="h-8 w-8 rounded-md bg-orange-500/10 flex items-center justify-center shrink-0">
          <PhoneCall className="h-4 w-4 text-orange-500" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold tracking-tight">Call Quality Scorecards</h3>
          <p className="text-xs text-muted-foreground">
            Reps needing attention • last {days} days
          </p>
        </div>
        {data?.team && (
          <Badge variant="outline" className="text-[10px] shrink-0">
            {data.team.totalCalls} calls
          </Badge>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: topN }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorBanner
            compact
            message="Couldn't load call quality scorecards."
            onRetry={() => refetch()}
          />
        ) : !hasData ? (
          <EmptyState
            icon={PhoneCall}
            title="No call quality data"
            description={`No Webex call activity in the last ${days} days.`}
            compact
            testId="empty-call-quality-portlet"
          />
        ) : (
          <ul className="divide-y" data-testid="list-attention-reps">
            {top.map((rep) => (
              <li
                key={rep.userId}
                className="py-2 flex items-center gap-3"
                data-testid={`row-attention-rep-${rep.userId}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{rep.repName}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {rep.totalCalls} calls · {formatPct(rep.outboundConnectRate)} connect · {formatSeconds(rep.avgTalkSecondsPerConnected)} avg talk
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-sm font-semibold ${attentionColor(rep.attentionScore)}`}>
                    {rep.attentionScore.toFixed(0)}
                  </div>
                  <div className="text-[10px] text-muted-foreground">attention</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Exec Analytics panel ───────────────────────────────────────────────

type SortKey =
  | "attention" | "totalCalls" | "connectRate" | "avgTalk"
  | "hold" | "deadAir" | "mos" | "callsPerDay" | "afterHours";

/**
 * Full Call Quality panel for Exec Analytics. Shows team rollup KPIs and a
 * sortable per-rep table with drill-in to the underlying call list.
 */
export function CallQualityPanel({
  days: daysProp,
  onDaysChange,
}: {
  days?: number;
  onDaysChange?: (days: number) => void;
} = {}) {
  const { toast } = useToast();
  const [internalDays, setInternalDays] = useState(30);
  const days = daysProp ?? internalDays;
  const setDays = (n: number) => {
    if (onDaysChange) onDaysChange(n);
    else setInternalDays(n);
  };
  const externallyControlled = daysProp !== undefined;
  const [sortKey, setSortKey] = useState<SortKey>("attention");
  const [sortDesc, setSortDesc] = useState(true);
  const [drillUserId, setDrillUserId] = useState<string | null>(null);
  const [drillRepName, setDrillRepName] = useState<string>("");

  const { data, isLoading, isError, refetch } = useQuery<CallQualityScorecard>({
    queryKey: ["/api/webex/call-quality/scorecard", days],
    queryFn: async () => {
      const res = await fetch(`/api/webex/call-quality/scorecard?days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load scorecard");
      return res.json();
    },
  });

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/webex/call-quality/backfill", { days: 90 });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Backfill started", description: "Webex call analytics are being hydrated for the last 90 days." });
      queryClient.invalidateQueries({ queryKey: ["/api/webex/call-quality/scorecard"] });
    },
    onError: (err: any) => {
      toast({
        title: "Backfill failed",
        description: err?.message ?? "Unable to run backfill. Is Webex connected?",
        variant: "destructive",
      });
    },
  });

  const sorted = (() => {
    const reps = [...(data?.reps ?? [])];
    const keyFn = (r: CallQualityRep): number => {
      switch (sortKey) {
        case "totalCalls": return r.totalCalls;
        case "connectRate": return r.outboundConnectRate;
        case "avgTalk": return r.avgTalkSecondsPerConnected;
        case "hold": return r.holdRatio;
        case "deadAir": return r.deadAirRatio;
        case "mos": return r.avgMos ?? 0;
        case "callsPerDay": return r.callsPerDay;
        case "afterHours": return r.afterHoursRate;
        case "attention":
        default: return r.attentionScore;
      }
    };
    reps.sort((a, b) => (keyFn(a) - keyFn(b)) * (sortDesc ? -1 : 1));
    return reps;
  })();

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc(!sortDesc);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const SortHeader = ({ label, sk }: { label: string; sk: SortKey }) => (
    <button
      onClick={() => toggleSort(sk)}
      className={`text-xs font-medium hover:text-foreground transition-colors ${sortKey === sk ? "text-foreground" : "text-muted-foreground"}`}
      data-testid={`sort-${sk}`}
    >
      {label}{sortKey === sk ? (sortDesc ? " ↓" : " ↑") : ""}
    </button>
  );

  return (
    <Card className="p-5" data-testid="card-call-quality-panel">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-9 w-9 rounded-md bg-orange-500/10 flex items-center justify-center shrink-0">
          <PhoneCall className="h-4.5 w-4.5 text-orange-500" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold tracking-tight">Call Quality</h3>
          <p className="text-xs text-muted-foreground">
            Webex talk-time, quality, and activity metrics
          </p>
        </div>
        {!externallyControlled && (
          <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v, 10))}>
            <SelectTrigger className="w-[110px]" data-testid="select-days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="60">Last 60 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
          data-testid="button-backfill"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${backfillMutation.isPending ? "animate-spin" : ""}`} />
          Backfill 90d
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="skeleton-call-quality-panel">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <ErrorBanner
          message="We couldn't load call quality scorecards. This is usually temporary — try again."
          onRetry={() => refetch()}
        />
      ) : !data || data.team.totalCalls === 0 ? (
        <EmptyState
          icon={PhoneCall}
          title="No call quality data yet"
          description={`Once your team's Webex calls sync, quality metrics will appear here for the last ${days} days.`}
          testId="empty-call-quality-panel"
        />
      ) : (
        <>
          {/* Team rollup */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <RollupTile label="Calls" value={data.team.totalCalls.toLocaleString()} icon={<PhoneCall className="h-3.5 w-3.5" />} />
            <RollupTile label="Outbound connect" value={formatPct(data.team.outboundConnectRate)} icon={<Activity className="h-3.5 w-3.5" />} />
            <RollupTile label="Avg talk time" value={formatSeconds(data.team.connectedCalls > 0 ? data.team.totalTalkSeconds / data.team.connectedCalls : 0)} icon={<Clock className="h-3.5 w-3.5" />} />
            <RollupTile label="Avg MOS" value={formatNumber(data.team.avgMos, 2)} icon={<Volume2 className="h-3.5 w-3.5" />} />
            <RollupTile label="Avg jitter" value={data.team.avgJitterMs != null ? `${data.team.avgJitterMs.toFixed(0)} ms` : "—"} icon={<Activity className="h-3.5 w-3.5" />} />
            <RollupTile label="Avg packet loss" value={data.team.avgPacketLossPct != null ? `${data.team.avgPacketLossPct.toFixed(2)}%` : "—"} icon={<Activity className="h-3.5 w-3.5" />} />
            <RollupTile label="After-hours calls" value={data.team.afterHoursCalls.toLocaleString()} icon={<Clock className="h-3.5 w-3.5" />} />
            <RollupTile label="Reps active" value={String(data.team.repCount)} icon={<AlertTriangle className="h-3.5 w-3.5" />} />
          </div>

          {/* Per-rep table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-3"><span className="text-xs font-medium text-muted-foreground">Rep</span></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Calls" sk="totalCalls" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Calls/day" sk="callsPerDay" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Connect" sk="connectRate" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Avg talk" sk="avgTalk" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Hold %" sk="hold" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Dead air" sk="deadAir" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="MOS" sk="mos" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="After-hours" sk="afterHours" /></th>
                  <th className="text-right py-2 pr-3"><SortHeader label="Attention" sk="attention" /></th>
                  <th className="py-2 w-6" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((rep) => (
                  <tr
                    key={rep.userId}
                    className="border-b hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => { setDrillUserId(rep.userId); setDrillRepName(rep.repName); }}
                    data-testid={`row-rep-${rep.userId}`}
                  >
                    <td className="py-2 pr-3 font-medium">{rep.repName}</td>
                    <td className="py-2 pr-3 text-right">{rep.totalCalls}</td>
                    <td className="py-2 pr-3 text-right">{rep.callsPerDay > 0 ? rep.callsPerDay.toFixed(1) : "—"}</td>
                    <td className="py-2 pr-3 text-right">{formatPct(rep.outboundConnectRate)}</td>
                    <td className="py-2 pr-3 text-right">{formatSeconds(rep.avgTalkSecondsPerConnected)}</td>
                    <td className="py-2 pr-3 text-right">{formatPct(rep.holdRatio, 1)}</td>
                    <td className="py-2 pr-3 text-right">{formatPct(rep.deadAirRatio, 1)}</td>
                    <td className="py-2 pr-3 text-right">{formatNumber(rep.avgMos, 2)}</td>
                    <td className="py-2 pr-3 text-right">{formatPct(rep.afterHoursRate)}</td>
                    <td className={`py-2 pr-3 text-right font-semibold ${attentionColor(rep.attentionScore)}`}>
                      {rep.attentionScore.toFixed(0)}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      <ChevronRight className="h-3.5 w-3.5 inline" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {drillUserId && (
        <CallQualityDrillIn
          userId={drillUserId}
          repName={drillRepName}
          days={days}
          onClose={() => setDrillUserId(null)}
        />
      )}
    </Card>
  );
}

function RollupTile({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function CallQualityDrillIn({
  userId, repName, days, onClose,
}: {
  userId: string; repName: string; days: number; onClose: () => void;
}) {
  const { data, isLoading, isError, refetch } = useQuery<{ calls: CallQualityCall[]; total: number; days: number }>({
    queryKey: ["/api/webex/call-quality/calls", userId, days],
    queryFn: async () => {
      const res = await fetch(`/api/webex/call-quality/calls?userId=${encodeURIComponent(userId)}&days=${days}&limit=200`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load calls");
      return res.json();
    },
  });

  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-end md:items-center justify-center p-0 md:p-4"
      onClick={onClose}
      data-testid="overlay-drill-in"
    >
      <div
        className="bg-background border rounded-t-lg md:rounded-lg max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 p-4 border-b">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold">{repName} — call detail</h3>
            <p className="text-xs text-muted-foreground">Last {days} days · {data?.total ?? 0} calls</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-drill-in">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <div className="space-y-2" data-testid="skeleton-call-drill-in">
              {Array.from({ length: 10 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : isError ? (
            <ErrorBanner
              compact
              message="Couldn't load this rep's call detail."
              onRetry={() => refetch()}
            />
          ) : (data?.calls ?? []).length === 0 ? (
            <EmptyState
              icon={PhoneCall}
              title="No calls in this window"
              description={`This rep had no Webex calls in the last ${days} days.`}
              compact
              testId="empty-call-drill-in"
            />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Contact / Number</th>
                  <th className="py-2 pr-3 font-medium">Dir</th>
                  <th className="py-2 pr-3 font-medium text-right">Duration</th>
                  <th className="py-2 pr-3 font-medium text-right">Talk</th>
                  <th className="py-2 pr-3 font-medium text-right">Hold</th>
                  <th className="py-2 pr-3 font-medium text-right">MOS</th>
                  <th className="py-2 font-medium">Quality</th>
                </tr>
              </thead>
              <tbody>
                {(data?.calls ?? []).map((c) => (
                  <tr key={c.id} className="border-b" data-testid={`call-row-${c.id}`}>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {c.start_time ? new Date(c.start_time).toLocaleString() : "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      <div className="font-medium">{c.contact_name || c.company_name || c.remote_number || "—"}</div>
                      {c.remote_number && (c.contact_name || c.company_name) && (
                        <div className="text-[10px] text-muted-foreground">{c.remote_number}</div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{c.direction === "ORIGINATING" ? "Out" : "In"}</td>
                    <td className="py-1.5 pr-3 text-right">{formatSeconds(c.duration_seconds)}</td>
                    <td className="py-1.5 pr-3 text-right">{formatSeconds(c.talk_time_seconds)}</td>
                    <td className="py-1.5 pr-3 text-right">{formatSeconds(c.hold_time_seconds)}</td>
                    <td className="py-1.5 pr-3 text-right">{c.mos_score ? Number(c.mos_score).toFixed(2) : "—"}</td>
                    <td className="py-1.5">
                      <Badge variant="outline" className={`text-[10px] ${gradeColor(c.quality_grade)}`}>
                        {c.quality_grade || "—"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
