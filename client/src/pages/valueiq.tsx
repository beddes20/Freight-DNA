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
import { recordAiEvent } from "@/lib/aiTelemetry";

// Lightweight inline renderer that linkifies markdown-style [text](href) and
// bare URLs. Keeps line breaks via whitespace-pre-wrap on the parent and adds
// nothing else fancy — enough for clickable deep-links in seeded briefings.
function MessageContent({ content }: { content: string }) {
  const nodes: (string | { href: string; label: string })[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]+)\)|((?:https?:\/\/)[^\s)]+)/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) nodes.push(content.slice(last, m.index));
    if (m[1] && m[2]) nodes.push({ href: m[2], label: m[1] });
    else if (m[3]) nodes.push({ href: m[3], label: m[3] });
    last = re.lastIndex;
  }
  if (last < content.length) nodes.push(content.slice(last));
  return (
    <div className="whitespace-pre-wrap text-sm">
      {nodes.map((n, i) => typeof n === "string" ? <span key={i}>{n}</span> : (
        <a key={i} href={n.href} className="underline text-primary hover:opacity-80"
          target={n.href.startsWith("http") ? "_blank" : undefined}
          rel={n.href.startsWith("http") ? "noopener noreferrer" : undefined}>{n.label}</a>
      ))}
    </div>
  );
}

interface AgentRow { id: string; slug: string; name: string; description: string | null; isDefault: boolean; }
interface ProjectRow { id: string; name: string; pinnedContext: string | null; }
interface ThreadRow { id: string; title: string; pinned: boolean; archivedAt: string | null; lastMessageAt: string | null; createdAt: string; defaultAgentId: string | null; projectId: string | null; }
interface MessageRow { id: string; role: string; content: string; agentName: string | null; rating: number | null; createdAt: string; }
interface LibraryRow { id: string; kind: string; title: string; body: string | null; createdAt: string; metadata?: Record<string, unknown> | null; }

interface AccountReviewThreadMessage {
  id: string; role: "user" | "assistant" | "system"; content: string; createdAt: string;
}

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
  // Task #700 — surface impression on mount + click event when the user
  // switches tabs so admin AI Engagement console can see per-feature usage.
  useEffect(() => {
    recordAiEvent({ surface: "valueiq", eventType: "impression", feature: tab });
  }, []); // intentionally only on mount
  const handleTabChange = (next: string) => {
    setTab(next);
    recordAiEvent({ surface: "valueiq", eventType: "click", feature: next });
  };
  return (
    <div className="container mx-auto p-4 md:p-6 max-w-[1400px]">
      <div className="mb-4 flex items-center gap-3">
        <Sparkles className="h-6 w-6 text-amber-500" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-valueiq-title">ValueIQ</h1>
          <p className="text-sm text-muted-foreground">Your AI workspace — insights, threads, and personal library, grounded in your CRM data.</p>
        </div>
      </div>
      <Tabs value={tab} onValueChange={handleTabChange}>
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
  const [search, setSearch] = useState("");
  const threadsQ = useQuery<ThreadRow[]>({ queryKey: ["/api/valueiq/threads"] });
  const projectsQ = useQuery<ProjectRow[]>({ queryKey: ["/api/valueiq/projects"] });
  const agentsQ = useQuery<AgentRow[]>({ queryKey: ["/api/valueiq/agents"] });
  // Honest connector-health snapshot — re-checked when the tab regains focus.
  // Refetches every 60s; never throws to the UI (see banner below).
  const healthQ = useQuery<{ degraded: boolean; providers: Record<string, { ok: boolean; configured?: boolean; error?: string }> }>({
    queryKey: ["/api/valueiq/health"],
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const renameThread = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiRequest("PATCH", `/api/valueiq/threads/${id}`, { title }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] }),
  });
  const createProject = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/valueiq/projects", { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/valueiq/projects"] }),
  });

  useEffect(() => {
    // Honor ?thread=<id> deep-link from the Insights handoff bar.
    const sp = new URLSearchParams(window.location.search);
    const requested = sp.get("thread");
    if (requested && threadsQ.data?.some((t) => t.id === requested)) {
      setActiveId(requested);
      return;
    }
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

  // Prefetch the very first thread's messages alongside the threads list so
  // the chat panel renders immediately on the next paint instead of waiting
  // for a second sequential round-trip after threadsQ resolves.
  useEffect(() => {
    const first = threadsQ.data?.[0];
    if (!first) return;
    queryClient.prefetchQuery({
      queryKey: ["/api/valueiq/threads", first.id, "messages"],
      // Use a strict fetcher (matches the default getQueryFn behavior): throw
      // on non-OK so a 401/500 doesn't poison the cache with `{error}` and
      // crash `messagesQ.data?.map` on the next render.
      queryFn: async () => {
        const r = await fetch(`/api/valueiq/threads/${first.id}/messages`, { credentials: "include" });
        if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
        return r.json();
      },
    });
  }, [threadsQ.data]);

  // Split degradation into "core" (db/embedder/sonar/openai — chat is meaningfully
  // impaired) vs "advisory" (eia/fmcsa/websearch/anthropic — only fuel/market-side
  // answers may be thin; the chat itself works fine for everything else).
  // Mirrors the server-side `degraded` flag in /api/valueiq/health.
  const ADVISORY_PROVIDERS = new Set(["eia", "fmcsa", "websearch", "anthropic"]);
  const downCore: string[] = [];
  const downAdvisory: string[] = [];
  if (healthQ.data?.providers) {
    for (const [name, info] of Object.entries(healthQ.data.providers)) {
      if (info.ok || info.configured === false) continue;
      if (ADVISORY_PROVIDERS.has(name)) downAdvisory.push(name);
      else downCore.push(name);
    }
  }
  const coreDegraded = !!healthQ.data?.degraded || downCore.length > 0;
  const advisoryOnly = !coreDegraded && downAdvisory.length > 0;
  const showHealthBanner = coreDegraded || advisoryOnly;
  const bannerText = coreDegraded
    ? (downCore.length
        ? `${downCore.join(", ")} ${downCore.length === 1 ? "is" : "are"} degraded — answers may be thin or unavailable.`
        : "Some core providers are degraded right now — answers may be thin.")
    : `${downAdvisory.join(", ")} ${downAdvisory.length === 1 ? "is" : "are"} unavailable — only related answers may be limited. The chat works normally for everything else.`;
  const bannerClass = coreDegraded
    ? "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-700"
    : "border-muted-foreground/30 bg-muted/40 text-muted-foreground";

  return (
    <div className="grid grid-cols-12 gap-4 h-[calc(100vh-200px)] min-h-[600px]">
      {showHealthBanner && (
        <div
          className={`col-span-12 -mb-2 px-3 py-2 text-xs rounded-md border ${bannerClass}`}
          data-testid="banner-valueiq-health"
        >
          <span className="font-medium">Heads up:</span> {bannerText}
        </div>
      )}
      <div className="col-span-3 border rounded-md flex flex-col min-h-0">
        <div className="p-2 border-b space-y-2">
          <Button size="sm" className="w-full" onClick={() => createThread.mutate()} disabled={createThread.isPending} data-testid="button-new-thread">
            <Plus className="h-4 w-4 mr-1" /> New thread
          </Button>
          <Input
            placeholder="Search threads…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
            data-testid="input-thread-search"
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Projects: {projectsQ.data?.length ?? 0}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              data-testid="button-new-project"
              onClick={() => {
                const name = window.prompt("New project name");
                if (name && name.trim()) createProject.mutate(name.trim());
              }}
            >
              <Plus className="h-3 w-3 mr-1" /> Project
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {threadsQ.isLoading && <div className="text-xs text-muted-foreground p-2">Loading…</div>}
            {threadsQ.data?.length === 0 && <div className="text-xs text-muted-foreground p-2">No threads yet — start one to talk to DNA.</div>}
            {threadsQ.data
              ?.filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()))
              .map((t) => (
              <div
                key={t.id}
                onClick={() => setActiveId(t.id)}
                onDoubleClick={() => {
                  const next = window.prompt("Rename thread", t.title);
                  if (next && next.trim() && next.trim() !== t.title) {
                    renameThread.mutate({ id: t.id, title: next.trim() });
                  }
                }}
                className={`p-2 rounded-md cursor-pointer text-sm ${activeId === t.id ? "bg-accent" : "hover:bg-muted"}`}
                data-testid={`thread-item-${t.id}`}
                title="Double-click to rename"
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
  // Tracks the current in-flight send so we can cancel on unmount or thread
  // switch — prevents the send button from staying disabled forever if the
  // user navigates away mid-stream.
  const sendAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setStreaming(""); setDraft(""); setPendingAttIds([]); setPendingAttNames([]);
    // Cancel any in-flight stream when switching threads.
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;
    setIsSending(false);
  }, [thread.id]);

  // Abort the in-flight stream when the component unmounts.
  useEffect(() => {
    return () => { sendAbortRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!agentId && agents.length > 0) {
      setAgentId(thread.defaultAgentId ?? agents.find(a => a.isDefault)?.id ?? agents[0].id);
    }
  }, [agents, thread, agentId]);

  // Use the default queryFn (which handles 401 by throwing instead of
  // returning {error: ...}) so a brief auth blip can't crash this view via
  // `messagesQ.data?.map` on a non-array.
  const messagesQ = useQuery<MessageRow[]>({
    queryKey: ["/api/valueiq/threads", thread.id, "messages"],
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

    // Hard safety net so the send button is never permanently stuck disabled
    // even if the network or server hangs. Server has its own 90s ceiling.
    const ac = new AbortController();
    sendAbortRef.current?.abort();
    sendAbortRef.current = ac;
    const safetyTimeout = setTimeout(() => ac.abort(), 95_000);

    let restoreDraftOnFailure = true;
    try {
      const res = await fetch(`/api/valueiq/threads/${thread.id}/messages`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, agentId, attachmentIds }),
        signal: ac.signal,
      });
      // Treat session expiry as a real, actionable signal rather than a vague
      // "send failed" toast — bounce to login so the user can re-auth.
      if (res.status === 401) {
        toast({ title: "Session expired", description: "Please sign in again to continue.", variant: "destructive" });
        if (!window.location.pathname.startsWith("/login")) {
          window.location.href = "/login";
        }
        return;
      }
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(txt || `Send failed (${res.status})`);
      }
      // We made it past the request boundary — the message is committed
      // server-side. Don't restore draft (it was sent).
      restoreDraftOnFailure = false;
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
    } catch (err: unknown) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : "Try again";
        toast({ title: "Send failed", description: msg, variant: "destructive" });
      }
      // Restore the user's typed message so they don't have to retype it
      // after a network error or timeout. (If we got past the POST boundary
      // the message was already committed server-side, so keep it cleared.)
      if (restoreDraftOnFailure) {
        setDraft((prev) => prev || content);
        setPendingAttIds(attachmentIds);
      }
    } finally {
      clearTimeout(safetyTimeout);
      // Only finalize state if THIS send is still the active one. Prevents a
      // late-arriving finally from a thread switch / abort from clobbering a
      // newer in-flight send (would re-enable button mid-stream).
      if (sendAbortRef.current === ac) {
        sendAbortRef.current = null;
        setIsSending(false);
        setStreaming("");
      }
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
  const refreshToday = useMutation({
    mutationFn: () => apiRequest("POST", "/api/valueiq/today/refresh"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads", thread.id, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/threads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/today"] });
      toast({ title: "Today briefing refreshed" });
    },
    onError: () => toast({ title: "Couldn't refresh briefing", variant: "destructive" }),
  });
  // Server is the source of truth for today's title (computed in the org's
  // configured timezone). The current-day thread is the only one refreshable.
  const { data: todayMeta } = useQuery<{ enabled: boolean; threadId: string | null; title?: string }>({
    queryKey: ["/api/valueiq/today"],
    staleTime: 60_000,
  });
  const isTodayThread = !!todayMeta?.title && thread.title === todayMeta.title;

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
        {isTodayThread && (
          <Button size="sm" variant="outline" onClick={() => refreshToday.mutate()}
            disabled={refreshToday.isPending} data-testid="button-refresh-today">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />Refresh Today
          </Button>
        )}
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
              <MessageContent content={m.content} />
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
          <input ref={fileInputRef} type="file" className="hidden" onChange={onFile} accept=".txt,.md,.csv,.json,.log,.pdf,.xlsx,.xls,text/*,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
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
  const uploadRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const add = useMutation({
    mutationFn: () => apiRequest("POST", "/api/valueiq/library", { kind: "memory", title, body }),
    onSuccess: () => {
      setTitle(""); setBody("");
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/library"] });
      toast({ title: "Saved to Library" });
    },
  });
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/valueiq/library/upload", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      queryClient.invalidateQueries({ queryKey: ["/api/valueiq/library"] });
      toast({ title: `Uploaded ${file.name} to Library` });
    } catch (err) {
      toast({ title: "Upload failed", description: String(err), variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };
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
          <div className="pt-2 border-t">
            <input
              ref={uploadRef}
              type="file"
              className="hidden"
              onChange={onUpload}
              accept=".txt,.md,.csv,.json,.log,.pdf,.xlsx,.xls,text/*,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            />
            <Button
              variant="outline"
              className="w-full"
              onClick={() => uploadRef.current?.click()}
              disabled={isUploading}
              data-testid="button-lib-upload"
            >
              <Paperclip className="h-4 w-4 mr-2" />{isUploading ? "Uploading…" : "Upload file (PDF / Excel / text)"}
            </Button>
          </div>
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
                it.kind === "account-review"
                  ? <AccountReviewLibraryItem key={it.id} item={it} onDelete={() => del.mutate(it.id)} />
                  : (
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
                  )
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Account Review library card ───────────────────────────────────────────
// Opens the review inline with its full body, company/week metadata, and an
// inline follow-up thread that reuses /api/account-reviews/:id/follow-up.
function AccountReviewLibraryItem({ item, onDelete }: { item: LibraryRow; onDelete: () => void }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [followUp, setFollowUp] = useState("");

  const meta = (item.metadata ?? {}) as {
    companyId?: string;
    weekOf?: string;
    repName?: string;
    accountReviewId?: string;
  };

  // Resolve the canonical account review id from the library metadata. If the
  // writer didn't stamp it we fall back to looking it up by (companyId, weekOf).
  const reviewQ = useQuery<{ id: string; followUpThreadId: string | null } | null>({
    queryKey: ["/api/account-reviews/lookup-from-library", item.id, meta.accountReviewId, meta.companyId, meta.weekOf],
    enabled: expanded,
    queryFn: async () => {
      if (meta.accountReviewId) return { id: meta.accountReviewId, followUpThreadId: null };
      if (!meta.companyId) return null;
      const rows = await fetch(`/api/account-reviews/company/${meta.companyId}`, { credentials: "include" }).then(r => r.json());
      if (!Array.isArray(rows)) return null;
      const match = rows.find((r: { weekOf?: string }) => r.weekOf === meta.weekOf) || rows[0];
      return match ? { id: match.id, followUpThreadId: match.followUpThreadId ?? null } : null;
    },
  });
  const reviewId = reviewQ.data?.id ?? null;

  const threadQ = useQuery<{ threadId: string | null; messages: AccountReviewThreadMessage[] }>({
    queryKey: ["/api/account-reviews", reviewId, "follow-up"],
    enabled: !!reviewId && expanded,
    queryFn: async () => fetch(`/api/account-reviews/${reviewId}/follow-up`, { credentials: "include" }).then(r => r.json()),
  });

  const followUpMut = useMutation({
    mutationFn: async (message: string) => apiRequest("POST", `/api/account-reviews/${reviewId}/follow-up`, { message }),
    onSuccess: () => {
      setFollowUp("");
      queryClient.invalidateQueries({ queryKey: ["/api/account-reviews", reviewId, "follow-up"] });
      toast({ title: "Agent replied in thread" });
    },
    onError: (e: unknown) => toast({ title: "Follow-up failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }),
  });

  const conversation = (threadQ.data?.messages ?? [])
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(1); // drop the seeded review body

  return (
    <div className="border rounded-md p-3" data-testid={`library-item-${item.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-medium text-sm">{item.title}</span>
            <Badge variant="outline" className="text-xs">account review</Badge>
            {meta.weekOf && <Badge variant="secondary" className="text-xs">Week of {meta.weekOf}</Badge>}
            {meta.repName && <Badge variant="outline" className="text-xs">{meta.repName}</Badge>}
          </div>
          {!expanded && item.body && (
            <div className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-3">{item.body}</div>
          )}
          <div className="text-xs text-muted-foreground mt-1">{new Date(item.createdAt).toLocaleString()}</div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setExpanded(v => !v)}
            data-testid={`button-lib-open-${item.id}`}
          >
            {expanded ? "Close" : "Open"}
          </Button>
          <Button size="icon" variant="ghost" onClick={onDelete} data-testid={`button-lib-del-${item.id}`}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 space-y-3" data-testid={`library-review-detail-${item.id}`}>
          {item.body && (
            <pre
              className="whitespace-pre-wrap text-sm font-sans leading-relaxed border-t pt-3"
              data-testid={`library-review-body-${item.id}`}
            >
              {item.body}
            </pre>
          )}
          <div className="border-t pt-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Follow-up thread</div>
            {reviewQ.isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
            {!reviewQ.isLoading && !reviewId && (
              <div className="text-xs text-muted-foreground">Could not resolve the linked review.</div>
            )}
            {conversation.length > 0 && (
              <div className="space-y-2">
                {conversation.map(m => (
                  <div
                    key={m.id}
                    className={`text-sm rounded-md p-2 whitespace-pre-wrap ${m.role === "user" ? "bg-muted/50" : "bg-primary/5"}`}
                    data-testid={`lib-thread-msg-${m.id}`}
                  >
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5">
                      {m.role === "user" ? "You" : "Agent"}
                    </div>
                    {m.content}
                  </div>
                ))}
              </div>
            )}
            <Textarea
              rows={2}
              placeholder="Ask a follow-up about this review…"
              value={followUp}
              onChange={e => setFollowUp(e.target.value)}
              disabled={!reviewId}
              data-testid={`input-lib-follow-up-${item.id}`}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!reviewId || !followUp.trim() || followUpMut.isPending}
                onClick={() => followUpMut.mutate(followUp.trim())}
                data-testid={`button-lib-follow-up-${item.id}`}
              >
                {followUpMut.isPending ? "Asking…" : "Ask follow-up"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
