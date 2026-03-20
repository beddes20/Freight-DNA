import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  PieChart, TrendingUp, TrendingDown, Minus, Plus, Sparkles,
  Pencil, Trash2, RefreshCw, Loader2, BarChart3, Info,
  Trophy, Truck, Upload,
} from "lucide-react";
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { MarketShareEntry, Rfp } from "@shared/schema";

interface Props {
  companyId: string;
  rfps?: Rfp[];
}

type EntryForm = {
  entryType: "monthly" | "rfp_cycle";
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  totalMarketLoads: string;
  vtLoads: string;
  spotLoads: string;
  rfpId: string;
  notes: string;
};

const emptyForm = (): EntryForm => ({
  entryType: "monthly",
  periodLabel: "",
  periodStart: "",
  periodEnd: "",
  totalMarketLoads: "",
  vtLoads: "",
  spotLoads: "",
  rfpId: "",
  notes: "",
});

function calcPct(vtLoads: number | null, spotLoads: number | null, totalMarketLoads: number | null): number | null {
  if (!totalMarketLoads || totalMarketLoads <= 0) return null;
  const total = (vtLoads ?? 0) + (spotLoads ?? 0);
  return Math.round((total / totalMarketLoads) * 1000) / 10;
}

function PctBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <Badge variant="secondary">—</Badge>;
  const color = pct >= 30 ? "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400"
    : pct >= 15 ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400"
    : pct >= 5 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400"
    : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400";
  return <Badge className={color}>{pct}%</Badge>;
}

function TrendIcon({ current, prev }: { current: number | null; prev: number | null }) {
  if (current === null || prev === null) return null;
  const diff = current - prev;
  if (diff > 0.5) return <TrendingUp className="h-4 w-4 text-green-500" />;
  if (diff < -0.5) return <TrendingDown className="h-4 w-4 text-red-500" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const pct = payload.find((p: any) => p.dataKey === "pct")?.value;
  const vt = payload.find((p: any) => p.dataKey === "vtLoads")?.value;
  const spot = payload.find((p: any) => p.dataKey === "spotLoads")?.value;
  const total = payload.find((p: any) => p.dataKey === "totalMarketLoads")?.value;
  return (
    <div className="bg-card border border-border rounded-lg shadow-lg p-3 text-xs space-y-1">
      <p className="font-semibold text-sm">{label}</p>
      {pct !== undefined && <p className="text-primary font-bold text-base">{pct}% market share</p>}
      {vt !== undefined && <p>Contracted: <strong>{(vt ?? 0).toLocaleString()}</strong> loads</p>}
      {spot !== undefined && spot > 0 && <p>Spot: <strong>{spot.toLocaleString()}</strong> loads</p>}
      {total !== undefined && total > 0 && <p className="text-muted-foreground">Total market: {total.toLocaleString()} loads</p>}
    </div>
  );
};

export function MarketShareCard({ companyId, rfps = [] }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<MarketShareEntry | null>(null);
  const [form, setForm] = useState<EntryForm>(emptyForm());
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [autoCalcing, setAutoCalcing] = useState(false);
  const [activeTab, setActiveTab] = useState<"monthly" | "rfp_cycle">("monthly");
  const [uploadingFile, setUploadingFile] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const { data: entries = [], isLoading } = useQuery<MarketShareEntry[]>({
    queryKey: ["/api/companies", companyId, "market-share"],
    queryFn: () => fetch(`/api/companies/${companyId}/market-share`, { credentials: "include" }).then(r => r.json()),
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", `/api/companies/${companyId}/market-share`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/companies", companyId, "market-share"] });
      setDialogOpen(false);
      setForm(emptyForm());
      toast({ title: "Entry saved" });
    },
    onError: () => toast({ title: "Failed to save entry", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => apiRequest("PATCH", `/api/market-share/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/companies", companyId, "market-share"] });
      setDialogOpen(false);
      setEditEntry(null);
      setForm(emptyForm());
      toast({ title: "Entry updated" });
    },
    onError: () => toast({ title: "Failed to update entry", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/market-share/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/companies", companyId, "market-share"] });
      setDeleteId(null);
      toast({ title: "Entry deleted" });
    },
    onError: () => toast({ title: "Failed to delete entry", variant: "destructive" }),
  });

  const handleAutoCalc = async () => {
    setAutoCalcing(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/market-share/auto-calc`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      if (!data.months?.length) {
        toast({ title: "No financial data found", description: `No loads matched for "${data.customerName}"`, variant: "destructive" });
        return;
      }
      // Create entries for each month that doesn't already exist
      const existingLabels = new Set(entries.filter(e => e.entryType === "monthly").map(e => e.periodLabel));
      const toCreate = data.months.filter((m: any) => !existingLabels.has(m.periodLabel));
      if (!toCreate.length) {
        toast({ title: "All months already imported", description: "No new periods to add" });
        return;
      }
      for (const m of toCreate) {
        await apiRequest("POST", `/api/companies/${companyId}/market-share`, {
          entryType: "monthly",
          periodLabel: m.periodLabel,
          periodStart: m.periodStart,
          periodEnd: m.periodEnd,
          vtLoads: m.vtLoads,
          spotLoads: m.spotLoads,
          totalMarketLoads: null,
          notes: "Auto-calculated from financial data",
        });
      }
      qc.invalidateQueries({ queryKey: ["/api/companies", companyId, "market-share"] });
      toast({
        title: "Financial data imported",
        description: `Added ${toCreate.length} month${toCreate.length !== 1 ? "s" : ""} — set total market loads to calculate %`,
      });
    } catch {
      toast({ title: "Auto-calculate failed", variant: "destructive" });
    } finally {
      setAutoCalcing(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/companies/${companyId}/market-share/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error ?? "Upload failed");
      }
      const data = await res.json();
      qc.invalidateQueries({ queryKey: ["/api/companies", companyId, "market-share"] });
      toast({
        title: `Imported ${data.created} entr${data.created !== 1 ? "ies" : "y"}`,
        description: data.skipped > 0 ? `${data.skipped} row${data.skipped !== 1 ? "s" : ""} skipped (missing period label)` : undefined,
      });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message ?? "Could not parse file", variant: "destructive" });
    } finally {
      setUploadingFile(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const openAdd = (type: "monthly" | "rfp_cycle" = "monthly") => {
    setEditEntry(null);
    setForm({ ...emptyForm(), entryType: type });
    setDialogOpen(true);
  };

  const openEdit = (entry: MarketShareEntry) => {
    setEditEntry(entry);
    setForm({
      entryType: (entry.entryType as "monthly" | "rfp_cycle") || "monthly",
      periodLabel: entry.periodLabel ?? "",
      periodStart: entry.periodStart ?? "",
      periodEnd: entry.periodEnd ?? "",
      totalMarketLoads: entry.totalMarketLoads != null ? String(entry.totalMarketLoads) : "",
      vtLoads: entry.vtLoads != null ? String(entry.vtLoads) : "",
      spotLoads: entry.spotLoads != null ? String(entry.spotLoads) : "",
      rfpId: entry.rfpId ?? "",
      notes: entry.notes ?? "",
    });
    setDialogOpen(true);
  };

  const handleSave = () => {
    const payload = {
      entryType: form.entryType,
      periodLabel: form.periodLabel.trim(),
      periodStart: form.periodStart || null,
      periodEnd: form.periodEnd || null,
      totalMarketLoads: form.totalMarketLoads ? parseInt(form.totalMarketLoads) : null,
      vtLoads: form.vtLoads ? parseInt(form.vtLoads) : 0,
      spotLoads: form.spotLoads ? parseInt(form.spotLoads) : 0,
      rfpId: form.rfpId || null,
      notes: form.notes.trim() || null,
    };
    if (!payload.periodLabel) { toast({ title: "Period label is required", variant: "destructive" }); return; }
    if (editEntry) updateMutation.mutate({ id: editEntry.id, data: payload });
    else createMutation.mutate(payload);
  };

  const monthlyEntries = useMemo(() =>
    entries.filter(e => e.entryType === "monthly").sort((a, b) => (a.periodStart ?? "").localeCompare(b.periodStart ?? "")),
    [entries]
  );

  const rfpEntries = useMemo(() =>
    entries.filter(e => e.entryType === "rfp_cycle").sort((a, b) => (b.periodStart ?? "").localeCompare(a.periodStart ?? "")),
    [entries]
  );

  const chartData = useMemo(() =>
    monthlyEntries.map((e, i) => {
      const pct = calcPct(e.vtLoads, e.spotLoads, e.totalMarketLoads);
      return {
        label: e.periodLabel,
        pct,
        vtLoads: e.vtLoads ?? 0,
        spotLoads: e.spotLoads ?? 0,
        totalMarketLoads: e.totalMarketLoads ?? 0,
        prevPct: i > 0 ? calcPct(monthlyEntries[i - 1].vtLoads, monthlyEntries[i - 1].spotLoads, monthlyEntries[i - 1].totalMarketLoads) : null,
      };
    }),
    [monthlyEntries]
  );

  const latestMonthly = monthlyEntries[monthlyEntries.length - 1];
  const prevMonthly = monthlyEntries[monthlyEntries.length - 2];
  const latestPct = latestMonthly ? calcPct(latestMonthly.vtLoads, latestMonthly.spotLoads, latestMonthly.totalMarketLoads) : null;
  const prevPct = prevMonthly ? calcPct(prevMonthly.vtLoads, prevMonthly.spotLoads, prevMonthly.totalMarketLoads) : null;

  const rfpForEntry = (rfpId: string | null | undefined) => rfps.find(r => r.id === rfpId);

  const hasMissingTotal = monthlyEntries.some(e => !e.totalMarketLoads);

  return (
    <>
      <Card data-testid="card-market-share">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <PieChart className="h-4 w-4 text-primary" />
              Market Share
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={handleAutoCalc} disabled={autoCalcing} className="h-7 text-xs gap-1.5" data-testid="button-ms-auto-calc">
                {autoCalcing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                From Financial Data
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => uploadRef.current?.click()}
                disabled={uploadingFile}
                className="h-7 text-xs gap-1"
                data-testid="button-ms-upload"
                title="Upload Excel/CSV with columns: Period, VT Loads, Spot Loads, Total Market Loads"
              >
                {uploadingFile ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Upload
              </Button>
              <input
                ref={uploadRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleFileUpload}
                data-testid="input-ms-file-upload"
              />
              <Button variant="outline" size="sm" onClick={() => openAdd(activeTab)} className="h-7 text-xs gap-1" data-testid="button-ms-add">
                <Plus className="h-3 w-3" /> Add
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {isLoading ? (
            <div className="space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" /></div>
          ) : entries.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground space-y-2">
              <BarChart3 className="h-8 w-8 mx-auto opacity-30" />
              <p className="text-sm font-medium">No market share data yet</p>
              <p className="text-xs max-w-xs mx-auto">Click "From Financial Data" to auto-import monthly load counts, upload a spreadsheet, or add entries manually to track your share of this account's freight.</p>
            </div>
          ) : (
            <>
              {/* Current snapshot */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border bg-card p-3 text-center space-y-0.5">
                  <p className="text-xs text-muted-foreground">Current Share</p>
                  <div className="flex items-center justify-center gap-1">
                    <p className="text-2xl font-bold text-primary">{latestPct !== null ? `${latestPct}%` : "—"}</p>
                    <TrendIcon current={latestPct} prev={prevPct} />
                  </div>
                  {latestMonthly && <p className="text-xs text-muted-foreground">{latestMonthly.periodLabel}</p>}
                </div>
                <div className="rounded-xl border bg-card p-3 text-center space-y-0.5">
                  <p className="text-xs text-muted-foreground">VT Loads (month)</p>
                  <p className="text-2xl font-bold">{latestMonthly ? ((latestMonthly.vtLoads ?? 0) + (latestMonthly.spotLoads ?? 0)).toLocaleString() : "—"}</p>
                  {latestMonthly && latestMonthly.spotLoads ? (
                    <p className="text-xs text-muted-foreground">{latestMonthly.spotLoads} spot</p>
                  ) : <p className="text-xs text-muted-foreground opacity-0">.</p>}
                </div>
                <div className="rounded-xl border bg-card p-3 text-center space-y-0.5">
                  <p className="text-xs text-muted-foreground">Total Market</p>
                  <p className="text-2xl font-bold">{latestMonthly?.totalMarketLoads ? latestMonthly.totalMarketLoads.toLocaleString() : "—"}</p>
                  <p className="text-xs text-muted-foreground">loads/mo</p>
                </div>
              </div>

              {hasMissingTotal && (
                <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Some entries are missing <strong>Total Market Loads</strong> — edit them to calculate market share %</span>
                </div>
              )}

              {/* Tabs */}
              <div className="flex gap-1 border-b">
                <button
                  onClick={() => setActiveTab("monthly")}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${activeTab === "monthly" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  data-testid="tab-ms-monthly"
                >
                  Monthly Trend
                </button>
                <button
                  onClick={() => setActiveTab("rfp_cycle")}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${activeTab === "rfp_cycle" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  data-testid="tab-ms-rfp-cycle"
                >
                  RFP Bid Cycles {rfpEntries.length > 0 && <span className="ml-1 text-muted-foreground">({rfpEntries.length})</span>}
                </button>
              </div>

              {activeTab === "monthly" && (
                <>
                  {chartData.length >= 2 ? (
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                          <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v != null ? `${v}%` : ""} domain={[0, "auto"]} />
                          <Tooltip content={<CustomTooltip />} />
                          <ReferenceLine y={20} stroke="#6b7280" strokeDasharray="4 2" label={{ value: "20%", fontSize: 10, fill: "#6b7280" }} />
                          <Bar dataKey="vtLoads" name="Contracted" fill="#001AB3" opacity={0.7} radius={[2, 2, 0, 0]} yAxisId={0} hide />
                          <Line
                            type="monotone"
                            dataKey="pct"
                            name="Market Share %"
                            stroke="#001AB3"
                            strokeWidth={2.5}
                            dot={{ r: 4, fill: "#001AB3" }}
                            activeDot={{ r: 6 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : chartData.length === 1 ? (
                    <div className="text-xs text-muted-foreground text-center py-4">Add more months to see the trend chart</div>
                  ) : null}

                  <div className="space-y-1 max-h-52 overflow-y-auto">
                    {[...monthlyEntries].reverse().map((entry, i) => {
                      const pct = calcPct(entry.vtLoads, entry.spotLoads, entry.totalMarketLoads);
                      const idx = monthlyEntries.indexOf(entry);
                      const prev = idx > 0 ? monthlyEntries[idx - 1] : null;
                      const prevP = prev ? calcPct(prev.vtLoads, prev.spotLoads, prev.totalMarketLoads) : null;
                      return (
                        <div key={entry.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 group text-sm" data-testid={`row-ms-monthly-${entry.id}`}>
                          <span className="w-20 text-xs font-medium shrink-0">{entry.periodLabel}</span>
                          <PctBadge pct={pct} />
                          <TrendIcon current={pct} prev={prevP} />
                          <span className="text-xs text-muted-foreground flex-1">
                            {((entry.vtLoads ?? 0) + (entry.spotLoads ?? 0)).toLocaleString()} VT loads
                            {entry.spotLoads ? ` (${entry.spotLoads} spot)` : ""}
                            {entry.totalMarketLoads ? ` / ${entry.totalMarketLoads.toLocaleString()} total` : " — set total to calculate %"}
                          </span>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button onClick={() => openEdit(entry)} className="text-muted-foreground hover:text-foreground p-1 rounded" data-testid={`button-ms-edit-${entry.id}`}>
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button onClick={() => setDeleteId(entry.id)} className="text-muted-foreground hover:text-destructive p-1 rounded" data-testid={`button-ms-delete-${entry.id}`}>
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {activeTab === "rfp_cycle" && (
                <div className="space-y-2">
                  {rfpEntries.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Trophy className="h-7 w-7 mx-auto mb-2 opacity-30" />
                      <p className="text-sm">No RFP bid cycles yet</p>
                      <p className="text-xs mt-1">Add a cycle to track your win rate per bid</p>
                      <Button variant="outline" size="sm" className="mt-3 text-xs gap-1" onClick={() => openAdd("rfp_cycle")}>
                        <Plus className="h-3 w-3" /> Add RFP Cycle
                      </Button>
                    </div>
                  ) : rfpEntries.map(entry => {
                    const pct = calcPct(entry.vtLoads, entry.spotLoads, entry.totalMarketLoads);
                    const linkedRfp = rfpForEntry(entry.rfpId);
                    return (
                      <div key={entry.id} className="rounded-xl border p-3 space-y-2 group" data-testid={`row-ms-rfp-${entry.id}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">{entry.periodLabel}</p>
                            {linkedRfp && (
                              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                                <Sparkles className="h-3 w-3" /> RFP: {linkedRfp.title}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <PctBadge pct={pct} />
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => openEdit(entry)} className="text-muted-foreground hover:text-foreground p-1 rounded" data-testid={`button-ms-rfp-edit-${entry.id}`}>
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button onClick={() => setDeleteId(entry.id)} className="text-muted-foreground hover:text-destructive p-1 rounded" data-testid={`button-ms-rfp-delete-${entry.id}`}>
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
                            <p className="text-xs text-muted-foreground">RFP Volume</p>
                            <p className="text-sm font-semibold">{entry.totalMarketLoads?.toLocaleString() ?? "—"}</p>
                          </div>
                          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
                            <p className="text-xs text-muted-foreground">VT Awarded</p>
                            <p className="text-sm font-semibold">{(entry.vtLoads ?? 0).toLocaleString()}</p>
                          </div>
                          <div className="rounded-lg bg-muted/50 px-2 py-1.5">
                            <p className="text-xs text-muted-foreground">Spot/Trans</p>
                            <p className="text-sm font-semibold">{(entry.spotLoads ?? 0).toLocaleString()}</p>
                          </div>
                        </div>
                        {entry.notes && <p className="text-xs text-muted-foreground italic">{entry.notes}</p>}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={open => { if (!open) { setDialogOpen(false); setEditEntry(null); setForm(emptyForm()); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editEntry ? "Edit Entry" : "Add Market Share Entry"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Type</Label>
              <Select value={form.entryType} onValueChange={v => setForm(f => ({ ...f, entryType: v as any }))}>
                <SelectTrigger className="h-8 text-sm" data-testid="select-ms-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly Snapshot</SelectItem>
                  <SelectItem value="rfp_cycle">RFP Bid Cycle</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Period Label <span className="text-destructive">*</span></Label>
              <Input
                value={form.periodLabel}
                onChange={e => setForm(f => ({ ...f, periodLabel: e.target.value }))}
                placeholder={form.entryType === "monthly" ? "e.g. Jan 2025" : "e.g. 2025 Annual Bid"}
                className="h-8 text-sm"
                data-testid="input-ms-period-label"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Period Start</Label>
                <Input type="date" value={form.periodStart} onChange={e => setForm(f => ({ ...f, periodStart: e.target.value }))} className="h-8 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Period End</Label>
                <Input type="date" value={form.periodEnd} onChange={e => setForm(f => ({ ...f, periodEnd: e.target.value }))} className="h-8 text-sm" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                {form.entryType === "rfp_cycle" ? "RFP Total Volume (loads)" : "Total Market Loads (denominator)"}
              </Label>
              <Input
                type="number"
                value={form.totalMarketLoads}
                onChange={e => setForm(f => ({ ...f, totalMarketLoads: e.target.value }))}
                placeholder={form.entryType === "rfp_cycle" ? "Total loads in the RFP" : "Customer's total loads this period"}
                className="h-8 text-sm"
                data-testid="input-ms-total-market"
              />
              <p className="text-xs text-muted-foreground">
                {form.entryType === "rfp_cycle"
                  ? "Use the RFP's total annual load count as the denominator"
                  : "Set from the RFP or estimate from industry data"}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  {form.entryType === "rfp_cycle" ? "VT Awarded Loads" : "VT Loads (contracted)"}
                </Label>
                <Input
                  type="number"
                  value={form.vtLoads}
                  onChange={e => setForm(f => ({ ...f, vtLoads: e.target.value }))}
                  placeholder="0"
                  className="h-8 text-sm"
                  data-testid="input-ms-vt-loads"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Spot / Transactional Loads</Label>
                <Input
                  type="number"
                  value={form.spotLoads}
                  onChange={e => setForm(f => ({ ...f, spotLoads: e.target.value }))}
                  placeholder="0"
                  className="h-8 text-sm"
                  data-testid="input-ms-spot-loads"
                />
              </div>
            </div>

            {(form.vtLoads || form.spotLoads) && form.totalMarketLoads ? (
              <div className="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-sm text-center">
                <span className="text-muted-foreground">Calculated share: </span>
                <span className="font-bold text-primary">
                  {calcPct(parseInt(form.vtLoads || "0"), parseInt(form.spotLoads || "0"), parseInt(form.totalMarketLoads))}%
                </span>
                <span className="text-xs text-muted-foreground ml-2">
                  ({(parseInt(form.vtLoads || "0") + parseInt(form.spotLoads || "0")).toLocaleString()} / {parseInt(form.totalMarketLoads).toLocaleString()} loads)
                </span>
              </div>
            ) : null}

            {form.entryType === "rfp_cycle" && rfps.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Link to RFP (optional)</Label>
                <Select value={form.rfpId || "none"} onValueChange={v => setForm(f => ({ ...f, rfpId: v === "none" ? "" : v }))}>
                  <SelectTrigger className="h-8 text-sm" data-testid="select-ms-rfp">
                    <SelectValue placeholder="Select an RFP…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {rfps.map(r => (
                      <SelectItem key={r.id} value={r.id}>{r.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">Notes (optional)</Label>
              <Textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Context, source, caveats…"
                className="text-sm min-h-[60px] resize-none"
                data-testid="textarea-ms-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDialogOpen(false); setEditEntry(null); setForm(emptyForm()); }}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
              className="bg-[#001AB3] hover:bg-[#044ad3]"
              data-testid="button-ms-save"
            >
              {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete entry?</AlertDialogTitle>
            <AlertDialogDescription>This market share entry will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="button-ms-delete-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
