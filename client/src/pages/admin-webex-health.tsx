import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Activity, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/queryClient";

type HealthUser = {
  userId: string;
  webexEmail: string | null;
  webexDisplayName: string | null;
  scopeVersion: number;
  needsReauth: boolean;
  scopeUpgradeAvailable: boolean;
  grantedScopes: string[];
  missingScopes: string[];
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  connectedAt: string | null;
  accessTokenExpiresAt: string | null;
};

type SyncStateRow = {
  dataSource: string;
  userId: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  cursor: string | null;
  backfillTotalDays: number;
  backfillCompletedDays: number;
  backfillStartedAt: string | null;
  backfillCompletedAt: string | null;
  progressPct: number | null;
};

type EnrichmentFailure = {
  callId: string;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  updatedAt: string | null;
};

type InventoryRow = { kind: string; count: number; lastUpdatedAt: string | null };

type HealthResponse = {
  currentScopeVersion: number;
  requiredScopes: string[];
  maxBackfillDays: number;
  users: HealthUser[];
  syncState: SyncStateRow[];
  enrichmentJobs: {
    counts: Record<string, number>;
    recentFailures: EnrichmentFailure[];
  };
  inventory: InventoryRow[];
};

function formatTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function relTime(value: string | null): string {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function AdminWebexHealth() {
  const { data, isLoading, isFetching, error } = useQuery<HealthResponse>({
    queryKey: ["/api/webex/health"],
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground" data-testid="loading-webex-health">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading Webex health…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 text-destructive" data-testid="error-webex-health">
        Failed to load Webex health. Admin role required.
      </div>
    );
  }

  const jobs = data.enrichmentJobs.counts;
  const failedTotal = (jobs.failed ?? 0) + (jobs.dead_letter ?? 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" data-testid="page-webex-health">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-600" /> Webex Integration Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Required scope version: <strong>v{data.currentScopeVersion}</strong> ·
            Max backfill window: <strong>{data.maxBackfillDays} days</strong>
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/webex/health"] })}
          disabled={isFetching}
          data-testid="button-refresh-webex-health"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* Enrichment job summary */}
      <Card data-testid="card-enrichment-jobs">
        <CardHeader>
          <CardTitle className="text-base">Call enrichment job queue</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {(["pending", "running", "succeeded", "failed", "dead_letter"] as const).map((status) => {
            const count = jobs[status] ?? 0;
            const tone =
              status === "succeeded"
                ? "text-green-700 bg-green-50 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800"
                : status === "failed" || status === "dead_letter"
                ? "text-red-700 bg-red-50 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800"
                : status === "running"
                ? "text-blue-700 bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
                : "text-muted-foreground bg-muted/40 border-muted";
            return (
              <div
                key={status}
                className={`rounded-md border p-3 text-center ${tone}`}
                data-testid={`stat-jobs-${status}`}
              >
                <p className="text-xs uppercase tracking-wide opacity-80">{status.replace("_", " ")}</p>
                <p className="text-2xl font-bold mt-1">{count}</p>
              </div>
            );
          })}
        </CardContent>
        {data.enrichmentJobs.recentFailures.length > 0 && (
          <CardContent className="pt-0">
            <p className="text-sm font-medium mb-2">Recent failures ({failedTotal})</p>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-2">Call ID</th>
                    <th className="text-left p-2">Attempts</th>
                    <th className="text-left p-2">Last error</th>
                    <th className="text-left p-2">Next retry</th>
                  </tr>
                </thead>
                <tbody>
                  {data.enrichmentJobs.recentFailures.map((f) => (
                    <tr key={f.callId} className="border-t" data-testid={`row-failure-${f.callId}`}>
                      <td className="p-2 font-mono truncate max-w-[200px]" title={f.callId}>{f.callId}</td>
                      <td className="p-2">{f.attempts}</td>
                      <td className="p-2 text-red-700 dark:text-red-300">{f.lastError ?? "—"}</td>
                      <td className="p-2">{relTime(f.nextRetryAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Sync state per data source */}
      <Card data-testid="card-sync-state">
        <CardHeader>
          <CardTitle className="text-base">Backfill & sync progress per data source</CardTitle>
        </CardHeader>
        <CardContent>
          {data.syncState.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sync state recorded yet. Backfill auto-starts after the first OAuth connection.
            </p>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs">
                  <tr>
                    <th className="text-left p-2">Data source</th>
                    <th className="text-left p-2">User</th>
                    <th className="text-left p-2">Progress</th>
                    <th className="text-left p-2">Last success</th>
                    <th className="text-left p-2">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.syncState.map((row, i) => (
                    <tr key={`${row.dataSource}-${row.userId ?? "org"}-${i}`} className="border-t" data-testid={`row-sync-${row.dataSource}-${i}`}>
                      <td className="p-2 font-medium">{row.dataSource}</td>
                      <td className="p-2 text-xs text-muted-foreground">{row.userId ?? <span className="italic">org-level</span>}</td>
                      <td className="p-2 w-[260px]">
                        {row.progressPct != null ? (
                          <div className="space-y-1">
                            <Progress value={row.progressPct} className="h-2" />
                            <p className="text-[11px] text-muted-foreground">
                              {row.backfillCompletedDays}/{row.backfillTotalDays} days ({row.progressPct}%)
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">incremental</span>
                        )}
                      </td>
                      <td className="p-2 text-xs">{relTime(row.lastSuccessAt)}</td>
                      <td className="p-2 text-xs text-red-700 dark:text-red-300 max-w-[260px] truncate" title={row.lastError ?? ""}>
                        {row.lastError ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Inventory snapshots */}
      <Card data-testid="card-inventory">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> Org inventory snapshots
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.inventory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No inventory captured yet. Inventory is snapshotted on connect and periodically thereafter.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {data.inventory.map((row) => (
                <div key={row.kind} className="rounded-md border p-3" data-testid={`stat-inventory-${row.kind}`}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{row.kind}</p>
                  <p className="text-2xl font-bold mt-1">{row.count}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">refreshed {relTime(row.lastUpdatedAt)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-user scope coverage */}
      <Card data-testid="card-user-scopes">
        <CardHeader>
          <CardTitle className="text-base">Per-user scope coverage ({data.users.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.users.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users have connected their personal Webex account yet.</p>
          ) : (
            <div className="space-y-3">
              {data.users.map((u) => {
                const isHealthy = !u.needsReauth && u.missingScopes.length === 0 && !u.scopeUpgradeAvailable;
                return (
                  <div
                    key={u.userId}
                    className="rounded-md border p-3 space-y-2"
                    data-testid={`row-user-scopes-${u.userId}`}
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="font-medium text-sm">{u.webexDisplayName ?? u.webexEmail ?? u.userId}</p>
                        <p className="text-xs text-muted-foreground">{u.webexEmail}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">scope v{u.scopeVersion}</Badge>
                        {isHealthy ? (
                          <Badge className="text-xs bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                            <CheckCircle2 className="h-3 w-3 mr-1" /> Healthy
                          </Badge>
                        ) : u.needsReauth ? (
                          <Badge className="text-xs bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                            <AlertTriangle className="h-3 w-3 mr-1" /> Needs re-auth
                          </Badge>
                        ) : (
                          <Badge className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3 mr-1" /> Scope upgrade available
                          </Badge>
                        )}
                      </div>
                    </div>
                    {u.missingScopes.length > 0 && (
                      <div className="text-xs">
                        <span className="font-medium text-amber-800 dark:text-amber-300">Missing: </span>
                        <span className="font-mono">{u.missingScopes.join(", ")}</span>
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      Connected {formatTime(u.connectedAt)} · Last refresh {relTime(u.lastRefreshAt)}
                      {u.lastRefreshError && (
                        <span className="text-red-700 dark:text-red-300"> · {u.lastRefreshError}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
