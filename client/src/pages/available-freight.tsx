// Available Freight Cockpit (Task #601) — triage cockpit page.

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useLaneSignals, laneSigKey } from "@/hooks/useLaneSignals";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
  Truck, AlertCircle, RefreshCw, Search, Inbox, Upload,
  CheckCircle2, Clock, Bookmark, MoreHorizontal, ChevronDown,
  Send, AlarmClock, X, UserCheck, ClipboardCheck, Star,
  ChevronsUpDown, Check,
} from "lucide-react";
import type { FreightOpportunity } from "@shared/schema";
import { applyCockpitFilters } from "@/lib/cockpitFilters";
import { CarrierReasonsPopover } from "@/components/CarrierReasonsPopover";
import { AutoPilotPreviewDrawer } from "@/components/freight/auto-pilot-preview-drawer";
import { LwqContextChip, type LwqContextChipData } from "@/components/freight/lane-cross-link-chip";


interface CockpitChip {
  opportunityCarrierId: string;
  carrierId: string;
  carrierName: string;
  bucket: string;
  rank: number;
  fitScore: number;
  explanation?: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  /** Task #632 — true when carrier has positive bench outcomes on this lane in last 90d */
  bench?: boolean;
  /** Count of positive bench outcomes used for the "Bench Nx wins" chip label */
  benchWins?: number;
  /**
   * Task #633 — Capped, ordered "why this carrier" reason strings driven by
   * the carrier ranker. Mirrors `RankedCarrier.reasons` on the server.
   */
  reasons?: string[];
  /** Task #633 — suppression notes, rendered muted at the top of the popover. */
  suppressionReasons?: string[];
}

interface CockpitItem {
  opportunity: FreightOpportunity;
  chips: CockpitChip[];
  coverage: {
    included: number;
    sent: number;
    responded: number;
    excluded?: number;
    excludedReasons?: Record<string, number>;
    covered: boolean;
    stage?: "none" | "outreach" | "awaiting" | "partial" | "covered";
  };
  suggestedBuy: {
    rate: number | null;
    confidence: string;
    reason: string;
    marketRpm?: number | null;
    marketDeltaPct?: number | null;
    lastPaidRpm?: number | null;
    loads30d?: number | null;
  } | null;
  urgency: { score: number; level: "critical" | "high" | "medium" | "low"; reasons: string[] };
  freshnessMinutes: number | null;
  groupKey: string;
  customer: {
    id: string;
    name: string;
    accountTier: string | null;
    autoPilotEnabled: boolean;
  } | null;
  owner: { id: string; name: string } | null;
  sla: { level: "green" | "yellow" | "red" | null; ageMinutes: number | null };
  laneScore: number | null;
  /** Task #635 — joined from server in the same payload (no per-row N+1). */
  lwqContext?: LwqContextChipData | null;
  laneSignature?: string;
}

interface BulkActionResult {
  opportunityId: string;
  ok: boolean;
  message?: string;
  sent?: number;
  blocked?: number;
  loadFact?: { inserted: boolean; updated: boolean } | null;
}
interface BulkActionResponse {
  action: string;
  results: BulkActionResult[];
}

interface UserOption {
  id: string;
  name?: string | null;
  username?: string | null;
}

interface SavedViewResponse { view?: SavedView }

interface CockpitResponse {
  items: CockpitItem[];
  kpis: {
    total: number;
    generatedToday: number;
    readyToSend: number;
    sentAwaitingCarrier: number;
    atRiskPickup24h: number;
    coveredToday: number;
    avgFreshnessMinutes: number | null;
  };
  lastImport: { at: string; ageMinutes: number } | null;
  nextImport?: { at: string; inMinutes: number } | null;
  roiMetrics?: {
    responseByBucket: Record<string, { sent: number; responded: number }>;
    suppressionBreakdown: Record<string, number>;
    medianTimeToCoverMin: number | null;
  };
  sort: string;
  grouping: string;
}

interface SavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  isShared: boolean;
  isBuiltIn?: boolean;
}

interface CockpitPrefs {
  userId: string;
  orgId: string;
  activeViewId: string | null;
  layout: "table" | "calendar";
  grouping: "none" | "customer" | "pickup_day" | "lane";
  sort: "urgency" | "pickup_soonest" | "freshness" | "customer" | "lane";
  autopilotMutedUntil: string | null;
}


// Task #649 — count "interesting" deltas between the displayed feed and a
// fresh server payload: added rows, removed rows, status changes, urgency
// level changes, and new carrier replies. Used to label the refresh pill.
export function countCockpitDelta(prev: CockpitItem[], next: CockpitItem[]): number {
  const prevById = new Map(prev.map(i => [i.opportunity.id, i]));
  const nextIds = new Set(next.map(i => i.opportunity.id));
  let delta = 0;
  for (const it of next) {
    const before = prevById.get(it.opportunity.id);
    if (!before) { delta++; continue; }
    if (before.opportunity.status !== it.opportunity.status) { delta++; continue; }
    if ((before.urgency?.level ?? null) !== (it.urgency?.level ?? null)) { delta++; continue; }
    if ((before.coverage?.responded ?? 0) !== (it.coverage?.responded ?? 0)) { delta++; continue; }
  }
  for (const id of prevById.keys()) {
    if (!nextIds.has(id)) delta++;
  }
  return delta;
}

function fmtLane(o: string, os: string | null, d: string, ds: string | null) {
  return `${os ? `${o}, ${os.toUpperCase()}` : o} → ${ds ? `${d}, ${ds.toUpperCase()}` : d}`;
}
function fmtPickup(s: string | null | undefined) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "—";
}
function fmtAge(min: number | null | undefined) {
  if (min === null || min === undefined) return "—";
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / (60 * 24))}d`;
}
function urgencyTone(level: CockpitItem["urgency"]["level"]) {
  switch (level) {
    case "critical":
      return "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30";
    case "high":
      return "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30";
    case "medium":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}
function bucketTone(bucket: string) {
  switch (bucket) {
    case "proven": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
    case "strong_fit_underused": return "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30";
    case "exploratory": return "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30";
    case "rep_added": return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}
function freshnessPulseColor(min: number | null) {
  if (min === null) return "bg-muted";
  if (min < 60) return "bg-emerald-500 animate-pulse";
  if (min < 12 * 60) return "bg-amber-500";
  return "bg-red-500";
}

interface CarrierOption {
  id: string;
  name: string;
  rank: number;
  bench?: boolean;
  benchWins?: number;
}

/**
 * Task #636 — Combobox for selecting (or free-typing) the carrier name when
 * marking an Available Freight opportunity covered. Suggestions come from the
 * cockpit's per-opp ranked carrier chips so reps can one-tap the top-ranked
 * carrier without retyping. Free-typed values are still accepted.
 */
function CarrierCombobox({
  value,
  onChange,
  options,
  testId,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: CarrierOption[];
  testId: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={testId}
        >
          <span className="truncate text-left">
            {value || placeholder || "Select or type carrier..."}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter>
          <CommandInput
            placeholder="Type carrier name..."
            value={value}
            onValueChange={onChange}
            data-testid={`${testId}-input`}
          />
          <CommandList>
            <CommandEmpty>
              {value.trim() ? `Use "${value.trim()}"` : "No suggestions yet — type a carrier name"}
            </CommandEmpty>
            {options.map((opt) => (
              <CommandItem
                key={opt.id}
                value={opt.name}
                onSelect={(v) => {
                  onChange(v);
                  setOpen(false);
                }}
                data-testid={`${testId}-option-${opt.id}`}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value.trim().toLowerCase() === opt.name.trim().toLowerCase()
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                <div className="flex items-center gap-2">
                  <span className="text-sm">{opt.name}</span>
                  {opt.rank === 1 && (
                    <Badge variant="secondary" className="text-[10px]">Top</Badge>
                  )}
                  {opt.bench && opt.benchWins ? (
                    <Badge variant="outline" className="text-[10px]">
                      Bench {opt.benchWins}w
                    </Badge>
                  ) : null}
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}


export default function AvailableFreightPage() {
  const [search, setSearch] = useState("");
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  // Task #635 — `?lane=<sig>` deep-link from LWQ filters the cockpit to a
  // single lane signature so the rep lands directly on those opportunities.
  const [laneFilter, setLaneFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("lane");
    return v && v.length > 0 ? v : null;
  });
  // Re-sync laneFilter whenever the URL changes (so navigating in-place from
  // an LWQ deep link or back/forward updates the filtered cockpit view).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const v = new URLSearchParams(window.location.search).get("lane");
      setLaneFilter(v && v.length > 0 ? v : null);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<CockpitPrefs["grouping"]>("none");
  const [sort, setSort] = useState<CockpitPrefs["sort"]>("urgency");
  const [layout, setLayout] = useState<CockpitPrefs["layout"]>("table");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeHours, setSnoozeHours] = useState<string>("4");
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [autoPilotDrawerOpen, setAutoPilotDrawerOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewShared, setNewViewShared] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<
    | { action: "approve" | "send_top" | "dismiss"; extra?: Record<string, unknown> }
    | null
  >(null);
  const [bulkCoverOpen, setBulkCoverOpen] = useState(false);
  const [bulkCoverCarrier, setBulkCoverCarrier] = useState("");
  const [bulkCoverPaidRate, setBulkCoverPaidRate] = useState("");
  const [bulkCoverCustomerRate, setBulkCoverCustomerRate] = useState("");
  const [bulkCoverNotes, setBulkCoverNotes] = useState("");
  // Task #636 — per-cover opt-out flags. Default to true; rep can untick
  // any of the three downstream loops before submitting.
  const [bulkCoverApplyToBench, setBulkCoverApplyToBench] = useState(true);
  const [bulkCoverApplyToRateBand, setBulkCoverApplyToRateBand] = useState(true);
  const [bulkCoverOfferRecurringLane, setBulkCoverOfferRecurringLane] = useState(true);
  const [reassignTargetIds, setReassignTargetIds] = useState<string[] | null>(null);
  const [reassignToUserId, setReassignToUserId] = useState<string>("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [draftPreviewId, setDraftPreviewId] = useState<string | null>(null);
  const [outcomeTargetId, setOutcomeTargetId] = useState<string | null>(null);
  const [outcomeStatus, setOutcomeStatus] = useState<"covered" | "lost" | "no_bid">("covered");
  const [outcomeNotes, setOutcomeNotes] = useState<string>("");
  const [outcomeCarrier, setOutcomeCarrier] = useState<string>("");
  const [outcomePaidRate, setOutcomePaidRate] = useState<string>("");
  const [outcomeCustomerRate, setOutcomeCustomerRate] = useState<string>("");
  // Task #636 — per-cover opt-out flags for the per-row outcome modal.
  const [outcomeApplyToBench, setOutcomeApplyToBench] = useState(true);
  const [outcomeApplyToRateBand, setOutcomeApplyToRateBand] = useState(true);
  const [outcomeOfferRecurringLane, setOutcomeOfferRecurringLane] = useState(true);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() => {
    try { return localStorage.getItem("cockpit:lastSeenAt"); } catch { return null; }
  });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: usersResp } = useQuery<UserOption[]>({
    queryKey: ["/api/users"],
  });
  const users = usersResp ?? [];
  function ownerLabel(u: UserOption): string {
    return u.name || u.username || u.id;
  }

  const { data: prefsResp } = useQuery<{ prefs: CockpitPrefs | null }>({
    queryKey: ["/api/freight-opportunities/cockpit-prefs"],
  });
  const { data: viewsResp } = useQuery<{ views: SavedView[]; builtInViews?: SavedView[] }>({
    queryKey: ["/api/freight-opportunities/saved-views"],
  });
  const builtInViews = (viewsResp?.builtInViews ?? []).map(v => ({ ...v, isBuiltIn: true }));
  const customViews = viewsResp?.views ?? [];
  const savedViews: SavedView[] = [...builtInViews, ...customViews];

  // Hydrate UI state from prefs once.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!prefsResp) return;
    hydratedRef.current = true;
    const p = prefsResp.prefs;
    if (p) {
      setActiveViewId(p.activeViewId);
      setGrouping(p.grouping);
      setSort(p.sort);
      if (p.layout) setLayout(p.layout);
    }
  }, [prefsResp]);

  useEffect(() => {
    if (!activeViewId) return;
    const v = savedViews.find(v => v.id === activeViewId);
    if (!v) return;
    const f = v.filters as { search?: string; companyId?: string; status?: string };
    if (typeof f.search === "string") setSearch(f.search);
    if (typeof f.companyId === "string") setCompanyFilter(f.companyId);
    if (typeof f.status === "string") setStatusFilter(f.status);
  }, [activeViewId, savedViews]);

  const { data: currentUser } = useQuery<{ id: string } | null>({
    queryKey: ["/api/auth/me"],
  });

  const upsertPrefs = useMutation({
    mutationFn: async (patch: Partial<CockpitPrefs>) => {
      return apiRequest("PATCH", "/api/freight-opportunities/cockpit-prefs", patch);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit-prefs"] }),
  });

  // Persist grouping/sort/active view changes to prefs (debounced via simple effect dep).
  useEffect(() => {
    if (!hydratedRef.current) return;
    upsertPrefs.mutate({ activeViewId, grouping, sort, layout });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId, grouping, sort, layout]);

  const statusParam = statusFilter === "active"
    ? "new,ready_to_send,sent,awaiting_carrier_reply,awaiting_customer_confirm,partially_covered,awaiting_approval"
    : statusFilter === "all"
      ? ""
      : statusFilter;

  const feedKey = ["/api/freight-opportunities/cockpit", { status: statusParam, sort, grouping, companyId: companyFilter, lane: laneFilter }];
  const { data: serverFeed, isLoading, isError, refetch, isFetching } = useQuery<CockpitResponse>({
    queryKey: feedKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusParam) params.set("status", statusParam);
      params.set("sort", sort);
      params.set("grouping", grouping);
      if (companyFilter !== "all") params.set("companyId", companyFilter);
      if (laneFilter) params.set("lane", laneFilter);
      params.set("limit", "200");
      const res = await fetch(`/api/freight-opportunities/cockpit?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    // Refetch on focus so a tab-switch back from Excel/email surfaces fresh imports.
    refetchOnWindowFocus: true,
  });

  // Task #649 — buffer fresh server data into a "pending" slot whenever the
  // rep is mid-interaction with the feed (pointer over the list or keyboard
  // focus inside a row), so a focus refetch never re-sorts rows out from
  // under their cursor. The buffer applies on click of the refresh pill, on
  // Enter while focused on it, or after ~3s of idle outside the list.
  const feedListRef = useRef<HTMLDivElement>(null);
  const isInteractingRef = useRef(false);
  const [displayedFeed, setDisplayedFeed] = useState<CockpitResponse | null>(null);
  const [pendingFeed, setPendingFeed] = useState<CockpitResponse | null>(null);
  const [pendingDelta, setPendingDelta] = useState(0);
  const displayedRef = useRef<CockpitResponse | null>(null);
  const pendingRef = useRef<CockpitResponse | null>(null);
  useEffect(() => { displayedRef.current = displayedFeed; }, [displayedFeed]);
  useEffect(() => { pendingRef.current = pendingFeed; }, [pendingFeed]);

  const applyPending = useCallback(() => {
    const next = pendingRef.current;
    if (!next) return;
    setDisplayedFeed(next);
    setPendingFeed(null);
    setPendingDelta(0);
  }, []);

  // Task #649 — Escape on the pill dismisses the visible badge WITHOUT
  // applying. The buffered payload stays alive so the 3s trailing-idle
  // auto-apply still fires (or the next refetch will refresh the badge).
  const dismissPill = useCallback(() => {
    setPendingDelta(0);
  }, []);

  useEffect(() => {
    const el = feedListRef.current;
    if (!el) return;
    // Track pointer-inside and focus-inside as INDEPENDENT flags. Interaction
    // is the union (pointerInside || focusInside) so that crossing modalities
    // (e.g. mouse leaves but keyboard focus stays in a row) does NOT collapse
    // the interacting state. Only when both go false do we start the 3s
    // trailing timer to auto-apply pending updates.
    let pointerInside = false;
    let focusInside = false;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const reconcile = () => {
      const interacting = pointerInside || focusInside;
      if (interacting) {
        if (trailing) { clearTimeout(trailing); trailing = null; }
        isInteractingRef.current = true;
      } else {
        if (trailing) clearTimeout(trailing);
        trailing = setTimeout(() => {
          trailing = null;
          isInteractingRef.current = false;
          if (pendingRef.current) applyPending();
        }, 3_000);
      }
    };
    const onPointerEnter = () => { pointerInside = true; reconcile(); };
    const onPointerLeave = () => { pointerInside = false; reconcile(); };
    const onFocusIn = () => { focusInside = true; reconcile(); };
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) {
        focusInside = false;
        reconcile();
      }
    };
    el.addEventListener("pointerenter", onPointerEnter);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("focusin", onFocusIn as EventListener);
    el.addEventListener("focusout", onFocusOut as EventListener);
    return () => {
      el.removeEventListener("pointerenter", onPointerEnter);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("focusin", onFocusIn as EventListener);
      el.removeEventListener("focusout", onFocusOut as EventListener);
      if (trailing) clearTimeout(trailing);
    };
  }, [applyPending]);

  // Task #649 — only buffer SAME-QUERY refetches (focus/window/staleTime).
  // When the rep changes sort, grouping, status, customer, lane, or saved
  // view, the queryKey changes and the resulting payload must apply
  // immediately so the list reflects their action without pill gating.
  const prevFeedKeyRef = useRef<string | null>(null);
  const feedKeyString = JSON.stringify(feedKey);
  useEffect(() => {
    if (!serverFeed) return;
    const prev = displayedRef.current;
    const lastKey = prevFeedKeyRef.current;
    prevFeedKeyRef.current = feedKeyString;
    const keyChanged = lastKey !== null && lastKey !== feedKeyString;
    if (!prev || keyChanged) {
      setDisplayedFeed(serverFeed);
      setPendingFeed(null);
      setPendingDelta(0);
      return;
    }
    if (isInteractingRef.current) {
      setPendingFeed(serverFeed);
      setPendingDelta(countCockpitDelta(prev.items, serverFeed.items));
    } else {
      setDisplayedFeed(serverFeed);
      setPendingFeed(null);
      setPendingDelta(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverFeed, feedKeyString]);

  const feed = displayedFeed;

  useEffect(() => {
    if (!feed) return;
    const t = setTimeout(() => {
      const now = new Date().toISOString();
      try { localStorage.setItem("cockpit:lastSeenAt", now); } catch { /* ignore */ }
      setLastSeenAt(prev => prev ?? now);
    }, 4_000);
    return () => clearTimeout(t);
  }, [feed]);

  const items = feed?.items ?? [];
  const kpis = feed?.kpis;

  // Task #649 — toast fires off the raw server payload (not the buffered
  // displayedFeed) so reps still hear about new carrier replies the instant
  // the refetch lands, even if the visible list is paused mid-interaction.
  const replyTotalRef = useRef<number | null>(null);
  useEffect(() => {
    if (!serverFeed) return;
    const sItems = serverFeed.items;
    const myItems = currentUser?.id
      ? sItems.filter(it => it.owner?.id === currentUser.id)
      : [];
    const total = myItems.reduce((a, it) => a + (it.coverage?.responded ?? 0), 0);
    if (replyTotalRef.current !== null && total > replyTotalRef.current) {
      const delta = total - replyTotalRef.current;
      toast({
        title: `${delta} new carrier repl${delta === 1 ? "y" : "ies"}`,
        description: "Refreshed cockpit shows the latest replies.",
      });
    }
    replyTotalRef.current = total;
  }, [serverFeed, currentUser?.id, toast]);

  const activeView = activeViewId ? savedViews.find(v => v.id === activeViewId) : null;
  const viewFilters = (activeView?.filters ?? {}) as {
    ownerScope?: "mine" | "team";
    pickupWithinHours?: number;
    pickupAfterHours?: number;
    confidenceFlag?: "low" | "medium" | "high";
    sentNoReplyMinAgeMin?: number;
    statuses?: string[];
  };

  const filtered = useMemo(
    () => applyCockpitFilters(items, search, viewFilters, currentUser?.id ?? null, Date.now()),
    [items, search, viewFilters, currentUser?.id],
  );

  // Task #651 — warm the shared lane-signal cache for every visible
  // opportunity. Per-lane react-query keys mean LWQ and Customer Quotes
  // immediately reuse the result when they show the same lane.
  const visibleLaneSigs = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const it of filtered) {
      const o = it.opportunity.origin;
      const d = it.opportunity.destination;
      if (!o || !d) continue;
      const sig = laneSigKey(o, d);
      if (!seen.has(sig)) { seen.add(sig); out.push(sig); }
    }
    return out;
  }, [filtered]);
  useLaneSignals(visibleLaneSigs);

  // Task #636 — carrier typeahead suggestions for the per-row outcome modal
  // come from the targeted opp's ranked carrier chips. Top-ranked sits first.
  const outcomeCarrierOptions = useMemo<CarrierOption[]>(() => {
    if (!outcomeTargetId) return [];
    const it = filtered.find(x => x.opportunity.id === outcomeTargetId);
    if (!it) return [];
    return [...it.chips]
      .filter(c => c.carrierName)
      .sort((a, b) => a.rank - b.rank)
      .map(c => ({
        id: c.carrierId,
        name: c.carrierName,
        rank: c.rank,
        bench: c.bench,
        benchWins: c.benchWins,
      }));
  }, [filtered, outcomeTargetId]);

  // Task #636 — bulk-cover suggestions union of every selected opp's chips,
  // de-duplicated by carrier id and minimum rank wins (so a top-ranked carrier
  // on any opp surfaces as "Top").
  const bulkCarrierOptions = useMemo<CarrierOption[]>(() => {
    if (selected.size === 0) return [];
    const byId = new Map<string, CarrierOption>();
    filtered.forEach(it => {
      if (!selected.has(it.opportunity.id)) return;
      it.chips.forEach(c => {
        if (!c.carrierName) return;
        const prev = byId.get(c.carrierId);
        if (!prev || c.rank < prev.rank) {
          byId.set(c.carrierId, {
            id: c.carrierId,
            name: c.carrierName,
            rank: c.rank,
            bench: c.bench,
            benchWins: c.benchWins,
          });
        }
      });
    });
    return Array.from(byId.values()).sort((a, b) => a.rank - b.rank);
  }, [filtered, selected]);

  // Task #636 — when the rep opens the per-row outcome modal in "covered" mode
  // and hasn't typed anything, prefill with the top-ranked carrier suggestion.
  useEffect(() => {
    if (!outcomeTargetId) return;
    if (outcomeStatus !== "covered") return;
    if (outcomeCarrier.trim()) return;
    const top = outcomeCarrierOptions[0];
    if (top) setOutcomeCarrier(top.name);
    // Intentionally only watching modal open + status; we don't want to clobber
    // a value the rep just edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeTargetId, outcomeStatus]);

  // Same prefill for bulk-cover modal — defaults to the top-ranked carrier
  // across all selected opps.
  useEffect(() => {
    if (!bulkCoverOpen) return;
    if (bulkCoverCarrier.trim()) return;
    const top = bulkCarrierOptions[0];
    if (top) setBulkCoverCarrier(top.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkCoverOpen]);

  // Group items for display.
  const groups = useMemo(() => {
    if (grouping === "none") return [{ key: "all", label: "All", items: filtered }];
    const m = new Map<string, CockpitItem[]>();
    filtered.forEach(it => {
      const k = it.groupKey;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(it);
    });
    return Array.from(m.entries()).map(([k, v]) => ({ key: k, label: k, items: v }));
  }, [filtered, grouping]);

  const bulkMutate = useMutation<BulkActionResponse, Error, Record<string, unknown>>({
    mutationFn: async (body) => {
      const res = await apiRequest("POST", "/api/freight-opportunities/bulk-action", body);
      return res.json() as Promise<BulkActionResponse>;
    },
    onSuccess: (resp) => {
      const results = resp.results ?? [];
      const okCount = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok);
      const sent = results.reduce((acc, r) => acc + (r.sent ?? 0), 0);
      toast({
        title: `Bulk ${resp.action} done`,
        description: sent
          ? `${okCount}/${results.length} ok • ${sent} carriers sent${fail.length ? ` • ${fail.length} failed` : ""}`
          : `${okCount}/${results.length} ok${fail.length ? ` • ${fail.length} failed` : ""}`,
        variant: fail.length ? "destructive" : "default",
      });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities"] });
    },
    onError: (err) => {
      toast({ title: "Bulk action failed", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  // Run a bulk action against the selected opps; destructive actions go through confirm.
  function bulk(action: string, extra: Record<string, unknown> = {}) {
    if (selected.size === 0) return;
    if (action === "approve" || action === "send_top" || action === "dismiss") {
      setConfirmBulk({ action: action as "approve" | "send_top" | "dismiss", extra });
      return;
    }
    bulkMutate.mutate({ action, opportunityIds: Array.from(selected), ...extra });
  }

  // Saved-view CRUD.
  const createView = useMutation<SavedViewResponse, Error, { name: string; filters: Record<string, unknown>; isShared: boolean }>({
    mutationFn: async (b) => {
      const res = await apiRequest("POST", "/api/freight-opportunities/saved-views", b);
      return res.json() as Promise<SavedViewResponse>;
    },
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/saved-views"] });
      setSaveViewOpen(false);
      setNewViewName("");
      if (resp?.view?.id) setActiveViewId(resp.view.id);
      toast({ title: "View saved" });
    },
  });
  const deleteView = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/freight-opportunities/saved-views/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/saved-views"] });
      setActiveViewId(null);
    },
  });

  const toggleAutoPilotMutation = useMutation<unknown, Error, { companyId: string; enabled: boolean }>({
    mutationFn: async ({ companyId, enabled }) => {
      return apiRequest("PATCH", `/api/companies/${companyId}/outreach-policy`, { autoSendEnabled: enabled });
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
      toast({ title: vars.enabled ? "Auto-pilot enabled" : "Auto-pilot disabled" });
    },
    onError: (err) => toast({ title: "Couldn't update auto-pilot", description: String(err?.message ?? err), variant: "destructive" }),
  });
  const toggleAutoPilot = useCallback((it: CockpitItem) => {
    if (!it.customer?.id) return;
    toggleAutoPilotMutation.mutate({ companyId: it.customer.id, enabled: !it.customer.autoPilotEnabled });
  }, [toggleAutoPilotMutation]);

  const logOutcomeMutation = useMutation<
    {
      loops?: {
        bench?: { applied: boolean; reason: string; rows: Array<{ laneId: string; benchRowId: string }> };
        rateBand?: { applied: boolean; reason: string };
        recurringLaneSuggestion?: {
          suggested: boolean;
          reason: string;
          suggestion?: {
            origin: string;
            originState: string | null;
            destination: string;
            destinationState: string | null;
            equipmentType: string | null;
            companyId: string | null;
            companyName: string | null;
          };
        };
      } | null;
    } | null,
    Error,
    {
      id: string;
      status: "covered" | "lost" | "no_bid";
      notes: string;
      carrierName?: string;
      paidRate?: number;
      customerRate?: number;
      applyToBench?: boolean;
      applyToRateBand?: boolean;
      offerRecurringLane?: boolean;
    }
  >({
    mutationFn: async ({ id, status, notes, carrierName, paidRate, customerRate, applyToBench, applyToRateBand, offerRecurringLane }) => {
      // `apiRequest` returns the raw `Response`; parse JSON here so the
      // success handler can read `loops.recurringLaneSuggestion`.
      let res: Response;
      if (status === "covered") {
        res = await apiRequest("POST", `/api/freight-opportunities/${id}/cover`, {
          carrierName,
          paidRate,
          customerRate,
          notes: notes || undefined,
          applyToBench: applyToBench ?? true,
          applyToRateBand: applyToRateBand ?? true,
          offerRecurringLane: offerRecurringLane ?? true,
        });
      } else {
        res = await apiRequest("POST", "/api/freight-opportunities/bulk-action", {
          action: "dismiss",
          opportunityIds: [id],
          notes: notes || undefined,
          outcome: status,
        });
      }
      try {
        return await res.json();
      } catch {
        return null;
      }
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
      const targetCockpitItem = filtered.find(it => it.opportunity.id === variables.id);
      const companyName = targetCockpitItem?.customer?.name ?? null;
      setOutcomeTargetId(null);
      setOutcomeNotes("");
      setOutcomeCarrier("");
      setOutcomePaidRate("");
      setOutcomeCustomerRate("");
      setOutcomeStatus("covered");
      setOutcomeApplyToBench(true);
      setOutcomeApplyToRateBand(true);
      setOutcomeOfferRecurringLane(true);
      const loops = (data as { loops?: { recurringLaneSuggestion?: { suggested: boolean; suggestion?: { origin: string; originState: string | null; destination: string; destinationState: string | null; equipmentType: string | null; companyName: string | null } } } } | null | undefined)?.loops;
      const sugg = loops?.recurringLaneSuggestion;
      if (sugg?.suggested && sugg.suggestion) {
        // One-tap CTA: convert this lane into a recurring lane so future
        // opps inherit the cover carrier on the bench and the new rate
        // band moves with them.
        const s = sugg.suggestion;
        toast({
          title: "Outcome logged",
          description: `Set ${s.origin} → ${s.destination}${s.equipmentType ? ` · ${s.equipmentType}` : ""} as a recurring lane?`,
          action: (
            <Button
              size="sm"
              variant="default"
              data-testid="button-toast-set-recurring"
              onClick={() => {
                createRecurringLaneFromSuggestion.mutate({
                  origin: s.origin,
                  originState: s.originState,
                  destination: s.destination,
                  destinationState: s.destinationState,
                  equipmentType: s.equipmentType,
                  companyName: s.companyName ?? companyName,
                });
              }}
            >Set as recurring</Button>
          ),
        });
      } else {
        toast({ title: "Outcome logged" });
      }
    },
    onError: (err) => toast({ title: "Couldn't log outcome", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const createRecurringLaneFromSuggestion = useMutation<
    unknown,
    Error,
    {
      origin: string;
      originState: string | null;
      destination: string;
      destinationState: string | null;
      equipmentType: string | null;
      companyName: string | null;
    }
  >({
    mutationFn: async (vars) => {
      return apiRequest("POST", "/api/lanes/manual", {
        origin: vars.origin,
        originState: vars.originState ?? "",
        destination: vars.destination,
        destinationState: vars.destinationState ?? "",
        equipmentType: vars.equipmentType ?? "",
        companyName: vars.companyName ?? "",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/recurring-lanes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
      toast({ title: "Recurring lane created" });
    },
    onError: (err) => toast({ title: "Couldn't create recurring lane", description: String(err?.message ?? err), variant: "destructive" }),
  });

  const onKey = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    if (e.key === "j") {
      e.preventDefault();
      setFocusIndex(i => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "k") {
      e.preventDefault();
      setFocusIndex(i => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const it = filtered[focusIndex];
      if (it) navigate(`/available-freight/${it.opportunity.id}`);
    } else if (e.key === "x" || e.key === " ") {
      const it = filtered[focusIndex];
      if (it) {
        e.preventDefault();
        toggleSelected(it.opportunity.id);
      }
    } else if (e.key === "a" || e.key === "A") {
      if (selected.size > 0) bulk("approve");
    } else if (e.key === "s" || e.key === "S") {
      if (selected.size > 0) bulk("send_top", { topN: 3 });
    } else if (e.key === "r" || e.key === "R") {
      const targets = selected.size > 0
        ? Array.from(selected)
        : (filtered[focusIndex] ? [filtered[focusIndex].opportunity.id] : []);
      if (targets.length > 0) {
        e.preventDefault();
        setReassignToUserId("");
        setReassignTargetIds(targets);
      }
    } else if (e.key === "?" || (e.shiftKey && e.key === "/")) {
      e.preventDefault();
      setShowShortcutsHelp(true);
    } else if (e.key === "Escape") {
      setShowShortcutsHelp(false);
      setSelected(new Set());
      setFocusIndex(-1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, focusIndex, selected, navigate]);

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  function toggleSelected(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map(i => i.opportunity.id)));
  }

  async function handleUploadFile(file: File) {
    setIsUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/freight-opportunities/upload", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `${res.status}` }));
        throw new Error(err.error || `Upload failed (${res.status})`);
      }
      const summary = await res.json();
      toast({
        title: "Available freight imported",
        description: `${summary.inserted ?? 0} new, ${summary.updated ?? 0} updated, ${summary.expired ?? 0} expired`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Distinct customers for the filter dropdown.
  const customersForFilter = useMemo(() => {
    const seen = new Map<string, string>();
    items.forEach(i => {
      if (i.opportunity.companyId && !seen.has(i.opportunity.companyId)) {
        seen.set(i.opportunity.companyId, i.customer?.name ?? i.opportunity.companyId.slice(0, 8) + "…");
      }
    });
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [items]);

  const roi = useMemo(() => {
    const total = filtered.length;
    const sentRows = filtered.filter(i => i.coverage.sent > 0).length;
    const replyRows = filtered.filter(i => i.coverage.responded > 0).length;
    const coveredRows = filtered.filter(i => i.coverage.covered).length;
    const carriersContacted = filtered.reduce((a, b) => a + b.coverage.sent, 0);
    const repliedCarriers = filtered.reduce((a, b) => a + b.coverage.responded, 0);
    const replyRate = carriersContacted > 0 ? Math.round((repliedCarriers / carriersContacted) * 100) : 0;
    const coverageRate = total > 0 ? Math.round((coveredRows / total) * 100) : 0;
    return { total, sentRows, replyRows, coveredRows, carriersContacted, repliedCarriers, replyRate, coverageRate };
  }, [filtered]);

  return (
    <div className="container mx-auto p-4 space-y-4 max-w-screen-2xl">
      {/* Header + upload */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="heading-available-freight">
            <Truck className="h-6 w-6" /> Available Freight Cockpit
          </h1>
          <p className="text-sm text-muted-foreground">
            Triage open freight in priority order. Shortcuts: j/k move • x select • Enter open • A approve • S send top 3 • R reassign • Esc clear.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            data-testid="input-upload-available-freight"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadFile(f); }}
          />
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={isUploading} data-testid="button-upload-available-freight">
            <Upload className={`h-4 w-4 mr-2 ${isUploading ? "animate-pulse" : ""}`} />
            {isUploading ? "Uploading…" : "Upload Excel"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-cockpit">
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={() => setAutoPilotDrawerOpen(true)}
            data-testid="button-auto-pilot-preview"
          >
            <Truck className="h-4 w-4 mr-2" /> Auto-pilot preview
          </Button>
        </div>
      </div>
      <AutoPilotPreviewDrawer
        open={autoPilotDrawerOpen}
        onOpenChange={setAutoPilotDrawerOpen}
      />

      {/* KPI strip — Task #601 contract semantics */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        <KpiTile label="Generated today" value={kpis?.generatedToday ?? 0} testId="kpi-generated-today" />
        <KpiTile label="Ready to send" value={kpis?.readyToSend ?? 0} tone="ready" testId="kpi-ready" />
        <KpiTile label="Sent / awaiting carrier" value={kpis?.sentAwaitingCarrier ?? 0} tone="info" testId="kpi-sent-awaiting" />
        <KpiTile label="At-risk pickup ≤24h" value={kpis?.atRiskPickup24h ?? 0} tone="critical" testId="kpi-at-risk-24h" />
        <KpiTile label="Covered today" value={kpis?.coveredToday ?? 0} tone="ok" testId="kpi-covered-today" />
        <KpiTile label="Total in queue" value={kpis?.total ?? 0} testId="kpi-total" />
      </div>

      {/* Saved-view tab strip + freshness pulse */}
      <Card>
        <CardContent className="p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm" variant={activeViewId === null ? "default" : "outline"}
              onClick={() => setActiveViewId(null)}
              data-testid="button-view-all"
            >
              All
            </Button>
            {savedViews.map(v => (
              <div key={v.id} className="flex items-center gap-0.5">
                <Button
                  size="sm" variant={activeViewId === v.id ? "default" : "outline"}
                  onClick={() => setActiveViewId(v.id)}
                  data-testid={`button-view-${v.id}`}
                  title={v.isBuiltIn ? "Built-in view" : undefined}
                >
                  {v.isShared && <Star className="h-3 w-3 mr-1 fill-current" />}
                  {v.name}
                </Button>
                {/* Built-ins cannot be deleted from the UI — only user-created views. */}
                {activeViewId === v.id && !v.isBuiltIn && (
                  <Button
                    size="sm" variant="ghost" className="h-7 w-7 p-0"
                    onClick={() => deleteView.mutate(v.id)}
                    data-testid={`button-delete-view-${v.id}`}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setSaveViewOpen(true)} data-testid="button-save-view">
              <Bookmark className="h-3 w-3 mr-1" /> Save current
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-full ${freshnessPulseColor(feed?.lastImport?.ageMinutes ?? null)}`} data-testid="indicator-freshness-pulse" />
            <span data-testid="text-last-import">
              {feed?.lastImport
                ? `Last import ${fmtAge(feed.lastImport.ageMinutes)} ago`
                : "No import yet"}
            </span>
            {feed?.nextImport && (
              <span data-testid="text-next-import">
                · next in {fmtAge(feed.nextImport.inMinutes)}
              </span>
            )}
            {kpis?.avgFreshnessMinutes !== null && kpis?.avgFreshnessMinutes !== undefined && (
              <span>· avg row age {fmtAge(kpis.avgFreshnessMinutes)}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Task #635 — Lane deep-link banner (clearable) */}
      {laneFilter && (
        <div
          className="flex items-center justify-between gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300"
          data-testid="banner-lane-filter"
        >
          <span>
            Showing only opportunities for the selected LWQ lane.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => {
              setLaneFilter(null);
              const url = new URL(window.location.href);
              url.searchParams.delete("lane");
              window.history.replaceState({}, "", url.toString());
            }}
            data-testid="button-clear-lane-filter"
          >
            <X className="h-3 w-3 mr-1" /> Clear lane filter
          </Button>
        </div>
      )}

      {/* Filters & view controls */}
      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            <div className="lg:col-span-2 relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8" placeholder="Search lane, equipment, carrier…"
                value={search} onChange={(e) => setSearch(e.target.value)}
                data-testid="input-filter-search"
              />
            </div>
            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger data-testid="select-filter-company"><SelectValue placeholder="Customer" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                {customersForFilter.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="select-filter-status"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active queue</SelectItem>
                <SelectItem value="awaiting_approval">Awaiting approval</SelectItem>
                <SelectItem value="ready_to_send">Ready</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="awaiting_carrier_reply">Awaiting carrier</SelectItem>
                <SelectItem value="partially_covered">Partial</SelectItem>
                <SelectItem value="covered">Covered</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as CockpitPrefs["sort"])}>
              <SelectTrigger data-testid="select-sort"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="urgency">Sort: urgency</SelectItem>
                <SelectItem value="pickup_soonest">Sort: pickup soonest</SelectItem>
                <SelectItem value="freshness">Sort: freshest</SelectItem>
                <SelectItem value="suggested_buy">Sort: suggested buy</SelectItem>
                <SelectItem value="coverage_pct">Sort: coverage %</SelectItem>
                <SelectItem value="confidence">Sort: confidence</SelectItem>
                <SelectItem value="customer">Sort: customer</SelectItem>
                <SelectItem value="lane">Sort: lane</SelectItem>
              </SelectContent>
            </Select>
            <Select value={grouping} onValueChange={(v) => setGrouping(v as CockpitPrefs["grouping"])}>
              <SelectTrigger data-testid="select-grouping"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Group: none</SelectItem>
                <SelectItem value="customer">Group: customer</SelectItem>
                <SelectItem value="pickup_day">Group: pickup day</SelectItem>
                <SelectItem value="lane">Group: lane</SelectItem>
              </SelectContent>
            </Select>
            <Select value={layout} onValueChange={(v) => setLayout(v as CockpitPrefs["layout"])}>
              <SelectTrigger data-testid="select-layout"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="table">Layout: table</SelectItem>
                <SelectItem value="calendar">Layout: pickup-day swimlane</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-accent/40 p-2" data-testid="bar-bulk-actions">
          <div className="text-sm font-medium">{selected.size} selected</div>
          <div className="flex flex-wrap items-center gap-1">
            <Button size="sm" onClick={() => bulk("approve")} disabled={bulkMutate.isPending} data-testid="button-bulk-approve">
              <UserCheck className="h-3 w-3 mr-1" /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulk("send_top", { topN: 3 })} disabled={bulkMutate.isPending} data-testid="button-bulk-send-top">
              <Send className="h-3 w-3 mr-1" /> Send top 3
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSnoozeOpen(true)} disabled={bulkMutate.isPending} data-testid="button-bulk-snooze">
              <AlarmClock className="h-3 w-3 mr-1" /> Snooze
            </Button>
            <Button
              size="sm" variant="outline" disabled={bulkMutate.isPending}
              onClick={() => { setReassignToUserId(""); setReassignTargetIds(Array.from(selected)); }}
              data-testid="button-bulk-reassign"
            >
              <UserCheck className="h-3 w-3 mr-1" /> Reassign
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBulkCoverOpen(true)}
              disabled={bulkMutate.isPending}
              title="Cover the selected opportunities with one carrier and rate; emits load_fact for each"
              data-testid="button-bulk-covered"
            >
              <ClipboardCheck className="h-3 w-3 mr-1" /> Mark covered
            </Button>
            <Button size="sm" variant="outline" onClick={() => bulk("dismiss")} disabled={bulkMutate.isPending} data-testid="button-bulk-dismiss">
              <X className="h-3 w-3 mr-1" /> Dismiss
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} data-testid="button-bulk-clear">Clear</Button>
          </div>
        </div>
      )}

      {/* Main grid: rows + ROI side-rail */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <Card>
          <CardContent className="p-0">
            <div ref={feedListRef} className="relative" data-testid="cockpit-feed-container">
            {pendingDelta > 0 && (
              <div className="sticky top-0 z-10 flex justify-center px-3 pt-2 pb-1 bg-gradient-to-b from-background via-background/90 to-transparent pointer-events-none">
                <button
                  type="button"
                  onClick={applyPending}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      applyPending();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      dismissPill();
                    }
                  }}
                  className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary text-primary-foreground px-3 py-1 text-xs font-medium shadow-md hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="cockpit-refresh-pill"
                  aria-label={`${pendingDelta} new update${pendingDelta === 1 ? "" : "s"} — refresh`}
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>{pendingDelta} new update{pendingDelta === 1 ? "" : "s"} — refresh</span>
                </button>
              </div>
            )}
            {isError ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center" data-testid="state-error">
                <AlertCircle className="h-8 w-8 text-destructive" />
                <p className="text-sm font-medium">Couldn't load cockpit</p>
                <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
              </div>
            ) : isLoading ? (
              <div className="p-4 space-y-2" data-testid="state-loading">
                {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20 w-full" />)}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" data-testid="state-empty">
                <Inbox className="h-10 w-10 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">No opportunities match these filters</p>
                  <p className="text-xs text-muted-foreground">
                    Upload a workbook or wait for the next scheduled import.
                  </p>
                </div>
              </div>
            ) : (
              <div>
                {/* Select-all bar */}
                <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={selected.size > 0 && selected.size === filtered.length}
                    onCheckedChange={toggleAll}
                    data-testid="checkbox-select-all"
                  />
                  <span>Select all visible ({filtered.length})</span>
                </div>
                {layout === "calendar" ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 p-3" data-testid="layout-swimlane">
                    {(() => {
                      const lanes = new Map<string, CockpitItem[]>();
                      for (const it of filtered) {
                        const d = it.opportunity.pickupWindowStart
                          ? new Date(it.opportunity.pickupWindowStart).toISOString().slice(0, 10)
                          : "no-pickup";
                        if (!lanes.has(d)) lanes.set(d, []);
                        lanes.get(d)!.push(it);
                      }
                      const sortedLanes = Array.from(lanes.entries()).sort(([a], [b]) => a.localeCompare(b));
                      return sortedLanes.map(([date, laneItems]) => (
                        <div key={date} className="rounded-md border bg-muted/10" data-testid={`swimlane-${date}`}>
                          <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold flex items-center justify-between">
                            <span>{date === "no-pickup" ? "No pickup date" : new Date(date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
                            <span className="text-muted-foreground">{laneItems.length} load{laneItems.length === 1 ? "" : "s"}</span>
                          </div>
                          <div className="divide-y">
                            {laneItems.map((it, idx) => (
                              <CockpitRowView
                                key={it.opportunity.id}
                                item={it}
                                isSelected={selected.has(it.opportunity.id)}
                                onToggleSelected={() => toggleSelected(it.opportunity.id)}
                                isFocused={filtered[focusIndex]?.opportunity.id === it.opportunity.id}
                                onFocus={() => setFocusIndex(filtered.findIndex(x => x.opportunity.id === it.opportunity.id))}
                                onAction={(action, extra) => bulkMutate.mutate({ action, opportunityIds: [it.opportunity.id], ...(extra ?? {}) })}
                                onReassign={() => { setReassignToUserId(""); setReassignTargetIds([it.opportunity.id]); }}
                                onOpenDraft={() => setDraftPreviewId(it.opportunity.id)}
                                onLogOutcome={() => setOutcomeTargetId(it.opportunity.id)}
                                onToggleAutoPilot={() => toggleAutoPilot(it)}
                                index={idx}
                                lastSeenAt={lastSeenAt}
                                compact
                              />
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                ) : (
                  groups.map(g => {
                    const isCollapsed = collapsedGroups.has(g.key);
                    return (
                      <div key={g.key}>
                        {grouping !== "none" && (
                          <button
                            type="button"
                            className="w-full text-left border-b bg-muted/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide flex items-center gap-2 hover:bg-muted/50"
                            onClick={() => setCollapsedGroups(prev => {
                              const next = new Set(prev);
                              if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                              return next;
                            })}
                            data-testid={`group-header-${g.key}`}
                          >
                            <ChevronDown className={`h-3 w-3 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                            <span>{g.label} · {g.items.length}</span>
                            <span className="ml-auto text-[10px] text-muted-foreground normal-case font-normal">
                              {/* Roll-up: covered / awaiting reply / no outreach */}
                              {g.items.filter(i => i.coverage.covered).length} covered ·{" "}
                              {g.items.filter(i => i.coverage.sent > 0 && i.coverage.responded === 0).length} awaiting ·{" "}
                              {g.items.filter(i => i.coverage.sent === 0).length} no outreach
                            </span>
                          </button>
                        )}
                        {!isCollapsed && g.items.map((it, idx) => (
                          <CockpitRowView
                            key={it.opportunity.id}
                            item={it}
                            isSelected={selected.has(it.opportunity.id)}
                            onToggleSelected={() => toggleSelected(it.opportunity.id)}
                            isFocused={filtered[focusIndex]?.opportunity.id === it.opportunity.id}
                            onFocus={() => setFocusIndex(filtered.findIndex(x => x.opportunity.id === it.opportunity.id))}
                            onAction={(action, extra) => bulkMutate.mutate({ action, opportunityIds: [it.opportunity.id], ...(extra ?? {}) })}
                            onReassign={() => { setReassignToUserId(""); setReassignTargetIds([it.opportunity.id]); }}
                            onOpenDraft={() => setDraftPreviewId(it.opportunity.id)}
                            onLogOutcome={() => setOutcomeTargetId(it.opportunity.id)}
                            onToggleAutoPilot={() => toggleAutoPilot(it)}
                            index={idx}
                            lastSeenAt={lastSeenAt}
                          />
                        ))}
                      </div>
                    );
                  })
                )}
              </div>
            )}
            </div>
          </CardContent>
        </Card>

        {/* ROI side panel */}
        <Card>
          <CardContent className="p-3 space-y-3" data-testid="panel-roi">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> ROI snapshot
            </div>
            <div className="space-y-2 text-sm">
              <RoiRow label="Opportunities visible" value={String(roi.total)} testId="roi-total" />
              <RoiRow label="Sent / no reply" value={String(roi.sentRows - roi.replyRows)} testId="roi-no-reply" />
              <RoiRow label="With at least one reply" value={String(roi.replyRows)} testId="roi-replied" />
              <RoiRow label="Covered" value={`${roi.coveredRows} (${roi.coverageRate}%)`} testId="roi-coverage" />
              <RoiRow label="Carriers contacted" value={String(roi.carriersContacted)} testId="roi-carriers-contacted" />
              <RoiRow label="Reply rate" value={`${roi.replyRate}%`} testId="roi-reply-rate" />
              {feed?.roiMetrics?.medianTimeToCoverMin !== null &&
                feed?.roiMetrics?.medianTimeToCoverMin !== undefined && (
                <RoiRow
                  label="Median time to cover"
                  value={fmtAge(feed.roiMetrics.medianTimeToCoverMin)}
                  testId="roi-median-time-to-cover"
                />
              )}
              <div className="pt-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>Coverage progress</span>
                  <span>{roi.coverageRate}%</span>
                </div>
                <Progress value={roi.coverageRate} data-testid="progress-roi-coverage" />
              </div>
            </div>

            {/* Response rate per carrier bucket — sourced from server roiMetrics */}
            {feed?.roiMetrics?.responseByBucket &&
              Object.keys(feed.roiMetrics.responseByBucket).length > 0 && (
              <div className="border-t pt-2 space-y-1" data-testid="panel-roi-by-bucket">
                <div className="text-xs font-semibold text-muted-foreground">
                  Response by carrier bucket
                </div>
                {Object.entries(feed.roiMetrics.responseByBucket).map(([bucket, v]) => {
                  const rate = v.sent > 0 ? Math.round((v.responded / v.sent) * 100) : 0;
                  return (
                    <div
                      key={bucket}
                      className="flex items-center justify-between text-xs"
                      data-testid={`roi-bucket-${bucket}`}
                    >
                      <span className="capitalize">{bucket.replace(/_/g, " ")}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {v.responded}/{v.sent} ({rate}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Suppression breakdown — explains the carriers we filtered out */}
            {feed?.roiMetrics?.suppressionBreakdown &&
              Object.keys(feed.roiMetrics.suppressionBreakdown).length > 0 && (
              <div className="border-t pt-2 space-y-1" data-testid="panel-roi-suppression">
                <div className="text-xs font-semibold text-muted-foreground">
                  Suppressed carriers (why)
                </div>
                {Object.entries(feed.roiMetrics.suppressionBreakdown)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([reason, count]) => (
                    <div
                      key={reason}
                      className="flex items-center justify-between text-xs"
                      data-testid={`roi-suppression-${reason}`}
                    >
                      <span className="capitalize">{reason.replace(/_/g, " ")}</span>
                      <span className="tabular-nums text-muted-foreground">{count}</span>
                    </div>
                  ))}
              </div>
            )}

            <div className="border-t pt-2 text-xs text-muted-foreground">
              Auto-pilot uses each customer's top-N carrier limit. Mute or change the
              hour in the customer's outreach policy.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Snooze dialog */}
      <Dialog open={snoozeOpen} onOpenChange={setSnoozeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Snooze {selected.size} opportunit{selected.size === 1 ? "y" : "ies"}</DialogTitle>
            <DialogDescription>
              Hide from the cockpit until the wake time. Audit log records who snoozed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="snooze-hours">Hours from now</Label>
            <Input
              id="snooze-hours" type="number" min="1" max="168"
              value={snoozeHours} onChange={(e) => setSnoozeHours(e.target.value)}
              data-testid="input-snooze-hours"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnoozeOpen(false)}>Cancel</Button>
            <Button
              onClick={() => {
                const h = Math.max(1, parseInt(snoozeHours) || 4);
                const until = new Date(Date.now() + h * 3600_000).toISOString();
                bulk("snooze", { snoozeUntil: until });
                setSnoozeOpen(false);
              }}
              data-testid="button-snooze-confirm"
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk-action confirm dialog. Per reviewer feedback (Task #601),
          outbound or destructive bulk actions must require explicit confirm
          so dispatchers don't accidentally fire dozens of sends. */}
      <Dialog open={!!confirmBulk} onOpenChange={(open) => { if (!open) setConfirmBulk(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle data-testid="dialog-bulk-confirm-title">
              {confirmBulk?.action === "approve" && `Approve ${selected.size} opportunit${selected.size === 1 ? "y" : "ies"}?`}
              {confirmBulk?.action === "send_top" && `Send top ${(confirmBulk.extra?.topN as number) ?? 3} carriers for ${selected.size} opportunit${selected.size === 1 ? "y" : "ies"}?`}
              {confirmBulk?.action === "dismiss" && `Dismiss ${selected.size} opportunit${selected.size === 1 ? "y" : "ies"}?`}
            </DialogTitle>
            <DialogDescription>
              {confirmBulk && (() => {
                const sel = items.filter(i => selected.has(i.opportunity.id));
                const customers = new Set(sel.map(i => i.opportunity.companyId)).size;
                const carriers = sel.reduce((acc, i) => acc + i.coverage.included, 0);
                if (confirmBulk.action === "send_top") {
                  const topN = (confirmBulk.extra?.topN as number) ?? 3;
                  const willSend = sel.reduce((acc, i) => acc + Math.min(topN, Math.max(0, i.coverage.included - i.coverage.sent)), 0);
                  return `${selected.size} loads across ${customers} customer${customers === 1 ? "" : "s"} • approx ${willSend} carrier emails will be sent (guardrails still apply).`;
                }
                if (confirmBulk.action === "approve") {
                  return `${selected.size} loads across ${customers} customer${customers === 1 ? "" : "s"} will move to ready_to_send. ${carriers} shortlisted carriers may be sent next.`;
                }
                if (confirmBulk.action === "dismiss") {
                  return `${selected.size} loads will be cancelled and hidden. The audit log records this action.`;
                }
                return `${selected.size} loads will be marked covered. This skips outreach for any remaining shortlisted carriers.`;
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBulk(null)} data-testid="button-bulk-confirm-cancel">Cancel</Button>
            <Button
              variant={confirmBulk?.action === "dismiss" ? "destructive" : "default"}
              disabled={bulkMutate.isPending}
              onClick={() => {
                if (!confirmBulk) return;
                bulkMutate.mutate({ action: confirmBulk.action, opportunityIds: Array.from(selected), ...(confirmBulk.extra ?? {}) });
                setConfirmBulk(null);
              }}
              data-testid="button-bulk-confirm-go"
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reassign dialog — drives both bulk-bar and per-row reassign menu. */}
      <Dialog open={!!reassignTargetIds} onOpenChange={(open) => { if (!open) setReassignTargetIds(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reassign {reassignTargetIds?.length ?? 0} opportunit{(reassignTargetIds?.length ?? 0) === 1 ? "y" : "ies"}
            </DialogTitle>
            <DialogDescription>
              Pick a new owner. They become the responsible dispatcher and any
              awaiting-approval clock continues to tick.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reassign-owner">Owner</Label>
            <Select value={reassignToUserId} onValueChange={setReassignToUserId}>
              <SelectTrigger id="reassign-owner" data-testid="select-reassign-owner">
                <SelectValue placeholder="Select a user…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassign__">Unassign (no owner)</SelectItem>
                {users.map(u => (
                  <SelectItem key={u.id} value={u.id}>{ownerLabel(u)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignTargetIds(null)} data-testid="button-reassign-cancel">Cancel</Button>
            <Button
              disabled={bulkMutate.isPending || !reassignToUserId}
              onClick={() => {
                if (!reassignTargetIds || !reassignToUserId) return;
                const ownerUserId = reassignToUserId === "__unassign__" ? null : reassignToUserId;
                bulkMutate.mutate({
                  action: "reassign",
                  opportunityIds: reassignTargetIds,
                  ownerUserId,
                });
                setReassignTargetIds(null);
              }}
              data-testid="button-reassign-confirm"
            >
              Reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* In-place "Open draft" preview — replaces the prior detail-page jump.
          Shows the carrier shortlist that would be sent and lets the dispatcher
          fire send-top right from the cockpit. */}
      <Dialog open={!!draftPreviewId} onOpenChange={(open) => { if (!open) setDraftPreviewId(null); }}>
        <DialogContent className="max-w-lg">
          {(() => {
            const target = items.find(i => i.opportunity.id === draftPreviewId);
            if (!target) {
              return (
                <>
                  <DialogHeader><DialogTitle>Draft preview</DialogTitle></DialogHeader>
                  <div className="text-sm text-muted-foreground">Opportunity is no longer in the cockpit feed.</div>
                </>
              );
            }
            return (
              <>
                <DialogHeader>
                  <DialogTitle data-testid="dialog-draft-title">
                    Draft for {fmtLane(target.opportunity.origin, target.opportunity.originState, target.opportunity.destination, target.opportunity.destinationState)}
                  </DialogTitle>
                  <DialogDescription>
                    The top carriers below will receive a templated outreach. Review and confirm to send.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  {target.chips.length === 0 ? (
                    <div className="text-sm text-muted-foreground" data-testid="text-draft-no-carriers">No carriers ranked yet — try a fresh import.</div>
                  ) : (
                    <ul className="divide-y rounded-md border" data-testid="list-draft-carriers">
                      {target.chips.slice(0, 3).map((c, i) => (
                        <li key={c.carrierId} className="flex items-center justify-between px-3 py-2 text-sm" data-testid={`row-draft-carrier-${i}`}>
                          <span className="font-medium truncate">{c.carrierName}</span>
                          <span className="text-xs text-muted-foreground">
                            {c.bucket} · fit {c.fitScore}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {target.suggestedBuy?.rate != null && (
                    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs" data-testid="text-draft-buy">
                      Suggested buy: ${target.suggestedBuy.rate.toFixed(2)}/mi · {target.suggestedBuy.confidence}
                    </div>
                  )}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDraftPreviewId(null)} data-testid="button-draft-cancel">Cancel</Button>
                  <Button
                    disabled={target.chips.length === 0 || bulkMutate.isPending}
                    onClick={() => {
                      bulkMutate.mutate({ action: "send_top", opportunityIds: [target.opportunity.id], topN: Math.min(3, target.chips.length) });
                      setDraftPreviewId(null);
                    }}
                    data-testid="button-draft-send"
                  >
                    Send to top {Math.min(3, target.chips.length)}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!outcomeTargetId} onOpenChange={(open) => {
        if (!open) {
          setOutcomeTargetId(null);
          setOutcomeNotes("");
          setOutcomeCarrier("");
          setOutcomePaidRate("");
          setOutcomeCustomerRate("");
          setOutcomeApplyToBench(true);
          setOutcomeApplyToRateBand(true);
          setOutcomeOfferRecurringLane(true);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log outcome</DialogTitle>
            <DialogDescription>
              Covered loads emit a load_fact row for coaching/rate intelligence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="outcome-status">Outcome</Label>
              <Select value={outcomeStatus} onValueChange={(v) => setOutcomeStatus(v as "covered" | "lost" | "no_bid")}>
                <SelectTrigger id="outcome-status" data-testid="select-outcome-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="covered">Won — covered</SelectItem>
                  <SelectItem value="lost">Lost</SelectItem>
                  <SelectItem value="no_bid">No bid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {outcomeStatus === "covered" && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="outcome-carrier">Carrier name</Label>
                  <CarrierCombobox
                    value={outcomeCarrier}
                    onChange={setOutcomeCarrier}
                    options={outcomeCarrierOptions}
                    testId="input-outcome-carrier"
                    placeholder="e.g. Acme Logistics"
                  />
                  {outcomeCarrierOptions.length > 0 && outcomeCarrierOptions[0].name === outcomeCarrier && (
                    <div className="text-[11px] text-muted-foreground" data-testid="text-outcome-carrier-hint">
                      Defaulted to top-ranked carrier — change if needed.
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="outcome-paid-rate">Paid rate ($)</Label>
                    <Input id="outcome-paid-rate" type="number" inputMode="decimal" min="0" step="0.01" value={outcomePaidRate} onChange={(e) => setOutcomePaidRate(e.target.value)} placeholder="2200" data-testid="input-outcome-paid-rate" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="outcome-customer-rate">Customer rate ($)</Label>
                    <Input id="outcome-customer-rate" type="number" inputMode="decimal" min="0" step="0.01" value={outcomeCustomerRate} onChange={(e) => setOutcomeCustomerRate(e.target.value)} placeholder="2500" data-testid="input-outcome-customer-rate" />
                  </div>
                </div>
                <div className="space-y-2 rounded-md border p-3">
                  <div className="text-xs font-medium text-muted-foreground">Capture loops</div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={outcomeApplyToBench}
                      onCheckedChange={(v) => setOutcomeApplyToBench(v === true)}
                      data-testid="checkbox-outcome-apply-bench"
                    />
                    <span>Add carrier to lane bench</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={outcomeApplyToRateBand}
                      onCheckedChange={(v) => setOutcomeApplyToRateBand(v === true)}
                      data-testid="checkbox-outcome-apply-rateband"
                    />
                    <span>Update lane rate band</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={outcomeOfferRecurringLane}
                      onCheckedChange={(v) => setOutcomeOfferRecurringLane(v === true)}
                      data-testid="checkbox-outcome-offer-recurring"
                    />
                    <span>Offer "Set as recurring lane" if no match</span>
                  </label>
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label htmlFor="outcome-notes">Notes (optional)</Label>
              <Input id="outcome-notes" value={outcomeNotes} onChange={(e) => setOutcomeNotes(e.target.value)} placeholder="Why, lane context, etc." data-testid="input-outcome-notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setOutcomeTargetId(null);
              setOutcomeNotes("");
              setOutcomeCarrier("");
              setOutcomePaidRate("");
              setOutcomeCustomerRate("");
            }} data-testid="button-outcome-cancel">Cancel</Button>
            <Button
              disabled={
                logOutcomeMutation.isPending
                || !outcomeTargetId
                || (outcomeStatus === "covered" && (!outcomeCarrier.trim() || !(parseFloat(outcomePaidRate) > 0) || !(parseFloat(outcomeCustomerRate) > 0)))
              }
              onClick={() => {
                if (!outcomeTargetId) return;
                logOutcomeMutation.mutate({
                  id: outcomeTargetId,
                  status: outcomeStatus,
                  notes: outcomeNotes,
                  ...(outcomeStatus === "covered" ? {
                    carrierName: outcomeCarrier.trim(),
                    paidRate: parseFloat(outcomePaidRate),
                    customerRate: parseFloat(outcomeCustomerRate),
                    // Task #636 — propagate per-cover loop opt-outs.
                    applyToBench: outcomeApplyToBench,
                    applyToRateBand: outcomeApplyToRateBand,
                    offerRecurringLane: outcomeOfferRecurringLane,
                  } : {}),
                });
              }}
              data-testid="button-outcome-confirm"
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkCoverOpen} onOpenChange={(open) => {
        if (!open) {
          setBulkCoverOpen(false);
          setBulkCoverCarrier("");
          setBulkCoverPaidRate("");
          setBulkCoverCustomerRate("");
          setBulkCoverNotes("");
          setBulkCoverApplyToBench(true);
          setBulkCoverApplyToRateBand(true);
          setBulkCoverOfferRecurringLane(true);
        }
      }}>
        <DialogContent data-testid="dialog-bulk-cover">
          <DialogHeader>
            <DialogTitle>Mark {selected.size} opportunit{selected.size === 1 ? "y" : "ies"} covered</DialogTitle>
            <DialogDescription>
              Applies the same carrier + rates to every selected opportunity. Each one routes through the canonical cover endpoint and emits a load_fact row for coaching/rate intelligence.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-cover-carrier">Carrier name</Label>
              <CarrierCombobox
                value={bulkCoverCarrier}
                onChange={setBulkCoverCarrier}
                options={bulkCarrierOptions}
                testId="input-bulk-cover-carrier"
                placeholder="e.g. Acme Logistics"
              />
              {bulkCarrierOptions.length > 0 && bulkCarrierOptions[0].name === bulkCoverCarrier && (
                <div className="text-[11px] text-muted-foreground" data-testid="text-bulk-cover-carrier-hint">
                  Defaulted to top-ranked carrier across selected opps — change if needed.
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="bulk-cover-paid-rate">Paid rate ($)</Label>
                <Input id="bulk-cover-paid-rate" type="number" inputMode="decimal" min="0" step="0.01" value={bulkCoverPaidRate} onChange={(e) => setBulkCoverPaidRate(e.target.value)} placeholder="2200" data-testid="input-bulk-cover-paid-rate" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-cover-customer-rate">Customer rate ($)</Label>
                <Input id="bulk-cover-customer-rate" type="number" inputMode="decimal" min="0" step="0.01" value={bulkCoverCustomerRate} onChange={(e) => setBulkCoverCustomerRate(e.target.value)} placeholder="2500" data-testid="input-bulk-cover-customer-rate" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-cover-notes">Notes (optional)</Label>
              <Input id="bulk-cover-notes" value={bulkCoverNotes} onChange={(e) => setBulkCoverNotes(e.target.value)} placeholder="Why, lane context, etc." data-testid="input-bulk-cover-notes" />
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <div className="text-xs font-medium text-muted-foreground">Capture loops (per cover)</div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={bulkCoverApplyToBench}
                  onCheckedChange={(v) => setBulkCoverApplyToBench(v === true)}
                  data-testid="checkbox-bulk-cover-apply-bench"
                />
                <span>Add carrier to lane bench for each opp</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={bulkCoverApplyToRateBand}
                  onCheckedChange={(v) => setBulkCoverApplyToRateBand(v === true)}
                  data-testid="checkbox-bulk-cover-apply-rateband"
                />
                <span>Update lane rate band for each opp</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={bulkCoverOfferRecurringLane}
                  onCheckedChange={(v) => setBulkCoverOfferRecurringLane(v === true)}
                  data-testid="checkbox-bulk-cover-offer-recurring"
                />
                <span>Surface recurring-lane suggestions when no match</span>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setBulkCoverOpen(false);
              setBulkCoverCarrier("");
              setBulkCoverPaidRate("");
              setBulkCoverCustomerRate("");
              setBulkCoverNotes("");
              setBulkCoverApplyToBench(true);
              setBulkCoverApplyToRateBand(true);
              setBulkCoverOfferRecurringLane(true);
            }} data-testid="button-bulk-cover-cancel">Cancel</Button>
            <Button
              disabled={
                bulkMutate.isPending
                || selected.size === 0
                || !bulkCoverCarrier.trim()
                || !(parseFloat(bulkCoverPaidRate) > 0)
                || !(parseFloat(bulkCoverCustomerRate) > 0)
              }
              onClick={() => {
                bulkMutate.mutate({
                  action: "mark_covered",
                  opportunityIds: Array.from(selected),
                  carrierName: bulkCoverCarrier.trim(),
                  paidRate: parseFloat(bulkCoverPaidRate),
                  customerRate: parseFloat(bulkCoverCustomerRate),
                  notes: bulkCoverNotes || undefined,
                  applyToBench: bulkCoverApplyToBench,
                  applyToRateBand: bulkCoverApplyToRateBand,
                  offerRecurringLane: bulkCoverOfferRecurringLane,
                });
                setBulkCoverOpen(false);
                setBulkCoverCarrier("");
                setBulkCoverPaidRate("");
                setBulkCoverCustomerRate("");
                setBulkCoverNotes("");
                setBulkCoverApplyToBench(true);
                setBulkCoverApplyToRateBand(true);
                setBulkCoverOfferRecurringLane(true);
              }}
              data-testid="button-bulk-cover-confirm"
            >
              Cover {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showShortcutsHelp} onOpenChange={setShowShortcutsHelp}>
        <DialogContent data-testid="dialog-shortcuts-help">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Move faster through the freight cockpit.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">j</kbd><span>Focus next row</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">k</kbd><span>Focus previous row</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">x</kbd><span>Toggle selection on focused row</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">Enter</kbd><span>Open focused opportunity</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">A</kbd><span>Approve selected</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">S</kbd><span>Send top 3 carriers for selected</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">R</kbd><span>Reassign selected (or focused) row</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">?</kbd><span>Show this cheat sheet</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">Esc</kbd><span>Clear selection / close dialogs</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowShortcutsHelp(false)} data-testid="button-close-shortcuts">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={saveViewOpen} onOpenChange={setSaveViewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>Save the current filters as a reusable view.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="view-name">Name</Label>
              <Input id="view-name" value={newViewName} onChange={(e) => setNewViewName(e.target.value)} data-testid="input-view-name" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="view-shared" checked={newViewShared} onCheckedChange={(v) => setNewViewShared(!!v)} data-testid="checkbox-view-shared" />
              <Label htmlFor="view-shared" className="text-sm">Share with team</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveViewOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createView.mutate({
                name: newViewName.trim() || "Untitled view",
                filters: { search, companyId: companyFilter, status: statusFilter },
                isShared: newViewShared,
              })}
              data-testid="button-view-save-confirm"
              disabled={createView.isPending}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


function KpiTile({ label, value, tone, testId }: { label: string; value: number; tone?: "critical" | "warn" | "ready" | "info" | "ok"; testId: string }) {
  const toneCls = tone === "critical"
    ? "text-red-700 dark:text-red-300"
    : tone === "warn"
      ? "text-amber-700 dark:text-amber-300"
      : tone === "ready"
        ? "text-blue-700 dark:text-blue-300"
        : tone === "info"
          ? "text-violet-700 dark:text-violet-300"
          : tone === "ok"
            ? "text-emerald-700 dark:text-emerald-300"
            : "text-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold tabular-nums ${toneCls}`} data-testid={`text-${testId}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function RoiRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums" data-testid={`text-${testId}`}>{value}</span>
    </div>
  );
}

function ownerInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function tierTone(tier: string | null): string {
  switch ((tier ?? "").toLowerCase()) {
    case "platinum": return "bg-slate-200 text-slate-900 dark:bg-slate-300/20 dark:text-slate-100 border-slate-400";
    case "gold":     return "bg-amber-200 text-amber-900 dark:bg-amber-300/20 dark:text-amber-100 border-amber-400";
    case "silver":   return "bg-zinc-200 text-zinc-900 dark:bg-zinc-300/20 dark:text-zinc-100 border-zinc-400";
    case "bronze":   return "bg-orange-200 text-orange-900 dark:bg-orange-300/20 dark:text-orange-100 border-orange-400";
    default:         return "bg-muted text-muted-foreground border-border";
  }
}

function slaDotColor(level: "green" | "yellow" | "red" | null): string {
  if (level === "red") return "bg-red-500";
  if (level === "yellow") return "bg-amber-500";
  if (level === "green") return "bg-emerald-500";
  return "bg-transparent";
}

function CockpitRowView(props: {
  item: CockpitItem;
  isSelected: boolean;
  isFocused: boolean;
  onToggleSelected: () => void;
  onFocus: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onReassign: () => void;
  onOpenDraft?: () => void;
  onLogOutcome?: () => void;
  onToggleAutoPilot?: () => void;
  index: number;
  lastSeenAt: string | null;
  compact?: boolean;
}) {
  const { item, isSelected, isFocused, onToggleSelected, onFocus, onAction, onReassign, onOpenDraft, onLogOutcome, onToggleAutoPilot, lastSeenAt } = props;
  const opp = item.opportunity;
  const coveragePct = item.coverage.included > 0
    ? Math.round((item.coverage.responded / Math.max(1, item.coverage.included)) * 100)
    : 0;
  // NEW pill — opp generated after the user's last visit. We only show it when
  // we *have* a baseline so the very first session doesn't paint everything new.
  const isNewSinceLastView = !!lastSeenAt && opp.generatedAt
    ? new Date(opp.generatedAt).getTime() > new Date(lastSeenAt).getTime()
    : false;

  return (
    <div
      onClick={onFocus}
      className={`flex flex-col gap-2 border-b px-3 py-3 hover:bg-accent/30 cursor-pointer ${isFocused ? "bg-accent/40" : ""}`}
      data-testid={`row-opportunity-${opp.id}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => { onToggleSelected(); }}
          onClick={(e) => e.stopPropagation()}
          data-testid={`checkbox-row-${opp.id}`}
        />
        {/* SLA dot — only shown while approval is pending */}
        {item.sla.level && (
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${slaDotColor(item.sla.level)}`}
            title={`Awaiting approval ${fmtAge(item.sla.ageMinutes)}`}
            data-testid={`indicator-sla-${opp.id}`}
          />
        )}
        <Badge variant="outline" className={urgencyTone(item.urgency.level)} data-testid={`badge-urgency-${opp.id}`}>
          {item.urgency.level} · {item.urgency.score}
        </Badge>
        {isNewSinceLastView && (
          <Badge className="bg-violet-600 text-white hover:bg-violet-600" data-testid={`badge-new-${opp.id}`}>NEW</Badge>
        )}
        <Link
          href={`/available-freight/${opp.id}`}
          className="font-medium hover:underline"
          data-testid={`link-opportunity-${opp.id}`}
        >
          {fmtLane(opp.origin, opp.originState, opp.destination, opp.destinationState)}
        </Link>
        {opp.equipmentType && <span className="text-xs text-muted-foreground">{opp.equipmentType}</span>}
        {item.lwqContext && (
          <LwqContextChip
            data={item.lwqContext}
            testId={`chip-lwq-context-${opp.id}`}
          />
        )}
        {item.customer && (
          <span className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground" data-testid={`text-customer-${opp.id}`}>{item.customer.name}</span>
            {item.customer.accountTier && (
              <Badge variant="outline" className={`text-[10px] ${tierTone(item.customer.accountTier)}`} data-testid={`badge-tier-${opp.id}`}>
                {item.customer.accountTier}
              </Badge>
            )}
            {item.customer.autoPilotEnabled && (
              <Badge variant="outline" className="text-[10px] bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30" data-testid={`badge-autopilot-${opp.id}`}>
                AP on
              </Badge>
            )}
          </span>
        )}
        <Badge variant="secondary" data-testid={`badge-status-${opp.id}`}>{opp.status.replace(/_/g, " ")}</Badge>
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Clock className="h-3 w-3" /> pickup {fmtPickup(opp.pickupWindowStart)}
        </span>
        {item.coverage.covered && (
          <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
            <CheckCircle2 className="h-3 w-3 mr-1" /> covered
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Owner avatar — small initials chip; falls back to "—" if unassigned */}
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
            title={item.owner ? item.owner.name : "Unassigned"}
            data-testid={`avatar-owner-${opp.id}`}
          >
            {item.owner ? ownerInitials(item.owner.name) : "—"}
          </span>
          <span className="text-xs text-muted-foreground" data-testid={`text-freshness-${opp.id}`}>{fmtAge(item.freshnessMinutes)} ago</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => e.stopPropagation()} data-testid={`button-row-menu-${opp.id}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Quick actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onOpenDraft?.()} data-testid={`menu-open-draft-${opp.id}`}>
                Open draft
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onLogOutcome?.()} data-testid={`menu-log-outcome-${opp.id}`}>
                Log outcome
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAction("approve")} data-testid={`menu-approve-${opp.id}`}>Approve</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAction("send_top", { topN: 3 })} data-testid={`menu-send-top-${opp.id}`}>Send top 3</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onAction("snooze", { snoozeUntil: new Date(Date.now() + 4 * 3600_000).toISOString() })} data-testid={`menu-snooze-${opp.id}`}>Snooze 4h</DropdownMenuItem>
              <DropdownMenuItem onClick={onReassign} data-testid={`menu-reassign-${opp.id}`}>Reassign…</DropdownMenuItem>
              {item.customer && onToggleAutoPilot && (
                <DropdownMenuItem onClick={() => onToggleAutoPilot()} data-testid={`menu-toggle-autopilot-${opp.id}`}>
                  {item.customer.autoPilotEnabled ? "Turn off auto-pilot for this customer" : "Turn on auto-pilot for this customer"}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onAction("dismiss")} data-testid={`menu-dismiss-${opp.id}`} className="text-destructive">Dismiss</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-7">
        {item.chips.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">No carriers shortlisted yet</span>
        ) : (
          item.chips.map(chip => {
            // Server-side fit-score reason for tooltip.
            const tip = [
              `${chip.bucket.replace(/_/g, " ")} • fit ${Math.round(chip.fitScore)}`,
              chip.explanation,
              chip.respondedAt
                ? "responded"
                : chip.sentAt
                  ? "sent, awaiting reply"
                  : "queued",
            ].filter(Boolean).join(" · ");
            const benchWins = chip.benchWins ?? 0;
            const showBench = !!chip.bench && benchWins > 0;
            return (
              <span key={chip.opportunityCarrierId} className="inline-flex items-center gap-1">
                {/*
                  Task #633 — wrap the carrier badge in CarrierReasonsPopover so
                  reps can see the ranker's "why this carrier" reasons on hover
                  (desktop) or tap (mobile). The native title= tooltip is kept
                  as a fallback for screen readers / older browsers.
                */}
                <CarrierReasonsPopover
                  carrierName={chip.carrierName}
                  reasons={chip.reasons ?? []}
                  suppressionReasons={chip.suppressionReasons ?? []}
                  testId={`trigger-reasons-${opp.id}-${chip.carrierId}`}
                >
                  <Badge
                    variant="outline"
                    className={`${bucketTone(chip.bucket)} cursor-help`}
                    data-testid={`chip-carrier-${opp.id}-${chip.carrierId}`}
                    title={tip}
                  >
                    #{chip.rank} {chip.carrierName}
                    {chip.respondedAt && <CheckCircle2 className="h-3 w-3 ml-1" />}
                    {!chip.respondedAt && chip.sentAt && <Send className="h-3 w-3 ml-1" />}
                  </Badge>
                </CarrierReasonsPopover>
                {showBench && (
                  <Badge
                    variant="outline"
                    className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 text-[10px] py-0 px-1.5"
                    data-testid={`chip-bench-${opp.id}-${chip.carrierId}`}
                    title={`replied yes ${benchWins}x in last 90d`}
                  >
                    Bench ({benchWins} wins)
                  </Badge>
                )}
              </span>
            );
          })
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground ml-auto">
          {item.suggestedBuy?.rate !== null && item.suggestedBuy?.rate !== undefined && (
            <span
              data-testid={`text-suggested-buy-${opp.id}`}
              title={[
                item.suggestedBuy.reason,
                item.suggestedBuy.lastPaidRpm
                  ? `Last paid $${item.suggestedBuy.lastPaidRpm.toFixed(2)}/mi · ${item.suggestedBuy.loads30d ?? 0} loads/30d`
                  : null,
              ].filter(Boolean).join(" — ")}
            >
              suggested ${item.suggestedBuy.rate.toFixed(2)}/mi · {item.suggestedBuy.confidence}
              {item.suggestedBuy.lastPaidRpm != null && (
                <span className="text-muted-foreground/70 ml-1" data-testid={`text-last-paid-${opp.id}`}>
                  (last ${item.suggestedBuy.lastPaidRpm.toFixed(2)})
                </span>
              )}
            </span>
          )}
          {/* Market delta badge — green when below market, red when above */}
          {item.suggestedBuy?.marketDeltaPct !== null &&
            item.suggestedBuy?.marketDeltaPct !== undefined && (
            <Badge
              variant="outline"
              className={
                item.suggestedBuy.marketDeltaPct <= 0
                  ? "border-emerald-300 text-emerald-700 dark:text-emerald-400"
                  : "border-red-300 text-red-700 dark:text-red-400"
              }
              data-testid={`badge-market-delta-${opp.id}`}
              title={
                item.suggestedBuy.marketRpm
                  ? `Market ~$${item.suggestedBuy.marketRpm.toFixed(2)}/mi`
                  : "vs current market RPM"
              }
            >
              {item.suggestedBuy.marketDeltaPct > 0 ? "+" : ""}
              {item.suggestedBuy.marketDeltaPct.toFixed(1)}% vs mkt
            </Badge>
          )}
          <span data-testid={`text-coverage-${opp.id}`}>
            {item.coverage.responded}/{item.coverage.sent || item.coverage.included || 0} replied
          </span>
          <div className="w-24">
            <Progress value={coveragePct} data-testid={`progress-coverage-${opp.id}`} />
          </div>
        </div>
      </div>

      {item.urgency.reasons.length > 0 && (
        <div className="pl-7 text-xs text-muted-foreground" data-testid={`text-urgency-reasons-${opp.id}`}>
          {item.urgency.reasons.join(" · ")}
        </div>
      )}
    </div>
  );
}
