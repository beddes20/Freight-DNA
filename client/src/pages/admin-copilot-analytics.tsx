import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertTriangle, ShieldAlert, ThumbsDown, ThumbsUp, Activity, Wrench, Clock } from "lucide-react";

type Overview = {
  windowDays: number;
  topQuestions: Array<{ question: string; count: number }>;
  toolMix: Array<{ tool: string; outcome: string; count: number }>;
  latency: { p50: number | null; p95: number | null; avg: number | null; count: number };
  outcomes: Array<{ outcome: string; count: number }>;
  feedback: { up: number; down: number };
  weekly: Array<{ week: string; turns: number; failed: number; avgConfidence: number | null }>;
};

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

  const isAdmin = user?.role === "admin";

  if (!user) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="p-8">
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <ShieldAlert className="h-10 w-10 text-amber-500 mx-auto" />
            <p className="font-semibold">Admins only</p>
            <p className="text-sm text-muted-foreground">Copilot analytics are restricted to admin users.</p>
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
          ) : (needs.data?.length ?? 0) === 0 ? (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Nothing to review — every recent turn is clean.</CardContent></Card>
          ) : (
            <div className="space-y-2">
              {needs.data!.map((row) => (
                <Card key={row.id} data-testid={`row-needs-${row.id}`}>
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
      </Tabs>
    </div>
  );
}
