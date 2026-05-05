/**
 * Task #1030 (LWQ E) — Admin / Director Lane Engine console.
 *
 * Hosts every operational/health surface that used to clutter the
 * Lane Work Queue rep page:
 *
 *   - Run Engine button + last-run metadata
 *   - Source FreshnessPill (won-load autopilot, importer, manual)
 *   - Cache vs live "Warming up" banner for the LWQ summary cache
 *   - Leak Console deep-link
 *   - Recurring lane / carrier-rolodex Excel upload
 *   - Carrier sourcing performance by channel
 *   - Per-lane Edit / Delete management table
 *
 * Sales reps are explicitly forbidden (403). The LWQ rep page links here
 * via the `status-engine-health` dot.
 */
import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Play, RefreshCw, Database, Upload, ShieldAlert,
  CheckCircle2, AlertTriangle, PowerOff, Trash2, Pencil,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { FreshnessPill, type FreshnessSignal } from "@/components/freight/freshness-pill";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

const ALLOWED_ROLES = ["admin", "director", "national_account_manager", "sales_director"];

interface EngineRunMeta {
  source: "financial_uploads";
  uploadIds: string[];
  latestUploadDate: string;
  rowsScanned: number;
  lanesGenerated: number;
  ranAt?: string;
}

interface SourcingPerfRow {
  sourceChannel: string;
  label: string;
  carriersImported: number;
  outreached: number;
  responded: number;
  responseRate: number;
}

interface EngineHealth {
  state: "healthy" | "degraded" | "down";
  lastRunAt: string | null;
  ageHours: number | null;
  freshnessState: "green" | "yellow" | "red";
  message: string;
  reasons: string[];
}

interface EngineKpis {
  detectedThisWeek: number;
  retractedThisWeek: number;
  totalEligible: number;
  eligibilityDistribution: Record<string, number>;
  windowDays: number;
}

interface ManagedLane {
  laneId: string;
  origin: string;
  originState: string | null;
  destination: string;
  destinationState: string | null;
  equipmentType: string | null;
  avgLoadsPerWeek: string | null;
  companyName: string | null;
  ownerName: string | null;
  isManual?: boolean;
}

interface WorkQueueResp {
  unassigned: ManagedLane[];
  noContactable: ManagedLane[];
  assignedUntouched: ManagedLane[];
  inProgress: ManagedLane[];
  meta?: { source: "cache" | "full" };
}

function StatusBadge({ state }: { state: EngineHealth["state"] }) {
  const tone =
    state === "healthy" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
    : state === "degraded" ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
    : "border-red-500/40 bg-red-500/10 text-red-400";
  const Icon = state === "healthy" ? CheckCircle2 : state === "degraded" ? AlertTriangle : PowerOff;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium ${tone}`}
      data-testid={`badge-engine-state-${state}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {state}
    </span>
  );
}

export default function AdminLaneEnginePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const allowed = !!user && ALLOWED_ROLES.includes(user.role ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editTarget, setEditTarget] = useState<ManagedLane | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedLane | null>(null);
  const [editForm, setEditForm] = useState({
    origin: "", originState: "", destination: "", destinationState: "",
    equipmentType: "", avgLoadsPerWeek: "", companyName: "",
  });

  const { data: health } = useQuery<EngineHealth>({
    queryKey: ["/api/lane-engine/health"],
    enabled: allowed,
    refetchInterval: 60_000,
  });
  const { data: kpis } = useQuery<EngineKpis>({
    queryKey: ["/api/lane-engine/kpis"],
    enabled: allowed,
    staleTime: 60_000,
  });
  const { data: engineStatus } = useQuery<{ meta: EngineRunMeta | null }>({
    queryKey: ["/api/recurring-lanes/engine-status"],
    enabled: allowed,
    staleTime: 60_000,
  });
  const { data: freshness } = useQuery<FreshnessSignal>({
    queryKey: ["/api/freight-freshness"],
    enabled: allowed,
    refetchInterval: 60_000,
  });
  const { data: sourcingPerf = [] } = useQuery<SourcingPerfRow[]>({
    queryKey: ["/api/carriers/sourcing-performance"],
    enabled: allowed,
    staleTime: 60_000,
  });
  const { data: queue, refetch: refetchQueue } = useQuery<WorkQueueResp>({
    queryKey: ["/api/recurring-lanes/work-queue"],
    enabled: allowed,
  });

  const runEngineMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/recurring-lanes/run-engine", {}).then(r => r.json()),
    onSuccess: (data: { upserted?: number; total?: number; message?: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/engine-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lane-engine/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lane-engine/kpis"] });
      toast({
        title: `Engine complete — ${data.upserted ?? data.total ?? 0} lanes scored`,
        description: data.message ?? "Work queue refreshed.",
      });
    },
    onError: () => toast({ title: "Engine run failed", variant: "destructive" }),
  });

  // Task #1030 — explicit cache recompute trigger separate from the
  // heavier Run Engine. Rebuilds lane_summary_cache so the LWQ flips off
  // its "Warming up" banner without re-running detection.
  const recomputeCacheMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/lane-engine/recompute-cache", {}).then(r => r.json()),
    onSuccess: (data: { durationMs?: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/lane-engine/kpis"] });
      toast({
        title: "Cache rebuilt",
        description: `lane_summary_cache rebuilt in ${Math.round((data.durationMs ?? 0))} ms`,
      });
    },
    onError: () => toast({ title: "Cache recompute failed", variant: "destructive" }),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch("/api/admin/carriers/seed-from-excel", {
        method: "POST", body: fd, credentials: "include",
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error ?? "Upload failed");
      return resp.json();
    },
    onSuccess: (data: { mode?: string; created?: number; alreadyExisted?: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({
        title: `Upload complete (${data.mode ?? "—"})`,
        description: `${data.created ?? 0} created · ${data.alreadyExisted ?? 0} already on file`,
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err: unknown) => toast({
      title: (err as { message?: string }).message ?? "Upload failed",
      variant: "destructive",
    }),
  });

  const deleteMutation = useMutation({
    mutationFn: (laneId: string) => apiRequest("DELETE", `/api/recurring-lanes/${laneId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete lane", variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: (vars: { laneId: string; data: typeof editForm }) =>
      apiRequest("PATCH", `/api/recurring-lanes/${vars.laneId}`, {
        origin: vars.data.origin.trim() || undefined,
        originState: vars.data.originState.trim() || null,
        destination: vars.data.destination.trim() || undefined,
        destinationState: vars.data.destinationState.trim() || null,
        equipmentType: vars.data.equipmentType.trim() || null,
        avgLoadsPerWeek: vars.data.avgLoadsPerWeek !== "" ? vars.data.avgLoadsPerWeek : null,
        companyName: vars.data.companyName.trim() || null,
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/work-queue"] });
      toast({ title: "Lane updated" });
      setEditTarget(null);
    },
    onError: () => toast({ title: "Failed to update lane", variant: "destructive" }),
  });

  // Lane edit/delete backend permissions are manager/owner-scoped
  // (admin/director/national_account_manager/logistics_manager OR the
  // owning rep). sales_director is allowed onto this console for the
  // read-only KPIs/health/sourcing surfaces but cannot mutate lanes —
  // hide the row actions for them so the controls never 403 silently.
  const canMutateLanes = !!user && ["admin", "director", "national_account_manager"].includes(user.role ?? "");

  const allLanes = useMemo<ManagedLane[]>(() => {
    if (!queue) return [];
    return [
      ...(queue.unassigned ?? []),
      ...(queue.noContactable ?? []),
      ...(queue.assignedUntouched ?? []),
      ...(queue.inProgress ?? []),
    ].sort((a, b) =>
      `${a.companyName ?? ""}|${a.origin}`.localeCompare(`${b.companyName ?? ""}|${b.origin}`),
    );
  }, [queue]);

  if (!user) return <div className="p-8" data-testid="admin-lane-engine-loading">Loading…</div>;
  if (!allowed) {
    return (
      <div className="p-8 max-w-xl mx-auto" data-testid="admin-lane-engine-forbidden">
        <Card>
          <CardHeader>
            <CardTitle>Admin only</CardTitle>
            <CardDescription>
              The Lane Engine console is restricted to admins, directors, sales directors, and
              national account managers. Sales reps work the Lane Work Queue itself.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-5" data-testid="page-admin-lane-engine">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Database className="h-6 w-6 text-amber-500" /> Lane Engine
          </h1>
          <p className="text-sm text-muted-foreground">
            Operational console for the recurring-lane capacity engine and its source feeds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {health && <StatusBadge state={health.state} />}
          <Link href="/lanes/work-queue">
            <Button variant="outline" size="sm" data-testid="link-back-lwq">Back to Work Queue</Button>
          </Link>
          <Link href="/leak-console">
            <Button variant="outline" size="sm" className="gap-1.5" data-testid="link-leak-console">
              <ShieldAlert className="w-3.5 h-3.5" /> Leak Console
            </Button>
          </Link>
        </div>
      </div>

      <Card data-testid="card-engine-control">
        <CardHeader>
          <CardTitle className="text-base">Run Engine</CardTitle>
          <CardDescription>
            Manually trigger the recurring-lane capacity engine + scoring pass. Normally runs on
            cron; use this after a fresh financial upload or when reps report missing lanes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => runEngineMutation.mutate()}
              disabled={runEngineMutation.isPending}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
              data-testid="btn-run-engine"
            >
              {runEngineMutation.isPending
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Play className="w-4 h-4" />}
              Run Engine
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes/engine-status"] });
                queryClient.invalidateQueries({ queryKey: ["/api/lane-engine/health"] });
                queryClient.invalidateQueries({ queryKey: ["/api/freight-freshness"] });
              }}
              data-testid="btn-refresh-engine-meta"
              className="gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </div>
          {engineStatus?.meta ? (
            <div
              className="rounded-md border border-border bg-muted/30 px-3 py-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground"
              data-testid="engine-debug-panel"
            >
              <span>Source: <span className="text-foreground">{engineStatus.meta.source}</span></span>
              <span>Uploads used: <span className="text-foreground">{engineStatus.meta.uploadIds.length}</span></span>
              <span>Rows scanned: <span className="text-foreground">{engineStatus.meta.rowsScanned.toLocaleString()}</span></span>
              <span>Lanes generated: <span className="text-foreground">{engineStatus.meta.lanesGenerated}</span></span>
              {engineStatus.meta.latestUploadDate && (
                <span>Upload date: <span className="text-foreground">
                  {new Date(engineStatus.meta.latestUploadDate).toLocaleDateString()}
                </span></span>
              )}
              {engineStatus.meta.ranAt && (
                <span>Last run: <span className="text-foreground">
                  {new Date(engineStatus.meta.ranAt).toLocaleString()}
                </span></span>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              No engine run recorded yet for this org.
            </p>
          )}
          {health && (
            <div className="text-[11px] text-muted-foreground" data-testid="text-engine-health-summary">
              {health.message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-engine-kpis">
        <CardHeader>
          <CardTitle className="text-base">Engine Health KPIs</CardTitle>
          <CardDescription>
            Detection vs retraction over the last {kpis?.windowDays ?? 7} days, plus the
            confidence distribution of currently eligible lanes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2" data-testid="kpi-detected-this-week">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Detected this week</div>
              <div className="text-2xl font-semibold text-emerald-400 tabular-nums">
                {kpis?.detectedThisWeek ?? "—"}
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2" data-testid="kpi-retracted-this-week">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Retracted this week</div>
              <div className="text-2xl font-semibold text-amber-400 tabular-nums">
                {kpis?.retractedThisWeek ?? "—"}
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2" data-testid="kpi-total-eligible">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total eligible</div>
              <div className="text-2xl font-semibold text-foreground tabular-nums">
                {kpis?.totalEligible ?? "—"}
              </div>
            </div>
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2" data-testid="kpi-eligibility-distribution">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Eligibility</div>
              <div className="text-xs text-foreground space-y-0.5 mt-1">
                {Object.entries(kpis?.eligibilityDistribution ?? {}).length === 0
                  ? <span className="text-muted-foreground italic">No data</span>
                  : Object.entries(kpis?.eligibilityDistribution ?? {}).map(([bucket, n]) => (
                    <div key={bucket} className="flex justify-between gap-2" data-testid={`kpi-bucket-${bucket}`}>
                      <span className="capitalize text-muted-foreground">{bucket}</span>
                      <span className="font-semibold tabular-nums">{n}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-source-freshness">
        <CardHeader>
          <CardTitle className="text-base">Source Freshness</CardTitle>
          <CardDescription>
            Per-producer ingestion health. Reps used to see this on the LWQ header — it lives here
            now so the work queue stays focused on lane work.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3 flex-wrap">
          <FreshnessPill
            signal={freshness}
            testId="pill-lwq-freshness"
            popoverTestId="popover-lwq-freshness"
          />
          {/* Cache vs live indicator. `cache` = served from
              lane_summary_cache (fast path), `full` = live aggregate
              fallback (slow path; cache is cold). */}
          {queue?.meta?.source === "cache" && (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 border border-emerald-500/40 rounded-full px-2 py-0.5 bg-emerald-500/10"
              data-testid="indicator-cache-live"
              title="Work queue is being served from lane_summary_cache (fast path)."
            >
              <CheckCircle2 className="w-3 h-3" />
              Cache: live
            </span>
          )}
          {queue?.meta?.source === "full" && (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-amber-400 border border-amber-500/40 rounded-full px-2 py-0.5 bg-amber-500/10"
              data-testid="banner-cache-warming"
              title="Lane cache is still warming after restart. The next refresh will be much faster."
            >
              <Loader2 className="w-3 h-3 animate-spin" />
              Warming up — next load will be faster
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => recomputeCacheMutation.mutate()}
            disabled={recomputeCacheMutation.isPending}
            data-testid="btn-recompute-cache"
            title="Rebuild lane_summary_cache without re-running detection"
          >
            {recomputeCacheMutation.isPending
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            Recompute Cache
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="card-recurring-lane-upload">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="w-4 h-4" /> Recurring Lane / Carrier Upload
          </CardTitle>
          <CardDescription>
            Drop a TMS financial export, carrier rolodex, or legacy directory. The server detects
            the format and seeds carriers; the lane engine picks them up on its next run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            type="file"
            accept=".xlsx,.xls"
            ref={fileInputRef}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) uploadMutation.mutate(f);
            }}
            disabled={uploadMutation.isPending}
            data-testid="input-lane-upload-file"
          />
          {uploadMutation.isPending && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
            </p>
          )}
        </CardContent>
      </Card>

      <Card data-testid="sourcing-performance-panel">
        <CardHeader>
          <CardTitle className="text-base">Carrier Sourcing Performance</CardTitle>
          <CardDescription>Response rates by import channel.</CardDescription>
        </CardHeader>
        <CardContent>
          {sourcingPerf.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No sourcing data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Source</th>
                    <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Imported</th>
                    <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Outreached</th>
                    <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Responded</th>
                    <th className="text-right px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Response %</th>
                  </tr>
                </thead>
                <tbody>
                  {sourcingPerf.map(ch => (
                    <tr key={ch.sourceChannel} className="border-b border-border/50 last:border-0 hover:bg-muted/20" data-testid={`row-sourcing-${ch.sourceChannel}`}>
                      <td className="px-3 py-2 font-medium text-foreground">{ch.label}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{ch.carriersImported}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{ch.outreached}</td>
                      <td className="px-3 py-2 text-right text-emerald-500">{ch.responded}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={`font-semibold ${ch.responseRate >= 40 ? "text-emerald-400" : ch.responseRate >= 20 ? "text-amber-400" : "text-muted-foreground"}`}>
                          {ch.responseRate}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-lane-management">
        <CardHeader>
          <CardTitle className="text-base">Lane Management</CardTitle>
          <CardDescription>
            Edit or delete recurring lanes. Moved off the LWQ rep cards so reps can't fat-finger
            structural lane changes mid-outreach.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground" data-testid="text-lane-count">
              {allLanes.length} lane{allLanes.length === 1 ? "" : "s"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetchQueue()}
              data-testid="btn-refresh-lanes"
              className="gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </Button>
          </div>
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Customer</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Lane</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Equipment</th>
                  <th className="text-right px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Loads/wk</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Owner</th>
                  <th className="text-right px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {allLanes.map(l => (
                  <tr key={l.laneId} className="border-b border-border/50 last:border-0 hover:bg-muted/20" data-testid={`row-managed-lane-${l.laneId}`}>
                    <td className="px-3 py-2 text-foreground">
                      {l.companyName ?? <span className="text-muted-foreground italic">—</span>}
                      {l.isManual && <Badge variant="outline" className="ml-1 text-[9px] py-0 px-1">Manual</Badge>}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {l.origin}{l.originState ? `, ${l.originState}` : ""} → {l.destination}{l.destinationState ? `, ${l.destinationState}` : ""}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.equipmentType ?? "Any"}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{l.avgLoadsPerWeek ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.ownerName ?? <span className="italic">Unassigned</span>}</td>
                    <td className="px-3 py-2 text-right">
                      {canMutateLanes ? (
                        <>
                          <button
                            className="p-1 rounded hover:bg-amber-500/10 text-muted-foreground hover:text-amber-400"
                            onClick={() => {
                              setEditTarget(l);
                              setEditForm({
                                origin: l.origin ?? "",
                                originState: l.originState ?? "",
                                destination: l.destination ?? "",
                                destinationState: l.destinationState ?? "",
                                equipmentType: l.equipmentType ?? "",
                                avgLoadsPerWeek: l.avgLoadsPerWeek ?? "",
                                companyName: l.companyName ?? "",
                              });
                            }}
                            data-testid={`btn-edit-lane-${l.laneId}`}
                            title="Edit lane"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 ml-1"
                            onClick={() => setDeleteTarget(l)}
                            data-testid={`btn-delete-lane-${l.laneId}`}
                            title="Delete lane"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic" data-testid={`text-readonly-lane-${l.laneId}`}>read-only</span>
                      )}
                    </td>
                  </tr>
                ))}
                {allLanes.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground italic">No lanes yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lane?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && <>This permanently removes <strong>{deleteTarget.origin} → {deleteTarget.destination}</strong> along with carrier interest records.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-delete-lane-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.laneId)}
              disabled={deleteMutation.isPending}
              data-testid="btn-delete-lane-confirm"
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete lane"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit lane</DialogTitle>
            <DialogDescription>Update the details for this recurring lane.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-origin">Origin city</Label>
                <Input id="edit-origin" value={editForm.origin}
                  onChange={e => setEditForm(f => ({ ...f, origin: e.target.value }))}
                  data-testid="input-edit-origin" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-origin-state">Origin state</Label>
                <Input id="edit-origin-state" value={editForm.originState} maxLength={2}
                  onChange={e => setEditForm(f => ({ ...f, originState: e.target.value }))}
                  data-testid="input-edit-origin-state" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-destination">Destination city</Label>
                <Input id="edit-destination" value={editForm.destination}
                  onChange={e => setEditForm(f => ({ ...f, destination: e.target.value }))}
                  data-testid="input-edit-destination" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-destination-state">Destination state</Label>
                <Input id="edit-destination-state" value={editForm.destinationState} maxLength={2}
                  onChange={e => setEditForm(f => ({ ...f, destinationState: e.target.value }))}
                  data-testid="input-edit-destination-state" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-equipment">Equipment</Label>
                <Input id="edit-equipment" value={editForm.equipmentType}
                  onChange={e => setEditForm(f => ({ ...f, equipmentType: e.target.value }))}
                  data-testid="input-edit-equipment" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-loads">Loads/week</Label>
                <Input id="edit-loads" type="number" min="0" step="0.1" value={editForm.avgLoadsPerWeek}
                  onChange={e => setEditForm(f => ({ ...f, avgLoadsPerWeek: e.target.value }))}
                  data-testid="input-edit-loads" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-company">Customer</Label>
              <Input id="edit-company" value={editForm.companyName}
                onChange={e => setEditForm(f => ({ ...f, companyName: e.target.value }))}
                data-testid="input-edit-company" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)} data-testid="btn-edit-cancel">Cancel</Button>
            <Button
              onClick={() => editTarget && editMutation.mutate({ laneId: editTarget.laneId, data: editForm })}
              disabled={editMutation.isPending || !editForm.origin.trim() || !editForm.destination.trim()}
              data-testid="btn-edit-save"
            >
              {editMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
