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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Calendar, ChevronDown } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
import { BulkActionBar } from "@/components/conversations/bulk-action-bar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Bookmark } from "lucide-react";
import type {
  ConversationBucket,
  ConversationDensity,
  ConversationGroupBy,
  ConversationThread,
  ThreadsResponse,
  SavedView,
  BulkActionResult,
} from "@/components/conversations/types";
import { parseBucket, buildGroups } from "@/components/conversations/types";

// Re-export legacy public surface so unrelated importers still work.
// (Some debug pages and tests import the ConversationThread type from here.)
export type { ConversationThread } from "@/components/conversations/types";
export { ThreadDetailPanel } from "@/components/conversations/thread-detail-pane";

const DENSITY_KEY = "conversations:density";
// Per-user persistence keys (Task #535) — scoped by authenticated user id so
// preferences don't bleed between users sharing the same browser profile.
const GROUP_BY_KEY_PREFIX = "conversations:groupBy:";
const COLLAPSED_GROUPS_KEY_PREFIX = "conversations:collapsedGroups:";
const AUDIENCE_KEY_PREFIX = "conversations:audience:";

function groupByKey(userId: string | null | undefined): string | null {
  return userId ? `${GROUP_BY_KEY_PREFIX}${userId}` : null;
}
function collapsedGroupsKey(userId: string | null | undefined): string | null {
  return userId ? `${COLLAPSED_GROUPS_KEY_PREFIX}${userId}` : null;
}
function audienceKey(userId: string | null | undefined): string | null {
  return userId ? `${AUDIENCE_KEY_PREFIX}${userId}` : null;
}

// "all" = both customer and carrier threads (default).
// "customers" = only threads linked to a customer account.
// "carriers"  = only threads linked to a carrier.
type ConversationAudience = "all" | "customers" | "carriers";

function loadAudience(userId: string | null | undefined): ConversationAudience {
  if (typeof window === "undefined") return "all";
  const k = audienceKey(userId);
  if (!k) return "all";
  const v = window.localStorage.getItem(k);
  return v === "customers" || v === "carriers" ? v : "all";
}

function loadDensity(): ConversationDensity {
  if (typeof window === "undefined") return "comfortable";
  const v = window.localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfortable";
}

function loadGroupBy(userId: string | null | undefined): ConversationGroupBy {
  if (typeof window === "undefined") return "none";
  const k = groupByKey(userId);
  if (!k) return "none";
  const v = window.localStorage.getItem(k);
  return v === "account" || v === "carrier" ? v : "none";
}

// Persisted collapsed-state is keyed by groupBy mode + group key so
// switching between Account / Carrier doesn't carry the wrong collapse
// state across to a different set of groups.
function loadCollapsedGroups(userId: string | null | undefined): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  const k = collapsedGroupsKey(userId);
  if (!k) return {};
  try {
    const raw = window.localStorage.getItem(k);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string[]>;
  } catch {
    // Corrupt JSON shouldn't take the page down — fall through to empty.
  }
  return {};
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
    // Switching buckets exits any active saved view — saved views always have
    // a single specific bucket, so the moment the user picks a different one
    // they're no longer "in" that view.
    setActiveSavedViewId(null);
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
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(archiveSearch), 400);
    return () => clearTimeout(t);
  }, [archiveSearch]);

  // ── Date range filter — shared across every bucket (Task #787) ────────────
  // Reps want to narrow any inbox bucket (Mine, Unowned, etc.) to a window of
  // recent activity, not just the Archived bucket. We keep a single source of
  // truth here and feed dateFrom/dateTo into every request + the React Query
  // key so changing the range refetches and resets pagination.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Inline validation: the UI guards against From > To by treating an
  // invalid range as "no date filter" so we never send a broken request.
  const isDateRangeInvalid = !!dateFrom && !!dateTo && dateFrom > dateTo;
  const effectiveDateFrom = isDateRangeInvalid ? "" : dateFrom;
  const effectiveDateTo = isDateRangeInvalid ? "" : dateTo;

  function fmtLocalDate(d: Date): string {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function applyDatePreset(preset: "today" | "last7" | "last30" | "thisMonth") {
    const today = new Date();
    const todayStr = fmtLocalDate(today);
    if (preset === "today") {
      setDateFrom(todayStr);
      setDateTo(todayStr);
    } else if (preset === "last7") {
      const from = new Date(today);
      from.setDate(today.getDate() - 6);
      setDateFrom(fmtLocalDate(from));
      setDateTo(todayStr);
    } else if (preset === "last30") {
      const from = new Date(today);
      from.setDate(today.getDate() - 29);
      setDateFrom(fmtLocalDate(from));
      setDateTo(todayStr);
    } else if (preset === "thisMonth") {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      setDateFrom(fmtLocalDate(from));
      setDateTo(todayStr);
    }
  }

  function clearDateRange() {
    setDateFrom("");
    setDateTo("");
  }

  // Whenever the *effective* date range changes, dump the accumulated thread
  // list and the pagination cursor so "Load more" can't blend pages from a
  // previous range with the new one. The query key change below also forces
  // a refetch — this just keeps the visible list consistent in the gap.
  useEffect(() => {
    setAllThreads([]);
    setNextCursor(null);
    // We intentionally don't include setAllThreads/setNextCursor in deps —
    // they're stable state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveDateFrom, effectiveDateTo]);

  // ── Density (per-user via localStorage) ───────────────────────────────────
  const [density, setDensity] = useState<ConversationDensity>(loadDensity);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DENSITY_KEY, density);
  }, [density]);

  // ── Group by (per-user via localStorage, Task #535) ───────────────────────
  // Persisted (per authenticated user id) so a rep doesn't have to re-set
  // their preferred grouping every time they reload the inbox, and
  // preferences from one user don't leak to another sharing a browser.
  const [groupBy, setGroupBy] = useState<ConversationGroupBy>(() => loadGroupBy(user?.id));
  // Audience (Customers / Carriers / Both) — same per-user persistence
  // pattern as groupBy. Defaults to "all" so directors/admins see the full
  // firehose on first load, but their last choice sticks across reloads.
  const [audience, setAudience] = useState<ConversationAudience>(() => loadAudience(user?.id));
  // Re-hydrate when the authenticated user becomes known after first render
  // (useAuth resolves async on initial mount).
  useEffect(() => {
    if (!user?.id) return;
    setGroupBy(loadGroupBy(user.id));
    setAudience(loadAudience(user.id));
    setCollapsedGroupsByMode(loadCollapsedGroups(user.id));
    // We intentionally only re-hydrate when the user identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const k = groupByKey(user?.id);
    if (!k) return;
    window.localStorage.setItem(k, groupBy);
  }, [groupBy, user?.id]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const k = audienceKey(user?.id);
    if (!k) return;
    window.localStorage.setItem(k, audience);
  }, [audience, user?.id]);
  // Switching audience invalidates the visible page — clear the local
  // accumulator and selection so the rep doesn't see stale rows from the
  // previous audience flash through before the refetch completes.
  function changeAudience(next: ConversationAudience) {
    if (next === audience) return;
    setAudience(next);
    setAllThreads([]);
    setNextCursor(null);
    setSelectedIds(new Set());
  }

  // Collapsed groups are persisted per (groupBy mode) key so the user's
  // expand/collapse state survives reloads. Default is "expanded" — the
  // collapsed set is the only thing we have to track.
  const [collapsedGroupsByMode, setCollapsedGroupsByMode] = useState<Record<string, string[]>>(() => loadCollapsedGroups(user?.id));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const k = collapsedGroupsKey(user?.id);
    if (!k) return;
    window.localStorage.setItem(k, JSON.stringify(collapsedGroupsByMode));
  }, [collapsedGroupsByMode, user?.id]);
  const collapsedGroupKeys = useMemo(
    () => new Set(collapsedGroupsByMode[groupBy] ?? []),
    [collapsedGroupsByMode, groupBy],
  );
  function toggleGroupCollapsed(key: string) {
    setCollapsedGroupsByMode(prev => {
      const current = new Set(prev[groupBy] ?? []);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      return { ...prev, [groupBy]: Array.from(current) };
    });
  }

  // ── Pagination state — accumulated as the user clicks "Load more" ─────────
  const [allThreads, setAllThreads] = useState<ConversationThread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Mobile drawer for the bucket sidebar (lg+ shows it as a real pane).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // ── Bulk selection state (Task #533) ──────────────────────────────────────
  // Selection is keyed by thread record id (db UUID), not threadId, because
  // bulk endpoints take db ids. Cleared when bucket / filters change so the
  // user can't accidentally apply an action to threads that scrolled out of
  // view.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── Saved views state (Task #533) ─────────────────────────────────────────
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(null);
  const [saveViewDialogOpen, setSaveViewDialogOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");

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
    } else if (bucket === "snoozed") {
      // Show only currently-snoozed threads. Sorted by snooze wake time
      // ascending on the server.
      p.set("snoozed", "true");
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
    // Audience filter (Customers / Carriers / Both). "all" is the default
    // so we only emit the param when the rep has narrowed it — keeps URLs
    // and request lines clean.
    if (audience !== "all") p.set("audience", audience);
    // Date range filter — applied on every bucket (Task #787). Uses the
    // *effective* values so an invalid (From > To) range is treated as
    // "no date filter" and never reaches the server.
    if (effectiveDateFrom) p.set("dateFrom", effectiveDateFrom);
    if (effectiveDateTo) p.set("dateTo", effectiveDateTo);
    if (cursorParam) p.set("cursor", cursorParam);
    return p.toString();
  }

  const { data, isLoading, isError, refetch } = useQuery<ThreadsResponse>({
    queryKey: [
      "/api/internal/conversations",
      bucket,
      audience,
      filterState,
      filterPriority,
      filterOverdue,
      filterRep,
      debouncedSearch,
      effectiveDateFrom,
      effectiveDateTo,
    ],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?${buildParams()}`);
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
    // Always-fresh: pull every 30s while the page is open, and force a refetch
    // the moment the user comes back to the tab. The backend webhook + 5-min
    // poll keep messages flowing into the DB; without this the page would
    // happily display 30-minute-stale rows after any window blur.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
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
  // All bucket counts respect the audience filter so the sidebar numbers
  // match the visible thread count for the rep's chosen slice.
  const audienceParam = audience !== "all" ? `&audience=${audience}` : "";
  // Bucket counts are sidebar badges, not the primary feed — they refresh at
  // 60s (vs 30s for the main list) so a busy org with many concurrent reps
  // doesn't fan out 5 polling queries every 30s per user. Window-focus refetch
  // still snaps them current the moment a rep returns to the tab.
  const COUNT_REFRESH_OPTS = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;

  const { data: mineData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "mine-count", user?.id, audience],
    queryFn: async () => {
      const p = new URLSearchParams({ waitingState: "waiting_on_us", limit: "1" });
      if (user?.id) p.set("ownerUserId", user.id);
      if (audience !== "all") p.set("audience", audience);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    enabled: !!user?.id,
    ...COUNT_REFRESH_OPTS,
  });

  const { data: unownedData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "unowned-count", audience],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?unowned=true&waitingState=waiting_on_us&limit=1${audienceParam}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
  });

  const { data: highPriData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "high-priority-count", audience],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?responsePriority=high&waitingState=waiting_on_us&limit=1${audienceParam}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
  });

  const { data: quoteData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "quote-request-count", audience],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?signal=quote_request&waitingState=waiting_on_us&limit=1${audienceParam}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
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
  // Restrict the rep filter to customer-facing + logistics roles only.
  // Admins (and other internal roles like generic "sales" / "sales_director")
  // shouldn't appear here — sales leadership wants to filter the inbox by
  // the people who actually own customer relationships and freight execution.
  const CONVERSATIONS_FILTER_ROLES = new Set([
    "director",
    "national_account_manager",
    "account_manager",
    "logistics_manager",
    "logistics_coordinator",
  ]);
  const sortedReps = useMemo(
    () => [...repsData]
      .filter(r => CONVERSATIONS_FILTER_ROLES.has(r.role))
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

  const snoozeMutation = useMutation({
    mutationFn: async ({ id, until }: { id: string; until: Date }) => {
      return apiRequest("POST", `/api/internal/conversations/${id}/snooze`, {
        snoozedUntil: until.toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation snoozed" });
    },
    onError: () => toast({ title: "Failed to snooze conversation", variant: "destructive" }),
  });

  const unsnoozeMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("POST", `/api/internal/conversations/${id}/unsnooze`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      toast({ title: "Conversation woken" });
    },
    onError: () => toast({ title: "Failed to wake conversation", variant: "destructive" }),
  });

  // ── Bulk action mutation (Task #533) ──────────────────────────────────────
  // Single endpoint accepts any of resolve/reopen/archive/assign/snooze. Toast
  // surfaces a per-action success summary, including any per-thread failures
  // so the user knows when (e.g.) an archive was rejected for an un-resolved
  // thread.
  const bulkMutation = useMutation({
    mutationFn: async (body: {
      action: "resolve" | "reopen" | "archive" | "assign" | "snooze";
      threadIds: string[];
      ownerUserId?: string | null;
      snoozedUntil?: string;
    }) => {
      const res = await apiRequest("POST", "/api/internal/conversations/bulk", body);
      return (await res.json()) as BulkActionResult;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      setSelectedIds(new Set());
      const failed = result.failed;
      const verb =
        result.action === "resolve" ? "resolved"
        : result.action === "reopen" ? "reopened"
        : result.action === "archive" ? "archived"
        : result.action === "assign" ? "assigned"
        : "snoozed";
      toast({
        title: `${result.succeeded} of ${result.total} conversations ${verb}`,
        description: failed > 0 ? `${failed} could not be updated.` : undefined,
        variant: failed > 0 && result.succeeded === 0 ? "destructive" : "default",
      });
    },
    onError: () => toast({ title: "Bulk action failed", variant: "destructive" }),
  });

  // ── Saved views (Task #533) ───────────────────────────────────────────────
  const { data: savedViewsData } = useQuery<{ views: SavedView[] }>({
    queryKey: ["/api/internal/conversations/saved-views"],
    queryFn: async () => {
      const res = await fetch("/api/internal/conversations/saved-views");
      if (!res.ok) throw new Error("");
      return res.json();
    },
  });
  const savedViews = savedViewsData?.views ?? [];

  const createViewMutation = useMutation({
    mutationFn: async (body: { name: string; bucket: ConversationBucket; filters: Record<string, any> }) => {
      const res = await apiRequest("POST", "/api/internal/conversations/saved-views", body);
      return (await res.json()) as { view: SavedView };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/saved-views"] });
      setActiveSavedViewId(data.view.id);
      toast({ title: "View saved" });
    },
    onError: () => toast({ title: "Failed to save view", variant: "destructive" }),
  });

  const updateViewMutation = useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; name?: string }) => {
      return apiRequest("PATCH", `/api/internal/conversations/saved-views/${id}`, patch);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/saved-views"] });
    },
    onError: () => toast({ title: "Failed to update view", variant: "destructive" }),
  });

  const deleteViewMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/internal/conversations/saved-views/${id}`);
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/saved-views"] });
      if (activeSavedViewId === id) setActiveSavedViewId(null);
      toast({ title: "View deleted" });
    },
    onError: () => toast({ title: "Failed to delete view", variant: "destructive" }),
  });

  const reorderViewsMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      return apiRequest("POST", "/api/internal/conversations/saved-views/reorder", { orderedIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations/saved-views"] });
    },
    onError: () => toast({ title: "Failed to reorder views", variant: "destructive" }),
  });

  // Clear selection whenever the bucket or any filter that drives the visible
  // list changes — selecting threads then changing the view shouldn't keep
  // them in the bulk action queue.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [bucket, filterState, filterPriority, filterOverdue, filterRep, debouncedSearch, effectiveDateFrom, effectiveDateTo]);

  function applySavedView(view: SavedView) {
    const f = view.filters ?? {};
    setActiveSavedViewId(view.id);
    setFilterState((f.filterState as string) ?? "all");
    setFilterPriority((f.filterPriority as string) ?? "all");
    setFilterOverdue(!!f.filterOverdue);
    setFilterRep((f.filterRep as string) ?? "all");
    setAllThreads([]);
    setNextCursor(null);
    updateUrl({ bucket: view.bucket === "mine" ? null : view.bucket, threadId: null });
  }

  function moveSavedView(id: string, direction: "up" | "down") {
    const idx = savedViews.findIndex(v => v.id === id);
    if (idx < 0) return;
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= savedViews.length) return;
    const next = [...savedViews];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    reorderViewsMutation.mutate(next.map(v => v.id));
  }

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

  // ── Group computation (Task #535) ─────────────────────────────────────────
  // Pure client-side: groupBy maps the already-sorted list into account or
  // carrier groups. Sort order *within* a group preserves the triage order
  // above (overdue first, then oldest waiting, then recency).
  const groups = useMemo(() => buildGroups(sorted, groupBy), [sorted, groupBy]);

  // Wire group-header selection into the existing bulk selection model:
  // checking a header adds every thread in the group to the selection set,
  // unchecking removes them. Threads outside the group are left alone, which
  // is what reps expect when they're working multiple groups in one pass.
  function toggleGroupSelected(groupThreads: ConversationThread[], checked: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const t of groupThreads) {
        if (checked) next.add(t.id);
        else next.delete(t.id);
      }
      return next;
    });
  }

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
                savedViews={savedViews}
                activeSavedViewId={activeSavedViewId}
                onSelectSavedView={(v) => { applySavedView(v); setMobileNavOpen(false); }}
                onRenameSavedView={(id, name) => updateViewMutation.mutate({ id, name })}
                onDeleteSavedView={(id) => deleteViewMutation.mutate(id)}
                onMoveSavedView={moveSavedView}
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
          <BucketSidebar
            bucket={bucket}
            onChange={setBucket}
            counts={counts}
            savedViews={savedViews}
            activeSavedViewId={activeSavedViewId}
            onSelectSavedView={applySavedView}
            onRenameSavedView={(id, name) => updateViewMutation.mutate({ id, name })}
            onDeleteSavedView={(id) => deleteViewMutation.mutate(id)}
            onMoveSavedView={moveSavedView}
          />
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
            {/* Audience toggle — flips the inbox between customer-facing and
                carrier-facing threads (or both). Persisted per user so a
                rep's preferred audience sticks across reloads. Placed first
                in the filter bar because it changes the meaning of every
                other filter and bucket count to its right. */}
            <ToggleGroup
              type="single"
              value={audience}
              onValueChange={(v) => {
                // ToggleGroup fires "" when the active item is clicked again.
                // Treat that as a no-op so reps can't accidentally end up in
                // an empty/undefined state by double-clicking the active tab.
                if (v === "all" || v === "customers" || v === "carriers") {
                  changeAudience(v);
                }
              }}
              className="h-8 rounded-md border bg-background"
              data-testid="toggle-audience"
            >
              <ToggleGroupItem
                value="all"
                aria-label="Show all conversations"
                className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                data-testid="toggle-audience-all"
              >
                All
              </ToggleGroupItem>
              <ToggleGroupItem
                value="customers"
                aria-label="Show only customer conversations"
                className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                data-testid="toggle-audience-customers"
              >
                Customers
              </ToggleGroupItem>
              <ToggleGroupItem
                value="carriers"
                aria-label="Show only carrier conversations"
                className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                data-testid="toggle-audience-carriers"
              >
                Carriers
              </ToggleGroupItem>
            </ToggleGroup>

            {/* Group by — Task #535. Available across every bucket so reps
                can pivot any view by account or carrier. Persisted per user. */}
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as ConversationGroupBy)}>
              <SelectTrigger className="h-8 w-36 text-xs" data-testid="select-group-by">
                <SelectValue placeholder="Group by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" data-testid="option-group-by-none">No grouping</SelectItem>
                <SelectItem value="account" data-testid="option-group-by-account">Group by account</SelectItem>
                <SelectItem value="carrier" data-testid="option-group-by-carrier">Group by carrier</SelectItem>
              </SelectContent>
            </Select>

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
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search account, carrier, or subject…"
                  value={archiveSearch}
                  onChange={(e) => setArchiveSearch(e.target.value)}
                  className="pl-8 h-8 text-xs"
                  data-testid="input-archive-search"
                />
                {archiveSearch && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                    onClick={() => {
                      setArchiveSearch("");
                      setDebouncedSearch("");
                    }}
                    data-testid="button-clear-archive-search"
                    aria-label="Clear search"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                )}
              </div>
            )}

            {/* Date range filter — visible in every bucket (Task #787).
                Replaces the archive-only date inputs so there is exactly one
                date range UI no matter which bucket is active. */}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="date-range-filter">
              <Label htmlFor="input-date-from" className="text-xs text-muted-foreground hidden sm:inline">
                From
              </Label>
              <Input
                id="input-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                max={dateTo || undefined}
                className={cn(
                  "w-[9.5rem] h-8 text-xs",
                  isDateRangeInvalid && "border-destructive focus-visible:ring-destructive",
                )}
                data-testid="input-date-from"
                aria-invalid={isDateRangeInvalid}
              />
              <Label htmlFor="input-date-to" className="text-xs text-muted-foreground hidden sm:inline">
                To
              </Label>
              <Input
                id="input-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                min={dateFrom || undefined}
                className={cn(
                  "w-[9.5rem] h-8 text-xs",
                  isDateRangeInvalid && "border-destructive focus-visible:ring-destructive",
                )}
                data-testid="input-date-to"
                aria-invalid={isDateRangeInvalid}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs gap-1.5"
                    data-testid="button-date-preset"
                  >
                    <Calendar className="w-3 h-3" />
                    Quick range
                    <ChevronDown className="w-3 h-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => applyDatePreset("today")}
                    data-testid="option-date-preset-today"
                  >
                    Today
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => applyDatePreset("last7")}
                    data-testid="option-date-preset-last7"
                  >
                    Last 7 days
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => applyDatePreset("last30")}
                    data-testid="option-date-preset-last30"
                  >
                    Last 30 days
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => applyDatePreset("thisMonth")}
                    data-testid="option-date-preset-this-month"
                  >
                    This month
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {(dateFrom || dateTo) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={clearDateRange}
                  data-testid="button-clear-date-range"
                >
                  <X className="w-3 h-3 mr-1" />
                  Clear dates
                </Button>
              )}
              {isDateRangeInvalid && (
                <span
                  className="text-xs text-destructive"
                  role="alert"
                  data-testid="text-date-range-error"
                >
                  "From" date must be on or before "To" date.
                </span>
              )}
            </div>
          </div>

          {/* Bulk action bar — sticky above the list when ≥1 thread is checked. */}
          <BulkActionBar
            count={selectedIds.size}
            busy={bulkMutation.isPending}
            onClear={() => setSelectedIds(new Set())}
            onResolve={() => bulkMutation.mutate({ action: "resolve", threadIds: Array.from(selectedIds) })}
            onReopen={() => bulkMutation.mutate({ action: "reopen", threadIds: Array.from(selectedIds) })}
            onArchive={() => bulkMutation.mutate({ action: "archive", threadIds: Array.from(selectedIds) })}
            onSnooze={(until) => bulkMutation.mutate({
              action: "snooze",
              threadIds: Array.from(selectedIds),
              snoozedUntil: until.toISOString(),
            })}
            onAssign={(ownerUserId) => bulkMutation.mutate({
              action: "assign",
              threadIds: Array.from(selectedIds),
              ownerUserId,
            })}
            reps={sortedReps}
            currentUserId={user?.id}
          />

          {/* "Save as view" button — visible whenever the current bucket+filters
              aren't already from a saved view. Lets the user freeze the
              current screen for one-click access later. */}
          {!activeSavedViewId && (
            <div className="px-3 py-1.5 border-b shrink-0 flex items-center justify-end gap-2 bg-background">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                onClick={() => { setSaveViewName(""); setSaveViewDialogOpen(true); }}
                data-testid="button-open-save-view"
              >
                <Bookmark className="w-3 h-3" />
                Save as view
              </Button>
            </div>
          )}

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
                onSnooze={async (id, until) => { await snoozeMutation.mutateAsync({ id, until }); }}
                onUnsnooze={(id) => unsnoozeMutation.mutate(id)}
                hasMore={!!nextCursor}
                onLoadMore={() => loadMoreMutation.mutate()}
                isFetchingMore={loadMoreMutation.isPending}
                selectedIds={selectedIds}
                onToggleSelected={(id, checked) => {
                  setSelectedIds(prev => {
                    const next = new Set(prev);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
                onToggleAll={(checked) => {
                  if (checked) setSelectedIds(new Set(sorted.map(t => t.id)));
                  else setSelectedIds(new Set());
                }}
                groupBy={groupBy}
                groups={groups}
                collapsedGroupKeys={collapsedGroupKeys}
                onToggleGroupCollapsed={toggleGroupCollapsed}
                onToggleGroupSelected={(group, checked) => toggleGroupSelected(group.threads, checked)}
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

      {/* Save view dialog (Task #533) */}
      <Dialog open={saveViewDialogOpen} onOpenChange={setSaveViewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>
              Saves the active bucket and filters under a name in your sidebar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="save-view-name">Name</Label>
            <Input
              id="save-view-name"
              value={saveViewName}
              onChange={(e) => setSaveViewName(e.target.value)}
              placeholder="e.g. My overdue quotes"
              autoFocus
              data-testid="input-save-view-name"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSaveViewDialogOpen(false)}
              data-testid="button-save-view-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const name = saveViewName.trim();
                if (!name) return;
                createViewMutation.mutate({
                  name,
                  bucket,
                  filters: {
                    filterState,
                    filterPriority,
                    filterOverdue,
                    filterRep,
                  },
                });
                setSaveViewDialogOpen(false);
              }}
              disabled={!saveViewName.trim() || createViewMutation.isPending}
              data-testid="button-save-view-confirm"
            >
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
