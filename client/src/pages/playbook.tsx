import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ClipboardList, BarChart3, Plus, Send, CheckCircle2, XCircle, Clock, Sparkles, Pencil, Archive, Upload, History, Info, AlertTriangle } from "lucide-react";

interface Play {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  audience: "customer" | "carrier";
  channel: "email" | "call" | "in_person";
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  signalType: string | null;
  recommendedSteps: string[];
  templateBody: string;
  successMetric: string;
  outcomeWindowHours: number;
  status: "draft" | "published" | "archived";
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface PlayRunRow {
  run: {
    id: string;
    playId: string;
    status: string;
    accountName: string | null;
    suggestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    triggerSnapshot: Record<string, unknown> | null;
  };
  play: { id: string; name: string; channel: string; audience: string; signalType?: string | null };
  outcome?: {
    id: string;
    status: string;                                          // pending | classified | overridden | expired | recorded | bounced
    classifierLabel: string | null;                          // won | lost | partial | no_response | bounced
    classifierConfidence: number | null;
    overrideLabel: string | null;
    overrideReason: string | null;
    evidence: Record<string, unknown> | null;
    windowExpiresAt: string | null;
    recordedAt: string;
  } | null;
}

type FinalLabel = "won" | "lost" | "partial" | "no_response" | "bounced";

function effectiveLabel(o: PlayRunRow["outcome"]): FinalLabel | null {
  if (!o) return null;
  if (o.overrideLabel) return o.overrideLabel as FinalLabel;
  if (o.classifierLabel) return o.classifierLabel as FinalLabel;
  return null;
}

function outcomeChip(label: FinalLabel | null, status?: string) {
  if (!label) return null;
  const map: Record<FinalLabel, { cls: string; text: string }> = {
    won:        { cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200", text: "Won" },
    lost:       { cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200", text: "Lost" },
    partial:    { cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200", text: "Partial" },
    no_response:{ cls: "bg-muted text-muted-foreground", text: status === "expired" ? "No reply (expired)" : "No reply" },
    bounced:    { cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200", text: "Bounced" },
  };
  const m = map[label];
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${m.cls}`}>{m.text}</span>;
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual",
  quote_no_response: "Quote — no response",
  award_no_carrier: "Award — no carrier",
  sentiment_drop: "Sentiment drop",
  signal_match: "Email signal match",
};

function statusBadge(status: string) {
  if (status === "published") return <Badge variant="default" className="bg-emerald-600 hover:bg-emerald-700">Published</Badge>;
  if (status === "archived") return <Badge variant="secondary">Archived</Badge>;
  return <Badge variant="outline">Draft</Badge>;
}

interface PlayFormState {
  id?: string;
  name: string;
  description: string;
  audience: "customer" | "carrier";
  channel: "email" | "call" | "in_person";
  triggerType: string;
  signalType: string;
  recommendedSteps: string;
  templateBody: string;
  successMetric: string;
  outcomeWindowHours: number;
}

type Audience = "customer" | "carrier";
type Channel = "email" | "call" | "in_person";

function isAudience(v: string): v is Audience {
  return v === "customer" || v === "carrier";
}
function isChannel(v: string): v is Channel {
  return v === "email" || v === "call" || v === "in_person";
}

const blankForm: PlayFormState = {
  name: "",
  description: "",
  audience: "customer",
  channel: "email",
  triggerType: "manual",
  signalType: "",
  recommendedSteps: "",
  templateBody: "",
  successMetric: "",
  outcomeWindowHours: 96,
};

export default function PlaybookPage() {
  const { toast } = useToast();
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<PlayFormState>(blankForm);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [triggerFilter, setTriggerFilter] = useState<string>("all");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [audienceFilter, setAudienceFilter] = useState<string>("all");
  const [versionsForPlay, setVersionsForPlay] = useState<Play | null>(null);
  const [selectedRun, setSelectedRun] = useState<PlayRunRow | null>(null);
  const [outcomeNotes, setOutcomeNotes] = useState("");

  const { data: playsResp, isLoading: playsLoading } = useQuery<{ plays: Play[]; canAuthor: boolean }>({
    queryKey: ["/api/playbook/plays", statusFilter, triggerFilter, channelFilter, audienceFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (triggerFilter !== "all") params.set("triggerType", triggerFilter);
      if (channelFilter !== "all") params.set("channel", channelFilter);
      if (audienceFilter !== "all") params.set("audience", audienceFilter);
      const qs = params.toString();
      const url = `/api/playbook/plays${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });
  const plays = playsResp?.plays ?? [];
  const canAuthor = !!playsResp?.canAuthor;

  const { data: triggeredResp } = useQuery<{ triggered: PlayRunRow[] }>({
    queryKey: ["/api/playbook/triggered"],
  });
  const triggered = triggeredResp?.triggered ?? [];

  const { data: myRunsResp } = useQuery<{ runs: PlayRunRow[] }>({
    queryKey: ["/api/playbook/runs"],
  });
  const myRuns = myRunsResp?.runs ?? [];

  const saveMutation = useMutation({
    mutationFn: async (payload: PlayFormState) => {
      const body = {
        name: payload.name,
        description: payload.description || null,
        audience: payload.audience,
        channel: payload.channel,
        triggerType: payload.triggerType,
        signalType: payload.signalType || null,
        recommendedSteps: payload.recommendedSteps.split("\n").map(s => s.trim()).filter(Boolean),
        templateBody: payload.templateBody,
        successMetric: payload.successMetric,
        outcomeWindowHours: Number(payload.outcomeWindowHours) || 96,
      };
      if (payload.id) {
        return apiRequest("PATCH", `/api/playbook/plays/${payload.id}`, body);
      }
      return apiRequest("POST", `/api/playbook/plays`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/plays"] });
      setEditorOpen(false);
      setForm(blankForm);
      toast({ title: "Play saved" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message ?? "Error", variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/playbook/plays/${id}/publish`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/plays"] });
      toast({ title: "Play published" });
    },
  });
  const archiveMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("POST", `/api/playbook/plays/${id}/archive`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/plays"] });
      toast({ title: "Play archived" });
    },
  });

  const runMutation = useMutation({
    mutationFn: async (args: { playId: string; suggestedRunId?: string }): Promise<{
      runId: string;
      renderedBody: string;
      play: { name: string; channel: string };
      nextAction?: { type: "compose_email"; body: string } | { type: "open_task"; taskId: string | null };
    }> => {
      const resp = await apiRequest("POST", `/api/playbook/plays/${args.playId}/run`, { suggestedRunId: args.suggestedRunId });
      return await resp.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/triggered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/my-procurement"] });
      const action = data?.nextAction;
      if (action?.type === "compose_email") {
        try {
          navigator.clipboard?.writeText(action.body);
          toast({
            title: "Play started — email body copied",
            description: "Paste into your compose window to send.",
          });
        } catch {
          toast({ title: "Play started", description: "Email body ready in your runs list." });
        }
      } else if (action?.type === "open_task" && action.taskId) {
        toast({
          title: "Play started — task created",
          description: "Find it in your Tasks list.",
        });
      } else {
        toast({ title: "Play started", description: "Marked as open in your runs list." });
      }
    },
  });

  const outcomeMutation = useMutation({
    mutationFn: async (args: { runId: string; outcome: "success" | "fail" | "no_response"; notes?: string }) =>
      apiRequest("POST", `/api/playbook/runs/${args.runId}/outcome`, { outcome: args.outcome, notes: args.notes ?? null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/triggered"] });
      setSelectedRun(null);
      setOutcomeNotes("");
      toast({ title: "Outcome recorded" });
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async (args: { runId: string; label: FinalLabel; reason?: string }) =>
      apiRequest("POST", `/api/playbook/runs/${args.runId}/override`, { label: args.label, reason: args.reason ?? null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/playbook/analytics"] });
      toast({ title: "Outcome overridden" });
    },
    onError: (e: any) => {
      toast({ title: "Override failed", description: String(e?.message ?? e), variant: "destructive" });
    },
  });

  const openRunsCount = useMemo(() => myRuns.filter(r => r.run.status === "open").length, [myRuns]);

  function openEditor(play?: Play) {
    if (play) {
      setForm({
        id: play.id,
        name: play.name,
        description: play.description ?? "",
        audience: play.audience,
        channel: play.channel,
        triggerType: play.triggerType,
        signalType: play.signalType ?? "",
        recommendedSteps: (play.recommendedSteps ?? []).join("\n"),
        templateBody: play.templateBody ?? "",
        successMetric: play.successMetric ?? "",
        outcomeWindowHours: play.outcomeWindowHours ?? 96,
      });
    } else {
      setForm(blankForm);
    }
    setEditorOpen(true);
  }

  return (
    <div className="container mx-auto p-6 space-y-6" data-testid="page-playbook">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ClipboardList className="h-6 w-6" /> Playbook
          </h1>
          <p className="text-sm text-muted-foreground">
            Author plays once, fire them across the team, and track what actually moves outcomes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canAuthor && (
            <Link href="/playbook/analytics">
              <Button variant="outline" size="sm" data-testid="link-playbook-analytics">
                <BarChart3 className="h-4 w-4 mr-2" /> Analytics
              </Button>
            </Link>
          )}
          {canAuthor && (
            <Button size="sm" onClick={() => openEditor()} data-testid="button-new-play">
              <Plus className="h-4 w-4 mr-2" /> New play
            </Button>
          )}
        </div>
      </div>

      {/* Triggered plays */}
      {triggered.length > 0 && (
        <Card data-testid="card-triggered">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              Triggered plays ({triggered.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {triggered.map(t => (
              <div key={t.run.id} className="flex items-center justify-between gap-3 border rounded-md p-3" data-testid={`triggered-${t.run.id}`}>
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{t.play.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    Suggested {new Date(t.run.suggestedAt).toLocaleString()}
                    {t.play.signalType ? ` · signal ${t.play.signalType}` : ""}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => runMutation.mutate({ playId: t.play.id, suggestedRunId: t.run.id })}
                  disabled={runMutation.isPending}
                  data-testid={`button-run-suggested-${t.run.id}`}
                >
                  <Send className="h-4 w-4 mr-2" /> Run play
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Plays list */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-medium text-muted-foreground">Plays</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-36 h-8" data-testid="select-status-filter"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  {canAuthor && <SelectItem value="draft">Draft</SelectItem>}
                  {canAuthor && <SelectItem value="archived">Archived</SelectItem>}
                </SelectContent>
              </Select>
              <Select value={triggerFilter} onValueChange={setTriggerFilter}>
                <SelectTrigger className="w-44 h-8" data-testid="select-trigger-filter"><SelectValue placeholder="Trigger" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All triggers</SelectItem>
                  {Object.entries(TRIGGER_LABELS).map(([k, v]) => (<SelectItem key={k} value={k}>{v}</SelectItem>))}
                </SelectContent>
              </Select>
              <Select value={channelFilter} onValueChange={setChannelFilter}>
                <SelectTrigger className="w-32 h-8" data-testid="select-channel-filter"><SelectValue placeholder="Channel" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="call">Call</SelectItem>
                  <SelectItem value="in_person">In person</SelectItem>
                </SelectContent>
              </Select>
              <Select value={audienceFilter} onValueChange={setAudienceFilter}>
                <SelectTrigger className="w-32 h-8" data-testid="select-audience-filter"><SelectValue placeholder="Audience" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All audiences</SelectItem>
                  <SelectItem value="customer">Customer</SelectItem>
                  <SelectItem value="carrier">Carrier</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {playsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : plays.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground text-center">
                No plays yet. {canAuthor ? "Create one to get started." : "Ask a manager to publish a play."}
              </CardContent>
            </Card>
          ) : (
            plays.map(p => (
              <Card key={p.id} data-testid={`play-${p.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium" data-testid={`text-play-name-${p.id}`}>{p.name}</span>
                        {statusBadge(p.status)}
                        <Badge variant="outline" className="text-xs">v{p.currentVersion}</Badge>
                        <Badge variant="outline" className="text-xs">{p.audience}</Badge>
                        <Badge variant="outline" className="text-xs">{p.channel}</Badge>
                        <Badge variant="outline" className="text-xs">{TRIGGER_LABELS[p.triggerType] ?? p.triggerType}</Badge>
                      </div>
                      {p.description && <div className="text-sm text-muted-foreground mt-1">{p.description}</div>}
                      {p.successMetric && (
                        <div className="text-xs mt-1">
                          <span className="text-muted-foreground">Success metric: </span>
                          <span>{p.successMetric}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2 shrink-0">
                      {p.status === "published" && (
                        <Button size="sm" variant="default" onClick={() => runMutation.mutate({ playId: p.id })} data-testid={`button-run-${p.id}`}>
                          <Send className="h-4 w-4 mr-2" /> Run
                        </Button>
                      )}
                      {canAuthor && (
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => openEditor(p)} data-testid={`button-edit-${p.id}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setVersionsForPlay(p)} data-testid={`button-versions-${p.id}`} title="Version history">
                            <History className="h-4 w-4" />
                          </Button>
                          {p.status === "draft" && (
                            <Button size="sm" variant="ghost" onClick={() => publishMutation.mutate(p.id)} data-testid={`button-publish-${p.id}`}>
                              <Upload className="h-4 w-4" />
                            </Button>
                          )}
                          {p.status !== "archived" && (
                            <Button size="sm" variant="ghost" onClick={() => archiveMutation.mutate(p.id)} data-testid={`button-archive-${p.id}`}>
                              <Archive className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* My runs */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            My runs {openRunsCount > 0 && <span className="text-foreground">({openRunsCount} open)</span>}
          </h2>
          {myRuns.length === 0 ? (
            <Card><CardContent className="p-4 text-sm text-muted-foreground">No runs yet.</CardContent></Card>
          ) : (
            myRuns.slice(0, 12).map(r => {
              const label = effectiveLabel(r.outcome);
              const isAutoTagged = !!(r.outcome?.classifierLabel && !r.outcome?.overrideLabel);
              return (
              <Card key={r.run.id} data-testid={`run-${r.run.id}`}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{r.play.name}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        {r.run.startedAt ? `Started ${new Date(r.run.startedAt).toLocaleString()}` : `Suggested ${new Date(r.run.suggestedAt).toLocaleString()}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-end">
                      {label && (
                        <span data-testid={`chip-outcome-${r.run.id}`}>{outcomeChip(label, r.outcome?.status)}</span>
                      )}
                      {!label && r.outcome?.status === "pending" && (
                        <span className="text-[11px] text-muted-foreground" data-testid={`chip-pending-${r.run.id}`}>Awaiting reply</span>
                      )}
                      <Badge variant={r.run.status === "completed" ? "default" : r.run.status === "open" ? "outline" : "secondary"} className="text-xs">
                        {r.run.status}
                      </Badge>
                    </div>
                  </div>
                  {/* Why? + Override row for completed runs with an outcome */}
                  {r.outcome && (label || r.outcome.status === "bounced") && (
                    <div className="flex items-center gap-1 mt-2 flex-wrap">
                      {r.outcome.evidence && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5"
                              data-testid={`button-why-${r.run.id}`}>
                              <Info className="h-3 w-3 mr-1" /> Why?
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-80 text-xs space-y-1" data-testid={`popover-why-${r.run.id}`}>
                            <div className="font-medium">
                              {isAutoTagged ? `Auto-tagged ${label}` : `Overridden to ${label}`}
                              {r.outcome.classifierConfidence != null && isAutoTagged && (
                                <span className="text-muted-foreground"> ({r.outcome.classifierConfidence}% confidence)</span>
                              )}
                            </div>
                            {typeof r.outcome.evidence.reasoning === "string" && (
                              <div className="text-muted-foreground">{String(r.outcome.evidence.reasoning)}</div>
                            )}
                            {typeof r.outcome.evidence.quotedText === "string" && r.outcome.evidence.quotedText && (
                              <div className="border-l-2 pl-2 italic">"{String(r.outcome.evidence.quotedText)}"</div>
                            )}
                            {typeof r.outcome.evidence.fromEmail === "string" && (
                              <div className="text-muted-foreground">From: {String(r.outcome.evidence.fromEmail)}</div>
                            )}
                            {r.outcome.overrideReason && (
                              <div className="border-t pt-1 mt-1"><span className="font-medium">Override note:</span> {r.outcome.overrideReason}</div>
                            )}
                            {r.outcome.status === "expired" && (
                              <div className="flex items-center gap-1 text-muted-foreground"><AlertTriangle className="h-3 w-3" />Window elapsed without a reply.</div>
                            )}
                          </PopoverContent>
                        </Popover>
                      )}
                      {(["won", "lost", "partial", "no_response"] as FinalLabel[]).map(opt => (
                        opt !== label && (
                          <Button key={opt} size="sm" variant="ghost" className="h-6 text-xs px-1.5"
                            onClick={() => overrideMutation.mutate({ runId: r.run.id, label: opt })}
                            data-testid={`button-override-${opt}-${r.run.id}`}>
                            {opt === "won" ? "Won" : opt === "lost" ? "Lost" : opt === "partial" ? "Partial" : "No reply"}
                          </Button>
                        )
                      ))}
                    </div>
                  )}
                  {r.run.status === "open" && !r.outcome && (
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="ghost" className="h-7 text-emerald-700"
                        onClick={() => outcomeMutation.mutate({ runId: r.run.id, outcome: "success" })}
                        data-testid={`button-success-${r.run.id}`}>
                        <CheckCircle2 className="h-3 w-3 mr-1" /> Success
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-red-700"
                        onClick={() => outcomeMutation.mutate({ runId: r.run.id, outcome: "fail" })}
                        data-testid={`button-fail-${r.run.id}`}>
                        <XCircle className="h-3 w-3 mr-1" /> Fail
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7"
                        onClick={() => { setSelectedRun(r); setOutcomeNotes(""); }}
                        data-testid={`button-note-${r.run.id}`}>
                        Note
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
              );
            })
          )}
        </div>
      </div>

      {/* Editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-play-editor">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit play" : "New play"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="play-name">Name</Label>
              <Input id="play-name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} data-testid="input-play-name" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="play-desc">Description</Label>
              <Textarea id="play-desc" rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} data-testid="input-play-description" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Audience</Label>
                <Select value={form.audience} onValueChange={v => { if (isAudience(v)) setForm({ ...form, audience: v }); }}>
                  <SelectTrigger data-testid="select-audience"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="customer">Customer</SelectItem>
                    <SelectItem value="carrier">Carrier</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Channel</Label>
                <Select value={form.channel} onValueChange={v => { if (isChannel(v)) setForm({ ...form, channel: v }); }}>
                  <SelectTrigger data-testid="select-channel"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="call">Call</SelectItem>
                    <SelectItem value="in_person">In person</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Trigger</Label>
                <Select value={form.triggerType} onValueChange={v => setForm({ ...form, triggerType: v })}>
                  <SelectTrigger data-testid="select-trigger"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TRIGGER_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {form.triggerType === "signal_match" && (
              <div className="grid gap-2">
                <Label htmlFor="signal-type">Signal type to match</Label>
                <Input
                  id="signal-type"
                  placeholder="e.g. objection, pricing_request, urgency_signal"
                  value={form.signalType}
                  onChange={e => setForm({ ...form, signalType: e.target.value })}
                  data-testid="input-signal-type"
                />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="steps">Recommended steps (one per line)</Label>
              <Textarea id="steps" rows={4} value={form.recommendedSteps} onChange={e => setForm({ ...form, recommendedSteps: e.target.value })} data-testid="input-steps" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="template">Template body (supports {`{{variable}}`})</Label>
              <div className="flex flex-wrap gap-1.5" data-testid="variable-picker">
                <span className="text-xs text-muted-foreground self-center mr-1">Insert:</span>
                {["accountName", "contactName", "repName", "lastTouchDate", "laneOrigin", "laneDest", "rate"].map(v => (
                  <Button
                    key={v}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    data-testid={`button-var-${v}`}
                    onClick={() => setForm(f => ({ ...f, templateBody: `${f.templateBody}{{${v}}}` }))}
                  >
                    {`{{${v}}}`}
                  </Button>
                ))}
              </div>
              <Textarea id="template" rows={6} value={form.templateBody} onChange={e => setForm({ ...form, templateBody: e.target.value })} data-testid="input-template" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="metric">Success metric</Label>
                <Input id="metric" placeholder="e.g. Reply within 96h" value={form.successMetric} onChange={e => setForm({ ...form, successMetric: e.target.value })} data-testid="input-metric" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="window">Outcome window (hours)</Label>
                <Input id="window" type="number" value={form.outcomeWindowHours} onChange={e => setForm({ ...form, outcomeWindowHours: Number(e.target.value) })} data-testid="input-window" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} data-testid="button-cancel-editor">Cancel</Button>
            <Button onClick={() => saveMutation.mutate(form)} disabled={!form.name || saveMutation.isPending} data-testid="button-save-play">
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Version history dialog */}
      <VersionHistoryDialog play={versionsForPlay} onOpenChange={(open) => { if (!open) setVersionsForPlay(null); }} />

      {/* Outcome notes dialog */}
      <Dialog open={!!selectedRun} onOpenChange={(open) => { if (!open) setSelectedRun(null); }}>
        <DialogContent data-testid="dialog-outcome-notes">
          <DialogHeader>
            <DialogTitle>Record outcome — {selectedRun?.play.name}</DialogTitle>
          </DialogHeader>
          <Textarea
            rows={4}
            placeholder="What happened?"
            value={outcomeNotes}
            onChange={e => setOutcomeNotes(e.target.value)}
            data-testid="input-outcome-notes"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => selectedRun && outcomeMutation.mutate({ runId: selectedRun.run.id, outcome: "no_response", notes: outcomeNotes })}>
              No response
            </Button>
            <Button variant="destructive" onClick={() => selectedRun && outcomeMutation.mutate({ runId: selectedRun.run.id, outcome: "fail", notes: outcomeNotes })}>
              Fail
            </Button>
            <Button onClick={() => selectedRun && outcomeMutation.mutate({ runId: selectedRun.run.id, outcome: "success", notes: outcomeNotes })}>
              Success
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface PlayVersionRow {
  id: string;
  playId: string;
  version: number;
  publishedAt: string | null;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

function VersionHistoryDialog({
  play,
  onOpenChange,
}: {
  play: Play | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data } = useQuery<{ versions: PlayVersionRow[] }>({
    queryKey: ["/api/playbook/plays", play?.id],
    enabled: !!play,
    queryFn: async () => {
      const r = await fetch(`/api/playbook/plays/${play!.id}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });
  const versions = data?.versions ?? [];
  return (
    <Dialog open={!!play} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="dialog-versions">
        <DialogHeader>
          <DialogTitle>Version history — {play?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {versions.length === 0 ? (
            <div className="text-sm text-muted-foreground">No versions yet.</div>
          ) : (
            versions.map(v => (
              <div key={v.id} className="border rounded-md p-3" data-testid={`version-${v.version}`}>
                <div className="flex items-center justify-between">
                  <div className="font-medium text-sm">v{v.version}</div>
                  <div className="text-xs text-muted-foreground">
                    {v.publishedAt ? `Published ${new Date(v.publishedAt).toLocaleString()}` : `Drafted ${new Date(v.createdAt).toLocaleString()}`}
                  </div>
                </div>
                {typeof v.snapshot?.successMetric === "string" && v.snapshot.successMetric && (
                  <div className="text-xs text-muted-foreground mt-1">Metric: {String(v.snapshot.successMetric)}</div>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
