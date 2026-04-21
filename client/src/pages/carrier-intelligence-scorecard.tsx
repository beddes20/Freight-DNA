import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trophy, Search, Download, BookmarkPlus, RefreshCw, Truck, AlertTriangle, Phone, Mail, MessageSquare } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MoveStatusFilter, type MoveStatus, sumByMoveStatus } from "@/components/move-status-filter";
import { LineChart, Line, ResponsiveContainer, Tooltip as ReTooltip, XAxis, YAxis } from "recharts";
import {
  useCarrierIntelPrefs, useSaveCarrierIntelPrefs,
  colorForMarginPct, colorForOnTimePct,
  fmtCurrency, fmtNum, fmtPct, fmtRpm, fmtDate, downloadCsv,
  type CarrierIntelThresholds,
} from "@/lib/carrier-intelligence";
import { useToast } from "@/hooks/use-toast";

interface ScorecardRow {
  id: string;
  carrierName: string;
  equipmentType: string;
  loads: number;
  loads30d: number;
  loads90d: number;
  revenue: string | number;
  cost: string | number;
  margin: string | number;
  marginPct: string | number;
  avgRpm: string | number | null;
  revenuePerLoad: string | number | null;
  onTimePct: string | number | null;
  activeLoads: number;
  availableLoads: number;
  doNotUse: boolean;
  performanceScore: number;
  tier: string;
  daysSinceLastLoad: number | null;
  lastLoadDate: string | null;
}
interface CarrierContact {
  id: string; name: string; role: string; email: string | null; phone: string | null;
  extension: string | null; preferredMethod: string | null; isPrimary: boolean;
}
interface RecentLoad {
  id: string; orderId: string; bucket: string; moveStatus: string | null;
  customerName: string | null; equipmentType: string | null;
  originCity: string | null; originState: string | null;
  destinationCity: string | null; destinationState: string | null;
  pickupDate: string | null; deliveryDate: string | null;
  revenue: string | null; margin: string | null; marginPct: string | null;
  totalMiles: string | null;
}
interface LaneMixRow { lane: string; loads: number; revenue: number; margin: number }
interface TrendPoint {
  month: string; loads: number; revenue: number; margin: number;
  marginPct: number | null; onTimePct: number | null;
}
interface CarrierDetailResp {
  carrier: { id: string | null; name: string; status: string | null; tags: string[] };
  scorecard: ScorecardRow;
  equipmentSplits: ScorecardRow[];
  moveStatus: MoveStatus[];
  recentLoads: RecentLoad[];
  laneMix: LaneMixRow[];
  trend: TrendPoint[];
  contacts: CarrierContact[];
  recommendations: Array<{ id: string; loadFactId: string; rank: number; totalScore: number; reason: string | null }>;
}

const TIER_BADGE: Record<string, string> = {
  A: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40",
  B: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40",
  C: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40",
  new: "bg-muted text-muted-foreground border-border",
};

export default function CarrierIntelligenceScorecardPage() {
  const { toast } = useToast();
  const prefsQ = useCarrierIntelPrefs();
  const savePrefs = useSaveCarrierIntelPrefs();
  const userPrefs = prefsQ.data?.user;
  const thresholds = userPrefs?.thresholds;

  const [moveStatus, setMoveStatus] = useState<MoveStatus[] | null>(null);
  const [tier, setTier] = useState<string>("");
  const [equipment, setEquipment] = useState<string>("");
  const [minLoads, setMinLoads] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [drawerCarrier, setDrawerCarrier] = useState<string | null>(null);
  const [drawerMoveStatus, setDrawerMoveStatus] = useState<MoveStatus[]>(["realized", "active"]);
  const [savedViewName, setSavedViewName] = useState("");

  // Initialize controls from prefs once
  if (userPrefs && moveStatus === null) {
    setMoveStatus((userPrefs.scorecard.moveStatus as MoveStatus[]) ?? ["realized", "active"]);
    setTier(userPrefs.scorecard.tier ?? "all");
    setEquipment(userPrefs.scorecard.equipment ?? "ALL");
    setMinLoads(userPrefs.scorecard.minLoads ?? 1);
  }

  const { data, isLoading, refetch, isFetching } = useQuery<{ rows?: ScorecardRow[]; scorecards?: ScorecardRow[] }>({
    queryKey: ["/api/carrier-intelligence/scorecard"],
    select: (d) => ({ scorecards: d.rows ?? d.scorecards ?? [] }),
  });

  const drawerMsKey = drawerMoveStatus.slice().sort().join(",");
  const detailQ = useQuery<CarrierDetailResp>({
    queryKey: ["/api/carrier-intelligence/carriers", drawerCarrier, drawerMsKey],
    enabled: !!drawerCarrier,
    queryFn: async () => {
      const res = await fetch(
        `/api/carrier-intelligence/carriers/${encodeURIComponent(drawerCarrier!)}?moveStatus=${encodeURIComponent(drawerMsKey)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load carrier detail");
      return res.json();
    },
  });

  const equipmentOptions = useMemo(() => {
    const set = new Set<string>(["ALL"]);
    (data?.scorecards ?? []).forEach((r) => set.add(r.equipmentType ?? "UNKNOWN"));
    return Array.from(set);
  }, [data]);

  const filtered = useMemo(() => {
    const rows = data?.scorecards ?? [];
    const q = search.trim().toLowerCase();
    const ms = moveStatus ?? ["realized", "active"];
    return rows
      .filter((r) => (equipment && equipment !== "ALL" ? r.equipmentType === equipment : r.equipmentType === "ALL"))
      .filter((r) => (tier && tier !== "all" ? r.tier === tier : true))
      .filter((r) => (minLoads != null ? sumByMoveStatus(r, ms) >= minLoads : true))
      .filter((r) => !q || r.carrierName.toLowerCase().includes(q))
      .sort((a, b) => b.performanceScore - a.performanceScore);
  }, [data, search, equipment, tier, minLoads, moveStatus]);

  const totals = useMemo(() => {
    const ms = moveStatus ?? ["realized", "active"];
    return filtered.reduce(
      (acc, r) => {
        const isRealized = ms.includes("realized");
        if (isRealized) {
          acc.loads += Number(r.loads || 0);
          acc.revenue += Number(r.revenue || 0);
          acc.margin += Number(r.margin || 0);
        }
        if (ms.includes("active")) acc.active += Number(r.activeLoads || 0);
        if (ms.includes("available")) acc.available += Number(r.availableLoads || 0);
        return acc;
      },
      { loads: 0, revenue: 0, margin: 0, active: 0, available: 0 },
    );
  }, [filtered, moveStatus]);

  function persistFilters() {
    if (!moveStatus) return;
    savePrefs.mutate({
      scorecard: {
        ...(userPrefs?.scorecard as any),
        moveStatus, tier, equipment, minLoads: minLoads ?? 1,
        sort: "performanceScore_desc",
        savedViews: userPrefs?.scorecard.savedViews ?? [],
      },
    });
  }

  function saveCurrentView() {
    if (!savedViewName.trim() || !moveStatus) return;
    const id = `v_${Date.now()}`;
    const next = [
      ...(userPrefs?.scorecard.savedViews ?? []),
      { id, name: savedViewName.trim(), payload: { moveStatus, tier, equipment, minLoads, search } },
    ];
    savePrefs.mutate({
      scorecard: { ...(userPrefs?.scorecard as any), savedViews: next },
    } as any);
    setSavedViewName("");
    toast({ title: "View saved", description: "It will appear in your saved views." });
  }

  function applySavedView(id: string) {
    const v = userPrefs?.scorecard.savedViews.find((x) => x.id === id);
    if (!v) return;
    const p = v.payload as any;
    if (p.moveStatus) setMoveStatus(p.moveStatus);
    if (p.tier) setTier(p.tier);
    if (p.equipment) setEquipment(p.equipment);
    if (p.minLoads != null) setMinLoads(p.minLoads);
    if (p.search != null) setSearch(p.search);
  }

  function exportCsv() {
    const ms = moveStatus ?? ["realized", "active"];
    downloadCsv(`carrier-scorecard-${new Date().toISOString().slice(0, 10)}.csv`, filtered.map((r) => ({
      Carrier: r.carrierName,
      Equipment: r.equipmentType,
      Tier: r.tier,
      Score: r.performanceScore,
      Loads: ms.includes("realized") ? r.loads : "",
      ActiveLoads: ms.includes("active") ? r.activeLoads : "",
      AvailableLoads: ms.includes("available") ? r.availableLoads : "",
      Revenue: ms.includes("realized") ? Number(r.revenue || 0) : "",
      MarginPct: ms.includes("realized") ? Number(r.marginPct || 0) : "",
      OnTimePct: ms.includes("realized") ? Number(r.onTimePct || 0) : "",
      AvgRpm: r.avgRpm ?? "",
      LastLoadDate: r.lastLoadDate ?? "",
      DoNotUse: r.doNotUse ? "yes" : "no",
    })));
  }

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-[1400px] mx-auto" data-testid="page-carrier-intelligence-scorecard">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
            <Trophy className="h-6 w-6 text-amber-500" /> Carrier Scorecard
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Carrier-level performance from realized loads, with live in-flight and available counts. Click a carrier to dig in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh">
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-csv">
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <MoveStatusFilter
            value={moveStatus ?? ["realized", "active"]}
            onChange={(v) => { setMoveStatus(v); }}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input
                placeholder="Search carrier…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
                data-testid="input-search-carrier"
              />
            </div>
            <Select value={tier || "all"} onValueChange={setTier}>
              <SelectTrigger data-testid="select-tier"><SelectValue placeholder="Tier" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tiers</SelectItem>
                <SelectItem value="A">Tier A</SelectItem>
                <SelectItem value="B">Tier B</SelectItem>
                <SelectItem value="C">Tier C</SelectItem>
                <SelectItem value="new">New</SelectItem>
              </SelectContent>
            </Select>
            <Select value={equipment || "ALL"} onValueChange={setEquipment}>
              <SelectTrigger data-testid="select-equipment"><SelectValue placeholder="Equipment" /></SelectTrigger>
              <SelectContent>
                {equipmentOptions.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input
              type="number"
              placeholder="Min loads"
              value={minLoads ?? ""}
              onChange={(e) => setMinLoads(e.target.value === "" ? null : Number(e.target.value))}
              data-testid="input-min-loads"
            />
            <Button variant="secondary" size="sm" onClick={persistFilters} data-testid="button-save-defaults">
              Save as my defaults
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Input
              placeholder="Saved view name…"
              value={savedViewName}
              onChange={(e) => setSavedViewName(e.target.value)}
              className="w-48 h-8 text-sm"
              data-testid="input-saved-view-name"
            />
            <Button size="sm" variant="outline" onClick={saveCurrentView} disabled={!savedViewName.trim()} data-testid="button-save-view">
              <BookmarkPlus className="h-3.5 w-3.5 mr-1" /> Save view
            </Button>
            {(userPrefs?.scorecard.savedViews ?? []).map((v) => (
              <Badge
                key={v.id}
                variant="outline"
                className="cursor-pointer hover:bg-accent"
                onClick={() => applySavedView(v.id)}
                data-testid={`chip-saved-view-${v.id}`}
              >
                {v.name}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <SummaryStat label="Carriers" value={fmtNum(filtered.length)} testId="stat-carrier-count" />
        <SummaryStat label="Loads (realized)" value={fmtNum(totals.loads)} testId="stat-loads" />
        <SummaryStat label="Active" value={fmtNum(totals.active)} testId="stat-active" />
        <SummaryStat label="Available" value={fmtNum(totals.available)} testId="stat-available" />
        <SummaryStat label="Margin (realized)" value={fmtCurrency(totals.margin)} testId="stat-margin" />
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-base flex items-center gap-2"><Truck className="h-4 w-4" /> Carriers</CardTitle>
          <CardDescription>Sorted by performance score. Realized columns dim when Realized is excluded.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="table-scorecard">
                <TableHeader>
                  <TableRow>
                    <TableHead>Carrier</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Tier</TableHead>
                    <TableHead className="text-right">Loads</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                    <TableHead className="text-right">Avail</TableHead>
                    <TableHead className="text-right">Margin %</TableHead>
                    <TableHead className="text-right">On-time %</TableHead>
                    <TableHead className="text-right">Avg $/mi</TableHead>
                    <TableHead>Last load</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8" data-testid="text-no-rows">No carriers match these filters.</TableCell></TableRow>
                  ) : filtered.map((r) => {
                    const ms = moveStatus ?? ["realized", "active"];
                    const realizedDim = !ms.includes("realized") ? "text-muted-foreground/60" : "";
                    return (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => {
                          setDrawerMoveStatus(moveStatus ?? ["realized", "active"]);
                          setDrawerCarrier(r.carrierName);
                        }}
                        data-testid={`row-scorecard-${r.id}`}
                      >
                        <TableCell className="font-medium flex items-center gap-2">
                          {r.carrierName}
                          {r.doNotUse && (
                            <Badge variant="outline" className="border-red-500/50 text-red-600 dark:text-red-400" data-testid={`badge-dnu-${r.id}`}>
                              <AlertTriangle className="h-3 w-3 mr-1" /> DNU
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{r.performanceScore}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={TIER_BADGE[r.tier] ?? TIER_BADGE.new}>{r.tier.toUpperCase()}</Badge>
                        </TableCell>
                        <TableCell className={`text-right tabular-nums ${realizedDim}`}>{fmtNum(r.loads)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${ms.includes("active") ? "" : "text-muted-foreground/60"}`}>{fmtNum(r.activeLoads)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${ms.includes("available") ? "" : "text-muted-foreground/60"}`}>{fmtNum(r.availableLoads)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${realizedDim} ${thresholds ? colorForMarginPct(Number(r.marginPct), thresholds) : ""}`}>
                          {fmtPct(Number(r.marginPct))}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums ${realizedDim} ${thresholds ? colorForOnTimePct(r.onTimePct == null ? null : Number(r.onTimePct), thresholds) : ""}`}>
                          {r.onTimePct == null ? "—" : fmtPct(Number(r.onTimePct))}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.avgRpm == null ? "—" : fmtRpm(Number(r.avgRpm))}</TableCell>
                        <TableCell className="whitespace-nowrap">{fmtDate(r.lastLoadDate)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Carrier detail drawer */}
      <Sheet open={!!drawerCarrier} onOpenChange={(o) => !o && setDrawerCarrier(null)}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-2xl overflow-y-auto p-0"
          data-testid="drawer-carrier-detail"
        >
          <CarrierDetailPanel
            carrierName={drawerCarrier}
            data={detailQ.data}
            isLoading={detailQ.isLoading}
            error={detailQ.error as Error | null}
            moveStatus={drawerMoveStatus}
            onChangeMoveStatus={setDrawerMoveStatus}
            thresholds={thresholds}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

interface CarrierDetailPanelProps {
  carrierName: string | null;
  data: CarrierDetailResp | undefined;
  isLoading: boolean;
  error: Error | null;
  moveStatus: MoveStatus[];
  onChangeMoveStatus: (next: MoveStatus[]) => void;
  thresholds?: CarrierIntelThresholds;
}

function CarrierDetailPanel({
  carrierName, data, isLoading, error, moveStatus, onChangeMoveStatus, thresholds,
}: CarrierDetailPanelProps) {
  const primary = data?.contacts.find((c) => c.isPrimary) ?? data?.contacts[0];
  const tier = data?.scorecard?.tier ?? "new";
  const tierClass = TIER_BADGE[tier] ?? TIER_BADGE.new;

  return (
    <div className="flex flex-col h-full">
      <SheetHeader className="px-5 pt-5 pb-3 border-b">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 truncate" data-testid="text-drawer-carrier">
              <Truck className="h-5 w-5 text-muted-foreground shrink-0" />
              <span className="truncate">{carrierName}</span>
            </SheetTitle>
            <SheetDescription className="mt-1">
              Per-carrier deep dive: lane mix, recent loads, performance trend.
            </SheetDescription>
          </div>
          {data && (
            <div className="flex items-center gap-1.5 shrink-0">
              <Badge variant="outline" className={tierClass} data-testid="badge-drawer-tier">{tier.toUpperCase()}</Badge>
              <Badge variant="secondary" data-testid="badge-drawer-score">Score {data.scorecard.performanceScore}</Badge>
              {data.carrier.status === "do_not_use" && (
                <Badge variant="outline" className="border-red-500/50 text-red-600 dark:text-red-400">
                  <AlertTriangle className="h-3 w-3 mr-1" /> DNU
                </Badge>
              )}
            </div>
          )}
        </div>
      </SheetHeader>

      <div className="px-5 pt-4 space-y-4">
        {/* Quick actions */}
        {primary ? (
          <Card data-testid="card-primary-contact">
            <CardContent className="py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Primary contact</div>
                <div className="font-medium truncate" data-testid="text-primary-contact-name">
                  {primary.name}
                  <span className="text-muted-foreground ml-2 text-xs">{primary.role}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {primary.phone ?? "—"}{primary.extension ? ` x${primary.extension}` : ""}
                  {primary.email ? ` · ${primary.email}` : ""}
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!primary.phone}
                  asChild={!!primary.phone}
                  data-testid="button-call-primary"
                >
                  {primary.phone ? <a href={`tel:${primary.phone}`}><Phone className="h-3.5 w-3.5 mr-1" /> Call</a> : <span><Phone className="h-3.5 w-3.5 mr-1" /> Call</span>}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!primary.phone}
                  asChild={!!primary.phone}
                  data-testid="button-text-primary"
                >
                  {primary.phone ? <a href={`sms:${primary.phone}`}><MessageSquare className="h-3.5 w-3.5 mr-1" /> Text</a> : <span><MessageSquare className="h-3.5 w-3.5 mr-1" /> Text</span>}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!primary.email}
                  asChild={!!primary.email}
                  data-testid="button-email-primary"
                >
                  {primary.email ? <a href={`mailto:${primary.email}`}><Mail className="h-3.5 w-3.5 mr-1" /> Email</a> : <span><Mail className="h-3.5 w-3.5 mr-1" /> Email</span>}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : data && data.carrier.id ? (
          <div className="text-xs text-muted-foreground" data-testid="text-no-contacts">
            No active contacts on file for this carrier.
          </div>
        ) : data ? (
          <div className="text-xs text-muted-foreground" data-testid="text-not-in-rolodex">
            This carrier is not yet in your rolodex — add it to track contacts here.
          </div>
        ) : null}

        {/* Move status filter (drawer-scoped, mirrors parent) */}
        <MoveStatusFilter
          value={moveStatus}
          onChange={onChangeMoveStatus}
          testIdPrefix="chip-drawer-move-status"
        />
      </div>

      <div className="px-5 py-4 space-y-5">
        {isLoading && (
          <div className="space-y-3" data-testid="loading-drawer">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400" data-testid="text-drawer-error">
            {error.message}
          </div>
        )}

        {data && (
          <>
            {/* Headline KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniStat label="Loads" value={fmtNum(data.scorecard.loads)} testId="stat-drawer-loads" />
              <MiniStat label="Active" value={fmtNum(data.scorecard.activeLoads)} testId="stat-drawer-active" />
              <MiniStat
                label="Margin %"
                value={fmtPct(Number(data.scorecard.marginPct))}
                valueClass={thresholds ? colorForMarginPct(Number(data.scorecard.marginPct), thresholds) : undefined}
                testId="stat-drawer-margin-pct"
              />
              <MiniStat
                label="On-time %"
                value={data.scorecard.onTimePct == null ? "—" : fmtPct(Number(data.scorecard.onTimePct))}
                valueClass={thresholds ? colorForOnTimePct(data.scorecard.onTimePct == null ? null : Number(data.scorecard.onTimePct), thresholds) : undefined}
                testId="stat-drawer-on-time"
              />
            </div>

            {/* Equipment splits */}
            {data.equipmentSplits.length > 1 && (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Equipment splits</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {data.equipmentSplits.filter(s => s.equipmentType !== "ALL").map((r) => (
                    <div key={r.id} className="rounded-md border p-2.5" data-testid={`card-equip-split-${r.equipmentType}`}>
                      <div className="text-xs text-muted-foreground">{r.equipmentType}</div>
                      <div className="text-base font-semibold tabular-nums">{r.performanceScore}</div>
                      <div className="text-xs text-muted-foreground">{r.loads} loads · {fmtPct(Number(r.marginPct))}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Trend chart */}
            {data.trend.length > 0 && (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Margin % & on-time % (last {data.trend.length} mo)</CardTitle>
                </CardHeader>
                <CardContent className="h-44 pl-1 pr-3" data-testid="chart-drawer-trend">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.trend} margin={{ top: 5, right: 8, bottom: 0, left: -16 }}>
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" />
                      <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" domain={[0, 100]} />
                      <ReTooltip
                        contentStyle={{ fontSize: 12 }}
                        formatter={(v: number, name) => [v == null ? "—" : `${v.toFixed(1)}%`, name]}
                      />
                      <Line type="monotone" dataKey="marginPct" name="Margin %" stroke="#10b981" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="onTimePct" name="On-time %" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {/* Lane mix */}
            {data.laneMix.length > 0 && (
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Top lanes</CardTitle>
                  <CardDescription>Within selected move status buckets.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table data-testid="table-drawer-lane-mix">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lane</TableHead>
                        <TableHead className="text-right">Loads</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                        <TableHead className="text-right">Margin</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.laneMix.map((l, i) => (
                        <TableRow key={`${l.lane}-${i}`} data-testid={`row-lane-${i}`}>
                          <TableCell className="text-sm truncate max-w-[260px]">{l.lane}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtNum(l.loads)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtCurrency(l.revenue)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtCurrency(l.margin)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Recent loads */}
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Recent loads</CardTitle>
                <CardDescription>
                  Latest {data.recentLoads.length} loads in selected buckets ({moveStatus.join(", ") || "none"}).
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {data.recentLoads.length === 0 ? (
                  <div className="px-4 py-6 text-center text-muted-foreground text-sm" data-testid="text-no-recent-loads">
                    No loads match the selected move status.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table data-testid="table-drawer-recent-loads">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Order</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Lane</TableHead>
                          <TableHead>Pickup</TableHead>
                          <TableHead className="text-right">Revenue</TableHead>
                          <TableHead className="text-right">Margin %</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.recentLoads.map((l) => (
                          <TableRow key={l.id} data-testid={`row-load-${l.id}`}>
                            <TableCell className="font-mono text-xs">{l.orderId}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">{l.bucket}</Badge>
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {(l.originCity ?? "?")}, {l.originState ?? "?"} → {(l.destinationCity ?? "?")}, {l.destinationState ?? "?"}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">{fmtDate(l.pickupDate)}</TableCell>
                            <TableCell className="text-right tabular-nums">{l.revenue == null ? "—" : fmtCurrency(Number(l.revenue))}</TableCell>
                            <TableCell className={`text-right tabular-nums ${thresholds && l.marginPct != null ? colorForMarginPct(Number(l.marginPct) * 100, thresholds) : ""}`}>
                              {l.marginPct == null ? "—" : fmtPct(Number(l.marginPct) * 100)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Active recommendations */}
            {data.recommendations.length > 0 && (
              <Card>
                <CardHeader className="py-3"><CardTitle className="text-sm">Active recommendations</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {data.recommendations.slice(0, 8).map((rec) => (
                    <div key={rec.id} className="flex justify-between border-b last:border-0 pb-2" data-testid={`row-rec-${rec.id}`}>
                      <span className="truncate">{rec.reason ?? `Rank ${rec.rank}`}</span>
                      <span className="text-muted-foreground tabular-nums ml-2">Score {rec.totalScore}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, valueClass, testId }: { label: string; value: string; valueClass?: string; testId: string }) {
  return (
    <div className="rounded-md border p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${valueClass ?? ""}`} data-testid={testId}>{value}</div>
    </div>
  );
}

function SummaryStat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-bold tabular-nums" data-testid={testId}>{value}</div>
      </CardContent>
    </Card>
  );
}
