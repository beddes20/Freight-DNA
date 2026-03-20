import { useState, useCallback, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart3,
  Upload,
  Search,
  Truck,
  DollarSign,
  Package,
  TrendingUp,
  Filter,
  X,
  FileSpreadsheet,
  Loader2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Check,
  Pencil,
  Link,
  Database,
  Download,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { DataAnalystPortlet } from "@/components/data-analyst-portlet";

type FinancialRow = {
  "Order number"?: string | number;
  "Customer"?: string;
  "Operations user"?: string;
  "Order type"?: string;
  "Movement type"?: string;
  "Date ordered"?: string;
  "Shipper city"?: string;
  "Shipper state"?: string;
  "Consignee city"?: string;
  "Consignee state"?: string;
  "Status"?: string;
  "Shipper location name"?: string;
  "Consignee location name"?: string;
  "Commodity description"?: string;
  "Freight charge"?: string | number;
  "Other Charges"?: string | number;
  "Total charges"?: string | number;
  "Broker"?: string;
  "Rate"?: string | number;
  "Weight"?: string | number;
  [key: string]: any;
};

type UploadMeta = { id: string; fileName: string; uploadedAt: string; rowCount: number };
type FinancialData = { id: string; fileName: string; uploadedAt: string; rowCount: number; rows: FinancialRow[] };

const PAGE_SIZE = 50;

function toNumber(val: any): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function formatCurrency(val: any) {
  const n = toNumber(val);
  return n === 0 ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(val: any) {
  if (!val) return "—";
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString();
  } catch {
    return String(val);
  }
}

export default function Financials() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [search, setSearch] = useState("");
  const [filterRep, setFilterRep] = useState("all");
  const [filterCustomer, setFilterCustomer] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAdminOrNam = user?.role === "admin" || user?.role === "director" || user?.role === "national_account_manager" || user?.role === "sales" || user?.role === "sales_director";
  const canSyncOneDrive = user?.role === "admin" || user?.role === "national_account_manager" || user?.role === "sales" || user?.role === "sales_director";

  const [oneDriveUrlInput, setOneDriveUrlInput] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);

  const { data: financialData, isLoading } = useQuery<FinancialData | null>({
    queryKey: ["/api/financials"],
  });

  const { data: uploads = [], isLoading: uploadsLoading } = useQuery<UploadMeta[]>({
    queryKey: ["/api/financials/uploads"],
    enabled: isAdmin,
  });

  const { data: oneDriveSetting } = useQuery<{ url: string }>({
    queryKey: ["/api/settings/onedrive-url"],
    enabled: canSyncOneDrive,
  });

  const saveUrlMutation = useMutation({
    mutationFn: async (url: string) => {
      await apiRequest("PATCH", "/api/settings/onedrive-url", { url });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/onedrive-url"] });
      setEditingUrl(false);
      toast({ title: "OneDrive URL saved" });
    },
    onError: () => {
      toast({ title: "Failed to save URL", variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/financials/sync-onedrive", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Sync failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-lane-corridors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-heatmap"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proximity-matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sync-alert"] });
      toast({ title: "Sync complete", description: `${data.rowCount.toLocaleString()} records imported from OneDrive.` });
    },
    onError: (error: Error) => {
      toast({ title: "Sync failed", description: error.message, variant: "destructive" });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/financials/upload", { method: "POST", body: formData });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/account-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team/performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-lane-corridors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-heatmap"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proximity-matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sync-alert"] });
      toast({ title: "Upload successful", description: "Financial data has been updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message || "Please try again.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => fetch(`/api/financials/uploads/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/financials/account-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/team/performance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-lane-corridors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/historical-heatmap"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proximity-matches"] });
      toast({ title: "Upload deleted" });
    },
  });

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      toast({ title: "Invalid file type", description: "Please upload an Excel or CSV file.", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  }, [uploadMutation, toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const rows: FinancialRow[] = financialData?.rows || [];

  const uniqueReps = Array.from(new Set(rows.map(r => r["Operations user"]).filter(Boolean))).sort();
  const uniqueCustomers = Array.from(new Set(rows.map(r => r["Customer"]).filter(Boolean))).sort();
  const uniqueStatuses = Array.from(new Set(rows.map(r => r["Status"]).filter(Boolean))).sort();

  const filtered = rows.filter(r => {
    const q = search.toLowerCase();
    if (filterRep !== "all" && r["Operations user"] !== filterRep) return false;
    if (filterCustomer !== "all" && r["Customer"] !== filterCustomer) return false;
    if (filterStatus !== "all" && r["Status"] !== filterStatus) return false;
    if (q) {
      const haystack = [r["Customer"], r["Operations user"], r["Shipper city"], r["Consignee city"], r["Order number"]].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const totalRevenue = filtered.reduce((s, r) => s + toNumber(r["Total charges"]), 0);
  const totalFreight = filtered.reduce((s, r) => s + toNumber(r["Freight charge"]), 0);
  const loadCount = filtered.length;
  const avgRate = loadCount > 0 ? filtered.reduce((s, r) => s + toNumber(r["Rate"]), 0) / loadCount : 0;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const clearFilters = () => {
    setSearch("");
    setFilterRep("all");
    setFilterCustomer("all");
    setFilterStatus("all");
    setPage(1);
  };

  const hasFilters = search || filterRep !== "all" || filterCustomer !== "all" || filterStatus !== "all";

  const financialContextData = useMemo(() => {
    if (!rows.length) return "";

    // --- Column discovery ---
    const allColumns = rows.length > 0 ? Object.keys(rows[0]) : [];

    // --- Detect date columns ---
    const dateCols = allColumns.filter(col => /date|day/i.test(col));

    // Helper: parse a cell value as a JS Date
    const parseDate = (val: unknown): Date | null => {
      if (!val) return null;
      // Excel serial number
      if (typeof val === "number" && val > 1000) {
        const d = new Date((val - 25569) * 86400 * 1000);
        if (!isNaN(d.getTime())) return d;
      }
      const d = new Date(String(val));
      return isNaN(d.getTime()) ? null : d;
    };

    const lines: string[] = [
      `Financial Data File: ${financialData?.fileName || "Unknown"}`,
      `Total Records: ${rows.length.toLocaleString()} (ALL aggregations below are computed from every row)`,
      `Columns (${allColumns.length}): ${allColumns.join(" | ")}`,
      `Total Revenue (Total Charges): $${rows.reduce((s, r) => s + toNumber(r["Total charges"]), 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      `Total Freight Charges: $${rows.reduce((s, r) => s + toNumber(r["Freight charge"]), 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    ];

    // --- Unique values for key categorical columns ---
    const catCols = ["Customer", "Operations user", "Broker", "Shipper state", "Consignee state", "Tender Method", "Order Type", "Equipment type", "Status", "Mode"];
    catCols.forEach(col => {
      const vals = [...new Set(rows.map(r => String(r[col] || "")).filter(Boolean))];
      if (vals.length > 0 && vals.length <= 80) {
        lines.push(`Unique ${col} values (${vals.length}): ${vals.slice(0, 60).join(", ")}`);
      }
    });

    // --- Monthly breakdowns from ALL rows for each detected date column ---
    const orderTypeCol = allColumns.find(c => /order.?type/i.test(c)) || "Order Type";
    const tenderCol = allColumns.find(c => /tender/i.test(c)) || "Tender Method";
    const repCol = allColumns.find(c => /operations.?user|broker/i.test(c)) || "Operations user";

    dateCols.forEach(dateCol => {
      type MonthEntry = { loads: number; revenue: number; byOrderType: Record<string, number>; byRep: Record<string, number> };
      const monthMap: Record<string, MonthEntry> = {};

      rows.forEach(r => {
        const d = parseDate(r[dateCol]);
        if (!d) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthMap[key]) monthMap[key] = { loads: 0, revenue: 0, byOrderType: {}, byRep: {} };
        const entry = monthMap[key];
        entry.loads++;
        entry.revenue += toNumber(r["Total charges"]);
        const ot = String(r[orderTypeCol] || r[tenderCol] || "Unknown").trim();
        entry.byOrderType[ot] = (entry.byOrderType[ot] || 0) + 1;
        const rep = String(r[repCol] || r["Broker"] || "Unknown").trim();
        if (rep && rep !== "Unknown") entry.byRep[rep] = (entry.byRep[rep] || 0) + 1;
      });

      const sorted = Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b));
      if (sorted.length > 0) {
        lines.push("", `MONTHLY BREAKDOWN BY ${dateCol.toUpperCase()} (all ${rows.length} rows, exact counts):`);
        sorted.forEach(([month, data]) => {
          const label = (() => {
            const [yr, mo] = month.split("-");
            return new Date(Number(yr), Number(mo) - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
          })();
          const orderBreakdown = Object.entries(data.byOrderType)
            .sort((a, b) => b[1] - a[1])
            .map(([type, cnt]) => `${type}: ${cnt}`)
            .join(", ");
          const repBreakdown = Object.entries(data.byRep)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([rep, cnt]) => `${rep}: ${cnt}`)
            .join(", ");
          lines.push(`  ${label} (${month}): ${data.loads} loads | $${data.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} revenue`);
          if (orderBreakdown) lines.push(`    Order Types: ${orderBreakdown}`);
          if (repBreakdown) lines.push(`    By Rep: ${repBreakdown}`);
        });
      }
    });

    // --- Aggregated summaries (all rows) ---
    const repMap: Record<string, { loads: number; revenue: number }> = {};
    const custMap: Record<string, { loads: number; revenue: number }> = {};
    const laneMap: Record<string, { loads: number; revenue: number }> = {};

    rows.forEach(r => {
      const rep = r["Operations user"] || r["Broker"] || "";
      const cust = r["Customer"] || "";
      const origCity = r["Shipper city"] || "";
      const origState = r["Shipper state"] || "";
      const destCity = r["Consignee city"] || "";
      const destState = r["Consignee state"] || "";
      const lane = origCity && destCity ? `${origCity}, ${origState} → ${destCity}, ${destState}` : "";
      const rev = toNumber(r["Total charges"]);

      if (rep) { repMap[rep] = repMap[rep] || { loads: 0, revenue: 0 }; repMap[rep].loads++; repMap[rep].revenue += rev; }
      if (cust) { custMap[cust] = custMap[cust] || { loads: 0, revenue: 0 }; custMap[cust].loads++; custMap[cust].revenue += rev; }
      if (lane) { laneMap[lane] = laneMap[lane] || { loads: 0, revenue: 0 }; laneMap[lane].loads++; laneMap[lane].revenue += rev; }
    });

    const topReps = Object.entries(repMap).sort((a, b) => b[1].loads - a[1].loads).slice(0, 15);
    const topCusts = Object.entries(custMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 25);
    const topLanes = Object.entries(laneMap).sort((a, b) => b[1].loads - a[1].loads).slice(0, 30);

    if (topReps.length) {
      lines.push("", "TOP REPS BY LOAD COUNT (all rows):");
      topReps.forEach(([name, s]) => lines.push(`  • ${name}: ${s.loads.toLocaleString()} loads | $${s.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} revenue`));
    }
    if (topCusts.length) {
      lines.push("", "TOP CUSTOMERS BY REVENUE (all rows):");
      topCusts.forEach(([name, s]) => lines.push(`  • ${name}: $${s.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ${s.loads.toLocaleString()} loads`));
    }
    if (topLanes.length) {
      lines.push("", "TOP LANES BY LOAD COUNT (all rows):");
      topLanes.forEach(([lane, s]) => lines.push(`  • ${lane}: ${s.loads.toLocaleString()} loads | $${s.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} revenue`));
    }

    // --- Raw row sample: up to 3000 rows for record-level lookups ---
    const sampleSize = Math.min(rows.length, 3000);
    const sampleRows = rows.slice(0, sampleSize);
    lines.push("", `RAW DATA SAMPLE (${sampleSize} of ${rows.length} rows — use MONTHLY BREAKDOWN sections above for exact date-filtered totals):`);
    lines.push(allColumns.join(" | "));
    sampleRows.forEach(r => {
      lines.push(allColumns.map(col => String(r[col] ?? "")).join(" | "));
    });

    return lines.join("\n");
  }, [rows, financialData]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div
        className="relative overflow-hidden rounded-xl px-6 py-5 text-white"
        style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #334155 100%)" }}
      >
        <div className="pointer-events-none absolute -top-10 -right-10 h-48 w-48 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute -bottom-8 -right-4 h-32 w-32 rounded-full bg-white/5" />
        <div className="pointer-events-none absolute top-1/2 right-24 -translate-y-1/2 h-20 w-20 rounded-full bg-white/5" />
        <div className="relative flex items-start justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
              <BarChart3 className="h-6 w-6" />
              Numbers
            </h1>
            <p className="text-white/60 mt-1 text-sm">
              {financialData ? `${financialData.rowCount.toLocaleString()} total records · ${financialData.fileName}` : "Upload your Excel data to get started"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/financials"] });
                queryClient.invalidateQueries({ queryKey: ["/api/financials/uploads"] });
                queryClient.invalidateQueries({ queryKey: ["/api/financials/account-summary"] });
                queryClient.invalidateQueries({ queryKey: ["/api/team/performance"] });
                queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
                queryClient.invalidateQueries({ queryKey: ["/api/opportunities"] });
                queryClient.invalidateQueries({ queryKey: ["/api/historical-data-summary"] });
                queryClient.invalidateQueries({ queryKey: ["/api/historical-lane-corridors"] });
                queryClient.invalidateQueries({ queryKey: ["/api/historical-heatmap"] });
                queryClient.invalidateQueries({ queryKey: ["/api/proximity-matches"] });
                queryClient.invalidateQueries({ queryKey: ["/api/sync-alert"] });
              }}
              data-testid="button-refresh-financials"
              className="flex items-center gap-1.5 rounded-lg bg-white/15 backdrop-blur-sm px-3 py-2 text-white/80 hover:text-white hover:bg-white/25 transition-colors text-sm"
              title="Refresh all financial data"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            {financialData && (
              <div className="hidden sm:flex items-center gap-2 rounded-lg bg-white/15 backdrop-blur-sm px-3 py-2">
                <Package className="h-4 w-4" />
                <span className="text-sm font-medium">{filtered.length.toLocaleString()} records</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="data" className="w-full">
        <TabsList data-testid="tabs-financials">
          <TabsTrigger value="data" className="flex items-center gap-1.5" data-testid="tab-data">
            <BarChart3 className="h-3.5 w-3.5" />Data
          </TabsTrigger>
          <TabsTrigger value="analyze" className="flex items-center gap-1.5" data-testid="tab-analyze">
            <Sparkles className="h-3.5 w-3.5" />DNA Analysis
          </TabsTrigger>
        </TabsList>

        <TabsContent value="data" className="space-y-4 mt-4">

      {canSyncOneDrive && oneDriveSetting && (
        <Card className="border-blue-200 dark:border-blue-800/50 bg-gradient-to-r from-blue-50/50 to-white dark:from-blue-950/20 dark:to-card">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <CloudDownload className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                OneDrive Sync
              </CardTitle>
              {oneDriveSetting.url && financialData && (
                <span className="text-xs text-muted-foreground" data-testid="text-last-sync">
                  Last updated: {formatDate(financialData.uploadedAt)}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                {editingUrl ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={oneDriveUrlInput}
                      onChange={e => setOneDriveUrlInput(e.target.value)}
                      placeholder="Paste your OneDrive share link here..."
                      className="flex-1 text-xs"
                      data-testid="input-onedrive-url"
                    />
                    <Button
                      size="sm"
                      onClick={() => saveUrlMutation.mutate(oneDriveUrlInput)}
                      disabled={saveUrlMutation.isPending || !oneDriveUrlInput.trim()}
                      data-testid="button-save-onedrive-url"
                    >
                      {saveUrlMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      <span className="ml-1">Save</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingUrl(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {oneDriveSetting.url ? (
                      <>
                        <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-xs text-muted-foreground truncate">{oneDriveSetting.url}</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">No OneDrive link configured</span>
                    )}
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 h-7 px-2"
                        onClick={() => { setOneDriveUrlInput(oneDriveSetting.url || ""); setEditingUrl(true); }}
                        data-testid="button-edit-onedrive-url"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {canSyncOneDrive && oneDriveSetting.url && (
              <Button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="w-full gap-2"
                data-testid="button-sync-onedrive"
              >
                {syncMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Syncing from OneDrive...
                  </>
                ) : (
                  <>
                    <CloudDownload className="h-4 w-4" />
                    Sync from OneDrive
                  </>
                )}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Upload Financial Data
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              data-testid="dropzone-financial"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
                data-testid="input-financial-file"
              />
              {uploadMutation.isPending ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                  <p className="text-sm font-medium">Processing your file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <FileSpreadsheet className="h-10 w-10 text-muted-foreground/50" />
                  <p className="text-sm font-medium">Drag & drop your Excel file here</p>
                  <p className="text-xs text-muted-foreground">or click to browse · .xlsx, .xls, .csv</p>
                </div>
              )}
            </div>

            {uploads.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Upload History</p>
                {uploadsLoading ? (
                  <Skeleton className="h-10 w-full" />
                ) : (
                  uploads.map(u => (
                    <div key={u.id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{u.fileName}</p>
                        <p className="text-xs text-muted-foreground">{u.rowCount.toLocaleString()} rows · {formatDate(u.uploadedAt)}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <a
                          href={`/api/financials/uploads/${u.id}/download`}
                          download
                          title="Download as Excel"
                          data-testid={`button-download-upload-${u.id}`}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => deleteMutation.mutate(u.id)}
                          disabled={deleteMutation.isPending}
                          data-testid={`button-delete-upload-${u.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : financialData ? (
        <>
          <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Total Revenue", value: `$${(totalRevenue / 1000).toFixed(1)}K`, sub: "Total charges", icon: DollarSign, color: "text-green-600 dark:text-green-400", bg: "bg-green-100 dark:bg-green-900/30" },
              { label: "Total Freight", value: `$${(totalFreight / 1000).toFixed(1)}K`, sub: "Freight charges", icon: Truck, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-100 dark:bg-blue-900/30" },
              { label: "Load Count", value: loadCount.toLocaleString(), sub: "Filtered records", icon: Package, color: "text-purple-600 dark:text-purple-400", bg: "bg-purple-100 dark:bg-purple-900/30" },
              { label: "Avg Rate", value: avgRate > 0 ? `$${avgRate.toFixed(0)}` : "—", sub: "Per load", icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-100 dark:bg-emerald-900/30" },
            ].map(s => (
              <Card key={s.label} className="overflow-hidden">
                <CardContent className="p-4 sm:p-6">
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${s.bg}`}>
                        <s.icon className={`h-4 w-4 ${s.color}`} />
                      </div>
                    </div>
                    <div>
                      <div className="text-xl sm:text-2xl font-bold">{s.value}</div>
                      <p className="text-xs text-muted-foreground mt-0.5">{s.sub}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-36">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search orders, customers..."
                    value={search}
                    onChange={e => { setSearch(e.target.value); setPage(1); }}
                    className="pl-8"
                    data-testid="input-search-financials"
                  />
                </div>
                <Select value={filterRep} onValueChange={v => { setFilterRep(v); setPage(1); }}>
                  <SelectTrigger className="w-44" data-testid="select-filter-rep">
                    <SelectValue placeholder="All Reps" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Reps</SelectItem>
                    {uniqueReps.map(r => <SelectItem key={r} value={r!}>{r}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filterCustomer} onValueChange={v => { setFilterCustomer(v); setPage(1); }}>
                  <SelectTrigger className="w-52" data-testid="select-filter-customer">
                    <SelectValue placeholder="All Customers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Customers</SelectItem>
                    {uniqueCustomers.map(c => <SelectItem key={c} value={c!}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filterStatus} onValueChange={v => { setFilterStatus(v); setPage(1); }}>
                  <SelectTrigger className="w-40" data-testid="select-filter-status">
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    {uniqueStatuses.map(s => <SelectItem key={s} value={s!}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                {hasFilters && (
                  <Button variant="outline" size="sm" onClick={clearFilters} className="gap-1" data-testid="button-clear-filters">
                    <X className="h-3 w-3" /> Clear
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      {["Order #", "Customer", "Rep", "Date", "Origin", "Destination", "Status", "Freight", "Total", "Rate"].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paginated.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="py-12 text-center text-muted-foreground text-sm">
                          No records match your filters
                        </td>
                      </tr>
                    ) : (
                      paginated.map((r, i) => (
                        <tr key={i} className="border-b hover:bg-muted/30 transition-colors" data-testid={`row-financial-${i}`}>
                          <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">{r["Order number"] || "—"}</td>
                          <td className="px-3 py-2.5 font-medium max-w-[160px] truncate">{r["Customer"] || "—"}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r["Operations user"] || "—"}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{formatDate(r["Date ordered"])}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{r["Shipper city"] ? `${r["Shipper city"]}, ${r["Shipper state"]}` : "—"}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">{r["Consignee city"] ? `${r["Consignee city"]}, ${r["Consignee state"]}` : "—"}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            {r["Status"] ? (
                              <Badge variant="outline" className="text-xs capitalize">{r["Status"]}</Badge>
                            ) : "—"}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-xs">{formatCurrency(r["Freight charge"])}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-xs font-semibold text-green-600 dark:text-green-400">{formatCurrency(r["Total charges"])}</td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-xs">{formatCurrency(r["Rate"])}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t">
                  <p className="text-xs text-muted-foreground">
                    Showing {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                      <ChevronLeft className="h-3 w-3" />
                    </Button>
                    <span className="text-xs px-2">{page} / {totalPages}</span>
                    <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

        </>
      ) : !isLoading && !isAdmin ? (
        <div className="text-center py-16 text-muted-foreground">
          <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">No financial data available yet</p>
          <p className="text-xs mt-1">An admin needs to upload the data first</p>
        </div>
      ) : null}

        </TabsContent>

        <TabsContent value="analyze" className="mt-4">
          <Card data-testid="card-financial-ai-analysis">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500" />
                DNA Analysis
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">Ask Claude to surface trends, compare reps, flag anomalies, and identify opportunities in this data</p>
            </CardHeader>
            <CardContent className="pt-0">
              <DataAnalystPortlet
                contextType="financial"
                contextData={financialContextData}
                presetQuestions={[
                  "Who are the top performing reps and what's driving their results?",
                  "Which customers have the most potential to grow?",
                  "What are the top lanes by volume and revenue?",
                  "Are there any trends or anomalies I should be aware of?",
                  "Which customers or lanes should we focus on to grow margin?",
                ]}
                emptyLabel="Upload financial data to enable DNA Analysis"
              />
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>
    </div>
  );
}
