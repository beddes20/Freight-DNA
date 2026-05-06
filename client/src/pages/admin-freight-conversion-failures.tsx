/**
 * Phase A5 — Won-Quote conversion failure audit (admin-only).
 *
 * Lists every silent drop the converter (createFreightOpportunityFromWonQuote)
 * has logged, with one-click Retry and Mark-resolved actions plus a header
 * health pill. Reps never visit this page; it exists so an admin can
 * answer "is the Won → Freight handoff healthy?" at any moment.
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
  CheckCircle2, AlertTriangle, RefreshCw, Loader2, Wrench, ShieldCheck, Clock,
} from "lucide-react";

type Reason =
  | "no_customer"
  | "fake_customer"
  | "company_create_failed"
  | "exception"
  | "backfill_orphan";

type FailureRow = {
  id: string;
  quoteId: string;
  reason: Reason;
  detail: string | null;
  errorMessage: string | null;
  attemptedAt: string;
  retryCount: number;
  lastRetryAt: string | null;
  lastRetryError: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  customerName: string | null;
  repName: string | null;
  originCity: string | null;
  originState: string | null;
  destCity: string | null;
  destState: string | null;
  equipment: string | null;
  quotedAmount: string | null;
  outcomeStatus: string | null;
};

type FailuresResponse = { ok: true; status: "open" | "resolved" | "all"; rows: FailureRow[] };
type HealthResponse = {
  ok: true;
  openCount: number;
  resolvedThisWeek: number;
  last24hOpened: number;
  last7dOpened: number;
};

const REASON_LABEL: Record<Reason, string> = {
  no_customer: "No customer",
  fake_customer: "Fake customer name",
  company_create_failed: "Company create failed",
  exception: "Converter exception",
  backfill_orphan: "Pre-A5 orphan",
};

function ReasonBadge({ reason }: { reason: Reason }): JSX.Element {
  const tone =
    reason === "exception"
      ? "text-red-700 border-red-300 dark:text-red-300 dark:border-red-800"
      : reason === "backfill_orphan"
        ? "text-zinc-700 border-zinc-300 dark:text-zinc-300 dark:border-zinc-700"
        : "text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800";
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

function fmtLane(r: FailureRow): string {
  const o = [r.originCity, r.originState].filter(Boolean).join(", ");
  const d = [r.destCity, r.destState].filter(Boolean).join(", ");
  if (!o && !d) return "—";
  return `${o || "?"} → ${d || "?"}`;
}

export default function AdminFreightConversionFailuresPage(): JSX.Element {
  const { user } = useAuth();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"open" | "resolved" | "all">("open");
  const [resolveDialog, setResolveDialog] = useState<{ row: FailureRow } | null>(null);
  const [resolveNote, setResolveNote] = useState("");

  const isAuthorized = !!user && user.role === "admin";

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<FailuresResponse>({
    queryKey: ["/api/admin/freight-conversion-failures", statusFilter],
    enabled: isAuthorized,
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/freight-conversion-failures?status=${encodeURIComponent(statusFilter)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const { data: health } = useQuery<HealthResponse>({
    queryKey: ["/api/admin/freight-conversion-failures/health"],
    enabled: isAuthorized,
    refetchInterval: 30_000,
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/freight-conversion-failures/${id}/retry`, {});
      return (await res.json()) as { ok: boolean; retried?: boolean; freightOpportunityId?: string; error?: string };
    },
    onSuccess: (res) => {
      if (res.ok && res.freightOpportunityId) {
        toast({
          title: "Won load created",
          description: `Freight opportunity ${res.freightOpportunityId.slice(0, 8)}… is now in the cockpit.`,
        });
      } else {
        toast({
          title: "Retry did not clear the failure",
          description: res.error ?? "See updated reason in the row.",
          variant: "destructive",
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/freight-conversion-failures"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/freight-conversion-failures/health"] });
    },
    onError: (err: Error) => {
      toast({ title: "Retry failed", description: err.message, variant: "destructive" });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (input: { id: string; note: string | null }) => {
      const res = await apiRequest("POST", `/api/admin/freight-conversion-failures/${input.id}/resolve`, { note: input.note });
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: () => {
      toast({ title: "Marked resolved", description: "Failure cleared from the open queue." });
      setResolveDialog(null);
      setResolveNote("");
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/freight-conversion-failures"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/freight-conversion-failures/health"] });
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
            <CardDescription>You need admin access to view the Won → Freight failure audit.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const isHealthy = (health?.openCount ?? 0) === 0;

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto" data-testid="page-freight-conversion-failures">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-page-title">
            Won → Freight failure audit
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-page-summary">
            Every won quote that didn't make it into the freight cockpit. Click <strong>Retry</strong> to re-run the converter,
            or <strong>Mark resolved</strong> if the drop is genuinely fine.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as "open" | "resolved" | "all")}>
            <SelectTrigger className="w-36" data-testid="select-status-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open" data-testid="option-status-open">Open</SelectItem>
              <SelectItem value="resolved" data-testid="option-status-resolved">Resolved</SelectItem>
              <SelectItem value="all" data-testid="option-status-all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh">
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Card data-testid="card-health-open">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              {isHealthy
                ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
              Open failures
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-semibold ${isHealthy ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}
                 data-testid="text-health-open">
              {health?.openCount ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1" data-testid="text-health-banner">
              {isHealthy
                ? "Won → Freight is healthy."
                : `${health?.last24hOpened ?? 0} new in the last 24h, ${health?.last7dOpened ?? 0} in the last 7 days.`}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-health-resolved">
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />Resolved this week
          </CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold" data-testid="text-health-resolved">
              {health?.resolvedThisWeek ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Auto + manual.</div>
          </CardContent>
        </Card>
        <Card data-testid="card-health-24h">
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-zinc-600" />New in 24h
          </CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold" data-testid="text-health-24h">
              {health?.last24hOpened ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Newly logged failures still open.</div>
          </CardContent>
        </Card>
        <Card data-testid="card-health-7d">
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-zinc-600" />New in 7d
          </CardDescription></CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold" data-testid="text-health-7d">
              {health?.last7dOpened ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground mt-1">Trend over the past week.</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Failures</CardTitle>
          <CardDescription>
            Showing <strong>{statusFilter}</strong> failures. Retry re-runs the converter; the row auto-clears on success.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center" data-testid="text-loading">
              <Loader2 className="h-4 w-4 animate-spin" />Loading…
            </div>
          )}
          {isError && (
            <div className="text-sm text-destructive py-4" data-testid="text-error">
              Failed to load failures: {(error as Error)?.message ?? "unknown error"}
            </div>
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-empty">
              {statusFilter === "open"
                ? "Won → Freight is healthy — no failures recorded."
                : "No failures match this filter."}
            </div>
          )}
          {!isLoading && !isError && rows.length > 0 && (
            <Table data-testid="table-failures">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Quote / Lane</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">Retries</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const resolved = !!r.resolvedAt;
                  return (
                    <TableRow key={r.id} data-testid={`row-failure-${r.id}`}>
                      <TableCell className="text-xs whitespace-nowrap" data-testid={`text-attempted-${r.id}`}>
                        {fmtDateTime(r.attemptedAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-mono text-[11px] text-muted-foreground" data-testid={`text-quote-id-${r.id}`}>
                          {r.quoteId.slice(0, 8)}…
                        </div>
                        <div data-testid={`text-lane-${r.id}`}>{fmtLane(r)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {r.equipment ?? "—"}{r.quotedAmount ? ` · $${Number(r.quotedAmount).toLocaleString()}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm" data-testid={`text-customer-${r.id}`}>
                        {r.customerName ?? <span className="text-muted-foreground italic">unmapped</span>}
                        {r.repName && <div className="text-[11px] text-muted-foreground">rep: {r.repName}</div>}
                      </TableCell>
                      <TableCell><ReasonBadge reason={r.reason} /></TableCell>
                      <TableCell className="text-xs max-w-[28ch]" data-testid={`text-detail-${r.id}`}>
                        <div>{r.detail ?? "—"}</div>
                        {r.errorMessage && (
                          <div className="font-mono text-[11px] text-red-700 dark:text-red-400 mt-1 break-all">
                            {r.errorMessage}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-right" data-testid={`text-retries-${r.id}`}>
                        {r.retryCount}
                        {r.lastRetryAt && (
                          <div className="text-[11px] text-muted-foreground">last {fmtDateTime(r.lastRetryAt)}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        {resolved ? (
                          <Badge variant="outline" className="text-emerald-700 border-emerald-300 dark:text-emerald-300 dark:border-emerald-800" data-testid={`badge-resolved-${r.id}`}>
                            <CheckCircle2 className="h-3 w-3 mr-1" />Resolved
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-800" data-testid={`badge-open-${r.id}`}>
                            <AlertTriangle className="h-3 w-3 mr-1" />Open
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {!resolved && (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="default"
                              disabled={retryMutation.isPending}
                              onClick={() => retryMutation.mutate(r.id)}
                              data-testid={`button-retry-${r.id}`}
                            >
                              <Wrench className="h-3.5 w-3.5 mr-1" />Retry
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setResolveDialog({ row: r }); setResolveNote(""); }}
                              data-testid={`button-resolve-${r.id}`}
                            >
                              Mark resolved
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
            <DialogTitle>Mark this failure resolved</DialogTitle>
            <DialogDescription>
              Use this when the drop is genuinely fine — for example the quote was a duplicate, or the freight
              has already been logged manually. The row will move to the Resolved tab and stop counting against
              the open-failures pill.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="resolve-note">Optional note</label>
            <Textarea
              id="resolve-note"
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              placeholder="e.g. duplicate of quote ABCD1234 — freight already in cockpit"
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
