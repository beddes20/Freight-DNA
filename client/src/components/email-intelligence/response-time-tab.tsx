/**
 * Response Time Tab — Email Intelligence (Tasks #414 + #602).
 *
 * Lets reps & leadership see how fast inbound customer emails get a reply.
 * Sections: filters, sync-freshness banner, "Right now" strip, KPI tiles
 * (today/week/month w/ deltas), trend chart, SLA compliance + outlier
 * accounts, response-time heatmap, per-rep leaderboard (incl. an
 * "Unattributed" bucket), slowest threads w/ owner + Assign actions, and
 * an admin-only Diagnostics expander.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  Clock, ArrowDown, ArrowUp, Filter, ChevronRight, Mail, Inbox, AlertTriangle,
  Activity, RefreshCw, ShieldAlert, Target, ChevronDown, UserPlus, UserCheck,
  Settings, Info,
} from "lucide-react";
import { formatDistanceToNow, formatDistanceToNowStrict } from "date-fns";
import { ThreadDetailPanel, type ConversationThread } from "@/pages/conversations";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";

const ADMIN_ROLES = new Set(["admin", "director", "national_account_manager", "sales_director"]);

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

interface WeeklyTrendPointDto {
  weekStart: string;
  isoYear: number;
  isoWeek: number;
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

interface WeeklyTrendResponse {
  businessHours: boolean;
  windowStart: string;
  windowEnd: string;
  points: WeeklyTrendPointDto[];
}

interface LeaderboardRowDto {
  ownerUserId: string;
  ownerName: string;
  count: number;
  waiting: number;
  avgMs: number | null;
  medianMs: number | null;
  unattributed?: boolean;
  /** Raw users.role value, populated by the leaderboard endpoint (Task #798). */
  role?: string | null;
  /**
   * Cohort used by the Customer Facing / Carrier Facing tabs (Task #798).
   * "customer" = NAM/AM, "carrier" = LM, null = Unattributed or other roles.
   */
  cohort?: "customer" | "carrier" | null;
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
  senderName: string | null;
  senderUserId: string | null;
  accountName: string | null;
  accountId: string | null;
  subject: string | null;
  fromEmail: string | null;
  unattributed: boolean;
}

interface SlowestResponse {
  businessHours: boolean;
  rows: SlowestRowDto[];
}

interface RightNowSnapshotDto {
  businessHours: boolean;
  oldestWaiting: SlowestRowDto | null;
  waitingTotal: number;
  waitingOver1h: number;
  waitingOver4h: number;
  waitingOver24h: number;
  topOverdueRep: { ownerUserId: string; ownerName: string; overdueCount: number } | null;
  generatedAt: string;
}

interface FreshnessDto {
  lastProviderSentAt: string | null;
  lastMailboxSyncAt: string | null;
  asOf: string | null;
  ageMs: number | null;
  stale: boolean;
}

interface SlaTargetDto {
  label: string;
  ms: number;
  businessHours: boolean;
}
interface SlaComplianceRow extends SlaTargetDto {
  total: number;
  withinTarget: number;
  pct: number;
}
interface SlaOutlierRow {
  accountId: string;
  accountName: string;
  count: number;
  medianMs: number;
  orgMedianMs: number;
  multiplier: number;
}
interface SlaResponse {
  businessHours: boolean;
  targets: SlaTargetDto[];
  compliance: SlaComplianceRow[];
  outliers: SlaOutlierRow[];
}

interface HeatmapCellDto { weekday: number; hour: number; count: number; medianMs: number | null }
interface HeatmapResponse { businessHours: boolean; cells: HeatmapCellDto[] }

interface DiagnosticsResponse {
  businessHours: boolean;
  windowStart: string;
  windowEnd: string;
  totalReplies: number;
  attributedToRep: number;
  attributedToOwnerFallback: number;
  unattributed: number;
  threadsWithoutOwner: number;
  usersInOrg: number;
  usersWithoutEmailUsername: number;
  topUnmatchedFromEmails: Array<{ fromEmail: string; count: number }>;
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

/**
 * Short label for an ISO-week trend point: "MMM D" of the Monday. Parsed
 * from the YYYY-MM-DD weekStart string so we don't slide the date by a day
 * in negative-UTC environments.
 */
function formatWeekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  if (!y || !m || !d) return weekStart;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dt);
}

// ─── Range presets ───────────────────────────────────────────────────────────

const BUSINESS_TZ = "America/New_York";

function getEtParts(d: Date): { y: number; m: number; day: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => fmt.find((p) => p.type === t)?.value ?? "";
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    day: Number(get("day")),
    weekday: wdMap[get("weekday")] ?? 0,
  };
}

function getEtTzOffsetMs(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(fmt.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const localMs = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return localMs - d.getTime();
}

function utcMsForEtMidnight(y: number, m: number, day: number): number {
  const probe = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
  const offset = getEtTzOffsetMs(probe);
  return Date.UTC(y, m - 1, day, 0, 0, 0) - offset;
}

function etPrevDay(y: number, m: number, day: number): { y: number; m: number; day: number } {
  const utcMid = Date.UTC(y, m - 1, day, 12, 0, 0);
  const prev = new Date(utcMid - 24 * 60 * 60 * 1000);
  return { y: prev.getUTCFullYear(), m: prev.getUTCMonth() + 1, day: prev.getUTCDate() };
}

function etPrevBusinessDay(y: number, m: number, day: number): { y: number; m: number; day: number } {
  let cur = etPrevDay(y, m, day);
  for (let i = 0; i < 7; i++) {
    const wd = getEtParts(new Date(utcMsForEtMidnight(cur.y, cur.m, cur.day) + 12 * 60 * 60 * 1000)).weekday;
    if (wd !== 0 && wd !== 6) return cur;
    cur = etPrevDay(cur.y, cur.m, cur.day);
  }
  return cur;
}

interface RangeWindow { start: Date; end: Date }

function computeRangeWindow(preset: string, now: Date = new Date()): RangeWindow {
  const et = getEtParts(now);
  if (preset === "today") {
    const start = new Date(utcMsForEtMidnight(et.y, et.m, et.day));
    return { start, end: new Date(now.getTime() + 60_000) };
  }
  if (preset === "yesterday") {
    const prev = etPrevBusinessDay(et.y, et.m, et.day);
    const start = new Date(utcMsForEtMidnight(prev.y, prev.m, prev.day));
    const utcMid = Date.UTC(prev.y, prev.m - 1, prev.day, 12, 0, 0);
    const next = new Date(utcMid + 24 * 60 * 60 * 1000);
    const end = new Date(utcMsForEtMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()));
    return { start, end };
  }
  const days = Number(preset) || 30;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end: new Date(now.getTime() + 60_000) };
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Component ───────────────────────────────────────────────────────────────

export default function ResponseTimeTab() {
  const { user } = useAuth();
  const isAdmin = !!user?.role && ADMIN_ROLES.has(user.role);
  const { toast } = useToast();

  const [rangeDays, setRangeDays] = useState<string>("30");
  const [businessHours, setBusinessHours] = useState<boolean>(true);
  const [accountId, setAccountId] = useState<string>("__all__");
  const [selectedRepIds, setSelectedRepIds] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<"day" | "week" | "month">("day");
  const [leaderSort, setLeaderSort] = useState<{ key: "avg" | "median" | "count" | "name"; dir: "asc" | "desc" }>({ key: "avg", dir: "asc" });
  // Per-rep leaderboard cohort tab (Task #798). Customer Facing = NAM/AM,
  // Carrier Facing = LM. Not persisted across reloads — leadership tends
  // to bounce between cohorts in a single session.
  const [leaderTab, setLeaderTab] = useState<"customer" | "carrier">("customer");
  const [selectedThread, setSelectedThread] = useState<ConversationThread | null>(null);
  const [unattributedOnly, setUnattributedOnly] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [slaEditOpen, setSlaEditOpen] = useState(false);

  // Build query params shared by all four endpoints
  const filterParams = useMemo(() => {
    const { start, end } = computeRangeWindow(rangeDays);
    const params = new URLSearchParams();
    params.set("start", start.toISOString());
    params.set("end", end.toISOString());
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

  // Sync freshness — drives the "Data as of …" label and the yellow banner
  // when ingest is more than 15 minutes behind.
  const freshness = useQuery<FreshnessDto>({
    queryKey: ["/api/analytics/email-response-time/freshness"],
    queryFn: async () => {
      const r = await fetch("/api/analytics/email-response-time/freshness");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Right-now strip — auto-refresh every 60s independently of the range
  // selection so the "live" feel doesn't require leadership to keep
  // re-clicking the filter.
  const rightNow = useQuery<RightNowSnapshotDto>({
    queryKey: ["/api/analytics/email-response-time/right-now", String(businessHours)],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/right-now?businessHours=${businessHours}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
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

  // Weekly median + p90 for the selected window. Honors the page-level
  // business-hours toggle and all other filters (range, account, reps) via
  // the shared filterKey.
  const weeklyTrend = useQuery<WeeklyTrendResponse>({
    queryKey: ["/api/analytics/email-response-time/trend", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/trend?${filterKey}`);
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

  const slowestKey = `${filterKey}&unattributedOnly=${unattributedOnly}`;
  const slowest = useQuery<SlowestResponse>({
    queryKey: ["/api/analytics/email-response-time/slowest", slowestKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/slowest?${slowestKey}&limit=25`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const sla = useQuery<SlaResponse>({
    queryKey: ["/api/analytics/email-response-time/sla", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/sla?${filterKey}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const heatmap = useQuery<HeatmapResponse>({
    queryKey: ["/api/analytics/email-response-time/heatmap", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/heatmap?${filterKey}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    staleTime: 60_000,
  });

  const diagnostics = useQuery<DiagnosticsResponse>({
    queryKey: ["/api/analytics/email-response-time/diagnostics", filterKey],
    queryFn: async () => {
      const r = await fetch(`/api/analytics/email-response-time/diagnostics?${filterKey}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: isAdmin && diagnosticsOpen,
    staleTime: 60_000,
  });

  const assignOwner = useMutation({
    mutationFn: async (vars: { threadId: string; ownerUserId: string | null }) => {
      const r = await apiRequest(
        "PUT",
        `/api/analytics/email-response-time/thread-owner/${encodeURIComponent(vars.threadId)}`,
        { ownerUserId: vars.ownerUserId },
      );
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/email-response-time/slowest"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/email-response-time/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/email-response-time/diagnostics"] });
      toast({ title: "Owner updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to assign", description: err.message, variant: "destructive" });
    },
  });

  const sortedLeaderboard = useMemo(() => {
    const rows = [...(leaderboard.data?.rows ?? [])];
    rows.sort((a, b) => {
      // Always pin Unattributed to the bottom regardless of column sort.
      if (a.unattributed && !b.unattributed) return 1;
      if (!a.unattributed && b.unattributed) return -1;
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

  // Split the sorted rows into cohort tabs (Task #798). The Unattributed
  // synthetic row appears in BOTH tabs since unattributed replies could
  // belong to either cohort, and the existing pin-to-bottom sort in
  // sortedLeaderboard keeps it last in each tab.
  const customerLeaderboard = useMemo(
    () => sortedLeaderboard.filter((r) => r.unattributed || r.cohort === "customer"),
    [sortedLeaderboard],
  );
  const carrierLeaderboard = useMemo(
    () => sortedLeaderboard.filter((r) => r.unattributed || r.cohort === "carrier"),
    [sortedLeaderboard],
  );

  // Renders the leaderboard table for one cohort tab. Extracted so the
  // header/sort/freshness chrome around the table can stay shared while
  // the body changes per tab (Task #798).
  const renderLeaderboardTable = (rows: LeaderboardRowDto[], cohort: "customer" | "carrier") => {
    if (rows.length === 0) {
      return (
        <div
          className="py-8 text-center text-sm text-muted-foreground"
          data-testid={`text-rt-leaderboard-empty-${cohort}`}
        >
          No replies in this range
        </div>
      );
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="cursor-pointer" onClick={() => toggleSort("name")} data-testid="th-rt-name">Rep</TableHead>
            <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("avg")} data-testid="th-rt-avg">
              <span className="inline-flex items-center gap-1 justify-end">
                Avg
                <UITooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center justify-center p-1 -m-1 text-muted-foreground hover:text-foreground"
                      aria-label="Avg column info"
                      data-testid="tooltip-trigger-rt-avg"
                    >
                      <Info className="w-3 h-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs" data-testid="tooltip-rt-avg">
                    Average reply time using {businessHours
                      ? "business hours only (Mon–Fri 8a–6p ET)"
                      : "wall-clock elapsed time"}.
                  </TooltipContent>
                </UITooltip>
              </span>
            </TableHead>
            <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("median")} data-testid="th-rt-median">
              <span className="inline-flex items-center gap-1 justify-end">
                Median
                <UITooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center justify-center p-1 -m-1 text-muted-foreground hover:text-foreground"
                      aria-label="Median column info"
                      data-testid="tooltip-trigger-rt-median"
                    >
                      <Info className="w-3 h-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs text-xs" data-testid="tooltip-rt-median">
                    Median reply time using {businessHours
                      ? "business hours only (Mon–Fri 8a–6p ET)"
                      : "wall-clock elapsed time"}.
                  </TooltipContent>
                </UITooltip>
              </span>
            </TableHead>
            <TableHead className="cursor-pointer text-right" onClick={() => toggleSort("count")} data-testid="th-rt-count">Replies</TableHead>
            <TableHead className="text-right">Waiting</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody data-testid={`tbody-rt-leaderboard-${cohort}`}>
          {rows.map((row) => {
            const clickable = row.unattributed;
            return (
              <TableRow
                key={row.ownerUserId}
                className={clickable ? "cursor-pointer hover:bg-muted/40" : undefined}
                onClick={clickable ? () => handleLeaderboardRowClick(row) : undefined}
                data-testid={`row-rt-rep-${row.ownerUserId}`}
              >
                <TableCell className="font-medium" data-testid={`text-rt-rep-name-${row.ownerUserId}`}>
                  {row.ownerName}
                  {row.unattributed && (
                    <Badge variant="outline" className="ml-2 text-[10px] text-amber-400 border-amber-400/40">
                      unattributed · click to triage
                    </Badge>
                  )}
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
            );
          })}
        </TableBody>
      </Table>
    );
  };

  const handleOpenThread = (row: SlowestRowDto) => {
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

  const handleLeaderboardRowClick = (row: LeaderboardRowDto) => {
    if (row.unattributed) {
      // Drill straight into the unattributed slowest list — that's what the
      // row actually represents and the most useful follow-up action.
      setUnattributedOnly(true);
      requestAnimationFrame(() => {
        document.getElementById("rt-slowest-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  const repOptions: UserListItem[] = (usersList ?? []).filter((u) => u.id);

  return (
    <div className="space-y-4 md:space-y-6">
      {/* ── Sync freshness banner (only when stale) ─────────────────────────── */}
      {freshness.data?.stale && (
        <div
          className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-2 text-sm text-amber-100 flex items-center gap-2"
          data-testid="banner-rt-stale"
        >
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          Inbox data may be behind ·
          <span className="font-medium">
            {freshness.data.asOf
              ? `last sync ${formatDistanceToNowStrict(new Date(freshness.data.asOf), { addSuffix: true })}`
              : "no recent sync"}
          </span>
        </div>
      )}

      {/* ── Right now strip ─────────────────────────────────────────────────── */}
      <Card data-testid="card-rt-rightnow">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Activity className="w-4 h-4 text-emerald-400" />
              Right now
              <span className="text-xs text-muted-foreground font-normal">
                Auto-refresh · {businessHours ? "biz hours" : "wall-clock"}
              </span>
            </div>
            {rightNow.isLoading ? (
              <Skeleton className="h-6 w-64" />
            ) : (
              <>
                <div className="text-xs">
                  <span className="text-muted-foreground">Waiting</span>{" "}
                  <span className="font-semibold" data-testid="text-rt-rn-waiting">{rightNow.data?.waitingTotal ?? 0}</span>
                </div>
                <div className="text-xs">
                  <span className="text-muted-foreground">&gt;1h</span>{" "}
                  <span className={`font-semibold ${(rightNow.data?.waitingOver1h ?? 0) > 0 ? "text-amber-400" : ""}`} data-testid="text-rt-rn-over1h">
                    {rightNow.data?.waitingOver1h ?? 0}
                  </span>
                </div>
                <div className="text-xs">
                  <span className="text-muted-foreground">&gt;4h</span>{" "}
                  <span className={`font-semibold ${(rightNow.data?.waitingOver4h ?? 0) > 0 ? "text-orange-400" : ""}`} data-testid="text-rt-rn-over4h">
                    {rightNow.data?.waitingOver4h ?? 0}
                  </span>
                </div>
                <div className="text-xs">
                  <span className="text-muted-foreground">&gt;24h</span>{" "}
                  <span className={`font-semibold ${(rightNow.data?.waitingOver24h ?? 0) > 0 ? "text-red-400" : ""}`} data-testid="text-rt-rn-over24h">
                    {rightNow.data?.waitingOver24h ?? 0}
                  </span>
                </div>
                {rightNow.data?.oldestWaiting && (
                  <button
                    type="button"
                    onClick={() => handleOpenThread(rightNow.data!.oldestWaiting!)}
                    className="text-xs hover:underline text-left"
                    data-testid="button-rt-rn-oldest"
                  >
                    <span className="text-muted-foreground">Oldest:</span>{" "}
                    <span className="font-medium">{formatDuration(rightNow.data.oldestWaiting.ageMs)}</span>{" "}
                    · {rightNow.data.oldestWaiting.accountName ?? rightNow.data.oldestWaiting.fromEmail ?? "Unknown"}
                  </button>
                )}
                {rightNow.data?.topOverdueRep && (
                  <div className="text-xs ml-auto">
                    <ShieldAlert className="w-3 h-3 inline-block mr-1 text-orange-400" />
                    <span className="text-muted-foreground">Most overdue:</span>{" "}
                    <span className="font-medium" data-testid="text-rt-rn-top-rep">
                      {rightNow.data.topOverdueRep.ownerName} ({rightNow.data.topOverdueRep.overdueCount})
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>

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
              <SelectTrigger className="h-8 w-[140px]" data-testid="select-rt-range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="yesterday">Yesterday</SelectItem>
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
                  {freshness.data?.asOf && (
                    <span
                      className={`ml-auto text-[10px] font-normal ${freshness.data.stale ? "text-amber-400" : "text-muted-foreground"}`}
                      data-testid={`text-rt-asof-${bucket}`}
                    >
                      Data as of {formatDistanceToNowStrict(new Date(freshness.data.asOf), { addSuffix: true })}
                    </span>
                  )}
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

      {/* ── SLA + outliers ──────────────────────────────────────────────────── */}
      <Card data-testid="card-rt-sla">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Target className="w-4 h-4 text-emerald-400" />
            SLA compliance
          </CardTitle>
          {isAdmin && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setSlaEditOpen((v) => !v)}
              data-testid="button-rt-sla-edit"
            >
              <Settings className="w-3 h-3 mr-1" /> Edit targets
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {sla.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {sla.data?.compliance.map((t) => {
                  const passing = t.pct >= 90;
                  const barColor = passing ? "bg-emerald-500" : t.pct >= 75 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <div key={t.label} className="border rounded-md p-3 space-y-1" data-testid={`tile-rt-sla-${t.label}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">≤ {t.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {t.withinTarget}/{t.total}
                        </span>
                      </div>
                      <div className="text-2xl font-semibold" data-testid={`text-rt-sla-pct-${t.label}`}>
                        {t.total === 0 ? "—" : `${t.pct.toFixed(0)}%`}
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full ${barColor}`} style={{ width: `${Math.min(100, t.pct)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              {slaEditOpen && isAdmin && (
                <SlaEditor
                  initialTargets={sla.data?.targets ?? []}
                  onSaved={() => { setSlaEditOpen(false); sla.refetch(); }}
                />
              )}
              {(sla.data?.outliers.length ?? 0) > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2">Slowest accounts (≥2× org median)</div>
                  <div className="divide-y divide-border border rounded-md">
                    {sla.data!.outliers.slice(0, 5).map((o) => (
                      <button
                        key={o.accountId}
                        type="button"
                        onClick={() => setAccountId(o.accountId)}
                        className="w-full text-left px-3 py-2 hover:bg-muted/40 flex items-center gap-3"
                        data-testid={`button-rt-outlier-${o.accountId}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{o.accountName}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {o.count} replies · median {formatDuration(o.medianMs)}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-orange-400 border-orange-400/40">
                          {o.multiplier.toFixed(1)}× slower
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

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

      {/* ── Weekly trend (median + p90) ─────────────────────────────────────── */}
      <Card data-testid="card-rt-weekly-trend">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            Trend
            <span className="text-xs text-muted-foreground font-normal">
              Median &amp; p90 by ISO-week · {businessHours ? "biz hours" : "wall-clock"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {weeklyTrend.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (weeklyTrend.data?.points.length ?? 0) === 0 ? (
            <div
              className="h-64 flex items-center justify-center text-sm text-muted-foreground"
              data-testid="text-rt-weekly-trend-empty"
            >
              No replies in this range
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={weeklyTrend.data!.points.map((p) => ({
                    weekStart: p.weekStart,
                    label: formatWeekLabel(p.weekStart),
                    isoWeek: p.isoWeek,
                    isoYear: p.isoYear,
                    count: p.count,
                    median: p.medianMs == null ? null : Math.round(p.medianMs / 60000),
                    p90: p.p90Ms == null ? null : Math.round(p.p90Ms / 60000),
                    medianRawMs: p.medianMs,
                    p90RawMs: p.p90Ms,
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    label={{ value: "minutes", angle: -90, position: "insideLeft", fontSize: 11 }}
                  />
                  <Tooltip
                    content={(props) => {
                      if (!props.active || !props.payload?.length) return null;
                      const row = props.payload[0].payload as {
                        label: string; isoYear: number; isoWeek: number; count: number;
                        medianRawMs: number | null; p90RawMs: number | null;
                      };
                      return (
                        <div
                          className="rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-md"
                          data-testid="tooltip-rt-weekly-trend"
                        >
                          <div className="font-medium">
                            Week of {row.label}{" "}
                            <span className="text-muted-foreground font-normal">
                              · {row.isoYear}-W{String(row.isoWeek).padStart(2, "0")}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                            <span className="text-muted-foreground">Median</span>
                            <span className="ml-auto font-medium">{formatDuration(row.medianRawMs)}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
                            <span className="text-muted-foreground">p90</span>
                            <span className="ml-auto font-medium">{formatDuration(row.p90RawMs)}</span>
                          </div>
                          <div className="mt-1 text-muted-foreground">
                            {row.count} {row.count === 1 ? "reply" : "replies"}
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="median" name="Median" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="p90" name="p90" stroke="#fb923c" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Heatmap (DoW × hour, ET) ────────────────────────────────────────── */}
      <Card data-testid="card-rt-heatmap">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Response time heatmap (ET)</CardTitle>
        </CardHeader>
        <CardContent>
          {heatmap.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Heatmap cells={heatmap.data?.cells ?? []} />
          )}
        </CardContent>
      </Card>

      {/* ── Leaderboard ───────────────────────────────────────────────────── */}
      <Card data-testid="card-rt-leaderboard">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2 flex-wrap">
            <span>Per-rep leaderboard</span>
            <span
              className="text-xs text-muted-foreground font-normal"
              data-testid="text-rt-leaderboard-clock"
            >
              · {businessHours
                ? "Business hours (M–F 8a–6p ET)"
                : "Wall-clock"}
            </span>
            {freshness.data?.asOf && (
              <span
                className={`ml-auto text-[10px] font-normal ${freshness.data.stale ? "text-amber-400" : "text-muted-foreground"}`}
                data-testid="text-rt-leaderboard-asof"
              >
                Data as of {formatDistanceToNowStrict(new Date(freshness.data.asOf), { addSuffix: true })}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {leaderboard.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <TooltipProvider delayDuration={200}>
              <Tabs
                value={leaderTab}
                onValueChange={(v) => setLeaderTab(v as "customer" | "carrier")}
              >
                <TabsList className="mb-3" data-testid="tabs-rt-leaderboard">
                  <TabsTrigger value="customer" data-testid="tab-rt-leaderboard-customer">
                    Customer Facing
                  </TabsTrigger>
                  <TabsTrigger value="carrier" data-testid="tab-rt-leaderboard-carrier">
                    Carrier Facing
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="customer" data-testid="tab-content-rt-leaderboard-customer">
                  {renderLeaderboardTable(customerLeaderboard, "customer")}
                </TabsContent>
                <TabsContent value="carrier" data-testid="tab-content-rt-leaderboard-carrier">
                  {renderLeaderboardTable(carrierLeaderboard, "carrier")}
                </TabsContent>
              </Tabs>
            </TooltipProvider>
          )}
        </CardContent>
      </Card>

      {/* ── Slowest threads ───────────────────────────────────────────────── */}
      <Card data-testid="card-rt-slowest" id="rt-slowest-section">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Slowest threads
            {unattributedOnly && (
              <Badge variant="outline" className="text-[10px] text-amber-400 border-amber-400/40">
                Unattributed only
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Switch
              id="rt-unattributed-only"
              checked={unattributedOnly}
              onCheckedChange={setUnattributedOnly}
              data-testid="switch-rt-unattributed-only"
            />
            <Label htmlFor="rt-unattributed-only" className="text-xs cursor-pointer">
              Unattributed only
            </Label>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {slowest.isLoading ? (
            <div className="p-4"><Skeleton className="h-40 w-full" /></div>
          ) : (slowest.data?.rows.length ?? 0) === 0 ? (
            <div className="py-12 text-center" data-testid="text-rt-slowest-empty">
              <Inbox className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground">
                {unattributedOnly ? "No unattributed threads" : "No slow threads"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {unattributedOnly ? "Every reply was credited to a rep." : "All inbound emails replied to within range."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {slowest.data!.rows.map((row) => {
                const ownerLabel = row.ownerName ?? (row.ownerUserId ? "Assigned" : null);
                const senderLabel = row.senderName && row.senderUserId !== row.ownerUserId ? row.senderName : null;
                return (
                  <div
                    key={row.inboundId}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                    data-testid={`row-rt-slowest-${row.inboundId}`}
                  >
                    <button
                      type="button"
                      onClick={() => handleOpenThread(row)}
                      className="flex items-start gap-3 flex-1 min-w-0 text-left"
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
                          {row.unattributed && (
                            <Badge variant="outline" className="text-[10px] px-1.5 text-amber-400 border-amber-400/40">
                              {row.isWaiting ? "no owner" : "unattributed"}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 truncate">
                          {row.accountName ?? row.fromEmail ?? "Unknown account"}
                          {ownerLabel && <span className="ml-1">· owner: {ownerLabel}</span>}
                          {senderLabel && <span className="ml-1">· last reply: {senderLabel}</span>}
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
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      {user && row.ownerUserId !== user.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={assignOwner.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            assignOwner.mutate({ threadId: row.threadId, ownerUserId: user.id });
                          }}
                          data-testid={`button-rt-assign-me-${row.inboundId}`}
                        >
                          <UserPlus className="w-3 h-3 mr-1" /> Assign me
                        </Button>
                      )}
                      {isAdmin && (
                        <ReassignPopover
                          users={repOptions}
                          currentOwnerId={row.ownerUserId}
                          isPending={assignOwner.isPending}
                          onAssign={(uid) => assignOwner.mutate({ threadId: row.threadId, ownerUserId: uid })}
                          testId={`reassign-${row.inboundId}`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Diagnostics (admin only) ────────────────────────────────────────── */}
      {isAdmin && (
        <Collapsible open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen}>
          <Card data-testid="card-rt-diagnostics">
            <CollapsibleTrigger asChild>
              <button type="button" className="w-full text-left" data-testid="button-rt-diagnostics-toggle">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Activity className="w-4 h-4" /> Attribution diagnostics
                    <Badge variant="outline" className="text-[10px]">admin</Badge>
                  </CardTitle>
                  <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${diagnosticsOpen ? "rotate-180" : ""}`} />
                </CardHeader>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-4">
                {diagnostics.isLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : diagnostics.data ? (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <DiagStat label="Total replies" value={diagnostics.data.totalReplies} />
                      <DiagStat label="Attributed (sender)" value={diagnostics.data.attributedToRep} />
                      <DiagStat label="Owner fallback" value={diagnostics.data.attributedToOwnerFallback} />
                      <DiagStat label="Unattributed" value={diagnostics.data.unattributed} highlight />
                      <DiagStat label="Threads w/o owner" value={diagnostics.data.threadsWithoutOwner} />
                      <DiagStat label="Users in org" value={diagnostics.data.usersInOrg} />
                      <DiagStat label="Users w/o email username" value={diagnostics.data.usersWithoutEmailUsername} highlight={diagnostics.data.usersWithoutEmailUsername > 0} />
                    </div>
                    {diagnostics.data.topUnmatchedFromEmails.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-muted-foreground mb-2">Top unmatched from-emails</div>
                        <div className="border rounded-md divide-y divide-border">
                          {diagnostics.data.topUnmatchedFromEmails.map((row) => (
                            <div key={row.fromEmail} className="px-3 py-2 text-xs flex items-center justify-between">
                              <span className="font-mono truncate">{row.fromEmail}</span>
                              <Badge variant="outline">{row.count}</Badge>
                            </div>
                          ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-2">
                          Add these as monitored mailboxes (or update users.username) to credit them to the right rep.
                        </p>
                      </div>
                    )}
                  </>
                ) : null}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      )}

      {selectedThread && (
        <ThreadDetailPanel thread={selectedThread} onClose={() => setSelectedThread(null)} readOnly />
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DiagStat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="border rounded-md p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${highlight && value > 0 ? "text-amber-400" : ""}`} data-testid={`stat-rt-diag-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function ReassignPopover({
  users, currentOwnerId, isPending, onAssign, testId,
}: {
  users: UserListItem[];
  currentOwnerId: string | null;
  isPending: boolean;
  onAssign: (userId: string | null) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={isPending}
          onClick={(e) => e.stopPropagation()}
          data-testid={`button-rt-${testId}`}
        >
          <UserCheck className="w-3 h-3 mr-1" /> Reassign
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="max-h-64 overflow-y-auto space-y-0.5">
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`w-full text-left text-xs px-2 py-1 rounded hover:bg-muted/40 ${u.id === currentOwnerId ? "bg-muted/30 font-medium" : ""}`}
              onClick={() => { onAssign(u.id); setOpen(false); }}
              data-testid={`button-rt-${testId}-pick-${u.id}`}
            >
              {u.name ?? u.email ?? u.id}
            </button>
          ))}
          <div className="border-t mt-1 pt-1">
            <button
              type="button"
              className="w-full text-left text-xs px-2 py-1 rounded hover:bg-muted/40 text-muted-foreground"
              onClick={() => { onAssign(null); setOpen(false); }}
              data-testid={`button-rt-${testId}-unassign`}
            >
              Unassign
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SlaEditor({
  initialTargets, onSaved,
}: { initialTargets: SlaTargetDto[]; onSaved: () => void }) {
  const { toast } = useToast();
  const [targets, setTargets] = useState<SlaTargetDto[]>(initialTargets.length ? initialTargets : [
    { label: "1h", ms: 60 * 60 * 1000, businessHours: true },
    { label: "4h", ms: 4 * 60 * 60 * 1000, businessHours: true },
    { label: "24h", ms: 24 * 60 * 60 * 1000, businessHours: true },
  ]);
  useEffect(() => {
    if (initialTargets.length) setTargets(initialTargets);
  }, [initialTargets]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PUT", "/api/analytics/email-response-time/sla", { targets });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/email-response-time/sla"] });
      toast({ title: "SLA targets saved" });
      onSaved();
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="border rounded-md p-3 space-y-2 bg-muted/20" data-testid="panel-rt-sla-editor">
      <div className="text-xs font-medium text-muted-foreground">Edit SLA targets (org-wide)</div>
      {targets.map((t, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={t.label}
            onChange={(e) => setTargets((prev) => prev.map((x, idx) => idx === i ? { ...x, label: e.target.value } : x))}
            className="h-7 w-20 text-xs"
            data-testid={`input-rt-sla-label-${i}`}
          />
          <Input
            type="number"
            min={1}
            value={Math.round(t.ms / 60000)}
            onChange={(e) => setTargets((prev) => prev.map((x, idx) => idx === i ? { ...x, ms: Math.max(60_000, Number(e.target.value || 0) * 60_000) } : x))}
            className="h-7 w-24 text-xs"
            data-testid={`input-rt-sla-ms-${i}`}
          />
          <span className="text-xs text-muted-foreground">min</span>
          <label className="flex items-center gap-1 text-xs">
            <Checkbox
              checked={t.businessHours}
              onCheckedChange={(v) => setTargets((prev) => prev.map((x, idx) => idx === i ? { ...x, businessHours: !!v } : x))}
              data-testid={`checkbox-rt-sla-biz-${i}`}
            />
            biz hrs
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs ml-auto"
            onClick={() => setTargets((prev) => prev.filter((_, idx) => idx !== i))}
            data-testid={`button-rt-sla-remove-${i}`}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setTargets((p) => [...p, { label: `${p.length + 1}h`, ms: (p.length + 1) * 60 * 60 * 1000, businessHours: true }])}
          disabled={targets.length >= 6}
          data-testid="button-rt-sla-add"
        >
          + Add target
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs ml-auto"
          onClick={() => save.mutate()}
          disabled={save.isPending || targets.length === 0}
          data-testid="button-rt-sla-save"
        >
          {save.isPending ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : null}
          Save targets
        </Button>
      </div>
    </div>
  );
}

function Heatmap({ cells }: { cells: HeatmapCellDto[] }) {
  // Find the max median for a simple linear color scale; if no data, render
  // an empty-state.
  const populated = cells.filter((c) => c.medianMs != null && c.count > 0);
  if (populated.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-muted-foreground" data-testid="text-rt-heatmap-empty">
        Not enough replies in this range to draw a heatmap.
      </div>
    );
  }
  const maxMs = Math.max(...populated.map((c) => c.medianMs!));

  function cellColor(ms: number | null, count: number): string {
    if (ms == null || count === 0) return "rgba(63,63,70,0.25)";
    // Faster = greener, slower = redder. Linear interpolation in HSL.
    const ratio = Math.min(1, ms / maxMs);
    const hue = 140 - ratio * 140; // 140 (green) → 0 (red)
    const sat = 60;
    const light = 35 + (1 - ratio) * 15;
    return `hsl(${hue}, ${sat}%, ${light}%)`;
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div className="grid" style={{ gridTemplateColumns: "40px repeat(24, 1fr)" }}>
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-[10px] text-muted-foreground text-center">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
          {DOW_LABELS.map((dow, wd) => (
            <div key={wd} className="contents">
              <div className="text-[10px] text-muted-foreground pr-2 self-center text-right">{dow}</div>
              {Array.from({ length: 24 }, (_, h) => {
                const cell = cells.find((c) => c.weekday === wd && c.hour === h);
                const color = cellColor(cell?.medianMs ?? null, cell?.count ?? 0);
                const title = cell && cell.count > 0
                  ? `${dow} ${h}:00 — median ${formatDuration(cell.medianMs)} · ${cell.count} replies`
                  : `${dow} ${h}:00 — no replies`;
                return (
                  <div
                    key={h}
                    className="aspect-square m-[1px] rounded-sm"
                    style={{ background: color }}
                    title={title}
                    data-testid={`cell-rt-heatmap-${wd}-${h}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div className="text-[10px] text-muted-foreground mt-2 flex items-center gap-2">
          <span>Faster</span>
          <div className="flex">
            {[0, 0.25, 0.5, 0.75, 1].map((r) => (
              <div key={r} className="w-6 h-3" style={{ background: `hsl(${140 - r * 140}, 60%, ${35 + (1 - r) * 15}%)` }} />
            ))}
          </div>
          <span>Slower</span>
          <span className="ml-auto">Hours of day (ET)</span>
        </div>
      </div>
    </div>
  );
}
