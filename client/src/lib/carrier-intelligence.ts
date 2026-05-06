/**
 * Shared helpers for the Carrier Intelligence DNA surfaces.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "./queryClient";

export interface CarrierIntelThresholds {
  marginGreenPct: number;
  marginYellowPct: number;
  onTimeGreenPct: number;
  onTimeYellowPct: number;
  urgencyRedHours: number;
  urgencyYellowHours: number;
}

export interface CarrierIntelPrefs {
  scorecard: {
    moveStatus: string[];
    minLoads: number;
    tier: string;
    equipment: string;
    sort: string;
    savedViews: Array<{ id: string; name: string; payload: Record<string, unknown> }>;
  };
  availableLoads: {
    equipment: string;
    accountManager: string;
    urgency: string;
    sort: string;
    savedViews: Array<{ id: string; name: string; payload: Record<string, unknown> }>;
  };
  lanePricing: {
    recent: Array<{ origin: string; destination: string; equipmentType?: string; customer?: string; ts: number }>;
    savedViews: Array<{ id: string; name: string; payload: Record<string, unknown> }>;
  };
  thresholds: CarrierIntelThresholds;
}

export function useCarrierIntelPrefs() {
  return useQuery<{ defaults: CarrierIntelPrefs; user: CarrierIntelPrefs }>({
    queryKey: ["/api/carrier-intelligence/prefs"],
    staleTime: 60_000,
  });
}

export function useSaveCarrierIntelPrefs() {
  return useMutation({
    mutationFn: async (patch: Partial<CarrierIntelPrefs>) => {
      const res = await apiRequest("PUT", "/api/carrier-intelligence/prefs", patch);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/carrier-intelligence/prefs"] });
    },
  });
}

export function colorForMarginPct(pct: number | null | undefined, t: CarrierIntelThresholds): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= t.marginGreenPct) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= t.marginYellowPct) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function colorForOnTimePct(pct: number | null | undefined, t: CarrierIntelThresholds): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= t.onTimeGreenPct) return "text-emerald-600 dark:text-emerald-400";
  if (pct >= t.onTimeYellowPct) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function colorForConfidence(c: string | null | undefined): string {
  switch (c) {
    case "high": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40";
    case "medium": return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40";
    case "low": return "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

export function colorForUrgency(u: string | null | undefined): string {
  switch (u) {
    case "red": return "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40";
    case "yellow": return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40";
    default: return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40";
  }
}

export function fmtCurrency(n: number | null | undefined, frac = 0): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: frac });
}
export function fmtPct(n: number | null | undefined, frac = 1): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${Number(n).toFixed(frac)}%`;
}
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString();
}
export function fmtRpm(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${Number(n).toFixed(2)}/mi`;
}
export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString(); } catch { return s; }
}

/** Browser CSV export (no library). */
export function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    const blob = new Blob(["(no rows)"], { type: "text/csv;charset=utf-8" });
    return triggerDownload(filename, blob);
  }
  const cols = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map(r => cols.map(c => escape(r[c])).join(","))].join("\n");
  triggerDownload(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
