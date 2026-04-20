import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sparkles, MessageSquare, BookMarked, Plus, Send, Trash2, Pin, Archive, ThumbsUp, ThumbsDown, Paperclip } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import AIIntelligencePage from "@/pages/ai-intelligence";

interface AgentRow { id: string; slug: string; name: string; description: string | null; isDefault: boolean; }
interface ProjectRow { id: string; name: string; pinnedContext: string | null; }
interface ThreadRow { id: string; title: string; pinned: boolean; archivedAt: string | null; lastMessageAt: string | null; createdAt: string; defaultAgentId: string | null; projectId: string | null; }
interface MessageRow { id: string; role: string; content: string; agentName: string | null; rating: number | null; createdAt: string; }
interface LibraryRow { id: string; kind: string; title: string; body: string | null; createdAt: string; }

function useTabFromUrl(): [string, (t: string) => void] {
  const [location, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(window.location.search), [location]);
  const tab = params.get("tab") || "insights";
  const set = (t: string) => {
    const sp = new URLSearchParams(window.location.search);
    sp.set("tab", t);
    setLocation(`/valueiq?${sp.toString()}`);
  };
  return [tab, set];
}

export default function ValueIQPage() {
  const [tab, setTab] = useTabFromUrl();
  return (
    <div className="container mx-auto p-4 md:p-6 max-w-[1400px]">
      <div className="mb-4 flex items-center gap-3">
        <Sparkles className="h-6 w-6 text-amber-500" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-valueiq-title">ValueIQ</h1>
          <p className="text-sm text-muted-foreground">Your AI workspace — insights, threads, and personal library, grounded in your CRM data.</p>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="insights" data-testid="tab-insights"><Sparkles className="h-4 w-4 mr-2" />Insights</TabsTrigger>
          <TabsTrigger value="threads" data-testid="tab-threads"><MessageSquare className="h-4 w-4 mr-2" />Threads</TabsTrigger>
          <TabsTrigger value="library" data-testid="tab-library"><BookMarked className="h-4 w-4 mr-2" />Library</TabsTrigger>
        </TabsList>
        <TabsContent value="insights" className="m-0">
          <InsightsHandoffBar onOpened={() => setTab("threads")} />
          <AIIntelligencePage />
        </TabsContent>
        <TabsContent value="threads" className="m-0">
          <ThreadsPane />
        </TabsContent>
        <TabsContent value="library" className="m-0">
          <LibraryPane />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Insights handoff bar ─────────────────────────────────────────────────
function InsightsHandoffBar({ onOpened }: { onOpened: () => void }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const startThread = useMutation({
    mutationFn: async (seedTopic: string) => {
      const res = await apiRequest("POST", "/api/valueiq/threads", { title: seedTopic });
      const thread = await res.json();
      // Seed a user message that primes DNA with the dashboard context.
      await apiRequest("POST", `/api/valueiq/threads/${thread.id}/messages`, {
        content: `I just opened the AI Intelligence dashboard. ${seedTopic}. Use my CRM data to walk me through what to focus on first.`,
      }).catch(() => {/* SSE — fire and forget */});
      return thread.id as string;
    },
    onSuccess: (threadId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] });
      setLocation(`/valueiq?tab=threads&thread=${threadId}`);
      onOpened();
      toast({ title: "Started a new ValueIQ thread" });
    },
    onError: () => toast({ title: "Couldn't start thread", variant: "destructive" }),
  });
  const quickPrompts = [
    "Walk me through today's top insights",
    "Which accounts need a touchpoint this week?",
    "What's our biggest expansion opportunity right now?",
  ];
  return (
    <Card className="mb-4 border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
      <CardContent className="p-3 flex flex-col sm:flex-row gap-2 sm:items-center">
        <div className="flex-1 text-sm">
          <span className="font-medium">Discuss in ValueIQ:</span>{" "}
          <span className="text-muted-foreground">turn any insight into a working thread with DNA.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {quickPrompts.map((p) => (
            <Button key={p} size="sm" variant="outline"
              data-testid={`button-discuss-${p.slice(0, 12).replace(/\s+/g, "-").toLowerCase()}`}
              disabled={startThread.isPending}
              onClick={() => startThread.mutate(p)}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />{p}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Threads pane ──────────────────────────────────────────────────────────
function ThreadsPane() {
  const { toast } = useToast();
  const [activeId, setActiveId] = useState<string | null>(null);
  const threadsQ = useQuery<ThreadRow[]>({ queryKey: ["/api/valueiq/threads"] });
  const projectsQ = useQuery<ProjectRow[]>({ queryKey: ["/api/valueiq/projects"] });
  const agentsQ = useQuery<AgentRow[]>({ queryKey: ["/api/valueiq/agents"] });

  useEffect(() => {
    if (!activeId && threadsQ.data && threadsQ.data.length > 0) setActiveId(threadsQ.data[0].id);
  }, [threadsQ.data, activeId]);

  const createThread = useMutation({
    mutationFn: () => apiRequest("POST", "/api/valueiq/threads", { title: "New thread" }).then(r => r.json()),
    onSuccess: (row: ThreadRow) => {
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] });
      setActiveId(row.id);
    },
  });

  const archiveThread = useMutation({
    mutationFn: (id: string) => apiRequest("PATCH", `/api/valueiq/threads/${id}`, { archived: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] }),
  });
  const pinThread = useMutation({
    mutationFn: (t: ThreadRow) => apiRequest("PATCH", `/api/valueiq/threads/${t.id}`, { pinned: !t.pinned }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] }),
  });

  const active = threadsQ.data?.find(t => t.id === activeId) ?? null;

  return (
    <div className="grid grid-cols-12 gap-4 h-[calc(100vh-200px)] min-h-[600px]">
      <div className="col-span-3 border rounded-md flex flex-col min-h-0">
        <div className="p-2 border-b">
          <Button size="sm" className="w-full" onClick={() => createThread.mutate()} disabled={createThread.isPending} data-testid="button-new-thread">
            <Plus className="h-4 w-4 mr-1" /> New thread
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {threadsQ.isLoading && <div className="text-xs text-muted-foreground p-2">Loading…</div>}
            {threadsQ.data?.length === 0 && <div className="text-xs text-muted-foreground p-2">No threads yet — start one to talk to DNA.</div>}
            {threadsQ.data?.map(t => (
              <div
                key={t.id}
                onClick={() => setActiveId(t.id)}
                className={`p-2 rounded-md cursor-pointer text-sm ${activeId === t.id ? "bg-accent" : "hover:bg-muted"}`}
                data-testid={`thread-item-${t.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-medium">{t.title}</div>
                  {t.pinned && <Pin className="h-3 w-3 text-amber-500 shrink-0" />}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleDateString() : "Just created"}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      <div className="col-span-9 border rounded-md flex flex-col min-h-0">
        {active ? (
          <ThreadView
            thread={active}
            agents={agentsQ.data ?? []}
            onPin={() => pinThread.mutate(active)}
            onArchive={() => archiveThread.mutate(active.id)}
          />
        ) : (
          <div className="flex-1 grid place-items-center text-sm text-muted-foreground">Pick a thread or start a new one.</div>
        )}
      </div>
    </div>
  );
}

function ThreadView({ thread, agents, onPin, onArchive }: { thread: ThreadRow; agents: AgentRow[]; onPin: () => void; onArchive: () => void; }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [agentId, setAgentId] = useState<string>("");
  const [pendingAttIds, setPendingAttIds] = useState<string[]>([]);
  const [pendingAttNames, setPendingAttNames] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setStreaming(""); setDraft(""); setPendingAttIds([]); setPendingAttNames([]); }, [thread.id]);
  useEffect(() => {
    if (!agentId && agents.length > 0) {
      setAgentId(thread.defaultAgentId ?? agents.find(a => a.isDefault)?.id ?? agents[0].id);
    }
  }, [agents, thread, agentId]);

  const messagesQ = useQuery<MessageRow[]>({
    queryKey: ["/api/valueiq/threads", thread.id, "messages"],
    queryFn: () => fetch(`/api/valueiq/threads/${thread.id}/messages`, { credentials: "include" }).then(r => r.json()),
  });

  useEffect(() => {
    requestAnimationFrame(() => {
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
    });
  }, [messagesQ.data?.length, streaming]);

  const send = async () => {
    const content = draft.trim();
    if (!content || isSending) return;
    setIsSending(true);
    setStreaming("");
    const attachmentIds = pendingAttIds.slice();
    setDraft("");
    setPendingAttIds([]);
    setPendingAttNames([]);
    try {
      const res = await fetch(`/api/valueiq/threads/${thread.id}/messages`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, agentId, attachmentIds }),
      });
      if (!res.ok || !res.body) throw new Error("send failed");
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
        for (const p of parts) {
          if (!p.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(p.slice(6));
            if (ev.content) setStreaming(prev => prev + ev.content);
            if (ev.error) toast({ title: "Agent error", description: ev.error, variant: "destructive" });
          } catch {}
        }
      }
    } catch (err: any) {
      toast({ title: "Send failed", description: err.message ?? "Try again", variant: "destructive" });
    } finally {
      setIsSending(false);
      setStreaming("");
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads", thread.id, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] });
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try {
      const res = await fetch(`/api/valueiq/threads/${thread.id}/attach`, { method: "POST", credentials: "include", body: fd });
      const json = await res.json();
      if (json.id) {
        setPendingAttIds(p => [...p, json.id]);
        setPendingAttNames(p => [...p, f.name]);
      }
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      e.target.value = "";
    }
  };

  const rateMsg = useMutation({
    mutationFn: ({ id, rating }: { id: string; rating: number }) => apiRequest("PATCH", `/api/valueiq/messages/${id}`, { rating }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads", thread.id, "messages"] }),
  });
  const saveToLib = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/valueiq/messages/${id}/save`, { target: "library" }),
    onSuccess: () => toast({ title: "Saved to Library" }),
  });

  return (
    <>
      <div className="border-b p-3 flex items-center gap-3">
        <div className="font-semibold truncate flex-1" data-testid="text-thread-title">{thread.title}</div>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="w-[200px] h-8" data-testid="select-thread-agent"><SelectValue placeholder="Agent" /></SelectTrigger>
          <SelectContent>
            {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}{a.isDefault ? " (default)" : ""}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="icon" variant="ghost" onClick={onPin} title={thread.pinned ? "Unpin" : "Pin"} data-testid="button-pin-thread">
          <Pin className={`h-4 w-4 ${thread.pinned ? "text-amber-500 fill-amber-500" : ""}`} />
        </Button>
        <Button size="icon" variant="ghost" onClick={onArchive} title="Archive" data-testid="button-archive-thread"><Archive className="h-4 w-4" /></Button>
      </div>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messagesQ.data?.map(m => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
              {m.role !== "user" && m.agentName && <div className="text-xs font-semibold mb-1 opacity-80">{m.agentName}</div>}
              <div className="whitespace-pre-wrap text-sm">{m.content}</div>
              {m.role === "assistant" && (
                <div className="flex items-center gap-1 mt-2 opacity-70 hover:opacity-100">
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => rateMsg.mutate({ id: m.id, rating: m.rating === 1 ? 0 : 1 })} data-testid={`button-rate-up-${m.id}`}>
                    <ThumbsUp className={`h-3 w-3 ${m.rating === 1 ? "text-emerald-500" : ""}`} />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => rateMsg.mutate({ id: m.id, rating: m.rating === -1 ? 0 : -1 })} data-testid={`button-rate-down-${m.id}`}>
                    <ThumbsDown className={`h-3 w-3 ${m.rating === -1 ? "text-rose-500" : ""}`} />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => saveToLib.mutate(m.id)} title="Save to Library" data-testid={`button-save-lib-${m.id}`}>
                    <BookMarked className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-3 py-2 bg-muted">
              <div className="whitespace-pre-wrap text-sm">{streaming}<span className="animate-pulse">▍</span></div>
            </div>
          </div>
        )}
      </div>

      <div className="border-t p-3 space-y-2">
        {pendingAttNames.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pendingAttNames.map((n, i) => <Badge key={i} variant="secondary" data-testid={`badge-att-${i}`}><Paperclip className="h-3 w-3 mr-1" />{n}</Badge>)}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input ref={fileInputRef} type="file" className="hidden" onChange={onFile} accept=".txt,.md,.csv,.json,.log,text/*" />
          <Button size="icon" variant="ghost" onClick={() => fileInputRef.current?.click()} title="Attach file" data-testid="button-attach"><Paperclip className="h-4 w-4" /></Button>
          <Textarea
            value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask anything about your accounts, lanes, contacts…"
            className="min-h-[44px] max-h-[200px] resize-none" rows={1}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            data-testid="input-thread-draft"
          />
          <Button onClick={send} disabled={isSending || !draft.trim()} data-testid="button-send-thread">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

// ─── Library pane ──────────────────────────────────────────────────────────
function LibraryPane() {
  const { toast } = useToast();
  const itemsQ = useQuery<LibraryRow[]>({ queryKey: ["/api/valueiq/library"] });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [search, setSearch] = useState("");
  const add = useMutation({
    mutationFn: () => apiRequest("POST", "/api/valueiq/library", { kind: "memory", title, body }),
    onSuccess: () => {
      setTitle(""); setBody("");
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/library"] });
      toast({ title: "Saved to Library" });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/valueiq/library/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/valueiq/library"] }),
  });

  const filtered = (itemsQ.data ?? []).filter(it =>
    !search || it.title.toLowerCase().includes(search.toLowerCase()) || (it.body ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12 lg:col-span-4">
        <CardHeader><CardTitle className="text-base">Add to Library</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} data-testid="input-lib-title" />
          <Textarea placeholder="Memory, fact, snippet…" value={body} onChange={e => setBody(e.target.value)} className="min-h-[120px]" data-testid="input-lib-body" />
          <Button className="w-full" onClick={() => add.mutate()} disabled={!title.trim() || add.isPending} data-testid="button-lib-save">Save</Button>
          <p className="text-xs text-muted-foreground">Anything saved here becomes part of your personal context — DNA will recall it across threads.</p>
        </CardContent>
      </Card>
      <Card className="col-span-12 lg:col-span-8">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">My Library ({filtered.length})</CardTitle>
          <Input placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} className="w-48 h-8" data-testid="input-lib-search" />
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[60vh]">
            <div className="space-y-2 pr-2">
              {filtered.length === 0 && <div className="text-sm text-muted-foreground py-8 text-center">No items yet.</div>}
              {filtered.map(it => (
                <div key={it.id} className="border rounded-md p-3" data-testid={`library-item-${it.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm truncate">{it.title}</span>
                        <Badge variant="outline" className="text-xs">{it.kind}</Badge>
                      </div>
                      {it.body && <div className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-3">{it.body}</div>}
                      <div className="text-xs text-muted-foreground mt-1">{new Date(it.createdAt).toLocaleString()}</div>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => del.mutate(it.id)} data-testid={`button-lib-del-${it.id}`}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
