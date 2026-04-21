import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Play, Power } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const AUTONOMY = ["off", "suggest", "draft", "auto_hitl", "auto"] as const;

export default function AgentDetailPage() {
  const [, params] = useRoute("/agents/:slug");
  const slug = params?.slug ?? "";
  const { toast } = useToast();
  const { data, isLoading } = useQuery<any>({ queryKey: ["/api/agentic/agents", slug], enabled: !!slug });

  const updateMut = useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiRequest("PATCH", `/api/agentic/agents/${slug}`, patch).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/agents", slug] });
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/agents"] });
      toast({ title: "Saved" });
    },
  });

  const runMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/agentic/agents/${slug}/run`, { trigger: {} }).then(r => r.json()),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["/api/agentic/agents", slug] });
      toast({ title: "Loop run", description: res.summary ?? "Done" });
    },
  });

  if (isLoading || !data?.agent) return <div className="container mx-auto py-6">Loading…</div>;
  const a = data.agent;
  const def = data.definition;
  const stats = data.stats;

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid={`page-agent-${slug}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link href="/agents"><Button size="icon" variant="ghost"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <h1 className="text-2xl font-semibold">{a.name}</h1>
            <p className="text-sm text-muted-foreground max-w-2xl">{a.description}</p>
            <div className="flex gap-2 items-center mt-2 text-xs">
              <Badge variant="outline">Loop: {a.loop}</Badge>
              <Badge variant="outline">Model: {a.model}</Badge>
              {a.targetMetric && <Badge variant="outline">Target: {a.targetMetric}</Badge>}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => runMut.mutate()} disabled={runMut.isPending} data-testid="button-run-once">
            <Play className="h-4 w-4 mr-1" /> Run once
          </Button>
          <Button
            variant={a.killSwitch ? "destructive" : "outline"}
            onClick={() => updateMut.mutate({ killSwitch: !a.killSwitch })}
            data-testid="button-kill-switch"
          >
            <Power className="h-4 w-4 mr-1" /> {a.killSwitch ? "Resume" : "Kill switch"}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="cockpit">
        <TabsList>
          <TabsTrigger value="cockpit" data-testid="tab-cockpit">Cockpit</TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
          <TabsTrigger value="plays" data-testid="tab-plays">Plays</TabsTrigger>
          <TabsTrigger value="rollout" data-testid="tab-rollout">Rollout</TabsTrigger>
        </TabsList>

        <TabsContent value="cockpit" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard label="HITL acceptance (30d)" value={`${Math.round((stats.hitl.acceptanceRate || 0) * 100)}%`} sub={`${stats.hitl.approved}/${stats.hitl.total}`} />
            <StatCard label="Override rate" value={`${Math.round((stats.hitl.overrideRate || 0) * 100)}%`} sub={`${stats.hitl.edited} edited`} />
            <StatCard label="Pending in inbox" value={String(stats.hitl.pending)} sub="awaiting approval" />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Recent suggestions</CardTitle></CardHeader>
            <CardContent>
              {data.recentSuggestions.length === 0 && (
                <div className="text-sm text-muted-foreground">No suggestions yet. Try "Run once" to exercise the loop in dry-run.</div>
              )}
              <ul className="space-y-2">
                {data.recentSuggestions.map((s: any) => (
                  <li key={s.id} className="border rounded p-3 text-sm" data-testid={`suggestion-${s.id}`}>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{s.loopStep} · conf {s.confidence ?? "—"} · {s.adapterMode}</span>
                      <span>{new Date(s.createdAt).toLocaleString()}</span>
                    </div>
                    {s.reasoning && <div className="mt-1">{s.reasoning}</div>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Recent staged actions</CardTitle></CardHeader>
            <CardContent>
              {data.recentHitl.length === 0 && <div className="text-sm text-muted-foreground">No actions staged yet.</div>}
              <ul className="space-y-2">
                {data.recentHitl.map((h: any) => (
                  <li key={h.id} className="border rounded p-3 text-sm" data-testid={`hitl-${h.id}`}>
                    <div className="flex justify-between">
                      <div className="font-medium">{h.title}</div>
                      <Badge variant={h.status === "pending" ? "default" : "outline"}>{h.status}</Badge>
                    </div>
                    {h.summary && <div className="text-xs text-muted-foreground mt-1">{h.summary}</div>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings">
          <SettingsTab agent={a} onSave={(p) => updateMut.mutate(p)} />
        </TabsContent>

        <TabsContent value="plays">
          <Card>
            <CardHeader><CardTitle className="text-base">Starter plays</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {(def?.starterPlays ?? []).map((p: any, i: number) => (
                <div key={i} className="border rounded p-3" data-testid={`play-${i}`}>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">When: {p.whenToUse}</div>
                  <div className="text-sm mt-2 whitespace-pre-wrap">{p.body}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rollout">
          <RolloutTab adapters={def?.adapters ?? []} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card><CardContent className="pt-6">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </CardContent></Card>
  );
}

function SettingsTab({ agent, onSave }: { agent: any; onSave: (p: Record<string, unknown>) => void }) {
  const [autonomy, setAutonomy] = useState(agent.autonomy);
  const [enabled, setEnabled] = useState(agent.enabled);
  const [persona, setPersona] = useState(agent.personaOverlay ?? "");
  const [guardrails, setGuardrails] = useState(JSON.stringify(agent.guardrails ?? {}, null, 2));
  const [scope, setScope] = useState(JSON.stringify(agent.scope ?? {}, null, 2));
  return (
    <Card><CardContent className="pt-6 space-y-4">
      <div className="flex items-center gap-3">
        <Switch checked={enabled} onCheckedChange={setEnabled} data-testid="switch-enabled" />
        <Label>Enabled</Label>
      </div>
      <div className="max-w-xs">
        <Label>Autonomy</Label>
        <Select value={autonomy} onValueChange={setAutonomy}>
          <SelectTrigger data-testid="select-autonomy"><SelectValue /></SelectTrigger>
          <SelectContent>
            {AUTONOMY.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>Persona overlay</Label>
        <Textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={4} data-testid="textarea-persona" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label>Guardrails (JSON)</Label>
          <Textarea value={guardrails} onChange={(e) => setGuardrails(e.target.value)} rows={6} data-testid="textarea-guardrails" />
        </div>
        <div>
          <Label>Scope (JSON)</Label>
          <Textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={6} data-testid="textarea-scope" />
        </div>
      </div>
      <Button
        data-testid="button-save-settings"
        onClick={() => {
          let g = {}, s = {};
          try { g = JSON.parse(guardrails); } catch { return; }
          try { s = JSON.parse(scope); } catch { return; }
          onSave({ autonomy, enabled, personaOverlay: persona, guardrails: g, scope: s });
        }}
      >Save</Button>
    </CardContent></Card>
  );
}

function RolloutTab({ adapters }: { adapters: string[] }) {
  const { data } = useQuery<{ adapters: any[] }>({ queryKey: ["/api/agentic/adapters"] });
  const rows = (data?.adapters ?? []).filter(a => adapters.includes(a.key));
  const setMode = useMutation({
    mutationFn: (args: { key: string; mode: string }) => apiRequest("PATCH", `/api/agentic/adapters/${args.key}`, { mode: args.mode }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/agentic/adapters"] }),
  });
  return (
    <Card><CardContent className="pt-6 space-y-3">
      <div className="text-sm text-muted-foreground">
        Adapters this agent depends on. Flip to <strong>live</strong> only after credentials are configured.
      </div>
      {rows.length === 0 && <div className="text-sm">No adapters required.</div>}
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between border rounded p-3" data-testid={`adapter-${r.key}`}>
          <div>
            <div className="font-medium text-sm">{r.label}</div>
            <div className="text-xs text-muted-foreground">
              Credentials: {r.credentialsConfigured ? "configured" : "missing"} · current mode: {r.mode}
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={r.mode === "dry_run" ? "default" : "outline"} onClick={() => setMode.mutate({ key: r.key, mode: "dry_run" })}>Dry-run</Button>
            <Button size="sm" variant={r.mode === "live" ? "default" : "outline"} onClick={() => setMode.mutate({ key: r.key, mode: "live" })} disabled={!r.credentialsConfigured}>Live</Button>
          </div>
        </div>
      ))}
    </CardContent></Card>
  );
}
