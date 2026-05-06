import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  ShieldAlert,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDistanceToNow } from "date-fns";

interface UserHealth {
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
}

interface SyncStateRow {
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
}

interface EnrichmentFailure {
  callId: string;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  updatedAt: string | null;
}

interface InventoryRow {
  kind: string;
  count: number;
  lastUpdatedAt: string | null;
}

interface WebexHealthResponse {
  currentScopeVersion: number;
  requiredScopes: string[];
  maxBackfillDays: number;
  users: UserHealth[];
  syncState: SyncStateRow[];
  enrichmentJobs: {
    counts: Record<string, number>;
    recentFailures: EnrichmentFailure[];
  };
  inventory: InventoryRow[];
}

function formatRelative(ts: string | null): string {
  if (!ts) return "never";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return ts;
  }
}

export function WebexHealthPanel() {
  const { data, isLoading, isError, refetch } = useQuery<WebexHealthResponse>({
    queryKey: ["/api/webex/health"],
    refetchInterval: 30_000,
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
          <Button
            size="sm"
            variant="outline"
            className="ml-3"
            onClick={() => refetch()}
            data-testid="button-retry-webex-health"
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const enrichmentTotals = Object.entries(data.enrichmentJobs?.counts ?? {});
  const recentFailures = data.enrichmentJobs?.recentFailures ?? [];
  const usersNeedingReauth = data.users.filter(
    (u) => u.needsReauth || u.scopeUpgradeAvailable,
  );
  const activeBackfill = data.syncState.find(
    (s) => s.backfillStartedAt && !s.backfillCompletedAt,
  );

  return (
    <TooltipProvider>
      <Card data-testid="card-webex-health">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Webex Health
            <Badge
              variant="outline"
              className="ml-2 text-xs"
              data-testid="badge-webex-scopes-version"
            >
              scopes v{data.currentScopeVersion}
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            data-testid="button-refresh-webex-health"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Per-user scopes & re-auth state */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">
                Connected users ({data.users.length})
              </h3>
              {usersNeedingReauth.length > 0 && (
                <Badge
                  variant="destructive"
                  className="text-xs"
                  data-testid="badge-users-needing-reauth"
                >
                  <ShieldAlert className="h-3 w-3 mr-1" />{" "}
                  {usersNeedingReauth.length} need re-auth
                </Badge>
              )}
            </div>
            <div className="rounded border divide-y text-sm">
              {data.users.length === 0 && (
                <div
                  className="p-3 text-muted-foreground"
                  data-testid="text-no-webex-users"
                >
                  No users have connected Webex yet.
                </div>
              )}
              {data.users.map((u) => (
                <div
                  key={u.userId}
                  className="p-3 flex items-start justify-between gap-3"
                  data-testid={`row-webex-user-${u.userId}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">
                      {u.webexDisplayName || u.webexEmail || u.userId}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {u.webexEmail}
                    </div>
                    {u.lastRefreshError && (
                      <div
                        className="text-xs text-destructive mt-1 truncate"
                        title={u.lastRefreshError}
                      >
                        token refresh: {u.lastRefreshError}
                      </div>
                    )}
                    {u.missingScopes.length > 0 && (
                      <div
                        className="text-xs text-amber-600 dark:text-amber-400 mt-1"
                        data-testid={`text-missing-scopes-${u.userId}`}
                      >
                        missing: {u.missingScopes.length} scope(s)
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {u.needsReauth ? (
                      <Badge variant="destructive" className="text-xs">
                        needs re-auth
                      </Badge>
                    ) : u.scopeUpgradeAvailable ? (
                      <Badge variant="secondary" className="text-xs">
                        scope upgrade available
                      </Badge>
                    ) : (
                      <Badge
                        variant="default"
                        className="text-xs bg-emerald-600 hover:bg-emerald-700"
                      >
                        <CheckCircle2 className="h-3 w-3 mr-1" /> current
                      </Badge>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="text-[11px] text-muted-foreground"
                          data-testid={`text-last-refresh-${u.userId}`}
                        >
                          refreshed {formatRelative(u.lastRefreshAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Granted {u.grantedScopes.length} of{" "}
                        {data.requiredScopes.length} scopes (v{u.scopeVersion})
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Per-data-source sync state with backfill progress */}
          <section>
            <h3 className="text-sm font-medium mb-2">
              Sync state per data source (max backfill {data.maxBackfillDays}d)
            </h3>
            {data.syncState.length === 0 ? (
              <div
                className="text-sm text-muted-foreground"
                data-testid="text-no-sync-state"
              >
                No sync state recorded yet — connect a Webex account to seed it.
              </div>
            ) : (
              <div className="space-y-2">
                {data.syncState.map((s, idx) => {
                  const inProgress =
                    !!s.backfillStartedAt && !s.backfillCompletedAt;
                  const okRecent =
                    s.lastSuccessAt &&
                    (!s.lastError ||
                      (s.lastAttemptAt && s.lastSuccessAt > s.lastAttemptAt));
                  const key = `${s.dataSource}:${s.userId ?? "org"}:${idx}`;
                  return (
                    <div
                      key={key}
                      className="rounded border p-3 text-sm"
                      data-testid={`row-sync-${s.dataSource}-${s.userId ?? "org"}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex items-center gap-2">
                          <span className="font-mono text-xs">
                            {s.dataSource}
                          </span>
                          {s.userId && (
                            <Badge variant="outline" className="text-[10px]">
                              user {s.userId.slice(0, 8)}
                            </Badge>
                          )}
                          {inProgress ? (
                            <Badge variant="secondary" className="text-xs">
                              backfilling
                            </Badge>
                          ) : s.backfillCompletedAt ? (
                            <Badge
                              variant="default"
                              className="text-xs bg-emerald-600 hover:bg-emerald-700"
                            >
                              backfilled
                            </Badge>
                          ) : null}
                        </div>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatRelative(s.lastSuccessAt)}
                        </span>
                      </div>
                      {s.backfillTotalDays > 0 && (
                        <div className="mt-2">
                          <Progress
                            value={s.progressPct ?? 0}
                            className="h-2"
                            data-testid={`progress-backfill-${s.dataSource}`}
                          />
                          <div className="text-[11px] text-muted-foreground mt-1">
                            {s.backfillCompletedDays}/{s.backfillTotalDays}{" "}
                            days · {s.progressPct ?? 0}%
                          </div>
                        </div>
                      )}
                      {s.lastError && !okRecent && (
                        <div
                          className="text-xs text-destructive mt-1 truncate"
                          title={s.lastError}
                        >
                          {s.lastError}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {!activeBackfill && data.syncState.length > 0 && (
              <div className="text-xs text-muted-foreground mt-2">
                No backfill currently running. New connections automatically
                seed up to {data.maxBackfillDays} days.
              </div>
            )}
          </section>

          {/* Inventory snapshots */}
          {data.inventory.length > 0 && (
            <section>
              <h3 className="text-sm font-medium mb-2">
                Inventory snapshots
              </h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {data.inventory.map((i) => (
                  <div
                    key={i.kind}
                    className="rounded border p-3 text-sm"
                    data-testid={`row-inventory-${i.kind}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{i.kind}</span>
                      <Badge variant="secondary" className="text-xs">
                        {i.count}
                      </Badge>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      updated {formatRelative(i.lastUpdatedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Enrichment queue */}
          <section>
            <h3 className="text-sm font-medium mb-2">
              Detailed-call enrichment queue
            </h3>
            {enrichmentTotals.length === 0 ? (
              <div
                className="text-sm text-muted-foreground"
                data-testid="text-empty-enrichment-queue"
              >
                Queue is empty.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {enrichmentTotals.map(([status, count]) => (
                  <Badge
                    key={status}
                    variant={
                      status === "failed" || status === "dead_letter"
                        ? "destructive"
                        : status === "succeeded"
                          ? "default"
                          : "secondary"
                    }
                    className="text-xs"
                    data-testid={`badge-enrichment-${status}`}
                  >
                    {status}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          {/* Recent enrichment failures */}
          <section>
            <h3 className="text-sm font-medium mb-2 flex items-center gap-1">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Recent
              enrichment failures
              <span className="text-xs text-muted-foreground font-normal">
                (last 20)
              </span>
            </h3>
            {recentFailures.length === 0 ? (
              <div
                className="text-sm text-muted-foreground"
                data-testid="text-no-failures"
              >
                No recent enrichment failures.
              </div>
            ) : (
              <div className="rounded border divide-y text-xs max-h-72 overflow-y-auto">
                {recentFailures.map((f) => (
                  <div
                    key={f.callId}
                    className="p-2 flex items-start justify-between gap-2"
                    data-testid={`row-failure-${f.callId}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono truncate" title={f.callId}>
                        {f.callId}
                      </div>
                      {f.lastError && (
                        <div
                          className="text-muted-foreground truncate"
                          title={f.lastError}
                        >
                          {f.lastError}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end shrink-0">
                      <Badge variant="secondary" className="text-[10px]">
                        attempt {f.attempts}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {formatRelative(f.updatedAt)}
                      </span>
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
