/**
 * AI Center — unified admin/manager surface for every AI capability in FreightDNA.
 *
 * Replaces the previous four parallel sidebar entries (AI Agent / Agent Fleet /
 * Approvals / Pods) with one tabbed module. Each tab renders the existing
 * page-component as its body so behavior is preserved and there is no data
 * duplication. URL drives the active tab so deep links and back-navigation work.
 *
 * Routes mounted in App.tsx:
 *   /ai                 → Fleet (default)
 *   /ai/agents          → Fleet
 *   /ai/agents/:slug    → Workflow agent cockpit (existing AgentDetailPage)
 *   /ai/approvals       → HITL inbox
 *   /ai/pods            → Pods
 *   /ai/adapters        → Adapter status / dry-run vs live
 *   /ai/admin           → Legacy AiAgentPortal (personas, plays, permissions, activity)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { recordAiEvent } from "@/lib/aiTelemetry";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Bot, Inbox, Users, Plug, Settings as SettingsIcon, Sparkles, ArrowRight, ShieldAlert } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Agent, WorkflowAgent } from "@shared/schema";

interface AdapterRow {
  key: string;
  label: string;
  mode: "dry_run" | "live";
  credentialsConfigured: boolean;
  lastCheckedAt: string | null;
  notes: string | null;
  updatedAt: string | null;
}

import AgentDetailPage from "./agentic/agent-detail";
import ApprovalsPage from "./agentic/approvals";
import PodsPage from "./agentic/pods";
import AiAgentPortal from "./ai-agent";

const AUTONOMY_COLOR: Record<string, string> = {
  off: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  suggest: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200",
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  auto_hitl: "bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  auto: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
};

const TAB_ORDER = ["agents", "approvals", "pods", "adapters", "admin"] as const;
type TabKey = typeof TAB_ORDER[number];

function tabFromPath(path: string): TabKey {
  if (path.startsWith("/ai/approvals")) return "approvals";
  if (path.startsWith("/ai/pods")) return "pods";
  if (path.startsWith("/ai/adapters")) return "adapters";
  if (path.startsWith("/ai/admin")) return "admin";
  return "agents";
}

// ─── Fleet tab ───────────────────────────────────────────────────────────
type ImplementationStatus = "live_logic" | "stub";
type WorkflowAgentWithStatus = WorkflowAgent & { implementationStatus: ImplementationStatus };

function FleetTab() {
  const { data, isLoading } = useQuery<{
    callable: Agent[];
    workflow: WorkflowAgentWithStatus[];
    stats: { byAgent: Record<string, Record<string, number>> };
    summary: {
      callableCount: number;
      workflowCount: number;
      enabledWorkflowCount: number;
      stubWorkflowCount?: number;
      autonomyMix: Record<string, number>;
    };
  }>({
    queryKey: ["/api/ai-center/fleet"],
  });

  // Honesty banner — dismissed state persisted so users only see it once
  // until a new round of agents flips back to stub. Stored in localStorage
  // because this is a UI-only preference, not a server-tracked acknowledgement.
  const [previewAck, setPreviewAck] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("aiCenterPreviewAck") === "true";
  });
  const dismissPreviewBanner = () => {
    setPreviewAck(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aiCenterPreviewAck", "true");
    }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground" data-testid="text-fleet-loading">Loading agent fleet…</div>;

  const callable = data?.callable ?? [];
  const workflow = data?.workflow ?? [];
  const stubCount = data?.summary.stubWorkflowCount ?? workflow.filter(w => w.implementationStatus === "stub").length;
  const totalCount = workflow.length;

  return (
    <div className="space-y-8" data-testid="tab-fleet">
      {/* ── Honesty banner ────────────────────────────────────────────────
          Surfaces the gap between "agent shown in UI" and "agent actually
          executes against real systems". Dismissible because once a manager
          has read this, repeating it on every visit becomes noise. */}
      {!previewAck && stubCount > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100 flex items-start gap-3"
          data-testid="banner-fleet-preview"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-medium">
              {stubCount} of {totalCount} agents in preview.
            </p>
            <p className="text-xs mt-0.5 text-amber-800/90 dark:text-amber-100/80">
              Approved actions are recorded but do not execute against real systems yet.
              See the Adapters tab for connection status.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={dismissPreviewBanner}
            data-testid="button-fleet-preview-dismiss"
          >
            Got it
          </Button>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card data-testid="stat-callable-count">
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Callable agents</div>
            <div className="text-2xl font-semibold">{data?.summary.callableCount ?? 0}</div>
            <div className="text-xs text-muted-foreground mt-1">Chat / DNA / ValueIQ</div>
          </CardContent>
        </Card>
        <Card data-testid="stat-workflow-count">
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Workflow agents</div>
            <div className="text-2xl font-semibold">{data?.summary.workflowCount ?? 0}</div>
            <div className="text-xs text-muted-foreground mt-1">Outcome-owning bots</div>
          </CardContent>
        </Card>
        <Card data-testid="stat-workflow-enabled">
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Enabled (workflow)</div>
            <div className="text-2xl font-semibold">{data?.summary.enabledWorkflowCount ?? 0}</div>
            <div className="text-xs text-muted-foreground mt-1">of {data?.summary.workflowCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card data-testid="stat-autonomy-mix">
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Autonomy mix</div>
            <div className="text-sm mt-2 space-y-0.5">
              {Object.entries(data?.summary.autonomyMix ?? {}).map(([k, v]) => (
                <div key={k} className="flex justify-between"><span className="text-muted-foreground">{k}</span><span>{v}</span></div>
              ))}
              {Object.keys(data?.summary.autonomyMix ?? {}).length === 0 && (
                <div className="text-muted-foreground">—</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Workflow agents */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Bot className="h-5 w-5" /> Workflow agents
          </h2>
          <p className="text-xs text-muted-foreground">Sense → plan → draft → act, with autonomy and HITL.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {workflow.map((a) => {
            const s = data?.stats?.byAgent?.[a.id] ?? {};
            const pending = (s as any).pending ?? 0;
            const isStub = a.implementationStatus === "stub";
            return (
              <Card key={a.id} data-testid={`card-workflow-${a.slug}`} className="hover-elevate">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        {a.name}
                        {a.killSwitch && <ShieldAlert className="h-4 w-4 text-red-500" />}
                      </CardTitle>
                      <div className="text-xs text-muted-foreground mt-1">Loop: {a.loop}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="outline" className="text-xs">workflow</Badge>
                      <Badge className={AUTONOMY_COLOR[a.autonomy] ?? ""} data-testid={`badge-autonomy-${a.slug}`}>
                        {a.autonomy}
                      </Badge>
                      {/* Honesty badge: green = real domain logic; amber = canned mock data.
                          Distinct from autonomy (which only describes execution policy). */}
                      <Badge
                        className={
                          isStub
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                            : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                        }
                        data-testid={`badge-implementation-${a.slug}`}
                      >
                        {isStub ? "Preview / mock data" : "Live logic"}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground line-clamp-3">{a.description}</p>
                  {isStub && (
                    <p
                      className="text-[11px] text-amber-700 dark:text-amber-300 leading-snug"
                      data-testid={`text-stub-microcopy-${a.slug}`}
                    >
                      Outputs are deterministic mock data until adapters are wired.
                      Approvals are recorded but no external calls fire.
                    </p>
                  )}
                  <div className="flex items-center gap-3 text-xs">
                    <span className={a.enabled ? "text-emerald-600" : "text-muted-foreground"}>
                      {a.enabled ? "Enabled" : "Disabled"}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span data-testid={`text-pending-${a.slug}`}>{pending} pending</span>
                  </div>
                  <Link href={`/ai/agents/${a.slug}`}>
                    <Button variant="ghost" size="sm" className="w-full justify-between" data-testid={`link-workflow-${a.slug}`}>
                      Open cockpit <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Callable agents */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> Callable agents
          </h2>
          <p className="text-xs text-muted-foreground">Chat-based agents (DNA, ValueIQ). Manage personas, plays, permissions in Admin.</p>
        </div>
        {callable.length === 0 ? (
          <Card><CardContent className="pt-6 text-sm text-muted-foreground" data-testid="text-callable-empty">No callable agents configured yet.</CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {callable.map((a) => (
              <Card key={a.id} data-testid={`card-callable-${a.slug}`} className="hover-elevate">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{a.name}</CardTitle>
                      <div className="text-xs text-muted-foreground mt-1">slug: {a.slug}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="outline" className="text-xs">callable</Badge>
                      {a.isDefault && <Badge variant="secondary" className="text-xs">default</Badge>}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground line-clamp-3">{a.description ?? "—"}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>Status: {a.status}</span>
                    <span>·</span>
                    <span>Access: {a.accessScope}</span>
                  </div>
                  <Link href="/ai/admin#agents">
                    <Button variant="ghost" size="sm" className="w-full justify-between" data-testid={`link-callable-${a.slug}`}>
                      Manage in Admin <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Adapters tab ────────────────────────────────────────────────────────
function AdaptersTab() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ adapters: AdapterRow[] }>({ queryKey: ["/api/agentic/adapters"] });

  const toggleMode = useMutation({
    mutationFn: (args: { adapterKey: string; mode: "dry_run" | "live" }) =>
      apiRequest("PATCH", `/api/agentic/adapters/${args.adapterKey}`, { mode: args.mode }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/adapters"] });
      toast({ title: "Adapter updated" });
    },
    onError: (e: any) => toast({ title: "Update failed", description: String(e?.message ?? e), variant: "destructive" }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground" data-testid="text-adapters-loading">Loading adapters…</div>;

  const rows = data?.adapters ?? [];

  return (
    <div className="space-y-4" data-testid="tab-adapters">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Plug className="h-4 w-4" /> Adapter rollout</CardTitle>
          <CardDescription>
            Each integration starts in <strong>dry-run</strong> — the agent records what it would have done, but no external call is made.
            Flip to <strong>live</strong> once credentials are configured and you have observed dry-run behavior.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="text-adapters-empty">
              No adapters have been touched yet. They appear here once a workflow agent first calls them.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-4">Adapter</th>
                    <th className="py-2 pr-4">Mode</th>
                    <th className="py-2 pr-4">Credentials</th>
                    <th className="py-2 pr-4">Last checked</th>
                    <th className="py-2 pr-4">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className="border-b last:border-0" data-testid={`row-adapter-${r.key}`}>
                      <td className="py-2 pr-4 font-medium">
                        <div>{r.label}</div>
                        <div className="text-xs text-muted-foreground">{r.key}</div>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={r.mode === "live"}
                            disabled={toggleMode.isPending}
                            onCheckedChange={(v) => toggleMode.mutate({ adapterKey: r.key, mode: v ? "live" : "dry_run" })}
                            data-testid={`switch-adapter-mode-${r.key}`}
                          />
                          <Badge variant={r.mode === "live" ? "default" : "secondary"}>{r.mode}</Badge>
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        {r.credentialsConfigured
                          ? <Badge variant="default" className="bg-emerald-600">configured</Badge>
                          : <Badge variant="outline">missing</Badge>}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">
                        {r.lastCheckedAt ? new Date(r.lastCheckedAt).toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">{r.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <ZoomInfoConnectionTest />
    </div>
  );
}

interface ZoomInfoTestResult {
  ok: boolean;
  reason?: string;
  missing?: string[];
  httpStatus?: number;
  httpStatusText?: string;
  elapsedMs?: number;
  clientIdTail?: string;
  secretTail?: string;
  errorCode?: string | null;
  errorDescription?: string | null;
  rawBody?: string;
  parsed?: unknown;
  endpoint?: string;
  sentContentType?: string;
  grantType?: string;
  error?: string;
}

function ZoomInfoConnectionTest() {
  const { toast } = useToast();
  const [result, setResult] = useState<ZoomInfoTestResult | null>(null);
  const test = useMutation({
    mutationFn: () => apiRequest("POST", "/api/zoominfo/test-auth", {}).then(r => r.json()),
    onSuccess: (data: ZoomInfoTestResult) => {
      setResult(data);
      if (data.ok) toast({ title: "ZoomInfo auth succeeded" });
      else toast({ title: "ZoomInfo auth failed", description: data.errorCode ?? data.reason ?? `HTTP ${data.httpStatus ?? "?"}`, variant: "destructive" });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ ok: false, reason: "request_error", error: msg });
      toast({ title: "Test failed", description: msg, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-zoominfo-test">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Plug className="h-4 w-4" /> ZoomInfo connection test</CardTitle>
        <CardDescription>
          Sends a real <code>client_credentials</code> request to <code>https://api.zoominfo.com/oauth/token</code> and shows the full response.
          Use this after rotating your Client Secret to confirm the new value works. The secret itself is never returned — only its last 4 characters.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          onClick={() => test.mutate()}
          disabled={test.isPending}
          data-testid="button-zoominfo-test"
        >
          {test.isPending ? "Testing…" : "Test ZoomInfo connection"}
        </Button>
        {result && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-2" data-testid="text-zoominfo-test-result">
            <div className="flex items-center gap-2">
              <Badge variant={result.ok ? "default" : "destructive"}>
                {result.ok ? "OK" : (result.reason ?? "FAILED")}
              </Badge>
              {result.httpStatus !== undefined && (
                <span className="text-muted-foreground">HTTP {result.httpStatus} {result.httpStatusText ?? ""}</span>
              )}
              {result.elapsedMs !== undefined && (
                <span className="text-muted-foreground">{result.elapsedMs} ms</span>
              )}
            </div>
            {(result.clientIdTail || result.secretTail) && (
              <div className="text-muted-foreground">
                client_id …{result.clientIdTail} / secret …{result.secretTail}
              </div>
            )}
            {result.errorCode && (
              <div>
                <span className="font-medium">error: </span>
                <code>{result.errorCode}</code>
                {result.errorDescription && <span> — {result.errorDescription}</span>}
              </div>
            )}
            {result.missing && result.missing.length > 0 && (
              <div>Missing env vars: {result.missing.join(", ")}</div>
            )}
            {result.rawBody && (
              <details>
                <summary className="cursor-pointer text-muted-foreground">Full response body</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all bg-background border rounded p-2 max-h-64 overflow-auto">{result.rawBody}</pre>
              </details>
            )}
            {result.error && <div className="text-destructive">{result.error}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Shell ───────────────────────────────────────────────────────────────
export default function AiCenterPage() {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  const [matchAgentDetail, agentDetailParams] = useRoute("/ai/agents/:slug");

  const activeTab = useMemo<TabKey>(() => tabFromPath(location), [location]);

  // Honesty redirect: on an admin's *first ever* visit to /ai (the bare
  // root that resolves to Fleet by default), bounce them to the Adapters
  // tab so they immediately see which integrations are wired up before
  // they look at the agent fleet. The flag is one-shot — subsequent
  // visits to /ai keep the existing Fleet default. Stored in localStorage
  // because this is a UI hint, not a server-side preference.
  const isAdminUser = user?.role === "admin";
  useEffect(() => {
    if (!isAdminUser) return;
    if (location !== "/ai" && location !== "/ai/agents") return;
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("aiCenterFirstVisitAck") === "true") return;
    window.localStorage.setItem("aiCenterFirstVisitAck", "true");
    setLocation("/ai/adapters");
    // Eslint-disable: this effect should fire exactly once per page mount
    // for the first-visit case; we deliberately exclude `setLocation` from
    // deps because changing the location mid-effect would re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdminUser, location]);

  // Task #700 — surface impression on mount; click event whenever the user
  // changes tabs *after* mount (we use a first-render ref so the impression
  // event isn't double-counted as a click on initial load — that would
  // inflate CTR in the AI Engagement console).
  const firstAiCenterRender = useRef(true);
  useEffect(() => {
    recordAiEvent({ surface: "ai_center", eventType: "impression", feature: activeTab });
  }, []);
  useEffect(() => {
    if (firstAiCenterRender.current) {
      firstAiCenterRender.current = false;
      return;
    }
    recordAiEvent({ surface: "ai_center", eventType: "click", feature: activeTab });
  }, [activeTab]);

  const isAdmin = user?.role === "admin";
  const canSeeAi = ["admin", "manager", "director", "national_account_manager", "sales_director"].includes(user?.role ?? "");

  if (!canSeeAi) {
    return (
      <div className="container mx-auto py-10" data-testid="ai-center-forbidden">
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">
          The AI Center is only available to admins and managers. If you need access, ask your administrator.
        </CardContent></Card>
      </div>
    );
  }

  // Tab body. For agent detail (`/ai/agents/:slug`), render the existing detail
  // component (it reads its own slug from the URL).
  let body: React.ReactNode;
  if (matchAgentDetail) {
    body = <AgentDetailPage />;
  } else if (activeTab === "approvals") {
    body = <ApprovalsPage />;
  } else if (activeTab === "pods") {
    body = <PodsPage />;
  } else if (activeTab === "adapters") {
    body = <AdaptersTab />;
  } else if (activeTab === "admin") {
    body = <AiAgentPortal />;
  } else {
    body = <FleetTab />;
  }

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-ai-center">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-ai-center-title">
            <Sparkles className="h-6 w-6" /> AI Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            One place to manage every AI capability — chat agents, workflow agents, approvals, pods, and adapters.
          </p>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={(v) => setLocation(`/ai/${v === "agents" ? "agents" : v}`)}>
        <TabsList data-testid="ai-center-tabs">
          <TabsTrigger value="agents" data-testid="tab-trigger-agents"><Bot className="h-4 w-4 mr-1.5" /> Agents</TabsTrigger>
          <TabsTrigger value="approvals" data-testid="tab-trigger-approvals"><Inbox className="h-4 w-4 mr-1.5" /> Approvals</TabsTrigger>
          <TabsTrigger value="pods" data-testid="tab-trigger-pods"><Users className="h-4 w-4 mr-1.5" /> Pods</TabsTrigger>
          {isAdmin && <TabsTrigger value="adapters" data-testid="tab-trigger-adapters"><Plug className="h-4 w-4 mr-1.5" /> Adapters</TabsTrigger>}
          <TabsTrigger value="admin" data-testid="tab-trigger-admin"><SettingsIcon className="h-4 w-4 mr-1.5" /> Admin</TabsTrigger>
        </TabsList>
      </Tabs>

      <div>{body}</div>
    </div>
  );
}
