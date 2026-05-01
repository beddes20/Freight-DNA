import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertTriangle, ShieldAlert, ThumbsDown, ThumbsUp, Activity, Wrench, Clock, X, FileText, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Overview = {
  windowDays: number;
  totals?: { turns: number; inbound: number; actionsConfirmed: number };
  rates?: {
    unansweredRate: number;
    lowConfidenceRate: number;
    thumbsDownRate: number;
    thumbsUpRate: number;
    successRate: number;
  };
  topQuestions: Array<{ question: string; count: number }>;
  toolMix: Array<{ tool: string; outcome: string; count: number }>;
  latency: { p50: number | null; p95: number | null; avg: number | null; count: number };
  outcomes: Array<{ outcome: string; count: number }>;
  feedback: { up: number; down: number };
  weekly: Array<{ week: string; turns: number; failed: number; avgConfidence: number | null }>;
};

const fmtPct = (n: number | undefined | null) =>
  n == null || Number.isNaN(n) ? "—" : `${(n * 100).toFixed(1)}%`;

type NeedsAttentionRow = {
  id: string;
  userId: string;
  userName: string;
  conversationRef: string | null;
  messageId: number | null;
  summary: string | null;
  outcome: string;
  confidence: string | null;
  route: string | null;
  feedbackRating: string | null;
  actionOutcome: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  feedbackComment: string | null;
};

type ActionRow = {
  id: string;
  confirmedByUserId: string;
  userName: string;
  conversationRef: string | null;
  messageId: number | null;
  tool: string;
  args: any;
  result: string;
  errorMessage: string | null;
  relatedCompanyId: string | null;
  completedAt: string;
};

function fmtDate(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function AdminCopilotAnalyticsPage() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [naOutcomeFilter, setNaOutcomeFilter] = useState<string>("all");
  const [naFeedbackFilter, setNaFeedbackFilter] = useState<string>("all");
  const [naUserFilter, setNaUserFilter] = useState<string>("all");
  const [drawerTurnId, setDrawerTurnId] = useState<string | null>(null);

  const canView = user && ["admin", "director", "sales_director"].includes(user.role);

  if (!user) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="p-8">
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <ShieldAlert className="h-10 w-10 text-amber-500 mx-auto" />
            <p className="font-semibold">Restricted</p>
            <p className="text-sm text-muted-foreground">Copilot analytics are available to admins, directors, and sales directors.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const overview = useQuery<Overview>({
    queryKey: ["/api/agent/analytics/overview", days],
    queryFn: () => fetch(`/api/agent/analytics/overview?days=${days}`, { credentials: "include" }).then((r) => r.json()),
  });
  const needs = useQuery<NeedsAttentionRow[]>({
    queryKey: ["/api/agent/analytics/needs-attention", days],
    queryFn: () => fetch(`/api/agent/analytics/needs-attention?days=${days}`, { credentials: "include" }).then((r) => r.json()),
  });
  const actions = useQuery<ActionRow[]>({
    queryKey: ["/api/agent/analytics/actions", days],
    queryFn: () => fetch(`/api/agent/analytics/actions?days=${days}`, { credentials: "include" }).then((r) => r.json()),
  });

  // Task #910 — document processing queue (in-flight + failed)
  const docQueue = useQuery<{ documents: Array<{
    id: string;
    filename: string;
    classLabel: string;
    status: "parsing" | "parsed" | "failed";
    errorReason: string | null;
    sourceChannel: string;
    pageCount: number | null;
    ocrUsed: boolean;
    createdAt: string;
  }> }>({
    queryKey: ["/api/admin/copilot/documents/queue"],
    queryFn: () => fetch(`/api/admin/copilot/documents/queue?status=parsing,failed`, { credentials: "include" }).then((r) => r.json()),
  });
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retryDoc = async (id: string) => {
    setRetryingId(id);
    try {
      await fetch(`/api/admin/copilot/documents/${id}/retry`, { method: "POST", credentials: "include" });
      await docQueue.refetch();
    } finally {
      setRetryingId(null);
    }
  };

  const ov = overview.data;

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto" data-testid="page-copilot-analytics">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            DNA Copilot Analytics
          </h1>
          <p className="text-sm text-muted-foreground">
            Top questions, failure modes, latency, feedback, and the audit trail for every confirmed action.
          </p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[180px]" data-testid="select-window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="14">Last 14 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="60">Last 60 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="needs-attention" data-testid="tab-needs-attention">
            Needs Attention {needs.data?.length ? <Badge className="ml-2" variant="destructive">{needs.data.length}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="actions" data-testid="tab-actions">Action Audit</TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-documents">Document Queue</TabsTrigger>
          <TabsTrigger value="copilot-intelligence" data-testid="tab-copilot-intelligence">Copilot Intelligence</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          {overview.isLoading || !ov ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <Card data-testid="kpi-turns">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Turns</p>
                    <p className="text-2xl font-semibold">{ov.latency.count}</p>
                  </CardContent>
                </Card>
                <Card data-testid="kpi-latency">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" /> Latency p50 / p95</p>
                    <p className="text-2xl font-semibold">
                      {ov.latency.p50 != null ? `${Math.round(ov.latency.p50)}ms` : "—"} / {ov.latency.p95 != null ? `${Math.round(ov.latency.p95)}ms` : "—"}
                    </p>
                  </CardContent>
                </Card>
                <Card data-testid="kpi-feedback">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Thumbs up / down</p>
                    <p className="text-2xl font-semibold flex items-center gap-2">
                      <ThumbsUp className="h-4 w-4 text-green-600" /> {ov.feedback.up ?? 0}
                      <span className="text-muted-foreground">/</span>
                      <ThumbsDown className="h-4 w-4 text-red-600" /> {ov.feedback.down ?? 0}
                    </p>
                  </CardContent>
                </Card>
                <Card data-testid="kpi-outcomes">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Outcomes</p>
                    <div className="text-xs space-y-0.5 mt-1">
                      {ov.outcomes.map((o) => (
                        <div key={o.outcome} className="flex justify-between gap-2">
                          <span className={o.outcome === "ok" ? "" : "text-amber-700 dark:text-amber-400"}>{o.outcome}</span>
                          <span className="font-mono">{o.count}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Phase 5 KPI rates — required by the parent brief: success,
                  unanswered/abandoned, low-confidence, thumbs-down. */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card data-testid="kpi-success-rate">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Success rate</p>
                    <p className="text-2xl font-semibold text-emerald-700 dark:text-emerald-400" data-testid="text-success-rate">
                      {fmtPct(ov.rates?.successRate)}
                    </p>
                  </CardContent>
                </Card>
                <Card data-testid="kpi-unanswered-rate">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Unanswered / abandoned</p>
                    <p className="text-2xl font-semibold text-amber-700 dark:text-amber-400" data-testid="text-unanswered-rate">
                      {fmtPct(ov.rates?.unansweredRate)}
                    </p>
                  </CardContent>
                </Card>
                <Card data-testid="kpi-low-confidence-rate">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Low-confidence rate</p>
                    <p className="text-2xl font-semibold text-amber-700 dark:text-amber-400" data-testid="text-low-confidence-rate">
                      {fmtPct(ov.rates?.lowConfidenceRate)}
                    </p>
                  </CardContent>
                </Card>
                <Card data-testid="kpi-thumbs-ratio">
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground">Thumbs ratio (down)</p>
                    <p className="text-2xl font-semibold text-rose-700 dark:text-rose-400" data-testid="text-thumbs-down-rate">
                      {fmtPct(ov.rates?.thumbsDownRate)}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Top Questions</CardTitle></CardHeader>
                  <CardContent>
                    {ov.topQuestions.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No data in this window.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {ov.topQuestions.slice(0, 12).map((q, i) => (
                          <li key={i} className="flex items-start justify-between gap-3 text-sm">
                            <span className="line-clamp-1" data-testid={`text-top-question-${i}`}>{q.question || "(empty)"}</span>
                            <span className="font-mono text-xs text-muted-foreground shrink-0">{q.count}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-sm flex items-center gap-1.5"><Wrench className="h-4 w-4" /> Tool Mix</CardTitle></CardHeader>
                  <CardContent>
                    {ov.toolMix.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No tool calls in this window.</p>
                    ) : (
                      <ul className="space-y-1 max-h-72 overflow-y-auto pr-1">
                        {ov.toolMix.slice(0, 25).map((t, i) => (
                          <li key={i} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate font-mono">{t.tool}</span>
                            <span className="flex items-center gap-2">
                              <Badge variant={t.outcome === "ok" ? "secondary" : "destructive"} className="text-[10px] py-0">{t.outcome}</Badge>
                              <span className="font-mono">{t.count}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader><CardTitle className="text-sm">Weekly Trend</CardTitle></CardHeader>
                <CardContent>
                  {ov.weekly.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No data.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-muted-foreground">
                        <tr><th className="text-left py-1">Week</th><th className="text-right">Turns</th><th className="text-right">Failed</th><th className="text-right">Avg confidence</th></tr>
                      </thead>
                      <tbody>
                        {ov.weekly.map((w, i) => (
                          <tr key={i} className="border-t border-border/40">
                            <td className="py-1 font-mono">{w.week}</td>
                            <td className="text-right font-mono">{w.turns}</td>
                            <td className={`text-right font-mono ${w.failed > 0 ? "text-amber-700 dark:text-amber-400" : ""}`}>{w.failed}</td>
                            <td className="text-right font-mono">{w.avgConfidence == null ? "—" : (w.avgConfidence * 100).toFixed(0) + "%"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="needs-attention" className="space-y-2 mt-4">
          {needs.isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : (() => {
            const all = needs.data ?? [];
            const outcomes = Array.from(new Set(all.map((r) => r.outcome))).sort();
            const userOptions = Array.from(new Map(all.map((r) => [r.userId, r.userName])).entries());
            const filtered = all.filter((r) => {
              if (naOutcomeFilter !== "all" && r.outcome !== naOutcomeFilter) return false;
              if (naFeedbackFilter === "down" && r.feedbackRating !== "down") return false;
              if (naFeedbackFilter === "no_feedback" && r.feedbackRating) return false;
              if (naUserFilter !== "all" && r.userId !== naUserFilter) return false;
              return true;
            });
            return (
              <>
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="space-y-1">
                    <label className="text-[11px] uppercase text-muted-foreground">Outcome</label>
                    <Select value={naOutcomeFilter} onValueChange={setNaOutcomeFilter}>
                      <SelectTrigger className="w-[160px]" data-testid="filter-outcome"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All outcomes</SelectItem>
                        {outcomes.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] uppercase text-muted-foreground">Feedback</label>
                    <Select value={naFeedbackFilter} onValueChange={setNaFeedbackFilter}>
                      <SelectTrigger className="w-[160px]" data-testid="filter-feedback"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All feedback</SelectItem>
                        <SelectItem value="down">Thumbs-down only</SelectItem>
                        <SelectItem value="no_feedback">No feedback</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] uppercase text-muted-foreground">User</label>
                    <Select value={naUserFilter} onValueChange={setNaUserFilter}>
                      <SelectTrigger className="w-[200px]" data-testid="filter-user"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All users</SelectItem>
                        {userOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <span className="text-xs text-muted-foreground ml-auto" data-testid="text-filter-count">
                    Showing {filtered.length} of {all.length}
                  </span>
                </div>

                {filtered.length === 0 ? (
                  <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Nothing matches these filters.</CardContent></Card>
                ) : (
                  <div className="space-y-2">
                    {filtered.map((row) => (
                      <Card
                        key={row.id}
                        data-testid={`row-needs-${row.id}`}
                        className="cursor-pointer hover:bg-muted/40 transition-colors"
                        onClick={() => setDrawerTurnId(row.id)}
                      >
                        <CardContent className="p-3 space-y-1.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                              <span>{row.userName}</span>
                              <span>·</span>
                              <span className="font-mono">{fmtDate(row.createdAt)}</span>
                              {row.conversationRef ? (<><span>·</span><span className="font-mono">conv #{row.conversationRef}</span></>) : null}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Badge variant="outline" className="text-[10px]">{row.outcome}</Badge>
                              {row.feedbackRating === "down" ? <Badge variant="destructive" className="text-[10px]"><ThumbsDown className="h-3 w-3 mr-1" /> down</Badge> : null}
                              {row.confidence != null ? <Badge variant="secondary" className="text-[10px]">conf {(Number(row.confidence) * 100).toFixed(0)}%</Badge> : null}
                              {row.route ? <Badge variant="secondary" className="text-[10px]">{row.route}</Badge> : null}
                            </div>
                          </div>
                          {row.summary ? <p className="text-sm">{row.summary}</p> : null}
                          {row.errorMessage ? <p className="text-xs text-red-600 dark:text-red-400">{row.errorMessage}</p> : null}
                          {row.feedbackComment ? <p className="text-xs italic text-muted-foreground">“{row.feedbackComment}”</p> : null}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </TabsContent>

        <TabsContent value="actions" className="space-y-2 mt-4">
          {actions.isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : (actions.data?.length ?? 0) === 0 ? (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No actions confirmed in this window.</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground bg-muted/40">
                    <tr>
                      <th className="text-left p-2">When</th>
                      <th className="text-left p-2">User</th>
                      <th className="text-left p-2">Tool</th>
                      <th className="text-left p-2">Result</th>
                      <th className="text-left p-2">Args</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actions.data!.map((a) => (
                      <tr key={a.id} className="border-t border-border/40" data-testid={`row-action-${a.id}`}>
                        <td className="p-2 font-mono whitespace-nowrap">{fmtDate(a.completedAt)}</td>
                        <td className="p-2">{a.userName}</td>
                        <td className="p-2 font-mono">{a.tool}</td>
                        <td className="p-2">
                          <Badge variant={a.result === "success" ? "secondary" : a.result === "dismissed" ? "outline" : "destructive"} className="text-[10px]">{a.result}</Badge>
                        </td>
                        <td className="p-2 font-mono text-[11px] truncate max-w-[420px]">{a.args ? JSON.stringify(a.args) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Task #910 — Document Processing Queue */}
        <TabsContent value="documents" className="space-y-2 mt-4">
          {docQueue.isLoading ? (
            <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : (docQueue.data?.documents?.length ?? 0) === 0 ? (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No documents in flight or failed.</CardContent></Card>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-1.5">
                  <FileText className="h-4 w-4" /> Processing Queue
                  <Badge variant="secondary" className="text-[10px] ml-2">{docQueue.data?.documents.length ?? 0}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground bg-muted/40">
                    <tr>
                      <th className="text-left p-2">When</th>
                      <th className="text-left p-2">File</th>
                      <th className="text-left p-2">Class</th>
                      <th className="text-left p-2">Source</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Error</th>
                      <th className="text-right p-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docQueue.data!.documents.map((d) => (
                      <tr key={d.id} className="border-t border-border/40" data-testid={`row-document-${d.id}`}>
                        <td className="p-2 font-mono whitespace-nowrap">{fmtDate(d.createdAt)}</td>
                        <td className="p-2 truncate max-w-[260px]" title={d.filename}>{d.filename}</td>
                        <td className="p-2 font-mono">{d.classLabel}</td>
                        <td className="p-2 text-muted-foreground">{d.sourceChannel}</td>
                        <td className="p-2">
                          <Badge variant={d.status === "parsed" ? "secondary" : d.status === "failed" ? "destructive" : "outline"} className="text-[10px]">
                            {d.status}{d.ocrUsed ? " · OCR" : ""}
                          </Badge>
                        </td>
                        <td className="p-2 text-amber-700 dark:text-amber-400 truncate max-w-[260px]" title={d.errorReason ?? ""}>{d.errorReason ?? ""}</td>
                        <td className="p-2 text-right">
                          {d.status !== "parsed" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-[11px]"
                              disabled={retryingId === d.id}
                              onClick={() => retryDoc(d.id)}
                              data-testid={`button-retry-document-${d.id}`}
                            >
                              {retryingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                              Retry
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Task #926 — Copilot Intelligence analytics */}
        <TabsContent value="copilot-intelligence" className="space-y-3 mt-4">
          <CopilotIntelligenceTab days={days} />
        </TabsContent>
      </Tabs>

      <TurnDetailDrawer turnId={drawerTurnId} onClose={() => setDrawerTurnId(null)} />
    </div>
  );
}

type TurnDetail = {
  id: string;
  userId: string;
  userName: string;
  conversationRef: string | null;
  messageId: number | null;
  question: string | null;
  summary: string | null;
  outcome: string;
  confidence: string | null;
  route: string | null;
  feedbackRating: string | null;
  feedbackComment: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  toolsUsed: string[] | null;
  toolCalls?: Array<{
    id: string;
    tool: string | null;
    capability: string | null;
    outcome: string;
    errorMessage: string | null;
    inputJson: unknown;
    outputJson: unknown;
    latencyMs: number | null;
    createdAt: string;
  }>;
  assistantOutput?: unknown;
  envelopeSummary?: unknown;
  actions: Array<{ id: string; tool: string; result: string; args: any; errorMessage: string | null; completedAt: string }>;
};

function formatJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function TurnDetailDrawer({ turnId, onClose }: { turnId: string | null; onClose: () => void }) {
  const q = useQuery<TurnDetail>({
    queryKey: ["/api/agent/analytics/turns", turnId],
    queryFn: () => fetch(`/api/agent/analytics/turns/${turnId}`, { credentials: "include" }).then((r) => r.json()),
    enabled: !!turnId,
  });
  const open = !!turnId;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="drawer-turn-detail">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span>Turn detail</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} data-testid="button-close-drawer"><X className="h-4 w-4" /></Button>
          </DialogTitle>
        </DialogHeader>
        {q.isLoading || !q.data ? (
          <div className="p-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{q.data.userName}</span><span>·</span>
              <span className="font-mono">{fmtDate(q.data.createdAt)}</span>
              {q.data.conversationRef ? <><span>·</span><span className="font-mono">conv #{q.data.conversationRef}</span></> : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline">{q.data.outcome}</Badge>
              {q.data.confidence != null ? <Badge variant="secondary">conf {(Number(q.data.confidence) * 100).toFixed(0)}%</Badge> : null}
              {q.data.route ? <Badge variant="secondary">{q.data.route}</Badge> : null}
              {q.data.latencyMs != null ? <Badge variant="secondary">{Math.round(q.data.latencyMs)}ms</Badge> : null}
              {q.data.feedbackRating === "down" ? <Badge variant="destructive"><ThumbsDown className="h-3 w-3 mr-1" /> down</Badge> : null}
            </div>
            {q.data.question ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Question</p>
                <p data-testid="text-turn-question">{q.data.question}</p>
              </div>
            ) : null}
            {q.data.summary ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Summary</p>
                <p>{q.data.summary}</p>
              </div>
            ) : null}
            {q.data.errorMessage ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Error</p>
                <p className="text-xs text-red-600 dark:text-red-400 font-mono whitespace-pre-wrap">{q.data.errorMessage}</p>
              </div>
            ) : null}
            {q.data.feedbackComment ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Feedback</p>
                <p className="italic">“{q.data.feedbackComment}”</p>
              </div>
            ) : null}
            {q.data.assistantOutput ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Assistant output</p>
                <pre
                  className="text-[11px] font-mono bg-muted/50 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words"
                  data-testid="text-turn-assistant-output"
                >{formatJson(q.data.assistantOutput)}</pre>
              </div>
            ) : null}
            {q.data.envelopeSummary ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Prompt envelope</p>
                <pre
                  className="text-[11px] font-mono bg-muted/50 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words"
                  data-testid="text-turn-envelope"
                >{formatJson(q.data.envelopeSummary)}</pre>
              </div>
            ) : null}
            {q.data.toolCalls?.length ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Tool calls</p>
                <div className="space-y-2 mt-1">
                  {q.data.toolCalls.map((tc) => (
                    <div key={tc.id} className="rounded border p-2 text-[11px]" data-testid={`tool-call-${tc.id}`}>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="font-mono">{tc.tool ?? "?"}</Badge>
                        <Badge variant={tc.outcome === "ok" ? "secondary" : "destructive"}>{tc.outcome}</Badge>
                        {tc.latencyMs != null ? <span className="text-muted-foreground">{Math.round(tc.latencyMs)}ms</span> : null}
                      </div>
                      {tc.errorMessage ? <p className="text-red-600 dark:text-red-400 mt-1 font-mono">{tc.errorMessage}</p> : null}
                      {tc.inputJson ? (
                        <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">input</summary>
                          <pre className="bg-muted/40 rounded p-1.5 mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">{formatJson(tc.inputJson)}</pre>
                        </details>
                      ) : null}
                      {tc.outputJson ? (
                        <details className="mt-1"><summary className="cursor-pointer text-muted-foreground">output</summary>
                          <pre className="bg-muted/40 rounded p-1.5 mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words">{formatJson(tc.outputJson)}</pre>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : q.data.toolsUsed?.length ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Tools used</p>
                <div className="flex flex-wrap gap-1">
                  {q.data.toolsUsed.map((t, i) => <Badge key={i} variant="outline" className="font-mono text-[11px]">{t}</Badge>)}
                </div>
              </div>
            ) : null}
            {q.data.actions?.length ? (
              <div>
                <p className="text-[11px] uppercase text-muted-foreground mb-1">Confirmed actions ({q.data.actions.length})</p>
                <div className="space-y-1.5">
                  {q.data.actions.map((a) => (
                    <div key={a.id} className="border border-border/60 rounded p-2" data-testid={`drawer-action-${a.id}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">{a.tool}</span>
                        <Badge variant={a.result === "success" ? "secondary" : a.result === "dismissed" ? "outline" : "destructive"} className="text-[10px]">{a.result}</Badge>
                      </div>
                      {a.args ? <p className="font-mono text-[11px] text-muted-foreground mt-1 break-all">{JSON.stringify(a.args)}</p> : null}
                      {a.errorMessage ? <p className="text-[11px] text-red-600 dark:text-red-400 mt-1">{a.errorMessage}</p> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Task #926 — Copilot Intelligence tab ──────────────────────────────
type ExtractionRateRow = { class: string; docs: number | string; extracted: number | string };
type PlayAcceptanceRow = { play_id: string; total: string | number; accepted: string | number; dismissed: string | number; overridden: string | number; snoozed: string | number };
type WinRateRow = { play_id: string; won_accepted: string | number; won_overridden: string | number; outcomes: string | number };
type AdjustmentRow = { id: string; scope: string; scopeKey: string; factor: string; sampleCount: number; winRate: string | null; computedAt: string };

function CopilotIntelligenceTab({ days }: { days: number }) {
  const rates = useQuery<{ rows: ExtractionRateRow[] }>({ queryKey: ["/api/copilot/admin/extraction-rates", days] });
  const plays = useQuery<{ acceptance: PlayAcceptanceRow[]; winRates: WinRateRow[] }>({ queryKey: ["/api/copilot/admin/play-acceptance", days] });
  const adj = useQuery<{ adjustments: AdjustmentRow[] }>({ queryKey: ["/api/copilot/admin/adjustments"] });

  if (rates.isLoading || plays.isLoading || adj.isLoading) {
    return <div className="p-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  const winByPlay = new Map<string, WinRateRow>();
  for (const w of plays.data?.winRates ?? []) winByPlay.set(w.play_id, w);

  return (
    <div className="space-y-3">
      <Card data-testid="card-extraction-rates">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <FileText className="h-4 w-4" /> Extraction rate by class
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground bg-muted/40">
              <tr><th className="text-left p-2">Class</th><th className="text-right p-2">Docs</th><th className="text-right p-2">Extracted</th><th className="text-right p-2">Rate</th></tr>
            </thead>
            <tbody>
              {(rates.data?.rows ?? []).map((r) => {
                const docs = Number(r.docs) || 0;
                const extracted = Number(r.extracted) || 0;
                const pct = docs ? `${((extracted / docs) * 100).toFixed(0)}%` : "—";
                return (
                  <tr key={r.class} className="border-t border-border/40" data-testid={`row-extract-${r.class}`}>
                    <td className="p-2 font-mono">{r.class}</td>
                    <td className="p-2 text-right">{docs}</td>
                    <td className="p-2 text-right">{extracted}</td>
                    <td className="p-2 text-right">{pct}</td>
                  </tr>
                );
              })}
              {!rates.data?.rows?.length && <tr><td colSpan={4} className="p-3 text-center text-muted-foreground">No documents in window.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card data-testid="card-play-acceptance">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Activity className="h-4 w-4" /> Play acceptance + accepted-vs-overridden win rate
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground bg-muted/40">
              <tr>
                <th className="text-left p-2">Play</th>
                <th className="text-right p-2">Total</th>
                <th className="text-right p-2">Acc</th>
                <th className="text-right p-2">Dis</th>
                <th className="text-right p-2">Ovr</th>
                <th className="text-right p-2">Snz</th>
                <th className="text-right p-2">Acc-Win</th>
                <th className="text-right p-2">Ovr-Win</th>
              </tr>
            </thead>
            <tbody>
              {(plays.data?.acceptance ?? []).map((r) => {
                const w = winByPlay.get(r.play_id);
                const totalOutcomes = Number(w?.outcomes ?? 0);
                const accWin = totalOutcomes ? `${((Number(w?.won_accepted ?? 0) / totalOutcomes) * 100).toFixed(0)}%` : "—";
                const ovrWin = totalOutcomes ? `${((Number(w?.won_overridden ?? 0) / totalOutcomes) * 100).toFixed(0)}%` : "—";
                return (
                  <tr key={r.play_id} className="border-t border-border/40" data-testid={`row-play-${r.play_id}`}>
                    <td className="p-2 font-mono">{r.play_id}</td>
                    <td className="p-2 text-right">{Number(r.total)}</td>
                    <td className="p-2 text-right">{Number(r.accepted)}</td>
                    <td className="p-2 text-right">{Number(r.dismissed)}</td>
                    <td className="p-2 text-right">{Number(r.overridden)}</td>
                    <td className="p-2 text-right">{Number(r.snoozed)}</td>
                    <td className="p-2 text-right" data-testid={`text-acc-win-${r.play_id}`}>{accWin}</td>
                    <td className="p-2 text-right" data-testid={`text-ovr-win-${r.play_id}`}>{ovrWin}</td>
                  </tr>
                );
              })}
              {!plays.data?.acceptance?.length && <tr><td colSpan={8} className="p-3 text-center text-muted-foreground">No play recommendations in window.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card data-testid="card-adjustments">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Wrench className="h-4 w-4" /> Current learning factors (clamped 0.5–1.5)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground bg-muted/40">
              <tr>
                <th className="text-left p-2">Scope</th>
                <th className="text-left p-2">Key</th>
                <th className="text-right p-2">Factor</th>
                <th className="text-right p-2">Win rate</th>
                <th className="text-right p-2">Samples</th>
                <th className="text-left p-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {(adj.data?.adjustments ?? []).map((a) => (
                <tr key={a.id} className="border-t border-border/40" data-testid={`row-adj-${a.id}`}>
                  <td className="p-2 font-mono">{a.scope}</td>
                  <td className="p-2 font-mono truncate max-w-[260px]" title={a.scopeKey}>{a.scopeKey}</td>
                  <td className="p-2 text-right" data-testid={`text-factor-${a.id}`}>{Number(a.factor).toFixed(3)}</td>
                  <td className="p-2 text-right">{a.winRate != null ? `${(Number(a.winRate) * 100).toFixed(0)}%` : "—"}</td>
                  <td className="p-2 text-right">{a.sampleCount}</td>
                  <td className="p-2 font-mono whitespace-nowrap">{fmtDate(a.computedAt)}</td>
                </tr>
              ))}
              {!adj.data?.adjustments?.length && <tr><td colSpan={6} className="p-3 text-center text-muted-foreground">No learning factors yet — outcomes table is below the threshold.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
