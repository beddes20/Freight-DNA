import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { QueryError } from "@/components/query-error";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { runWithUndo } from "@/lib/workflow-os/withUndo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Search,
  X,
  Menu,
  Rows3,
  Rows2,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BucketSidebar } from "@/components/conversations/bucket-sidebar";
import { ThreadList } from "@/components/conversations/thread-list";
import { ThreadDetailPane, EmptyDetailPane } from "@/components/conversations/thread-detail-pane";
import { CaptureAuditStatusPill } from "@/components/conversations/capture-audit-status-pill";
// Task #967 — shared trust-layer primitives.
import { LiveSyncPill } from "@/components/live-sync/LiveSyncPill";
import { useLiveSyncStatus, setPolledFallbackActive, subscribeLiveSyncEvents } from "@/hooks/useLiveSync";
import {
  HiddenCountsDisclosure,
  type HiddenCountsSummary,
} from "@/components/freight/hidden-counts";
import { BulkActionBar } from "@/components/conversations/bulk-action-bar";
import {
  DatePopover,
  FiltersPopover,
  ActiveFilterChips,
} from "@/components/conversations/filter-controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type {
  ConversationBucket,
  ConversationDensity,
  ConversationGroupBy,
  ConversationThread,
  ThreadsResponse,
  SavedView,
  BulkActionResult,
} from "@/components/conversations/types";
import { parseBucket, buildGroups, resolveBucketLabel } from "@/components/conversations/types";

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
// Task #968 — rep filter persists per-user. URL `?rep=` wins on first
// load (so a shared link still scopes correctly), then we mirror the
// chosen value into localStorage so a follow-up reload without a query
// string still lands on the rep's last selection. Helper + key prefix
// live in @/lib/conversations/repFilterStorage so unit tests can import
// them without dragging in React / wouter; we re-export here so existing
// callers (and the hardening test's source-grep assertions) keep working.
import {
  REP_FILTER_KEY_PREFIX,
  repFilterKey,
  loadRepFilter,
} from "@/lib/conversations/repFilterStorage";
export { loadRepFilter, REP_FILTER_KEY_PREFIX };

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
    setExtraPages([]);
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
  // Rep filter (Task #968) — persists per-user via URL `?rep=` and
  // localStorage. URL wins on first load so a shared link still scopes
  // correctly; the chosen value mirrors back into both stores so a
  // follow-up reload without a query string still lands on the rep's
  // last selection.
  const [filterRep, _setFilterRep] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    const url = new URLSearchParams(window.location.search).get("rep");
    if (url) return url;
    return "all";
  });

  // Task #899 — Quote requests sub-toggle. Defaults to "waiting on us"
  // because the QA pass on Task #862 surfaced that most reps care more
  // about the actionable subset than the lifetime total of quote-request
  // threads. The "all" mode is one click away and the sidebar badge
  // shows both numbers ("X waiting · Y total") regardless of mode.
  const [quoteWaitingMode, setQuoteWaitingMode] = useState<"waiting_on_us" | "all">("waiting_on_us");

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

  // Picker state holds plain YYYY-MM-DD; buildParams also sends `tz` so
  // the backend resolves the day window in the rep's local zone (#858).
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

  // Whenever the *effective* date range changes, drop any "Load more" pages
  // and the pagination cursor so "Load more" can't blend pages from a
  // previous range with the new one. The query key change below also forces
  // a refetch and React Query will replace the first page on its own.
  useEffect(() => {
    setExtraPages([]);
    setNextCursor(null);
    // We intentionally don't include setExtraPages/setNextCursor in deps —
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
    // Task #968 — rep filter persistence contract:
    //   • URL `?rep=` wins on first load (so a shared link still scopes
    //     correctly), and we mirror that value into per-user
    //     localStorage so a follow-up reload WITHOUT the query string
    //     still lands on the rep's last selection.
    //   • If there's no URL rep, fall back to the per-user persisted
    //     value.
    if (typeof window !== "undefined") {
      const k = repFilterKey(user.id);
      const urlRep = new URLSearchParams(window.location.search).get("rep");
      if (urlRep) {
        if (k) {
          if (urlRep === "all") window.localStorage.removeItem(k);
          else window.localStorage.setItem(k, urlRep);
        }
      } else {
        const stored = loadRepFilter(user.id);
        if (stored && stored !== filterRep) _setFilterRep(stored);
      }
    }
    // We intentionally only re-hydrate when the user identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Setter wrapper that mirrors the choice into the URL (so it survives a
  // share-link copy/paste and is honored on reload) and into per-user
  // localStorage (so a reload without a query string still lands on the
  // rep's last selection). Both stores are updated synchronously here so
  // a single user gesture lands in one consistent place.
  const setFilterRep = (next: string) => {
    _setFilterRep(next);
    updateUrl({ rep: next === "all" ? null : next });
    if (typeof window !== "undefined" && user?.id) {
      const k = repFilterKey(user.id);
      if (k) {
        if (next === "all") window.localStorage.removeItem(k);
        else window.localStorage.setItem(k, next);
      }
    }
  };
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
    setExtraPages([]);
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

  // ── Pagination state — only the *extra* pages beyond the React Query
  // first page. The first page is always read live from `data?.threads`
  // so back-navigation from an open thread can never land on an empty
  // list (the cached query result is still there, even if a transient
  // refetch races with the navigation). "Load more" appends pages here.
  const [extraPages, setExtraPages] = useState<ConversationThread[]>([]);
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
      // Task #899 — sub-toggle inside the bucket lets the rep flip between
      // "waiting on us" (the actionable subset most reps care about) and
      // "all" (every quote-request thread that ever existed). The default
      // lands on the actionable subset; the split sidebar badge keeps the
      // total visible regardless.
      if (quoteWaitingMode === "waiting_on_us") p.set("waitingState", "waiting_on_us");
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
    // "no date filter" and never reaches the server. Task #858 also
    // ships the rep's IANA tz so the backend resolves "today" against
    // their local clock instead of UTC midnight.
    if (effectiveDateFrom) p.set("dateFrom", effectiveDateFrom);
    if (effectiveDateTo) p.set("dateTo", effectiveDateTo);
    if (effectiveDateFrom || effectiveDateTo) {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) p.set("tz", tz);
      } catch {
        // No-op — backend falls back to UTC for missing tz.
      }
    }
    if (cursorParam) p.set("cursor", cursorParam);
    return p.toString();
  }

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ThreadsResponse>({
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
      // Task #899 — included so toggling the Quote requests sub-mode
      // refetches the list (and resets the "Load more" accumulator via
      // the dep effect below).
      bucket === "quote_requests" ? quoteWaitingMode : "n/a",
    ],
    queryFn: async () => {
      const res = await fetch(`/api/internal/conversations?${buildParams()}`);
      if (!res.ok) throw new Error("Failed to fetch conversations");
      return res.json();
    },
    // Task #867 — live-sync (mailbox_inbound/outbound topics) now invalidates
    // this query within ~50ms of any accepted Graph webhook or delta-sync
    // ingest, so this background poll is a fall-back for environments where
    // the SSE stream is blocked by an intermediary (corporate proxy, etc.).
    // Two-minute cadence is loose enough to avoid herd-effect refetches in
    // rooms with many tabs open and tight enough that a long SSE outage
    // still self-corrects within the typical attention span.
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  // Task #968 — single-source bucket-move toast. Driven entirely by
  // server-emitted `conversation_thread` events whose payload carries
  // {previousBucket, currentBucket, previousWaitingState,
  //  currentWaitingState, previousOwnerUserId, currentOwnerUserId}.
  // Dedupes by `${threadId}|${currentBucket}` per session.
  const bucketMoveSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const unsubscribe = subscribeLiveSyncEvents("conversation_thread", (evt) => {
      const p = evt.payload;
      if (!p || typeof p !== "object") return;
      const threadId = (p as { threadId?: unknown }).threadId;
      if (typeof threadId !== "string" || !threadId) return;
      const prevState = (p as { previousWaitingState?: unknown }).previousWaitingState;
      const currState = (p as { currentWaitingState?: unknown }).currentWaitingState;
      const prevOwner = (p as { previousOwnerUserId?: unknown }).previousOwnerUserId;
      const currOwner = (p as { currentOwnerUserId?: unknown }).currentOwnerUserId;
      // Server-supplied destination labels win when present (covers
      // signal-driven moves like Quote Requests that aren't derivable
      // from waitingState alone). Fall back to the viewer-aware
      // resolver when the server didn't tag the bucket explicitly.
      const serverPrev = (p as { previousBucket?: unknown }).previousBucket;
      const serverCurr = (p as { currentBucket?: unknown }).currentBucket;
      const prev = typeof serverPrev === "string"
        ? { key: serverPrev, label: serverPrev }
        : resolveBucketLabel(
            typeof prevState === "string" ? prevState : null,
            typeof prevOwner === "string" ? prevOwner : null,
            user?.id ?? null,
          );
      const curr = typeof serverCurr === "string"
        ? { key: serverCurr, label: serverCurr, bucket: serverCurr as ConversationBucket }
        : resolveBucketLabel(
            typeof currState === "string" ? currState : null,
            typeof currOwner === "string" ? currOwner : null,
            user?.id ?? null,
          );
      if (prev.key === curr.key) return;
      const dedupeKey = `${threadId}|${curr.key}`;
      if (bucketMoveSeenRef.current.has(dedupeKey)) return;
      bucketMoveSeenRef.current.add(dedupeKey);
      if (bucketMoveSeenRef.current.size > 500) {
        const first = bucketMoveSeenRef.current.values().next().value;
        if (first) bucketMoveSeenRef.current.delete(first);
      }
      const destBucket = (curr as { bucket?: ConversationBucket }).bucket ?? null;
      toast({
        title: `Reclassified to ${curr.label}`,
        description: `Moved from ${prev.label} → ${curr.label}.`,
        action: (
          <ToastAction
            altText="Open thread"
            onClick={() => updateUrl(destBucket
              ? { bucket: destBucket, threadId }
              : { threadId })}
            data-testid={`toast-action-open-bucket-move-${threadId}`}
          >
            Open
          </ToastAction>
        ),
      });
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Polled fallback — activates after >60s of explicit offline state
  // (anything other than live/stale). Tracks `offlineSinceRef` so the
  // gate uses a single source of truth.
  const liveSyncStatus = useLiveSyncStatus();
  const isOfflineLike =
    liveSyncStatus.state === "connecting" ||
    liveSyncStatus.state === "idle" ||
    liveSyncStatus.state === "disabled";
  const offlineSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isOfflineLike) {
      offlineSinceRef.current = null;
      setPolledFallbackActive(false);
      return;
    }
    if (offlineSinceRef.current === null) {
      offlineSinceRef.current = Date.now();
    }
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const elapsed = Date.now() - (offlineSinceRef.current ?? Date.now());
    const remaining = Math.max(0, 60_000 - elapsed);
    const startTimer = setTimeout(() => {
      setPolledFallbackActive(true);
      pollTimer = setInterval(() => {
        void queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
      }, 30_000);
    }, remaining);
    return () => {
      clearTimeout(startTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [isOfflineLike]);

  // Reset "Load more" pagination ONLY when the user changes the filter
  // signature (bucket / audience / filters / date / search). A background
  // refetch of the same query keeps the same key, so the user's already
  // loaded extra pages stay intact — critical for the back-from-thread
  // scenario where a 30s refetch could otherwise wipe out pages 2..N
  // while the rep is reading a thread.
  useEffect(() => {
    setExtraPages([]);
    setNextCursor(null);
  }, [
    bucket,
    audience,
    filterState,
    filterPriority,
    filterOverdue,
    filterRep,
    debouncedSearch,
    effectiveDateFrom,
    effectiveDateTo,
    quoteWaitingMode,
  ]);

  // Track the cursor returned by the active first-page query so "Load more"
  // can pick up where the server left off. Only update when the cursor
  // actually changes to avoid clobbering a paginated cursor with the
  // same value during background refetches.
  useEffect(() => {
    if (data && extraPages.length === 0) {
      setNextCursor(data.nextCursor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.nextCursor]);

  // ── Refresh control ─────────────────────────────────────────────────────
  // Manual refresh of the visible thread list + every bucket count badge.
  // Used by the inbox header Refresh button and the "R" keyboard shortcut.
  // We refetch the active list query (so failures actually bubble up here
  // and we can toast on them) and then invalidate sibling queries (bucket
  // counts, single-thread deep links) so they refresh in the background.
  // `isManualRefreshing` is tracked separately from the query's general
  // `isFetching` flag so the button's spinner/disabled state lights up
  // *only* for user-initiated refreshes — not for the silent 30s
  // refetchInterval or the focus-restored refetch, which would otherwise
  // make the button look perpetually busy.
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const refreshInbox = useCallback(async () => {
    setIsManualRefreshing(true);
    try {
      const result = await refetch();
      if (result.isError) {
        toast({
          title: "Failed to refresh",
          description: "Couldn't reload the inbox. Please try again.",
          variant: "destructive",
        });
        return;
      }
      // Best-effort: kick the bucket-count and per-thread queries too.
      // These are read-mostly so a fire-and-forget invalidate is fine —
      // their own queryFns will surface their own errors if any matter.
      void queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
    } catch {
      toast({
        title: "Failed to refresh",
        description: "Couldn't reload the inbox. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsManualRefreshing(false);
    }
  }, [refetch, toast]);

  // "R" keyboard shortcut. Active any time the conversations page is mounted
  // and focus is *not* in a text input / textarea / contenteditable — we
  // don't want to swallow the rep's typing in a draft reply, the archive
  // search box, or the "save view" name field.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key !== "r" && e.key !== "R") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (t.isContentEditable) return;
      e.preventDefault();
      void refreshInbox();
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshInbox]);

  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      if (!nextCursor) return null;
      const res = await fetch(`/api/internal/conversations?${buildParams(nextCursor)}`);
      if (!res.ok) throw new Error("Failed to load more");
      return res.json() as Promise<ThreadsResponse>;
    },
    onSuccess: (result) => {
      if (result) {
        setExtraPages(prev => [...prev, ...result.threads]);
        setNextCursor(result.nextCursor);
      }
    },
    onError: () => toast({ title: "Failed to load more conversations", variant: "destructive" }),
  });

  // ── Per-bucket counts (lightweight 1-row queries) ─────────────────────────
  // All bucket counts respect the audience filter so the sidebar numbers
  // match the visible thread count for the rep's chosen slice.
  // Bucket counts are sidebar badges, not the primary feed — they refresh at
  // 60s (vs 30s for the main list) so a busy org with many concurrent reps
  // doesn't fan out 5 polling queries every 30s per user. Window-focus refetch
  // still snaps them current the moment a rep returns to the tab.
  const COUNT_REFRESH_OPTS = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const;

  // Task #862 (QA polish) — thread the active date-range filter into every
  // sidebar count query. Without this the badges show the *unfiltered* total
  // (e.g. "Quote requests 613") while the visible list shows the today-window
  // subset (e.g. 87). The list endpoint already honours dateFrom/dateTo/tz
  // and anchors on `last_email_at` (Task #858/#859), so threading the same
  // params here makes the count match what the rep can actually see. The
  // browser's resolved zone is sent so the day window is computed in the
  // rep's local time, not UTC.
  const browserTz = typeof Intl !== "undefined"
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";
  function applyDateRange(p: URLSearchParams) {
    if (effectiveDateFrom) p.set("dateFrom", effectiveDateFrom);
    if (effectiveDateTo) p.set("dateTo", effectiveDateTo);
    if (effectiveDateFrom || effectiveDateTo) p.set("tz", browserTz);
  }
  const dateRangeKey = `${effectiveDateFrom}|${effectiveDateTo}`;

  const { data: mineData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "mine-count", user?.id, audience, dateRangeKey],
    queryFn: async () => {
      const p = new URLSearchParams({ waitingState: "waiting_on_us", limit: "1" });
      if (user?.id) p.set("ownerUserId", user.id);
      if (audience !== "all") p.set("audience", audience);
      applyDateRange(p);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    enabled: !!user?.id,
    ...COUNT_REFRESH_OPTS,
  });

  const { data: unownedData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "unowned-count", audience, dateRangeKey],
    queryFn: async () => {
      const p = new URLSearchParams({ unowned: "true", waitingState: "waiting_on_us", limit: "1" });
      if (audience !== "all") p.set("audience", audience);
      applyDateRange(p);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
  });

  const { data: highPriData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "high-priority-count", audience, dateRangeKey],
    queryFn: async () => {
      const p = new URLSearchParams({ responsePriority: "high", waitingState: "waiting_on_us", limit: "1" });
      if (audience !== "all") p.set("audience", audience);
      applyDateRange(p);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
  });

  // Task #899 — total quote-request count (every thread where the customer
  // is asking for pricing, regardless of waiting state). Always fetched so
  // the sidebar split badge can show "X waiting · Y total" and the in-bucket
  // toggle's "All" label can render its companion count immediately.
  const { data: quoteTotalData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "quote-request-count", "total", audience, dateRangeKey],
    queryFn: async () => {
      const p = new URLSearchParams({ signal: "quote_request", limit: "1" });
      if (audience !== "all") p.set("audience", audience);
      applyDateRange(p);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
  });

  // Task #899 — actionable subset count (quote requests waiting on us).
  // This is what most reps care about (per the QA report on Task #862),
  // and it's the bucket's default view. Sidebar badge primary number.
  const { data: quoteWaitingData } = useQuery<ThreadsResponse>({
    queryKey: ["/api/internal/conversations", "quote-request-count", "waiting", audience, dateRangeKey],
    queryFn: async () => {
      const p = new URLSearchParams({
        signal: "quote_request",
        waitingState: "waiting_on_us",
        limit: "1",
      });
      if (audience !== "all") p.set("audience", audience);
      applyDateRange(p);
      const res = await fetch(`/api/internal/conversations?${p.toString()}`);
      if (!res.ok) throw new Error("");
      return res.json();
    },
    ...COUNT_REFRESH_OPTS,
  });

  // Sidebar badges: primary = "actionable" subset, secondary = total.
  // For Quote requests this means waiting-on-us vs every quote-request
  // thread — which is the whole point of Task #899. The split badge
  // renders only when both are known and they differ, so the original
  // single-number presentation is preserved for parity buckets.
  const counts: Partial<Record<ConversationBucket, number>> = {
    mine: mineData?.count,
    unowned: unownedData?.count,
    high_priority: highPriData?.count,
    quote_requests: quoteWaitingData?.count,
  };
  const secondaryCounts: Partial<Record<ConversationBucket, number>> = {
    quote_requests: quoteTotalData?.count,
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

  // ── Bulk action mutation (Task #533, hardened in #970) ────────────────────
  // Single endpoint accepts resolve/reopen/archive/assign/snooze/unsnooze.
  // The mutation itself is the workhorse; bulk callsites route through
  // `runBulkActionWithUndo` below so every successful bulk surfaces a
  // selection-cleared toast with an Undo affordance for actions that
  // have a clean inverse (snooze ↔ unsnooze, resolve ↔ reopen). Archive
  // and assign omit `invert`: archive has no symmetric "unarchive" bulk
  // path, and assign would need per-thread prior-owner snapshots that
  // the bulk endpoint doesn't return.
  type BulkBody = {
    action: "resolve" | "reopen" | "archive" | "assign" | "snooze" | "unsnooze";
    threadIds: string[];
    ownerUserId?: string | null;
    snoozedUntil?: string;
  };
  const bulkMutation = useMutation({
    mutationFn: async (body: BulkBody) => {
      const res = await apiRequest("POST", "/api/internal/conversations/bulk", body);
      return (await res.json()) as BulkActionResult;
    },
    // No onSuccess/onError here — the runWithUndo wrapper surfaces toasts
    // and clears the selection so the inverse can replay the prior state.
  });

  const VERB_BY_ACTION: Record<BulkBody["action"], string> = {
    resolve: "resolved",
    reopen: "reopened",
    archive: "archived",
    assign: "assigned",
    snooze: "snoozed",
    unsnooze: "woken",
  };

  const runBulkActionWithUndo = useCallback(
    async (body: BulkBody, opts?: { invert?: BulkBody["action"] }) => {
      const inverseAction = opts?.invert;
      try {
        await runWithUndo(
          {
            perform: async (params: BulkBody) => {
              const result = await bulkMutation.mutateAsync(params);
              queryClient.invalidateQueries({ queryKey: ["/api/internal/conversations"] });
              const verb =
                VERB_BY_ACTION[result.action as BulkBody["action"]] ?? result.action;
              const failed = result.failed;
              // Surface per-action failures inline before the Undo
              // toast so reps see them even if they Undo immediately.
              if (failed > 0 && result.succeeded === 0) {
                toast({
                  title: `Bulk ${result.action} failed`,
                  description: `${failed} of ${result.total} could not be updated.`,
                  variant: "destructive",
                });
              } else if (failed > 0) {
                toast({
                  title: `${result.succeeded} of ${result.total} ${verb}`,
                  description: `${failed} could not be updated.`,
                });
              }
              return result;
            },
            invert: inverseAction
              ? async (result) => {
                  // Replay the inverse against the threads that
                  // *actually* succeeded so we don't re-touch threads
                  // the forward call already failed on.
                  const succeededIds = result.results
                    .filter(r => r.ok)
                    .map(r => r.id);
                  if (succeededIds.length === 0) return;
                  await bulkMutation.mutateAsync({
                    action: inverseAction,
                    threadIds: succeededIds,
                  });
                  queryClient.invalidateQueries({
                    queryKey: ["/api/internal/conversations"],
                  });
                }
              : undefined,
            toastTitle: `${body.threadIds.length} ${VERB_BY_ACTION[body.action] ?? body.action}`,
            toast,
            captureSelection: () => Array.from(selectedIds),
            clearSelection: () => setSelectedIds(new Set()),
            restoreSelection: (ids) => setSelectedIds(new Set(ids)),
          },
          body,
        );
      } catch (err) {
        toast({
          title: "Bulk action failed",
          description: (err as { message?: string })?.message,
          variant: "destructive",
        });
      }
    },
    [bulkMutation, toast, selectedIds],
  );

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
    setExtraPages([]);
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
  // Build the visible list from the React Query cache (first page) plus any
  // accumulated "Load more" pages. Reading the first page from the cache —
  // not from local state — is what makes back-navigation safe: even if a
  // refetch lands while the detail pane is open, the list always has rows
  // when the rep returns to it.
  const baseThreads = data?.threads ?? [];
  // Dedupe by row id when concatenating extra pages: a background refetch of
  // page 1 can occasionally pull in a thread that's also present in
  // extraPages (e.g. a new top-of-list thread pushes an old one into the
  // tail), which would otherwise produce duplicate React keys and a
  // double-rendered row.
  const allThreads = useMemo(() => {
    if (extraPages.length === 0) return baseThreads;
    const seen = new Set<string>();
    const out: ConversationThread[] = [];
    for (const t of [...baseThreads, ...extraPages]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }, [baseThreads, extraPages],
  );
  const sorted = useMemo(() => {
    const arr = [...allThreads];
    arr.sort((a, b) => {
      if (bucket === "archived") {
        const aDate = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
        const bDate = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
        return bDate - aDate;
      }
      // Phase 1 — "Stop lying about freshness."
      // Sort by REAL email activity, not thread.updatedAt (which gets
      // bumped by background workers and routinely lands days off the
      // actual conversation activity). Falls back through the same
      // chain the row UI uses so the visible-row order matches the
      // visible "Customer replied X" / "You replied Y" labels.
      const recencyTs = (t: typeof a): number => {
        const ts = t.lastEmailAt ?? t.lastIncomingAt ?? t.lastOutgoingAt ?? t.updatedAt;
        return ts ? new Date(ts).getTime() : 0;
      };
      if (bucket === "all") {
        return recencyTs(b) - recencyTs(a);
      }
      const aOverdue = !!a.overdueAt;
      const bOverdue = !!b.overdueAt;
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      if (a.waitingSinceAt && b.waitingSinceAt) {
        return new Date(a.waitingSinceAt).getTime() - new Date(b.waitingSinceAt).getTime();
      }
      return recencyTs(b) - recencyTs(a);
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
                secondaryCounts={secondaryCounts}
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
          {/* Task #967 — shared live-sync health pill. */}
          <LiveSyncPill testId="pill-live-sync-conversations" />
          {/* Task #967 — hidden-counts disclosure. Surfaces "N hidden of
              M total" when bucket selection or audience toggle is hiding
              threads the rep would otherwise see. The total uses the
              data.count facet (org-scope, pre-bucket); visible uses the
              currently-rendered list size. */}
          {(() => {
            const total = data?.count ?? 0;
            const visible = (data?.threads?.length ?? 0);
            if (total <= visible) return null;
            const summary: HiddenCountsSummary = {
              totalInScope: total,
              visible,
              buckets: [
                { id: "bucket", label: `Hidden by bucket "${bucket}" / audience "${audience}"`, count: Math.max(0, total - visible) },
              ],
            };
            return (
              <HiddenCountsDisclosure
                summary={summary}
                surface="conversations"
                testId="disclosure-hidden-conversations"
              />
            );
          })()}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void refreshInbox()}
            disabled={isManualRefreshing}
            data-testid="button-refresh-inbox"
            title="Refresh conversations (R)"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isManualRefreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
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
            secondaryCounts={secondaryCounts}
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
          {/* Compact filter bar — Audience toggle stays inline (it changes
              the meaning of every other control); everything else lives
              behind a Date popover and a single Filters popover so the bar
              is one line tall on a typical screen. Active filters surface
              as dismissible chips below this bar. */}
          <div className="px-3 py-2 border-b shrink-0 flex flex-wrap items-center gap-2 bg-muted/10">
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

            <DatePopover
              dateFrom={dateFrom}
              dateTo={dateTo}
              onChangeFrom={setDateFrom}
              onChangeTo={setDateTo}
              onApplyPreset={applyDatePreset}
              onClear={clearDateRange}
              isInvalid={isDateRangeInvalid}
            />

            <FiltersPopover
              bucket={bucket}
              groupBy={groupBy}
              setGroupBy={setGroupBy}
              filterState={filterState}
              setFilterState={setFilterState}
              filterPriority={filterPriority}
              setFilterPriority={setFilterPriority}
              filterOverdue={filterOverdue}
              setFilterOverdue={setFilterOverdue}
              filterRep={filterRep}
              setFilterRep={setFilterRep}
              reps={sortedReps}
            />

            {/* Task #899 — Quote requests sub-toggle. Inline (not buried in
                the Filters popover) because it answers the rep's most
                common Quote-requests question — "what's actually on me?"
                vs "what's everything?" — in one click. The companion
                count next to each label keeps both numbers visible so
                the rep doesn't have to flip back and forth to compare. */}
            {bucket === "quote_requests" && (
              <ToggleGroup
                type="single"
                value={quoteWaitingMode}
                onValueChange={(v) => {
                  if (v === "waiting_on_us" || v === "all") setQuoteWaitingMode(v);
                }}
                className="h-8 rounded-md border bg-background"
                data-testid="toggle-quote-waiting"
              >
                <ToggleGroupItem
                  value="waiting_on_us"
                  aria-label="Show only quote requests waiting on us"
                  className="h-8 px-3 text-xs gap-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  data-testid="toggle-quote-waiting-on-us"
                >
                  Waiting on us
                  {typeof quoteWaitingData?.count === "number" && (
                    <span
                      className="text-[10px] tabular-nums opacity-70"
                      data-testid="toggle-quote-waiting-on-us-count"
                    >
                      {quoteWaitingData.count}
                    </span>
                  )}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="all"
                  aria-label="Show all quote requests"
                  className="h-8 px-3 text-xs gap-1.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  data-testid="toggle-quote-waiting-all"
                >
                  All
                  {typeof quoteTotalData?.count === "number" && (
                    <span
                      className="text-[10px] tabular-nums opacity-70"
                      data-testid="toggle-quote-waiting-all-count"
                    >
                      {quoteTotalData.count}
                    </span>
                  )}
                </ToggleGroupItem>
              </ToggleGroup>
            )}

            {/* Archive search stays inline because reps type into it
                continuously when scrubbing the archive — burying it
                inside a popover would force constant clicks. */}
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
          </div>

          {/* Active-filter chip row + inline "Save as view" button. The
              chips give reps an at-a-glance view of every active filter
              and a one-click way to drop any of them. We render the row
              whenever there's at least one chip to show OR when the
              "Save as view" affordance is available, so the row never
              flashes in and out as a single chip is dismissed. */}
          <ActiveFilterChips
            bucket={bucket}
            groupBy={groupBy}
            setGroupBy={setGroupBy}
            filterState={filterState}
            setFilterState={setFilterState}
            filterPriority={filterPriority}
            setFilterPriority={setFilterPriority}
            filterOverdue={filterOverdue}
            setFilterOverdue={setFilterOverdue}
            filterRep={filterRep}
            setFilterRep={setFilterRep}
            reps={sortedReps}
            dateFrom={dateFrom}
            dateTo={dateTo}
            isDateRangeInvalid={isDateRangeInvalid}
            onClearDate={clearDateRange}
            archiveSearch={archiveSearch}
            onClearArchiveSearch={() => { setArchiveSearch(""); setDebouncedSearch(""); }}
            showSaveAsView={!activeSavedViewId}
            onSaveAsView={() => { setSaveViewName(""); setSaveViewDialogOpen(true); }}
          />

          {/* Bulk action bar — sticky above the list when ≥1 thread is checked. */}
          <BulkActionBar
            count={selectedIds.size}
            busy={bulkMutation.isPending}
            onClear={() => setSelectedIds(new Set())}
            onResolve={() =>
              runBulkActionWithUndo(
                { action: "resolve", threadIds: Array.from(selectedIds) },
                { invert: "reopen" },
              )
            }
            onReopen={() =>
              runBulkActionWithUndo(
                { action: "reopen", threadIds: Array.from(selectedIds) },
                { invert: "resolve" },
              )
            }
            onArchive={() =>
              runBulkActionWithUndo({
                action: "archive",
                threadIds: Array.from(selectedIds),
              })
            }
            onSnooze={(until) =>
              runBulkActionWithUndo(
                {
                  action: "snooze",
                  threadIds: Array.from(selectedIds),
                  snoozedUntil: until.toISOString(),
                },
                { invert: "unsnooze" },
              )
            }
            onAssign={(ownerUserId) =>
              runBulkActionWithUndo({
                action: "assign",
                threadIds: Array.from(selectedIds),
                ownerUserId,
              })
            }
            reps={sortedReps}
            currentUserId={user?.id}
          />

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
