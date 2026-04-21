import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Loader2, RefreshCw, Database, AlertCircle, CheckCircle2, XCircle, GitMerge, Truck, Clock, BarChart3 } from "lucide-react";

interface BucketCounts { available: number; realized: number; cancelled: number; unknown: number }
interface LoadFactSettings {
  url: string | null;
  schedule: string | null;
  lastImport: {
    at?: string; fileName?: string; fileHash?: string | null; replayToken?: string | null;
    totalRows?: number; inserted?: number; updated?: number; unchanged?: number;
    transitioned?: number; expired?: number; skipped?: number; replayed?: boolean;
    buckets?: BucketCounts;
  } | null;
  cutoverActive: boolean;
  counts: { total: number; available: number; realized: number; cancelled: number; unknown: number };
}

interface ImportAuditRow {
  id: string; fileName: string | null;
  fileHash?: string | null; replayToken?: string | null;
  totalRows: number; inserted: number; updated: number; unchanged: number;
  transitioned?: number; expired?: number; skipped?: number;
  buckets: BucketCounts;
  warnings: string[]; triggeredBy: string; kind: string;
  error: string | null; durationMs: number | null; createdAt: string;
}

interface ScheduleConfig {
  morningEnabled: boolean;
  afternoonEnabled: boolean;
  cadence: "weekdays" | "daily" | "off";
  pauseUntil: string | null;
}

interface MetricRow { realizedLoads: number; availableLoads: number; realizedRevenue: number; realizedCost: number; realizedMargin: number }
interface ParityBreakdownRow {
  key: string; legacy: MetricRow; loadFact: MetricRow;
  drift: { realizedLoadsDelta: number; availableLoadsDelta: number; revenueDelta: number; marginDelta: number; maxAbsPct: number };
  withinTolerance: boolean;
}
interface ParityReport {
  generatedAt: string;
  global: {
    legacy: MetricRow & { rowsScanned: number; distinctOrderIds: number };
    loadFact: MetricRow & { totalRows: number };
    drift: {
      realizedLoadsDelta: number; realizedLoadsDeltaPct: number;
      availableLoadsDelta: number; availableLoadsDeltaPct: number;
      revenueDelta: number; revenueDeltaPct: number;
      marginDelta: number; marginDeltaPct: number;
      maxAbsPct: number;
    };
    withinTolerance: boolean;
  };
  byCarrier: ParityBreakdownRow[];
  byMonth: ParityBreakdownRow[];
  byAccountManager: ParityBreakdownRow[];
  withinTolerance: boolean;
  tolerancePct: number;
  notes: string[];
}

interface CombinedMetrics {
  executedLoads: number;
  realizedRevenue: number;
  realizedCost: number;
  realizedMargin: number;
  realizedMarginPct: number;
  activeLoads: number;
  activeRevenue: number;
  activeCost: number;
  pipelineMarginPlaceholder: number;
  availableLoads: number;
  pipelineRevenue: number;
  totalLoads: number;
}

function fmtNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}
function fmtCurrency(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function AdminCarrierIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleConfig | null>(null);
  const [parityReport, setParityReport] = useState<ParityReport | null>(null);
  const [forceCutoverConfirm, setForceCutoverConfirm] = useState<{ enable: boolean; report: ParityReport } | null>(null);

  const settingsQuery = useQuery<LoadFactSettings>({
    queryKey: ["/api/admin/load-fact/settings"],
    enabled: !!user && user.role === "admin",
  });
  const importsQuery = useQuery<{ imports: ImportAuditRow[] }>({
    queryKey: ["/api/admin/load-fact/imports"],
    enabled: !!user && user.role === "admin",
  });
  const scheduleQuery = useQuery<ScheduleConfig>({
    queryKey: ["/api/admin/load-fact/schedule"],
    enabled: !!user && user.role === "admin",
  });
  const metricsQuery = useQuery<CombinedMetrics>({
    queryKey: ["/api/admin/load-fact/metrics"],
    enabled: !!user && user.role === "admin",
  });

  const saveSettingsMutation = useMutation({
    mutationFn: async (payload: { url?: string | null }) => {
      const res = await apiRequest("PUT", "/api/admin/load-fact/settings", payload);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Settings saved" });
      setUrlDraft(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/settings"] });
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
  });

  const saveScheduleMutation = useMutation({
    mutationFn: async (payload: ScheduleConfig) => {
      const res = await apiRequest("PUT", "/api/admin/load-fact/schedule", payload);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Schedule saved" });
      setScheduleDraft(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/schedule"] });
    },
    onError: (err: Error) => toast({ title: "Failed to save schedule", description: err.message, variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/load-fact/import", {});
      return res.json();
    },
    onSuccess: (data: { summary: { totalRows: number; inserted: number; updated: number; transitioned?: number; expired?: number; replayed?: boolean } }) => {
      const s = data.summary;
      toast({
        title: s.replayed ? "Import replayed (no writes)" : "Import complete",
        description: `${s.totalRows} rows • ${s.inserted} new • ${s.updated} updated • ${s.transitioned ?? 0} transitioned • ${s.expired ?? 0} expired`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/imports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/metrics"] });
    },
    onError: (err: Error) => toast({ title: "Import failed", description: err.message, variant: "destructive" }),
  });

  const backfillMutation = useMutation({
    mutationFn: async (source: "all" | "financial_uploads" | "freight_opportunities") => {
      const res = await apiRequest("POST", "/api/admin/load-fact/backfill", { source });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Backfill complete" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/imports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/metrics"] });
    },
    onError: (err: Error) => toast({ title: "Backfill failed", description: err.message, variant: "destructive" }),
  });

  const parityMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/admin/load-fact/parity");
      return res.json() as Promise<ParityReport>;
    },
    onSuccess: (report) => {
      setParityReport(report);
      toast({
        title: report.withinTolerance ? "Parity within tolerance" : "Parity drift detected",
        description: `Max drift: ${report.global.drift.maxAbsPct}%`,
        variant: report.withinTolerance ? "default" : "destructive",
      });
    },
    onError: (err: Error) => toast({ title: "Parity check failed", description: err.message, variant: "destructive" }),
  });

  const cutoverMutation = useMutation({
    mutationFn: async (payload: { enabled: boolean; force?: boolean }) => {
      const res = await apiRequest("POST", "/api/admin/load-fact/cutover", payload);
      if (res.status === 409) {
        const body = await res.json();
        throw Object.assign(new Error(body.error || "Cutover blocked"), { parityBlock: body });
      }
      return res.json();
    },
    onSuccess: (data: { cutoverActive: boolean }) => {
      toast({
        title: data.cutoverActive ? "load_fact is now ACTIVE" : "load_fact disabled — falling back to legacy reads",
      });
      setForceCutoverConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/load-fact/settings"] });
    },
    onError: (err: Error & { parityBlock?: { report: ParityReport } }) => {
      if (err.parityBlock?.report) {
        setForceCutoverConfirm({ enable: true, report: err.parityBlock.report });
        return;
      }
      toast({ title: "Cutover failed", description: err.message, variant: "destructive" });
    },
  });

  if (user && user.role !== "admin") {
    return (
      <div className="p-8 max-w-2xl mx-auto" data-testid="text-not-admin">
        <Card><CardContent className="pt-6">Admin access required.</CardContent></Card>
      </div>
    );
  }

  const settings = settingsQuery.data;
  const url = urlDraft ?? settings?.url ?? "";
  const counts = settings?.counts;
  const schedule = scheduleDraft ?? scheduleQuery.data ?? null;
  const metrics = metricsQuery.data;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6" data-testid="page-carrier-intelligence">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-page-title">
          <Truck className="h-6 w-6" /> Carrier Intelligence — load_fact
        </h1>
        <p className="text-muted-foreground mt-1">
          Single trusted freight load substrate fed by one unified PowerBI/OneDrive TMS extract.
          Move Status drives the canonical Available vs Realized split.
        </p>
      </div>

      {/* Counts */}
      <Card data-testid="card-counts">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database className="h-5 w-5" /> Substrate state</CardTitle>
          <CardDescription>Live counts from <code>load_fact</code> for your organization.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div className="text-center"><div className="text-2xl font-bold" data-testid="text-count-total">{fmtNumber(counts?.total)}</div><div className="text-xs text-muted-foreground">Total rows</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-blue-600" data-testid="text-count-available">{fmtNumber(counts?.available)}</div><div className="text-xs text-muted-foreground">Available</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-green-600" data-testid="text-count-realized">{fmtNumber(counts?.realized)}</div><div className="text-xs text-muted-foreground">Realized</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-amber-600" data-testid="text-count-cancelled">{fmtNumber(counts?.cancelled)}</div><div className="text-xs text-muted-foreground">Cancelled</div></div>
            <div className="text-center"><div className="text-2xl font-bold text-gray-500" data-testid="text-count-unknown">{fmtNumber(counts?.unknown)}</div><div className="text-xs text-muted-foreground">Unknown status</div></div>
          </div>
        </CardContent>
      </Card>

      {/* Available vs Active vs Realized metrics */}
      <Card data-testid="card-metrics">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" /> Available vs Active vs Realized</CardTitle>
          <CardDescription>Bucketed metrics from the carrier-intelligence service. Active = picked up but not yet delivered.</CardDescription>
        </CardHeader>
        <CardContent>
          {metricsQuery.isLoading ? (
            <div className="text-muted-foreground text-sm"><Loader2 className="h-4 w-4 inline mr-2 animate-spin" />Loading…</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div className="border rounded p-3" data-testid="metric-available">
                <div className="font-semibold text-blue-600">Available</div>
                <div>Loads: <span data-testid="text-metric-available-count">{fmtNumber(metrics?.availableLoads)}</span></div>
                <div>Pipeline revenue: {fmtCurrency(metrics?.pipelineRevenue)}</div>
                <div>Margin (placeholder): {fmtCurrency(metrics?.pipelineMarginPlaceholder)}</div>
              </div>
              <div className="border rounded p-3" data-testid="metric-active">
                <div className="font-semibold text-amber-600">Active (in transit)</div>
                <div>Loads: <span data-testid="text-metric-active-count">{fmtNumber(metrics?.activeLoads)}</span></div>
                <div>Revenue: {fmtCurrency(metrics?.activeRevenue)}</div>
                <div>Cost: {fmtCurrency(metrics?.activeCost)}</div>
              </div>
              <div className="border rounded p-3" data-testid="metric-realized">
                <div className="font-semibold text-green-600">Realized (delivered/billed)</div>
                <div>Loads: <span data-testid="text-metric-realized-count">{fmtNumber(metrics?.executedLoads)}</span></div>
                <div>Revenue: {fmtCurrency(metrics?.realizedRevenue)}</div>
                <div>Margin: {fmtCurrency(metrics?.realizedMargin)} ({(metrics?.realizedMarginPct ?? 0).toFixed(1)}%)</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PowerBI URL settings */}
      <Card data-testid="card-settings">
        <CardHeader>
          <CardTitle>PowerBI / OneDrive extract URL</CardTitle>
          <CardDescription>
            Share link to the unified TMS extract spreadsheet. Required Azure secrets:
            OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET. Scheduled imports run
            5:30 AM and 1:30 PM CT, Mon–Fri.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="input-powerbi-url">OneDrive / SharePoint share link or Graph drive item path</Label>
            <Input
              id="input-powerbi-url"
              data-testid="input-powerbi-url"
              value={url}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://1drv.ms/x/s!... or drives/{driveId}/items/{itemId}"
              className="font-mono text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button
              data-testid="button-save-settings"
              onClick={() => saveSettingsMutation.mutate({ url: url.trim() || null })}
              disabled={urlDraft === null || saveSettingsMutation.isPending}
            >
              {saveSettingsMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save URL
            </Button>
            <Button
              variant="outline"
              data-testid="button-trigger-import"
              onClick={() => importMutation.mutate()}
              disabled={importMutation.isPending || !settings?.url}
            >
              {importMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Run import now
            </Button>
          </div>
          {settings?.lastImport && (
            <div className="text-sm text-muted-foreground space-y-1" data-testid="text-last-import">
              <div>
                Last import: {fmtDateTime(settings.lastImport.at)} •{" "}
                {settings.lastImport.fileName ?? "—"} •{" "}
                {settings.lastImport.totalRows ?? 0} rows
                ({settings.lastImport.inserted ?? 0} new, {settings.lastImport.updated ?? 0} updated, {settings.lastImport.unchanged ?? 0} unchanged)
              </div>
              <div className="text-xs">
                Transitioned: {settings.lastImport.transitioned ?? 0} •
                {" "}Expired: {settings.lastImport.expired ?? 0} •
                {" "}Skipped: {settings.lastImport.skipped ?? 0}
                {settings.lastImport.replayed && <Badge variant="outline" className="ml-2">replayed</Badge>}
              </div>
              {settings.lastImport.fileHash && (
                <div className="text-xs font-mono">file hash: {settings.lastImport.fileHash.slice(0, 16)}…</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schedule */}
      <Card data-testid="card-schedule">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Clock className="h-5 w-5" /> Import schedule</CardTitle>
          <CardDescription>
            Two slots — 5:30 AM CT (before reps log in) and 1:30 PM CT (mid-afternoon). Toggle off to skip a slot.
            Manual imports always work regardless of these toggles.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {scheduleQuery.isLoading || !schedule ? (
            <div className="text-muted-foreground text-sm"><Loader2 className="h-4 w-4 inline mr-2 animate-spin" />Loading…</div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Switch
                  checked={schedule.morningEnabled}
                  onCheckedChange={(checked) => setScheduleDraft({ ...schedule, morningEnabled: checked })}
                  data-testid="switch-schedule-morning"
                />
                <Label>5:30 AM CT (morning)</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={schedule.afternoonEnabled}
                  onCheckedChange={(checked) => setScheduleDraft({ ...schedule, afternoonEnabled: checked })}
                  data-testid="switch-schedule-afternoon"
                />
                <Label>1:30 PM CT (afternoon)</Label>
              </div>
              <div>
                <Label>Cadence</Label>
                <div className="flex gap-2 mt-1">
                  {(["weekdays", "daily", "off"] as const).map((c) => (
                    <Button
                      key={c}
                      type="button"
                      size="sm"
                      variant={schedule.cadence === c ? "default" : "outline"}
                      data-testid={`button-schedule-cadence-${c}`}
                      onClick={() => setScheduleDraft({ ...schedule, cadence: c })}
                    >
                      {c}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <Label htmlFor="input-pause-until">Pause both slots until (ISO datetime, optional)</Label>
                <Input
                  id="input-pause-until"
                  data-testid="input-schedule-pause-until"
                  value={schedule.pauseUntil ?? ""}
                  onChange={(e) => setScheduleDraft({ ...schedule, pauseUntil: e.target.value || null })}
                  placeholder="2026-05-01T00:00:00.000Z"
                  className="font-mono text-sm"
                />
              </div>
              <Button
                data-testid="button-save-schedule"
                onClick={() => schedule && saveScheduleMutation.mutate(schedule)}
                disabled={scheduleDraft === null || saveScheduleMutation.isPending}
              >
                {saveScheduleMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save schedule
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Backfill */}
      <Card data-testid="card-backfill">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><GitMerge className="h-5 w-5" /> Backfill from legacy sources</CardTitle>
          <CardDescription>
            Idempotent merge of every existing financial_uploads row and freight_opportunities row into <code>load_fact</code>.
            Newest-wins precedence — older monthly snapshots cannot overwrite fresher data. Safe to re-run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button data-testid="button-backfill-all" onClick={() => backfillMutation.mutate("all")} disabled={backfillMutation.isPending}>
              {backfillMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Backfill all
            </Button>
            <Button variant="outline" data-testid="button-backfill-financial" onClick={() => backfillMutation.mutate("financial_uploads")} disabled={backfillMutation.isPending}>
              Financial uploads only
            </Button>
            <Button variant="outline" data-testid="button-backfill-opps" onClick={() => backfillMutation.mutate("freight_opportunities")} disabled={backfillMutation.isPending}>
              Freight opportunities only
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Parity */}
      <Card data-testid="card-parity">
        <CardHeader>
          <CardTitle>Parity harness</CardTitle>
          <CardDescription>
            Compares legacy aggregates (financial_uploads + freight_opportunities) against load_fact.
            Cutover is blocked when any breakdown row exceeds tolerance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button data-testid="button-run-parity" onClick={() => parityMutation.mutate()} disabled={parityMutation.isPending}>
            {parityMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Run parity check
          </Button>
          {parityReport && (
            <div className="border rounded p-4 space-y-3" data-testid="parity-report">
              <div className="flex items-center gap-2">
                {parityReport.withinTolerance
                  ? <Badge variant="default" className="bg-green-600" data-testid="badge-parity-ok"><CheckCircle2 className="h-3 w-3 mr-1" />Within tolerance</Badge>
                  : <Badge variant="destructive" data-testid="badge-parity-drift"><AlertCircle className="h-3 w-3 mr-1" />Drift exceeds {parityReport.tolerancePct}%</Badge>}
                <span className="text-sm text-muted-foreground">Max drift: {parityReport.global.drift.maxAbsPct}%</span>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="font-semibold mb-1">Realized loads</div>
                  <div data-testid="text-parity-legacy-realized">Legacy: {fmtNumber(parityReport.global.legacy.realizedLoads)}</div>
                  <div data-testid="text-parity-loadfact-realized">load_fact: {fmtNumber(parityReport.global.loadFact.realizedLoads)}</div>
                  <div className="text-muted-foreground">Δ {parityReport.global.drift.realizedLoadsDelta} ({parityReport.global.drift.realizedLoadsDeltaPct}%)</div>
                </div>
                <div>
                  <div className="font-semibold mb-1">Available loads</div>
                  <div>Legacy: {fmtNumber(parityReport.global.legacy.availableLoads)}</div>
                  <div>load_fact: {fmtNumber(parityReport.global.loadFact.availableLoads)}</div>
                  <div className="text-muted-foreground">Δ {parityReport.global.drift.availableLoadsDelta} ({parityReport.global.drift.availableLoadsDeltaPct}%)</div>
                </div>
                <div>
                  <div className="font-semibold mb-1">Realized revenue</div>
                  <div>Legacy: {fmtCurrency(parityReport.global.legacy.realizedRevenue)}</div>
                  <div>load_fact: {fmtCurrency(parityReport.global.loadFact.realizedRevenue)}</div>
                  <div className="text-muted-foreground">Δ {fmtCurrency(parityReport.global.drift.revenueDelta)} ({parityReport.global.drift.revenueDeltaPct}%)</div>
                </div>
              </div>

              <Tabs defaultValue="carrier" className="w-full">
                <TabsList>
                  <TabsTrigger value="carrier" data-testid="tab-parity-carrier">By carrier</TabsTrigger>
                  <TabsTrigger value="month" data-testid="tab-parity-month">By month</TabsTrigger>
                  <TabsTrigger value="am" data-testid="tab-parity-am">By account manager</TabsTrigger>
                </TabsList>
                <TabsContent value="carrier"><BreakdownTable rows={parityReport.byCarrier} testid="parity-by-carrier" /></TabsContent>
                <TabsContent value="month"><BreakdownTable rows={parityReport.byMonth} testid="parity-by-month" /></TabsContent>
                <TabsContent value="am"><BreakdownTable rows={parityReport.byAccountManager} testid="parity-by-am" /></TabsContent>
              </Tabs>

              {parityReport.notes.length > 0 && (
                <ul className="text-xs text-muted-foreground list-disc pl-5">
                  {parityReport.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cutover */}
      <Card data-testid="card-cutover">
        <CardHeader>
          <CardTitle>Cutover gate</CardTitle>
          <CardDescription>
            When ON, downstream consumers should treat <code>load_fact</code> as system-of-record for this org.
            When OFF, legacy reads remain authoritative. The toggle blocks if parity drift exceeds 5%.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              checked={!!settings?.cutoverActive}
              onCheckedChange={(checked) => cutoverMutation.mutate({ enabled: checked })}
              disabled={cutoverMutation.isPending}
              data-testid="switch-cutover"
            />
            <span data-testid="text-cutover-status">
              {settings?.cutoverActive
                ? <Badge variant="default" className="bg-green-600">load_fact ACTIVE</Badge>
                : <Badge variant="outline">Legacy reads (load_fact dormant)</Badge>}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Imports audit */}
      <Card data-testid="card-imports">
        <CardHeader>
          <CardTitle>Recent imports</CardTitle>
          <CardDescription>Audit trail of every import + backfill run.</CardDescription>
        </CardHeader>
        <CardContent>
          {importsQuery.isLoading ? (
            <div className="text-muted-foreground"><Loader2 className="h-4 w-4 inline mr-2 animate-spin" />Loading…</div>
          ) : (importsQuery.data?.imports.length ?? 0) === 0 ? (
            <div className="text-muted-foreground" data-testid="text-no-imports">No imports yet.</div>
          ) : (
            <div className="space-y-2">
              {importsQuery.data!.imports.map((row) => (
                <div key={row.id} className="border rounded p-3 text-sm flex items-start justify-between gap-4" data-testid={`row-import-${row.id}`}>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline">{row.kind}</Badge>
                      <Badge variant={row.triggeredBy === "manual" ? "default" : "secondary"}>{row.triggeredBy}</Badge>
                      <span className="font-mono text-xs">{row.fileName ?? "—"}</span>
                      {row.error && <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Error</Badge>}
                      {row.fileHash && <span className="text-xs font-mono text-muted-foreground">hash {row.fileHash.slice(0, 10)}…</span>}
                    </div>
                    <div className="text-muted-foreground mt-1">
                      {fmtDateTime(row.createdAt)} •
                      {" "}{row.totalRows} rows ({row.inserted} new, {row.updated} updated, {row.unchanged} unchanged)
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Transitioned: {row.transitioned ?? 0} • Expired: {row.expired ?? 0} • Skipped: {row.skipped ?? 0}
                      {row.durationMs != null && ` • ${(row.durationMs / 1000).toFixed(1)}s`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Buckets: available={row.buckets.available}, realized={row.buckets.realized},
                      cancelled={row.buckets.cancelled}, unknown={row.buckets.unknown}
                    </div>
                    {row.error && <div className="text-red-600 text-xs mt-1">{row.error}</div>}
                    {row.warnings.length > 0 && (
                      <ul className="text-xs text-amber-700 mt-1 list-disc pl-5">
                        {row.warnings.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
                        {row.warnings.length > 3 && <li>… and {row.warnings.length - 3} more</li>}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!forceCutoverConfirm} onOpenChange={(o) => !o && setForceCutoverConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force cutover with parity drift?</AlertDialogTitle>
            <AlertDialogDescription>
              Parity drift is {forceCutoverConfirm?.report.global.drift.maxAbsPct}%, which exceeds the 5% safety threshold.
              Proceeding will mark <code>load_fact</code> as system-of-record despite the drift.
              You can flip cutover OFF at any time to revert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-force-cutover">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-force-cutover"
              onClick={() => cutoverMutation.mutate({ enabled: true, force: true })}
            >
              Force cutover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Separator />
      <div className="text-xs text-muted-foreground" data-testid="text-foundation-note">
        Foundation task #368 — downstream scoring/pricing will read from <code>load_fact</code> via the carrierIntelligence service once cutover is active.
      </div>
    </div>
  );
}

function BreakdownTable({ rows, testid }: { rows: ParityBreakdownRow[]; testid: string }) {
  if (!rows || rows.length === 0) {
    return <div className="text-muted-foreground text-xs py-4" data-testid={`${testid}-empty`}>No breakdown rows.</div>;
  }
  return (
    <div className="overflow-x-auto" data-testid={testid}>
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2 pr-3">Key</th>
            <th className="py-2 pr-3">Realized (legacy → lf)</th>
            <th className="py-2 pr-3">Available (legacy → lf)</th>
            <th className="py-2 pr-3">Revenue Δ</th>
            <th className="py-2 pr-3">Margin Δ</th>
            <th className="py-2 pr-3">Max %</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((r) => (
            <tr key={r.key} className="border-t" data-testid={`${testid}-row-${r.key}`}>
              <td className="py-1 pr-3 font-mono">{r.key}</td>
              <td className="py-1 pr-3">{r.legacy.realizedLoads} → {r.loadFact.realizedLoads}</td>
              <td className="py-1 pr-3">{r.legacy.availableLoads} → {r.loadFact.availableLoads}</td>
              <td className="py-1 pr-3">{fmtCurrency(r.drift.revenueDelta)}</td>
              <td className="py-1 pr-3">{fmtCurrency(r.drift.marginDelta)}</td>
              <td className="py-1 pr-3">
                {r.withinTolerance
                  ? <Badge variant="outline" className="text-green-700">{r.drift.maxAbsPct}%</Badge>
                  : <Badge variant="destructive">{r.drift.maxAbsPct}%</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
