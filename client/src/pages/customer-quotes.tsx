import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Search, Download, RefreshCw, Bookmark, X, ArrowUp, ArrowDown,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Hourglass, Trophy,
  Trash2, Plus, ChevronsUpDown, Check, ChevronLeft, ChevronRight,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  LineChart, Line, CartesianGrid,
} from "recharts";
import { useToast } from "@/hooks/use-toast";

// ---------- Types (mirror server contract) ----------
type Quote = {
  id: string;
  organizationId: string;
  customerId: string; customerName: string;
  repId: string | null; repName: string;
  carrierId: string | null; carrierName: string | null;
  outcomeReasonId: string | null; outcomeReasonLabel: string | null;
  requestDate: string;
  originCity: string; originState: string;
  destCity: string; destState: string;
  equipment: string;
  quotedAmount: string | null;
  validThrough: string | null;
  outcomeStatus: string;
  carrierPaid: string | null;
  responseTimeHours: string | null;
  source: string; sourceReference: string | null;
  notes: string | null;
  score: string | null;
};

type ListResult = { rows: Quote[]; total: number; offset: number; limit: number };

type Customer = { id: string; organizationId: string; name: string; segment: string | null };
type Rep = { id: string; organizationId: string; name: string; email: string | null };
type Reason = { id: string; organizationId: string; code: string; label: string; category: string };
type LaneGroup = { id: string; organizationId: string; name: string };
type Carrier = { id: string; organizationId: string; name: string };

type Trend = { winRate: number; total: number; avgMargin: number; avgResponse: number };

type CustomerPerformance = {
  customer: Customer;
  winCount: number; lossCount: number;
  avgQuoted: number; avgCarrierBuy: number;
  topLanes: { lane: string; total: number; won: number; quoted: number; paid: number }[];
  topLossReasons: { reason: string; count: number }[];
};

type LaneVarianceItem = {
  lane: string; min: number; max: number; spread: number; spreadPct: number;
  breakdown: { rep: string; avg: number }[];
};

type AttractivenessLabel = "Pursue Aggressively" | "Good Freight" | "Selective" | "Low Quality";
type AttractivenessItem = {
  customer: string; lane: string; total: number; won: number;
  winRate: number; avgMargin: number; label: AttractivenessLabel;
};

type AlertSeverity = "high" | "medium" | "low";
type Alert = {
  id: string; severity: AlertSeverity; type: string;
  title: string; detail: string;
  data?: { lane?: string; customerId?: string; quoteId?: string; startDate?: string };
};

type StaleFollowUpItem = {
  quoteId: string;
  customerId: string;
  customerName: string;
  lane: string;
  ageHours: number;
  pTypicalHours: number;
  hoursOverdue: number;
  quotedAmount: number;
  estimatedMargin: number;
  repName: string | null;
};

type Snapshot = {
  total: number;
  kpis: {
    total: number; won: number; lost: number; winRate: number;
    avgQuoted: number; avgCarrierCost: number;
    avgMarginDollar: number; avgMarginPct: number;
    avgResponseTime: number; pending: number; expiringSoon: number;
    trend: Trend;
  };
  customers: Customer[];
  reps: Rep[];
  reasons: Reason[];
  laneGroups: LaneGroup[];
  carriers: Carrier[];
  customerPerformance: CustomerPerformance | null;
  taxonomy: Record<string, number>;
  validityWindow: {
    expiringList: { id: string; lane: string; customer: string; validThrough: string; quotedAmount: number }[];
    agingBuckets: Record<string, number>;
    staleCount: number; activeCount: number; expiredCount: number;
  };
  laneVariance: LaneVarianceItem[];
  attractiveness: AttractivenessItem[];
  staleFollowUps: StaleFollowUpItem[];
  charts: {
    trend: { date: string; total: number; won: number; lost: number }[];
    winRateByCustomer: { customer: string; winRate: number; total: number }[];
    marginByCustomer: { customer: string; avgMargin: number; won: number }[];
    topLanes: { lane: string; total: number; won: number }[];
    highVolLowWin: { lane: string; total: number; won: number }[];
  };
  alerts: Alert[];
};

type Filters = {
  customerId?: string;
  startDate?: string;
  endDate?: string;
  equipment?: string;
  repId?: string;
  outcomeStatus?: string;
  outcomeReasonId?: string;
  laneSearch?: string;
  wonOnly?: boolean;
  activeOnly?: boolean;
  lostOnly?: boolean;
  expiringOnly?: boolean;
};

type SortKey =
  | "requestDate" | "customerName" | "originCity" | "destCity" | "equipment"
  | "quotedAmount" | "validThrough" | "outcomeStatus" | "outcomeReasonLabel"
  | "carrierPaid" | "marginDollar" | "marginPct" | "repName" | "responseTimeHours"
  | "source" | "score";

type SavedView = { id: string; name: string; filters: Filters; createdAt: string };

type QuoteEvent = {
  id: string; quoteId: string; eventType: string; occurredAt: string;
  actor: string | null; payload: Record<string, unknown> | null;
};

type QuoteDetail = {
  opp: Quote;
  events: QuoteEvent[];
  customer: Customer | null;
  rep: Rep | null;
  carrier: Carrier | null;
  reason: Reason | null;
  relatedSameLane: Quote[];
  relatedSameCustomer: Quote[];
  relatedSameLaneGroup: Quote[];
};

// ---------- Constants ----------
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending", won: "Won", won_low_margin: "Won (low margin)",
  lost_price: "Lost — price", lost_service: "Lost — service",
  lost_timing: "Lost — timing", lost_incumbent: "Lost — incumbent",
  no_response: "No response", expired: "Expired",
};
const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  won: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  won_low_margin: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
  lost_price: "bg-red-500/15 text-red-300 border-red-500/30",
  lost_service: "bg-red-500/15 text-red-300 border-red-500/30",
  lost_timing: "bg-red-500/15 text-red-300 border-red-500/30",
  lost_incumbent: "bg-red-500/15 text-red-300 border-red-500/30",
  no_response: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  expired: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
};
const ALL_STATUSES = Object.keys(STATUS_LABELS);
// Spec: 8-bucket outcome taxonomy — final outcomes only, excludes "pending" (an active state).
const OUTCOME_BUCKETS = ["won", "won_low_margin", "lost_price", "lost_service", "lost_timing", "lost_incumbent", "no_response", "expired"];
const EQUIPMENTS = ["Dry Van", "Reefer", "Flatbed"];
const ATTRACT_COLORS: Record<AttractivenessLabel, string> = {
  "Pursue Aggressively": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "Good Freight": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "Selective": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "Low Quality": "bg-red-500/15 text-red-300 border-red-500/30",
};
const PIE_COLORS = ["#10b981", "#84cc16", "#ef4444", "#f97316", "#f59e0b", "#a855f7", "#71717a", "#525252", "#facc15"];
const PAGE_SIZE = 50;
const ROW_HEIGHT = 32;

// ---------- Helpers ----------
function fmtMoney(v: number | string | null | undefined, opts: { dash?: boolean } = {}): string {
  if (v === null || v === undefined || v === "") return opts.dash ? "—" : "$0";
  const n = typeof v === "string" ? Number(v) : v;
  if (!isFinite(n) || n === 0) return opts.dash ? "—" : "$0";
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtPct(v: number): string { return `${v.toFixed(1)}%`; }
function fmtHours(v: number): string { return `${v.toFixed(1)}h`; }
function num(v: string | null | undefined): number {
  if (!v) return 0; const n = Number(v); return isNaN(n) ? 0 : n;
}
function filtersToQuery(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === false) return;
    p.set(k, String(v));
  });
  return p;
}
function filtersFromUrl(search: string): Filters {
  const p = new URLSearchParams(search);
  const f: Filters = {};
  (["customerId", "startDate", "endDate", "equipment", "repId", "outcomeStatus", "outcomeReasonId", "laneSearch"] as const).forEach(k => {
    const v = p.get(k); if (v) f[k] = v;
  });
  if (p.get("wonOnly") === "true") f.wonOnly = true;
  if (p.get("activeOnly") === "true") f.activeOnly = true;
  if (p.get("lostOnly") === "true") f.lostOnly = true;
  if (p.get("expiringOnly") === "true") f.expiringOnly = true;
  return f;
}
function trendIcon(v: number): JSX.Element {
  if (Math.abs(v) < 0.5) return <Minus className="h-3 w-3 text-zinc-500" />;
  if (v > 0) return <TrendingUp className="h-3 w-3 text-emerald-400" />;
  return <TrendingDown className="h-3 w-3 text-red-400" />;
}

function StatusPill({ status }: { status: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${STATUS_COLORS[status] ?? "bg-zinc-500/10 text-zinc-300 border-zinc-500/30"}`} data-testid={`status-pill-${status}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function KpiCard({ label, value, sub, trend, onClick, testId }: {
  label: string; value: string; sub?: string; trend?: number; onClick?: () => void; testId: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-start gap-0.5 rounded p-2.5 bg-zinc-900 border border-zinc-800 hover:border-amber-500/40 hover:bg-zinc-900/80 transition text-left min-w-[120px]"
      data-testid={testId}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
        <span>{label}</span>
        {trend !== undefined && trendIcon(trend)}
      </div>
      <div className="text-lg font-semibold text-zinc-100 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-zinc-500">{sub}</div>}
    </button>
  );
}

// ---------- Page ----------
export default function CustomerQuotesPage(): JSX.Element {
  const initialSearch = typeof window !== "undefined" ? window.location.search : "";
  const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(initialSearch));
  const [drawerId, setDrawerId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("quote");
  });
  const [savedViewsOpen, setSavedViewsOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newQuoteOpen, setNewQuoteOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("requestDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const { toast } = useToast();

  // Reset page when filters/sort change.
  useEffect(() => { setPage(0); }, [filters, sortKey, sortDir]);

  // Sync filters + drawer to URL.
  useEffect(() => {
    const p = filtersToQuery(filters);
    if (drawerId) p.set("quote", drawerId);
    const qs = p.toString();
    const target = `/customer-quotes${qs ? "?" + qs : ""}`;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState({}, "", target);
    }
  }, [filters, drawerId]);

  // Listen for browser back/forward to keep drawer in sync with URL.
  useEffect(() => {
    function onPop() {
      const q = new URLSearchParams(window.location.search).get("quote");
      setDrawerId(q);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const filterQs = filtersToQuery(filters).toString();

  const snapshotQuery = useQuery<Snapshot>({
    queryKey: ["/api/customer-quotes/snapshot", filterQs],
    queryFn: async (): Promise<Snapshot> => {
      const res = await fetch(`/api/customer-quotes/snapshot${filterQs ? "?" + filterQs : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load snapshot");
      return res.json() as Promise<Snapshot>;
    },
  });

  const listQs = useMemo(() => {
    const p = filtersToQuery(filters);
    p.set("sortKey", sortKey); p.set("sortDir", sortDir);
    p.set("offset", String(page * PAGE_SIZE)); p.set("limit", String(PAGE_SIZE));
    return p.toString();
  }, [filters, sortKey, sortDir, page]);

  const listQuery = useQuery<ListResult>({
    queryKey: ["/api/customer-quotes/list", listQs],
    queryFn: async (): Promise<ListResult> => {
      const res = await fetch(`/api/customer-quotes/list?${listQs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load list");
      return res.json() as Promise<ListResult>;
    },
  });

  const savedViewsQuery = useQuery<SavedView[]>({
    queryKey: ["/api/customer-quotes/saved-views"],
  });

  const saveViewMutation = useMutation({
    mutationFn: async (payload: { name: string; filters: Filters }): Promise<SavedView> => {
      const res = await apiRequest("POST", "/api/customer-quotes/saved-views", payload);
      return res.json() as Promise<SavedView>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] });
      setSaveDialogOpen(false); setNewViewName("");
      toast({ title: "Saved view created" });
    },
  });
  const deleteViewMutation = useMutation({
    mutationFn: async (id: string): Promise<{ ok: boolean }> => {
      const res = await apiRequest("DELETE", `/api/customer-quotes/saved-views/${id}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] }),
  });

  const invalidateQuoteData = (id?: string): void => {
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
    if (id) queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", id] });
  };

  const createQuoteMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>): Promise<QuoteDetail> => {
      const res = await apiRequest("POST", "/api/customer-quotes/quote", payload);
      return res.json() as Promise<QuoteDetail>;
    },
    onSuccess: (detail) => {
      invalidateQuoteData();
      setNewQuoteOpen(false);
      toast({ title: "Quote logged", description: `${detail.opp.originCity} → ${detail.opp.destCity}` });
      setDrawerId(detail.opp.id);
    },
    onError: (err: Error) => toast({ title: "Could not save quote", description: err.message, variant: "destructive" }),
  });

  const updateQuoteMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }): Promise<QuoteDetail> => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/quote/${id}`, patch);
      return res.json() as Promise<QuoteDetail>;
    },
    onSuccess: (detail) => {
      invalidateQuoteData(detail.opp.id);
      toast({ title: "Quote updated" });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const updateFilter = (patch: Partial<Filters>): void => setFilters(f => ({ ...f, ...patch }));
  const clearAll = (): void => setFilters({});
  const removeFilter = (k: keyof Filters): void => setFilters(f => { const c = { ...f }; delete c[k]; return c; });
  const hasFilters = Object.values(filters).some(v => v !== undefined && v !== "" && v !== false);

  const toggleSort = (k: SortKey): void => {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  };

  const handleExport = (): void => {
    const url = `/api/customer-quotes/export.csv${filterQs ? "?" + filterQs : ""}`;
    window.open(url, "_blank");
  };

  const data = snapshotQuery.data;
  const list = listQuery.data;
  const totalPages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100" style={{ fontFamily: "Inter, sans-serif" }}>
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-800 bg-zinc-950 shrink-0" data-testid="header-customer-quotes">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Customer Quotes</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Quote requests, outcomes, lane performance — drillable across customers, reps, and lanes.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setNewQuoteOpen(true)} className="bg-amber-500 hover:bg-amber-600 text-zinc-950" data-testid="button-new-quote">
              <Plus className="h-3.5 w-3.5 mr-1.5" /> New Quote
            </Button>
            <Button size="sm" variant="outline" onClick={handleExport} className="border-zinc-700 hover:bg-zinc-800" data-testid="button-export-csv">
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSavedViewsOpen(v => !v)} className="border-zinc-700 hover:bg-zinc-800" data-testid="button-saved-views">
              <Bookmark className="h-3.5 w-3.5 mr-1.5" /> Saved Views
            </Button>
            <Button size="sm" variant="outline" onClick={() => { snapshotQuery.refetch(); listQuery.refetch(); }} disabled={snapshotQuery.isFetching || listQuery.isFetching} className="border-zinc-700 hover:bg-zinc-800" data-testid="button-refresh">
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${snapshotQuery.isFetching || listQuery.isFetching ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Sticky filter bar */}
      <div className="sticky top-0 z-20 px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur shrink-0" data-testid="filter-bar">
        <div className="flex flex-wrap items-end gap-2">
          <FilterBox label="Customer">
            <CustomerCombobox customers={data?.customers ?? []} value={filters.customerId} onChange={(v) => updateFilter({ customerId: v })} />
          </FilterBox>
          <FilterBox label="Start date">
            <Input type="date" value={filters.startDate ?? ""} onChange={e => updateFilter({ startDate: e.target.value || undefined })} className="h-8 w-[140px] bg-zinc-900 border-zinc-700 text-xs" data-testid="input-start-date" />
          </FilterBox>
          <FilterBox label="End date">
            <Input type="date" value={filters.endDate ?? ""} onChange={e => updateFilter({ endDate: e.target.value || undefined })} className="h-8 w-[140px] bg-zinc-900 border-zinc-700 text-xs" data-testid="input-end-date" />
          </FilterBox>
          <FilterBox label="Equipment">
            <Select value={filters.equipment ?? "_all"} onValueChange={v => updateFilter({ equipment: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[120px] bg-zinc-900 border-zinc-700 text-xs" data-testid="select-equipment"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All</SelectItem>
                {EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Rep">
            <Select value={filters.repId ?? "_all"} onValueChange={v => updateFilter({ repId: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[140px] bg-zinc-900 border-zinc-700 text-xs" data-testid="select-rep"><SelectValue placeholder="All reps" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All reps</SelectItem>
                {data?.reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Outcome">
            <Select value={filters.outcomeStatus ?? "_all"} onValueChange={v => updateFilter({ outcomeStatus: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[140px] bg-zinc-900 border-zinc-700 text-xs" data-testid="select-outcome"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All</SelectItem>
                {ALL_STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Reason">
            <Select value={filters.outcomeReasonId ?? "_all"} onValueChange={v => updateFilter({ outcomeReasonId: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[160px] bg-zinc-900 border-zinc-700 text-xs" data-testid="select-reason"><SelectValue placeholder="All reasons" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_all">All reasons</SelectItem>
                {data?.reasons.map(r => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Lane search">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
              <Input value={filters.laneSearch ?? ""} onChange={e => updateFilter({ laneSearch: e.target.value || undefined })} placeholder="Origin/dest..." className="h-8 w-[180px] pl-7 bg-zinc-900 border-zinc-700 text-xs" data-testid="input-lane-search" />
            </div>
          </FilterBox>
          <FilterBox label="Won only">
            <div className="h-8 flex items-center"><Switch checked={!!filters.wonOnly} onCheckedChange={v => updateFilter({ wonOnly: v ? true : undefined })} data-testid="switch-won-only" /></div>
          </FilterBox>
          <FilterBox label="Active only">
            <div className="h-8 flex items-center"><Switch checked={!!filters.activeOnly} onCheckedChange={v => updateFilter({ activeOnly: v ? true : undefined })} data-testid="switch-active-only" /></div>
          </FilterBox>
          {hasFilters && (
            <>
              <Button size="sm" variant="ghost" onClick={clearAll} className="h-8 text-xs text-zinc-400 hover:text-zinc-100" data-testid="button-clear-filters">Clear all</Button>
              <Button size="sm" variant="ghost" onClick={() => setSaveDialogOpen(true)} className="h-8 text-xs text-amber-400 hover:text-amber-300" data-testid="button-save-view"><Plus className="h-3 w-3 mr-1" /> Save view</Button>
            </>
          )}
        </div>
        {hasFilters && (
          <div className="flex flex-wrap gap-1.5 mt-2" data-testid="active-filter-chips">
            {Object.entries(filters).map(([k, v]) => {
              if (v === undefined || v === "" || v === false) return null;
              let label = `${k}: ${String(v)}`;
              if (k === "customerId") label = `Customer: ${data?.customers.find(c => c.id === v)?.name ?? v}`;
              if (k === "repId") label = `Rep: ${data?.reps.find(r => r.id === v)?.name ?? v}`;
              if (k === "outcomeReasonId") label = `Reason: ${data?.reasons.find(r => r.id === v)?.label ?? v}`;
              if (k === "outcomeStatus") label = `Outcome: ${STATUS_LABELS[v as string] ?? v}`;
              if (k === "wonOnly") label = "Won only";
              if (k === "lostOnly") label = "Lost only";
              if (k === "activeOnly") label = "Active only";
              if (k === "expiringOnly") label = "Expiring <3d";
              return (
                <button key={k} onClick={() => removeFilter(k as keyof Filters)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25"
                  data-testid={`chip-${k}`}>
                  {label}<X className="h-3 w-3" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {snapshotQuery.isLoading || !data ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full bg-zinc-900" />
            <Skeleton className="h-64 w-full bg-zinc-900" />
            <Skeleton className="h-96 w-full bg-zinc-900" />
          </div>
        ) : (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-11 gap-2" data-testid="kpi-strip">
              <KpiCard testId="kpi-total" label="Total" value={data.kpis.total.toString()} trend={data.kpis.trend.total} onClick={clearAll} />
              <KpiCard testId="kpi-won" label="Won" value={data.kpis.won.toString()} onClick={() => updateFilter({ wonOnly: true, lostOnly: undefined, activeOnly: undefined, expiringOnly: undefined })} />
              <KpiCard testId="kpi-lost" label="Lost" value={data.kpis.lost.toString()} onClick={() => updateFilter({ lostOnly: true, wonOnly: undefined, activeOnly: undefined, expiringOnly: undefined })} />
              <KpiCard testId="kpi-win-rate" label="Win rate" value={fmtPct(data.kpis.winRate)} trend={data.kpis.trend.winRate} onClick={() => updateFilter({ wonOnly: true, lostOnly: undefined })} />
              <KpiCard testId="kpi-avg-quoted" label="Avg quoted" value={fmtMoney(data.kpis.avgQuoted)} onClick={() => { setSortKey("quotedAmount"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-avg-carrier" label="Avg carrier" value={fmtMoney(data.kpis.avgCarrierCost)} onClick={() => { updateFilter({ wonOnly: true }); setSortKey("carrierPaid"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-avg-margin-d" label="Avg margin $" value={fmtMoney(data.kpis.avgMarginDollar)} trend={data.kpis.trend.avgMargin} onClick={() => { updateFilter({ wonOnly: true }); setSortKey("marginDollar"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-avg-margin-pct" label="Avg margin %" value={fmtPct(data.kpis.avgMarginPct)} trend={data.kpis.trend.avgMargin} onClick={() => { updateFilter({ wonOnly: true }); setSortKey("marginPct"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-avg-response" label="Avg response" value={fmtHours(data.kpis.avgResponseTime)} trend={-data.kpis.trend.avgResponse} onClick={() => { setSortKey("responseTimeHours"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-pending" label="Pending" value={data.kpis.pending.toString()} onClick={() => updateFilter({ activeOnly: true, wonOnly: undefined, lostOnly: undefined, expiringOnly: undefined })} />
              <KpiCard testId="kpi-expiring" label="Expiring soon" value={data.kpis.expiringSoon.toString()} sub="<3 days" onClick={() => updateFilter({ expiringOnly: true, activeOnly: undefined, wonOnly: undefined, lostOnly: undefined })} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
              <div className="space-y-4 min-w-0">
                {data.customerPerformance && <CustomerPerformancePanel cp={data.customerPerformance} />}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <TaxonomyModule taxonomy={data.taxonomy} onPick={(s) => updateFilter({ outcomeStatus: s })} />
                  <ValidityWindowModule vw={data.validityWindow} onPickQuote={setDrawerId} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <LaneVarianceModule items={data.laneVariance} onPickLane={(l) => updateFilter({ laneSearch: l.replace(/ → /g, " ") })} />
                  <AttractivenessModule items={data.attractiveness} />
                </div>

                <ChartStrip
                  charts={data.charts}
                  taxonomy={data.taxonomy}
                  agingBuckets={data.validityWindow.agingBuckets}
                  onPickLane={(l) => updateFilter({ laneSearch: l.replace(/ → /g, " ") })}
                  onPickCustomer={(name) => {
                    const c = data.customers.find(x => x.name === name);
                    if (c) updateFilter({ customerId: c.id });
                  }}
                  onPickOutcome={(s) => updateFilter({ outcomeStatus: s })}
                  onPickTrend={(variant, date) => {
                    updateFilter({
                      startDate: date,
                      endDate: date,
                      wonOnly: variant === "won" ? true : undefined,
                      lostOnly: variant === "lost" ? true : undefined,
                    });
                  }}
                  onPickAging={(bucket) => {
                    const now = new Date();
                    const day = 24 * 3600 * 1000;
                    const ranges: Record<string, [number, number]> = {
                      "0-2d": [0, 2], "3-7d": [3, 7], "8-14d": [8, 14],
                      "15-30d": [15, 30], "30+d": [31, 365],
                    };
                    const r = ranges[bucket]; if (!r) return;
                    const end = new Date(now.getTime() - r[0] * day);
                    const start = new Date(now.getTime() - r[1] * day);
                    updateFilter({
                      startDate: start.toISOString().slice(0, 10),
                      endDate: end.toISOString().slice(0, 10),
                    });
                  }}
                />

                {/* Quote opportunities table */}
                <Card className="bg-zinc-900 border-zinc-800" data-testid="quote-table-card">
                  <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm text-zinc-100">
                      Quote Opportunities <span className="text-zinc-500 font-normal">({list?.total ?? 0})</span>
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="h-7 w-7 p-0" data-testid="button-page-prev"><ChevronLeft className="h-4 w-4" /></Button>
                      <span className="text-xs text-zinc-400 tabular-nums">Page {page + 1} of {totalPages}</span>
                      <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="h-7 w-7 p-0" data-testid="button-page-next"><ChevronRight className="h-4 w-4" /></Button>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <VirtualTable
                      rows={list?.rows ?? []}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      onRowClick={(id) => setDrawerId(id)}
                      isLoading={listQuery.isLoading}
                      reasons={data.reasons}
                      onInlineOutcome={(id, outcomeStatus, outcomeReasonId) =>
                        updateQuoteMutation.mutate({ id, patch: { outcomeStatus, outcomeReasonId: outcomeReasonId ?? null } })
                      }
                      pendingId={updateQuoteMutation.isPending ? (updateQuoteMutation.variables as { id: string } | undefined)?.id : undefined}
                    />
                  </CardContent>
                </Card>
              </div>

              {/* Right rail */}
              <div className="space-y-4">
                <Card className="bg-zinc-900 border-zinc-800" data-testid="alerts-panel">
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-xs uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Operational Alerts
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 space-y-2 max-h-[420px] overflow-y-auto">
                    {data.alerts.length === 0 && <div className="text-xs text-zinc-500 px-1">All quiet — no urgent items.</div>}
                    {data.alerts.map(a => (
                      <button key={a.id} onClick={() => {
                        if (a.type === "pattern_shift" && a.data?.customerId) {
                          updateFilter({
                            customerId: a.data.customerId,
                            startDate: a.data.startDate,
                            endDate: undefined,
                            wonOnly: undefined, lostOnly: undefined,
                            activeOnly: undefined, expiringOnly: undefined,
                          });
                        }
                        else if (a.data?.quoteId) setDrawerId(a.data.quoteId);
                        else if (a.data?.lane) updateFilter({ laneSearch: a.data.lane.replace(/ → /g, " ") });
                        else if (a.data?.customerId) updateFilter({ customerId: a.data.customerId });
                        else if (a.type === "expiring") updateFilter({ expiringOnly: true, activeOnly: undefined, wonOnly: undefined, lostOnly: undefined });
                        else if (a.type === "low_margin") updateFilter({ outcomeStatus: "won_low_margin" });
                      }} className={`w-full text-left rounded p-2 border ${
                        a.severity === "high" ? "bg-red-500/10 border-red-500/30 hover:bg-red-500/20"
                        : a.severity === "medium" ? "bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20"
                        : "bg-zinc-800/40 border-zinc-700 hover:bg-zinc-800"
                      }`} data-testid={`alert-${a.type}`}>
                        <div className="text-[11px] font-semibold text-zinc-100">{a.title}</div>
                        <div className="text-[10px] text-zinc-400 mt-0.5">{a.detail}</div>
                      </button>
                    ))}
                  </CardContent>
                </Card>

                <Card className="bg-zinc-900 border-zinc-800" data-testid="stale-followups-panel">
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-xs uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                      <Hourglass className="h-3.5 w-3.5 text-amber-400" /> Stale Follow-Ups
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 space-y-1.5 max-h-[360px] overflow-y-auto">
                    {(!data.staleFollowUps || data.staleFollowUps.length === 0) && (
                      <div className="text-xs text-zinc-500 px-1" data-testid="text-stale-empty">
                        No quotes past their typical decision window.
                      </div>
                    )}
                    {data.staleFollowUps?.map(s => {
                      const overdueLabel = s.hoursOverdue >= 48
                        ? `${Math.round(s.hoursOverdue / 24)}d`
                        : `${Math.round(s.hoursOverdue)}h`;
                      const typicalLabel = s.pTypicalHours >= 48
                        ? `${Math.round(s.pTypicalHours / 24)}d`
                        : `${Math.round(s.pTypicalHours)}h`;
                      return (
                        <button
                          key={s.quoteId}
                          onClick={() => setDrawerId(s.quoteId)}
                          className="w-full text-left rounded p-2 border bg-amber-500/8 border-amber-500/25 hover:bg-amber-500/15 transition"
                          data-testid={`stale-followup-${s.quoteId}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold text-zinc-100 truncate">{s.customerName}</span>
                            <span className="text-[10px] text-amber-300 shrink-0">{overdueLabel} late</span>
                          </div>
                          <div className="text-[10px] text-zinc-400 mt-0.5 truncate">{s.lane}</div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            {fmtMoney(s.quotedAmount)} · typical {typicalLabel}{s.repName ? ` · ${s.repName}` : ""}
                          </div>
                        </button>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card className="bg-zinc-900 border-zinc-800" data-testid="current-slice-panel">
                  <CardHeader className="py-3 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Current Slice</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-3 text-xs text-zinc-300 space-y-1">
                    <div><span className="text-zinc-500">Quotes:</span> {data.kpis.total}</div>
                    <div><span className="text-zinc-500">Win rate:</span> {fmtPct(data.kpis.winRate)}</div>
                    <div><span className="text-zinc-500">Avg margin:</span> {fmtMoney(data.kpis.avgMarginDollar)} ({fmtPct(data.kpis.avgMarginPct)})</div>
                    <div><span className="text-zinc-500">Pending:</span> {data.kpis.pending}</div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Saved Views drawer */}
      {savedViewsOpen && (
        <div className="fixed top-[120px] right-6 z-30 w-[280px] rounded border border-zinc-700 bg-zinc-900 shadow-xl" data-testid="saved-views-panel">
          <div className="flex items-center justify-between p-3 border-b border-zinc-800">
            <span className="text-xs uppercase tracking-wider text-zinc-400">Saved Views</span>
            <button onClick={() => setSavedViewsOpen(false)} className="text-zinc-500 hover:text-zinc-200"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="p-2 max-h-[300px] overflow-y-auto">
            {!savedViewsQuery.data?.length && <div className="text-xs text-zinc-500 px-2 py-3">No saved views yet. Save the current filters to make one.</div>}
            {savedViewsQuery.data?.map(v => (
              <div key={v.id} className="flex items-center gap-1 group">
                <button onClick={() => { setFilters(v.filters); setSavedViewsOpen(false); }}
                  className="flex-1 text-left px-2 py-1.5 rounded text-xs text-zinc-200 hover:bg-zinc-800"
                  data-testid={`button-apply-view-${v.id}`}>{v.name}</button>
                <button onClick={() => deleteViewMutation.mutate(v.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-zinc-500 hover:text-red-400"
                  data-testid={`button-delete-view-${v.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
          <DialogHeader><DialogTitle>Save current view</DialogTitle></DialogHeader>
          <Label htmlFor="view-name" className="text-xs">Name</Label>
          <Input id="view-name" value={newViewName} onChange={e => setNewViewName(e.target.value)} placeholder="e.g. Aurora Foods — wins this month" data-testid="input-view-name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => saveViewMutation.mutate({ name: newViewName.trim(), filters })}
              disabled={!newViewName.trim() || saveViewMutation.isPending} data-testid="button-save-view-confirm">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <QuoteDetailDrawer
        quoteId={drawerId}
        onClose={() => setDrawerId(null)}
        onPickRelated={(id) => setDrawerId(id)}
        customers={data?.customers ?? []}
        reps={data?.reps ?? []}
        carriers={data?.carriers ?? []}
        reasons={data?.reasons ?? []}
        onSave={(id, patch) => updateQuoteMutation.mutate({ id, patch })}
        isSaving={updateQuoteMutation.isPending}
      />

      <NewQuoteDialog
        open={newQuoteOpen}
        onOpenChange={setNewQuoteOpen}
        customers={data?.customers ?? []}
        reps={data?.reps ?? []}
        onSubmit={(payload) => createQuoteMutation.mutate(payload)}
        isSubmitting={createQuoteMutation.isPending}
      />
    </div>
  );
}

// ---------- Subcomponents ----------
function FilterBox({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function CustomerCombobox({ customers, value, onChange }: { customers: Customer[]; value: string | undefined; onChange: (v: string | undefined) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = value ? customers.find(c => c.id === value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-[200px] justify-between bg-zinc-900 border-zinc-700 text-xs font-normal"
          data-testid="combobox-customer"
        >
          <span className="truncate">{selected?.name ?? "All customers"}</span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[260px] p-0 bg-zinc-900 border-zinc-700">
        <Command className="bg-zinc-900">
          <CommandInput placeholder="Search customers..." className="h-9 text-xs" data-testid="combobox-customer-input" />
          <CommandList>
            <CommandEmpty className="py-3 text-xs text-zinc-500 text-center">No customer found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="_all" onSelect={() => { onChange(undefined); setOpen(false); }} data-testid="combobox-customer-item-all">
                <Check className={`mr-2 h-3.5 w-3.5 ${!value ? "opacity-100" : "opacity-0"}`} /> All customers
              </CommandItem>
              {customers.map(c => (
                <CommandItem key={c.id} value={c.name} onSelect={() => { onChange(c.id); setOpen(false); }} data-testid={`combobox-customer-item-${c.id}`}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${value === c.id ? "opacity-100" : "opacity-0"}`} />
                  <span className="text-xs">{c.name}</span>
                  {c.segment && <span className="ml-auto text-[10px] text-zinc-500">{c.segment}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type ColumnDef = { key: SortKey; label: string; align?: "right" };
const COLUMNS: ColumnDef[] = [
  { key: "requestDate", label: "Request" },
  { key: "customerName", label: "Customer" },
  { key: "originCity", label: "Origin" },
  { key: "destCity", label: "Destination" },
  { key: "equipment", label: "Equip" },
  { key: "quotedAmount", label: "Quoted", align: "right" },
  { key: "validThrough", label: "Valid" },
  { key: "outcomeStatus", label: "Outcome" },
  { key: "outcomeReasonLabel", label: "Reason" },
  { key: "carrierPaid", label: "Carrier $", align: "right" },
  { key: "marginDollar", label: "Margin $", align: "right" },
  { key: "marginPct", label: "Margin %", align: "right" },
  { key: "repName", label: "Rep" },
  { key: "responseTimeHours", label: "Resp", align: "right" },
  { key: "source", label: "Source" },
  { key: "score", label: "Score", align: "right" },
];

function VirtualTable({ rows, sortKey, sortDir, onSort, onRowClick, isLoading, reasons, onInlineOutcome, pendingId }: {
  rows: Quote[]; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; onRowClick: (id: string) => void; isLoading: boolean;
  reasons: Reason[];
  onInlineOutcome: (id: string, status: string, reasonId: string | null) => void;
  pendingId: string | undefined;
}): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportH = 600;
  const overscan = 8;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + overscan);
  const visible = rows.slice(startIdx, endIdx);
  const padTop = startIdx * ROW_HEIGHT;
  const padBottom = (rows.length - endIdx) * ROW_HEIGHT;

  return (
    <div
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ maxHeight: viewportH }}
      className="overflow-auto"
      data-testid="quote-table-virtual"
    >
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-zinc-900 z-10 border-b border-zinc-800">
          <tr className="text-left text-zinc-400">
            {COLUMNS.map(col => (
              <th key={col.key} className={`px-2 py-2 font-medium text-[10px] uppercase tracking-wider ${col.align === "right" ? "text-right" : ""}`}>
                <button onClick={() => onSort(col.key)} className="inline-flex items-center gap-0.5 hover:text-zinc-100" data-testid={`sort-${col.key}`}>
                  {col.label}
                  {sortKey === col.key && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!isLoading && rows.length === 0 && (
            <tr><td colSpan={COLUMNS.length} className="text-center py-8 text-zinc-500">No quote opportunities match these filters.</td></tr>
          )}
          {padTop > 0 && <tr style={{ height: padTop }} aria-hidden="true"><td colSpan={COLUMNS.length} /></tr>}
          {visible.map(q => {
            const quoted = num(q.quotedAmount);
            const paid = num(q.carrierPaid);
            const margin = quoted - paid;
            const marginPct = quoted > 0 && paid > 0 ? (margin / quoted) * 100 : null;
            return (
              <tr key={q.id} onClick={() => onRowClick(q.id)}
                className="border-b border-zinc-800/50 hover:bg-zinc-800/40 cursor-pointer"
                style={{ height: ROW_HEIGHT }}
                data-testid={`row-quote-${q.id}`}>
                <td className="px-2 whitespace-nowrap text-zinc-300">{new Date(q.requestDate).toLocaleDateString()}</td>
                <td className="px-2 whitespace-nowrap text-zinc-100 font-medium">{q.customerName}</td>
                <td className="px-2 whitespace-nowrap text-zinc-300">{q.originCity}, {q.originState}</td>
                <td className="px-2 whitespace-nowrap text-zinc-300">{q.destCity}, {q.destState}</td>
                <td className="px-2 whitespace-nowrap text-zinc-400">{q.equipment}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-zinc-100">{fmtMoney(quoted)}</td>
                <td className="px-2 whitespace-nowrap text-zinc-400">{q.validThrough ? new Date(q.validThrough).toLocaleDateString() : "—"}</td>
                <td className="px-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <InlineOutcome
                    quote={q}
                    reasons={reasons}
                    onChange={onInlineOutcome}
                    pending={pendingId === q.id}
                  />
                </td>
                <td className="px-2 whitespace-nowrap text-zinc-400 max-w-[140px] truncate">{q.outcomeReasonLabel ?? "—"}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-zinc-300">{paid ? fmtMoney(paid) : "—"}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-zinc-100">{paid ? fmtMoney(margin) : "—"}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-zinc-300">{marginPct !== null ? fmtPct(marginPct) : "—"}</td>
                <td className="px-2 whitespace-nowrap text-zinc-400">{q.repName}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-zinc-400">{num(q.responseTimeHours).toFixed(1)}h</td>
                <td className="px-2 whitespace-nowrap text-zinc-500 uppercase text-[10px]">{q.source}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-zinc-300">{num(q.score).toFixed(0)}</td>
              </tr>
            );
          })}
          {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden="true"><td colSpan={COLUMNS.length} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

function CustomerPerformancePanel({ cp }: { cp: CustomerPerformance }): JSX.Element {
  const total = cp.winCount + cp.lossCount;
  const winRate = total > 0 ? (cp.winCount / total) * 100 : 0;
  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="customer-performance-panel">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-zinc-100">Customer Performance — {cp.customer.name}</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Win/Loss</div>
          <div className="text-2xl font-semibold text-zinc-100">{fmtPct(winRate)}</div>
          <div className="text-xs text-zinc-400 mt-0.5">{cp.winCount} won · {cp.lossCount} lost</div>
          <div className="mt-2 text-xs text-zinc-400">Avg quoted: <span className="text-zinc-100">{fmtMoney(cp.avgQuoted)}</span></div>
          <div className="text-xs text-zinc-400">Avg carrier: <span className="text-zinc-100">{fmtMoney(cp.avgCarrierBuy)}</span></div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Top Lanes</div>
          <ul className="space-y-1">
            {cp.topLanes.map(l => (
              <li key={l.lane} className="text-xs text-zinc-300 flex justify-between"><span className="truncate pr-2">{l.lane}</span><span className="text-zinc-500">{l.total}</span></li>
            ))}
            {!cp.topLanes.length && <li className="text-xs text-zinc-500">No lane data.</li>}
          </ul>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Top Loss Reasons</div>
          <ul className="space-y-1">
            {cp.topLossReasons.map(r => (
              <li key={r.reason} className="text-xs text-zinc-300 flex justify-between"><span className="truncate pr-2">{r.reason}</span><span className="text-zinc-500">{r.count}</span></li>
            ))}
            {!cp.topLossReasons.length && <li className="text-xs text-zinc-500">No losses logged.</li>}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function TaxonomyModule({ taxonomy, onPick }: { taxonomy: Record<string, number>; onPick: (s: string) => void }): JSX.Element {
  const entries = OUTCOME_BUCKETS.map(s => ({ status: s, label: STATUS_LABELS[s], count: taxonomy[s] ?? 0 }));
  const total = entries.reduce((s, e) => s + e.count, 0);
  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="taxonomy-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-zinc-100 flex items-center gap-1.5"><Trophy className="h-4 w-4 text-amber-400" /> Quote Outcome Taxonomy</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {entries.map((e, i) => {
          const pct = total > 0 ? (e.count / total) * 100 : 0;
          return (
            <button key={e.status} onClick={() => onPick(e.status)} className="w-full text-left group" data-testid={`taxonomy-${e.status}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-300 group-hover:text-zinc-100">{e.label}</span>
                <span className="text-zinc-400 tabular-nums">{e.count} <span className="text-zinc-600">·</span> {fmtPct(pct)}</span>
              </div>
              <div className="h-1.5 bg-zinc-800 rounded mt-0.5 overflow-hidden">
                <div className="h-full" style={{ width: `${pct}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ValidityWindowModule({ vw, onPickQuote }: { vw: Snapshot["validityWindow"]; onPickQuote: (id: string) => void }): JSX.Element {
  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="validity-window-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-zinc-100 flex items-center gap-1.5"><Hourglass className="h-4 w-4 text-amber-400" /> Quote Validity Window</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-zinc-800/60 p-2"><div className="text-lg font-semibold text-zinc-100">{vw.activeCount}</div><div className="text-[10px] text-zinc-500 uppercase">Active</div></div>
          <div className="rounded bg-zinc-800/60 p-2"><div className="text-lg font-semibold text-zinc-100">{vw.expiredCount}</div><div className="text-[10px] text-zinc-500 uppercase">Expired</div></div>
          <div className="rounded bg-zinc-800/60 p-2"><div className="text-lg font-semibold text-zinc-100">{vw.staleCount}</div><div className="text-[10px] text-zinc-500 uppercase">Stale</div></div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Aging buckets</div>
          <div className="flex gap-1 text-[11px]">
            {Object.entries(vw.agingBuckets).map(([k, v]) => (
              <div key={k} className="flex-1 bg-zinc-800/60 rounded p-1.5 text-center"><div className="font-semibold text-zinc-100">{v}</div><div className="text-zinc-500">{k}</div></div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Expiring soon</div>
          <ul className="space-y-1 max-h-[140px] overflow-y-auto">
            {vw.expiringList.length === 0 && <li className="text-xs text-zinc-500">Nothing expiring imminently.</li>}
            {vw.expiringList.map(q => (
              <li key={q.id}>
                <button onClick={() => onPickQuote(q.id)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-zinc-800 flex justify-between gap-2" data-testid={`expiring-${q.id}`}>
                  <span className="truncate text-zinc-200">{q.lane}</span>
                  <span className="text-zinc-500 whitespace-nowrap">{new Date(q.validThrough).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function LaneVarianceModule({ items, onPickLane }: { items: LaneVarianceItem[]; onPickLane: (l: string) => void }): JSX.Element {
  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="lane-variance-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-zinc-100">Lane Overlap / Internal Variance</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-1 max-h-[260px] overflow-y-auto">
        {items.length === 0 && <div className="text-xs text-zinc-500">No same-lane overlap among reps.</div>}
        {items.map(v => (
          <button key={v.lane} onClick={() => onPickLane(v.lane)} className="w-full text-left rounded p-2 hover:bg-zinc-800/60" data-testid={`variance-${v.lane}`}>
            <div className="flex justify-between items-center text-xs">
              <span className="text-zinc-200 truncate pr-2">{v.lane}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${v.spreadPct > 18 ? "bg-red-500/15 text-red-300 border-red-500/30" : "bg-zinc-700/40 text-zinc-300 border-zinc-700"}`}>
                ${Math.round(v.spread).toLocaleString()} ({v.spreadPct.toFixed(0)}%)
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5 truncate">
              {v.breakdown.map(b => `${b.rep}: ${fmtMoney(b.avg)}`).join(" · ")}
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

function AttractivenessModule({ items }: { items: AttractivenessItem[] }): JSX.Element {
  return (
    <Card className="bg-zinc-900 border-zinc-800" data-testid="attractiveness-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-zinc-100">Should We Want This Freight?</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-1 max-h-[260px] overflow-y-auto">
        {items.length === 0 && <div className="text-xs text-zinc-500">Need more quotes per lane to score.</div>}
        {items.slice(0, 12).map(item => (
          <div key={item.customer + item.lane} className="rounded p-2 bg-zinc-800/30 flex items-start justify-between gap-2" data-testid={`attract-${item.customer}-${item.lane}`}>
            <div className="min-w-0">
              <div className="text-xs text-zinc-100 truncate">{item.customer}</div>
              <div className="text-[10px] text-zinc-500 truncate">{item.lane}</div>
            </div>
            <div className="text-right shrink-0">
              <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${ATTRACT_COLORS[item.label]}`}>{item.label}</span>
              <div className="text-[10px] text-zinc-500 mt-0.5">{fmtPct(item.winRate)} · {fmtMoney(item.avgMargin)}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

type LaneClickPayload = { lane: string };
type CustomerClickPayload = { customer: string };

type OutcomeBarPayload = { bucket: string };
type AgingBarPayload = { bucket: string };

function ChartStrip({ charts, taxonomy, agingBuckets, onPickLane, onPickCustomer, onPickOutcome, onPickAging, onPickTrend }: {
  charts: Snapshot["charts"];
  taxonomy: Record<string, number>;
  agingBuckets: Record<string, number>;
  onPickLane: (l: string) => void;
  onPickCustomer: (c: string) => void;
  onPickOutcome: (s: string) => void;
  onPickAging: (bucket: string) => void;
  onPickTrend: (variant: "won" | "lost" | "total", date: string) => void;
}): JSX.Element {
  const outcomeData = OUTCOME_BUCKETS.map(s => ({ bucket: s, label: STATUS_LABELS[s], count: taxonomy[s] ?? 0 }));
  const agingData = Object.entries(agingBuckets).map(([bucket, count]) => ({ bucket, count }));
  const handleLaneClick = (data: unknown): void => {
    const d = data as LaneClickPayload | undefined;
    if (d?.lane) onPickLane(d.lane);
  };
  const handleCustomerClick = (data: unknown): void => {
    const d = data as CustomerClickPayload | undefined;
    if (d?.customer) onPickCustomer(d.customer);
  };
  const handleOutcomeClick = (data: unknown): void => {
    const d = data as OutcomeBarPayload | undefined;
    if (d?.bucket) onPickOutcome(d.bucket);
  };
  const handleAgingClick = (data: unknown): void => {
    const d = data as AgingBarPayload | undefined;
    if (d?.bucket) onPickAging(d.bucket);
  };
  const handleTrendClick = (variant: "won" | "lost" | "total") => (data: unknown): void => {
    const d = data as { activeLabel?: string } | undefined;
    const date = d?.activeLabel;
    if (!date) return;
    onPickTrend(variant, date);
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Win/Loss Trend (30d)</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><LineChart data={charts.trend}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 10 }} />
            <YAxis tick={{ fill: "#71717a", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} />
            <Line
              dataKey="won" stroke="#10b981" strokeWidth={1.5}
              dot={{ r: 2, cursor: "pointer" }}
              activeDot={{ r: 4, cursor: "pointer", onClick: (_e: unknown, p: unknown) => {
                const date = (p as { payload?: { date?: string } } | undefined)?.payload?.date;
                if (date) onPickTrend("won", date);
              } }}
            />
            <Line
              dataKey="lost" stroke="#ef4444" strokeWidth={1.5}
              dot={{ r: 2, cursor: "pointer" }}
              activeDot={{ r: 4, cursor: "pointer", onClick: (_e: unknown, p: unknown) => {
                const date = (p as { payload?: { date?: string } } | undefined)?.payload?.date;
                if (date) onPickTrend("lost", date);
              } }}
            />
          </LineChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Quote Volume (30d)</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.trend} onClick={handleTrendClick("total")}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 10 }} />
            <YAxis tick={{ fill: "#71717a", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} />
            <Bar dataKey="total" fill="#facc15" cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Win Rate by Customer</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.winRateByCustomer} layout="vertical">
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "#71717a", fontSize: 10 }} />
            <YAxis type="category" dataKey="customer" tick={{ fill: "#a1a1aa", fontSize: 10 }} width={110} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} formatter={(v: number) => `${v.toFixed(1)}%`} />
            <Bar dataKey="winRate" fill="#10b981" onClick={handleCustomerClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Avg Margin by Customer</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.marginByCustomer} layout="vertical">
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "#71717a", fontSize: 10 }} />
            <YAxis type="category" dataKey="customer" tick={{ fill: "#a1a1aa", fontSize: 10 }} width={110} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} formatter={(v: number) => fmtMoney(v)} />
            <Bar dataKey="avgMargin" fill="#facc15" onClick={handleCustomerClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Top Lanes</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.topLanes} layout="vertical">
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "#71717a", fontSize: 10 }} />
            <YAxis type="category" dataKey="lane" tick={{ fill: "#a1a1aa", fontSize: 9 }} width={150} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} />
            <Bar dataKey="total" fill="#3b82f6" onClick={handleLaneClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">High-Volume / Low-Win Lanes</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.highVolLowWin} layout="vertical">
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "#71717a", fontSize: 10 }} />
            <YAxis type="category" dataKey="lane" tick={{ fill: "#a1a1aa", fontSize: 9 }} width={150} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} />
            <Bar dataKey="total" fill="#ef4444" onClick={handleLaneClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800" data-testid="chart-outcome-distribution">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Outcome Distribution</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={outcomeData}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="bucket" tick={{ fill: "#71717a", fontSize: 9 }} angle={-30} textAnchor="end" height={50} />
            <YAxis tick={{ fill: "#71717a", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} formatter={(v: number) => `${v} quotes`} />
            <Bar dataKey="count" fill="#a855f7" onClick={handleOutcomeClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-zinc-900 border-zinc-800" data-testid="chart-quote-aging">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-zinc-400">Quote Aging</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={agingData}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="bucket" tick={{ fill: "#a1a1aa", fontSize: 10 }} />
            <YAxis tick={{ fill: "#71717a", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 11 }} />
            <Bar dataKey="count" fill="#0ea5e9" cursor="pointer" onClick={handleAgingClick} />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

function QuoteDetailDrawer({ quoteId, onClose, onPickRelated, customers, reps, carriers, reasons, onSave, isSaving }: {
  quoteId: string | null; onClose: () => void; onPickRelated: (id: string) => void;
  customers: Customer[]; reps: Rep[]; carriers: Carrier[]; reasons: Reason[];
  onSave: (id: string, patch: Record<string, unknown>) => void;
  isSaving: boolean;
}): JSX.Element {
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  useEffect(() => { setEditMode(false); setDraft({}); }, [quoteId]);
  const detailQuery = useQuery<QuoteDetail>({
    queryKey: ["/api/customer-quotes/quote", quoteId],
    queryFn: async (): Promise<QuoteDetail> => {
      if (!quoteId) throw new Error("no id");
      const res = await fetch(`/api/customer-quotes/quote/${quoteId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<QuoteDetail>;
    },
    enabled: !!quoteId,
  });
  const data = detailQuery.data;

  return (
    <Sheet open={!!quoteId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-[520px] bg-zinc-950 border-l border-zinc-800 text-zinc-100 overflow-y-auto" data-testid="quote-detail-drawer">
        <SheetHeader className="flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-zinc-100">Quote Detail</SheetTitle>
          {!detailQuery.isLoading && data && !editMode && (
            <Button size="sm" variant="outline" className="border-zinc-700 hover:bg-zinc-800 mr-8" onClick={() => { setEditMode(true); setDraft({}); }} data-testid="button-edit-quote">Edit</Button>
          )}
        </SheetHeader>
        {detailQuery.isLoading || !data ? (
          <div className="space-y-3 mt-4"><Skeleton className="h-32 bg-zinc-900" /><Skeleton className="h-32 bg-zinc-900" /></div>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <div className="rounded bg-zinc-900 border border-zinc-800 p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Lane</div>
              <div className="text-base font-semibold text-zinc-100 mt-0.5">{data.opp.originCity}, {data.opp.originState} → {data.opp.destCity}, {data.opp.destState}</div>
              <div className="text-xs text-zinc-400 mt-1">{data.opp.equipment} · Customer: {data.customer?.name ?? "—"} · Rep: {data.rep?.name ?? "—"}</div>
              <div className="mt-2 flex items-center gap-2"><StatusPill status={data.opp.outcomeStatus} /><span className="text-xs text-zinc-400">{data.reason?.label ?? ""}</span></div>
            </div>
            {editMode && (
              <QuoteEditForm
                quote={data.opp}
                customers={customers}
                reps={reps}
                carriers={carriers}
                reasons={reasons}
                draft={draft}
                onChange={setDraft}
                onCancel={() => { setEditMode(false); setDraft({}); }}
                onSave={() => { onSave(data.opp.id, draft); setEditMode(false); setDraft({}); }}
                isSaving={isSaving}
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Quoted" value={fmtMoney(data.opp.quotedAmount)} />
              <Stat label="Carrier paid" value={fmtMoney(data.opp.carrierPaid, { dash: true })} />
              <Stat label="Margin $" value={num(data.opp.carrierPaid) ? fmtMoney(num(data.opp.quotedAmount) - num(data.opp.carrierPaid)) : "—"} />
              <Stat label="Margin %" value={num(data.opp.carrierPaid) && num(data.opp.quotedAmount) ? fmtPct(((num(data.opp.quotedAmount) - num(data.opp.carrierPaid)) / num(data.opp.quotedAmount)) * 100) : "—"} />
              <Stat label="Response time" value={fmtHours(num(data.opp.responseTimeHours))} />
              <Stat label="Valid through" value={data.opp.validThrough ? new Date(data.opp.validThrough).toLocaleDateString() : "—"} />
            </div>
            <div className="rounded bg-zinc-900 border border-zinc-800 p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Source</div>
              <div className="text-xs text-zinc-300">{data.opp.source.toUpperCase()} <span className="text-zinc-500 ml-2">{data.opp.sourceReference}</span></div>
              <div className="text-xs text-zinc-400 mt-1">Carrier: {data.carrier?.name ?? "—"}</div>
            </div>
            <div className="rounded bg-zinc-900 border border-zinc-800 p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Timeline & revisions</div>
              <ol className="space-y-2">
                {data.events.map(e => {
                  const amt = e.payload && typeof e.payload === "object" && "quotedAmount" in e.payload ? String((e.payload as Record<string, unknown>).quotedAmount) : null;
                  return (
                    <li key={e.id} className="flex items-start gap-2 text-xs">
                      <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                      <div className="flex-1">
                        <div className="text-zinc-200 capitalize">{e.eventType.replace(/_/g, " ")} <span className="text-zinc-500 font-normal">· {e.actor ?? "system"}</span></div>
                        <div className="text-zinc-500 text-[10px]">{new Date(e.occurredAt).toLocaleString()}</div>
                        {amt && <div className="text-zinc-400 text-[10px]">Amount: {fmtMoney(amt)}</div>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
            {data.opp.notes && (
              <div className="rounded bg-zinc-900 border border-zinc-800 p-3">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Notes</div>
                <div className="text-xs text-zinc-300 whitespace-pre-wrap">{data.opp.notes}</div>
              </div>
            )}
            <RelatedSection title="Same lane history" items={data.relatedSameLane} onPick={onPickRelated} testId="related-same-lane" />
            <RelatedSection title="Same customer history" items={data.relatedSameCustomer} onPick={onPickRelated} testId="related-same-customer" />
            <RelatedSection title="Similar lane group" items={data.relatedSameLaneGroup} onPick={onPickRelated} testId="related-same-lane-group" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function RelatedSection({ title, items, onPick, testId }: { title: string; items: Quote[]; onPick: (id: string) => void; testId: string }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="rounded bg-zinc-900 border border-zinc-800 p-3" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">{title} <span className="text-zinc-600">({items.length})</span></div>
      <ul className="space-y-1">
        {items.slice(0, 8).map(r => (
          <li key={r.id}>
            <button onClick={() => onPick(r.id)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-zinc-800 flex items-center justify-between gap-2" data-testid={`${testId}-item-${r.id}`}>
              <span className="text-zinc-200 truncate">
                {new Date(r.requestDate).toLocaleDateString()} · {r.originCity}→{r.destCity} · {fmtMoney(r.quotedAmount)}
              </span>
              <StatusPill status={r.outcomeStatus} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded bg-zinc-900 border border-zinc-800 p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

const SOURCES = ["email", "tms", "crm", "manual", "import"] as const;

function InlineOutcome({ quote, reasons, onChange, pending }: {
  quote: Quote; reasons: Reason[];
  onChange: (id: string, status: string, reasonId: string | null) => void;
  pending: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const eligibleReasons = useMemo(() => {
    const cat = quote.outcomeStatus.startsWith("won") ? "won"
      : quote.outcomeStatus.startsWith("lost") ? "lost"
      : quote.outcomeStatus === "no_response" ? "no_response"
      : quote.outcomeStatus === "expired" ? "expired" : null;
    return cat ? reasons.filter(r => r.category === cat) : [];
  }, [quote.outcomeStatus, reasons]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex" data-testid={`inline-outcome-${quote.id}`} disabled={pending}>
          <StatusPill status={quote.outcomeStatus} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-2 bg-zinc-900 border-zinc-700" align="start">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5 px-1">Set outcome</div>
        <div className="space-y-0.5">
          {Object.keys(STATUS_LABELS).map(s => (
            <button key={s}
              onClick={() => { onChange(quote.id, s, null); setOpen(false); }}
              className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-zinc-800 ${s === quote.outcomeStatus ? "bg-zinc-800/60" : ""}`}
              data-testid={`inline-outcome-option-${quote.id}-${s}`}>
              <StatusPill status={s} />
            </button>
          ))}
        </div>
        {eligibleReasons.length > 0 && (
          <div className="mt-2 pt-2 border-t border-zinc-800">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1 px-1">Reason</div>
            <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
              {eligibleReasons.map(r => (
                <button key={r.id}
                  onClick={() => { onChange(quote.id, quote.outcomeStatus, r.id); setOpen(false); }}
                  className={`w-full text-left px-2 py-1 rounded text-xs text-zinc-300 hover:bg-zinc-800 ${quote.outcomeReasonId === r.id ? "bg-zinc-800/60 text-zinc-100" : ""}`}
                  data-testid={`inline-reason-option-${quote.id}-${r.id}`}>{r.label}</button>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function QuoteEditForm({ quote, customers, reps, carriers, reasons, draft, onChange, onCancel, onSave, isSaving }: {
  quote: Quote; customers: Customer[]; reps: Rep[]; carriers: Carrier[]; reasons: Reason[];
  draft: Record<string, unknown>; onChange: (d: Record<string, unknown>) => void;
  onCancel: () => void; onSave: () => void; isSaving: boolean;
}): JSX.Element {
  const get = <T,>(k: string, fallback: T): T => (k in draft ? draft[k] as T : fallback);
  const set = (k: string, v: unknown): void => onChange({ ...draft, [k]: v });
  const status = get("outcomeStatus", quote.outcomeStatus);
  const cat = String(status).startsWith("won") ? "won"
    : String(status).startsWith("lost") ? "lost"
    : status === "no_response" ? "no_response"
    : status === "expired" ? "expired" : null;
  const eligibleReasons = cat ? reasons.filter(r => r.category === cat) : reasons;
  const validThroughDraft = get<string | null>("validThrough", quote.validThrough);
  const validThroughInput = validThroughDraft ? new Date(validThroughDraft).toISOString().slice(0, 10) : "";

  return (
    <div className="rounded bg-zinc-900 border border-amber-500/30 p-3 space-y-3" data-testid="quote-edit-form">
      <div className="text-[10px] uppercase tracking-wider text-amber-400">Edit quote</div>
      <div className="grid grid-cols-2 gap-2">
        <FormCol label="Customer">
          <Select value={get("customerId", quote.customerId)} onValueChange={(v) => set("customerId", v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-customer"><SelectValue /></SelectTrigger>
            <SelectContent>{customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Rep">
          <Select value={get("repId", quote.repId ?? "_none") as string} onValueChange={(v) => set("repId", v === "_none" ? null : v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-rep"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">— Unassigned —</SelectItem>
              {reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Origin city">
          <Input className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={get("originCity", quote.originCity)} onChange={(e) => set("originCity", e.target.value)} data-testid="edit-origin-city" />
        </FormCol>
        <FormCol label="Origin ST">
          <Input className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={get("originState", quote.originState)} onChange={(e) => set("originState", e.target.value.toUpperCase())} maxLength={2} data-testid="edit-origin-state" />
        </FormCol>
        <FormCol label="Dest city">
          <Input className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={get("destCity", quote.destCity)} onChange={(e) => set("destCity", e.target.value)} data-testid="edit-dest-city" />
        </FormCol>
        <FormCol label="Dest ST">
          <Input className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={get("destState", quote.destState)} onChange={(e) => set("destState", e.target.value.toUpperCase())} maxLength={2} data-testid="edit-dest-state" />
        </FormCol>
        <FormCol label="Equipment">
          <Select value={get("equipment", quote.equipment)} onValueChange={(v) => set("equipment", v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-equipment"><SelectValue /></SelectTrigger>
            <SelectContent>{EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Source">
          <Select value={get("source", quote.source)} onValueChange={(v) => set("source", v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-source"><SelectValue /></SelectTrigger>
            <SelectContent>{SOURCES.map(s => <SelectItem key={s} value={s}>{s.toUpperCase()}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Quoted $">
          <Input type="number" step="0.01" className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={String(get("quotedAmount", quote.quotedAmount ?? ""))} onChange={(e) => set("quotedAmount", e.target.value)} data-testid="edit-quoted-amount" />
        </FormCol>
        <FormCol label="Carrier paid $">
          <Input type="number" step="0.01" className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={String(get("carrierPaid", quote.carrierPaid ?? ""))} onChange={(e) => set("carrierPaid", e.target.value)} data-testid="edit-carrier-paid" />
        </FormCol>
        <FormCol label="Carrier">
          <Select value={get("carrierId", quote.carrierId ?? "_none") as string} onValueChange={(v) => set("carrierId", v === "_none" ? null : v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-carrier"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">— None —</SelectItem>
              {carriers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Valid through">
          <Input type="date" className="h-8 bg-zinc-950 border-zinc-700 text-xs" value={validThroughInput} onChange={(e) => set("validThrough", e.target.value ? new Date(e.target.value).toISOString() : null)} data-testid="edit-valid-through" />
        </FormCol>
        <FormCol label="Outcome">
          <Select value={status as string} onValueChange={(v) => set("outcomeStatus", v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-outcome"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.keys(STATUS_LABELS).map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Reason">
          <Select value={(get("outcomeReasonId", quote.outcomeReasonId ?? "_none") as string) || "_none"} onValueChange={(v) => set("outcomeReasonId", v === "_none" ? null : v)}>
            <SelectTrigger className="h-8 bg-zinc-950 border-zinc-700 text-xs" data-testid="edit-reason"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">— None —</SelectItem>
              {eligibleReasons.map(r => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormCol>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-zinc-500">Notes</Label>
        <textarea className="w-full mt-0.5 rounded bg-zinc-950 border border-zinc-700 p-2 text-xs text-zinc-100 min-h-[60px]"
          value={String(get("notes", quote.notes ?? ""))} onChange={(e) => set("notes", e.target.value)} data-testid="edit-notes" />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="button-edit-cancel">Cancel</Button>
        <Button size="sm" onClick={onSave} disabled={isSaving || Object.keys(draft).length === 0}
          className="bg-amber-500 hover:bg-amber-600 text-zinc-950" data-testid="button-edit-save">
          {isSaving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function FormCol({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</Label>
      {children}
    </div>
  );
}

function NewQuoteDialog({ open, onOpenChange, customers, reps, onSubmit, isSubmitting }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  customers: Customer[]; reps: Rep[];
  onSubmit: (payload: Record<string, unknown>) => void; isSubmitting: boolean;
}): JSX.Element {
  const [form, setForm] = useState({
    customerId: "", repId: "_none",
    originCity: "", originState: "",
    destCity: "", destState: "",
    equipment: "Dry Van",
    quotedAmount: "",
    validThrough: "",
    source: "manual",
    sourceReference: "",
    notes: "",
  });
  useEffect(() => {
    if (open) setForm({
      customerId: "", repId: "_none",
      originCity: "", originState: "",
      destCity: "", destState: "",
      equipment: "Dry Van", quotedAmount: "",
      validThrough: "", source: "manual",
      sourceReference: "", notes: "",
    });
  }, [open]);
  const upd = (k: string, v: string): void => setForm(f => ({ ...f, [k]: v }));
  const valid = form.customerId && form.originCity && form.originState && form.destCity && form.destState && form.equipment;
  const submit = (): void => {
    const payload: Record<string, unknown> = {
      customerId: form.customerId,
      repId: form.repId === "_none" ? null : form.repId,
      originCity: form.originCity.trim(),
      originState: form.originState.trim().toUpperCase(),
      destCity: form.destCity.trim(),
      destState: form.destState.trim().toUpperCase(),
      equipment: form.equipment,
      source: form.source,
    };
    if (form.quotedAmount) payload.quotedAmount = form.quotedAmount;
    if (form.validThrough) payload.validThrough = new Date(form.validThrough).toISOString();
    if (form.sourceReference.trim()) payload.sourceReference = form.sourceReference.trim();
    if (form.notes.trim()) payload.notes = form.notes.trim();
    onSubmit(payload);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-zinc-700 text-zinc-100 max-w-[640px]" data-testid="new-quote-dialog">
        <DialogHeader><DialogTitle>Log a new quote request</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <FormCol label="Customer *">
            <Select value={form.customerId} onValueChange={(v) => upd("customerId", v)}>
              <SelectTrigger className="h-9 bg-zinc-950 border-zinc-700" data-testid="new-customer"><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent>{customers.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Rep">
            <Select value={form.repId} onValueChange={(v) => upd("repId", v)}>
              <SelectTrigger className="h-9 bg-zinc-950 border-zinc-700" data-testid="new-rep"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_none">— Unassigned —</SelectItem>
                {reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Origin city *">
            <Input className="h-9 bg-zinc-950 border-zinc-700" value={form.originCity} onChange={(e) => upd("originCity", e.target.value)} data-testid="new-origin-city" />
          </FormCol>
          <FormCol label="Origin state *">
            <Input className="h-9 bg-zinc-950 border-zinc-700" value={form.originState} onChange={(e) => upd("originState", e.target.value.toUpperCase())} maxLength={2} data-testid="new-origin-state" />
          </FormCol>
          <FormCol label="Destination city *">
            <Input className="h-9 bg-zinc-950 border-zinc-700" value={form.destCity} onChange={(e) => upd("destCity", e.target.value)} data-testid="new-dest-city" />
          </FormCol>
          <FormCol label="Destination state *">
            <Input className="h-9 bg-zinc-950 border-zinc-700" value={form.destState} onChange={(e) => upd("destState", e.target.value.toUpperCase())} maxLength={2} data-testid="new-dest-state" />
          </FormCol>
          <FormCol label="Equipment">
            <Select value={form.equipment} onValueChange={(v) => upd("equipment", v)}>
              <SelectTrigger className="h-9 bg-zinc-950 border-zinc-700" data-testid="new-equipment"><SelectValue /></SelectTrigger>
              <SelectContent>{EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Quoted amount $">
            <Input type="number" step="0.01" className="h-9 bg-zinc-950 border-zinc-700" value={form.quotedAmount} onChange={(e) => upd("quotedAmount", e.target.value)} data-testid="new-quoted-amount" />
          </FormCol>
          <FormCol label="Valid through">
            <Input type="date" className="h-9 bg-zinc-950 border-zinc-700" value={form.validThrough} onChange={(e) => upd("validThrough", e.target.value)} data-testid="new-valid-through" />
          </FormCol>
          <FormCol label="Source">
            <Select value={form.source} onValueChange={(v) => upd("source", v)}>
              <SelectTrigger className="h-9 bg-zinc-950 border-zinc-700" data-testid="new-source"><SelectValue /></SelectTrigger>
              <SelectContent>{SOURCES.map(s => <SelectItem key={s} value={s}>{s.toUpperCase()}</SelectItem>)}</SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Source reference">
            <Input className="h-9 bg-zinc-950 border-zinc-700" placeholder="e.g. EMAIL-1234" value={form.sourceReference} onChange={(e) => upd("sourceReference", e.target.value)} data-testid="new-source-ref" />
          </FormCol>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-zinc-500">Notes</Label>
          <textarea className="w-full mt-0.5 rounded bg-zinc-950 border border-zinc-700 p-2 text-xs text-zinc-100 min-h-[60px]"
            value={form.notes} onChange={(e) => upd("notes", e.target.value)} data-testid="new-notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-new-cancel">Cancel</Button>
          <Button onClick={submit} disabled={!valid || isSubmitting}
            className="bg-amber-500 hover:bg-amber-600 text-zinc-950" data-testid="button-new-save">
            {isSubmitting ? "Saving..." : "Log quote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
