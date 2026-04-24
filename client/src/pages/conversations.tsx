import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { QueryError } from "@/components/query-error";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  AlertTriangle,
  Search,
  X,
  Menu,
  Rows3,
  Rows2,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BucketSidebar } from "@/components/conversations/bucket-sidebar";
import { ThreadList } from "@/components/conversations/thread-list";
import { ThreadDetailPane, EmptyDetailPane } from "@/components/conversations/thread-detail-pane";
import { RepFilterCombobox } from "@/components/conversations/rep-filter-combobox";
import { CaptureAuditStatusPill } from "@/components/conversations/capture-audit-status-pill";
import type {
  ConversationBucket,
  ConversationDensity,
  ConversationThread,
  ThreadsResponse,
} from "@/components/conversations/types";
import { parseBucket } from "@/components/conversations/types";

// Re-export legacy public surface so unrelated importers still work.
// (Some debug pages and tests import the ConversationThread type from here.)
export type { ConversationThread } from "@/components/conversations/types";
export { ThreadDetailPanel } from "@/components/conversations/thread-detail-pane";

const DENSITY_KEY = "conversations:density";

function loadDensity(): ConversationDensity {
  if (typeof window === "undefined") return "comfortable";
  const v = window.localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfortable";
}

export default function ConversationsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const search = useSearch();

  // ── URL-driven state ──────────────────────────────────────────────────────
  const urlParams = useMemo(() => new URLSearchParams(search), [search]);
  const bucket: ConversationBucket = parseBucket(urlParams.get("bucket"));
  const selectedThreadId = urlParams.get("threadId");

  function updateUrl(updates: Record<string, string | null>) {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    setLocation(qs ? `/conversations?${qs}` : "/conversations", { replace: true });
  }

  function setBucket(b: ConversationBucket) {
    setAllThreads([]);
    setNextCursor(null);
    // Clearing the selected thread on bucket switch keeps the URL sane and
    // avoids a stale detail pane referencing a thread that's no longer in
    // the visible list.
    updateUrl({ bucket: b === "mine" ? null : b, threadId: null });
  }

  function setSelectedThread(thread: ConversationThread | null) {
    updateUrl({ threadId: thread?.threadId ?? null });
  }

  // ── Filters (kept as in-memory state — not part of shareable URLs) ────────
  const [filterState, setFilterState] = useState<string>("all");
  const [filterPriority, setFilterPriority] = useState<string>("all");
  const [filterOverdue, setFilterOverdue] = useState(false);
  const [filterRep, setFilterRep] = useState<string>("all");

  const [archiveSearch, setArchiveSearch] = useState("");
  const [archiveDateFrom, setArchiveDateFrom] = useState("");
  const [archiveDateTo, setArchiveDateTo] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(archiveSearch), 400);
    return () => clearTimeout(t);
  }, [archiveSearch]);

  // ── Density (per-user via localStorage) ───────────────────────────────────
  const [density, setDensity] = useState<ConversationDensity>(loadDensity);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DENSITY_KEY, density);
  }, [density]);

  // ── Pagination state — accumulated as the user clicks "Load more" ─────────
  const [allThreads, setAllThreads] = useState<ConversationThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Mobile drawer for the bucket sidebar (lg+ shows it as a real pane).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // ── Build the params for the active bucket + filters ──────────────────────
  function buildParams(cursorParam?: string): string {
    const p = new URLSearchParams();
    p.set("limit", "50");
    if (bucket === "mine" && user?.id) {
      p.set("ownerUserId", user.id);
      p.set("waitingState", "waiting_on_us");
    } else if (bucket === "unowned") {
      p.set("unowned", "true");
      p.set("waitingState", "waiting_on_us");
    } else if (bucket === "high_priority") {
      p.set("responsePriority", "high");
      p.set("waitingState", "waiting_on_us");
    } else if (bucket === "quote_requests") {
      p.set("signal", "quote_request");
    } else if (bucket === "archived") {
      p.set("archived", "true");
      if (debouncedSearch) p.set("search", debouncedSearch);
      if (archiveDateFrom) p.set("dateFrom", archiveDateFrom);
      if (archiveDateTo) p.set("dateTo", archiveDateTo);
    } else {
      // "all" — chronological firehose.
      p.set("sort", "recency");
      if (filterState !== "all") p.set("waitingState", filterState);
      if (filterPriority !== "all") p.set("responsePriority", filterPriority);
      if (filterOverdue) p.set("overdue", "true");
    }
    if (bucket !== "mine" && bucket !== "unowned" && filterRep !== "all") {
      if (filterRep === "unassigned") p.set("unowned", "true");
      else p.set("team", filterRep);
    }
    if (cursorParam) p.set("cursor", cursorParam);
    return p.toString();
  }

  const { data, isLoading, isError, refetch } = useQuery<ThreadsResponse>({
    queryKey: [
      "/api/internal/conversations",
      bucket,
      filterState,
      filterPriority,
      filterOverdue,
      filterRep,
      debouncedSearch,
      archiveDateFrom,
      archiveDateTo,
    ],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?${buildParams()}`);
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
  });

  useEffect(() => {
    if (data) {
      setAllThreads(data.threads);
      setNextCursor(data.nextCursor);
    }
  }, [data]);

  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      if (!nextCursor) return null;
      const res = await fetch(`/api/internal/conversations?${buildParams(nextCursor)}`);
      if (!res.ok) throw new Error("Failed to load more");
      return res.json() as Promise<ThreadsResponse>;
    },
    onSuccess: (result) => {
      if (result) {
        setAllThreads(prev => [...prev, ...result.threads]);
        setNextCursor(result.nextCursor);
      }
    },
    onError: () => toast({ title: "Failed to load more conversations", variant: "destructive" }),
  });

  // ── Per-bucket counts (lightweight 1-row queries) ─────────────────────────
  const { data: mineData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "mine-count", user?.id],
    queryFn: async () => {
      const p = new URLSearchParams({ waitingState: "waiting_on_us", limit: "1" });
      if (user?.id) p.set("ownerUserId", user.id);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    enabled: !!user?.id,
  });

  const { data: unownedData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "unowned-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?unowned=true&waitingState=waiting_on_us&limit=1");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const { data: highPriData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "high-priority-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?responsePriority=high&waitingState=waiting_on_us&limit=1");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const { data: quoteData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "quote-request-count"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations?signal=quote_request&waitingState=waiting_on_us&limit=1");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });

  const counts: Partial<Record<ConversationBucket, number>> = {
    mine: mineData?.count,
    unowned: unownedData?.count,
    high_priority: highPriData?.count,
    quote_requests: quoteData?.count,
  };

  // ── Reps for the filter combobox ──────────────────────────────────────────
  const { data: repsData = [] } = useQuery<Array<{ id: string; name: string; username: string; role: string }>>({
    queryKey: ["/api/users?includeManagers=true"],
  });
  const sortedReps = useMemo(
    () => [...repsData]
      .map(r => ({ id: r.id, fullName: r.name || r.username, email: r.username }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    [repsData]
  );

  // ── Mutations on threads ──────────────────────────────────────────────────
  const assignToMeMutation = useMutation({
    mutationFn: async (threadRecordId: string) => {
      if (!user?.id) throw new Error("Not logged in");
      return apiRequest("POST", `/api/internal/conversations/${threadRecordId}/owner`, { ownerUserId: user.id });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation assigned to you" });
    },
    onError: () => toast({ title: "Failed to assign conversation", variant: "destructive" }),
  });

  const changeStateMutation = useMutation({
    mutationFn: async ({ id, state }: { id: string; state: ConversationThread["waitingState"] }) => {
      return apiRequest("POST", `/api/internal/conversations/${id}/waiting-state`, { waitingState: state });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation updated" });
    },
    onError: () => toast({ title: "Failed to update conversation", variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: async (threadRecordId: string) => {
      return apiRequest("POST", `/api/internal/conversations/${threadRecordId}/archive`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation archived" });
    },
    onError: () => toast({ title: "Failed to archive conversation", variant: "destructive" }),
  });

  // ── Thread sorting (mirrors the server's intent per bucket) ───────────────
  const sorted = useMemo(() => {
    const arr = [...allThreads];
    arr.sort((a, b) => {
      if (bucket === "archived") {
        const aDate = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
        const bDate = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
        return bDate - aDate;
      }
      if (bucket === "all") {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      const aOverdue = !!a.overdueAt;
      const bOverdue = !!b.overdueAt;
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      if (a.waitingSinceAt && b.waitingSinceAt) {
        return new Date(a.waitingSinceAt).getTime() - new Date(b.waitingSinceAt).getTime();
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return arr;
  }, [allThreads, bucket]);

  // ── Resolve the selected thread:
  //   1) Look up in the loaded list. If found we're done.
  //   2) If we have a threadId from the URL but no match (deep link to a
  //      thread the current bucket excludes), fetch a single-thread page.
  // This is what makes URL-deep-linking work across buckets / new sessions.
  const directMatch = selectedThreadId
    ? sorted.find(t => t.threadId === selectedThreadId) ?? null
    : null;

  const { data: deepLinkData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "deep-link", selectedThreadId],
    queryFn: async () => {
      const p = new URLSearchParams({ threadId: selectedThreadId!, limit: "1" });
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    enabled: !!selectedThreadId && !directMatch,
    staleTime: 30_000,
  });

  const selectedThread: ConversationThread | null =
    directMatch ?? deepLinkData?.threads?.[0] ?? null;

  return (
    <div
      className="flex flex-col bg-background h-[calc(100dvh-3.5rem-3.5rem)] md:h-[calc(100dvh-3.5rem)]"
      data-testid="conversations-page"
    >
      {/* Top header strip — title, total count, mobile bucket trigger, density toggle */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                data-testid="button-mobile-buckets"
                aria-label="Open buckets"
              >
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetHeader className="px-4 py-3 border-b">
                <SheetTitle className="text-base">Conversations</SheetTitle>
              </SheetHeader>
              <BucketSidebar
                bucket={bucket}
                onChange={(b) => { setBucket(b); setMobileNavOpen(false); }}
                counts={counts}
              />
            </SheetContent>
          </Sheet>
          <MessageSquare className="w-5 h-5 text-primary shrink-0" />
          <h1 className="text-base md:text-lg font-semibold truncate">Conversations</h1>
          <Badge variant="secondary" className="text-xs" data-testid="badge-total-count">
            {data?.count ?? "—"}
          </Badge>
          {/* Task #536 — capture-audit health pill. Always-visible
              indicator of the email capture pipeline scoped to threads
              the current rep can see. Click to open the diagnostics /
              affected-thread panel. */}
          <CaptureAuditStatusPill
            onOpenThread={(threadId) => updateUrl({ threadId })}
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => setDensity(density === "comfortable" ? "compact" : "comfortable")}
            data-testid="button-density-toggle"
            title={`Switch to ${density === "comfortable" ? "compact" : "comfortable"} density`}
          >
            {density === "comfortable" ? <Rows3 className="w-3.5 h-3.5" /> : <Rows2 className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{density === "comfortable" ? "Comfortable" : "Compact"}</span>
          </Button>
        </div>
      </div>

      {/* Three-pane grid (lg+).
          On mobile we stack: list takes full width and the detail pane takes
          over (with a back button) when a thread is selected. */}
      <div className="flex-1 flex min-h-0">
        {/* Left — bucket sidebar (desktop only) */}
        <aside className="hidden lg:flex w-60 shrink-0 border-r bg-muted/20 flex-col" data-testid="left-pane">
          <BucketSidebar bucket={bucket} onChange={setBucket} counts={counts} />
        </aside>

        {/* Middle — thread list */}
        <section
          className={cn(
            "flex flex-col min-w-0 border-r bg-background",
            // On mobile: hide the list while a detail pane is open.
            selectedThread ? "hidden lg:flex" : "flex flex-1 lg:flex-1",
            // On desktop the middle pane has a fixed-ish ideal width when
            // the right pane is also visible; otherwise it flexes.
            selectedThread ? "lg:w-[420px] lg:shrink-0" : ""
          )}
          data-testid="middle-pane"
        >
          {/* Filters bar */}
          <div className="px-3 py-2 border-b shrink-0 flex flex-wrap items-center gap-2 bg-muted/10">
            {bucket !== "mine" && bucket !== "unowned" && (
              <RepFilterCombobox value={filterRep} onChange={setFilterRep} users={sortedReps} />
            )}

            {bucket === "all" && (
              <>
                <Select value={filterState} onValueChange={setFilterState}>
                  <SelectTrigger className="h-8 w-36 text-xs" data-testid="select-filter-state">
                    <SelectValue placeholder="Waiting state" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All states</SelectItem>
                    <SelectItem value="waiting_on_us">Waiting on us</SelectItem>
                    <SelectItem value="waiting_on_them">Waiting on them</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filterPriority} onValueChange={setFilterPriority}>
                  <SelectTrigger className="h-8 w-32 text-xs" data-testid="select-filter-priority">
                    <SelectValue placeholder="Priority" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All priorities</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant={filterOverdue ? "default" : "outline"}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setFilterOverdue(!filterOverdue)}
                  data-testid="button-filter-overdue"
                >
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  Overdue only
                </Button>
              </>
            )}

            {bucket === "archived" && (
              <>
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search account, carrier, or subject…"
                    value={archiveSearch}
                    onChange={(e) => setArchiveSearch(e.target.value)}
                    className="pl-8 h-8 text-xs"
                    data-testid="input-archive-search"
                  />
                </div>
                <Input
                  type="date"
                  value={archiveDateFrom}
                  onChange={(e) => setArchiveDateFrom(e.target.value)}
                  className="w-36 h-8 text-xs"
                  data-testid="input-archive-date-from"
                />
                <Input
                  type="date"
                  value={archiveDateTo}
                  onChange={(e) => setArchiveDateTo(e.target.value)}
                  className="w-36 h-8 text-xs"
                  data-testid="input-archive-date-to"
                />
                {(archiveSearch || archiveDateFrom || archiveDateTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      setArchiveSearch("");
                      setDebouncedSearch("");
                      setArchiveDateFrom("");
                      setArchiveDateTo("");
                    }}
                    data-testid="button-clear-archive-filters"
                  >
                    <X className="w-3 h-3 mr-1" />
                    Clear
                  </Button>
                )}
              </>
            )}
          </div>

          {/* Scrollable thread list */}
          <div className="flex-1 overflow-y-auto" data-testid="thread-list-scroll">
            {isError ? (
              <QueryError
                message="Couldn't load conversations. This is usually temporary."
                onRetry={() => refetch()}
              />
            ) : (
              <ThreadList
                threads={sorted}
                isLoading={isLoading}
                density={density}
                bucket={bucket}
                selectedThreadId={selectedThreadId}
                onSelect={setSelectedThread}
                onAssignToMe={(id) => assignToMeMutation.mutate(id)}
                onChangeState={(id, state) => changeStateMutation.mutate({ id, state })}
                onArchive={(id) => archiveMutation.mutate(id)}
                hasMore={!!nextCursor}
                onLoadMore={() => loadMoreMutation.mutate()}
                isFetchingMore={loadMoreMutation.isPending}
              />
            )}
          </div>
        </section>

        {/* Right — detail pane.
            Mobile: takes over when a thread is selected.
            Desktop (lg+): always-visible third pane. */}
        <section
          className={cn(
            "flex-1 min-w-0",
            selectedThread ? "flex" : "hidden lg:flex"
          )}
          data-testid="right-pane"
        >
          {selectedThread ? (
            <ThreadDetailPane
              key={selectedThread.id}
              thread={selectedThread}
              showBackButton
              onBack={() => setSelectedThread(null)}
            />
          ) : (
            <EmptyDetailPane />
          )}
        </section>
      </div>
    </div>
  );
}
