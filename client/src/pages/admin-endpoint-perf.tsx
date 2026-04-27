/**
 * Task #705 — Endpoint Performance Budgets (admin).
 *
 * Single page that shows current p50/p95/p99 against the per-route
 * budget. Failing rows are highlighted so regressions are obvious.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert, CheckCircle2, AlertTriangle, Minus } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorBanner } from "@/components/ui/error-banner";

interface RouteRow {
  routeKey: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  budget: number | null;
  pass: boolean | null;
}

export default function AdminEndpointPerfPage() {
  const { user } = useAuth();
  const [days, setDays] = useState(7);
  const canView = user?.role === "admin";

  const { data, isLoading, isError, refetch } = useQuery<{ days: number; routes: RouteRow[] }>({
    queryKey: ["/api/admin/endpoint-perf/overview", { days }],
    queryFn: async () => {
      const r = await fetch(`/api/admin/endpoint-perf/overview?days=${days}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!canView,
    refetchInterval: 60_000,
  });

  if (!user) return <div className="p-8 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!canView) {
    return (
      <div className="p-8"><Card><CardContent className="p-8 text-center space-y-2">
        <ShieldAlert className="h-10 w-10 text-amber-500 mx-auto" />
        <p className="font-semibold">Restricted</p>
        <p className="text-sm text-muted-foreground">Performance budgets are admin-only.</p>
      </CardContent></Card></div>
    );
  }

  const routes = data?.routes ?? [];
  const failing = routes.filter((r) => r.pass === false);

  return (
    <div className="p-6 space-y-6" data-testid="page-endpoint-perf">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Endpoint performance</h1>
          <p className="text-sm text-muted-foreground">
            Per-route p95 latency vs. its budget. Use this to catch regressions before reps do.
          </p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[160px]" data-testid="select-window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 24 hours</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isError && <ErrorBanner message="Couldn't load performance data" onRetry={() => refetch()} />}

      {failing.length > 0 && (
        <Card className="border-red-500/40 bg-red-500/5">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" />
              {failing.length} {failing.length === 1 ? "route" : "routes"} over p95 budget
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Investigate before this lands in front of reps. Check cache hit rates, slow joins, or upstream APIs.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tracked routes</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground inline-block" /></div>
          ) : routes.length === 0 ? (
            <EmptyState title="No data yet" description="Once requests start hitting tracked routes, latency rolls up here." testId="empty-perf" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left py-2 pr-3">Route</th>
                    <th className="text-right py-2 px-3">Requests</th>
                    <th className="text-right py-2 px-3">Errors</th>
                    <th className="text-right py-2 px-3">p50 (ms)</th>
                    <th className="text-right py-2 px-3">p95 (ms)</th>
                    <th className="text-right py-2 px-3">p99 (ms)</th>
                    <th className="text-right py-2 px-3">Budget</th>
                    <th className="text-center py-2 pl-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r) => (
                    <tr key={r.routeKey} className={`border-b hover-elevate ${r.pass === false ? "bg-red-500/5" : ""}`} data-testid={`row-route-${r.routeKey.replace(/[^\w]/g, "_")}`}>
                      <td className="py-2 pr-3 font-mono text-xs">{r.routeKey}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{r.requests.toLocaleString()}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{r.errors > 0 ? <span className="text-red-600 dark:text-red-400">{r.errors}</span> : 0}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{r.p50}</td>
                      <td className="text-right py-2 px-3 tabular-nums font-medium">{r.p95}</td>
                      <td className="text-right py-2 px-3 tabular-nums">{r.p99}</td>
                      <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">{r.budget ?? "—"}</td>
                      <td className="text-center py-2 pl-3">
                        {r.pass === true && <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"><CheckCircle2 className="h-3 w-3 mr-1" />Pass</Badge>}
                        {r.pass === false && <Badge className="bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"><AlertTriangle className="h-3 w-3 mr-1" />Over</Badge>}
                        {r.pass === null && <Badge variant="outline"><Minus className="h-3 w-3" /></Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
