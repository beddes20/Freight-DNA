import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Trash2, Plus, Pin, Brain, Shield, Sparkles } from "lucide-react";
import { format } from "date-fns";

type Effect = "allow" | "deny" | "auto";
interface CapRow { capability: string; defaultEffect: Effect; effect: Effect; hasOverride: boolean }
interface Fact { id: string; fact: string; pinned: boolean; source: string; createdAt: string }
interface Memory { id: string; kind: string; content: string; importance: number; relatedCompanyId: string | null; createdAt: string }

function effectBadge(e: Effect) {
  if (e === "auto") return <Badge className="bg-emerald-600 hover:bg-emerald-700" data-testid={`badge-effect-${e}`}>Auto-approved</Badge>;
  if (e === "allow") return <Badge variant="secondary" data-testid={`badge-effect-${e}`}>Allowed (asks first)</Badge>;
  return <Badge variant="destructive" data-testid={`badge-effect-${e}`}>Denied</Badge>;
}

function prettyCapability(cap: string) {
  return cap
    .replace(/^read\./, "View ")
    .replace(/^write\./, "Modify ")
    .replace(/^navigate\./, "Navigate ")
    .replace(/\./g, " ");
}

export default function SettingsAiAssistantPage() {
  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="h-7 w-7 text-amber-500" />
        <div>
          <h1 className="text-2xl font-semibold" data-testid="text-page-title">AI Assistant</h1>
          <p className="text-sm text-muted-foreground">Tune what DNA can do for you, what it remembers, and your standing instructions.</p>
        </div>
      </div>

      <Tabs defaultValue="permissions" className="w-full">
        <TabsList>
          <TabsTrigger value="permissions" data-testid="tab-permissions"><Shield className="h-4 w-4 mr-2" />Permissions</TabsTrigger>
          <TabsTrigger value="facts" data-testid="tab-facts"><Pin className="h-4 w-4 mr-2" />Standing Instructions</TabsTrigger>
          <TabsTrigger value="memories" data-testid="tab-memories"><Brain className="h-4 w-4 mr-2" />Memories</TabsTrigger>
        </TabsList>

        <TabsContent value="permissions" className="mt-4">
          <PermissionsPanel />
        </TabsContent>
        <TabsContent value="facts" className="mt-4">
          <FactsPanel />
        </TabsContent>
        <TabsContent value="memories" className="mt-4">
          <MemoriesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PermissionsPanel() {
  const { data, isLoading } = useQuery<CapRow[]>({ queryKey: ["/api/agent/me/capabilities"] });
  if (isLoading) return <Loader2 className="h-6 w-6 animate-spin" />;
  const rows = data ?? [];
  const groups: Record<string, CapRow[]> = { Reads: [], Writes: [], "External Outreach": [], Navigation: [] };
  for (const r of rows) {
    if (r.capability.startsWith("read.")) groups.Reads.push(r);
    else if (r.capability.startsWith("navigate.")) groups.Navigation.push(r);
    else if (r.capability === "write.sms.driver" || r.capability === "write.voice.driver" || r.capability === "write.email.external") groups["External Outreach"].push(r);
    else groups.Writes.push(r);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>What DNA can do for you</CardTitle>
        <CardDescription>
          These are read-only here. To change them, ask an admin to update your AI permissions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {Object.entries(groups).map(([label, items]) => (
          items.length === 0 ? null : (
            <div key={label}>
              <h3 className="font-semibold text-sm mb-2 uppercase tracking-wide text-muted-foreground">{label}</h3>
              <div className="rounded-md border">
                {items.map((row, i) => (
                  <div key={row.capability}
                    className={`flex items-center justify-between px-4 py-3 ${i > 0 ? "border-t" : ""}`}
                    data-testid={`row-cap-${row.capability}`}>
                    <div>
                      <div className="font-medium capitalize">{prettyCapability(row.capability)}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.capability}
                        {row.hasOverride && <span className="ml-2 text-amber-600">• admin override</span>}
                      </div>
                    </div>
                    {effectBadge(row.effect)}
                  </div>
                ))}
              </div>
            </div>
          )
        ))}
      </CardContent>
    </Card>
  );
}

function FactsPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Fact[]>({ queryKey: ["/api/agent/me/facts"] });
  const [draft, setDraft] = useState("");
  const [pinned, setPinned] = useState(true);

  const add = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/agent/me/facts", { fact: draft.trim(), pinned }),
    onSuccess: () => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["/api/agent/me/facts"] });
      toast({ title: "Saved" });
    },
    onError: () => toast({ title: "Could not save", variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/agent/me/facts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/agent/me/facts"] }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Standing instructions</CardTitle>
        <CardDescription>
          Short notes DNA will always remember about how you work. Pinned items are loaded into every conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 items-center">
          <Input
            placeholder="e.g. Always cc dispatch@acme on Acme threads"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid="input-new-fact"
          />
          <div className="flex items-center gap-2 shrink-0">
            <Switch checked={pinned} onCheckedChange={setPinned} data-testid="switch-pinned" />
            <span className="text-sm text-muted-foreground">Pin</span>
          </div>
          <Button
            disabled={!draft.trim() || add.isPending}
            onClick={() => add.mutate()}
            data-testid="button-add-fact"
          >
            {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </Button>
        </div>

        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          (data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-empty-facts">
              No standing instructions yet. Add one above and DNA will remember it across every conversation.
            </div>
          ) : (
            <div className="rounded-md border">
              {(data ?? []).map((f, i) => (
                <div key={f.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t" : ""}`} data-testid={`row-fact-${f.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {f.pinned && <Pin className="h-3 w-3 text-amber-500" />}
                      <span className="font-medium">{f.fact}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Added {format(new Date(f.createdAt), "MMM d, yyyy")} · source: {f.source}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(f.id)} data-testid={`button-delete-fact-${f.id}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

function MemoriesPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<Memory[]>({ queryKey: ["/api/agent/me/memories"] });
  const del = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/agent/me/memories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agent/me/memories"] });
      toast({ title: "Memory removed" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>What DNA remembers about you</CardTitle>
        <CardDescription>
          Episodic memories DNA captured from prior conversations. Delete anything that's wrong or outdated.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          (data ?? []).length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-empty-memories">
              No memories saved yet. As you chat with DNA, it'll save things you ask it to remember.
            </div>
          ) : (
            <div className="rounded-md border">
              {(data ?? []).map((m, i) => (
                <div key={m.id} className={`flex items-start justify-between gap-4 px-4 py-3 ${i > 0 ? "border-t" : ""}`} data-testid={`row-memory-${m.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-xs">{m.kind}</Badge>
                      <span className="text-xs text-muted-foreground">{format(new Date(m.createdAt), "MMM d, yyyy h:mma")}</span>
                    </div>
                    <div className="text-sm">{m.content}</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(m.id)} data-testid={`button-delete-memory-${m.id}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
