/**
 * Response Time Tab — Email Intelligence (Task #414)
 *
 * Lets reps & leadership see how fast inbound customer emails get a reply.
 * Sections: filters, KPI tiles (today/week/month w/ deltas), trend chart,
 * per-rep leaderboard, slowest threads (click → conversation drawer).
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  Clock, ArrowDown, ArrowUp, Filter, ChevronRight, Mail, Inbox, AlertTriangle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ThreadDetailPanel, type ConversationThread } from "@/pages/conversations";

// ─── Types ───────────────────────────────────────────────────────────────────

interface KpiBucketDto {
  label: string;
  start: string;
  end: string;
  avgMs: number | null;
  medianMs: number | null;
  count: number;
  waiting: number;
}

interface KpisResponse {
  businessHours: boolean;
  today: { current: KpiBucketDto; prior: KpiBucketDto };
  week: { current: KpiBucketDto; prior: KpiBucketDto };
  month: { current: KpiBucketDto; prior: KpiBucketDto };
}

interface TimeseriesPointDto {
  bucket: string;
  avgMs: number | null;
  medianMs: number | null;
  count: number;
}

interface TimeseriesResponse {
  granularity: "day" | "week" | "month";
  businessHours: boolean;
  points: TimeseriesPointDto[];
}

interface LeaderboardRowDto {
  ownerUserId: string;
  ownerName: string;
  count: number;
  waiting: number;
  avgMs: number | null;
  medianMs: number | null;
}

interface LeaderboardResponse {
  businessHours: boolean;
  rows: LeaderboardRowDto[];
}

interface SlowestRowDto {
  inboundId: string;
  threadId: string;
  inboundAt: string;
  outboundAt: string | null;
  ageMs: number;
  isWaiting: boolean;
  ownerName: string | null;
  ownerUserId: string | null;
  accountName: string | null;
  accountId: string | null;
  subject: string | null;
  fromEmail: string | null;
}

interface SlowestResponse {
  businessHours: boolean;
  rows: SlowestRowDto[];
}

interface UserListItem {
  id: string;
  name?: string | null;
  email?: string | null;
}

interface CompanyListItem {
  id: string;
  name: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 0) ms = 0;
  const m = ms / 60000;
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  const d = h / 24;
  return `${d.toFixed(d < 10 ? 1 : 0)}d`;
}

function deltaPct(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

const RANGE_PRESETS: Record<string, number> = {
  "7": 7,
  "30": 30,
  "60": 60,
  "90": 90,
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function ResponseTimeTab() {
  const [rangeDays, setRangeDays] = useState<string>("30");
  const [businessHours, setBusinessHours] = useState<boolean>(true);
  const [accountId, setAccountId] = useState<string>("__all__");
  const [selectedRepIds, setSelectedRepIds] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<"day" | "week" | "month">("day");
  const [leaderSort, setLeaderSort] = useState<{ key: "avg" | "median" | "count" | "name"; dir: "asc" | "desc" }>({ key: "avg", dir: "asc" });
  const [selectedThread, setSelectedThread] = useState<ConversationThread | null>(null);

  // Build query params shared by all four endpoints
  const filterParams = useMemo(() => {
    const now = new Date();
    const days = RANGE_PRESETS[rangeDays] ?? 30;
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams();
    params.set("start", start.toISOString());
    params.set("end", new Date(now.getTime() + 60_000).toISOString());
    params.set("businessHours", String(businessHours));
    if (accountId && accountId !== "__all__") params.set("accountId", accountId);
    if (selectedRepIds.length) params.set("repIds", selectedRepIds.join(","));
    return params;
  }, [rangeDays, businessHours, accountId, selectedRepIds]);

  const filterKey = filterParams.toString();

  // ── Reps for filter ────────────────────────────────────────────────────────
  const { data: usersList } = useQuery<UserListItem[]>({ queryKey: ["/api/users"] });

  // ── Accounts for filter (lightweight — first 200) ─────────────────────────
  const { data: companiesData } = useQuery<{ companies: CompanyListItem[] } | CompanyListItem[]>({
    queryKey: ["/api/companies", { limit: 200 }],
    queryFn: async () => {
      const r = await fetch("/api/companies?limit=200");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 10 * 60 * 1000,
  });
  const companies: CompanyListItem[] = Array.isArray(companiesData)
    ? companiesData
    : (companiesData?.companies ?? []);

  // ── Data ───────────────────────────────────────────────────────────────────
  const kpis = useQuery<KpisResponse>({
    queryKey: ["/api/analytics/email-response-time/kpis", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/kpis?${filterKey}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const trendParams = useMemo(() => {
    const p = new URLSearchParams(filterParams);
    p.set("granularity", granularity);
    return p.toString();
  }, [filterParams, granularity]);

  const trend = useQuery<TimeseriesResponse>({
    queryKey: ["/api/analytics/email-response-time/timeseries", trendParams],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/timeseries?${trendParams}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const leaderboard = useQuery<LeaderboardResponse>({
    queryKey: ["/api/analytics/email-response-time/leaderboard", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/leaderboard?${filterKey}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const slowest = useQuery<SlowestResponse>({
    queryKey: ["/api/analytics/email-response-time/slowest", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/slowest?${filterKey}&limit=25`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const sortedLeaderboard = useMemo(() => {
    const rows = [...(leaderboard.data?.rows ?? [])];
    rows.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (leaderSort.key === "name") {
        av = a.ownerName ?? "";
        bv = b.ownerName ?? "";
      } else if (leaderSort.key === "count") {
        av = a.count;
        bv = b.count;
      } else if (leaderSort.key === "median") {
        av = a.medianMs ?? Number.POSITIVE_INFINITY;
        bv = b.medianMs ?? Number.POSITIVE_INFINITY;
      } else {
        av = a.avgMs ?? Number.POSITIVE_INFINITY;
        bv = b.avgMs ?? Number.POSITIVE_INFINITY;
      }
      if (av < bv) return leaderSort.dir === "asc" ? -1 : 1;
      if (av > bv) return leaderSort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [leaderboard.data, leaderSort]);

  const toggleSort = (key: typeof leaderSort.key) => {
    setLeaderSort((s) => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  };

  const handleOpenThread = (row: SlowestRowDto) => {
    // Build a minimal ConversationThread stub. The conversations messages
    // endpoint (`/api/internal/conversations/:id/messages`) accepts either a
    // real conversation row id or a `thread:<thread_id>` prefix — we use the
    // prefix form since we only have the raw thread id from the analytics
    // payload.
    const stub: ConversationThread = {
      id: `thread:${row.threadId}`,
      orgId: "",
      threadId: row.threadId,
      linkedAccountId: row.accountId,
      linkedCarrierId: null,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerName,
      waitingState: row.isWaiting ? "waiting_on_us" : "resolved",
      responsePriority: "normal",
      lastMessageId: null,
      lastIncomingAt: row.inboundAt,
      lastOutgoingAt: row.outboundAt,
      waitingSinceAt: row.isWaiting ? row.inboundAt : null,
      overdueAt: null,
      archivedAt: null,
      createdAt: row.inboundAt,
      updatedAt: row.outboundAt ?? row.inboundAt,
    };
    setSelectedThread(stub);
  };

  const repOptions: UserListItem[] = (usersList ?? []).filter((u) => u.id);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <Card data-testid="card-rt-filters">
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Filters</span>
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Range</Label>
            <Select value={rangeDays} onValueChange={setRangeDays}>
              <SelectTrigger className="h-8 w-[120px]" data-testid="select-rt-range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="h-8 w-[200px]" data-testid="select-rt-account">
                <SelectValue placeholder="All accounts" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All accounts</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8" data-testid="button-rt-reps">
                Reps {selectedRepIds.length > 0 && <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">{selectedRepIds.length}</Badge>}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-2">
              <div className="max-h-72 overflow-y-auto space-y-1">
                {repOptions.length === 0 && (
                  <div className="text-xs text-muted-foreground p-2">No reps available</div>
                )}
                {repOptions.map((u) => {
                  const checked = selectedRepIds.includes(u.id);
                  return (
                    <label key={u.id} className="flex items-center gap-2 text-sm px-2 py-1 hover:bg-muted/40 rounded cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          setSelectedRepIds((prev) =>
                            v ? [...prev, u.id] : prev.filter((id) => id !== u.id),
                          );
                        }}
                        data-testid={`checkbox-rt-rep-${u.id}`}
                      />
                      <span className="truncate">{u.name ?? u.email ?? u.id}</span>
                    </label>
                  );
                })}
              </div>
              {selectedRepIds.length > 0 && (
                <div className="border-t mt-2 pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs w-full"
                    onClick={() => setSelectedRepIds([])}
                    data-testid="button-rt-clear-reps"
                  >
                    Clear selection
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-2 ml-auto">
            <Switch
              id="rt-business-hours"
              checked={businessHours}
              onCheckedChange={setBusinessHours}
              data-testid="switch-rt-business-hours"
            />
            <Label htmlFor="rt-business-hours" className="text-xs cursor-pointer">
              Business hours only (M–F 8a–6p ET)
            </Label>
          </div>
        </CardContent>
      </Card>

      {/* ── KPI tiles ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(["today", "week", "month"] as const).map((bucket) => {
          const labelMap = { today: "Today", week: "Last 7 days", month: "Last 30 days" };
          const cur = kpis.data?.[bucket].current;
          const prior = kpis.data?.[bucket].prior;
          const dPct = deltaPct(cur?.avgMs ?? null, prior?.avgMs ?? null);
          const better = dPct != null && dPct < 0; // faster = better
          return (
            <Card key={bucket} data-testid={`card-rt-kpi-${bucket}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium">
                  <Clock className="w-4 h-4" />
                  {labelMap[bucket]}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {kpis.isLoading ? (
                  <Skeleton className="h-8 w-24" />
                ) : (
                  <>
                    <div className="flex items-end gap-2">
                      <span className="text-3xl font-bold" data-testid={`text-rt-kpi-${bucket}-avg`}>
                        {formatDuration(cur?.avgMs ?? null)}
                      </span>
                      {dPct != null && (
                        <span
                          className={`flex items-center text-xs font-medium ${better ? "text-emerald-500" : "text-red-500"}`}
                          data-testid={`text-rt-kpi-${bucket}-delta`}
                        >
                          {better ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />}
                          {Math.abs(dPct).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Median {formatDuration(cur?.medianMs ?? null)} · {cur?.count ?? 0} replies
                      {(cur?.waiting ?? 0) > 0 && (
                        <span className="text-amber-500 ml-2">· {cur?.waiting} waiting</span>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      Prior: {formatDuration(prior?.avgMs ?? null)} avg
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Trend chart ───────────────────────────────────────────────────── */}
      <Card data-testid="card-rt-trend">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Response time trend</CardTitle>
          <Select value={granularity} onValueChange={(v) => setGranularity(v as "day" | "week" | "month")}>
            <SelectTrigger className="h-7 w-[120px] text-xs" data-testid="select-rt-granularity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Daily</SelectItem>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {trend.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (trend.data?.points.length ?? 0) === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-muted-foreground" data-testid="text-rt-trend-empty">
              No replies in this range
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend.data!.points.map((p) => ({
                  bucket: p.bucket,
                  avg: p.avgMs == null ? null : Math.round(p.avgMs / 60000),
                  median: p.medianMs == null ? null : Math.round(p.medianMs / 60000),
                  count: p.count,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: "minutes", angle: -90, position: "insideLeft", fontSize: 11 }} />
                  <Tooltip
                    formatter={(v: number, name: string) => [`${v} min`, name === "avg" ? "Average" : "Median"]}
                    contentStyle={{ background: "#18181b", border: "1px solid #27272a", fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="avg" name="Average" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="median" name="Median" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Leaderboard ───────────────────────────────────────────────────── */}
      <Card data-testid="card-rt-leaderboard">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Per-rep leaderboard</CardTitle>
        </CardHeader>
        <CardContent>
          {leaderboard.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : sortedLeaderboard.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground" data-testid="text-rt-leaderboard-empty">
              No assigned-rep replies in this range
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("name")} data-testid="th-rt-name">Rep</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("avg")} data-testid="th-rt-avg">Avg</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("median")} data-testid="th-rt-median">Median</TableHead>
                  <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("count")} data-testid="th-rt-count">Replies</TableHead>
                  <TableHead className="text-right">Waiting</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLeaderboard.map((row) => (
                  <TableRow key={row.ownerUserId} data-testid={`row-rt-rep-${row.ownerUserId}`}>
                    <TableCell className="font-medium" data-testid={`text-rt-rep-name-${row.ownerUserId}`}>
                      {row.ownerName}
                    </TableCell>
                    <TableCell className="text-right" data-testid={`text-rt-rep-avg-${row.ownerUserId}`}>
                      {formatDuration(row.avgMs)}
                    </TableCell>
                    <TableCell className="text-right">{formatDuration(row.medianMs)}</TableCell>
                    <TableCell className="text-right">{row.count}</TableCell>
                    <TableCell className="text-right">
                      {row.waiting > 0 ? (
                        <Badge variant="outline" className="text-amber-500 border-amber-500/40">{row.waiting}</Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Slowest threads ───────────────────────────────────────────────── */}
      <Card data-testid="card-rt-slowest">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Slowest threads
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {slowest.isLoading ? (
            <div className="p-4"><Skeleton className="h-40 w-full" /></div>
          ) : (slowest.data?.rows.length ?? 0) === 0 ? (
            <div className="py-12 text-center" data-testid="text-rt-slowest-empty">
              <Inbox className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground">No slow threads</p>
              <p className="text-xs text-muted-foreground mt-1">All inbound emails replied to within range.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {slowest.data!.rows.map((row) => (
                <button
                  key={row.inboundId}
                  type="button"
                  onClick={() => handleOpenThread(row)}
                  className="w-full text-left px-4 py-3 hover:bg-muted/40 transition-colors flex items-start gap-3 cursor-pointer"
                  data-testid={`button-rt-slowest-${row.inboundId}`}
                >
                  <Mail className={`w-4 h-4 shrink-0 mt-0.5 ${row.isWaiting ? "text-amber-500" : "text-blue-400"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate" data-testid={`text-rt-slowest-subject-${row.inboundId}`}>
                        {row.subject ?? "(no subject)"}
                      </span>
                      {row.isWaiting && (
                        <Badge variant="outline" className="text-[10px] px-1.5 text-amber-500 border-amber-500/40">Waiting</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {row.accountName ?? row.fromEmail ?? "Unknown account"}
                      {row.ownerName && <span className="ml-1">· {row.ownerName}</span>}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(row.inboundAt), { addSuffix: true })}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-sm font-semibold ${row.isWaiting ? "text-amber-500" : "text-foreground"}`} data-testid={`text-rt-slowest-age-${row.inboundId}`}>
                      {formatDuration(row.ageMs)}
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground inline-block mt-0.5" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selectedThread && (
        <ThreadDetailPanel thread={selectedThread} onClose={() => setSelectedThread(null)} readOnly />
      )}
    </div>
  );
}
