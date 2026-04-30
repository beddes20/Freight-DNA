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
import { Loader2, ShieldAlert, RefreshCw, CheckCircle2, AlertTriangle, HelpCircle, PowerOff, Mail, Beaker, DatabaseZap } from "lucide-react";
import { Link } from "wouter";
import { ErrorBanner } from "@/components/ui/error-banner";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface MailboxRow {
  id: string;
  email: string;
  userId: string;
  userName: string;
  enabled: boolean;
  syncStatus: string;
  syncError: string | null;
  subscriptionId: string | null;
  sentItemsSubscriptionId: string | null;
  subscriptionExpiresAt: string | null;
  lastSentItemsNotificationAt: string | null;
  lastOutboundCapturedAt: string | null;
  sentItemsHealth: {
    sentItemsHealth: "active" | "expired" | "missing" | "stale" | "unknown";
    reason: string;
  };
}

interface FixturePollutionScan {
  monitoredMailboxes: number;
  users: number;
  companies: number;
  contacts: number;
  scannedAt: string;
  samples: { table: string; column: string; email: string }[];
}

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

interface CallerCounter {
  live: number;
  coalesced: number;
  cacheHits: number;
  breakerSkipped: number;
  budgetSkipped: number;
  errors: number;
}

interface CallBudgetSnapshot {
  date: string;
  totals: CallerCounter;
  cacheHitRatio: number | null;
  byCaller: Record<string, CallerCounter>;
  unexpectedLiveCallers: string[];
  allowedLiveCallers: string[];
}

interface SonarCallBudget {
  today: CallBudgetSnapshot;
  yesterday: CallBudgetSnapshot | null;
}

function SonarCallBudgetBlock({ budget }: { budget: SonarCallBudget }) {
  const today = budget.today;
  const callerEntries = Object.entries(today.byCaller).sort(
    (a, b) => (b[1].live + b[1].coalesced) - (a[1].live + a[1].coalesced),
  );
  const ratioLabel = today.cacheHitRatio !== null
    ? `${(today.cacheHitRatio * 100).toFixed(1)}% cache`
    : "—";
  return (
    <div className="pt-2 border-t border-border space-y-2" data-testid="block-sonar-call-budget">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground font-medium">Call budget · {today.date}</span>
        <span className="tabular-nums" data-testid="text-sonar-calls-total">
          {today.totals.live} live / {today.totals.coalesced} coal / {today.totals.cacheHits} cache · <span data-testid="text-sonar-cache-hit-ratio">{ratioLabel}</span>
        </span>
      </div>
      {today.totals.breakerSkipped > 0 && (
        <div className="flex items-center justify-between text-red-600 dark:text-red-400">
          <span>Breaker-skipped</span>
          <span className="tabular-nums">{today.totals.breakerSkipped}</span>
        </div>
      )}
      {today.totals.budgetSkipped > 0 && (
        <div className="flex items-center justify-between text-amber-700 dark:text-amber-400" data-testid="row-sonar-budget-skipped">
          <span>Budget-skipped (non-allowed callers)</span>
          <span className="tabular-nums">{today.totals.budgetSkipped}</span>
        </div>
      )}
      {today.unexpectedLiveCallers.length > 0 && (
        <div
          className="text-[11px] rounded-sm bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300 px-2 py-1"
          data-testid="text-sonar-unexpected-callers"
        >
          ⚠ Unexpected live callers: {today.unexpectedLiveCallers.join(", ")}
        </div>
      )}
      {callerEntries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">No SONAR calls so far today.</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left font-normal">Caller</th>
              <th className="text-right font-normal">Live</th>
              <th className="text-right font-normal">Coal</th>
              <th className="text-right font-normal">Cache</th>
              <th className="text-right font-normal">Brk</th>
              <th className="text-right font-normal">Bdg</th>
              <th className="text-right font-normal">Err</th>
            </tr>
          </thead>
          <tbody>
            {callerEntries.map(([tag, c]) => {
              const isUnexpected = today.unexpectedLiveCallers.includes(tag);
              return (
                <tr key={tag} data-testid={`row-sonar-caller-${tag}`}>
                  <td
                    className={`py-0.5 truncate max-w-[140px] ${isUnexpected ? "text-red-600 dark:text-red-400 font-semibold" : ""}`}
                    title={tag}
                  >
                    {tag}{isUnexpected ? " ⚠" : ""}
                  </td>
                  <td className="text-right tabular-nums">{c.live}</td>
                  <td className="text-right tabular-nums text-muted-foreground">{c.coalesced}</td>
                  <td className="text-right tabular-nums text-muted-foreground">{c.cacheHits}</td>
                  <td className={`text-right tabular-nums ${c.breakerSkipped > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>{c.breakerSkipped}</td>
                  <td className={`text-right tabular-nums ${c.budgetSkipped > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>{c.budgetSkipped}</td>
                  <td className={`text-right tabular-nums ${c.errors > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>{c.errors}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {budget.yesterday && (
        <div className="text-[11px] text-muted-foreground pt-1">
          Yesterday ({budget.yesterday.date}): {budget.yesterday.totals.live} live ·{" "}
          {budget.yesterday.totals.coalesced} coalesced ·{" "}
          {budget.yesterday.totals.cacheHits} cache
          {budget.yesterday.cacheHitRatio !== null && (
            <span> · {(budget.yesterday.cacheHitRatio * 100).toFixed(1)}% hit</span>
          )}
          {budget.yesterday.unexpectedLiveCallers.length > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {" "}· ⚠ {budget.yesterday.unexpectedLiveCallers.length} unexpected
            </span>
          )}
        </div>
      )}
    </div>
  );
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

  // Per-mailbox visibility — re-uses the existing admin endpoint that already
  // returns SentItems health per row. Polls every 30s alongside the integration
  // probes so admins see the same freshness across the page.
  const mailboxesQuery = useQuery<{ mailboxes: MailboxRow[] }>({
    queryKey: ["/api/internal/admin/monitored-mailboxes"],
    queryFn: async () => {
      const r = await fetch("/api/internal/admin/monitored-mailboxes", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!canView,
    refetchInterval: 30_000,
  });

  const fixturePollutionQuery = useQuery<{ scan: FixturePollutionScan | null }>({
    queryKey: ["/api/admin/integrations/fixture-pollution"],
    queryFn: async () => {
      const r = await fetch("/api/admin/integrations/fixture-pollution", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    enabled: !!canView,
    refetchInterval: 5 * 60_000, // 5min — boot scan only changes on restart
  });

  const reregisterMutation = useMutation({
    mutationFn: async (mailboxId: string) => {
      const r = await apiRequest("POST", `/api/internal/admin/monitored-mailboxes/${mailboxId}/sync`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Subscription re-registered" });
      qc.invalidateQueries({ queryKey: ["/api/internal/admin/monitored-mailboxes"] });
    },
    onError: (err) => toast({
      title: "Re-register failed",
      description: err instanceof Error ? err.message : String(err),
      variant: "destructive",
    }),
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

      <FixturePollutionBanner scan={fixturePollutionQuery.data?.scan ?? null} />

      <LoadFactPipelineTile />

      <QuoteRequestLeakageTile />

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
                {s.source === "sonar" && s.detail && (s.detail as { callBudget?: SonarCallBudget }).callBudget && (
                  <SonarCallBudgetBlock budget={(s.detail as { callBudget: SonarCallBudget }).callBudget} />
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

      <MonitoredMailboxesSection
        mailboxes={mailboxesQuery.data?.mailboxes ?? []}
        isLoading={mailboxesQuery.isLoading}
        isError={mailboxesQuery.isError}
        onRetry={() => mailboxesQuery.refetch()}
        onReregister={(id) => reregisterMutation.mutate(id)}
        reregisteringId={reregisterMutation.isPending ? (reregisterMutation.variables as string | undefined) : undefined}
      />
    </div>
  );
}

function FixturePollutionBanner({ scan }: { scan: FixturePollutionScan | null }) {
  if (!scan) return null;
  const total = scan.users + scan.companies + scan.contacts;
  if (total === 0) return null;
  const breakdownParts: string[] = [];
  if (scan.users > 0) breakdownParts.push(`${scan.users} user${scan.users === 1 ? "" : "s"}`);
  if (scan.companies > 0) breakdownParts.push(`${scan.companies} compan${scan.companies === 1 ? "y" : "ies"}`);
  if (scan.contacts > 0) breakdownParts.push(`${scan.contacts} contact${scan.contacts === 1 ? "" : "s"}`);
  return (
    <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800" data-testid="banner-fixture-pollution">
      <CardContent className="p-4 flex items-start gap-3">
        <Beaker className="h-5 w-5 text-amber-700 dark:text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="space-y-1 text-sm">
          <div className="font-medium text-amber-900 dark:text-amber-200">
            Fixture-style addresses detected in production tables
          </div>
          <div className="text-amber-800 dark:text-amber-300">
            Found <span className="tabular-nums font-medium">{breakdownParts.join(", ")}</span> using
            non-routable domains (example.com / .test / .invalid / .localhost / test.local).
            New fixture rows are blocked, but these existing rows should be reviewed and removed if
            they aren't intentional. Last scanned {fmtAgo(scan.scannedAt)}.
          </div>
          {scan.samples.length > 0 && (
            <details className="text-xs text-amber-700 dark:text-amber-400 mt-2">
              <summary className="cursor-pointer">Show samples ({scan.samples.length})</summary>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                {scan.samples.map((s, i) => (
                  <li key={i} data-testid={`text-fixture-sample-${i}`}>
                    <code>{s.table}.{s.column}</code> = {s.email}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function MonitoredMailboxesSection({
  mailboxes,
  isLoading,
  isError,
  onRetry,
  onReregister,
  reregisteringId,
}: {
  mailboxes: MailboxRow[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onReregister: (id: string) => void;
  reregisteringId: string | undefined;
}) {
  return (
    <Card data-testid="card-monitored-mailboxes">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Monitored mailboxes
          {mailboxes.length > 0 && (
            <Badge variant="outline" className="text-[10px]">{mailboxes.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {isError ? (
          <div className="p-4">
            <ErrorBanner message="Couldn't load monitored mailboxes" onRetry={onRetry} />
          </div>
        ) : isLoading && mailboxes.length === 0 ? (
          <div className="p-6 text-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground inline-block" /></div>
        ) : mailboxes.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No monitored mailboxes registered.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-left p-2 font-medium">Mailbox</th>
                  <th className="text-left p-2 font-medium">User</th>
                  <th className="text-left p-2 font-medium">Subscription</th>
                  <th className="text-left p-2 font-medium">SentItems</th>
                  <th className="text-left p-2 font-medium">Expires</th>
                  <th className="text-left p-2 font-medium">Last outbound</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((m) => {
                  const sentHealth = m.sentItemsHealth?.sentItemsHealth ?? "unknown";
                  return (
                    <tr key={m.id} className="border-t" data-testid={`row-mailbox-${m.id}`}>
                      <td className="p-2 font-mono">{m.email}</td>
                      <td className="p-2">{m.userName}</td>
                      <td className="p-2">
                        <Badge
                          variant={m.syncStatus === "active" ? "default" : "outline"}
                          className="text-[10px]"
                        >
                          {m.syncStatus}
                        </Badge>
                      </td>
                      <td className="p-2">
                        <SentItemsHealthBadge state={sentHealth} reason={m.sentItemsHealth?.reason} />
                      </td>
                      <td className="p-2 tabular-nums">{fmtAgo(m.subscriptionExpiresAt)}</td>
                      <td className="p-2 tabular-nums">{fmtAgo(m.lastOutboundCapturedAt)}</td>
                      <td className="p-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onReregister(m.id)}
                          disabled={reregisteringId === m.id}
                          data-testid={`button-reregister-${m.id}`}
                        >
                          {reregisteringId === m.id ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          ) : (
                            <RefreshCw className="h-3 w-3 mr-1" />
                          )}
                          Re-register
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SentItemsHealthBadge({ state, reason }: { state: string; reason?: string }) {
  const map: Record<string, { label: string; className: string }> = {
    active:  { label: "Active",  className: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800" },
    expired: { label: "Expired", className: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800" },
    missing: { label: "Missing", className: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950 dark:text-red-300 dark:border-red-800" },
    stale:   { label: "Stale",   className: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800" },
    unknown: { label: "Unknown", className: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-700" },
  };
  const cfg = map[state] ?? map.unknown;
  return (
    <Badge variant="outline" className={`text-[10px] ${cfg.className}`} title={reason}>
      {cfg.label}
    </Badge>
  );
}

interface PipelineHealth {
  urlConfigured: boolean;
  credentialsPresent: boolean;
  scheduleEnabled: boolean;
  lastImportAt: string | null;
  lastImportRowCount: number;
  currentRowCount: number;
}

/**
 * Load Fact pipeline tile — surfaces *why* the carrier-intelligence pages
 * may be empty. The honesty cases (in priority order):
 *   1. URL not configured   → yellow banner with link to Load Fact admin.
 *   2. Azure creds missing  → yellow banner naming the missing env vars.
 *   3. Schedule paused/off  → yellow banner.
 *   4. Configured + healthy → green tile with last-import metadata.
 * Without this tile an admin had no way to tell whether a quiet day was
 * "real" or "the pipeline silently never ran".
 */
function LoadFactPipelineTile() {
  const { data, isLoading, isError, refetch } = useQuery<PipelineHealth>({
    queryKey: ["/api/admin/load-fact/pipeline-health"],
    queryFn: async () => {
      const r = await fetch("/api/admin/load-fact/pipeline-health", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <Card data-testid="card-load-fact-pipeline">
        <CardContent className="p-6 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground inline-block" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card data-testid="card-load-fact-pipeline" className="border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800">
        <CardContent className="p-4 text-sm">
          <span className="text-amber-700 dark:text-amber-300">Couldn't read Load Fact pipeline status.</span>
          <Button size="sm" variant="outline" className="ml-3" onClick={() => refetch()} data-testid="button-retry-pipeline-health">Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const lastImportLabel = data.lastImportAt ? fmtAgo(data.lastImportAt) : "never";
  const cause: { tone: "yellow" | "green"; title: string; body: string; cta?: { label: string; href: string } } =
    !data.urlConfigured
      ? {
          tone: "yellow",
          title: "Load Fact pipeline — not configured",
          body: "No source URL has been set, so scheduled imports skip every tick. Carrier scorecards, available loads, and lane pricing will stay empty until the URL is provided.",
          cta: { label: "Configure source URL", href: "/admin/load-fact" },
        }
      : !data.credentialsPresent
      ? {
          tone: "yellow",
          title: "Load Fact pipeline — Azure credentials missing",
          body: "OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID, and OUTLOOK_CLIENT_SECRET must all be set so the importer can fetch the workbook from OneDrive/Graph.",
        }
      : !data.scheduleEnabled
      ? {
          tone: "yellow",
          title: "Load Fact pipeline — schedule paused",
          body: `Source URL is set but the cron schedule is off. Last import: ${lastImportLabel} (${data.lastImportRowCount.toLocaleString()} rows).`,
          cta: { label: "Open Load Fact admin", href: "/admin/load-fact" },
        }
      : {
          tone: "green",
          title: "Load Fact pipeline — healthy",
          body: `Last import: ${lastImportLabel} (${data.lastImportRowCount.toLocaleString()} rows). Currently ${data.currentRowCount.toLocaleString()} rows in load_fact.`,
        };

  const tone = cause.tone === "yellow"
    ? "border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800"
    : "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800";
  const Icon = cause.tone === "yellow" ? AlertTriangle : CheckCircle2;
  const iconTone = cause.tone === "yellow" ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";

  return (
    <Card className={tone} data-testid="card-load-fact-pipeline">
      <CardContent className="p-4 flex items-start gap-3">
        <DatabaseZap className={`h-5 w-5 mt-0.5 ${iconTone}`} />
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm" data-testid="text-pipeline-status-title">{cause.title}</span>
            <Icon className={`h-3.5 w-3.5 ${iconTone}`} />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="text-pipeline-status-body">{cause.body}</p>
          {cause.cta && (
            <div className="pt-1">
              <Button asChild size="sm" variant="outline" data-testid="button-pipeline-cta">
                <Link href={cause.cta.href}>{cause.cta.label}</Link>
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Phase 2a — Quote-Request Leakage tile ──────────────────────────────
//
// Read-only diagnostic that surfaces how many inbound customer
// pricing_request / quote_request signals failed to materialize a
// tracked quote_opportunities row (and weren't acknowledged via
// capture_leak_reviews either).
//
// Categorization is mutually exclusive with priority:
//   1. withOpportunity  — signal links to an opp (direct or via source_reference)
//   2. inLeakQueue      — capture_leak_reviews row exists for the message
//   3. leaked           — neither — silent leak
//
// This tile drives no automation. It exists so we can watch the leakage
// rate for a few normal business days before turning on Phase 2b
// (forward closure).

interface LeakageWindowStats {
  windowLabel: string;
  windowStart: string;
  totalSignals: number;
  withOpportunity: number;
  inLeakQueue: number;
  leaked: number;
  leakRate: number;
}

interface LeakageDomainBreakdown {
  domain: string;
  totalSignals: number;
  leakedSignals: number;
  leakRate: number;
}

interface LeakageStatsResponse {
  generatedAt: string;
  organizationId: string;
  windows: { last24h: LeakageWindowStats; last7d: LeakageWindowStats };
  topLeakingDomains: LeakageDomainBreakdown[];
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function leakRateTone(rate: number): string {
  if (rate >= 0.5) return "text-red-700 dark:text-red-400";
  if (rate >= 0.2) return "text-amber-700 dark:text-amber-400";
  return "text-emerald-700 dark:text-emerald-400";
}

function LeakageWindowCard({ stats }: { stats: LeakageWindowStats }) {
  const tone = leakRateTone(stats.leakRate);
  const testIdSlug = stats.windowLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className="border border-border rounded-md p-3 space-y-2" data-testid={`leakage-window-${testIdSlug}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{stats.windowLabel}</span>
        <span className={`text-lg font-semibold tabular-nums ${tone}`} data-testid={`text-leak-rate-${testIdSlug}`}>
          {stats.totalSignals === 0 ? "—" : pct(stats.leakRate)}
        </span>
      </div>
      {stats.totalSignals === 0 ? (
        <p className="text-xs text-muted-foreground italic">No quote-request signals in this window.</p>
      ) : (
        <div className="grid grid-cols-4 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Total</div>
            <div className="tabular-nums font-medium" data-testid={`text-total-${testIdSlug}`}>{stats.totalSignals}</div>
          </div>
          <div>
            <div className="text-muted-foreground">With opp</div>
            <div className="tabular-nums font-medium text-emerald-700 dark:text-emerald-400" data-testid={`text-with-opp-${testIdSlug}`}>{stats.withOpportunity}</div>
          </div>
          <div>
            <div className="text-muted-foreground">In queue</div>
            <div className="tabular-nums font-medium text-slate-700 dark:text-slate-300" data-testid={`text-in-queue-${testIdSlug}`}>{stats.inLeakQueue}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Leaked</div>
            <div className={`tabular-nums font-medium ${tone}`} data-testid={`text-leaked-${testIdSlug}`}>{stats.leaked}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuoteRequestLeakageTile() {
  const { data, isLoading, isError, refetch } = useQuery<LeakageStatsResponse>({
    queryKey: ["/api/admin/conversations/leakage-stats"],
    queryFn: async () => {
      const r = await fetch("/api/admin/conversations/leakage-stats", { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 60_000,
  });

  if (isLoading && !data) {
    return (
      <Card data-testid="card-quote-request-leakage">
        <CardContent className="p-6 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground inline-block" />
        </CardContent>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card data-testid="card-quote-request-leakage" className="border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800">
        <CardContent className="p-4 text-sm">
          <span className="text-amber-700 dark:text-amber-300">Couldn't read quote-request leakage stats.</span>
          <Button size="sm" variant="outline" className="ml-3" onClick={() => refetch()} data-testid="button-retry-leakage">Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const overallTone = leakRateTone(data.windows.last7d.leakRate);

  return (
    <Card data-testid="card-quote-request-leakage">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Quote-request leakage
          <Badge variant="outline" className={`text-[10px] ${overallTone}`} data-testid="badge-leakage-overall-rate">
            {data.windows.last7d.totalSignals === 0 ? "no data" : `${pct(data.windows.last7d.leakRate)} 7d`}
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Inbound customer "pricing_request" / "quote_request" signals that never produced a tracked
          quote_opportunity row and weren't acknowledged in the leak queue. Read-only — no automation
          changes anything based on these counts. Phase 2b (forward closure) will use these numbers to
          decide thresholds before turning on auto-create / auto-attach.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <LeakageWindowCard stats={data.windows.last24h} />
          <LeakageWindowCard stats={data.windows.last7d} />
        </div>

        {data.topLeakingDomains.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Top leaking sender domains (last 7d)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="text-left p-2 font-medium">Domain</th>
                    <th className="text-right p-2 font-medium">Total signals</th>
                    <th className="text-right p-2 font-medium">Leaked</th>
                    <th className="text-right p-2 font-medium">Leak rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topLeakingDomains.map((d) => (
                    <tr key={d.domain} className="border-t" data-testid={`row-leaking-domain-${d.domain}`}>
                      <td className="p-2 font-mono">{d.domain}</td>
                      <td className="p-2 text-right tabular-nums">{d.totalSignals}</td>
                      <td className="p-2 text-right tabular-nums">{d.leakedSignals}</td>
                      <td className={`p-2 text-right tabular-nums font-medium ${leakRateTone(d.leakRate)}`}>{pct(d.leakRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Generated {fmtAgo(data.generatedAt)} · refreshes every 60s
        </p>
      </CardContent>
    </Card>
  );
}
