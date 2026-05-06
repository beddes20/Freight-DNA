import { useState, useCallback, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { fmtMoney } from "@/lib/rep-utils";
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
  TrendingDown,
  Filter,
  X,
  FileSpreadsheet,
  Loader2,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  Check,
  Pencil,
  Link,
  Database,
  Download,
  RefreshCw,
  Sparkles,
  Users,
  Trophy,
  CalendarDays,
  Target,
  Minus,
  ArrowUp,
  ArrowDown,
  Medal,
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
  const [tableCollapsed, setTableCollapsed] = useState(false);
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

  const { data: sheetsData } = useQuery<{
    bestDealDaysSpot: Record<string, any>[];
    bestDealDaysAll: Record<string, any>[];
    trendAnalysis: Record<string, any>[];
    averagesData: Record<string, any>[];
    dailyAcquisition: Record<string, any>[];
  }>({
    queryKey: ["/api/financials/sheets"],
  });

  const [todayRepFilter, setTodayRepFilter] = useState("all");
  const [todayTypeFilter, setTodayTypeFilter] = useState("all");

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
      queryClient.invalidateQueries({ queryKey: ["/api/financials/sheets"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/financials/sheets"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/financials/sheets"] });
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

  // Resolve every key column name once, case-insensitively, from whatever headers the TMS export uses.
  // This means "Order type", "Order Type", "ORDER TYPE" all work identically.
  const colMap = useMemo(() => {
    const keys = rows.length > 0 ? Object.keys(rows[0]) : [];
    const find = (pattern: RegExp, fallback: string) => keys.find(k => pattern.test(k)) ?? fallback;
    return {
      totalCharges:     find(/total.?charges?|total.?revenue/i,                          "Total charges"),
      freightCharge:    find(/freight.?charge|carrier.?cost|linehaul|^freight$/i,         "Freight charge"),
      customer:         find(/customer/i,                                                 "Customer"),
      opsUser:          find(/operations?.?user|ops?.?user/i,                            "Operations user"),
      broker:           find(/^broker$/i,                                                 "Broker"),
      orderType:        find(/order.?type|load.?type|movement.?type/i,                   "Order type"),
      tenderMethod:     find(/tender/i,                                                   "Tender Method"),
      shipperCity:      find(/shipper.?city|origin.?city|pickup.?city|^origin$/i,         "Shipper city"),
      shipperState:     find(/shipper.?state|origin.?state|pickup.?state/i,               "Shipper state"),
      consigneeCity:    find(/consignee.?city|dest.?city|delivery.?city|^destination$/i,  "Consignee city"),
      consigneeState:   find(/consignee.?state|dest.?state|delivery.?state|destination.?state/i, "Consignee state"),
      status:           find(/^status$/i,                                                 "Status"),
      mode:             find(/^mode$/i,                                                   "Mode"),
      equipType:        find(/equipment.?type|equip.?type|trailer.?type/i,               "Equipment type"),
      rate:             find(/^rate$|^price$/i,                                           "Rate"),
      orderNumber:      find(/order.?number|load.?number|shipment.?id|^order$/i,          "Order number"),
      dateOrdered:      find(/date.?ordered|order.?date|ship.?date|delivery.?date/i,      "Date ordered"),
      marginDollar:     find(/margin.?\$|^margin\s*\$|^margin$/i,                         "Margin $"),
      shipperLocName:   find(/shipper.?location.?name/i,                                  "Shipper location name"),
      consigneeLocName: find(/consignee.?location.?name/i,                                "Consignee location name"),
    };
  }, [rows]);

  const uniqueReps = useMemo(() =>
    Array.from(new Set(rows.map(r => r[colMap.opsUser] as string).filter(Boolean))).sort(),
    [rows, colMap]);
  const uniqueCustomers = useMemo(() =>
    Array.from(new Set(rows.map(r => r[colMap.customer] as string).filter(Boolean))).sort(),
    [rows, colMap]);
  const uniqueStatuses = useMemo(() =>
    Array.from(new Set(rows.map(r => r[colMap.status] as string).filter(Boolean))).sort(),
    [rows, colMap]);

  const filtered = useMemo(() => rows.filter(r => {
    const q = search.toLowerCase();
    if (filterRep !== "all" && r[colMap.opsUser] !== filterRep) return false;
    if (filterCustomer !== "all" && r[colMap.customer] !== filterCustomer) return false;
    if (filterStatus !== "all" && r[colMap.status] !== filterStatus) return false;
    if (q) {
      const haystack = [r[colMap.customer], r[colMap.opsUser], r[colMap.shipperCity], r[colMap.consigneeCity], r[colMap.orderNumber]].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }), [rows, colMap, search, filterRep, filterCustomer, filterStatus]);

  const totalRevenue = useMemo(() => filtered.reduce((s, r) => s + toNumber(r[colMap.totalCharges]), 0), [filtered, colMap]);
  const totalFreight = useMemo(() => filtered.reduce((s, r) => s + toNumber(r[colMap.freightCharge]), 0), [filtered, colMap]);
  const loadCount = filtered.length;
  const avgRate = loadCount > 0 ? filtered.reduce((s, r) => s + toNumber(r[colMap.rate]), 0) / loadCount : 0;

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

  const dashboardMetrics = useMemo(() => {
    if (!rows.length) return null;
    const { totalCharges: tcCol, freightCharge: fcCol, opsUser: ouCol, broker: brCol,
            customer: custCol, orderType: otCol, dateOrdered: doCol, marginDollar: mdCol } = colMap;

    const allKeys = Object.keys(rows[0]);
    const hasMargCol = allKeys.includes(mdCol);

    const getRowMargin = (r: any) =>
      hasMargCol ? toNumber(r[mdCol]) : toNumber(r[tcCol]) - toNumber(r[fcCol]);

    const totalRevenueAll = rows.reduce((s, r) => s + toNumber(r[tcCol]), 0);
    const totalMarginAll  = rows.reduce((s, r) => s + getRowMargin(r), 0);

    const spotCount     = rows.filter(r => /spot/i.test(String(r[otCol] ?? ""))).length;
    const contractCount = rows.filter(r => /contract/i.test(String(r[otCol] ?? ""))).length;
    const hybridCount   = rows.filter(r => /hybrid/i.test(String(r[otCol] ?? ""))).length;
    const spotPct = rows.length > 0 ? Math.round(spotCount / rows.length * 100) : 0;

    const repMap: Record<string, { loads: number; revenue: number; margin: number }> = {};
    rows.forEach(r => {
      const rep = String(r[ouCol] || r[brCol] || "").trim();
      if (!rep) return;
      if (!repMap[rep]) repMap[rep] = { loads: 0, revenue: 0, margin: 0 };
      repMap[rep].loads++;
      repMap[rep].revenue += toNumber(r[tcCol]);
      repMap[rep].margin += getRowMargin(r);
    });
    const topReps = Object.entries(repMap).sort((a, b) => b[1].loads - a[1].loads).slice(0, 5);
    const maxRepLoads = topReps[0]?.[1].loads || 1;

    const custMap: Record<string, { loads: number; revenue: number }> = {};
    rows.forEach(r => {
      const cust = String(r[custCol] || "").trim();
      if (!cust) return;
      if (!custMap[cust]) custMap[cust] = { loads: 0, revenue: 0 };
      custMap[cust].loads++;
      custMap[cust].revenue += toNumber(r[tcCol]);
    });
    const topCusts = Object.entries(custMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);
    const maxCustRev = topCusts[0]?.[1].revenue || 1;

    const dateCol = allKeys.includes(doCol) ? doCol : allKeys.find(c => /date/i.test(c));
    const parseDate = (val: any): Date | null => {
      if (!val) return null;
      if (typeof val === "number" && val > 1000) {
        const d = new Date((val - 25569) * 86400 * 1000);
        if (!isNaN(d.getTime())) return d;
      }
      const d = new Date(String(val));
      return isNaN(d.getTime()) ? null : d;
    };
    type MonthData = { loads: number; revenue: number; margin: number };
    const monthMap: Record<string, MonthData> = {};
    if (dateCol) {
      rows.forEach(r => {
        const d = parseDate(r[dateCol]);
        if (!d) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthMap[key]) monthMap[key] = { loads: 0, revenue: 0, margin: 0 };
        monthMap[key].loads++;
        monthMap[key].revenue += toNumber(r[tcCol]);
        monthMap[key].margin += getRowMargin(r);
      });
    }
    const monthlyTrend = Object.entries(monthMap)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 5)
      .map(([key, data]) => {
        const [yr, mo] = key.split("-");
        const label = new Date(Number(yr), Number(mo) - 1, 1).toLocaleString("default", { month: "short", year: "2-digit" });
        const marginPct = data.revenue > 0 ? (data.margin / data.revenue) * 100 : 0;
        return { key, label, ...data, marginPct };
      });

    return { totalRevenueAll, totalMarginAll, totalLoadsAll: rows.length, spotCount, spotPct, contractCount, hybridCount, topReps, maxRepLoads, topCusts, maxCustRev, monthlyTrend };
  }, [rows, colMap]);

  const financialContextData = useMemo(() => {
    if (!rows.length) return "";

    const { totalCharges: tcCol, freightCharge: fcCol, opsUser: ouCol, broker: brCol,
            customer: custCol, orderType: otCol, tenderMethod: tendCol,
            shipperCity: scCol, shipperState: ssCol, consigneeCity: ccCol, consigneeState: csCol,
            orderNumber: onCol, dateOrdered: doCol, status: stCol, marginDollar: mdCol } = colMap;

    const fmt0 = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const pct = (n: number, d: number) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";

    // --- Column discovery ---
    const allColumns = Object.keys(rows[0]);
    const totalRows = rows.length;

    // --- Detect date columns ---
    const dateCols = allColumns.filter(col => /date|day/i.test(col));

    // Helper: parse a cell value as a JS Date
    const parseDate = (val: unknown): Date | null => {
      if (!val) return null;
      if (typeof val === "number" && val > 1000) {
        const d = new Date((val - 25569) * 86400 * 1000);
        if (!isNaN(d.getTime())) return d;
      }
      const d = new Date(String(val));
      return isNaN(d.getTime()) ? null : d;
    };

    // Margin per row — use pre-computed column when available
    const hasMargCol = allColumns.includes(mdCol);
    const rowMargin = (r: any) => hasMargCol ? toNumber(r[mdCol]) : toNumber(r[tcCol]) - toNumber(r[fcCol]);

    const totalRevenue = rows.reduce((s, r) => s + toNumber(r[tcCol]), 0);
    const totalFreight = rows.reduce((s, r) => s + toNumber(r[fcCol]), 0);
    const totalMargin  = rows.reduce((s, r) => s + rowMargin(r), 0);
    const marginPct    = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;

    const lines: string[] = [
      `Financial Data File: ${financialData?.fileName || "Unknown"}`,
      `Total Records: ${totalRows.toLocaleString()} (ALL aggregations below are computed from every row)`,
      `Columns (${allColumns.length}): ${allColumns.join(" | ")}`,
      `Total Revenue (${tcCol}): $${fmt0(totalRevenue)}`,
      `Total Carrier Cost (${fcCol}): $${fmt0(totalFreight)}`,
      `Total Margin: $${fmt0(totalMargin)} (${marginPct.toFixed(1)}% margin)`,
    ];

    // ── DATA QUALITY STATS ──────────────────────────────────────────────────────
    lines.push("", `DATA QUALITY (all ${totalRows.toLocaleString()} rows):`);
    allColumns.forEach(col => {
      const vals = rows.map(r => r[col]);
      const nullCount   = vals.filter(v => v === null || v === undefined || String(v).trim() === "").length;
      const uniqueCount = new Set(vals.map(v => String(v ?? "").trim().toLowerCase())).size;
      const numericCount = vals.filter(v => v !== null && v !== undefined && String(v).trim() !== "" && !isNaN(Number(v))).length;
      const nonNull = totalRows - nullCount;
      const nullPctStr = pct(nullCount, totalRows);
      // Only flag columns with notable issues
      const issues: string[] = [];
      if (nullCount > 0) issues.push(`${nullCount.toLocaleString()} blanks (${nullPctStr})`);
      if (nonNull > 0 && numericCount > 0 && numericCount < nonNull) {
        issues.push(`mixed types: ${numericCount.toLocaleString()} numeric + ${(nonNull - numericCount).toLocaleString()} text`);
      }
      if (issues.length > 0) {
        lines.push(`  ${col}: ${nonNull.toLocaleString()} populated | ${issues.join(" | ")} | ${uniqueCount.toLocaleString()} unique values`);
      }
    });

    // Categorical unique-value listing for low-cardinality columns
    const catColKeys = [custCol, ouCol, brCol, ssCol, csCol, tendCol, otCol, colMap.equipType, colMap.status, colMap.mode]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    catColKeys.forEach(col => {
      const vals = [...new Set(rows.map(r => String(r[col] || "")).filter(Boolean))];
      if (vals.length > 0 && vals.length <= 80) {
        lines.push(`Unique ${col} values (${vals.length}): ${vals.slice(0, 60).join(", ")}`);
      }
    });

    // ── MONTHLY BREAKDOWNS ───────────────────────────────────────────────────────
    dateCols.forEach(dateCol => {
      type MonthEntry = {
        loads: number; revenue: number; margin: number;
        byOrderType: Record<string, { loads: number; margin: number }>;
        byRep: Record<string, { loads: number; margin: number }>;
      };
      const monthMap: Record<string, MonthEntry> = {};

      rows.forEach(r => {
        const d = parseDate(r[dateCol]);
        if (!d) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthMap[key]) monthMap[key] = { loads: 0, revenue: 0, margin: 0, byOrderType: {}, byRep: {} };
        const entry = monthMap[key];
        const rev = toNumber(r[tcCol]);
        const mgn = rowMargin(r);
        entry.loads++;
        entry.revenue += rev;
        entry.margin  += mgn;
        const ot = String(r[otCol] || r[tendCol] || "Unknown").trim();
        if (!entry.byOrderType[ot]) entry.byOrderType[ot] = { loads: 0, margin: 0 };
        entry.byOrderType[ot].loads++;
        entry.byOrderType[ot].margin += mgn;
        const rep = String(r[ouCol] || r[brCol] || "Unknown").trim();
        if (rep && rep !== "Unknown") {
          if (!entry.byRep[rep]) entry.byRep[rep] = { loads: 0, margin: 0 };
          entry.byRep[rep].loads++;
          entry.byRep[rep].margin += mgn;
        }
      });

      const sorted = Object.entries(monthMap).sort(([a], [b]) => a.localeCompare(b));
      if (sorted.length > 0) {
        lines.push("", `MONTHLY BREAKDOWN BY ${dateCol.toUpperCase()} (all ${totalRows.toLocaleString()} rows, exact counts):`);
        sorted.forEach(([month, data]) => {
          const [yr, mo] = month.split("-");
          const label = new Date(Number(yr), Number(mo) - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
          const mPct = data.revenue > 0 ? ((data.margin / data.revenue) * 100).toFixed(1) : "0.0";
          lines.push(`  ${label} (${month}): ${data.loads.toLocaleString()} loads | $${fmt0(data.revenue)} revenue | $${fmt0(data.margin)} margin (${mPct}%)`);

          const orderBreakdown = Object.entries(data.byOrderType)
            .sort((a, b) => b[1].loads - a[1].loads)
            .map(([type, s]) => `${type}: ${s.loads} loads / $${fmt0(s.margin)} margin`)
            .join(", ");
          if (orderBreakdown) lines.push(`    Order Types: ${orderBreakdown}`);

          const repBreakdown = Object.entries(data.byRep)
            .sort((a, b) => b[1].loads - a[1].loads)
            .slice(0, 10)
            .map(([rep, s]) => `${rep}: ${s.loads} loads / $${fmt0(s.margin)} margin`)
            .join(", ");
          if (repBreakdown) lines.push(`    By Rep: ${repBreakdown}`);
        });
      }
    });

    // ── AGGREGATED SUMMARIES ─────────────────────────────────────────────────────
    const repMap:  Record<string, { loads: number; revenue: number; margin: number }> = {};
    const custMap: Record<string, { loads: number; revenue: number; margin: number }> = {};
    const laneMap: Record<string, { loads: number; revenue: number; margin: number }> = {};

    rows.forEach(r => {
      const rep  = String(r[ouCol] || r[brCol] || "").trim();
      const cust = String(r[custCol] || "").trim();
      const origCity  = String(r[scCol] || "").trim();
      const origState = String(r[ssCol] || "").trim();
      const destCity  = String(r[ccCol] || "").trim();
      const destState = String(r[csCol] || "").trim();
      const lane = origCity && destCity ? `${origCity}, ${origState} → ${destCity}, ${destState}` : "";
      const rev = toNumber(r[tcCol]);
      const mgn = rowMargin(r);

      if (rep)  { repMap[rep]   = repMap[rep]   || { loads: 0, revenue: 0, margin: 0 }; repMap[rep].loads++;   repMap[rep].revenue   += rev; repMap[rep].margin   += mgn; }
      if (cust) { custMap[cust] = custMap[cust] || { loads: 0, revenue: 0, margin: 0 }; custMap[cust].loads++; custMap[cust].revenue += rev; custMap[cust].margin += mgn; }
      if (lane) { laneMap[lane] = laneMap[lane] || { loads: 0, revenue: 0, margin: 0 }; laneMap[lane].loads++; laneMap[lane].revenue += rev; laneMap[lane].margin += mgn; }
    });

    const topReps  = Object.entries(repMap).sort((a, b) => b[1].loads - a[1].loads).slice(0, 20);
    const topCusts = Object.entries(custMap).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 30);
    const topLanes = Object.entries(laneMap).sort((a, b) => b[1].loads - a[1].loads).slice(0, 40);

    if (topReps.length) {
      lines.push("", "TOP REPS BY LOAD COUNT (all rows):");
      topReps.forEach(([name, s]) => {
        const mp = s.revenue > 0 ? ((s.margin / s.revenue) * 100).toFixed(1) : "0.0";
        lines.push(`  • ${name}: ${s.loads.toLocaleString()} loads | $${fmt0(s.revenue)} revenue | $${fmt0(s.margin)} margin (${mp}%)`);
      });
    }
    if (topCusts.length) {
      lines.push("", "TOP CUSTOMERS BY REVENUE (all rows):");
      topCusts.forEach(([name, s]) => {
        const mp = s.revenue > 0 ? ((s.margin / s.revenue) * 100).toFixed(1) : "0.0";
        lines.push(`  • ${name}: ${s.loads.toLocaleString()} loads | $${fmt0(s.revenue)} revenue | $${fmt0(s.margin)} margin (${mp}%)`);
      });
    }
    if (topLanes.length) {
      lines.push("", "TOP LANES BY LOAD COUNT (all rows):");
      topLanes.forEach(([lane, s]) => {
        const mp = s.revenue > 0 ? ((s.margin / s.revenue) * 100).toFixed(1) : "0.0";
        lines.push(`  • ${lane}: ${s.loads.toLocaleString()} loads | $${fmt0(s.revenue)} revenue | $${fmt0(s.margin)} margin (${mp}%)`);
      });
    }

    // ── RAW DATA SAMPLE ──────────────────────────────────────────────────────────
    // Send key columns only so we can include more rows without hitting token limits.
    // Full aggregations above cover all rows; this section enables record-level lookups.
    const keyCols = [onCol, doCol, custCol, ouCol, scCol, ssCol, ccCol, csCol,
                     tcCol, fcCol, otCol, stCol, tendCol]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i && allColumns.includes(v));

    const sampleSize = Math.min(totalRows, 6000);
    const sampleRows = rows.slice(0, sampleSize);
    lines.push("",
      `RAW DATA SAMPLE — key columns, ${sampleSize.toLocaleString()} of ${totalRows.toLocaleString()} rows`,
      `(Note: "Margin" column is computed as ${tcCol} minus ${fcCol})`,
      [...keyCols, "Margin"].join(" | ")
    );
    sampleRows.forEach(r => {
      const mgn = rowMargin(r);
      lines.push([...keyCols.map(col => String(r[col] ?? "")), fmt0(mgn)].join(" | "));
    });

    return lines.join("\n");
  }, [rows, financialData, colMap]);

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
                queryClient.invalidateQueries({ queryKey: ["/api/financials/sheets"] });
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
        <TabsList data-testid="tabs-financials" className="flex-wrap h-auto">
          <TabsTrigger value="data" className="flex items-center gap-1.5" data-testid="tab-data">
            <BarChart3 className="h-3.5 w-3.5" />Data
          </TabsTrigger>
          <TabsTrigger value="records" className="flex items-center gap-1.5" data-testid="tab-records">
            <Trophy className="h-3.5 w-3.5" />Records
          </TabsTrigger>
          <TabsTrigger value="trends" className="flex items-center gap-1.5" data-testid="tab-trends">
            <TrendingUp className="h-3.5 w-3.5" />Trends
          </TabsTrigger>
          <TabsTrigger value="averages" className="flex items-center gap-1.5" data-testid="tab-averages">
            <Target className="h-3.5 w-3.5" />Averages
          </TabsTrigger>
          <TabsTrigger value="today" className="flex items-center gap-1.5" data-testid="tab-today">
            <CalendarDays className="h-3.5 w-3.5" />Today
          </TabsTrigger>
          <TabsTrigger value="analyze" className="flex items-center gap-1.5" data-testid="tab-analyze">
            <Sparkles className="h-3.5 w-3.5" />DNA Analysis
          </TabsTrigger>
        </TabsList>

        <TabsContent value="data" className="space-y-4 mt-4">

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

            <div className="border-t pt-4 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <CloudDownload className="h-3.5 w-3.5" />
                OneDrive Auto-Sync
              </p>
              <p className="text-xs text-muted-foreground">
                Paste a share link to your Excel file on OneDrive. The app will pull the latest data automatically on the first of each month — or you can sync manually below.
              </p>
              {editingUrl ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={oneDriveUrlInput}
                    onChange={e => setOneDriveUrlInput(e.target.value)}
                    placeholder="https://1drv.ms/x/..."
                    className="text-sm flex-1"
                    data-testid="input-onedrive-url"
                  />
                  <Button
                    size="sm"
                    onClick={() => saveUrlMutation.mutate(oneDriveUrlInput)}
                    disabled={saveUrlMutation.isPending || !oneDriveUrlInput.trim()}
                    data-testid="button-save-onedrive-url"
                  >
                    {saveUrlMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setEditingUrl(false); setOneDriveUrlInput(oneDriveSetting?.url || ""); }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0 rounded-md border bg-muted/30 px-3 py-2">
                    {oneDriveSetting?.url ? (
                      <p className="text-xs text-foreground font-mono truncate">{oneDriveSetting.url}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">No OneDrive URL configured</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setEditingUrl(true); setOneDriveUrlInput(oneDriveSetting?.url || ""); }}
                    data-testid="button-edit-onedrive-url"
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    {oneDriveSetting?.url ? "Edit" : "Set URL"}
                  </Button>
                </div>
              )}
              {oneDriveSetting?.url && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  data-testid="button-sync-onedrive"
                >
                  {syncMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-2" />Syncing from OneDrive...</>
                  ) : (
                    <><CloudDownload className="h-4 w-4 mr-2" />Sync Now</>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-24 w-full" />)}
          </div>
          <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
            {[1,2,3].map(i => <Skeleton key={i} className="h-52 w-full" />)}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : financialData && dashboardMetrics ? (
        <>
          {/* Floor-wide KPI cards */}
          <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: "Total Revenue",
                value: fmtMoney(dashboardMetrics.totalRevenueAll),
                sub: `${dashboardMetrics.totalLoadsAll.toLocaleString()} total loads`,
                icon: DollarSign, color: "text-green-600 dark:text-green-400", bg: "bg-green-100 dark:bg-green-900/30",
              },
              {
                label: "Gross Margin",
                value: fmtMoney(dashboardMetrics.totalMarginAll),
                sub: dashboardMetrics.totalLoadsAll > 0
                  ? `$${Math.round(dashboardMetrics.totalMarginAll / dashboardMetrics.totalLoadsAll).toLocaleString()} avg/load`
                  : "Revenue minus freight",
                icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-100 dark:bg-emerald-900/30",
              },
              {
                label: "Total Loads",
                value: dashboardMetrics.totalLoadsAll.toLocaleString(),
                sub: "All records in dataset",
                icon: Package, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-100 dark:bg-blue-900/30",
              },
              {
                label: "Spot Loads",
                value: dashboardMetrics.spotCount.toLocaleString(),
                sub: `${dashboardMetrics.spotPct}% spot · ${dashboardMetrics.contractCount.toLocaleString()} contract${dashboardMetrics.hybridCount > 0 ? ` · ${dashboardMetrics.hybridCount} hybrid` : ""}`,
                icon: Truck, color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-100 dark:bg-orange-900/30",
              },
            ].map(s => (
              <Card key={s.label} className="overflow-hidden">
                <CardContent className="p-4 sm:p-5">
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center gap-2">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${s.bg}`}>
                        <s.icon className={`h-4 w-4 ${s.color}`} />
                      </div>
                      <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
                    </div>
                    <div className="text-xl sm:text-2xl font-bold">{s.value}</div>
                    <p className="text-xs text-muted-foreground">{s.sub}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Insights row */}
          <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-blue-500" />
                  Monthly Trend
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {dashboardMetrics.monthlyTrend.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">No date column detected in data</p>
                ) : (
                  <div>
                    <div className="grid grid-cols-5 gap-x-2 pb-1 border-b mb-1">
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Month</span>
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Loads</span>
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Revenue</span>
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Margin</span>
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-right">Mgn%</span>
                    </div>
                    <div className="space-y-1.5">
                      {dashboardMetrics.monthlyTrend.map((m, i) => (
                        <div key={m.key} className={`grid grid-cols-5 gap-x-2 py-0.5 ${i === 0 ? "font-semibold" : ""}`}>
                          <span className="text-xs text-muted-foreground truncate">{m.label}</span>
                          <span className="text-xs tabular-nums text-right">{m.loads.toLocaleString()}</span>
                          <span className="text-xs tabular-nums text-right text-blue-600 dark:text-blue-400">
                            {fmtMoney(m.revenue)}
                          </span>
                          <span className="text-xs tabular-nums text-right text-emerald-600 dark:text-emerald-400">
                            {fmtMoney(m.margin)}
                          </span>
                          <span className={`text-xs tabular-nums text-right ${m.marginPct >= 15 ? "text-emerald-600 dark:text-emerald-400" : m.marginPct >= 10 ? "text-amber-600 dark:text-amber-400" : "text-red-500"}`}>
                            {m.marginPct.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground pt-2 border-t mt-2">Last 5 months · most recent first</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Users className="h-4 w-4 text-violet-500" />
                  Top Reps by Loads
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {dashboardMetrics.topReps.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">No rep data found</p>
                ) : (
                  <div className="space-y-2.5">
                    {dashboardMetrics.topReps.map(([rep, d], idx) => (
                      <div key={rep} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-4 shrink-0">{idx + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium truncate">{rep}</span>
                            <span className="text-xs tabular-nums text-muted-foreground ml-2 shrink-0">{d.loads} loads</span>
                          </div>
                          <div className="h-1 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-violet-500/60"
                              style={{ width: `${(d.loads / dashboardMetrics.maxRepLoads) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                    <p className="text-[10px] text-muted-foreground pt-1 border-t">By total load count in dataset</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <DollarSign className="h-4 w-4 text-green-500" />
                  Top Customers by Revenue
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {dashboardMetrics.topCusts.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-6 text-center">No customer data found</p>
                ) : (
                  <div className="space-y-2.5">
                    {dashboardMetrics.topCusts.map(([cust, d], idx) => (
                      <div key={cust} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-4 shrink-0">{idx + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium truncate">{cust}</span>
                            <span className="text-xs tabular-nums text-green-600 dark:text-green-400 ml-2 shrink-0">
                              {fmtMoney(d.revenue)}
                            </span>
                          </div>
                          <div className="h-1 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-green-500/60"
                              style={{ width: `${(d.revenue / dashboardMetrics.maxCustRev) * 100}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                    <p className="text-[10px] text-muted-foreground pt-1 border-t">By total revenue in dataset</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Data table with collapse toggle */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-start gap-2">
                <div className="flex flex-wrap flex-1 items-center gap-2">
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => setTableCollapsed(c => !c)}
                  data-testid="button-toggle-table"
                  title={tableCollapsed ? "Expand table" : "Collapse table"}
                >
                  {tableCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </Button>
              </div>
              {!tableCollapsed && (
                <p className="text-xs text-muted-foreground mt-1">
                  {filtered.length.toLocaleString()} record{filtered.length !== 1 ? "s" : ""}
                  {hasFilters ? " matching filters" : " total"}
                  {" · "}Revenue {fmtMoney(totalRevenue)}
                  {" · "}Margin {fmtMoney(Math.round(totalRevenue - totalFreight))}
                </p>
              )}
            </CardHeader>
            {!tableCollapsed && (
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
                            <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground whitespace-nowrap">{r[colMap.orderNumber] as string || "—"}</td>
                            <td className="px-3 py-2.5 font-medium max-w-[160px] truncate">{r[colMap.customer] as string || "—"}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r[colMap.opsUser] as string || "—"}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{formatDate(r[colMap.dateOrdered])}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap">{r[colMap.shipperCity] ? `${r[colMap.shipperCity]}, ${r[colMap.shipperState]}` : "—"}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap">{r[colMap.consigneeCity] ? `${r[colMap.consigneeCity]}, ${r[colMap.consigneeState]}` : "—"}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              {r[colMap.status] ? (
                                <Badge variant="outline" className="text-xs capitalize">{r[colMap.status] as string}</Badge>
                              ) : "—"}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-xs">{formatCurrency(r[colMap.freightCharge])}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-xs font-semibold text-green-600 dark:text-green-400">{formatCurrency(r[colMap.totalCharges])}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-right font-mono text-xs">{formatCurrency(r[colMap.rate])}</td>
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
            )}
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

        {/* ── RECORDS TAB ─────────────────────────────────────────────── */}
        <TabsContent value="records" className="mt-4 space-y-4">
          {(!sheetsData?.bestDealDaysSpot?.length && !sheetsData?.bestDealDaysAll?.length) ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <Trophy className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Upload your NUMBERS.xlsx file to see rep records</p>
            </CardContent></Card>
          ) : (() => {
            const fmtDate = (d: any) => {
              if (!d || d === "") return "—";
              try {
                const dt = new Date(d);
                if (isNaN(dt.getTime())) return String(d);
                return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
              } catch { return String(d); }
            };
            return (
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  { label: "Spot Records", icon: Trophy, data: sheetsData?.bestDealDaysSpot ?? [], color: "text-amber-500" },
                  { label: "All Loads Records", icon: Medal, data: sheetsData?.bestDealDaysAll ?? [], color: "text-blue-500" },
                ].map(({ label, icon: Icon, data, color }) => {
                  const cleanData = data.filter((row: any) => {
                    const r = row["Rank"];
                    return r !== "" && r !== null && r !== undefined && !isNaN(Number(r));
                  });
                  return (
                    <Card key={label}>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Icon className={`h-4 w-4 ${color}`} />
                          {label}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        {cleanData.length === 0 ? (
                          <p className="text-sm text-muted-foreground px-6 pb-4">No data available</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b bg-muted/30">
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">#</th>
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Rep</th>
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Record Date</th>
                                  <th className="px-4 py-2 text-right font-medium text-muted-foreground text-xs">Orders</th>
                                  <th className="px-4 py-2 text-right font-medium text-muted-foreground text-xs">Total YTD</th>
                                  <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {cleanData.map((row: any, i: number) => {
                                  const rank = Number(row["Rank"] ?? (i + 1));
                                  const rep = row["Sales Rep"] ?? row["Rep"] ?? "";
                                  const bestDay = row["Best Day"] ?? row["Best day"] ?? "";
                                  const orders = row["Orders That Day"] ?? row["Orders that day"] ?? row["Orders"] ?? "—";
                                  const total = row["Total Orders"] ?? row["Total orders"] ?? "";
                                  const prevBest = row["Prev Best"] ?? row["Prev best"] ?? "";
                                  const prevDate = row["Prev Date"] ?? row["Prev date"] ?? "";
                                  const isNewRecord = prevBest !== "" && prevBest !== null && prevBest !== undefined && prevBest !== 0;
                                  return (
                                    <tr key={i} className={`border-b last:border-0 ${isNewRecord ? "bg-amber-50/50 dark:bg-amber-950/20" : "hover:bg-muted/30"}`}>
                                      <td className="px-4 py-2.5">
                                        {rank === 1 ? <Trophy className="h-4 w-4 text-amber-500" /> :
                                         rank === 2 ? <Medal className="h-4 w-4 text-slate-400" /> :
                                         rank === 3 ? <Medal className="h-4 w-4 text-amber-700" /> :
                                         <span className="text-muted-foreground text-xs">{rank}</span>}
                                      </td>
                                      <td className="px-4 py-2.5 font-medium">{rep}</td>
                                      <td className="px-4 py-2.5 text-muted-foreground text-xs">{fmtDate(bestDay)}</td>
                                      <td className="px-4 py-2.5 text-right font-bold text-lg">{orders}</td>
                                      <td className="px-4 py-2.5 text-right text-muted-foreground text-xs">{total !== "" ? total : "—"}</td>
                                      <td className="px-4 py-2.5">
                                        {isNewRecord ? (
                                          <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-xs whitespace-nowrap">
                                            🏆 New! (was {prevBest} on {fmtDate(prevDate)})
                                          </Badge>
                                        ) : (
                                          <span className="text-xs text-muted-foreground">Previous record</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            );
          })()}
        </TabsContent>

        {/* ── TRENDS TAB ──────────────────────────────────────────────── */}
        <TabsContent value="trends" className="mt-4">
          {!sheetsData?.trendAnalysis?.length ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <TrendingUp className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Upload your NUMBERS.xlsx file to see account trends</p>
            </CardContent></Card>
          ) : (() => {
            const rows = sheetsData.trendAnalysis;
            const allKeys = Object.keys(rows[0] ?? {});
            const weekCols = allKeys.filter(k => k !== "Customer" && k.trim() !== "");
            return (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-blue-500" />
                    Account Trends — Week Over Week Load Acquisition
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">Green = up from prior week · Red = down · Gray = same</p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/30">
                          <th className="px-4 py-2 text-left font-medium text-muted-foreground text-xs sticky left-0 bg-muted/30 min-w-[160px]">Customer</th>
                          {weekCols.map(wk => (
                            <th key={wk} className="px-3 py-2 text-right font-medium text-muted-foreground text-xs whitespace-nowrap">{wk}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row: any, i: number) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                            <td className="px-4 py-2 font-medium sticky left-0 bg-background text-xs">{row["Customer"] ?? ""}</td>
                            {weekCols.map((wk, wi) => {
                              const val = row[wk];
                              const num = Number(val);
                              const prev = wi > 0 ? Number(row[weekCols[wi - 1]]) : null;
                              const trend = prev !== null && !isNaN(num) && !isNaN(prev)
                                ? num > prev ? "up" : num < prev ? "down" : "same"
                                : "none";
                              return (
                                <td key={wk} className="px-3 py-2 text-right">
                                  <span className={`inline-flex items-center justify-end gap-0.5 text-xs font-medium ${
                                    trend === "up" ? "text-green-600 dark:text-green-400" :
                                    trend === "down" ? "text-red-500 dark:text-red-400" :
                                    "text-muted-foreground"
                                  }`}>
                                    {trend === "up" && <ArrowUp className="h-3 w-3" />}
                                    {trend === "down" && <ArrowDown className="h-3 w-3" />}
                                    {trend === "same" && <Minus className="h-3 w-3" />}
                                    {val !== "" && val !== null && val !== undefined ? val : "—"}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </TabsContent>

        {/* ── AVERAGES TAB ────────────────────────────────────────────── */}
        <TabsContent value="averages" className="mt-4">
          {!sheetsData?.averagesData?.length ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <Target className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Upload your NUMBERS.xlsx file to see rep averages</p>
            </CardContent></Card>
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Target className="h-4 w-4 text-green-500" />
                  Rep Averages vs. Today
                </CardTitle>
                <p className="text-xs text-muted-foreground">Yearly daily averages compared to today's acquisition + days hitting or beating their average this month</p>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        {Object.keys(sheetsData.averagesData[0] ?? {}).map(col => (
                          <th key={col} className="px-4 py-2 text-left font-medium text-muted-foreground text-xs whitespace-nowrap">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheetsData.averagesData.map((row: any, i: number) => {
                        const status = String(row["Status"] ?? "").toLowerCase();
                        return (
                          <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                            {Object.entries(row).map(([col, val]: [string, any]) => (
                              <td key={col} className="px-4 py-2.5 text-xs">
                                {col === "Status" ? (
                                  <Badge className={
                                    status.includes("exceed") || status.includes("hit") || status === "on track" ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" :
                                    status.includes("behind") ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" :
                                    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                                  }>{val}</Badge>
                                ) : col === "Rank" ? (
                                  <span className="font-bold">{val}</span>
                                ) : col === "Sales Rep" ? (
                                  <span className="font-medium">{val}</span>
                                ) : (
                                  <span>{val !== "" && val !== null && val !== undefined ? val : "—"}</span>
                                )}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── TODAY TAB ───────────────────────────────────────────────── */}
        <TabsContent value="today" className="mt-4 space-y-4">
          {!sheetsData?.dailyAcquisition?.length ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <CalendarDays className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Upload your NUMBERS.xlsx file to see today's loads</p>
            </CardContent></Card>
          ) : (() => {
            // Strip void/voided loads before anything else
            const allRows = sheetsData.dailyAcquisition.filter((r: any) => {
              const status = String(r["Status"] ?? r["status"] ?? "").trim().toUpperCase();
              return status !== "VOID" && status !== "VOIDED" && status !== "CANCELLED" && status !== "";
            });
            const repOptions = [...new Set(allRows.map((r: any) => String(r["Operations User"] ?? r["Operations user"] ?? "").trim()).filter(Boolean))].sort();
            const typeOptions = [...new Set(allRows.map((r: any) => String(r["Order Type"] ?? r["Order type"] ?? "").trim()).filter(Boolean))].sort();
            const filtered = allRows.filter((r: any) => {
              const rep = String(r["Operations User"] ?? r["Operations user"] ?? "").trim();
              const type = String(r["Order Type"] ?? r["Order type"] ?? "").trim();
              return (todayRepFilter === "all" || rep === todayRepFilter) &&
                     (todayTypeFilter === "all" || type === todayTypeFilter);
            });
            const showCols = ["Order Number", "Order number", "Customer", "Operations User", "Operations user", "Order Type", "Order type", "Shipper City", "Shipper city", "Shipper State", "Shipper state", "Consignee city", "Consignee City", "Consignee state", "Consignee State", "Status", "Freight charge", "Freight Charge", "Total Charges", "Total charges"];
            const availCols = Object.keys(allRows[0] ?? {}).filter(k => showCols.some(s => s.toLowerCase() === k.toLowerCase()));
            return (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <CalendarDays className="h-4 w-4 text-indigo-500" />
                        Today's Load Activity
                      </CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">{filtered.length} of {allRows.length} active loads (voids excluded)</p>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <Select value={todayRepFilter} onValueChange={setTodayRepFilter}>
                        <SelectTrigger className="h-8 text-xs w-36" data-testid="select-today-rep">
                          <SelectValue placeholder="All Reps" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Reps</SelectItem>
                          {repOptions.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select value={todayTypeFilter} onValueChange={setTodayTypeFilter}>
                        <SelectTrigger className="h-8 text-xs w-36" data-testid="select-today-type">
                          <SelectValue placeholder="All Types" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Types</SelectItem>
                          {typeOptions.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/30">
                          {availCols.map(col => (
                            <th key={col} className="px-3 py-2 text-left font-medium text-muted-foreground text-xs whitespace-nowrap">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((row: any, i: number) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                            {availCols.map(col => (
                              <td key={col} className="px-3 py-2.5 text-xs">
                                {col === "Status" ? (
                                  <Badge variant="outline" className="text-xs">{row[col]}</Badge>
                                ) : (String(row[col] ?? "") || "—")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })()}
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
