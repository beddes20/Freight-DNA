/**
 * Task #701 — Integrations Health Console (admin).
 *
 * One card per external integration with current state, last success / last
 * error, breaker state, and a "test now" button that re-probes the source.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert, RefreshCw, CheckCircle2, AlertTriangle, HelpCircle, PowerOff } from "lucide-react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Snapshot {
  source: string;
  connected: boolean;
  healthState: "healthy" | "degraded" | "unknown" | "disabled";
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  breakerState: "closed" | "open" | "half_open" | null;
  detail: Record<string, unknown> | null;
}

const SOURCE_LABEL: Record<string, string> = {
  sonar: "FreightWaves SONAR",
  graph: "Microsoft Graph (Outlook)",
  webex: "Webex Calling",
  zoominfo: "ZoomInfo",
  onedrive: "OneDrive",
  trac: "FreightWaves TRAC",
  stripe: "Stripe",
};

function StateBadge({ state }: { state: Snapshot["healthState"] }) {
  if (state === "healthy") {
    return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 gap-1"><CheckCircle2 className="h-3 w-3" />Healthy</Badge>;
  }
  if (state === "degraded") {
    return <Badge className="bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30 gap-1"><AlertTriangle className="h-3 w-3" />Degraded</Badge>;
  }
  if (state === "disabled") {
    return <Badge variant="outline" className="gap-1"><PowerOff className="h-3 w-3" />Disabled</Badge>;
  }
  return <Badge variant="outline" className="gap-1"><HelpCircle className="h-3 w-3" />Unknown</Badge>;
}

function fmtAgo(ts: string | null): string {
  if (!ts) return "never";
  const ms = Date.now() - new Date(ts).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function AdminIntegrationsHealthPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canView = user?.role === "admin";

  const { data, isLoading, isError, refetch } = useQuery<{ snapshots: Snapshot[] }>({
    queryKey: ["/api/admin/integrations/health"],
    queryFn: async () => {
      const r = await fetch("/api/admin/integrations/health", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!canView,
    refetchInterval: 30_000,
  });

  const testMutation = useMutation({
    mutationFn: async (source: string) => {
      const r = await apiRequest("POST", `/api/admin/integrations/health/${source}/test`);
      return r.json();
    },
    onSuccess: (snap: Snapshot) => {
      toast({
        title: `Tested ${SOURCE_LABEL[snap.source] ?? snap.source}`,
        description: snap.healthState === "healthy" ? "Probe succeeded." : `State: ${snap.healthState}`,
        variant: snap.healthState === "degraded" ? "destructive" : "default",
      });
      qc.invalidateQueries({ queryKey: ["/api/admin/integrations/health"] });
    },
    onError: () => toast({ title: "Probe failed", variant: "destructive" }),
  });

  if (!user) {
    return <div className="p-8 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (!canView) {
    return (
      <div className="p-8">
        <Card><CardContent className="p-8 text-center space-y-2">
          <ShieldAlert className="h-10 w-10 text-amber-500 mx-auto" />
          <p className="font-semibold">Restricted</p>
          <p className="text-sm text-muted-foreground">Integration health is admin-only.</p>
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="page-integrations-health">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Integrations health</h1>
          <p className="text-sm text-muted-foreground">Live status of every external system FreightDNA depends on.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-all">
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isError && (
        <ErrorBanner message="Couldn't load integration health" onRetry={() => refetch()} />
      )}

      {isLoading && !data ? (
        <Card><CardContent className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground inline-block" /></CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {(data?.snapshots ?? []).map((s) => (
            <Card key={s.source} data-testid={`card-source-${s.source}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center justify-between gap-2">
                  <span>{SOURCE_LABEL[s.source] ?? s.source}</span>
                  <StateBadge state={s.healthState} />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last success</span>
                  <span className="tabular-nums">{fmtAgo(s.lastSuccessAt)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Last error</span>
                  <span className="tabular-nums">{fmtAgo(s.lastErrorAt)}</span>
                </div>
                {s.breakerState && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Circuit breaker</span>
                    <Badge variant="outline" className="text-[10px]">{s.breakerState}</Badge>
                  </div>
                )}
                {s.lastErrorMessage && (
                  <p className="text-red-600 dark:text-red-400 break-words" data-testid={`text-error-${s.source}`}>
                    {s.lastErrorMessage}
                  </p>
                )}
                <div className="pt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testMutation.mutate(s.source)}
                    disabled={testMutation.isPending}
                    data-testid={`button-test-${s.source}`}
                    className="w-full"
                  >
                    {testMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-2" /> : <RefreshCw className="h-3 w-3 mr-2" />}
                    Test now
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
