import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLiveSync } from "@/hooks/useLiveSync";
import { useToast } from "@/hooks/use-toast";
import { isQuoteOpportunitiesRole } from "@shared/quoteOpportunitiesRoles";
import { formatCustomerName } from "@shared/laneFormatters";
import { computeQuoteSla, formatSlaBadge } from "@shared/quoteSla";
import { EmailThreadViewerModal } from "@/components/conversations/email-thread-viewer-modal";
import { PricingRecommendationCard } from "@/components/PricingRecommendationCard";
import { NewContactReviewStrip } from "@/components/customer-quotes/NewContactReviewStrip";
import { QuoteFreshnessStrip } from "@/components/QuoteFreshnessStrip";
import { NewQuoteDialog, type NewQuoteInitialValues } from "@/components/quote-requests/NewQuoteDialog";
import { SavedViewsDropdown, type QuoteViewFilters } from "@/components/quote-requests/SavedViewsDropdown";
import { SpotQuoteSearchPanel } from "@/components/quote-requests/SpotQuoteSearchPanel";
import { QuoteDetailsCard } from "@/components/quote-requests/QuoteDetailsCard";
import { PricingIntelGate } from "@/components/quote-requests/PricingIntelGate";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { ErrorBanner } from "@/components/ui/error-banner";
import { EmptyState } from "@/components/ui/empty-state";
// Task #967 — shared trust-layer primitives for the four ops tabs.
import { LiveSyncPill } from "@/components/live-sync/LiveSyncPill";
import { EmptyStateRecovery } from "@/components/empty-states/EmptyStateRecovery";
import {
  HiddenCountsDisclosure,
  type HiddenCountsSummary,
} from "@/components/freight/hidden-counts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextNotePanel, ContextNoteBadge } from "@/components/context-notes";

import {
  Search,
  Sparkles,
  Filter as FilterIcon,
  MoreHorizontal,
  Clock,
  Mail,
  ChevronRight,
  Check,
  X,
  Inbox as InboxIcon,
  Send,
  Pause,
  ChevronLeft,
  Briefcase,
  MapPin,
  Link2,
  ShieldAlert,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  Plus,
  ChevronUp,
  Loader2,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────

type Quote = {
  id: string;
  organizationId: string;
  customerId: string;
  customerName: string;
  repId: string | null;
  repName: string;
  laneGroupId: string | null;
  carrierId: string | null;
  carrierName: string | null;
  outcomeReasonId: string | null;
  outcomeReasonLabel: string | null;
  requestDate: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: string;
  quotedAmount: string | null;
  validThrough: string | null;
  outcomeStatus: string;
  carrierPaid: string | null;
  responseTimeHours: string | null;
  source: string;
  sourceReference: string | null;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  notes: string | null;
  score: string | null;
  slaState?: "ok" | "warning" | "breached" | "na";
  minutesSinceRequest?: number;
  // Task #849 — added by snooze migration; column always present, may be null.
  snoozedUntil?: string | null;
  isSnoozed?: boolean;
  // Free-email sender flag: not server-computed today; we infer from
  // sender domain when source thread metadata is available.
  isFreeEmailSender?: boolean;
};

type ListResult = { rows: Quote[]; total: number; offset: number; limit: number };

type Customer = {
  id: string;
  organizationId: string;
  name: string;
  segment: string | null;
  partyType?: "customer" | "carrier" | "unknown";
};

type Rep = { id: string; organizationId: string; name: string; email: string | null };
type Reason = { id: string; organizationId: string; code: string; label: string; category: string };

type Snapshot = {
  total: number;
  kpis: {
    total: number;
    won: number;
    lost: number;
    winRate: number;
    avgQuoted: number;
    avgCarrierCost: number;
    avgMarginDollar: number;
    avgMarginPct: number;
    avgResponseTime: number;
    pending: number;
    expiringSoon: number;
    // Server-side count of today's email-sourced opps. Optional during rollout.
    autoCapturedToday?: number;
    trend: { winRate: number; total: number; avgMargin: number; avgResponse: number };
  };
  customers: Customer[];
  reps: Rep[];
  reasons: Reason[];
};

type QuoteEvent = {
  id: string;
  quoteId: string;
  eventType: string;
  occurredAt: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
};

type QuoteSourceMessage = {
  messageId: string;
  threadId: string | null;
  providerMessageId: string | null;
  subject: string | null;
  fromEmail: string | null;
  receivedAt: string | null;
};

type QuoteDetail = {
  opp: Quote;
  events: QuoteEvent[];
  customer: Customer | null;
  rep: Rep | null;
  carrier: { id: string; name: string } | null;
  reason: Reason | null;
  relatedSameLane: Quote[];
  relatedSameCustomer: Quote[];
  relatedSameLaneGroup: Quote[];
  lwqLaneId: string | null;
  sourceMessage: QuoteSourceMessage | null;
  outcomeFlipContext: Record<string, unknown>;
};

type AutomationCounters = {
  generatedAt: string;
  organizationId: string;
  window: { label: string; startIso: string; endIso: string };
  counters: {
    created: number;
    attached: number;
    skippedInternal: number;
    skippedLowConfidence: number;
    wouldCreate?: number;
    wouldAttach?: number;
  };
  closureFlagEnabled: boolean;
  leakQueueDeepLink: string;
};

type StatusFilter = "all" | "new" | "quoted" | "won" | "lost" | "no_response";
type AgeFilter = "today" | "24h" | "7d" | "30d";
type SortKey = "requestDate" | "customerName" | "outcomeStatus" | "repName" | "originCity";
type AttachDecision = "attached" | "duplicate";
type LeakReason = "not_a_request" | "unparseable" | "wrong_party" | "duplicate_email" | "other";
type SendToLeakBody = { reason: LeakReason; note?: string; suppressSender?: boolean };
type SendToLeakResponse = { senderSuppressionRequested?: boolean; senderSuppressed?: boolean };
type SnoozeResponse = { status?: string };

// ─── Constants & helpers ──────────────────────────────────────────────────

const PAGE_SIZE = 50;

const STATUS_LABELS: Record<string, string> = {
  pending: "New",
  quoted: "Quoted",
  won: "Won",
  won_low_margin: "Won (low margin)",
  lost_price: "Lost — price",
  lost_service: "Lost — service",
  lost_timing: "Lost — timing",
  lost_incumbent: "Lost — incumbent",
  no_response: "No response",
  expired: "Expired",
  attached: "Attached",
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  quoted: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  won: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  won_low_margin: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30",
  lost_price: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  lost_service: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  lost_timing: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  lost_incumbent: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  no_response: "bg-muted text-muted-foreground border-border",
  expired: "bg-muted text-muted-foreground border-border",
  attached: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
};

const STATUS_GROUPS: Record<StatusFilter, string[]> = {
  all: [],
  new: ["pending"],
  quoted: ["quoted"],
  won: ["won", "won_low_margin"],
  lost: ["lost_price", "lost_service", "lost_timing", "lost_incumbent"],
  no_response: ["no_response", "expired"],
};

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "aol.com", "icloud.com", "msn.com", "live.com", "ymail.com",
]);

function fmtMoney(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!isFinite(n) || n === 0) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 0) {
    const s = Math.abs(Math.floor(diff / 1000));
    if (s < 60) return `in ${s}s`;
    if (s < 3600) return `in ${Math.floor(s / 60)}m`;
    if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
    return `in ${Math.floor(s / 86400)}d`;
  }
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ageHours(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!isFinite(t)) return 0;
  return (Date.now() - t) / 3_600_000;
}

function formatAbsTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function isTerminal(status: string): boolean {
  return [
    "won", "won_low_margin",
    "lost_price", "lost_service", "lost_timing", "lost_incumbent",
    "no_response", "expired", "attached",
  ].includes(status);
}

function inferIsSnoozed(q: Quote): boolean {
  if (typeof q.isSnoozed === "boolean") return q.isSnoozed;
  if (!q.snoozedUntil) return false;
  return Date.parse(q.snoozedUntil) > Date.now();
}

function emailDomain(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  return addr.slice(at + 1).toLowerCase();
}

// ─── Page-level container ─────────────────────────────────────────────────

export default function QuoteRequestsPage(): JSX.Element {
  const auth = useAuth();
  const role = auth?.user?.role ?? "";
  const allowed = isQuoteOpportunitiesRole(role);

  if (!allowed) {
    return (
      <div className="p-6">
        <QueryError message="You do not have permission to view Quote Requests." />
      </div>
    );
  }
  return <QuoteRequestsInner />;
}

function QuoteRequestsInner(): JSX.Element {
  const auth = useAuth();
  const role = auth?.user?.role ?? "";
  const myUserId = auth?.user?.id ?? null;
  // myRepId is the requesting user's quote_reps.id (resolved server-side
  // and surfaced via /snapshot). All ownership checks (isMine,
  // isOwnerOrManager) compare against this — quotes carry repId, which
  // is rep identity, NOT user identity, so user.id would never match.
  const [myRepId, setMyRepId] = useState<string | null>(null);
  const isElevated = ["admin", "director", "sales_director"].includes(role);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  // Cross-tab live updates so newly-captured quotes appear without manual refresh.
  useLiveSync(["customer_quote", "email_thread"]);

  // ─── Filter / view state ─────────────────────────────────────────────
  const [status, setStatus] = useState<StatusFilter>("all");
  const [age, setAge] = useState<AgeFilter>("today");
  const [mineOnly, setMineOnly] = useState(false);
  const [freeEmailOnly, setFreeEmailOnly] = useState(false);
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("requestDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [offset, setOffset] = useState(0);
  // selectedId controls the drawer (open/closed). focusedId is the
  // keyboard cursor (j/k) — separating them so j/k navigation never
  // accidentally pops the drawer; only Enter / click promotes focus
  // into selection (per spec §7).
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const sp = new URLSearchParams(window.location.search);
    return sp.get("quote");
  });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [newQuoteOpen, setNewQuoteOpen] = useState(false);
  // Spot Search → New Quote handoff prefill, cleared each time the
  // composer closes so a fresh "+ New Quote" click starts blank.
  const [newQuotePrefill, setNewQuotePrefill] = useState<NewQuoteInitialValues | undefined>(undefined);
  // "Past SLA" client-side post-filter: applied via the saved view, but
  // exposed as a top-level toggle so it survives filter chip changes
  // until cleared.
  const [pastSlaOnly, setPastSlaOnly] = useState(false);
  // Tracks which Saved View (built-in key or saved id) is currently
  // applied. Cleared whenever the user changes any underlying filter.
  const [activeViewKey, setActiveViewKey] = useState<string | null>(null);

  // Mirror selectedId into ?quote=<id> via history.replaceState so the
  // drawer is deep-linkable and survives reload/share, without
  // disturbing wouter's route state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    if (selectedId) sp.set("quote", selectedId);
    else sp.delete("quote");
    const next = sp.toString();
    const url = window.location.pathname + (next ? "?" + next : "") + window.location.hash;
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  // Debounce search input → query.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset offset when filters change.
  useEffect(() => { setOffset(0); }, [status, age, mineOnly, freeEmailOnly, domainFilter, search, sortKey, sortDir]);

  const currentFilters: QuoteViewFilters = useMemo(() => ({
    status, age, mineOnly, freeEmailOnly, includeSnoozed, search, domainFilter, pastSlaOnly,
  }), [status, age, mineOnly, freeEmailOnly, includeSnoozed, search, domainFilter, pastSlaOnly]);

  // Clear the "active saved view" indicator whenever the user toggles a
  // filter chip after applying a view. We snapshot the filter signature
  // at apply time and clear once the live signature drifts away — this
  // keeps the dropdown badge honest without trapping the user behind
  // any single view.
  const appliedSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeViewKey) return;
    const sig = JSON.stringify(currentFilters);
    if (appliedSignatureRef.current !== null && appliedSignatureRef.current !== sig) {
      setActiveViewKey(null);
      appliedSignatureRef.current = null;
    }
  }, [activeViewKey, currentFilters]);

  const applySavedView = useCallback((filters: QuoteViewFilters, key: string) => {
    setStatus((filters.status as StatusFilter) ?? "all");
    setAge((filters.age as AgeFilter) ?? "today");
    setMineOnly(!!filters.mineOnly);
    setFreeEmailOnly(!!filters.freeEmailOnly);
    setIncludeSnoozed(!!filters.includeSnoozed);
    setDomainFilter(filters.domainFilter ?? null);
    setSearchInput(filters.search ?? "");
    setSearch(filters.search ?? "");
    setPastSlaOnly(!!filters.pastSlaOnly);
    setActiveViewKey(key);
    // Snapshot what currentFilters _will_ be after the state updates flush.
    appliedSignatureRef.current = JSON.stringify({
      status: (filters.status as StatusFilter) ?? "all",
      age: (filters.age as AgeFilter) ?? "today",
      mineOnly: !!filters.mineOnly,
      freeEmailOnly: !!filters.freeEmailOnly,
      includeSnoozed: !!filters.includeSnoozed,
      search: filters.search ?? "",
      domainFilter: filters.domainFilter ?? null,
      pastSlaOnly: !!filters.pastSlaOnly,
    });
  }, []);

  // ─── Build query strings ──────────────────────────────────────────────
  const ageDates = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (age === "today") {
      start.setHours(0, 0, 0, 0);
    } else if (age === "24h") {
      start.setTime(now.getTime() - 24 * 3600 * 1000);
    } else if (age === "7d") {
      start.setTime(now.getTime() - 7 * 24 * 3600 * 1000);
    } else if (age === "30d") {
      start.setTime(now.getTime() - 30 * 24 * 3600 * 1000);
    }
    return { startDate: start.toISOString(), endDate: now.toISOString() };
  }, [age]);

  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    p.set("startDate", ageDates.startDate);
    p.set("endDate", ageDates.endDate);
    if (status !== "all") {
      const codes = STATUS_GROUPS[status];
      if (codes.length === 1) p.set("outcomeStatus", codes[0]!);
    }
    if (mineOnly) {
      // Resolved server-side to the user's quote_reps.id (never widens
      // scope — falls back to a no-op sentinel if the user has no rep).
      p.set("mineOnly", "1");
    }
    if (search) p.set("laneSearch", search);
    return p;
  }, [ageDates, status, mineOnly, myUserId, search]);

  const listParams = useMemo(() => {
    const p = new URLSearchParams(filterParams);
    p.set("sortKey", sortKey);
    p.set("sortDir", sortDir);
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(offset));
    if (includeSnoozed) p.set("includeSnoozed", "1");
    return p.toString();
  }, [filterParams, sortKey, sortDir, offset, includeSnoozed]);

  // ─── Queries ─────────────────────────────────────────────────────────
  const snapshotQuery = useQuery<Snapshot & { myRepId: string | null }>({
    queryKey: ["/api/customer-quotes/snapshot", filterParams.toString()],
    queryFn: async () => {
      const qs = filterParams.toString();
      const res = await fetch(`/api/customer-quotes/snapshot${qs ? "?" + qs : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load snapshot");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  // Pull myRepId out of snapshot once it's available; this is what every
  // ownership check downstream uses (never user.id).
  useEffect(() => {
    const id = snapshotQuery.data?.myRepId ?? null;
    setMyRepId(prev => (prev === id ? prev : id));
  }, [snapshotQuery.data?.myRepId]);

  const listQuery = useQuery<ListResult>({
    queryKey: ["/api/customer-quotes/list", listParams],
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/list?${listParams}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load quotes");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const automationQuery = useQuery<AutomationCounters>({
    queryKey: ["/api/quote-requests/automation-counters", "today"],
    queryFn: async () => {
      const res = await fetch("/api/quote-requests/automation-counters?window=today", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load automation counters");
      return res.json();
    },
    refetchInterval: 60_000,
    retry: 1,
  });

  // Keep status-by-bucket counts for KPIs that aren't in snapshot.
  const wonTodayCount = snapshotQuery.data?.kpis?.won ?? 0;
  const openCount = snapshotQuery.data?.kpis?.pending ?? 0;
  // "Awaiting your reply" — when Mine-only is on, the list is already
  // server-scoped to this user's rep, so any pending row is "mine".
  // When Mine-only is off, we don't have a cheap rep mapping client-side
  // and intentionally show "—" rather than guess.
  const myAwaitingCount = useMemo(() => {
    if (!mineOnly) return null;
    const rows = listQuery.data?.rows ?? [];
    return rows.filter(r => r.outcomeStatus === "pending").length;
  }, [listQuery.data, mineOnly]);
  const pastSlaCount = useMemo(() => {
    const rows = listQuery.data?.rows ?? [];
    return rows.filter(r => r.slaState === "breached").length;
  }, [listQuery.data]);

  // ─── Client-side post-filter (snooze + free-email + domain) ──────────
  const visibleRows = useMemo(() => {
    let rows = listQuery.data?.rows ?? [];
    if (!includeSnoozed) {
      rows = rows.filter(r => !inferIsSnoozed(r));
    }
    if (freeEmailOnly) {
      // A free-email row is one where the source thread came from a
      // public mail domain. Without per-row sender data we approximate
      // by checking the customer name length / "Unknown" bucket.
      rows = rows.filter(r => r.customerName === "Unknown — needs review");
    }
    if (domainFilter) {
      const dom = domainFilter.toLowerCase();
      rows = rows.filter(r => (r.customerName ?? "").toLowerCase().includes(dom));
    }
    if (pastSlaOnly) {
      rows = rows.filter(r => r.slaState === "breached");
    }
    return rows;
  }, [listQuery.data, includeSnoozed, freeEmailOnly, domainFilter, pastSlaOnly]);

  // ─── Domain options for the dropdown ─────────────────────────────────
  const domainOptions = useMemo(() => {
    const counts = new Map<string, number>();
    (listQuery.data?.rows ?? []).forEach(r => {
      const c = r.customerName?.split(" ")[0]?.toLowerCase();
      if (c && c.length > 1) counts.set(c, (counts.get(c) ?? 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15);
  }, [listQuery.data]);

  // ─── Keyboard navigation ─────────────────────────────────────────────
  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>();
    visibleRows.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [visibleRows]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        const el = document.getElementById("qr-search-input") as HTMLInputElement | null;
        el?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (selectedId) setSelectedId(null);
        return;
      }
      if (visibleRows.length === 0) return;
      const cursorId = focusedId ?? selectedId;
      const idx = cursorId ? (rowIndexById.get(cursorId) ?? -1) : -1;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(visibleRows.length - 1, idx + 1);
        setFocusedId(visibleRows[Math.max(0, next)]!.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = Math.max(0, idx - 1);
        setFocusedId(visibleRows[next]!.id);
      } else if (e.key === "Enter" && focusedId) {
        e.preventDefault();
        setSelectedId(focusedId);
      } else if (e.key === "[") {
        e.preventDefault();
        setOffset(o => Math.max(0, o - PAGE_SIZE));
      } else if (e.key === "]") {
        e.preventDefault();
        setOffset(o => o + PAGE_SIZE);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visibleRows, selectedId, focusedId, rowIndexById]);

  // Keep focus in-bounds when the visible row set shrinks/changes.
  useEffect(() => {
    if (focusedId && !rowIndexById.has(focusedId)) {
      setFocusedId(visibleRows[0]?.id ?? null);
    }
  }, [focusedId, rowIndexById, visibleRows]);

  const selectedQuote = useMemo(
    () => (selectedId ? visibleRows.find(r => r.id === selectedId) ?? null : null),
    [selectedId, visibleRows],
  );

  // Drawer prev/next nav: compute neighbors in the current visible list so
  // a rep working through the day can step through quotes without
  // closing the drawer between rows.
  const { prevId, nextId, posLabel } = useMemo(() => {
    if (!selectedId || visibleRows.length === 0) {
      return { prevId: null as string | null, nextId: null as string | null, posLabel: "" };
    }
    const idx = visibleRows.findIndex(r => r.id === selectedId);
    if (idx < 0) return { prevId: null, nextId: null, posLabel: "" };
    return {
      prevId: idx > 0 ? visibleRows[idx - 1]!.id : null,
      nextId: idx < visibleRows.length - 1 ? visibleRows[idx + 1]!.id : null,
      posLabel: `${idx + 1} of ${visibleRows.length}`,
    };
  }, [selectedId, visibleRows]);

  // Post-create reset: when the rep creates a new quote, clear filters
  // that could hide it (search, domain, terminal-only status) and jump
  // back to page 1, then open the drawer. Without this, a quote created
  // while the rep was looking at "Won today" or filtered by an old
  // search would create successfully but never appear in the drawer.
  const handleQuoteCreated = useCallback((id: string) => {
    setOffset(0);
    setSearchInput("");
    setSearch("");
    setDomainFilter(null);
    // If the rep was on a terminal-only view (Won/Lost), widen to "new"
    // so the freshly created quote (status = "new") is visible.
    if (status === "won" || status === "lost") setStatus("new");
    setActiveViewKey(null);
    appliedSignatureRef.current = null;
    setSelectedId(id);
    setFocusedId(id);
  }, [status]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
    queryClient.invalidateQueries({ queryKey: ["/api/quote-requests/automation-counters"] });
  }, []);

  // ─── Layout ──────────────────────────────────────────────────────────
  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen w-full bg-background text-foreground">
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/50 shrink-0">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight" data-testid="text-page-title">Quote Requests</h1>
              {/* Task #967 — shared live-sync health pill. */}
              <LiveSyncPill testId="pill-live-sync-quotes" />
              {/* Task #967 — hidden-counts disclosure. Shown in the
                  header so reps can see "N hidden of M total" without
                  having to scroll through the table. Built from the
                  list query's totals (server total) vs. the visible
                  rows after page-local filters. */}
              {(() => {
                const total = listQuery.data?.total ?? 0;
                const visible = visibleRows.length;
                if (total <= visible) return null;
                const buckets: HiddenCountsSummary["buckets"] = [];
                if (mineOnly) buckets.push({ id: "mine-only", label: "Hidden by Mine only", count: Math.max(0, total - visible) });
                else if (search) buckets.push({ id: "search", label: `Hidden by search "${search}"`, count: Math.max(0, total - visible) });
                else buckets.push({ id: "filters", label: "Hidden by active filters", count: Math.max(0, total - visible) });
                const summary: HiddenCountsSummary = { totalInScope: total, visible, buckets };
                return <HiddenCountsDisclosure summary={summary} surface="quotes" testId="disclosure-hidden-quotes" />;
              })()}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Every inbound request, one row, one source of truth</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                id="qr-search-input"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Lane, customer, sender, notes  /"
                className="pl-8 h-8 text-xs"
                data-testid="input-search"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={handleRefresh}
              data-testid="button-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button
              size="sm"
              className="h-8 bg-amber-500 hover:bg-amber-600 text-black font-medium"
              onClick={() => setNewQuoteOpen(true)}
              data-testid="button-new-quote"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              New quote
            </Button>
          </div>
        </div>

        {/* Snapshot error banner — surfaced above the KPI strip when the
            counters/saved-views snapshot query fails. The list table already
            renders its own error state below; this catches the case where
            the page chrome (KPIs, mineOnly defaulting) can't load. */}
        {snapshotQuery.isError ? (
          <div className="px-6 pt-4">
            <ErrorBanner
              message={(snapshotQuery.error as Error)?.message ?? "Could not load Quote Requests snapshot"}
            />
          </div>
        ) : null}

        {/* Task #923 — Trust-visibility freshness strip. Always-visible
            "Last capture run …" timestamp + conditional "X emails still
            being processed" hint when inbound-today materially exceeds
            captured opps. Decouples user trust from operational
            back-load latency without touching the KPI math. */}
        <QuoteFreshnessStrip />

        {/* KPI strip */}
        <div className="flex items-stretch px-6 py-4 gap-4 border-b border-border bg-muted/20 shrink-0">
          <KpiTile
            label="Open requests"
            value={openCount}
            isLoading={snapshotQuery.isLoading}
            testId="kpi-open"
            onClick={() => { setStatus("new"); setAge("7d"); }}
          />
          <KpiTile
            label="Awaiting your reply"
            value={myAwaitingCount ?? "—"}
            sub={mineOnly ? undefined : "Toggle Mine only"}
            isLoading={listQuery.isLoading}
            testId="kpi-awaiting"
            onClick={() => { setStatus("new"); setMineOnly(true); }}
          />
          <KpiTile
            label="Past SLA"
            value={pastSlaCount}
            tone="danger"
            isLoading={listQuery.isLoading}
            testId="kpi-past-sla"
          />
          <KpiTile
            label="Won today"
            value={wonTodayCount}
            tone="success"
            isLoading={snapshotQuery.isLoading}
            testId="kpi-won-today"
            onClick={() => { setStatus("won"); setAge("today"); }}
          />
          <KpiTile
            label="Auto-captured today"
            icon={<Sparkles className="h-3 w-3" />}
            // Prefer the snapshot's SQL-backed count; fall back to the
            // legacy in-process counter only during rollout.
            value={
              snapshotQuery.data?.kpis?.autoCapturedToday
              ?? automationQuery.data?.counters?.created
              ?? 0
            }
            tone="amber"
            isLoading={snapshotQuery.isLoading || automationQuery.isLoading}
            testId="kpi-auto-captured"
            disabled={!snapshotQuery.data && !automationQuery.data}
          />
        </div>

        {/* Filter row */}
        <div className="px-6 py-3 border-b border-border flex items-center justify-between bg-card/30 shrink-0 flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <SavedViewsDropdown
              currentFilters={currentFilters}
              activeKey={activeViewKey}
              onApply={applySavedView}
            />
            <Separator orientation="vertical" className="h-5" />
            <ChipGroup
              testIdPrefix="status"
              value={status}
              onChange={v => setStatus(v as StatusFilter)}
              options={[
                { value: "all", label: "All" },
                { value: "new", label: "New" },
                { value: "quoted", label: "Quoted" },
                { value: "won", label: "Won" },
                { value: "lost", label: "Lost" },
                { value: "no_response", label: "No-response" },
              ]}
            />
            <Separator orientation="vertical" className="h-5" />
            <ChipGroup
              testIdPrefix="age"
              value={age}
              onChange={v => setAge(v as AgeFilter)}
              options={[
                { value: "today", label: "Today" },
                { value: "24h", label: "24h" },
                { value: "7d", label: "7d" },
                { value: "30d", label: "30d" },
              ]}
            />
          </div>
          <div className="flex items-center gap-3 text-xs font-medium text-muted-foreground flex-wrap">
            <label className="flex items-center gap-1.5 cursor-pointer" data-testid="toggle-mine-only">
              <Switch checked={mineOnly} onCheckedChange={setMineOnly} className="h-4 w-7" />
              Mine only
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer" data-testid="toggle-free-email">
              <Switch checked={freeEmailOnly} onCheckedChange={setFreeEmailOnly} className="h-4 w-7" />
              Free-email senders
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer" data-testid="toggle-include-snoozed">
              <Switch checked={includeSnoozed} onCheckedChange={setIncludeSnoozed} className="h-4 w-7" />
              Include snoozed
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" data-testid="button-domain-filter">
                  <FilterIcon className="h-3 w-3" />
                  {domainFilter ? `Customer: ${domainFilter}` : "Customer"}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Filter by customer</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {domainFilter && (
                  <>
                    <DropdownMenuItem onClick={() => setDomainFilter(null)}>
                      Clear
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {domainOptions.length === 0 ? (
                  <div className="text-xs text-muted-foreground px-2 py-1.5">No customers in view</div>
                ) : (
                  domainOptions.map(([dom, count]) => (
                    <DropdownMenuItem
                      key={dom}
                      onClick={() => setDomainFilter(dom)}
                      data-testid={`menu-item-domain-${dom}`}
                    >
                      <span className="flex-1 capitalize">{dom}</span>
                      <span className="text-muted-foreground text-xs ml-2">{count}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Automation strip — placed under filters so the live counters
            sit at the top of the work surface (per spec §3.4 / §4.1)
            instead of being hidden in a footer. */}
        <AutomationStripFooter data={automationQuery.data} isLoading={automationQuery.isLoading} />

        {/* New-contact review prompts — strip above the table when the
            autopilot needs us to confirm new sender → contact mappings. */}
        {snapshotQuery.data && (
          <div className="px-6 pt-3">
            <NewContactReviewStrip />
          </div>
        )}

        {/* Spot Quote Search — collapsible panel between filters and the
            table. Reps use it to search lane history, build a deal sheet
            from search results, or paste an inbound RFQ for parsing. */}
        <SpotQuoteSearchPanel
          customers={snapshotQuery.data?.customers ?? []}
          onApplyLaneFilter={(laneSearch) => {
            setSearch(laneSearch);
            setSearchInput(laneSearch);
          }}
          onPickQuote={(id) => setSelectedId(id)}
          onPickCustomer={(id) => {
            const c = (snapshotQuery.data?.customers ?? []).find(c => c.id === id);
            if (c) setDomainFilter(c.name.split(" ")[0]?.toLowerCase() ?? null);
          }}
          onStartNewQuote={(prefill) => {
            // Spot Search → New Quote handoff: seed the composer with the
            // lane (and resolved customer if any) the rep was looking at.
            setNewQuotePrefill(prefill);
            setNewQuoteOpen(true);
          }}
        />

        {/* Body: table + drawer */}
        <div className="flex flex-1 overflow-hidden relative">
          <div className={`flex-1 overflow-hidden transition-all ${selectedId ? "pr-[520px]" : ""}`}>
            <ListTable
              rows={visibleRows}
              isLoading={listQuery.isLoading}
              isError={!!listQuery.error}
              error={listQuery.error}
              total={listQuery.data?.total ?? 0}
              offset={offset}
              onSetOffset={setOffset}
              selectedId={selectedId}
              focusedId={focusedId}
              onSelect={id => { setFocusedId(id); setSelectedId(id); }}
              onOpen={id => setSelectedId(id)}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={(k) => {
                if (k === sortKey) {
                  setSortDir(d => (d === "asc" ? "desc" : "asc"));
                } else {
                  setSortKey(k);
                  setSortDir("desc");
                }
              }}
              isElevated={isElevated}
              myRepId={myRepId}
              onRefresh={handleRefresh}
              // Task #967 — empty-state recovery wiring. Surface the
              // currently-active *page-local* filters as plain-text chips
              // and offer a one-click "Reset filters" escape hatch on the
              // shared <EmptyStateRecovery /> pane.
              emptyStateFilters={(() => {
                const out: string[] = [];
                if (mineOnly) out.push("Mine only");
                if (status !== "all") out.push(`Status: ${status}`);
                if (age !== "today") out.push(`Age: ${age}`);
                if (freeEmailOnly) out.push("Free email only");
                if (includeSnoozed) out.push("Including snoozed");
                if (pastSlaOnly) out.push("Past SLA only");
                if (domainFilter) out.push(`Domain: ${domainFilter}`);
                if (search) out.push(`Search: "${search}"`);
                return out;
              })()}
              onResetFilters={() => {
                setMineOnly(false);
                setStatus("all");
                setAge("today");
                setFreeEmailOnly(false);
                setIncludeSnoozed(false);
                setPastSlaOnly(false);
                setDomainFilter(null);
                setSearch("");
                setSearchInput("");
              }}
            />
          </div>
          {selectedQuote && (
            <DetailDrawer
              quote={selectedQuote}
              role={role}
              myRepId={myRepId}
              isElevated={isElevated}
              onClose={() => setSelectedId(null)}
              onRefresh={handleRefresh}
              onPrev={prevId ? () => { setSelectedId(prevId); setFocusedId(prevId); } : null}
              onNext={nextId ? () => { setSelectedId(nextId); setFocusedId(nextId); } : null}
              positionLabel={posLabel}
            />
          )}
        </div>

        <NewQuoteDialog
          open={newQuoteOpen}
          onOpenChange={(o) => {
            setNewQuoteOpen(o);
            // Drop the prefill on close so the next "+ New Quote" click
            // starts blank.
            if (!o) setNewQuotePrefill(undefined);
          }}
          customers={snapshotQuery.data?.customers ?? []}
          onCreated={handleQuoteCreated}
          initialValues={newQuotePrefill}
        />
      </div>
    </TooltipProvider>
  );
}

// ─── KpiTile ──────────────────────────────────────────────────────────────

function KpiTile({
  label, value, sub, tone, icon, onClick, isLoading, disabled, testId,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "default" | "danger" | "success" | "amber";
  icon?: React.ReactNode;
  onClick?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  testId?: string;
}): JSX.Element {
  const toneClass =
    tone === "danger" ? "text-red-500" :
    tone === "success" ? "text-emerald-500" :
    tone === "amber" ? "text-amber-500" :
    "text-foreground";
  const containerTone =
    tone === "amber" ? "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15" :
    "bg-card border-border hover:bg-muted/40";
  const labelTone =
    tone === "danger" ? "text-red-500" :
    tone === "success" ? "text-emerald-500" :
    tone === "amber" ? "text-amber-600" :
    "text-muted-foreground";
  const Wrapper = (onClick && !disabled ? "button" : "div") as React.ElementType;
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      data-testid={testId}
      disabled={disabled}
      className={`flex-1 ${containerTone} border rounded-md p-3 text-left transition-colors ${onClick && !disabled ? "cursor-pointer" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <div className={`flex items-center gap-1.5 text-xs ${labelTone} uppercase tracking-wider font-semibold`}>
        {icon}
        {label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${toneClass}`}>
        {isLoading ? <Skeleton className="h-7 w-12 inline-block" /> : value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </Wrapper>
  );
}

// ─── ChipGroup ────────────────────────────────────────────────────────────

function ChipGroup<T extends string>({
  value, onChange, options, testIdPrefix,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  testIdPrefix: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`h-7 rounded-sm px-2 text-xs font-medium border transition-colors ${
            opt.value === value
              ? "bg-foreground text-background border-foreground"
              : "bg-transparent text-muted-foreground border-border hover:bg-muted"
          }`}
          data-testid={`chip-${testIdPrefix}-${opt.value}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── ListTable ────────────────────────────────────────────────────────────

function ListTable({
  rows, isLoading, isError, error, total, offset, onSetOffset,
  selectedId, focusedId, onSelect, onOpen, sortKey, sortDir, onSort, isElevated, myRepId,
  onRefresh,
  emptyStateFilters, onResetFilters,
}: {
  rows: Quote[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  total: number;
  offset: number;
  onSetOffset: (n: number) => void;
  selectedId: string | null;
  focusedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  sortKey: string;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  isElevated: boolean;
  myRepId: string | null;
  onRefresh: () => void;
  // Task #967 — filter signal flowed down so ZeroState can render the
  // shared EmptyStateRecovery (filtered-empty pane) when appropriate.
  emptyStateFilters?: ReadonlyArray<string>;
  onResetFilters?: () => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the active row (focus cursor preferred, falls back to
  // selection) into view as keyboard navigation moves it.
  useEffect(() => {
    const id = focusedId ?? selectedId;
    if (!id || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-row-id="${id}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [focusedId, selectedId]);

  if (isError) {
    return (
      <div className="p-6">
        <ErrorBanner message={(error as Error)?.message ?? "Could not load quote requests"} />
      </div>
    );
  }

  if (isLoading && rows.length === 0) {
    return (
      <div className="p-6 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (!isLoading && rows.length === 0) {
    return (
      <ZeroState
        isElevated={isElevated}
        onRefresh={onRefresh}
        activeFilterLabels={emptyStateFilters}
        onResetFilters={onResetFilters}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div ref={containerRef} className="flex-1 overflow-auto">
        <table className="w-full text-left text-[13px] border-collapse">
          <thead className="sticky top-0 z-10 bg-card border-b border-border shadow-sm">
            <tr className="text-muted-foreground uppercase tracking-wider text-[10px] font-semibold">
              <th className="w-6 py-2 px-3"></th>
              <SortableHeader label="Customer" k="customerName" sortKey={sortKey as SortKey} sortDir={sortDir} onSort={onSort} />
              <SortableHeader label="Lane" k="originCity" sortKey={sortKey as SortKey} sortDir={sortDir} onSort={onSort} />
              <th className="py-2 px-3">Equipment</th>
              <SortableHeader label="Requested" k="requestDate" sortKey={sortKey as SortKey} sortDir={sortDir} onSort={onSort} />
              <th className="py-2 px-3">Age</th>
              <SortableHeader label="Status" k="outcomeStatus" sortKey={sortKey as SortKey} sortDir={sortDir} onSort={onSort} />
              <SortableHeader label="Rep" k="repName" sortKey={sortKey as SortKey} sortDir={sortDir} onSort={onSort} />
              <th className="py-2 px-3">Last activity</th>
              <th className="py-2 px-3 text-right pr-4">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {rows.map((q) => (
              <ListRow
                key={q.id}
                q={q}
                selected={selectedId === q.id}
                focused={focusedId === q.id && selectedId !== q.id}
                onClick={() => { onSelect(q.id); onOpen(q.id); }}
                myRepId={myRepId}
              />
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length || offset > 0 ? (
        <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground shrink-0">
          <div data-testid="text-pagination-info">
            Showing {offset + 1}–{offset + rows.length} of {total}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              disabled={offset === 0}
              onClick={() => onSetOffset(Math.max(0, offset - PAGE_SIZE))}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-3 w-3" /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1"
              disabled={offset + rows.length >= total}
              onClick={() => onSetOffset(offset + PAGE_SIZE)}
              data-testid="button-next-page"
            >
              Next <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SortableHeader({
  label, k, sortKey, sortDir, onSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}): JSX.Element {
  const active = sortKey === k;
  return (
    <th className="py-2 px-3">
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`uppercase tracking-wider text-[10px] font-semibold flex items-center gap-1 ${active ? "text-foreground" : "text-muted-foreground"} hover:text-foreground`}
        data-testid={`sort-${k}`}
      >
        {label}
        {active ? (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
      </button>
    </th>
  );
}

// ─── ListRow ──────────────────────────────────────────────────────────────

function ListRow({
  q, selected, focused, onClick, myRepId,
}: {
  q: Quote;
  selected: boolean;
  focused: boolean;
  onClick: () => void;
  myRepId: string | null;
}): JSX.Element {
  const snoozed = inferIsSnoozed(q);
  const sla = computeQuoteSla(q.requestDate, q.outcomeStatus);
  const slaTone = sla.state === "breached" ? "danger" : sla.state === "warning" ? "warning" : "ok";
  const ageH = ageHours(q.requestDate);
  const isMine = !!myRepId && q.repId === myRepId;
  const hasNew = q.outcomeStatus === "pending";
  const customerLabel = formatCustomerName(q.customerName) || q.customerName || "—";

  return (
    <tr
      data-row-id={q.id}
      onClick={onClick}
      className={`h-[34px] cursor-pointer transition-colors ${
        selected
          ? "bg-amber-500/10 hover:bg-amber-500/15"
          : focused
          ? "bg-muted/60 ring-1 ring-inset ring-amber-500/40"
          : "hover:bg-muted/40"
      }`}
      data-testid={`row-quote-${q.id}`}
    >
      <td className="px-3 text-center">
        <div className={`w-1.5 h-1.5 rounded-full mx-auto ${
          selected ? "bg-amber-500" :
          hasNew ? "bg-amber-500/60" :
          q.outcomeStatus === "won" ? "bg-emerald-500/60" :
          q.outcomeStatus.startsWith("lost") ? "bg-red-500/60" :
          "bg-transparent"
        }`} />
      </td>
      <td className="px-3 font-medium whitespace-nowrap">
        <HoverCard openDelay={400}>
          <HoverCardTrigger asChild>
            <span className="hover:underline" data-testid={`text-customer-${q.id}`}>{customerLabel}</span>
          </HoverCardTrigger>
          <HoverCardContent className="w-72 text-xs" align="start">
            <div className="font-semibold mb-1">{customerLabel}</div>
            {q.customerId ? (
              <a href={`/companies/${q.customerId}`} className="text-primary hover:underline text-xs">
                Open customer profile →
              </a>
            ) : (
              <span className="text-muted-foreground">No customer record</span>
            )}
            <Separator className="my-2" />
            <div className="grid grid-cols-2 gap-1 text-muted-foreground">
              <span>Source</span>
              <span className="text-foreground">{q.source}</span>
              <span>Equipment</span>
              <span className="text-foreground">{q.equipment}</span>
            </div>
          </HoverCardContent>
        </HoverCard>
        {snoozed && (
          <Badge variant="outline" className="ml-2 text-[9px] bg-muted/40 border-border">
            <Pause className="h-2.5 w-2.5 mr-1" /> Snoozed
          </Badge>
        )}
        {isMine && (
          <Badge variant="outline" className="ml-2 text-[9px] bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30">
            Mine
          </Badge>
        )}
      </td>
      <td className="px-3 whitespace-nowrap text-xs">
        <span className="font-medium text-foreground">{q.originCity}, {q.originState}</span>
        <span className="text-muted-foreground text-[10px] mx-1.5">→</span>
        <span className="font-medium text-foreground">{q.destCity}, {q.destState}</span>
      </td>
      <td className="px-3 text-xs text-muted-foreground">{q.equipment}</td>
      <td className="px-3 text-xs text-muted-foreground whitespace-nowrap" data-testid={`text-requested-${q.id}`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>{relativeTime(q.requestDate)}</span>
          </TooltipTrigger>
          <TooltipContent side="top">{formatAbsTime(q.requestDate)}</TooltipContent>
        </Tooltip>
      </td>
      <td className="px-3 text-xs whitespace-nowrap">
        <span className={`${
          slaTone === "danger" ? "text-red-500 font-medium" :
          slaTone === "warning" ? "text-amber-500 font-medium" :
          "text-muted-foreground"
        }`}>
          {ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))}m` :
           ageH < 24 ? `${ageH.toFixed(1)}h` :
           `${Math.round(ageH / 24)}d`}
        </span>
      </td>
      <td className="px-3 whitespace-nowrap">
        <span className={`inline-flex items-center px-2 h-5 text-[10px] font-medium uppercase rounded border ${STATUS_TONE[q.outcomeStatus] ?? "bg-muted text-muted-foreground border-border"}`} data-testid={`status-${q.id}`}>
          {STATUS_LABELS[q.outcomeStatus] ?? q.outcomeStatus}
        </span>
      </td>
      <td className="px-3 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          <Avatar className="h-5 w-5 border border-border">
            <AvatarFallback className="text-[9px]">{initials(q.repName)}</AvatarFallback>
          </Avatar>
          <span className="text-xs">{q.repName ?? "Unassigned"}</span>
        </div>
      </td>
      <td className="px-3 text-xs text-muted-foreground max-w-[220px] truncate">
        {q.outcomeReasonLabel ?? (q.outcomeStatus === "pending" ? "Awaiting reply" : "—")}
      </td>
      <td className="px-3 text-right text-[10px] uppercase tracking-wider text-muted-foreground pr-4 whitespace-nowrap">
        <span className={
          q.source === "email_signal" ? "text-amber-500 inline-flex items-center gap-1" :
          ""
        }>
          {q.source === "email_signal" && <Sparkles className="h-2.5 w-2.5" />}
          {q.source === "email_signal" ? "Auto" :
           q.source === "spot_search" ? "Spot" :
           q.source === "email" ? "Email" :
           q.source === "manual" ? "Manual" :
           q.source}
        </span>
      </td>
    </tr>
  );
}

/**
 * ZeroState — shown when the snapshot returns zero rows.
 *
 * Two shapes:
 *   1. Filtered-empty (`activeFilterLabels` present) — Task #967's shared
 *      <EmptyStateRecovery /> with a "Reset filters" escape hatch and an
 *      admin-gated deep-link to the Capture Leak Queue.
 *   2. Genuinely-empty — the elevated-aware pane that fixes a historical
 *      "dead button" bug: the original "Review Capture Leak Queue" used
 *      wouter's `navigate()` to push `/admin/integrations-health#leak-tile`.
 *      Both `/admin/integrations-health` and `/admin/quote-pipeline-health`
 *      hard-gate render to `user.role === "admin"`. Non-admin reps saw
 *      the URL change, the content area go blank, and no feedback. This
 *      branch now:
 *        - uses real `<Link>` elements (reliable wouter routing)
 *        - routes admins to the actionable pipeline-health page (with
 *          reprocess buttons) AND keeps the legacy leak-tile link
 *        - shows non-admin reps a "Refresh" action they can actually use
 *        - fires a toast on click so the rep sees feedback even if the
 *          destination page takes a moment to render
 */
function ZeroState({
  isElevated,
  onRefresh,
  activeFilterLabels,
  onResetFilters,
}: {
  isElevated: boolean;
  onRefresh: () => void;
  activeFilterLabels?: ReadonlyArray<string>;
  onResetFilters?: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onRefresh();
    toast({
      title: "Refreshing quote inbox",
      description: "Re-pulling today's snapshot, list, and capture counters.",
    });
    // Clear the spinner after the queries have a chance to resolve.
    // The actual data update is driven by the query layer; this is just
    // a UX affordance so the click feels responsive.
    window.setTimeout(() => setRefreshing(false), 1200);
  }, [onRefresh, toast]);

  // Task #967 — when filters are active, prefer the shared
  // EmptyStateRecovery so reps can tell "filtered to nothing" from
  // "genuinely empty inbox" and have a one-click reset escape hatch.
  // The admin-gated leak-queue link only appears for elevated users so
  // we don't reintroduce the historical "dead button" bug.
  if (activeFilterLabels && activeFilterLabels.length > 0) {
    return (
      <div className="h-full flex items-center justify-center p-8" data-testid="empty-quote-rows">
        <EmptyStateRecovery
          icon={InboxIcon}
          activeFilterLabels={activeFilterLabels}
          onResetFilters={onResetFilters}
          extraActions={isElevated ? [{
            label: "Review Capture Leak Queue",
            onClick: () => navigate("/admin/integrations-health#leak-tile"),
            testId: "button-review-capture-leak-queue",
          }] : undefined}
          testId="empty-quote-rows-recovery"
        />
      </div>
    );
  }
  return (
    <div className="h-full flex items-center justify-center p-8" data-testid="empty-quote-rows">
      <div className="flex flex-col items-center gap-4">
        <EmptyState
          icon={InboxIcon}
          title="No quote requests"
          description="Your inbox is clear. New requests will appear here as they arrive or are auto-captured from customer emails."
          action={{
            label: refreshing ? "Refreshing…" : "Refresh inbox",
            onClick: handleRefresh,
            disabled: refreshing,
          }}
          testId="zero-state-empty"
        />
        {isElevated && (
          <div className="flex flex-wrap items-center justify-center gap-2 -mt-2">
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="text-amber-600 hover:text-amber-500"
              data-testid="zero-state-pipeline-health-link"
              onClick={() =>
                toast({
                  title: "Opening Capture Leak Queue",
                  description: "Loading the pipeline drops console…",
                })
              }
            >
              <Link href="/admin/quote-pipeline-health">Review Capture Leak Queue</Link>
            </Button>
            <span className="text-[10px] text-muted-foreground">·</span>
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              data-testid="zero-state-integrations-health-link"
            >
              <Link href="/admin/integrations-health#leak-tile">Integrations health</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AutomationStripFooter ────────────────────────────────────────────────

function AutomationStripFooter({
  data, isLoading,
}: { data: AutomationCounters | undefined; isLoading: boolean }): JSX.Element {
  const c = data?.counters;
  return (
    <div className="px-6 py-1.5 bg-muted/30 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-foreground">
          {data?.closureFlagEnabled === false ? "Phase 2b (dry-run):" : "Phase 2b Auto-capture:"}
        </span>
        {isLoading ? (
          <Skeleton className="h-3 w-48" />
        ) : c ? (
          <>
            <span data-testid="text-counter-created">Created <strong className="text-foreground">{c.created}</strong></span>
            <span className="text-border">•</span>
            <span data-testid="text-counter-attached">Attached <strong className="text-foreground">{c.attached}</strong></span>
            <span className="text-border">•</span>
            <span data-testid="text-counter-skipped-internal">Skipped (internal) <strong className="text-foreground">{c.skippedInternal}</strong></span>
            <span className="text-border">•</span>
            <span data-testid="text-counter-skipped-low-conf">Skipped (low conf) <strong className="text-foreground">{c.skippedLowConfidence}</strong></span>
            {data?.closureFlagEnabled === false && c.wouldCreate !== undefined && (
              <>
                <span className="text-border">•</span>
                <span>Would-create <strong className="text-foreground">{c.wouldCreate}</strong></span>
                <span className="text-border">•</span>
                <span>Would-attach <strong className="text-foreground">{c.wouldAttach ?? 0}</strong></span>
              </>
            )}
          </>
        ) : (
          <span className="text-muted-foreground italic">unavailable</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <kbd className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">j/k</kbd>
        <span>navigate</span>
        <kbd className="ml-2 bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">enter</kbd>
        <span>open</span>
        <kbd className="ml-2 bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono border border-border">/</kbd>
        <span>search</span>
      </div>
    </div>
  );
}

// ─── DetailDrawer ─────────────────────────────────────────────────────────

function DetailDrawer({
  quote, role, myRepId, isElevated, onClose, onRefresh,
  onPrev, onNext, positionLabel,
}: {
  quote: Quote;
  role: string;
  myRepId: string | null;
  isElevated: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  positionLabel: string;
}): JSX.Element {
  const { toast } = useToast();
  const detailQuery = useQuery<QuoteDetail>({
    queryKey: ["/api/customer-quotes/quote", quote.id],
    queryFn: async () => {
      const res = await fetch(`/api/customer-quotes/quote/${quote.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load detail");
      return res.json();
    },
  });

  const [showThread, setShowThread] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showLeak, setShowLeak] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [showReply, setShowReply] = useState(false);

  const detail = detailQuery.data;
  const opp = detail?.opp ?? quote;
  const events = detail?.events ?? [];
  const sourceMessage = detail?.sourceMessage ?? null;
  const customer = detail?.customer ?? null;
  const isClosed = isTerminal(opp.outcomeStatus);
  const snoozed = inferIsSnoozed(opp as Quote);
  // Ownership = the user's quote_reps.id matches the quote's repId, OR
  // the user holds an elevated org-wide role. Comparing against user.id
  // would never match because repId is rep identity, not user identity.
  const isOwnerOrManager = isElevated || (!!myRepId && opp.repId === myRepId);

  // Mutations on the existing PATCH endpoint for outcome flips. The
  // body shape is open so the Mark Won guard can ship quotedAmount +
  // validThrough alongside outcomeStatus in a single request (the
  // server's PATCH route accepts all three at once).
  const markOutcomeMut = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/quote/${opp.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Quote updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", opp.id] });
      onRefresh();
    },
    onError: (err) => {
      toast({ title: "Update failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  // Mark Won guard: if a rep clicks Won before any quotedAmount is
  // saved, we open a small dialog to capture amount + valid-through so
  // the won record carries a real number for downstream reporting.
  const [markWonOpen, setMarkWonOpen] = useState(false);

  const sla = computeQuoteSla(opp.requestDate, opp.outcomeStatus);
  const slaText = formatSlaBadge(sla);
  const customerLabel = formatCustomerName(opp.customerName) || opp.customerName || "—";

  return (
    <>
      <div className="absolute top-0 right-0 w-[520px] h-full bg-card border-l border-border shadow-2xl flex flex-col z-20" data-testid="drawer-quote-detail">
        {/* Sticky header */}
        <div className="px-5 py-4 border-b border-border bg-card sticky top-0 z-10 shrink-0">
          <div className="flex justify-between items-start mb-3">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h2 className="text-xl font-bold tracking-tight truncate" data-testid="text-drawer-customer">
                  {customerLabel}
                </h2>
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                <span className="uppercase tracking-wider font-semibold">Quote Request</span>
                <span>·</span>
                <span className="font-mono text-[10px]">{opp.id.slice(0, 8)}</span>
                <span>·</span>
                <span>{relativeTime(opp.requestDate)}</span>
                {sla.state !== "ok" && sla.state !== "na" && (
                  <>
                    <span>·</span>
                    <span className={sla.state === "breached" ? "text-red-500 font-medium" : "text-amber-500 font-medium"}>
                      SLA {slaText}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Badge
                variant="outline"
                className={`uppercase tracking-wider text-[10px] ${STATUS_TONE[opp.outcomeStatus] ?? ""}`}
                data-testid="badge-drawer-status"
              >
                {STATUS_LABELS[opp.outcomeStatus] ?? opp.outcomeStatus}
              </Badge>
              {snoozed && (
                <Badge variant="outline" className="bg-muted/40 text-[10px]">
                  <Pause className="h-2.5 w-2.5 mr-1" /> Snoozed
                </Badge>
              )}
              <div className="flex items-center gap-0.5 mr-1" data-testid="drawer-pager">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded"
                  onClick={() => onPrev?.()}
                  disabled={!onPrev}
                  title="Previous quote"
                  data-testid="button-drawer-prev"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {positionLabel && (
                  <span className="text-[10px] text-muted-foreground tabular-nums px-1" data-testid="text-drawer-position">
                    {positionLabel}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded"
                  onClick={() => onNext?.()}
                  disabled={!onNext}
                  title="Next quote"
                  data-testid="button-drawer-next"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={onClose} data-testid="button-close-drawer">
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-sm bg-muted/50 px-2 py-1 rounded border border-border">
              <Avatar className="h-6 w-6 border border-border">
                <AvatarFallback className="text-[10px] bg-card">{initials(opp.repName)}</AvatarFallback>
              </Avatar>
              <span className="font-medium text-xs">{opp.repName || "Unassigned"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {sourceMessage?.threadId && (
                <Button
                  size="sm"
                  className="h-8 bg-amber-500 hover:bg-amber-600 text-black font-medium gap-1.5"
                  onClick={() => setShowReply(true)}
                  disabled={isClosed}
                  data-testid="button-send-reply"
                >
                  <Mail className="h-3.5 w-3.5" /> Send reply
                </Button>
              )}
              <div className="flex items-center">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-r-none border-r-0 px-3 hover:bg-emerald-500/10 hover:text-emerald-500 hover:border-emerald-500/30"
                  disabled={isClosed || markOutcomeMut.isPending || !isOwnerOrManager}
                  onClick={() => {
                    // Guard: if the quote has no quoted amount yet, open
                    // the Mark Won composer so we capture price + valid
                    // through alongside the win in a single PATCH. The
                    // server's PATCH route accepts all three fields at
                    // once, so this avoids a half-state.
                    const amt = (opp.quotedAmount ?? "").toString().trim();
                    if (!amt) {
                      setMarkWonOpen(true);
                    } else {
                      markOutcomeMut.mutate({ outcomeStatus: "won" });
                    }
                  }}
                  data-testid="button-mark-won"
                >
                  <Check className="h-3.5 w-3.5 mr-1" /> Won
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-l-none px-3 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30"
                  disabled={isClosed || markOutcomeMut.isPending || !isOwnerOrManager}
                  onClick={() => markOutcomeMut.mutate({ outcomeStatus: "lost_price" })}
                  data-testid="button-mark-lost"
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Lost
                </Button>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="h-8 w-8" data-testid="button-drawer-more">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Actions</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={isClosed || !isOwnerOrManager}
                    onClick={() => setShowSnooze(true)}
                    data-testid="menu-item-snooze"
                  >
                    <Pause className="h-3.5 w-3.5 mr-2" />
                    {snoozed ? "Edit snooze" : "Snooze"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={isClosed || !isElevated}
                    onClick={() => setShowAttach(true)}
                    data-testid="menu-item-attach"
                  >
                    <Link2 className="h-3.5 w-3.5 mr-2" />
                    Attach to existing opp
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={isClosed || !isOwnerOrManager}
                    onClick={() => setShowLeak(true)}
                    data-testid="menu-item-send-to-leak"
                  >
                    <ShieldAlert className="h-3.5 w-3.5 mr-2" />
                    Send to leak queue
                  </DropdownMenuItem>
                  {opp.source === "email_signal" && !isClosed && (
                    <DropdownMenuItem
                      disabled={!isOwnerOrManager}
                      onClick={() => {
                        setShowLeak(true);
                      }}
                      data-testid="menu-item-override-autopilot"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 mr-2" />
                      Override autopilot (not a request)
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4 bg-muted/10">
          {detailQuery.isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {detailQuery.error && (
            <QueryError message={(detailQuery.error as Error).message} />
          )}

          {detail && (
            <>
              {/* Per-quote new-contact review prompt — only renders when
                  this quote's needsNewContactReview is non-null
                  (the strip's own query gates on that). */}
              <NewContactReviewStrip quoteIdFilter={opp.id} />

              {/* Lane card */}
              <LaneCard opp={opp} />

              {/* Editable quoted amount / valid-through / notes */}
              <QuoteDetailsCard
                quote={{
                  id: opp.id,
                  quotedAmount: opp.quotedAmount ?? null,
                  validThrough: opp.validThrough ?? null,
                  notes: opp.notes ?? null,
                }}
                canEdit={isOwnerOrManager && !isClosed}
                onSaved={onRefresh}
                events={events}
              />

              {/* Confidence card — only for autopilot-captured */}
              {opp.source === "email_signal" && <ConfidenceCard opp={opp} />}

              {/* Source thread embed */}
              {sourceMessage && (
                <SourceThreadCard
                  sourceMessage={sourceMessage}
                  threadId={sourceMessage.threadId}
                  onOpen={() => setShowThread(true)}
                />
              )}

              {/* Pricing recommendation (existing tier card) */}
              <PricingIntelCard opp={opp} />

              {/* Deeper pricing intelligence — lazy, gated to pending */}
              <PricingIntelGate
                opp={{
                  id: opp.id,
                  customerId: opp.customerId,
                  originCity: opp.originCity,
                  originState: opp.originState,
                  destCity: opp.destCity,
                  destState: opp.destState,
                  equipment: opp.equipment,
                  laneGroupId: opp.laneGroupId ?? null,
                  outcomeStatus: opp.outcomeStatus,
                }}
              />

              {/* Activity timeline */}
              <ActivityTimeline events={events} customer={customer} />

              {/* Team notes (Task #950 — Context Notes v1) */}
              <ContextNotePanel
                anchor={{ type: "quote_request", id: opp.id }}
                title="Team notes"
              />
            </>
          )}
        </div>

        {/* Quick actions strip */}
        <div className="border-t border-border bg-card p-3 flex items-center justify-center gap-2 text-xs shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={isClosed || !sourceMessage?.threadId}
            onClick={() => setShowReply(true)}
            data-testid="button-quick-reply"
          >
            <Send className="h-3 w-3 mr-1" /> Send reply
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={isClosed || !isOwnerOrManager}
            onClick={() => setShowSnooze(true)}
            data-testid="button-quick-snooze"
          >
            <Pause className="h-3 w-3 mr-1" /> Snooze
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={isClosed || !isElevated}
            onClick={() => setShowAttach(true)}
            data-testid="button-quick-attach"
          >
            <Link2 className="h-3 w-3 mr-1" /> Attach
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={isClosed || !isOwnerOrManager}
            onClick={() => setShowLeak(true)}
            data-testid="button-quick-send-to-leak"
          >
            <ShieldAlert className="h-3 w-3 mr-1" /> Leak
          </Button>
        </div>
      </div>

      {/* Modals */}
      {showThread && sourceMessage?.threadId && (
        <EmailThreadViewerModal
          open={showThread}
          threadId={sourceMessage.threadId}
          messageId={sourceMessage.messageId ?? null}
          onClose={() => setShowThread(false)}
        />
      )}
      {showAttach && (
        <AttachToDialog
          quote={opp as Quote}
          onClose={() => setShowAttach(false)}
          onSuccess={() => {
            setShowAttach(false);
            queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", opp.id] });
            onRefresh();
            onClose();
          }}
        />
      )}
      {showLeak && (
        <SendToLeakDialog
          quote={opp as Quote}
          isElevated={isElevated}
          onClose={() => setShowLeak(false)}
          onSuccess={() => {
            setShowLeak(false);
            queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", opp.id] });
            onRefresh();
            onClose();
          }}
        />
      )}
      {showSnooze && (
        <SnoozeDialog
          quote={opp as Quote}
          onClose={() => setShowSnooze(false)}
          onSuccess={() => {
            setShowSnooze(false);
            queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", opp.id] });
            onRefresh();
          }}
        />
      )}
      {showReply && sourceMessage?.threadId && (
        <SendReplyDialog
          quote={opp as Quote}
          threadId={sourceMessage.threadId}
          subject={sourceMessage.subject}
          toEmail={sourceMessage.fromEmail}
          onClose={() => setShowReply(false)}
          onSuccess={() => {
            setShowReply(false);
            queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", opp.id] });
            onRefresh();
          }}
        />
      )}
      {markWonOpen && (
        <MarkWonDialog
          submitting={markOutcomeMut.isPending}
          onClose={() => setMarkWonOpen(false)}
          onConfirm={(amount, validThrough) => {
            markOutcomeMut.mutate(
              {
                outcomeStatus: "won",
                quotedAmount: amount,
                validThrough: validThrough
                  ? new Date(`${validThrough}T12:00:00Z`).toISOString()
                  : null,
              },
              { onSuccess: () => setMarkWonOpen(false) },
            );
          }}
        />
      )}
    </>
  );
}

// ─── MarkWonDialog ───────────────────────────────────────────────────────
//
// Captures the quoted amount + valid-through date when a rep clicks Won
// on a quote that was never priced. We require an amount so won records
// always carry a real number for downstream reporting.
function MarkWonDialog({
  submitting, onClose, onConfirm,
}: {
  submitting: boolean;
  onClose: () => void;
  onConfirm: (amount: string, validThrough: string) => void;
}): JSX.Element {
  const [amount, setAmount] = useState("");
  const [validThrough, setValidThrough] = useState("");
  const valid = amount.trim() !== "" && Number.isFinite(Number(amount.trim()));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-mark-won">
        <DialogHeader>
          <DialogTitle>Mark Won — capture price</DialogTitle>
          <DialogDescription>
            This quote doesn't have a quoted amount yet. Enter the price (and
            optional expiry) before we mark it won.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Quoted amount
            </Label>
            <Input
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="$"
              className="h-8 text-sm mt-1"
              data-testid="input-mark-won-amount"
            />
          </div>
          <div>
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Valid through
            </Label>
            <Input
              type="date"
              value={validThrough}
              onChange={(e) => setValidThrough(e.target.value)}
              className="h-8 text-sm mt-1"
              data-testid="input-mark-won-valid-through"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="button-cancel-mark-won">
            Cancel
          </Button>
          <Button
            disabled={!valid || submitting}
            onClick={() => onConfirm(amount.trim(), validThrough)}
            data-testid="button-confirm-mark-won"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Mark Won
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── LaneCard ─────────────────────────────────────────────────────────────

function LaneCard({ opp }: { opp: Quote }): JSX.Element {
  return (
    <Card className="border-border/60 shadow-sm overflow-hidden">
      <div className="p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-bold text-foreground">{opp.originCity}, {opp.originState}</h3>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-base font-bold text-foreground">{opp.destCity}, {opp.destState}</h3>
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1.5"><Briefcase className="h-3.5 w-3.5" /> {opp.equipment}</span>
          {opp.quotedAmount && (
            <>
              <span>·</span>
              <span className="text-foreground font-medium">{fmtMoney(opp.quotedAmount)}</span>
            </>
          )}
          <span>·</span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" /> {formatAbsTime(opp.requestDate)}
          </span>
          {opp.validThrough && (
            <>
              <span>·</span>
              <span>valid {relativeTime(opp.validThrough)}</span>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── ConfidenceCard ───────────────────────────────────────────────────────

function ConfidenceCard({ opp }: { opp: Quote }): JSX.Element {
  const score = num(opp.score);
  const pct = score > 1 ? Math.min(100, score) : Math.round(score * 100);
  const label = pct >= 80 ? "high" : pct >= 60 ? "medium" : "low";
  const tone = pct >= 80 ? "text-amber-500" : pct >= 60 ? "text-amber-600" : "text-red-500";
  return (
    <Card className="border-amber-500/20 bg-amber-500/5 shadow-sm p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          <span className="font-semibold text-amber-600 dark:text-amber-500 text-sm">Auto-captured by Phase 2b</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-16 h-1.5 bg-amber-500/20 rounded-full overflow-hidden">
            <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
          </div>
          <span className={`text-[10px] uppercase font-bold tracking-wider ${tone}`}>
            {pct} · {label}
          </span>
        </div>
      </div>
      <div className="text-xs text-amber-700/80 dark:text-amber-300/80">
        Source classification: <span className="font-semibold">{opp.source}</span>.
        This row was created automatically from an inbound customer email signal.
      </div>
    </Card>
  );
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return isNaN(n) ? 0 : n;
}

// ─── SourceThreadCard ─────────────────────────────────────────────────────

function SourceThreadCard({
  sourceMessage, threadId, onOpen,
}: {
  sourceMessage: QuoteSourceMessage;
  threadId: string | null;
  onOpen: () => void;
}): JSX.Element {
  return (
    <Card className="border-border/60 shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Mail className="h-3.5 w-3.5" /> Source Thread
        </h4>
      </div>
      <div className="space-y-2">
        <div className="p-2.5 rounded bg-muted/30 border border-border/50 text-sm">
          <div className="flex justify-between items-baseline mb-1 gap-2">
            <span className="font-medium text-foreground text-xs truncate">
              {sourceMessage.fromEmail ?? "—"}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {relativeTime(sourceMessage.receivedAt)}
            </span>
          </div>
          <div className="font-medium text-xs mb-1 truncate" data-testid="text-source-subject">
            {sourceMessage.subject ?? "(no subject)"}
          </div>
        </div>
      </div>
      <div className="mt-3 text-xs text-center border-t border-border/50 pt-3">
        <button
          type="button"
          onClick={onOpen}
          className="text-primary hover:text-primary/80 font-medium flex items-center justify-center gap-1 mx-auto"
          data-testid="button-open-thread"
        >
          Open full thread <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </Card>
  );
}

// ─── PricingIntelCard ─────────────────────────────────────────────────────

function PricingIntelCard({ opp }: { opp: Quote }): JSX.Element {
  return (
    <Card className="border-border/60 shadow-sm p-4 bg-gradient-to-br from-card to-muted/20">
      <PricingRecommendationCard quoteId={opp.id} />
    </Card>
  );
}

// ─── ActivityTimeline ─────────────────────────────────────────────────────

function ActivityTimeline({
  events, customer,
}: {
  events: QuoteEvent[];
  customer: Customer | null;
}): JSX.Element {
  if (events.length === 0) {
    return (
      <div className="px-1 mt-2 mb-6">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Activity Timeline</h4>
        <div className="text-xs text-muted-foreground italic">No events yet.</div>
      </div>
    );
  }

  return (
    <div className="px-1 mt-2 mb-6">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Activity Timeline</h4>
      <ol className="space-y-3 relative pl-5 before:absolute before:left-1 before:top-1 before:bottom-1 before:w-0.5 before:bg-border/50">
        {events.map((ev) => (
          <li key={ev.id} className="relative" data-testid={`event-${ev.id}`}>
            <div
              className={`absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full border-2 border-background ${
                ev.eventType === "auto_captured" || ev.eventType === "opp_created" ? "bg-amber-500" :
                ev.eventType.startsWith("opp_attached") || ev.eventType.startsWith("opp_reattached") ? "bg-violet-500" :
                ev.eventType === "outbound_reply" ? "bg-sky-500" :
                ev.eventType === "snoozed" || ev.eventType === "unsnoozed" ? "bg-slate-400" :
                ev.eventType === "sent_to_leak" ? "bg-red-500" :
                ev.eventType.includes("won") ? "bg-emerald-500" :
                ev.eventType.includes("lost") ? "bg-red-500" :
                "bg-muted"
              }`}
            />
            <div className="text-xs">
              <div className="font-medium text-foreground">{describeEvent(ev)}</div>
              <time className="text-[10px] text-muted-foreground">{relativeTime(ev.occurredAt)}</time>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function describeEvent(ev: QuoteEvent): string {
  switch (ev.eventType) {
    case "opp_created": return "Opportunity created";
    case "auto_captured": return "Auto-captured from email";
    case "opp_attached_in": return "Attached: another opp merged in";
    case "opp_attached_out": return "Attached: this opp merged into another";
    case "opp_reattached_out": return "Re-attached to a different target";
    case "opp_reattached_away": return "Removed: an attached opp was re-routed";
    case "outbound_reply": return "You replied";
    case "snoozed": {
      const until = ev.payload?.snoozedUntil as string | null | undefined;
      return until ? `Snoozed until ${formatAbsTime(until)}` : "Snoozed";
    }
    case "unsnoozed": return "Unsnoozed";
    case "sent_to_leak": {
      const reason = (ev.payload?.reason as string) ?? "";
      return `Sent to leak queue${reason ? ` (${reason})` : ""}`;
    }
    case "email_won": return "Auto-flipped to Won (email signal)";
    case "email_lost": return "Auto-flipped to Lost (email signal)";
    case "tms_won": return "Auto-flipped to Won (TMS-confirmed)";
    case "tms_lost": return "Auto-flipped to Lost (TMS-confirmed)";
    default: return ev.eventType.replace(/_/g, " ");
  }
}

// ─── AttachToDialog ───────────────────────────────────────────────────────

function AttachToDialog({
  quote, onClose, onSuccess,
}: {
  quote: Quote;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [decision, setDecision] = useState<"attached" | "duplicate">("duplicate");
  const [note, setNote] = useState("");
  const [allowReattach, setAllowReattach] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Search candidate opps via the existing list endpoint (with broad search).
  const candidatesQuery = useQuery<ListResult>({
    queryKey: ["/api/customer-quotes/list", "attach-search", debouncedSearch, quote.customerId],
    queryFn: async () => {
      const p = new URLSearchParams();
      p.set("limit", "20");
      p.set("offset", "0");
      p.set("sortKey", "requestDate");
      p.set("sortDir", "desc");
      if (debouncedSearch) p.set("laneSearch", debouncedSearch);
      else if (quote.customerId) p.set("customerId", quote.customerId);
      const res = await fetch(`/api/customer-quotes/list?${p.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: !!debouncedSearch || !!quote.customerId,
  });

  const candidates = (candidatesQuery.data?.rows ?? []).filter(r => r.id !== quote.id);

  const mut = useMutation({
    mutationFn: async () => {
      if (!targetId) throw new Error("Select a target opportunity");
      const res = await apiRequest("POST", `/api/customer-quotes/quote/${quote.id}/attach-to`, {
        targetOppId: targetId,
        decision,
        note: note || undefined,
        allowReattach,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Attached", description: "This quote was merged into the target opportunity." });
      onSuccess();
    },
    onError: (err) => {
      const msg = (err as Error).message;
      if (msg.includes("already_closed")) {
        toast({ title: "Already closed", description: "This source quote is already in a terminal state.", variant: "destructive" });
      } else if (msg.includes("self_attach")) {
        toast({ title: "Cannot attach to itself", variant: "destructive" });
      } else {
        toast({ title: "Attach failed", description: msg, variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach to existing opportunity</DialogTitle>
          <DialogDescription>
            Merge this quote into another. The source quote will be closed as
            <span className="font-semibold"> {decision === "attached" ? "Attached" : "Duplicate (attached)"}</span>
            and its email signals will re-point at the target.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs">Decision</Label>
            <Select value={decision} onValueChange={(v) => setDecision(v as AttachDecision)}>
              <SelectTrigger className="h-8 text-xs mt-1" data-testid="select-attach-decision"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="duplicate">Duplicate request (default)</SelectItem>
                <SelectItem value="attached">Attached (merge into canonical)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Find target</Label>
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Lane, customer, notes…"
              className="h-8 text-xs mt-1"
              data-testid="input-attach-search"
            />
          </div>
          <div className="border border-border rounded max-h-72 overflow-auto">
            {candidatesQuery.isLoading && <div className="p-3 text-xs text-muted-foreground">Searching…</div>}
            {candidates.length === 0 && !candidatesQuery.isLoading && (
              <div className="p-3 text-xs text-muted-foreground">No candidates found.</div>
            )}
            {candidates.map(c => (
              <button
                type="button"
                key={c.id}
                onClick={() => setTargetId(c.id)}
                className={`w-full text-left p-2 hover:bg-muted/40 border-b border-border/40 last:border-b-0 ${
                  targetId === c.id ? "bg-amber-500/10" : ""
                }`}
                data-testid={`attach-candidate-${c.id}`}
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{formatCustomerName(c.customerName)}</span>
                  <Badge className={STATUS_TONE[c.outcomeStatus] ?? ""} variant="outline">
                    {STATUS_LABELS[c.outcomeStatus] ?? c.outcomeStatus}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {c.originCity}, {c.originState} → {c.destCity}, {c.destState}
                  <span className="mx-1">·</span>
                  {c.equipment}
                  <span className="mx-1">·</span>
                  {relativeTime(c.requestDate)}
                </div>
              </button>
            ))}
          </div>
          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Why this was a duplicate…"
              className="text-xs mt-1"
              rows={2}
              maxLength={500}
              data-testid="textarea-attach-note"
            />
          </div>
          {isTerminal(quote.outcomeStatus) && (
            <div className="flex items-center gap-2 p-2 rounded bg-amber-500/10 border border-amber-500/30">
              <Switch checked={allowReattach} onCheckedChange={setAllowReattach} />
              <Label className="text-xs">
                Re-attach correction (this quote is already attached; admin/director only)
              </Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="button-attach-cancel">Cancel</Button>
          <Button
            disabled={!targetId || mut.isPending}
            onClick={() => mut.mutate()}
            data-testid="button-attach-confirm"
          >
            {mut.isPending ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SendToLeakDialog ─────────────────────────────────────────────────────

function SendToLeakDialog({
  quote, isElevated, onClose, onSuccess,
}: {
  quote: Quote;
  isElevated: boolean;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [reason, setReason] = useState<"not_a_request" | "unparseable" | "wrong_party" | "duplicate_email" | "other">(
    quote.source === "email_signal" ? "not_a_request" : "unparseable"
  );
  const [note, setNote] = useState("");
  const [suppressSender, setSuppressSender] = useState(false);

  const mut = useMutation({
    mutationFn: async () => {
      const body: SendToLeakBody = { reason };
      if (note) body.note = note;
      if (reason === "not_a_request" && suppressSender) body.suppressSender = true;
      const res = await apiRequest("POST", `/api/customer-quotes/quote/${quote.id}/send-to-leak`, body);
      return (await res.json()) as SendToLeakResponse;
    },
    onSuccess: (data) => {
      const msg = data?.senderSuppressionRequested && !data?.senderSuppressed
        ? "Sent to leak queue (sender suppression skipped — admin only)"
        : data?.senderSuppressed
        ? "Sent to leak queue and sender suppressed"
        : "Sent to leak queue";
      toast({ title: msg });
      onSuccess();
    },
    onError: (err) => {
      const m = (err as Error).message;
      if (m.includes("already_closed")) {
        toast({ title: "Already closed", description: "This quote is already in a terminal state.", variant: "destructive" });
      } else {
        toast({ title: "Failed", description: m, variant: "destructive" });
      }
    },
  });

  const requireNote = reason === "other";
  const canSubmit = !requireNote || note.trim().length > 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {reason === "not_a_request" ? "Override autopilot" : "Send to leak queue"}
          </DialogTitle>
          <DialogDescription>
            {reason === "not_a_request"
              ? "Tell the autopilot this email was not a quote request. The opportunity will be closed and the underlying signal stays attributed to it."
              : "Close this opportunity and put the underlying email signal back into the admin leak queue for review."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs">Reason</Label>
            <Select value={reason} onValueChange={v => setReason(v as LeakReason)}>
              <SelectTrigger className="h-8 text-xs mt-1" data-testid="select-leak-reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="not_a_request">Not a request (override autopilot)</SelectItem>
                <SelectItem value="unparseable">Unparseable</SelectItem>
                <SelectItem value="wrong_party">Wrong party (not a customer)</SelectItem>
                <SelectItem value="duplicate_email">Duplicate email</SelectItem>
                <SelectItem value="other">Other (note required)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Note {requireNote && <span className="text-red-500">*</span>}</Label>
            <Textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              className="text-xs mt-1"
              rows={3}
              maxLength={2000}
              placeholder={requireNote ? "Required" : "Optional context"}
              data-testid="textarea-leak-note"
            />
          </div>
          {reason === "not_a_request" && isElevated && (
            <div className="flex items-center gap-2 p-2 rounded bg-muted/40 border border-border">
              <Switch checked={suppressSender} onCheckedChange={setSuppressSender} data-testid="toggle-suppress-sender" />
              <Label className="text-xs">
                Suppress this sender — autopilot will skip future emails from them
              </Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="button-leak-cancel">Cancel</Button>
          <Button
            disabled={!canSubmit || mut.isPending}
            onClick={() => mut.mutate()}
            variant="destructive"
            data-testid="button-leak-confirm"
          >
            {mut.isPending ? "Sending…" : "Send to leak"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SnoozeDialog ─────────────────────────────────────────────────────────

const SNOOZE_PRESETS: { label: string; minutes: number }[] = [
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Tomorrow 9am", minutes: -1 }, // computed
  { label: "Next week", minutes: 7 * 24 * 60 },
];

function SnoozeDialog({
  quote, onClose, onSuccess,
}: {
  quote: Quote;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const currentSnooze = quote.snoozedUntil;
  const [customDate, setCustomDate] = useState<string>(() => {
    const d = new Date();
    d.setHours(d.getHours() + 4);
    return d.toISOString().slice(0, 16);
  });

  const setMut = useMutation({
    mutationFn: async (snoozedUntil: string | null) => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/quote/${quote.id}/snooze`, { snoozedUntil });
      return (await res.json()) as SnoozeResponse;
    },
    onSuccess: (data) => {
      toast({ title: data?.status === "snoozed" ? "Snoozed" : "Unsnoozed" });
      onSuccess();
    },
    onError: (err) => {
      toast({ title: "Snooze failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  function applyPreset(preset: typeof SNOOZE_PRESETS[number]) {
    let d: Date;
    if (preset.minutes === -1) {
      d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else {
      d = new Date(Date.now() + preset.minutes * 60_000);
    }
    setMut.mutate(d.toISOString());
  }

  function applyCustom() {
    const d = new Date(customDate);
    if (isNaN(d.getTime())) {
      toast({ title: "Invalid date", variant: "destructive" });
      return;
    }
    if (d.getTime() <= Date.now()) {
      toast({ title: "Date must be in the future", variant: "destructive" });
      return;
    }
    if (d.getTime() > Date.now() + 14 * 24 * 3600 * 1000) {
      toast({ title: "Maximum 14 days out", variant: "destructive" });
      return;
    }
    setMut.mutate(d.toISOString());
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{currentSnooze ? "Edit snooze" : "Snooze this request"}</DialogTitle>
          <DialogDescription>
            Hide this row from the default Quote Requests list until the chosen time. Maximum 14 days.
            {currentSnooze && (
              <div className="mt-2 text-xs">
                Currently snoozed until <span className="font-semibold">{formatAbsTime(currentSnooze)}</span>.
              </div>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {SNOOZE_PRESETS.map(p => (
              <Button
                key={p.label}
                variant="outline"
                size="sm"
                onClick={() => applyPreset(p)}
                disabled={setMut.isPending}
                data-testid={`button-snooze-preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Separator />
          <div>
            <Label className="text-xs">Custom date/time</Label>
            <div className="flex gap-2 mt-1">
              <Input
                type="datetime-local"
                value={customDate}
                onChange={e => setCustomDate(e.target.value)}
                className="h-8 text-xs"
                data-testid="input-snooze-custom"
              />
              <Button
                size="sm"
                onClick={applyCustom}
                disabled={setMut.isPending}
                data-testid="button-snooze-custom"
              >
                Set
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          {currentSnooze && (
            <Button
              variant="outline"
              onClick={() => setMut.mutate(null)}
              disabled={setMut.isPending}
              data-testid="button-snooze-clear"
            >
              Unsnooze
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SendReplyDialog ──────────────────────────────────────────────────────

function SendReplyDialog({
  quote, threadId, subject, toEmail, onClose, onSuccess,
}: {
  quote: Quote;
  threadId: string;
  subject: string | null;
  toEmail: string | null;
  onClose: () => void;
  onSuccess: () => void;
}): JSX.Element {
  const { toast } = useToast();
  const [body, setBody] = useState("");
  const [overrideSubject, setOverrideSubject] = useState<string>(subject ? `Re: ${subject}` : "");

  const mut = useMutation({
    mutationFn: async () => {
      if (!body.trim()) throw new Error("Body is required");
      const res = await apiRequest("POST", `/api/email-conversations/${threadId}/reply`, {
        body,
        subject: overrideSubject || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reply sent", description: "Status flipped to Quoted." });
      onSuccess();
    },
    onError: (err) => {
      toast({ title: "Send failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send reply</DialogTitle>
          <DialogDescription>
            Sends an outbound email on the source thread. If this quote is currently
            <span className="font-semibold"> Pending</span>, it will flip to
            <span className="font-semibold"> Quoted</span> immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">To</Label>
            <Input value={toEmail ?? ""} disabled className="h-8 text-xs mt-1 bg-muted/30" data-testid="input-reply-to" />
          </div>
          <div>
            <Label className="text-xs">Subject</Label>
            <Input
              value={overrideSubject}
              onChange={e => setOverrideSubject(e.target.value)}
              className="h-8 text-xs mt-1"
              data-testid="input-reply-subject"
            />
          </div>
          <div>
            <Label className="text-xs">Message</Label>
            <Textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={10}
              className="text-xs mt-1 font-mono"
              placeholder="Hi, …"
              data-testid="textarea-reply-body"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} data-testid="button-reply-cancel">Cancel</Button>
          <Button
            disabled={!body.trim() || mut.isPending}
            onClick={() => mut.mutate()}
            data-testid="button-reply-send"
          >
            <Send className="h-3.5 w-3.5 mr-1.5" />
            {mut.isPending ? "Sending…" : "Send reply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
