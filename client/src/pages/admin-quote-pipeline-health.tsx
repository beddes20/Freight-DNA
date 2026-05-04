/**
 * Task #952 — Customer-Quote pipeline operator console (admin-only).
 *
 * Lists every silent drop that landed in `quote_pipeline_drops`
 * (classifier_miss, outbound, duplicate, unparseable, exception) with
 * one-click Reprocess and Mark-resolved actions, plus a header funnel +
 * health pill. Reps don't visit this page; it exists so an admin can
 * answer "is the email → quote pipeline healthy?" at any moment.
 *
 * Mirrors the visual + interaction pattern of
 * `admin-freight-conversion-failures.tsx` (Phase A5) so admins build
 * one mental model for the two adjacent failure consoles.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  CheckCircle2, AlertTriangle, RefreshCw, Loader2, Wrench, ShieldCheck, Clock, Activity,
} from "lucide-react";
import { formatQuoteConfidence } from "@/lib/customerQuotes";

type Reason =
  | "classifier_miss"
  | "outbound"
  | "duplicate"
  | "unparseable"
  | "exception";

type Stage = "classification" | "ingest";

type DropRow = {
  id: string;
  messageId: string | null;
  stage: Stage;
  reasonCode: Reason;
  detail: string | null;
  errorMessage: string | null;
  senderEmail: string | null;
  subject: string | null;
  receivedAt: string | null;
  confidence: string | null;
  quoteId: string | null;
  attemptedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  reprocessCount: number;
  lastReprocessAt: string | null;
  lastReprocessError: string | null;
};

type DropsResponse = { ok: true; rows: DropRow[]; total: number; limit: number; offset: number; includeArchived?: boolean };
type HealthResponse = {
  ok: true;
  openCount: number;
  last24hOpened: number;
  last7dOpened: number;
  openByReason: Record<Reason, number>;
};
type FunnelResponse = {
  ok: true;
  window: "24h" | "7d";
  inboundTotal: number;
  classifiedAsQuote: number;
  ingested: number;
  dropsByReason: Record<Reason, number>;
};

const REASON_LABEL: Record<Reason, string> = {
  classifier_miss: "Classifier miss",
  outbound: "Outbound (skipped)",
  duplicate: "Duplicate",
  unparseable: "Unparseable",
  exception: "Exception",
};

function ReasonBadge({ reason }: { reason: Reason }): JSX.Element {
  const tone =
    reason === "exception"
      ? "text-red-700 border-red-300 dark:text-red-300 dark:border-red-800"
      : reason === "classifier_miss"
        ? "text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800"
        : reason === "unparseable"
          ? "text-orange-700 border-orange-300 dark:text-orange-300 dark:border-orange-800"
          : "text-zinc-700 border-zinc-300 dark:text-zinc-300 dark:border-zinc-700";
  return (
    <Badge variant="outline" className={tone} data-testid={`badge-reason-${reason}`}>
      {REASON_LABEL[reason]}
    </Badge>
  );
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fmtPct(numer: number, denom: number): string {
  if (!denom) return "—";
  return `${Math.round((numer / denom) * 100)}%`;
}

export default function AdminQuotePipelineHealthPage(): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const [reasonFilter, setReasonFilter] = useState<"" | Reason>("");
  const [showResolved, setShowResolved] = useState<"open" | "all">("open");
  // Task #969 — opt-in toggle for the historical (archived) tail.
  // The default operator view shows only the active 30-day window.
  const [includeArchived, setIncludeArchived] = useState(false);
  const [funnelWindow, setFunnelWindow] = useState<"24h" | "7d">("24h");
  const [resolveDialog, setResolveDialog] = useState<{ row: DropRow } | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const isAuthorized = !!user && user.role === "admin";

  const dropsQueryKey = ["/api/admin/quote-pipeline/drops", reasonFilter, showResolved, includeArchived] as const;
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<DropsResponse>({
    queryKey: dropsQueryKey,
    enabled: isAuthorized,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (reasonFilter) params.set("reason", reasonFilter);
      if (showResolved === "all") params.set("resolved", "all");
      if (includeArchived) params.set("include_archived", "1");
      const res = await fetch(`/api/admin/quote-pipeline/drops?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const { data: health } = useQuery<HealthResponse>({
    queryKey: ["/api/admin/quote-pipeline/health"],
    enabled: isAuthorized,
    refetchInterval: 30_000,
  });

  const { data: funnel } = useQuery<FunnelResponse>({
    queryKey: ["/api/admin/quote-pipeline/funnel", funnelWindow],
    enabled: isAuthorized,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await fetch(`/api/admin/quote-pipeline/funnel?window=${funnelWindow}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const reprocessMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/quote-pipeline/drops/${id}/reprocess`, {});
      return (await res.json()) as { ok: boolean; reprocessed?: boolean; resolved?: boolean; status?: string; quoteId?: string | null; error?: string };
    },
    onSuccess: (res) => {
      if (res.ok && res.resolved && res.quoteId) {
        toast({
          title: "Quote opportunity captured",
          description: `Quote ${res.quoteId.slice(0, 8)}… is now in /quote-requests.`,
        });
      } else if (res.ok && res.resolved) {
        toast({ title: "Drop resolved", description: "No quote was created (auto-resolved)." });
      } else {
        toast({
          title: "Reprocess did not capture a quote",
          description: res.error ?? `Status: ${res.status ?? "unknown"}`,
          variant: "destructive",
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/quote-pipeline/drops"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/quote-pipeline/health"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/quote-pipeline/funnel"] });
    },
    onError: (err: Error) => {
      toast({ title: "Reprocess failed", description: err.message, variant: "destructive" });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (input: { id: string; note: string | null }) => {
      const res = await apiRequest("POST", `/api/admin/quote-pipeline/drops/${input.id}/resolve`, { note: input.note });
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: () => {
      toast({ title: "Marked resolved", description: "Drop cleared from the open queue." });
      setResolveDialog(null);
      setResolveNote("");
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/quote-pipeline/drops"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/quote-pipeline/health"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to resolve", description: err.message, variant: "destructive" });
    },
  });

  if (!isAuthorized) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
            <CardDescription>You need admin access to view the customer-quote pipeline console.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const isHealthy = (health?.openCount ?? 0) === 0;
  // Capture rate = ingested ÷ classifiedAsQuote (the meaningful denominator —
  // unrelated emails shouldn't drag the rate down).
  const captureRate = funnel ? fmtPct(funnel.ingested, funnel.classifiedAsQuote) : "—";

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto" data-testid="page-quote-pipeline-health">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">
            Customer-quote pipeline
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-summary">
            Every email → quote attempt the inline classifier or ingestion stage decided not to capture.
            Click <strong>Reprocess</strong> to re-run; the row auto-resolves if a quote is created.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh">
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </div>

      {/* Header health row */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card data-testid="card-health-open">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              {isHealthy
                ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
              Open drops
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-semibold ${isHealthy ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}
                 data-testid="text-health-open">
              {health?.openCount ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1" data-testid="text-health-banner">
              {isHealthy
                ? "Pipeline is healthy."
                : `${health?.last24hOpened ?? 0} new in 24h, ${health?.last7dOpened ?? 0} in 7d.`}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-health-classifier-miss">
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />Open: classifier miss
          </CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold" data-testid="text-health-classifier-miss">
              {health?.openByReason.classifier_miss ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Customer email matched no quote intent.</div>
          </CardContent>
        </Card>
        <Card data-testid="card-health-unparseable">
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5 text-orange-600" />Open: unparseable
          </CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold" data-testid="text-health-unparseable">
              {health?.openByReason.unparseable ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Quote intent matched but parse failed.</div>
          </CardContent>
        </Card>
        <Card data-testid="card-health-exception">
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />Open: exception
          </CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold" data-testid="text-health-exception">
              {health?.openByReason.exception ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Ingestion threw — investigate first.</div>
          </CardContent>
        </Card>
      </div>

      {/* Trailing funnel */}
      <Card data-testid="card-funnel">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" /> Trailing funnel
            </CardTitle>
            <CardDescription>Inbound → classified → ingested over the selected window.</CardDescription>
          </div>
          <Select value={funnelWindow} onValueChange={(v) => setFunnelWindow(v as "24h" | "7d")}>
            <SelectTrigger className="w-28" data-testid="select-funnel-window"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="24h" data-testid="option-window-24h">Last 24h</SelectItem>
              <SelectItem value="7d" data-testid="option-window-7d">Last 7 days</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div data-testid="stat-funnel-inbound">
              <div className="text-xs text-muted-foreground">Inbound</div>
              <div className="text-xl font-semibold">{funnel?.inboundTotal ?? "—"}</div>
            </div>
            <div data-testid="stat-funnel-classified">
              <div className="text-xs text-muted-foreground">Classified as quote</div>
              <div className="text-xl font-semibold">{funnel?.classifiedAsQuote ?? "—"}</div>
            </div>
            <div data-testid="stat-funnel-ingested">
              <div className="text-xs text-muted-foreground">Ingested</div>
              <div className="text-xl font-semibold">{funnel?.ingested ?? "—"}</div>
            </div>
            <div data-testid="stat-funnel-capture-rate">
              <div className="text-xs text-muted-foreground">Capture rate (ingested ÷ classified)</div>
              <div className="text-xl font-semibold">{captureRate}</div>
            </div>
          </div>
          {funnel && (
            <div className="mt-3 pt-3 border-t flex flex-wrap gap-2 text-xs" data-testid="row-funnel-drops">
              <span className="text-muted-foreground">Drops by reason:</span>
              {(Object.keys(funnel.dropsByReason) as Reason[]).map((reason) => (
                <span key={reason} className="inline-flex items-center gap-1" data-testid={`stat-funnel-drop-${reason}`}>
                  <ReasonBadge reason={reason} />
                  <span className="font-mono">{funnel.dropsByReason[reason]}</span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Drops table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle>Drops</CardTitle>
              <CardDescription data-testid="text-drops-window">
                Showing drops from the last <strong>30 days</strong>
                {includeArchived ? <> (<strong>including archived</strong>)</> : null}.
                {" "}
                <strong>{showResolved}</strong> drops{reasonFilter ? <> filtered by <strong>{REASON_LABEL[reasonFilter]}</strong></> : null}.
                Reprocess re-runs ingestion; the row auto-clears on success.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={reasonFilter || "all"} onValueChange={(v) => setReasonFilter(v === "all" ? "" : (v as Reason))}>
                <SelectTrigger className="w-44" data-testid="select-reason-filter"><SelectValue placeholder="All reasons" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" data-testid="option-reason-all">All reasons (excl. duplicate)</SelectItem>
                  <SelectItem value="classifier_miss" data-testid="option-reason-classifier_miss">Classifier miss</SelectItem>
                  <SelectItem value="unparseable" data-testid="option-reason-unparseable">Unparseable</SelectItem>
                  <SelectItem value="exception" data-testid="option-reason-exception">Exception</SelectItem>
                  <SelectItem value="outbound" data-testid="option-reason-outbound">Outbound</SelectItem>
                  <SelectItem value="duplicate" data-testid="option-reason-duplicate">Duplicate</SelectItem>
                </SelectContent>
              </Select>
              <Select value={showResolved} onValueChange={(v) => setShowResolved(v as "open" | "all")}>
                <SelectTrigger className="w-32" data-testid="select-resolved-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="open" data-testid="option-resolved-open">Open only</SelectItem>
                  <SelectItem value="all" data-testid="option-resolved-all">Include resolved</SelectItem>
                </SelectContent>
              </Select>
              {/* Task #969 — opt-in to the historical (archived) tail. */}
              <label
                className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
                data-testid="label-include-archived"
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 cursor-pointer"
                  checked={includeArchived}
                  onChange={(e) => setIncludeArchived(e.target.checked)}
                  data-testid="toggle-include-archived"
                />
                Include archived
              </label>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center" data-testid="text-loading">
              <Loader2 className="h-4 w-4 animate-spin" />Loading…
            </div>
          )}
          {isError && (
            <div className="text-sm text-destructive py-4" data-testid="text-error">
              Failed to load drops: {(error as Error)?.message ?? "unknown error"}
            </div>
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty">
              {showResolved === "open"
                ? "Pipeline is healthy — no open drops match this filter."
                : "No drops match this filter."}
            </div>
          )}
          {!isLoading && !isError && rows.length > 0 && (
            <Table data-testid="table-drops">
              <TableHeader>
                <TableRow>
                  <TableHead>Attempted</TableHead>
                  <TableHead>From / Subject</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">Reprocess</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const resolved = !!r.resolvedAt;
                  return (
                    <TableRow key={r.id} data-testid={`row-drop-${r.id}`}>
                      <TableCell className="text-xs whitespace-nowrap" data-testid={`text-attempted-${r.id}`}>
                        {fmtDateTime(r.attemptedAt)}
                        {r.receivedAt && (
                          <div className="text-[11px] text-muted-foreground">recv {fmtDateTime(r.receivedAt)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs max-w-[28ch]">
                        <div className="truncate" data-testid={`text-sender-${r.id}`}>
                          {r.senderEmail ?? <span className="text-muted-foreground italic">unknown</span>}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate" data-testid={`text-subject-${r.id}`}>
                          {r.subject ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs" data-testid={`text-stage-${r.id}`}>
                        {r.stage}
                        {r.confidence != null && (
                          <div className="text-[11px] text-muted-foreground" data-testid={`text-confidence-${r.id}`}>
                            conf {formatQuoteConfidence(r.confidence)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell><ReasonBadge reason={r.reasonCode} /></TableCell>
                      <TableCell className="text-xs max-w-[32ch]" data-testid={`text-detail-${r.id}`}>
                        <div>{r.detail ?? "—"}</div>
                        {r.errorMessage && (
                          <div className="font-mono text-[11px] text-red-700 dark:text-red-400 mt-1 break-all">
                            {r.errorMessage}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-right" data-testid={`text-reprocess-count-${r.id}`}>
                        {r.reprocessCount}
                        {r.lastReprocessAt && (
                          <div className="text-[11px] text-muted-foreground">last {fmtDateTime(r.lastReprocessAt)}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {resolved ? (
                          <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800" data-testid={`badge-resolved-${r.id}`}>
                            <CheckCircle2 className="h-3 w-3 mr-1" />Resolved
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800" data-testid={`badge-open-${r.id}`}>
                            <Clock className="h-3 w-3 mr-1" />Open
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {!resolved && (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="default"
                              disabled={reprocessMutation.isPending || !r.messageId}
                              onClick={() => reprocessMutation.mutate(r.id)}
                              data-testid={`button-reprocess-${r.id}`}
                              title={r.messageId ? "Re-run ingestion" : "Source message no longer exists"}
                            >
                              <Wrench className="h-3.5 w-3.5 mr-1" />Reprocess
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setResolveDialog({ row: r }); setResolveNote(""); }}
                              data-testid={`button-resolve-${r.id}`}
                            >
                              Resolve
                            </Button>
                          </div>
                        )}
                        {resolved && r.resolutionNote && (
                          <div className="text-[11px] text-muted-foreground max-w-[28ch]" data-testid={`text-resolution-note-${r.id}`}>
                            {r.resolutionNote}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!resolveDialog} onOpenChange={(open) => { if (!open) setResolveDialog(null); }}>
        <DialogContent data-testid="dialog-resolve">
          <DialogHeader>
            <DialogTitle>Mark this drop resolved</DialogTitle>
            <DialogDescription>
              Use this when the email genuinely shouldn't become a quote (e.g. spam mis-classified as customer,
              status update, internal team mail). The row moves to Resolved and stops counting against the
              open-drops pill.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="resolve-note">Optional note</label>
            <Textarea
              id="resolve-note"
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              placeholder="e.g. status update from carrier, not a quote request"
              data-testid="input-resolve-note"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResolveDialog(null)} data-testid="button-resolve-cancel">Cancel</Button>
            <Button
              onClick={() => {
                if (resolveDialog) {
                  resolveMutation.mutate({
                    id: resolveDialog.row.id,
                    note: resolveNote.trim() ? resolveNote.trim() : null,
                  });
                }
              }}
              disabled={resolveMutation.isPending}
              data-testid="button-resolve-confirm"
            >
              Mark resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
