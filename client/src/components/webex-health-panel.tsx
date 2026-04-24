import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock, Database, ShieldAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";

interface UserHealth {
  userId: string;
  email: string | null;
  name: string | null;
  scopesGranted: string[];
  scopesMissing: string[];
  scopesVersion: number;
  scopesCurrent: boolean;
  needsReauth: boolean;
  reauthReason: string | null;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
}

interface SyncStateRow {
  id: string;
  dataType: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface BackfillJobRow {
  id: string;
  dataType: string;
  status: string;
  targetWindowDays: number | null;
  startedAt: string;
  completedAt: string | null;
  chunksTotal: number;
  chunksDone: number;
  chunksFailed: number;
  itemsProcessed: number;
  progressPct: string | null;
  etaMs: number | null;
  lastError: string | null;
  triggeredBy: string | null;
}

interface FailureRow {
  id: string;
  endpoint: string;
  method: string;
  status: number;
  body: string | null;
  occurredAt: string;
}

interface WebexHealthResponse {
  scopesVersion: number;
  expectedScopes: string[];
  users: UserHealth[];
  syncState: SyncStateRow[];
  backfillJobs: BackfillJobRow[];
  recentFailures: FailureRow[];
  enrichmentQueue: Record<string, number>;
  defaultBackfillDays: number;
  maxBackfillDays: number;
}

const REFRESHABLE_DATA_TYPES: Array<{ key: string; label: string }> = [
  { key: "workspaces",     label: "Workspaces" },
  { key: "locations",      label: "Locations" },
  { key: "call_queues",    label: "Call Queues" },
  { key: "hunt_groups",    label: "Hunt Groups" },
  { key: "devices",        label: "Devices" },
  { key: "admin_reports",  label: "Admin Reports" },
];

function formatRelative(ts: string | null): string {
  if (!ts) return "never";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return ts;
  }
}

function formatEta(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

export function WebexHealthPanel() {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useQuery<WebexHealthResponse>({
    queryKey: ["/api/webex/health"],
    refetchInterval: 30_000,
  });

  const syncMutation = useMutation({
    mutationFn: async (dataType: string) => {
      return apiRequest("POST", `/api/webex/admin/sync/${dataType}`);
    },
    onSuccess: (_res, dataType) => {
      toast({ title: `Refreshed ${dataType.replace(/_/g, " ")}` });
      queryClient.invalidateQueries({ queryKey: ["/api/webex/health"] });
    },
    onError: (err: Error) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <Card data-testid="card-webex-health">
        <CardContent className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading Webex Health…
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card data-testid="card-webex-health">
        <CardContent className="p-6 text-sm text-destructive">
          Failed to load Webex Health.
          <Button size="sm" variant="outline" className="ml-3" onClick={() => refetch()} data-testid="button-retry-webex-health">Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const enrichmentTotals = Object.entries(data.enrichmentQueue ?? {});
  const usersNeedingReauth = data.users.filter(u => u.needsReauth || !u.scopesCurrent);
  const activeBackfill = data.backfillJobs.find(j => j.status === "running");

  return (
    <TooltipProvider>
      <Card data-testid="card-webex-health">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Webex Health
            <Badge variant="outline" className="ml-2 text-xs" data-testid="badge-webex-scopes-version">
              scopes v{data.scopesVersion}
            </Badge>
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-refresh-webex-health">
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Per-user scopes & re-auth state */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">Connected users ({data.users.length})</h3>
              {usersNeedingReauth.length > 0 && (
                <Badge variant="destructive" className="text-xs" data-testid="badge-users-needing-reauth">
                  <ShieldAlert className="h-3 w-3 mr-1" /> {usersNeedingReauth.length} need re-auth
                </Badge>
              )}
            </div>
            <div className="rounded border divide-y text-sm">
              {data.users.length === 0 && (
                <div className="p-3 text-muted-foreground" data-testid="text-no-webex-users">No users have connected Webex yet.</div>
              )}
              {data.users.map(u => (
                <div key={u.userId} className="p-3 flex items-start justify-between gap-3" data-testid={`row-webex-user-${u.userId}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{u.name || u.email}</div>
                    <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                    {u.lastRefreshError && (
                      <div className="text-xs text-destructive mt-1 truncate" title={u.lastRefreshError}>
                        token refresh: {u.lastRefreshError}
                      </div>
                    )}
                    {u.scopesMissing.length > 0 && (
                      <div className="text-xs text-amber-600 dark:text-amber-400 mt-1" data-testid={`text-missing-scopes-${u.userId}`}>
                        missing: {u.scopesMissing.length} scope(s)
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {u.needsReauth ? (
                      <Badge variant="destructive" className="text-xs">needs re-auth</Badge>
                    ) : u.scopesCurrent ? (
                      <Badge variant="default" className="text-xs bg-emerald-600 hover:bg-emerald-700">
                        <CheckCircle2 className="h-3 w-3 mr-1" /> current
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">stale scopes</Badge>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-[11px] text-muted-foreground" data-testid={`text-last-refresh-${u.userId}`}>
                          refreshed {formatRelative(u.lastRefreshAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Granted {u.scopesGranted.length} of {data.expectedScopes.length} scopes (v{u.scopesVersion})
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Backfill progress */}
          <section>
            <h3 className="text-sm font-medium mb-2">
              Backfill jobs (target {data.defaultBackfillDays}d)
            </h3>
            {data.backfillJobs.length === 0 && (
              <div className="text-sm text-muted-foreground" data-testid="text-no-backfill-jobs">No backfill jobs yet.</div>
            )}
            <div className="space-y-2">
              {data.backfillJobs.map(j => {
                const pct = Number(j.progressPct ?? 0);
                return (
                  <div key={j.id} className="rounded border p-3 text-sm" data-testid={`row-backfill-${j.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{j.dataType}</span>
                        <Badge variant={j.status === "completed" ? "default" : j.status === "failed" ? "destructive" : "secondary"} className="text-xs">
                          {j.status}
                        </Badge>
                        {j.targetWindowDays && (
                          <span className="text-xs text-muted-foreground">{j.targetWindowDays}d window</span>
                        )}
                        {j.triggeredBy && (
                          <span className="text-xs text-muted-foreground">· {j.triggeredBy}</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {j.chunksDone}/{j.chunksTotal} chunks · ETA {formatEta(j.etaMs)}
                      </span>
                    </div>
                    <Progress value={pct} className="h-2 mt-2" data-testid={`progress-backfill-${j.id}`} />
                    {j.lastError && (
                      <div className="text-xs text-destructive mt-1 truncate" title={j.lastError}>
                        last error: {j.lastError}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {!activeBackfill && (
              <div className="text-xs text-muted-foreground mt-2">
                No backfill currently running. New connections automatically seed {data.defaultBackfillDays} days.
              </div>
            )}
          </section>

          {/* Per-data-type sync state with refresh buttons */}
          <section>
            <h3 className="text-sm font-medium mb-2">Last sync per data type</h3>
            <div className="grid sm:grid-cols-2 gap-2">
              {REFRESHABLE_DATA_TYPES.map(({ key, label }) => {
                const row = data.syncState.find(s => s.dataType === key);
                const okRecent = row?.lastSuccessAt && (!row.lastError || (row.lastErrorAt && row.lastSuccessAt > row.lastErrorAt));
                return (
                  <div key={key} className="rounded border p-3 flex items-center justify-between gap-2" data-testid={`row-sync-${key}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{label}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {row ? formatRelative(row.lastSuccessAt) : "never synced"}
                      </div>
                      {row?.lastError && !okRecent && (
                        <div className="text-xs text-destructive mt-0.5 truncate" title={row.lastError}>
                          {row.lastError}
                        </div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => syncMutation.mutate(key)}
                      disabled={syncMutation.isPending}
                      data-testid={`button-sync-${key}`}
                    >
                      {syncMutation.isPending && syncMutation.variables === key
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : <RefreshCw className="h-3 w-3" />}
                    </Button>
                  </div>
                );
              })}
            </div>
            {/* Other auto-tracked sync rows (e.g. calls_backfill, voicemails:userId) */}
            {data.syncState.filter(s => !REFRESHABLE_DATA_TYPES.some(r => r.key === s.dataType)).length > 0 && (
              <div className="mt-3 rounded border divide-y text-xs">
                {data.syncState
                  .filter(s => !REFRESHABLE_DATA_TYPES.some(r => r.key === s.dataType))
                  .map(s => (
                    <div key={s.id} className="p-2 flex items-center justify-between gap-2" data-testid={`row-sync-extra-${s.dataType}`}>
                      <span className="font-mono">{s.dataType}</span>
                      <span className="text-muted-foreground">{formatRelative(s.lastSuccessAt)}</span>
                    </div>
                  ))}
              </div>
            )}
          </section>

          {/* Enrichment queue */}
          <section>
            <h3 className="text-sm font-medium mb-2">Detailed-call enrichment queue</h3>
            {enrichmentTotals.length === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="text-empty-enrichment-queue">Queue is empty.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {enrichmentTotals.map(([status, count]) => (
                  <Badge
                    key={status}
                    variant={status === "failed" ? "destructive" : status === "completed" ? "default" : "secondary"}
                    className="text-xs"
                    data-testid={`badge-enrichment-${status}`}
                  >
                    {status}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          {/* Recent failures */}
          <section>
            <h3 className="text-sm font-medium mb-2 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Recent API failures
              <span className="text-xs text-muted-foreground font-normal">(last 50)</span>
            </h3>
            {data.recentFailures.length === 0 ? (
              <div className="text-sm text-muted-foreground" data-testid="text-no-failures">No recent Webex API failures.</div>
            ) : (
              <div className="rounded border divide-y text-xs max-h-72 overflow-y-auto">
                {data.recentFailures.map(f => (
                  <div key={f.id} className="p-2 flex items-start justify-between gap-2" data-testid={`row-failure-${f.id}`}>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono truncate" title={f.endpoint}>{f.method} {f.endpoint}</div>
                      {f.body && (
                        <div className="text-muted-foreground truncate" title={f.body}>{f.body}</div>
                      )}
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <Badge variant={f.status >= 500 ? "destructive" : "secondary"} className="text-[10px]">
                        {f.status}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">{formatRelative(f.occurredAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
