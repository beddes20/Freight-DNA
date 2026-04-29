import { useEffect, useMemo, useState } from "react";
import { CustomerQuotesPortalContext, useCqOverlayPortal } from "@/lib/customer-quotes-portal";
import { formatCustomerName } from "@shared/laneFormatters";
import { EntityLink } from "@/components/entity-link";
import { isQuoteOpportunitiesRole } from "@shared/quoteOpportunitiesRoles";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorBanner } from "@/components/ui/error-banner";
import { EmptyState } from "@/components/ui/empty-state";
import { Inbox as InboxIcon } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { EmailThreadViewerModal } from "@/components/conversations/email-thread-viewer-modal";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Search, Download, RefreshCw, Bookmark, X, ArrowUp, ArrowDown,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Hourglass, Trophy,
  Trash2, Plus, ChevronsUpDown, Check, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, Sparkles,
  Sun, Moon,
} from "lucide-react";
import {
  PRESETS,
  presetToFilters,
  detectActivePreset,
  DEFAULT_SORT_KEY,
  DEFAULT_SORT_DIR,
  isRepUnassigned,
  type PresetKey,
} from "@/pages/customer-quotes-presets";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  LineChart, Line, CartesianGrid,
} from "recharts";
import { useToast } from "@/hooks/use-toast";
import { useLaneSignals, laneSigKey } from "@/hooks/useLaneSignals";
import { PricingIntelligencePanel } from "@/components/PricingIntelligencePanel";
import { PricingRecommendationCard } from "@/components/PricingRecommendationCard";
import { MarginFloorsSettings } from "@/components/MarginFloorsSettings";
import { SenderMappingsDialog } from "@/components/SenderMappingsDialog";
import { SpotQuoteSearch } from "@/components/SpotQuoteSearch";
import { ActionQueueCard } from "@/components/customer-quotes/ActionQueueCard";
import { NewContactReviewStrip } from "@/components/customer-quotes/NewContactReviewStrip";
import { computeQuoteSla, formatSlaBadge } from "@shared/quoteSla";

// ---------- Types (mirror server contract) ----------
type Quote = {
  id: string;
  organizationId: string;
  customerId: string; customerName: string;
  repId: string | null; repName: string;
  laneGroupId: string | null;
  carrierId: string | null; carrierName: string | null;
  outcomeReasonId: string | null; outcomeReasonLabel: string | null;
  requestDate: string;
  originCity: string; originState: string;
  destCity: string; destState: string;
  equipment: string;
  quotedAmount: string | null;
  validThrough: string | null;
  outcomeStatus: string;
  carrierPaid: string | null;
  responseTimeHours: string | null;
  source: string; sourceReference: string | null;
  // Task #526 — populated for source="email" rows so the table can deep-link
  // to the source thread in the Conversations tab. Null when not resolvable.
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  notes: string | null;
  score: string | null;
  // Customer Quotes #2 — server-computed SLA snapshot. The badge column
  // recomputes off requestDate so it ticks between refetches.
  slaState?: "ok" | "warning" | "breached" | "na";
  minutesSinceRequest?: number;
  // Task #803 (A) — populated when the autopilot detects a domain-matched
  // sender whose exact email is brand-new for the matched customer. The
  // row renders a "New contact" pill and the drawer surfaces an
  // Add/Dismiss prompt that calls /api/customer-quotes/:id/contact-review.
  needsNewContactReview?: {
    senderEmail: string;
    senderName: string | null;
    customerId: string;
    customerName: string;
    detectedAt: string;
  } | null;
};

type ListResult = { rows: Quote[]; total: number; offset: number; limit: number };

type PartyType = "customer" | "carrier" | "unknown";
type Customer = {
  id: string; organizationId: string; name: string; segment: string | null;
  // Task #597 — populated server-side; the drawer surfaces this so users can
  // flip a row's classification.
  partyType?: PartyType;
  partyTypeManual?: boolean;
};
type Rep = { id: string; organizationId: string; name: string; email: string | null };
type Reason = { id: string; organizationId: string; code: string; label: string; category: string };
type LaneGroup = { id: string; organizationId: string; name: string };
type Carrier = { id: string; organizationId: string; name: string };

type Trend = { winRate: number; total: number; avgMargin: number; avgResponse: number };

type CustomerPerformance = {
  customer: Customer;
  winCount: number; lossCount: number;
  avgQuoted: number; avgCarrierBuy: number;
  topLanes: { lane: string; total: number; won: number; quoted: number; paid: number }[];
  topLossReasons: { reason: string; count: number }[];
};

type LaneVarianceItem = {
  lane: string; min: number; max: number; spread: number; spreadPct: number;
  breakdown: { rep: string; avg: number }[];
};

type AttractivenessLabel = "Pursue Aggressively" | "Good Freight" | "Selective" | "Low Quality";
type AttractivenessItem = {
  customer: string; lane: string; total: number; won: number;
  winRate: number; avgMargin: number; label: AttractivenessLabel;
};

type AlertSeverity = "high" | "medium" | "low";
type Alert = {
  id: string; severity: AlertSeverity; type: string;
  title: string; detail: string;
  data?: { lane?: string; customerId?: string; quoteId?: string; startDate?: string };
};

type StaleFollowUpItem = {
  quoteId: string;
  customerId: string;
  customerName: string;
  lane: string;
  ageHours: number;
  pTypicalHours: number;
  hoursOverdue: number;
  quotedAmount: number;
  estimatedMargin: number;
  repName: string | null;
};

type Snapshot = {
  total: number;
  kpis: {
    total: number; won: number; lost: number; winRate: number;
    avgQuoted: number; avgCarrierCost: number;
    avgMarginDollar: number; avgMarginPct: number;
    avgResponseTime: number; pending: number; expiringSoon: number;
    trend: Trend;
  };
  customers: Customer[];
  reps: Rep[];
  reasons: Reason[];
  laneGroups: LaneGroup[];
  carriers: Carrier[];
  customerPerformance: CustomerPerformance | null;
  taxonomy: Record<string, number>;
  validityWindow: {
    expiringList: { id: string; lane: string; customer: string; validThrough: string; quotedAmount: number }[];
    agingBuckets: Record<string, number>;
    staleCount: number; activeCount: number; expiredCount: number;
  };
  laneVariance: LaneVarianceItem[];
  attractiveness: AttractivenessItem[];
  staleFollowUps: StaleFollowUpItem[];
  charts: {
    trend: { date: string; total: number; won: number; lost: number }[];
    winRateByCustomer: { customer: string; winRate: number; total: number }[];
    marginByCustomer: { customer: string; avgMargin: number; won: number }[];
    topLanes: { lane: string; total: number; won: number }[];
    highVolLowWin: { lane: string; total: number; won: number }[];
  };
  alerts: Alert[];
};

type Filters = {
  customerId?: string;
  startDate?: string;
  endDate?: string;
  equipment?: string;
  repId?: string;
  outcomeStatus?: string;
  outcomeReasonId?: string;
  laneSearch?: string;
  laneGroupId?: string;
  wonOnly?: boolean;
  activeOnly?: boolean;
  lostOnly?: boolean;
  expiringOnly?: boolean;
};

// Task #816 — `carrierPaid` / `marginDollar` / `marginPct` were retired
// when the carrier columns came off the customer-only Quote
// Opportunities table. The list endpoint still tolerates a stale saved
// view that requested one (it falls back to default request-date order)
// so old rows don't crash the page.
type SortKey =
  | "requestDate" | "customerName" | "originCity" | "destCity" | "equipment"
  | "quotedAmount" | "validThrough" | "outcomeStatus" | "outcomeReasonLabel"
  | "repName" | "responseTimeHours"
  | "source" | "score";

type SavedView = { id: string; name: string; filters: Filters; createdAt: string };

type QuoteEvent = {
  id: string; quoteId: string; eventType: string; occurredAt: string;
  actor: string | null; payload: Record<string, unknown> | null;
};

type QuoteSourceMessage = {
  messageId: string;
  threadId: string | null;
  providerMessageId: string | null;
  subject: string | null;
  fromEmail: string | null;
  receivedAt: string | null;
};

type QuoteOutcomeFlipContext = {
  source: "email" | "tms";
  matchedPhrase: string | null;
  bodyExcerpt: string | null;
  emailSubject: string | null;
  fromEmail: string | null;
  threadId: string | null;
  messageId: string | null;
  reasonCode: string | null;
  matchTier: string | null;
};

type QuoteDetail = {
  opp: Quote;
  events: QuoteEvent[];
  customer: Customer | null;
  rep: Rep | null;
  carrier: Carrier | null;
  reason: Reason | null;
  relatedSameLane: Quote[];
  relatedSameCustomer: Quote[];
  relatedSameLaneGroup: Quote[];
  // Task #477 — set when this quote auto-created (or matched) a LWQ lane.
  lwqLaneId: string | null;
  // Task #526 — populated when source = "email", lets us deep-link the
  // drawer's Source card to the Conversations tab on the right thread.
  sourceMessage: QuoteSourceMessage | null;
  // Per-event auto-flip context (keyed by quote_event.id). Populated for
  // email_won / email_lost / tms_won / tms_lost events so the timeline can
  // surface "AI flipped this to Won because the customer wrote …".
  outcomeFlipContext: Record<string, QuoteOutcomeFlipContext>;
};

const FLIP_EVENT_LABELS: Record<string, { label: string; tone: "won" | "lost" }> = {
  email_won: { label: "Auto-flipped to Won (email)", tone: "won" },
  email_lost: { label: "Auto-flipped to Lost (email)", tone: "lost" },
  tms_won: { label: "Auto-flipped to Won (TMS-confirmed)", tone: "won" },
  tms_lost: { label: "Auto-flipped to Lost (TMS-confirmed)", tone: "lost" },
};

// ---------- Constants ----------
// Task #803 — `quoted` is an active intermediate state (rep has sent a
// quote but customer hasn't accepted/rejected/timed out). The autopilot
// flips here automatically; manual Mark Quoted overrides also land here.
// It is NOT an outcome bucket.
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending", quoted: "Quoted", won: "Won", won_low_margin: "Won (low margin)",
  lost_price: "Lost — price", lost_service: "Lost — service",
  lost_timing: "Lost — timing", lost_incumbent: "Lost — incumbent",
  no_response: "No response", expired: "Expired",
};
const STATUS_COLORS: Record<string, string> = {
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
};
const ALL_STATUSES = Object.keys(STATUS_LABELS);
// Spec: 8-bucket outcome taxonomy — final outcomes only, excludes "pending" (an active state).
const OUTCOME_BUCKETS = ["won", "won_low_margin", "lost_price", "lost_service", "lost_timing", "lost_incumbent", "no_response", "expired"];
const EQUIPMENTS = ["Dry Van", "Reefer", "Flatbed"];
const ATTRACT_COLORS: Record<AttractivenessLabel, string> = {
  "Pursue Aggressively": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  "Good Freight": "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  "Selective": "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  "Low Quality": "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};
const PIE_COLORS = ["#10b981", "#84cc16", "#ef4444", "#f97316", "#f59e0b", "#a855f7", "#71717a", "#525252", "#facc15"];
const PAGE_SIZE = 50;
const ROW_HEIGHT = 32;
// Task #584 — must match server `UNKNOWN_CUSTOMER_NAME` exactly so the
// dashboard can recognise the shared bucket and surface the inline
// reassign action.
const UNKNOWN_CUSTOMER_NAME = "Unknown — needs review";

// ---------- Helpers ----------
function fmtMoney(v: number | string | null | undefined, opts: { dash?: boolean } = {}): string {
  if (v === null || v === undefined || v === "") return opts.dash ? "—" : "$0";
  const n = typeof v === "string" ? Number(v) : v;
  if (!isFinite(n) || n === 0) return opts.dash ? "—" : "$0";
  return `$${Math.round(n).toLocaleString()}`;
}
function fmtPct(v: number): string { return `${v.toFixed(1)}%`; }
function fmtHours(v: number): string { return `${v.toFixed(1)}h`; }
function num(v: string | null | undefined): number {
  if (!v) return 0; const n = Number(v); return isNaN(n) ? 0 : n;
}
function filtersToQuery(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "" || v === false) return;
    p.set(k, String(v));
  });
  return p;
}
function filtersFromUrl(search: string): Filters {
  const p = new URLSearchParams(search);
  const f: Filters = {};
  (["customerId", "startDate", "endDate", "equipment", "repId", "outcomeStatus", "outcomeReasonId", "laneSearch", "laneGroupId"] as const).forEach(k => {
    const v = p.get(k); if (v) f[k] = v;
  });
  if (p.get("wonOnly") === "true") f.wonOnly = true;
  if (p.get("activeOnly") === "true") f.activeOnly = true;
  if (p.get("lostOnly") === "true") f.lostOnly = true;
  if (p.get("expiringOnly") === "true") f.expiringOnly = true;

  // Task #652 — Lane Switchboard deep-link contract. The switchboard
  // sends explicit lane fields (originCity / originState / destCity /
  // destState) per the documented contract. If laneSearch wasn't already
  // supplied, synthesize one so the lane is visibly prefilled. We use
  // "ORIGIN DEST" — the same shape this page's lane chips emit and the
  // shape the page's free-text input matches against.
  if (!f.laneSearch) {
    const oc = p.get("originCity");
    const dc = p.get("destCity");
    if (oc && dc) f.laneSearch = `${oc} ${dc}`;
  }
  return f;
}
function trendIcon(v: number): JSX.Element {
  if (Math.abs(v) < 0.5) return <Minus className="h-3 w-3 text-muted-foreground" />;
  if (v > 0) return <TrendingUp className="h-3 w-3 text-emerald-400" />;
  return <TrendingDown className="h-3 w-3 text-red-400" />;
}

function StatusPill({ status }: { status: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${STATUS_COLORS[status] ?? "bg-muted text-muted-foreground border-border"}`} data-testid={`status-pill-${status}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function KpiCard({ label, value, sub, trend, onClick, testId }: {
  label: string; value: string; sub?: string; trend?: number; onClick?: () => void; testId: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-start gap-0.5 rounded p-2.5 bg-card border border-border hover:border-amber-500/40 hover:bg-card/80 transition text-left min-w-[120px]"
      data-testid={testId}
    >
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {trend !== undefined && trendIcon(trend)}
      </div>
      <div className="text-lg font-semibold text-foreground tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </button>
  );
}

// ---------- Page-scoped theme toggle ----------
// Persists the rep's choice via the `cq-theme` localStorage key. The
// theme is applied as a `light`/`dark` class on the page-root wrapper
// only, so the rest of the app is never affected.
const CQ_THEME_KEY = "cq-theme";
function useCustomerQuotesTheme(): { theme: "light" | "dark"; toggle: () => void } {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem(CQ_THEME_KEY);
    return saved === "dark" ? "dark" : "light";
  });
  const toggle = (): void => {
    setTheme(t => {
      const next = t === "dark" ? "light" : "dark";
      try { window.localStorage.setItem(CQ_THEME_KEY, next); } catch { /* ignore */ }
      return next;
    });
  };
  return { theme, toggle };
}

// ---------- Page ----------
// Task #615 / #714 — Quote Opportunities is restricted to roles that own
// the customer relationship. Reps outside this set (drivers, ops, dispatch,
// generic "sales", carrier-side roles, etc.) see an "Access required"
// empty state and the sidebar entry is hidden for them too.
//
// The role set lives in `shared/quoteOpportunitiesRoles.ts` so that the
// page-access gate, the sidebar visibility check, and the server-side rep
// filter (which hides reps whose linked user is non-customer-facing from
// the dropdowns / performance breakdown) cannot drift apart.
export default function CustomerQuotesPage(): JSX.Element {
  // Gate the entire dashboard at the page boundary so the hook order
  // inside the heavy inner page never changes between renders. Sidebar
  // entry is hidden for ungated roles via the same role list, but direct
  // URL navigation still lands here, so this short-circuit is the last
  // line of defence on the client.
  const { user: currentUser, isLoading: authLoading } = useAuth();
  const hasAccess =
    !!currentUser
    && typeof currentUser === "object"
    && "role" in currentUser
    && isQuoteOpportunitiesRole((currentUser as { role: string }).role);
  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="customer-quotes-auth-loading">
        <Skeleton className="h-6 w-32 bg-card" />
      </div>
    );
  }
  if (!hasAccess) {
    return (
      <div className="flex items-center justify-center h-full" data-testid="customer-quotes-access-required">
        <p className="text-muted-foreground">Access required</p>
      </div>
    );
  }
  return <CustomerQuotesPageInner />;
}

function CustomerQuotesPageInner(): JSX.Element {
  const { theme, toggle: toggleTheme } = useCustomerQuotesTheme();
  // Re-read the auth user inside the inner component so the "My Open"
  // preset can match the rep by email. The outer wrapper already
  // gated `hasAccess`, so we know we're past the loading/no-access
  // states by the time this hook runs.
  const { user: currentUser } = useAuth();
  const initialSearch = typeof window !== "undefined" ? window.location.search : "";
  const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(initialSearch));
  const [drawerId, setDrawerId] = useState<string | null>(() => {
    // Task #477 — support deep-linking from the LWQ "From won quote" badge
    // (uses ?quoteId=) and from existing in-app links (uses ?quote=).
    if (typeof window === "undefined") return null;
    const sp = new URLSearchParams(window.location.search);
    return sp.get("quoteId") ?? sp.get("quote");
  });
  // Task #477 — pending win-outcome dialog state. Holds the quote id, the
  // chosen "won" / "won_low_margin" status, and the full pending patch (which
  // may include unrelated edits coming from the QuoteEditForm) until the rep
  // confirms. Task #501 — extended to accept the entire patch so the drawer's
  // edit form can route through the same dialog.
  const [winDialog, setWinDialog] = useState<{ id: string; status: string; patch: Record<string, unknown> } | null>(null);
  const [savedViewsOpen, setSavedViewsOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newQuoteOpen, setNewQuoteOpen] = useState(false);
  // User-controlled gate for the Quote Lifecycle Autopilot prompt
  // strip. Pauses the strip's network query when collapsed (parallel
  // to the Action Queue card's collapse mechanic). Default expanded.
  const [showNewContactReviews, setShowNewContactReviews] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try {
      const v = window.localStorage.getItem("cq.newContactReviews.open");
      return v === null ? true : v === "1";
    } catch { return true; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem("cq.newContactReviews.open", showNewContactReviews ? "1" : "0"); }
    catch { /* ignore */ }
  }, [showNewContactReviews]);
  // Default sort flipped to `requestDate asc` so the OLDEST actionable
  // (pending) quotes float to the top of the table on first load. The
  // column header still toggles direction normally, and Saved Views
  // do not persist sort, so opening a saved view also lands here.
  // Constants live in customer-quotes-presets.ts so the test suite can
  // assert the contract without rendering the page.
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT_KEY);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(DEFAULT_SORT_DIR);
  const [page, setPage] = useState(0);
  const { toast } = useToast();

  // Reset page when filters/sort change.
  useEffect(() => { setPage(0); }, [filters, sortKey, sortDir]);

  // Sync filters + drawer to URL.
  useEffect(() => {
    const p = filtersToQuery(filters);
    if (drawerId) p.set("quote", drawerId);
    const qs = p.toString();
    const target = `/customer-quotes${qs ? "?" + qs : ""}`;
    if (window.location.pathname + window.location.search !== target) {
      window.history.replaceState({}, "", target);
    }
  }, [filters, drawerId]);

  // Listen for browser back/forward to keep drawer in sync with URL.
  useEffect(() => {
    function onPop() {
      const q = new URLSearchParams(window.location.search).get("quote");
      setDrawerId(q);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const filterQs = filtersToQuery(filters).toString();

  const snapshotQuery = useQuery<Snapshot>({
    queryKey: ["/api/customer-quotes/snapshot", filterQs],
    queryFn: async (): Promise<Snapshot> => {
      const res = await fetch(`/api/customer-quotes/snapshot${filterQs ? "?" + filterQs : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load snapshot");
      return res.json() as Promise<Snapshot>;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const listQs = useMemo(() => {
    const p = filtersToQuery(filters);
    p.set("sortKey", sortKey); p.set("sortDir", sortDir);
    p.set("offset", String(page * PAGE_SIZE)); p.set("limit", String(PAGE_SIZE));
    return p.toString();
  }, [filters, sortKey, sortDir, page]);

  const listQuery = useQuery<ListResult>({
    queryKey: ["/api/customer-quotes/list", listQs],
    queryFn: async (): Promise<ListResult> => {
      const res = await fetch(`/api/customer-quotes/list?${listQs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load list");
      return res.json() as Promise<ListResult>;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const savedViewsQuery = useQuery<SavedView[]>({
    queryKey: ["/api/customer-quotes/saved-views"],
  });

  // Task #597 — gate the admin-only "Purge demo data" button on the
  // current user's role. The backend route also enforces this, but
  // hiding the button keeps non-admin dashboards uncluttered.
  const meQuery = useQuery<{ role?: string } | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) return null;
      return res.json() as Promise<{ role?: string } | null>;
    },
    staleTime: 5 * 60_000,
  });
  const canPurgeDemo = ["admin", "director", "sales_director"].includes(meQuery.data?.role ?? "");
  const [purgeDemoOpen, setPurgeDemoOpen] = useState(false);
  const purgeDemoMutation = useMutation({
    mutationFn: async (): Promise<{ ok: boolean; summary: { customersDeleted: number; opportunitiesDeleted: number; eventsDeleted: number; carriersDeleted: number; repsDeleted: number; laneGroupsDeleted: number; outcomeReasonsDeleted: number } }> => {
      const res = await apiRequest("POST", "/api/customer-quotes/purge-demo-seed", {});
      return res.json();
    },
    onSuccess: (data) => {
      const s = data.summary;
      toast({
        title: "Demo data purged",
        description: `Removed ${s.opportunitiesDeleted} quotes, ${s.customersDeleted} customers, ${s.carriersDeleted} carriers.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      setPurgeDemoOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Purge failed", description: err.message, variant: "destructive" });
    },
  });

  const saveViewMutation = useMutation({
    mutationFn: async (payload: { name: string; filters: Filters }): Promise<SavedView> => {
      const res = await apiRequest("POST", "/api/customer-quotes/saved-views", payload);
      return res.json() as Promise<SavedView>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] });
      setSaveDialogOpen(false); setNewViewName("");
      toast({ title: "Saved view created" });
    },
  });
  const deleteViewMutation = useMutation({
    mutationFn: async (id: string): Promise<{ ok: boolean }> => {
      const res = await apiRequest("DELETE", `/api/customer-quotes/saved-views/${id}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/saved-views"] }),
  });

  const invalidateQuoteData = (id?: string): void => {
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
    queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
    if (id) queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", id] });
  };

  const createQuoteMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>): Promise<QuoteDetail> => {
      const res = await apiRequest("POST", "/api/customer-quotes/quote", payload);
      return res.json() as Promise<QuoteDetail>;
    },
    onSuccess: (detail) => {
      invalidateQuoteData();
      setNewQuoteOpen(false);
      toast({ title: "Quote logged", description: `${detail.opp.originCity} → ${detail.opp.destCity}` });
      setDrawerId(detail.opp.id);
    },
    onError: (err: Error) => toast({ title: "Could not save quote", description: err.message, variant: "destructive" }),
  });

  const updateQuoteMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }): Promise<QuoteDetail> => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/quote/${id}`, patch);
      return res.json() as Promise<QuoteDetail>;
    },
    onSuccess: (detail) => {
      invalidateQuoteData(detail.opp.id);
      toast({ title: "Quote updated" });
    },
    onError: (err: Error) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  // Task #584 — used by the inline reassign popover to spin up a fresh
  // quote_customers row when the rep can't find a match in the existing list.
  const createCustomerMutation = useMutation({
    mutationFn: async (input: { name: string; segment?: string | null }): Promise<Customer> => {
      const res = await apiRequest("POST", "/api/customer-quotes/customers", input);
      return res.json() as Promise<Customer>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
    },
    onError: (err: Error) => toast({ title: "Could not create customer", description: err.message, variant: "destructive" }),
  });

  // Task #584 — reassign a quote out of the "Unknown — needs review" bucket.
  // Two paths: pick an existing customer (just patch the FK) or create a new
  // one first (POST /customers, then patch). Both invalidate snapshot+list so
  // the chip counter and table reflect the change immediately.
  const reassignQuoteCustomer = async (quoteId: string, choice: { existingId: string } | { newName: string }): Promise<void> => {
    let customerId: string;
    if ("existingId" in choice) {
      customerId = choice.existingId;
    } else {
      const created = await createCustomerMutation.mutateAsync({ name: choice.newName });
      customerId = created.id;
    }
    await updateQuoteMutation.mutateAsync({ id: quoteId, patch: { customerId } });
  };

  // Customer Quotes #2 — bulk selection lives at the page level so the
  // floating bulk-action bar and the row checkboxes stay in sync.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const toggleSelect = (id: string): void => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = (ids: string[], checked: boolean): void => setSelectedIds(prev => {
    const next = new Set(prev);
    for (const id of ids) {
      if (checked) next.add(id); else next.delete(id);
    }
    return next;
  });
  const clearSelection = (): void => setSelectedIds(new Set());

  // Customer Quotes #2 — bulk endpoints. Both invalidate snapshot+list so
  // KPIs and the table reflect the change in one round-trip.
  const bulkReassignMutation = useMutation({
    mutationFn: async (input: { quoteIds: string[]; targetCustomerId: string }):
      Promise<{ updated: number; skipped: string[] }> => {
      const res = await apiRequest(
        "POST",
        "/api/customer-quotes/quotes/bulk-reassign-customer",
        input,
      );
      return res.json() as Promise<{ updated: number; skipped: string[] }>;
    },
    onSuccess: (result) => {
      const skipped = result.skipped?.length ?? 0;
      toast({
        title: `${result.updated} quote(s) reassigned`,
        description: skipped > 0 ? `${skipped} skipped (already classified).` : undefined,
      });
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/action-queue"] });
    },
    onError: (err: Error) => toast({ title: "Bulk reassign failed", description: err.message, variant: "destructive" }),
  });

  const bulkStatusMutation = useMutation({
    mutationFn: async (input: { quoteIds: string[]; status: "ignored" | "pending" }): Promise<{ updated: number }> => {
      const res = await apiRequest("POST", "/api/customer-quotes/quotes/bulk-status", input);
      return res.json() as Promise<{ updated: number }>;
    },
    onSuccess: (result, vars) => {
      toast({ title: `${result.updated} quote(s) marked ${vars.status}` });
      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/action-queue"] });
    },
    onError: (err: Error) => toast({ title: "Bulk status update failed", description: err.message, variant: "destructive" }),
  });

  const updateFilter = (patch: Partial<Filters>): void => setFilters(f => ({ ...f, ...patch }));
  const clearAll = (): void => setFilters({});
  const removeFilter = (k: keyof Filters): void => setFilters(f => { const c = { ...f }; delete c[k]; return c; });
  const hasFilters = Object.values(filters).some(v => v !== undefined && v !== "" && v !== false);

  const toggleSort = (k: SortKey): void => {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("desc"); }
  };

  const handleExport = (): void => {
    const url = `/api/customer-quotes/export.csv${filterQs ? "?" + filterQs : ""}`;
    window.open(url, "_blank");
  };

  const data = snapshotQuery.data;
  const list = listQuery.data;
  const totalPages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;

  // Match the logged-in user to their `quote_reps` row by email so the
  // "My Open" preset can scope the table. `null` if no mapping exists
  // (e.g. user is admin without a sales-rep identity); the chip is
  // rendered disabled in that case.
  const myRepId = useMemo<string | null>(() => {
    const u = currentUser as { email?: string | null } | null | undefined;
    const email = u?.email?.trim().toLowerCase();
    if (!email) return null;
    const reps = data?.reps ?? [];
    const match = reps.find(r => (r.email ?? "").trim().toLowerCase() === email);
    return match?.id ?? null;
  }, [currentUser, data?.reps]);

  // Derived: which preset chip (if any) matches the current
  // filter+sort signature. Re-derived on every render — no extra
  // state, so manually editing a filter naturally drops the active
  // chip highlight.
  const activePreset = useMemo<PresetKey | null>(
    () => detectActivePreset(filters, sortKey, sortDir, myRepId, new Date()),
    [filters, sortKey, sortDir, myRepId],
  );

  const applyPreset = (key: PresetKey): void => {
    if (key === "myOpen" && !myRepId) return;
    const next = presetToFilters(key, myRepId, new Date());
    setFilters(next.filters);
    setSortKey(next.sortKey);
    setSortDir(next.sortDir);
  };

  // Task #651 — warm the shared lane-signal cache for the rows on the
  // current page so LWQ + Available Freight see them populated for free.
  const visibleLaneSigs = useMemo<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of list?.rows ?? []) {
      if (!r.originCity || !r.destCity) continue;
      const sig = laneSigKey(r.originCity, r.destCity);
      if (!seen.has(sig)) { seen.add(sig); out.push(sig); }
    }
    return out;
  }, [list?.rows]);
  useLaneSignals(visibleLaneSigs);

  // Customer Quotes #2 — IDs of any quote_customer rows that map to the
  // shared "Unknown — needs review" bucket. Drives the bulk action bar's
  // "Reassign to…" enable/disable rule and the bulk-reassign payload.
  const unknownCustomerIds = useMemo<Set<string>>(() => {
    const ids = new Set<string>();
    for (const c of data?.customers ?? []) {
      if (c.name === UNKNOWN_CUSTOMER_NAME) ids.add(c.id);
    }
    return ids;
  }, [data?.customers]);

  const selectedQuotes = useMemo(
    () => (list?.rows ?? []).filter(r => selectedIds.has(r.id)),
    [list?.rows, selectedIds],
  );
  const allSelectedAreUnknown = selectedQuotes.length > 0
    && selectedQuotes.every(q => unknownCustomerIds.has(q.customerId));

  // Portal target for Radix overlays opened on this page. Stored in
  // state so consumers re-render once the div mounts.
  const [overlayPortal, setOverlayPortal] = useState<HTMLDivElement | null>(null);

  return (
    <div
      className={`flex flex-col h-full bg-background text-foreground ${theme === "dark" ? "dark" : "light"}`}
      style={{ fontFamily: "Inter, sans-serif" }}
      data-cq-theme={theme}
      data-testid="page-customer-quotes"
    >
      <div ref={setOverlayPortal} data-testid="cq-overlay-portal" />
      <CustomerQuotesPortalContext.Provider value={overlayPortal}>
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-background shrink-0" data-testid="header-customer-quotes">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Customer Quotes</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Quote requests, outcomes, lane performance — drillable across customers, reps, and lanes.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setNewQuoteOpen(true)} className="bg-amber-500 hover:bg-amber-600 text-zinc-950" data-testid="button-new-quote">
              <Plus className="h-3.5 w-3.5 mr-1.5" /> New Quote
            </Button>
            <Button size="sm" variant="outline" onClick={handleExport} className="border-border hover:bg-muted" data-testid="button-export-csv">
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSavedViewsOpen(v => !v)} className="border-border hover:bg-muted" data-testid="button-saved-views">
              <Bookmark className="h-3.5 w-3.5 mr-1.5" /> Saved Views
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={toggleTheme}
              className="border-border hover:bg-muted"
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              data-testid="button-toggle-theme"
            >
              {theme === "dark"
                ? <><Sun className="h-3.5 w-3.5 mr-1.5" /> Light</>
                : <><Moon className="h-3.5 w-3.5 mr-1.5" /> Dark</>}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { snapshotQuery.refetch(); listQuery.refetch(); }} disabled={snapshotQuery.isFetching || listQuery.isFetching} className="border-border hover:bg-muted" data-testid="button-refresh">
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${snapshotQuery.isFetching || listQuery.isFetching ? "animate-spin" : ""}`} /> Refresh
            </Button>
            <MarginFloorsSettings canEdit={canPurgeDemo} />
            {/* Customer Quotes #3 — admin view of learned sender→customer
                mappings, with the ability to remove a stale or wrong row. */}
            <SenderMappingsDialog canEdit={canPurgeDemo} />
            {/* Task #597 — admin escape hatch to clear demo seed rows that
                may have leaked into a live org (idempotent on the server). */}
            {canPurgeDemo && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPurgeDemoOpen(true)}
                className="border-border hover:bg-muted text-rose-600 dark:text-rose-400"
                data-testid="button-purge-demo"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Purge demo
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Sticky filter bar */}
      <div className="sticky top-0 z-20 px-6 py-3 border-b border-border bg-background/95 backdrop-blur shrink-0" data-testid="filter-bar">
        <div className="flex flex-wrap items-end gap-2">
          <FilterBox label="Customer">
            <CustomerCombobox customers={data?.customers ?? []} value={filters.customerId} onChange={(v) => updateFilter({ customerId: v })} />
          </FilterBox>
          <FilterBox label="Start date">
            <Input type="date" value={filters.startDate ?? ""} onChange={e => updateFilter({ startDate: e.target.value || undefined })} className="h-8 w-[140px] bg-card border-border text-xs" data-testid="input-start-date" />
          </FilterBox>
          <FilterBox label="End date">
            <Input type="date" value={filters.endDate ?? ""} onChange={e => updateFilter({ endDate: e.target.value || undefined })} className="h-8 w-[140px] bg-card border-border text-xs" data-testid="input-end-date" />
          </FilterBox>
          <FilterBox label="Equipment">
            <Select value={filters.equipment ?? "_all"} onValueChange={v => updateFilter({ equipment: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[120px] bg-card border-border text-xs" data-testid="select-equipment"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                <SelectItem value="_all">All</SelectItem>
                {EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Rep">
            <Select value={filters.repId ?? "_all"} onValueChange={v => updateFilter({ repId: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[140px] bg-card border-border text-xs" data-testid="select-rep"><SelectValue placeholder="All reps" /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                <SelectItem value="_all">All reps</SelectItem>
                {data?.reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Outcome">
            <Select value={filters.outcomeStatus ?? "_all"} onValueChange={v => updateFilter({ outcomeStatus: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[140px] bg-card border-border text-xs" data-testid="select-outcome"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                <SelectItem value="_all">All</SelectItem>
                {ALL_STATUSES.map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Reason">
            <Select value={filters.outcomeReasonId ?? "_all"} onValueChange={v => updateFilter({ outcomeReasonId: v === "_all" ? undefined : v })}>
              <SelectTrigger className="h-8 w-[160px] bg-card border-border text-xs" data-testid="select-reason"><SelectValue placeholder="All reasons" /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                <SelectItem value="_all">All reasons</SelectItem>
                {data?.reasons.map(r => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </FilterBox>
          <FilterBox label="Lane search">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={filters.laneSearch ?? ""} onChange={e => updateFilter({ laneSearch: e.target.value || undefined })} placeholder="Origin/dest..." className="h-8 w-[180px] pl-7 bg-card border-border text-xs" data-testid="input-lane-search" />
            </div>
          </FilterBox>
          <FilterBox label="Won only">
            <div className="h-8 flex items-center"><Switch checked={!!filters.wonOnly} onCheckedChange={v => updateFilter({ wonOnly: v ? true : undefined })} data-testid="switch-won-only" /></div>
          </FilterBox>
          <FilterBox label="Active only">
            <div className="h-8 flex items-center"><Switch checked={!!filters.activeOnly} onCheckedChange={v => updateFilter({ activeOnly: v ? true : undefined })} data-testid="switch-active-only" /></div>
          </FilterBox>
          {hasFilters && (
            <>
              <Button size="sm" variant="ghost" onClick={clearAll} className="h-8 text-xs text-muted-foreground hover:text-foreground" data-testid="button-clear-filters">Clear all</Button>
              <Button size="sm" variant="ghost" onClick={() => setSaveDialogOpen(true)} className="h-8 text-xs font-medium text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300" data-testid="button-save-view"><Plus className="h-3 w-3 mr-1" /> Save view</Button>
            </>
          )}
        </div>
        {hasFilters && (
          <div className="flex flex-wrap gap-1.5 mt-2" data-testid="active-filter-chips">
            {Object.entries(filters).map(([k, v]) => {
              if (v === undefined || v === "" || v === false) return null;
              let label = `${k}: ${String(v)}`;
              if (k === "customerId") label = `Customer: ${data?.customers.find(c => c.id === v)?.name ?? v}`;
              if (k === "repId") label = `Rep: ${data?.reps.find(r => r.id === v)?.name ?? v}`;
              if (k === "outcomeReasonId") label = `Reason: ${data?.reasons.find(r => r.id === v)?.label ?? v}`;
              if (k === "laneGroupId") label = `Lane group: ${data?.laneGroups.find(g => g.id === v)?.name ?? v}`;
              if (k === "outcomeStatus") label = `Outcome: ${STATUS_LABELS[v as string] ?? v}`;
              if (k === "wonOnly") label = "Won only";
              if (k === "lostOnly") label = "Lost only";
              if (k === "activeOnly") label = "Active only";
              if (k === "expiringOnly") label = "Expiring <3d";
              return (
                <button key={k} onClick={() => removeFilter(k as keyof Filters)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/25"
                  data-testid={`chip-${k}`}>
                  {label}<X className="h-3 w-3" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {snapshotQuery.isError || listQuery.isError ? (
          <ErrorBanner
            message="We couldn't load your customer quotes. This is usually temporary — try again."
            onRetry={() => { snapshotQuery.refetch(); listQuery.refetch(); }}
          />
        ) : snapshotQuery.isLoading || !data ? (
          <div className="space-y-3" data-testid="skeleton-customer-quotes">
            <Skeleton className="h-20 w-full bg-card" />
            <Skeleton className="h-64 w-full bg-card" />
            <Skeleton className="h-96 w-full bg-card" />
          </div>
        ) : (
          <>
            {/* Task #505/#616 — Spot Quote Search workflow (headline, top of body) */}
            <SpotQuoteSearch
              customers={data.customers.map(c => ({ id: c.id, name: c.name }))}
              onApplyLaneFilter={(laneSearch) => updateFilter({ laneSearch })}
              onPickQuote={(id) => setDrawerId(id)}
              onPickCustomer={(id) => updateFilter({ customerId: id })}
            />

            {/* Customer Quotes #2 — Action Queue (work board, below Spot Quote Search) */}
            <ActionQueueCard onOpenQuote={(id) => setDrawerId(id)} />

            {/* Sub-view presets — fast operating modes for reps. Each
             *  chip applies an existing filter+sort combination; the
             *  active chip highlights when the current state matches.
             *  Manually editing a filter naturally drops the highlight. */}
            <div className="flex flex-wrap items-center gap-1.5" data-testid="preset-bar" role="group" aria-label="Customer quote view presets">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground mr-1">View:</span>
              {PRESETS.map(p => {
                const isActive = activePreset === p.key;
                const isDisabled = p.key === "myOpen" && !myRepId;
                return (
                  <Button
                    key={p.key}
                    type="button"
                    size="sm"
                    variant={isActive ? "default" : "outline"}
                    disabled={isDisabled}
                    onClick={() => applyPreset(p.key)}
                    className={`h-7 px-2.5 text-xs ${isActive ? "bg-amber-500 hover:bg-amber-600 text-zinc-950 border-amber-500" : "border-border hover:bg-muted"}`}
                    title={isDisabled ? "No quote rep mapped to your account." : undefined}
                    aria-pressed={isActive}
                    data-testid={p.testId}
                    data-active={isActive ? "true" : "false"}
                  >
                    {p.label}
                  </Button>
                );
              })}
            </div>

            {/* KPI strip */}
            {/* Task #816 — carrier cost / margin KPIs were stripped from
                this customer-only surface. Margin data is preserved in
                the database for LWQ; it just isn't shown here. */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2" data-testid="kpi-strip">
              <KpiCard testId="kpi-total" label="Total" value={data.kpis.total.toString()} trend={data.kpis.trend.total} onClick={clearAll} />
              <KpiCard testId="kpi-won" label="Won" value={data.kpis.won.toString()} onClick={() => updateFilter({ wonOnly: true, lostOnly: undefined, activeOnly: undefined, expiringOnly: undefined })} />
              <KpiCard testId="kpi-lost" label="Lost" value={data.kpis.lost.toString()} onClick={() => updateFilter({ lostOnly: true, wonOnly: undefined, activeOnly: undefined, expiringOnly: undefined })} />
              <KpiCard testId="kpi-win-rate" label="Win rate" value={fmtPct(data.kpis.winRate)} trend={data.kpis.trend.winRate} onClick={() => updateFilter({ wonOnly: true, lostOnly: undefined })} />
              <KpiCard testId="kpi-avg-quoted" label="Avg quoted" value={fmtMoney(data.kpis.avgQuoted)} onClick={() => { setSortKey("quotedAmount"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-avg-response" label="Avg response" value={fmtHours(data.kpis.avgResponseTime)} trend={-data.kpis.trend.avgResponse} onClick={() => { setSortKey("responseTimeHours"); setSortDir("desc"); }} />
              <KpiCard testId="kpi-pending" label="Pending" value={data.kpis.pending.toString()} onClick={() => updateFilter({ activeOnly: true, wonOnly: undefined, lostOnly: undefined, expiringOnly: undefined })} />
              <KpiCard testId="kpi-expiring" label="Expiring soon" value={data.kpis.expiringSoon.toString()} sub="<3 days" onClick={() => updateFilter({ expiringOnly: true, activeOnly: undefined, wonOnly: undefined, lostOnly: undefined })} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
              <div className="space-y-4 min-w-0">
                {data.customerPerformance && <CustomerPerformancePanel cp={data.customerPerformance} />}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <TaxonomyModule taxonomy={data.taxonomy} onPick={(s) => updateFilter({ outcomeStatus: s })} />
                  <ValidityWindowModule vw={data.validityWindow} onPickQuote={setDrawerId} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <LaneVarianceModule items={data.laneVariance} onPickLane={(l) => updateFilter({ laneSearch: l.replace(/ → /g, " ") })} />
                  <AttractivenessModule items={data.attractiveness} />
                </div>

                <ChartStrip
                  charts={data.charts}
                  taxonomy={data.taxonomy}
                  agingBuckets={data.validityWindow.agingBuckets}
                  onPickLane={(l) => updateFilter({ laneSearch: l.replace(/ → /g, " ") })}
                  onPickCustomer={(name) => {
                    const c = data.customers.find(x => x.name === name);
                    if (c) updateFilter({ customerId: c.id });
                  }}
                  onPickOutcome={(s) => updateFilter({ outcomeStatus: s })}
                  onPickTrend={(variant, date) => {
                    updateFilter({
                      startDate: date,
                      endDate: date,
                      wonOnly: variant === "won" ? true : undefined,
                      lostOnly: variant === "lost" ? true : undefined,
                    });
                  }}
                  onPickAging={(bucket) => {
                    const now = new Date();
                    const day = 24 * 3600 * 1000;
                    const ranges: Record<string, [number, number]> = {
                      "0-2d": [0, 2], "3-7d": [3, 7], "8-14d": [8, 14],
                      "15-30d": [15, 30], "30+d": [31, 365],
                    };
                    const r = ranges[bucket]; if (!r) return;
                    const end = new Date(now.getTime() - r[0] * day);
                    const start = new Date(now.getTime() - r[1] * day);
                    updateFilter({
                      startDate: start.toISOString().slice(0, 10),
                      endDate: end.toISOString().slice(0, 10),
                    });
                  }}
                />

                {/* Task #803 — Quote Lifecycle Autopilot prompt strip.
                 *  Shown above the table when an inbound quote arrived from
                 *  a known customer DOMAIN but a NEW sender email; one-click
                 *  Add-as-contact / Dismiss clears it.
                 *
                 *  User-controlled gate (mirrors Action Queue): the strip's
                 *  `enabled` prop pauses its query when collapsed so reps
                 *  who don't use the prompt pay no per-page round-trip. */}
                <div className="flex items-center" data-testid="new-contact-reviews-section">
                  <button
                    type="button"
                    onClick={() => setShowNewContactReviews(v => !v)}
                    className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                    aria-expanded={showNewContactReviews}
                    aria-controls="new-contact-reviews-body"
                    data-testid="button-toggle-new-contact-reviews"
                  >
                    {showNewContactReviews
                      ? <ChevronDown className="h-3 w-3" />
                      : <ChevronRight className="h-3 w-3" />}
                    <Sparkles className="h-3 w-3 text-amber-500" />
                    Inbound contact prompts
                  </button>
                </div>
                {showNewContactReviews && (
                  <div id="new-contact-reviews-body">
                    <NewContactReviewStrip enabled={showNewContactReviews} />
                  </div>
                )}

                {/* Quote opportunities table */}
                <Card className="bg-card border-border" data-testid="quote-table-card">
                  <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm text-foreground">
                      Customer Quotes <span className="text-muted-foreground font-normal">({list?.total ?? 0})</span>
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="h-7 w-7 p-0" data-testid="button-page-prev"><ChevronLeft className="h-4 w-4" /></Button>
                      <span className="text-xs text-muted-foreground tabular-nums">Page {page + 1} of {totalPages}</span>
                      <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="h-7 w-7 p-0" data-testid="button-page-next"><ChevronRight className="h-4 w-4" /></Button>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <VirtualTable
                      rows={list?.rows ?? []}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={toggleSort}
                      onRowClick={(id) => setDrawerId(id)}
                      isLoading={listQuery.isLoading}
                      reasons={data.reasons}
                      onInlineOutcome={(id, outcomeStatus, outcomeReasonId) => {
                        // Task #477 — funnel "won" transitions through the
                        // win-outcome dialog so the rep can opt out of the
                        // automatic LWQ lane handoff.
                        const patch = { outcomeStatus, outcomeReasonId: outcomeReasonId ?? null };
                        if (outcomeStatus === "won" || outcomeStatus === "won_low_margin") {
                          setWinDialog({ id, status: outcomeStatus, patch });
                        } else {
                          updateQuoteMutation.mutate({ id, patch });
                        }
                      }}
                      pendingId={updateQuoteMutation.isPending ? (updateQuoteMutation.variables as { id: string } | undefined)?.id : undefined}
                      customers={data.customers}
                      onReassign={reassignQuoteCustomer}
                      selectedIds={selectedIds}
                      onToggleSelect={toggleSelect}
                      onToggleSelectAll={toggleSelectAll}
                      unknownCustomerIds={unknownCustomerIds}
                    />
                  </CardContent>
                </Card>
              </div>

              {/* Right rail */}
              <div className="space-y-4">
                <Card className="bg-card border-border" data-testid="alerts-panel">
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Operational Alerts
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 space-y-2 max-h-[420px] overflow-y-auto">
                    {data.alerts.length === 0 && <div className="text-xs text-muted-foreground px-1">All quiet — no urgent items.</div>}
                    {data.alerts.map(a => (
                      <button key={a.id} onClick={() => {
                        if (a.type === "pattern_shift" && a.data?.customerId) {
                          updateFilter({
                            customerId: a.data.customerId,
                            startDate: a.data.startDate,
                            endDate: undefined,
                            wonOnly: undefined, lostOnly: undefined,
                            activeOnly: undefined, expiringOnly: undefined,
                          });
                        }
                        else if (a.type === "lost_streak_customer" && a.data?.customerId) {
                          updateFilter({ customerId: a.data.customerId, lostOnly: true, wonOnly: undefined, activeOnly: undefined, expiringOnly: undefined });
                        }
                        else if (a.type === "lost_streak_lane" && a.data?.lane) {
                          const lg = data?.laneGroups.find(g => g.name === a.data?.lane);
                          if (lg) updateFilter({ laneGroupId: lg.id, lostOnly: true, wonOnly: undefined, activeOnly: undefined, expiringOnly: undefined });
                          else updateFilter({ laneSearch: a.data.lane.replace(/ → /g, " "), lostOnly: true, wonOnly: undefined, activeOnly: undefined, expiringOnly: undefined });
                        }
                        else if (a.data?.quoteId) setDrawerId(a.data.quoteId);
                        else if (a.data?.lane) updateFilter({ laneSearch: a.data.lane.replace(/ → /g, " ") });
                        else if (a.data?.customerId) updateFilter({ customerId: a.data.customerId });
                        else if (a.type === "expiring") updateFilter({ expiringOnly: true, activeOnly: undefined, wonOnly: undefined, lostOnly: undefined });
                        else if (a.type === "low_margin") updateFilter({ outcomeStatus: "won_low_margin" });
                      }} className={`w-full text-left rounded p-2 border ${
                        a.severity === "high" ? "bg-red-500/10 border-red-500/30 hover:bg-red-500/20"
                        : a.severity === "medium" ? "bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20"
                        : "bg-muted/60 border-border hover:bg-muted"
                      }`} data-testid={`alert-${a.type}`}>
                        <div className="text-[11px] font-semibold text-foreground">{a.title}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{a.detail}</div>
                      </button>
                    ))}
                  </CardContent>
                </Card>

                <Card className="bg-card border-border" data-testid="stale-followups-panel">
                  <CardHeader className="py-3 px-4">
                    <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                      <Hourglass className="h-3.5 w-3.5 text-amber-400" /> Stale Follow-Ups
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 space-y-1.5 max-h-[360px] overflow-y-auto">
                    {(!data.staleFollowUps || data.staleFollowUps.length === 0) && (
                      <div className="text-xs text-muted-foreground px-1" data-testid="text-stale-empty">
                        No quotes past their typical decision window.
                      </div>
                    )}
                    {data.staleFollowUps?.map(s => {
                      const overdueLabel = s.hoursOverdue >= 48
                        ? `${Math.round(s.hoursOverdue / 24)}d`
                        : `${Math.round(s.hoursOverdue)}h`;
                      const typicalLabel = s.pTypicalHours >= 48
                        ? `${Math.round(s.pTypicalHours / 24)}d`
                        : `${Math.round(s.pTypicalHours)}h`;
                      return (
                        <button
                          key={s.quoteId}
                          onClick={() => setDrawerId(s.quoteId)}
                          className="w-full text-left rounded p-2 border bg-amber-500/8 border-amber-500/25 hover:bg-amber-500/15 transition"
                          data-testid={`stale-followup-${s.quoteId}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold text-foreground truncate">{formatCustomerName(s.customerName)}</span>
                            <span className="text-[10px] text-amber-700 dark:text-amber-300 shrink-0">{overdueLabel} late</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 truncate">{s.lane}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {/* Task #837 — share the same "Unassigned" fallback
                                the main Rep column uses so the stale-followup
                                strip never leaks an em-dash placeholder. */}
                            {fmtMoney(s.quotedAmount)} · typical {typicalLabel} · {isRepUnassigned(s.repName)
                              ? <span className="italic">Unassigned</span>
                              : s.repName}
                          </div>
                        </button>
                      );
                    })}
                  </CardContent>
                </Card>

                <Card className="bg-card border-border" data-testid="current-slice-panel">
                  <CardHeader className="py-3 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Current Slice</CardTitle></CardHeader>
                  <CardContent className="px-4 pb-3 text-xs text-foreground/90 space-y-1">
                    {/* Task #816 — Avg margin row removed; this surface is customer-only. */}
                    <div><span className="text-muted-foreground">Quotes:</span> {data.kpis.total}</div>
                    <div><span className="text-muted-foreground">Win rate:</span> {fmtPct(data.kpis.winRate)}</div>
                    <div><span className="text-muted-foreground">Pending:</span> {data.kpis.pending}</div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Saved Views drawer */}
      {savedViewsOpen && (
        <div className="fixed top-[120px] right-6 z-30 w-[280px] rounded border border-border bg-card shadow-xl" data-testid="saved-views-panel">
          <div className="flex items-center justify-between p-3 border-b border-border">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Saved Views</span>
            <button onClick={() => setSavedViewsOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="p-2 max-h-[300px] overflow-y-auto">
            {!savedViewsQuery.data?.length && <div className="text-xs text-muted-foreground px-2 py-3">No saved views yet. Save the current filters to make one.</div>}
            {savedViewsQuery.data?.map(v => (
              <div key={v.id} className="flex items-center gap-1 group">
                <button onClick={() => { setFilters(v.filters); setSavedViewsOpen(false); }}
                  className="flex-1 text-left px-2 py-1.5 rounded text-xs text-foreground hover:bg-muted"
                  data-testid={`button-apply-view-${v.id}`}>{v.name}</button>
                <button onClick={() => deleteViewMutation.mutate(v.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-red-400"
                  data-testid={`button-delete-view-${v.id}`}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent container={overlayPortal} className="bg-card border-border text-foreground">
          <DialogHeader><DialogTitle>Save current view</DialogTitle></DialogHeader>
          <Label htmlFor="view-name" className="text-xs">Name</Label>
          <Input id="view-name" value={newViewName} onChange={e => setNewViewName(e.target.value)} placeholder="e.g. Aurora Foods — wins this month" data-testid="input-view-name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => saveViewMutation.mutate({ name: newViewName.trim(), filters })}
              disabled={!newViewName.trim() || saveViewMutation.isPending} data-testid="button-save-view-confirm">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WinOutcomeDialog
        state={winDialog}
        onCancel={() => setWinDialog(null)}
        onConfirm={(skipLwqHandoff) => {
          if (!winDialog) return;
          updateQuoteMutation.mutate({
            id: winDialog.id,
            patch: { ...winDialog.patch, skipLwqHandoff },
          });
          setWinDialog(null);
        }}
        isSaving={updateQuoteMutation.isPending}
      />

      <QuoteDetailDrawer
        quoteId={drawerId}
        onClose={() => setDrawerId(null)}
        onPickRelated={(id) => setDrawerId(id)}
        customers={data?.customers ?? []}
        reps={data?.reps ?? []}
        reasons={data?.reasons ?? []}
        onSave={(id, patch) => {
          // Task #501 — when the QuoteEditForm is changing the outcome to
          // won / won_low_margin, route through the same WinOutcomeDialog used
          // by the inline picker so the rep can opt out of the LWQ handoff.
          const status = patch.outcomeStatus as string | undefined;
          if (status === "won" || status === "won_low_margin") {
            setWinDialog({ id, status, patch });
          } else {
            updateQuoteMutation.mutate({ id, patch });
          }
        }}
        isSaving={updateQuoteMutation.isPending}
      />

      <BulkActionBar
        selectedCount={selectedIds.size}
        canReassign={allSelectedAreUnknown}
        customers={data?.customers ?? []}
        onClear={clearSelection}
        onReassign={(targetCustomerId) =>
          bulkReassignMutation.mutate({
            quoteIds: Array.from(selectedIds),
            targetCustomerId,
          })
        }
        onMarkIgnored={() =>
          bulkStatusMutation.mutate({
            quoteIds: Array.from(selectedIds),
            status: "ignored",
          })
        }
        isPending={bulkReassignMutation.isPending || bulkStatusMutation.isPending}
      />

      <NewQuoteDialog
        open={newQuoteOpen}
        onOpenChange={setNewQuoteOpen}
        customers={data?.customers ?? []}
        reps={data?.reps ?? []}
        onSubmit={(payload) => createQuoteMutation.mutate(payload)}
        isSubmitting={createQuoteMutation.isPending}
      />

      {/* Task #597 — confirm before purging demo seed rows. The backend
          deletes only canonical demo records (EMAIL/TMS/CRM/MANUAL-1xxx
          source refs); real customer data is untouched. */}
      <AlertDialog open={purgeDemoOpen} onOpenChange={setPurgeDemoOpen}>
        <AlertDialogContent container={overlayPortal} data-testid="dialog-purge-demo">
          <AlertDialogHeader>
            <AlertDialogTitle>Purge demo data?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the canonical demo seed (Aurora Foods, Northwind, Cascade, etc.) and
              their quotes/events from this organization. Real customer data is untouched.
              This is idempotent — safe to re-run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-purge-demo-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); purgeDemoMutation.mutate(); }}
              disabled={purgeDemoMutation.isPending}
              className="bg-rose-600 hover:bg-rose-700 text-white"
              data-testid="button-purge-demo-confirm"
            >
              {purgeDemoMutation.isPending ? "Purging…" : "Purge demo data"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </CustomerQuotesPortalContext.Provider>
    </div>
  );
}

// ---------- Subcomponents ----------
function FilterBox({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function CustomerCombobox({ customers, value, onChange }: { customers: Customer[]; value: string | undefined; onChange: (v: string | undefined) => void }): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [open, setOpen] = useState(false);
  const selected = value ? customers.find(c => c.id === value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-[200px] justify-between bg-card border-border text-xs font-normal"
          data-testid="combobox-customer"
        >
          <span className="truncate">{selected?.name ? formatCustomerName(selected.name) : "All customers"}</span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent container={overlayPortal} className="w-[260px] p-0 bg-card border-border">
        <Command className="bg-card">
          <CommandInput placeholder="Search customers..." className="h-9 text-xs" data-testid="combobox-customer-input" />
          <CommandList>
            <CommandEmpty className="py-3 text-xs text-muted-foreground text-center">No customer found.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="_all" onSelect={() => { onChange(undefined); setOpen(false); }} data-testid="combobox-customer-item-all">
                <Check className={`mr-2 h-3.5 w-3.5 ${!value ? "opacity-100" : "opacity-0"}`} /> All customers
              </CommandItem>
              {customers.map(c => (
                <CommandItem key={c.id} value={c.name} onSelect={() => { onChange(c.id); setOpen(false); }} data-testid={`combobox-customer-item-${c.id}`}>
                  <Check className={`mr-2 h-3.5 w-3.5 ${value === c.id ? "opacity-100" : "opacity-0"}`} />
                  <span className="text-xs">{formatCustomerName(c.name)}</span>
                  {c.segment && <span className="ml-auto text-[10px] text-muted-foreground">{c.segment}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Customer Quotes #2 — sticky bulk-action bar.
 *
 * Slides up from the bottom whenever ≥1 row is selected. "Reassign to…"
 * is enabled only when every selected row is in the Unknown bucket; the
 * other actions stay open so reps can mass-mark spam as ignored.
 */
function BulkActionBar({
  selectedCount, canReassign, customers, onClear, onReassign, onMarkIgnored, isPending,
}: {
  selectedCount: number;
  canReassign: boolean;
  customers: Customer[];
  onClear: () => void;
  onReassign: (targetCustomerId: string) => void;
  onMarkIgnored: () => void;
  isPending: boolean;
}): JSX.Element | null {
  const overlayPortal = useCqOverlayPortal();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  if (selectedCount === 0) return null;

  const matchable = customers.filter(c => c.name !== UNKNOWN_CUSTOMER_NAME);
  const trimmed = search.trim().toLowerCase();
  const filtered = trimmed
    ? matchable.filter(c => c.name.toLowerCase().includes(trimmed))
    : matchable.slice(0, 50);

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50"
      data-testid="bulk-action-bar"
    >
      <div className="flex items-center gap-2 rounded-lg bg-card border border-border shadow-lg px-3 py-2">
        <span className="text-xs font-medium text-foreground tabular-nums px-1" data-testid="text-bulk-count">
          {selectedCount} selected
        </span>
        <div className="h-5 w-px bg-border" />
        <Popover open={pickerOpen} onOpenChange={(o) => { setPickerOpen(o); if (!o) setSearch(""); }}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canReassign || isPending}
              title={canReassign ? "Reassign Needs-Review rows to a real customer" : "Only Needs-Review rows can be reassigned"}
              data-testid="button-bulk-reassign"
            >
              Reassign to…
            </Button>
          </PopoverTrigger>
          <PopoverContent container={overlayPortal} className="w-[280px] p-0" align="center" data-testid="popover-bulk-reassign">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search customer…"
                value={search}
                onValueChange={setSearch}
                data-testid="input-bulk-reassign-search"
              />
              <CommandList>
                <CommandEmpty className="py-2 text-xs text-muted-foreground text-center">
                  No matching customers
                </CommandEmpty>
                {filtered.length > 0 && (
                  <CommandGroup heading="Pick a customer">
                    {filtered.slice(0, 30).map(c => (
                      <CommandItem
                        key={c.id}
                        value={c.id}
                        onSelect={() => { onReassign(c.id); setPickerOpen(false); setSearch(""); }}
                        disabled={isPending}
                        data-testid={`option-bulk-reassign-${c.id}`}
                      >
                        <Check className="h-3 w-3 mr-2 opacity-0" />
                        <span className="truncate">{c.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onMarkIgnored}
          disabled={isPending}
          data-testid="button-bulk-ignore"
        >
          Mark ignored
        </Button>
        <div className="h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs px-2"
          onClick={onClear}
          disabled={isPending}
          data-testid="button-bulk-clear"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Customer Quotes #2 — per-row SLA badge. Recomputes on the client off
 * `requestDate` so the badge can flip from ok → warning → breached
 * without waiting for the next list refetch. Hidden for non-pending
 * rows (state === "na").
 */
function QuoteSlaBadgeCell({ quote }: { quote: Quote }): JSX.Element | null {
  const sla = computeQuoteSla(quote.requestDate, quote.outcomeStatus);
  if (sla.state === "na") return null;
  const tone = sla.state === "breached"
    ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
    : sla.state === "warning"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  const title = sla.state === "breached"
    ? `Past 7-min SLA by ${Math.floor(-sla.remainingMs / 60_000)} min`
    : sla.state === "warning"
      ? "Approaching 7-min SLA"
      : "Within SLA";
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-medium border rounded px-1 py-0.5 tabular-nums ${tone}`}
      title={title}
      data-testid={`badge-sla-${quote.id}`}
    >
      {formatSlaBadge(sla)}
    </span>
  );
}

type ColumnDef =
  | { key: SortKey; label: string; align?: "right"; sortable?: true }
  | { key: string; label: string; align?: "right"; sortable: false };
// Task #816 — Carrier $, Margin $, Margin % were stripped from this
// customer-only surface. Underlying data is still persisted for LWQ; it
// just isn't surfaced in the Quote Opportunities table or drawer.
const COLUMNS: ColumnDef[] = [
  { key: "requestDate", label: "Request" },
  { key: "slaState", label: "SLA", sortable: false },
  { key: "customerName", label: "Customer" },
  { key: "originCity", label: "Origin" },
  { key: "destCity", label: "Destination" },
  { key: "equipment", label: "Equip" },
  { key: "quotedAmount", label: "Quoted", align: "right" },
  { key: "validThrough", label: "Valid" },
  { key: "outcomeStatus", label: "Outcome" },
  { key: "outcomeReasonLabel", label: "Reason" },
  { key: "repName", label: "Rep" },
  { key: "responseTimeHours", label: "Resp", align: "right" },
  { key: "source", label: "Source" },
  { key: "score", label: "Score", align: "right" },
];

/**
 * Task #584 — inline reassign popover surfaced on rows whose customer is the
 * shared "Unknown — needs review" bucket. Lets a rep either pick an existing
 * customer or type in a new name (created on the fly via POST /customers)
 * without leaving the dashboard.
 */
function ReassignCustomerControl({ quoteId, customers, onReassign }: {
  quoteId: string;
  customers: Customer[];
  onReassign: (quoteId: string, choice: { existingId: string } | { newName: string }) => Promise<void>;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  // Surface unknown-bucket entries in the menu would be misleading — strip them.
  const matchable = useMemo(
    () => customers.filter(c => c.name !== UNKNOWN_CUSTOMER_NAME),
    [customers],
  );
  const trimmed = search.trim();
  const lower = trimmed.toLowerCase();
  const filtered = useMemo(
    () => trimmed ? matchable.filter(c => c.name.toLowerCase().includes(lower)) : matchable.slice(0, 50),
    [matchable, trimmed, lower],
  );
  const exactMatch = trimmed
    ? matchable.find(c => c.name.toLowerCase() === lower) ?? null
    : null;

  const handlePick = async (existingId: string): Promise<void> => {
    setBusy(true);
    try {
      await onReassign(quoteId, { existingId });
      setOpen(false);
      setSearch("");
    } finally {
      setBusy(false);
    }
  };
  const handleCreate = async (): Promise<void> => {
    if (!trimmed) return;
    setBusy(true);
    try {
      await onReassign(quoteId, { newName: trimmed });
      setOpen(false);
      setSearch("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-5 px-1.5 text-[10px] font-medium border-amber-500/40 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
          data-testid={`button-reassign-${quoteId}`}
          disabled={busy}
        >
          {busy ? "Saving…" : "Assign"}
        </Button>
      </PopoverTrigger>
      <PopoverContent container={overlayPortal} className="w-[260px] p-0" align="start" data-testid={`popover-reassign-${quoteId}`}>
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type new name…"
            value={search}
            onValueChange={setSearch}
            data-testid={`input-reassign-${quoteId}`}
          />
          <CommandList>
            <CommandEmpty className="py-2 text-xs text-muted-foreground text-center">
              No matching customers
            </CommandEmpty>
            {filtered.length > 0 && (
              <CommandGroup heading="Existing">
                {filtered.slice(0, 20).map(c => (
                  <CommandItem
                    key={c.id}
                    value={c.id}
                    onSelect={() => { void handlePick(c.id); }}
                    disabled={busy}
                    data-testid={`option-reassign-${quoteId}-${c.id}`}
                  >
                    <Check className="h-3 w-3 mr-2 opacity-0" />
                    <span className="truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {trimmed && !exactMatch && (
              <CommandGroup heading="Create new">
                <CommandItem
                  value={`__create__${trimmed}`}
                  onSelect={() => { void handleCreate(); }}
                  disabled={busy}
                  data-testid={`option-reassign-create-${quoteId}`}
                >
                  <Plus className="h-3 w-3 mr-2" />
                  <span className="truncate">Create &quot;{trimmed}&quot;</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function VirtualTable({ rows, sortKey, sortDir, onSort, onRowClick, isLoading, reasons, onInlineOutcome, pendingId, customers, onReassign, selectedIds, onToggleSelect, onToggleSelectAll, unknownCustomerIds }: {
  rows: Quote[]; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; onRowClick: (id: string) => void; isLoading: boolean;
  reasons: Reason[];
  onInlineOutcome: (id: string, status: string, reasonId: string | null) => void;
  pendingId: string | undefined;
  // Task #584 — passed in so the customer cell can render a reassign popover
  // for rows linked to the shared "Unknown — needs review" bucket.
  customers: Customer[];
  onReassign: (quoteId: string, choice: { existingId: string } | { newName: string }) => Promise<void>;
  // Customer Quotes #2 — bulk selection state lives in the parent so the
  // bottom action bar and row checkboxes stay in sync.
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: (ids: string[], checked: boolean) => void;
  unknownCustomerIds: Set<string>;
}): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportH = 600;
  const overscan = 8;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + overscan);
  const visible = rows.slice(startIdx, endIdx);
  const padTop = startIdx * ROW_HEIGHT;
  const padBottom = (rows.length - endIdx) * ROW_HEIGHT;

  return (
    <div
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ maxHeight: viewportH }}
      className="overflow-auto"
      data-testid="quote-table-virtual"
    >
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card z-10 border-b border-border">
          <tr className="text-left text-muted-foreground">
            <th className="px-2 py-2 w-8">
              <Checkbox
                checked={rows.length > 0 && rows.every(r => selectedIds.has(r.id))}
                onCheckedChange={(c) => onToggleSelectAll(rows.map(r => r.id), c === true)}
                aria-label="Select all visible"
                data-testid="checkbox-select-all"
              />
            </th>
            {COLUMNS.map(col => (
              <th key={col.key} className={`px-2 py-2 font-medium text-[10px] uppercase tracking-wider ${col.align === "right" ? "text-right" : ""}`}>
                {col.sortable === false ? (
                  <span className="inline-flex items-center gap-0.5">{col.label}</span>
                ) : (
                  <button onClick={() => onSort(col.key as SortKey)} className="inline-flex items-center gap-0.5 hover:text-foreground" data-testid={`sort-${col.key}`}>
                    {col.label}
                    {sortKey === col.key && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!isLoading && rows.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length + 1} className="p-0">
                <EmptyState
                  icon={InboxIcon}
                  title="No quote opportunities match these filters"
                  description="Try clearing a filter or expanding the date range to see more quote requests."
                  testId="empty-quote-rows"
                  compact
                />
              </td>
            </tr>
          )}
          {padTop > 0 && <tr style={{ height: padTop }} aria-hidden="true"><td colSpan={COLUMNS.length + 1} /></tr>}
          {visible.map(q => {
            const quoted = num(q.quotedAmount);
            // Task #816 — paid / margin / marginPct removed; surface is customer-only.
            return (
              <tr key={q.id} onClick={() => onRowClick(q.id)}
                className={`border-b border-border/50 hover:bg-muted/60 cursor-pointer ${selectedIds.has(q.id) ? "bg-amber-500/5" : ""}`}
                style={{ height: ROW_HEIGHT }}
                data-testid={`row-quote-${q.id}`}>
                <td className="px-2" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(q.id)}
                    onCheckedChange={() => onToggleSelect(q.id)}
                    aria-label={`Select quote ${q.id}`}
                    data-testid={`checkbox-quote-${q.id}`}
                  />
                </td>
                <td className="px-2 whitespace-nowrap text-foreground/90">{new Date(q.requestDate).toLocaleDateString()}</td>
                <td className="px-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <QuoteSlaBadgeCell quote={q} />
                </td>
                <td className="px-2 whitespace-nowrap text-foreground font-medium" onClick={(e) => e.stopPropagation()}>
                  {q.customerName === UNKNOWN_CUSTOMER_NAME ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300" title="Resolver could not match this opportunity to a customer">
                        <AlertTriangle className="h-3 w-3" />
                        {q.customerName}
                      </span>
                      <ReassignCustomerControl
                        quoteId={q.id}
                        customers={customers}
                        onReassign={onReassign}
                      />
                    </span>
                  ) : q.customerId ? (
                    <EntityLink
                      kind="customer"
                      id={q.customerId}
                      name={q.customerName}
                      className="text-foreground font-medium"
                    >
                      {formatCustomerName(q.customerName)}
                    </EntityLink>
                  ) : (
                    formatCustomerName(q.customerName)
                  )}
                  {q.needsNewContactReview ? (
                    <span
                      className="ml-1.5 inline-flex items-center gap-0.5 rounded-sm border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-1 text-[9px] font-semibold uppercase text-amber-800 dark:text-amber-200"
                      title={`Domain matched ${q.needsNewContactReview.customerName} but ${q.needsNewContactReview.senderEmail} is a new sender`}
                      data-testid={`pill-new-contact-${q.id}`}
                    >
                      New contact
                    </span>
                  ) : null}
                </td>
                <td className="px-2 whitespace-nowrap text-foreground/90">{q.originCity}, {q.originState}</td>
                <td className="px-2 whitespace-nowrap text-foreground/90">{q.destCity}, {q.destState}</td>
                <td className="px-2 whitespace-nowrap text-muted-foreground">{q.equipment}</td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-foreground">{fmtMoney(quoted)}</td>
                <td className="px-2 whitespace-nowrap text-muted-foreground">{q.validThrough ? new Date(q.validThrough).toLocaleDateString() : "—"}</td>
                <td className="px-2 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <InlineOutcome
                    quote={q}
                    reasons={reasons}
                    onChange={onInlineOutcome}
                    pending={pendingId === q.id}
                  />
                </td>
                <td className="px-2 whitespace-nowrap text-muted-foreground max-w-[140px] truncate">{q.outcomeReasonLabel ?? "—"}</td>
                {/* Task #816 — Carrier $, Margin $, Margin % cells removed; surface is customer-only. */}
                {/* Task #837 — display fallback: empty / unresolved rep renders as
                    a muted "Unassigned" so the column is never visually blank. */}
                <td className="px-2 whitespace-nowrap text-muted-foreground">
                  {q.repName && q.repName !== "—"
                    ? q.repName
                    : <span className="italic text-muted-foreground/70" data-testid={`text-rep-unassigned-${q.id}`}>Unassigned</span>}
                </td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-muted-foreground">{num(q.responseTimeHours).toFixed(1)}h</td>
                <td className="px-2 whitespace-nowrap text-[10px]">
                  {q.source === "email" && (q.sourceThreadId || q.sourceMessageId) ? (
                    <a
                      href={
                        q.sourceThreadId
                          ? `/conversations?threadId=${encodeURIComponent(q.sourceThreadId)}`
                          : `/conversations?messageId=${encodeURIComponent(q.sourceMessageId!)}`
                      }
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300 uppercase hover:underline"
                      title="Open the source email thread in Conversations"
                      data-testid={`link-quote-source-${q.id}`}
                    >
                      EMAIL
                      <ChevronRight className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground uppercase">{q.source}</span>
                  )}
                </td>
                <td className="px-2 whitespace-nowrap text-right tabular-nums text-foreground/90">{num(q.score).toFixed(0)}</td>
              </tr>
            );
          })}
          {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden="true"><td colSpan={COLUMNS.length} /></tr>}
        </tbody>
      </table>
    </div>
  );
}

function CustomerPerformancePanel({ cp }: { cp: CustomerPerformance }): JSX.Element {
  const total = cp.winCount + cp.lossCount;
  const winRate = total > 0 ? (cp.winCount / total) * 100 : 0;
  return (
    <Card className="bg-card border-border" data-testid="customer-performance-panel">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-foreground">Customer Performance — {formatCustomerName(cp.customer.name)}</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Win/Loss</div>
          <div className="text-2xl font-semibold text-foreground">{fmtPct(winRate)}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{cp.winCount} won · {cp.lossCount} lost</div>
          <div className="mt-2 text-xs text-muted-foreground">Avg quoted: <span className="text-foreground">{fmtMoney(cp.avgQuoted)}</span></div>
          {/* Task #816 — "Avg carrier" line removed; this surface is customer-only. */}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Top Lanes</div>
          <ul className="space-y-1">
            {cp.topLanes.map(l => (
              <li key={l.lane} className="text-xs text-foreground/90 flex justify-between"><span className="truncate pr-2">{l.lane}</span><span className="text-muted-foreground">{l.total}</span></li>
            ))}
            {!cp.topLanes.length && <li className="text-xs text-muted-foreground">No lane data.</li>}
          </ul>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Top Loss Reasons</div>
          <ul className="space-y-1">
            {cp.topLossReasons.map(r => (
              <li key={r.reason} className="text-xs text-foreground/90 flex justify-between"><span className="truncate pr-2">{r.reason}</span><span className="text-muted-foreground">{r.count}</span></li>
            ))}
            {!cp.topLossReasons.length && <li className="text-xs text-muted-foreground">No losses logged.</li>}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function TaxonomyModule({ taxonomy, onPick }: { taxonomy: Record<string, number>; onPick: (s: string) => void }): JSX.Element {
  const entries = OUTCOME_BUCKETS.map(s => ({ status: s, label: STATUS_LABELS[s], count: taxonomy[s] ?? 0 }));
  const total = entries.reduce((s, e) => s + e.count, 0);
  return (
    <Card className="bg-card border-border" data-testid="taxonomy-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-foreground flex items-center gap-1.5"><Trophy className="h-4 w-4 text-amber-400" /> Quote Outcome Taxonomy</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        {entries.map((e, i) => {
          const pct = total > 0 ? (e.count / total) * 100 : 0;
          return (
            <button key={e.status} onClick={() => onPick(e.status)} className="w-full text-left group" data-testid={`taxonomy-${e.status}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground/90 group-hover:text-foreground">{e.label}</span>
                <span className="text-muted-foreground tabular-nums">{e.count} <span className="text-muted-foreground/70">·</span> {fmtPct(pct)}</span>
              </div>
              <div className="h-1.5 bg-muted rounded mt-0.5 overflow-hidden">
                <div className="h-full" style={{ width: `${pct}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ValidityWindowModule({ vw, onPickQuote }: { vw: Snapshot["validityWindow"]; onPickQuote: (id: string) => void }): JSX.Element {
  return (
    <Card className="bg-card border-border" data-testid="validity-window-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-foreground flex items-center gap-1.5"><Hourglass className="h-4 w-4 text-amber-400" /> Quote Validity Window</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded bg-muted p-2"><div className="text-lg font-semibold text-foreground">{vw.activeCount}</div><div className="text-[10px] text-muted-foreground uppercase">Active</div></div>
          <div className="rounded bg-muted p-2"><div className="text-lg font-semibold text-foreground">{vw.expiredCount}</div><div className="text-[10px] text-muted-foreground uppercase">Expired</div></div>
          <div className="rounded bg-muted p-2"><div className="text-lg font-semibold text-foreground">{vw.staleCount}</div><div className="text-[10px] text-muted-foreground uppercase">Stale</div></div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Aging buckets</div>
          <div className="flex gap-1 text-[11px]">
            {Object.entries(vw.agingBuckets).map(([k, v]) => (
              <div key={k} className="flex-1 bg-muted rounded p-1.5 text-center"><div className="font-semibold text-foreground">{v}</div><div className="text-muted-foreground">{k}</div></div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Expiring soon</div>
          <ul className="space-y-1 max-h-[140px] overflow-y-auto">
            {vw.expiringList.length === 0 && <li className="text-xs text-muted-foreground">Nothing expiring imminently.</li>}
            {vw.expiringList.map(q => (
              <li key={q.id}>
                <button onClick={() => onPickQuote(q.id)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-muted flex justify-between gap-2" data-testid={`expiring-${q.id}`}>
                  <span className="truncate text-foreground">{q.lane}</span>
                  <span className="text-muted-foreground whitespace-nowrap">{new Date(q.validThrough).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function LaneVarianceModule({ items, onPickLane }: { items: LaneVarianceItem[]; onPickLane: (l: string) => void }): JSX.Element {
  return (
    <Card className="bg-card border-border" data-testid="lane-variance-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-foreground">Lane Overlap / Internal Variance</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-1 max-h-[260px] overflow-y-auto">
        {items.length === 0 && <div className="text-xs text-muted-foreground">No same-lane overlap among reps.</div>}
        {items.map(v => (
          <button key={v.lane} onClick={() => onPickLane(v.lane)} className="w-full text-left rounded p-2 hover:bg-muted" data-testid={`variance-${v.lane}`}>
            <div className="flex justify-between items-center text-xs">
              <span className="text-foreground truncate pr-2">{v.lane}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${v.spreadPct > 18 ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" : "bg-muted text-foreground/90 border-border"}`}>
                ${Math.round(v.spread).toLocaleString()} ({v.spreadPct.toFixed(0)}%)
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
              {v.breakdown.map(b => `${b.rep}: ${fmtMoney(b.avg)}`).join(" · ")}
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

function AttractivenessModule({ items }: { items: AttractivenessItem[] }): JSX.Element {
  return (
    <Card className="bg-card border-border" data-testid="attractiveness-module">
      <CardHeader className="py-3 px-4"><CardTitle className="text-sm text-foreground">Should We Want This Freight?</CardTitle></CardHeader>
      <CardContent className="px-4 pb-4 space-y-1 max-h-[260px] overflow-y-auto">
        {items.length === 0 && <div className="text-xs text-muted-foreground">Need more quotes per lane to score.</div>}
        {items.slice(0, 12).map(item => (
          <div key={item.customer + item.lane} className="rounded p-2 bg-muted/40 flex items-start justify-between gap-2" data-testid={`attract-${item.customer}-${item.lane}`}>
            <div className="min-w-0">
              <div className="text-xs text-foreground truncate">{formatCustomerName(item.customer)}</div>
              <div className="text-[10px] text-muted-foreground truncate">{item.lane}</div>
            </div>
            <div className="text-right shrink-0">
              <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${ATTRACT_COLORS[item.label]}`}>{item.label}</span>
              {/* Task #816 — avgMargin trailing the win-rate has been
                  stripped from the customer-only attractiveness module
                  alongside the rest of the margin/carrier surface. */}
              <div className="text-[10px] text-muted-foreground mt-0.5">{fmtPct(item.winRate)}</div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

type LaneClickPayload = { lane: string };
type CustomerClickPayload = { customer: string };

type OutcomeBarPayload = { bucket: string };
type AgingBarPayload = { bucket: string };

function ChartStrip({ charts, taxonomy, agingBuckets, onPickLane, onPickCustomer, onPickOutcome, onPickAging, onPickTrend }: {
  charts: Snapshot["charts"];
  taxonomy: Record<string, number>;
  agingBuckets: Record<string, number>;
  onPickLane: (l: string) => void;
  onPickCustomer: (c: string) => void;
  onPickOutcome: (s: string) => void;
  onPickAging: (bucket: string) => void;
  onPickTrend: (variant: "won" | "lost" | "total", date: string) => void;
}): JSX.Element {
  const outcomeData = OUTCOME_BUCKETS.map(s => ({ bucket: s, label: STATUS_LABELS[s], count: taxonomy[s] ?? 0 }));
  const agingData = Object.entries(agingBuckets).map(([bucket, count]) => ({ bucket, count }));
  const handleLaneClick = (data: unknown): void => {
    const d = data as LaneClickPayload | undefined;
    if (d?.lane) onPickLane(d.lane);
  };
  const handleCustomerClick = (data: unknown): void => {
    const d = data as CustomerClickPayload | undefined;
    if (d?.customer) onPickCustomer(d.customer);
  };
  const handleOutcomeClick = (data: unknown): void => {
    const d = data as OutcomeBarPayload | undefined;
    if (d?.bucket) onPickOutcome(d.bucket);
  };
  const handleAgingClick = (data: unknown): void => {
    const d = data as AgingBarPayload | undefined;
    if (d?.bucket) onPickAging(d.bucket);
  };
  const handleTrendClick = (variant: "won" | "lost" | "total") => (data: unknown): void => {
    const d = data as { activeLabel?: string } | undefined;
    const date = d?.activeLabel;
    if (!date) return;
    onPickTrend(variant, date);
  };
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Win/Loss Trend (30d)</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><LineChart data={charts.trend}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} />
            <Line
              dataKey="won" stroke="#10b981" strokeWidth={1.5}
              dot={{ r: 2, cursor: "pointer" }}
              activeDot={{ r: 4, cursor: "pointer", onClick: (_e: unknown, p: unknown) => {
                const date = (p as { payload?: { date?: string } } | undefined)?.payload?.date;
                if (date) onPickTrend("won", date);
              } }}
            />
            <Line
              dataKey="lost" stroke="#ef4444" strokeWidth={1.5}
              dot={{ r: 2, cursor: "pointer" }}
              activeDot={{ r: 4, cursor: "pointer", onClick: (_e: unknown, p: unknown) => {
                const date = (p as { payload?: { date?: string } } | undefined)?.payload?.date;
                if (date) onPickTrend("lost", date);
              } }}
            />
          </LineChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Quote Volume (30d)</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.trend} onClick={handleTrendClick("total")}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} />
            <Bar dataKey="total" fill="#facc15" cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Win Rate by Customer</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.winRateByCustomer} layout="vertical">
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis type="category" dataKey="customer" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} width={110} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} formatter={(v: number) => `${v.toFixed(1)}%`} />
            <Bar dataKey="winRate" fill="#10b981" onClick={handleCustomerClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      {/* Task #816 — "Avg Margin by Customer" chart card removed alongside
          the carrier/margin KPIs and Quote Opportunities columns; the
          underlying snapshot still ships `marginByCustomer` for the LWQ
          surface, so we just stop rendering it here. */}
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Top Lanes</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.topLanes} layout="vertical">
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis type="category" dataKey="lane" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} width={150} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} />
            <Bar dataKey="total" fill="#3b82f6" onClick={handleLaneClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-card border-border">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">High-Volume / Low-Win Lanes</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={charts.highVolLowWin} layout="vertical">
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis type="number" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis type="category" dataKey="lane" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} width={150} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} />
            <Bar dataKey="total" fill="#ef4444" onClick={handleLaneClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-card border-border" data-testid="chart-outcome-distribution">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Outcome Distribution</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={outcomeData}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis dataKey="bucket" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} angle={-30} textAnchor="end" height={50} />
            <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} formatter={(v: number) => `${v} quotes`} />
            <Bar dataKey="count" fill="#a855f7" onClick={handleOutcomeClick} cursor="pointer" />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
      <Card className="bg-card border-border" data-testid="chart-quote-aging">
        <CardHeader className="py-2 px-4"><CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Quote Aging</CardTitle></CardHeader>
        <CardContent className="px-2 pb-2 h-[160px]">
          <ResponsiveContainer><BarChart data={agingData}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis dataKey="bucket" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <RTooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 11 }} />
            <Bar dataKey="count" fill="#0ea5e9" cursor="pointer" onClick={handleAgingClick} />
          </BarChart></ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

// Task #597 — small drawer-scoped control that surfaces the customer's
// classification (customer/carrier/unknown) with a manual-override pill, plus
// three buttons to flip it. Sets `partyTypeManual=true` server-side so future
// auto-classifications don't undo the rep's call. Invalidates the lists/snapshot
// caches so the row immediately disappears (or appears) under the carriers
// toggle without a manual refresh.
function PartyTypeControl({ customer }: { customer: Customer }): JSX.Element {
  const current: PartyType = (customer.partyType as PartyType | undefined) ?? "unknown";
  const isManual = !!customer.partyTypeManual;
  const setMutation = useMutation({
    mutationFn: async (partyType: PartyType): Promise<Customer> => {
      const res = await apiRequest("PATCH", `/api/customer-quotes/customers/${customer.id}`, { partyType });
      return res.json() as Promise<Customer>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote"] });
    },
  });
  const pillColor =
    current === "customer" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
    : current === "carrier" ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30"
    : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  const Btn = ({ value, label }: { value: PartyType; label: string }): JSX.Element => (
    <button
      type="button"
      onClick={() => { if (current !== value) setMutation.mutate(value); }}
      disabled={setMutation.isPending || current === value}
      className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
        current === value
          ? "bg-muted border-border text-foreground cursor-default"
          : "bg-background border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      data-testid={`button-mark-${value}`}
    >
      {label}
    </button>
  );
  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap" data-testid="party-type-control">
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${pillColor}`}
        data-testid={`pill-party-type-${current}`}
        title={isManual ? "Manually set" : "Auto-classified"}
      >
        {current === "unknown" ? "Unknown party" : current === "carrier" ? "Carrier" : "Customer"}
        {isManual && <span className="ml-1 opacity-70">·set</span>}
      </span>
      <span className="text-[10px] text-muted-foreground">Mark as:</span>
      <Btn value="customer" label="Customer" />
      <Btn value="carrier" label="Carrier" />
      <Btn value="unknown" label="Unknown" />
    </div>
  );
}

function QuoteDetailDrawer({ quoteId, onClose, onPickRelated, customers, reps, reasons, onSave, isSaving }: {
  // Task #816 — `carriers` prop dropped from the customer-only drawer.
  quoteId: string | null; onClose: () => void; onPickRelated: (id: string) => void;
  customers: Customer[]; reps: Rep[]; reasons: Reason[];
  onSave: (id: string, patch: Record<string, unknown>) => void;
  isSaving: boolean;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  // Task #809 — peek-modal state for the email thread viewer. Tracking
  // both threadId and messageId lets the same modal serve the Source
  // portlet (always has a threadId) and Timeline flip context (may have
  // only the messageId on older auto-flip events). `subjectHint` keeps
  // the modal header from flickering "Email thread → Re: …" while the
  // messages query loads.
  const [emailViewer, setEmailViewer] = useState<{
    threadId: string | null;
    messageId: string | null;
    subjectHint: string | null;
  } | null>(null);
  useEffect(() => { setEditMode(false); setDraft({}); setEmailViewer(null); }, [quoteId]);
  const detailQuery = useQuery<QuoteDetail>({
    queryKey: ["/api/customer-quotes/quote", quoteId],
    queryFn: async (): Promise<QuoteDetail> => {
      if (!quoteId) throw new Error("no id");
      const res = await fetch(`/api/customer-quotes/quote/${quoteId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<QuoteDetail>;
    },
    enabled: !!quoteId,
  });
  const data = detailQuery.data;

  return (
    <Sheet open={!!quoteId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent container={overlayPortal} side="right" className="w-full sm:max-w-[520px] bg-background border-l border-border text-foreground overflow-y-auto" data-testid="quote-detail-drawer">
        <SheetHeader className="flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-foreground">Quote Detail</SheetTitle>
          {!detailQuery.isLoading && data && !editMode && (
            <Button size="sm" variant="outline" className="border-border hover:bg-muted mr-8" onClick={() => { setEditMode(true); setDraft({}); }} data-testid="button-edit-quote">Edit</Button>
          )}
        </SheetHeader>
        {detailQuery.isLoading || !data ? (
          <div className="space-y-3 mt-4"><Skeleton className="h-32 bg-card" /><Skeleton className="h-32 bg-card" /></div>
        ) : (
          <div className="mt-4 space-y-4 text-sm">
            <div className="rounded bg-card border border-border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Lane</div>
              <div className="text-base font-semibold text-foreground mt-0.5">{data.opp.originCity}, {data.opp.originState} → {data.opp.destCity}, {data.opp.destState}</div>
              <div className="text-xs text-muted-foreground mt-1">{data.opp.equipment} · Customer: {data.customer?.name ?? "—"} · Rep: {data.rep?.name ?? "—"}</div>
              {data.customer && <PartyTypeControl customer={data.customer} />}
              <div className="mt-2 flex items-center gap-2 flex-wrap"><StatusPill status={data.opp.outcomeStatus} /><span className="text-xs text-muted-foreground">{data.reason?.label ?? ""}</span>
                {data.lwqLaneId && (
                  <a
                    href={`/lanes/work-queue?laneId=${data.lwqLaneId}`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider border border-blue-500/40 text-blue-700 dark:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20"
                    data-testid="badge-sourcing-in-lwq"
                    title="Open the Lane Work Queue lane created from this quote"
                  >
                    Sourcing in LWQ
                  </a>
                )}
              </div>
            </div>
            {editMode && (
              <QuoteEditForm
                quote={data.opp}
                customers={customers}
                reps={reps}
                reasons={reasons}
                draft={draft}
                onChange={setDraft}
                onCancel={() => { setEditMode(false); setDraft({}); }}
                onSave={() => { onSave(data.opp.id, draft); setEditMode(false); setDraft({}); }}
                isSaving={isSaving}
              />
            )}
            {/* Task #816 — Carrier paid / Margin $ / Margin % tiles
                stripped from the customer-only drawer. The underlying
                values are still persisted (LWQ + reporting still use
                them), they just aren't shown on this surface. */}
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Quoted" value={fmtMoney(data.opp.quotedAmount)} />
              <Stat label="Response time" value={fmtHours(num(data.opp.responseTimeHours))} />
              <Stat label="Valid through" value={data.opp.validThrough ? new Date(data.opp.validThrough).toLocaleDateString() : "—"} />
            </div>
            <div className="rounded bg-card border border-border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Source</div>
              <div className="text-xs text-foreground/90">{data.opp.source.toUpperCase()} <span className="text-muted-foreground ml-2">{data.opp.sourceReference}</span></div>
              {data.sourceMessage && (data.sourceMessage.threadId || data.sourceMessage.messageId) && (
                <div className="mt-2 text-xs">
                  {/* Task #809: was a hard navigation to /conversations
                      that destroyed drawer state, filters, and scroll
                      position. Now opens a peek modal layered over the
                      drawer so reps can read email context and dismiss
                      back to the same load. */}
                  <button
                    type="button"
                    onClick={() => setEmailViewer({
                      threadId: data.sourceMessage!.threadId ?? null,
                      messageId: data.sourceMessage!.messageId ?? null,
                      subjectHint: data.sourceMessage!.subject ?? null,
                    })}
                    className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 hover:underline focus:outline-none focus:ring-2 focus:ring-ring rounded-sm"
                    data-testid="link-source-conversation"
                    title={data.sourceMessage.subject ?? "Open the source email thread"}
                  >
                    View email thread
                    <ChevronRight className="h-3 w-3" />
                  </button>
                  {data.sourceMessage.fromEmail && (
                    <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
                      From {data.sourceMessage.fromEmail}
                      {data.sourceMessage.receivedAt && ` · ${new Date(data.sourceMessage.receivedAt).toLocaleString()}`}
                    </div>
                  )}
                </div>
              )}
              {/* Task #816 — "Carrier:" line removed from drawer Source panel; surface is customer-only. */}
            </div>
            {data.opp.needsNewContactReview && (
              <NewContactReviewSection
                quoteId={data.opp.id}
                review={data.opp.needsNewContactReview}
              />
            )}
            <div className="rounded bg-card border border-border p-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Timeline & revisions</div>
              <ol className="space-y-2">
                {data.events.map(e => {
                  const amt = e.payload && typeof e.payload === "object" && "quotedAmount" in e.payload ? String((e.payload as Record<string, unknown>).quotedAmount) : null;
                  const flip = data.outcomeFlipContext?.[e.id];
                  const flipLabel = FLIP_EVENT_LABELS[e.eventType];
                  const isFlip = !!flipLabel;
                  const dotClass = isFlip
                    ? (flipLabel.tone === "won" ? "bg-emerald-500" : "bg-red-500")
                    : "bg-amber-400";
                  return (
                    <li key={e.id} className="flex items-start gap-2 text-xs" data-testid={`event-${e.eventType}-${e.id}`}>
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${dotClass}`} />
                      <div className="flex-1">
                        <div className="text-foreground">
                          {isFlip ? (
                            <span className={flipLabel.tone === "won" ? "text-emerald-700 dark:text-emerald-300 font-medium" : "text-red-700 dark:text-red-300 font-medium"}>
                              {flipLabel.label}
                            </span>
                          ) : (
                            <span className="capitalize">{e.eventType.replace(/_/g, " ")}</span>
                          )}
                          <span className="text-muted-foreground font-normal"> · {e.actor ?? "system"}</span>
                        </div>
                        <div className="text-muted-foreground text-[10px]">{new Date(e.occurredAt).toLocaleString()}</div>
                        {amt && <div className="text-muted-foreground text-[10px]">Amount: {fmtMoney(amt)}</div>}
                        {/* Task #803 (B) — direct deep-link to the outbound rep
                            email that triggered the auto-quote (or that we
                            looked at and chose not to auto-quote). The
                            payload always carries either threadId or
                            messageId from graphWebhook ingestion. */}
                        <OutboundReplyEventLink event={e} />
                        {flip && (
                          <div className="mt-1 rounded border border-border/60 bg-muted/40 p-2 space-y-1" data-testid={`flip-context-${e.id}`}>
                            {flip.matchedPhrase && (
                              <div className="text-[11px] text-foreground">
                                <span className="text-muted-foreground">Matched phrase: </span>
                                <span className="italic">&ldquo;{flip.matchedPhrase}&rdquo;</span>
                              </div>
                            )}
                            {flip.reasonCode && (
                              <div className="text-[10px] text-muted-foreground">
                                Reason: {STATUS_LABELS[flip.reasonCode] ?? flip.reasonCode.replace(/_/g, " ")}
                              </div>
                            )}
                            {flip.matchTier && (
                              <div className="text-[10px] text-muted-foreground">
                                TMS match tier: {flip.matchTier}
                              </div>
                            )}
                            {flip.source === "email" && flip.bodyExcerpt && (
                              <div className="text-[11px] text-foreground/80">
                                <div className="text-[10px] text-muted-foreground mb-0.5">
                                  From {flip.fromEmail ?? "customer"}{flip.emailSubject ? ` · ${flip.emailSubject}` : ""}
                                </div>
                                <div className="line-clamp-3 whitespace-pre-wrap">{flip.bodyExcerpt}</div>
                              </div>
                            )}
                            {flip.source === "email" && (flip.threadId || flip.messageId) && (
                              <button
                                type="button"
                                onClick={() => setEmailViewer({
                                  threadId: flip.threadId ?? null,
                                  messageId: flip.messageId ?? null,
                                  subjectHint: flip.emailSubject ?? null,
                                })}
                                className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300 hover:underline focus:outline-none focus:ring-2 focus:ring-ring rounded-sm"
                                data-testid={`link-flip-email-${e.id}`}
                                title="Open the email that triggered this auto-flip"
                              >
                                View triggering email
                                <ChevronRight className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
            {data.opp.notes && (
              <div className="rounded bg-card border border-border p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Notes</div>
                <div className="text-xs text-foreground/90 whitespace-pre-wrap">{data.opp.notes}</div>
              </div>
            )}
            {data.opp.outcomeStatus === "pending" && data.customer && (
              <>
                <PricingRecommendationCard quoteId={data.opp.id} />
                <PricingIntelligencePanel
                  input={{
                    customerId: data.opp.customerId,
                    originCity: data.opp.originCity,
                    originState: data.opp.originState,
                    destCity: data.opp.destCity,
                    destState: data.opp.destState,
                    equipment: data.opp.equipment,
                    laneGroupId: data.opp.laneGroupId ?? undefined,
                  }}
                />
              </>
            )}
            <RelatedSection title="Same lane history" items={data.relatedSameLane} onPick={onPickRelated} testId="related-same-lane" />
            <RelatedSection title="Same customer history" items={data.relatedSameCustomer} onPick={onPickRelated} testId="related-same-customer" />
            <RelatedSection title="Similar lane group" items={data.relatedSameLaneGroup} onPick={onPickRelated} testId="related-same-lane-group" />
          </div>
        )}
      </SheetContent>
      {/* Task #809: Email thread peek modal — mounted at the drawer level
          and routed through the same Customer Quotes overlay portal so it
          layers above both the drawer and the rest of the page without
          tearing down drawer state. */}
      {emailViewer && (
        <EmailThreadViewerModal
          open={!!emailViewer}
          onClose={() => setEmailViewer(null)}
          threadId={emailViewer.threadId}
          messageId={emailViewer.messageId}
          subjectHint={emailViewer.subjectHint}
          container={overlayPortal}
        />
      )}
    </Sheet>
  );
}

// Task #803 (B) — Renders a "View sent message" deep-link inside the
// QuoteDetailDrawer timeline for `auto:outbound_reply` events. The
// extractor + flipper writes both threadId (preferred) and messageId
// into the event payload at write time; this component pulls them back
// out and routes the rep to the Conversations tab. Returns null for
// every other event so the timeline stays uncluttered.
function OutboundReplyEventLink({ event }: { event: QuoteEvent }): JSX.Element | null {
  if (event.actor !== "auto:outbound_reply") return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
  const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
  const providerMessageId = typeof payload.providerMessageId === "string" ? payload.providerMessageId : null;
  const targetId = threadId ?? messageId ?? providerMessageId;
  if (!targetId) return null;
  const href = threadId
    ? `/conversations?threadId=${encodeURIComponent(threadId)}`
    : `/conversations?messageId=${encodeURIComponent(messageId ?? providerMessageId!)}`;
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300 hover:underline mt-0.5"
      data-testid={`link-outbound-reply-${event.id}`}
      title="Open the sent rep email that triggered this auto-quote"
    >
      View sent message
      <ChevronRight className="h-3 w-3" />
    </a>
  );
}

// Task #803 (A) — Add/Dismiss prompt rendered inside the QuoteDetailDrawer.
// Calls /api/customer-quotes/:id/contact-review which short-circuits via
// resolveNewContactReview (clears the flag, writes a sender-mapping
// suppression row, and emits an auto:new_sender event). On success we
// invalidate the detail + list queries so the pill disappears immediately.
function NewContactReviewSection({
  quoteId,
  review,
}: {
  quoteId: string;
  review: NonNullable<Quote["needsNewContactReview"]>;
}): JSX.Element {
  const [name, setName] = useState<string>(review.senderName ?? "");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (action: "add" | "dismiss") => {
      // Defensive: apiRequest already throws on !res.ok (see queryClient
      // throwIfResNotOk), but we re-check here so a future refactor of the
      // helper or a streaming/non-throwing branch can never silently turn
      // a 404/409 from this endpoint into a "success" toast for the rep.
      const res = await apiRequest(
        "POST",
        `/api/customer-quotes/quote/${quoteId}/new-contact-review`,
        action === "add" ? { action, name } : { action },
      );
      if (!res.ok) {
        const text = (await res.text().catch(() => "")) || res.statusText;
        throw new Error(`${res.status}: ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      // Task #803 review fix: drawer detail query is keyed
      // ['/api/customer-quotes/quote', quoteId] (see useQuery at ~L2157),
      // not ['/api/customer-quotes', quoteId]. Wrong key meant the prompt
      // stayed visible until manual reopen. Also invalidate the
      // new-contact-reviews list so the inbox/badge clears.
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/quote", quoteId] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/new-contact-reviews"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customer-quotes/snapshot"] });
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to update contact review");
    },
  });
  return (
    <div
      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-3"
      data-testid={`section-new-contact-review-${quoteId}`}
    >
      <div className="text-[10px] uppercase tracking-wider text-amber-800 dark:text-amber-200 mb-1">
        New contact at {review.customerName}
      </div>
      <div className="text-xs text-foreground/90">
        <span className="font-medium">{review.senderEmail}</span> emailed for the first time. Add as a contact or dismiss.
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Contact name"
          className="text-xs px-2 py-1 rounded border border-border bg-background min-w-[160px]"
          data-testid={`input-new-contact-name-${quoteId}`}
        />
        <button
          type="button"
          onClick={() => mutation.mutate("add")}
          disabled={mutation.isPending}
          className="text-xs px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          data-testid={`button-add-new-contact-${quoteId}`}
        >
          Add contact
        </button>
        <button
          type="button"
          onClick={() => mutation.mutate("dismiss")}
          disabled={mutation.isPending}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
          data-testid={`button-dismiss-new-contact-${quoteId}`}
        >
          Dismiss
        </button>
        {mutation.isPending && <span className="text-[10px] text-muted-foreground">Saving…</span>}
      </div>
      {error && <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

function RelatedSection({ title, items, onPick, testId }: { title: string; items: Quote[]; onPick: (id: string) => void; testId: string }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="rounded bg-card border border-border p-3" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">{title} <span className="text-muted-foreground/70">({items.length})</span></div>
      <ul className="space-y-1">
        {items.slice(0, 8).map(r => (
          <li key={r.id}>
            <button onClick={() => onPick(r.id)} className="w-full text-left text-xs px-2 py-1 rounded hover:bg-muted flex items-center justify-between gap-2" data-testid={`${testId}-item-${r.id}`}>
              <span className="text-foreground truncate">
                {new Date(r.requestDate).toLocaleDateString()} · {r.originCity}→{r.destCity} · {fmtMoney(r.quotedAmount)}
              </span>
              <StatusPill status={r.outcomeStatus} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded bg-card border border-border p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

const SOURCES = ["email", "tms", "crm", "manual", "import"] as const;

function InlineOutcome({ quote, reasons, onChange, pending }: {
  quote: Quote; reasons: Reason[];
  onChange: (id: string, status: string, reasonId: string | null) => void;
  pending: boolean;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [open, setOpen] = useState(false);
  const eligibleReasons = useMemo(() => {
    const cat = quote.outcomeStatus.startsWith("won") ? "won"
      : quote.outcomeStatus.startsWith("lost") ? "lost"
      : quote.outcomeStatus === "no_response" ? "no_response"
      : quote.outcomeStatus === "expired" ? "expired" : null;
    return cat ? reasons.filter(r => r.category === cat) : [];
  }, [quote.outcomeStatus, reasons]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex" data-testid={`inline-outcome-${quote.id}`} disabled={pending}>
          <StatusPill status={quote.outcomeStatus} />
        </button>
      </PopoverTrigger>
      <PopoverContent container={overlayPortal} className="w-[220px] p-2 bg-card border-border" align="start">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 px-1">Set outcome</div>
        <div className="space-y-0.5">
          {Object.keys(STATUS_LABELS).map(s => (
            <button key={s}
              onClick={() => { onChange(quote.id, s, null); setOpen(false); }}
              className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-muted ${s === quote.outcomeStatus ? "bg-muted" : ""}`}
              data-testid={`inline-outcome-option-${quote.id}-${s}`}>
              <StatusPill status={s} />
            </button>
          ))}
        </div>
        {eligibleReasons.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 px-1">Reason</div>
            <div className="space-y-0.5 max-h-[140px] overflow-y-auto">
              {eligibleReasons.map(r => (
                <button key={r.id}
                  onClick={() => { onChange(quote.id, quote.outcomeStatus, r.id); setOpen(false); }}
                  className={`w-full text-left px-2 py-1 rounded text-xs text-foreground/90 hover:bg-muted ${quote.outcomeReasonId === r.id ? "bg-muted text-foreground" : ""}`}
                  data-testid={`inline-reason-option-${quote.id}-${r.id}`}>{r.label}</button>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function QuoteEditForm({ quote, customers, reps, reasons, draft, onChange, onCancel, onSave, isSaving }: {
  // Task #816 — `carriers` prop was retired with the Carrier select in
  // the Edit form. Margin/carrier persistence is unchanged on the API;
  // the surface is just customer-only now.
  quote: Quote; customers: Customer[]; reps: Rep[]; reasons: Reason[];
  draft: Record<string, unknown>; onChange: (d: Record<string, unknown>) => void;
  onCancel: () => void; onSave: () => void; isSaving: boolean;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const get = <T,>(k: string, fallback: T): T => (k in draft ? draft[k] as T : fallback);
  const set = (k: string, v: unknown): void => onChange({ ...draft, [k]: v });
  const status = get("outcomeStatus", quote.outcomeStatus);
  const cat = String(status).startsWith("won") ? "won"
    : String(status).startsWith("lost") ? "lost"
    : status === "no_response" ? "no_response"
    : status === "expired" ? "expired" : null;
  const eligibleReasons = cat ? reasons.filter(r => r.category === cat) : reasons;
  const validThroughDraft = get<string | null>("validThrough", quote.validThrough);
  const validThroughInput = validThroughDraft ? new Date(validThroughDraft).toISOString().slice(0, 10) : "";

  return (
    <div className="rounded bg-card border border-amber-500/30 p-3 space-y-3" data-testid="quote-edit-form">
      <div className="text-[10px] uppercase tracking-wider text-amber-400">Edit quote</div>
      <div className="grid grid-cols-2 gap-2">
        <FormCol label="Customer">
          <Select value={get("customerId", quote.customerId)} onValueChange={(v) => set("customerId", v)}>
            <SelectTrigger className="h-8 bg-background border-border text-xs" data-testid="edit-customer"><SelectValue /></SelectTrigger>
            <SelectContent container={overlayPortal}>{customers.map(c => <SelectItem key={c.id} value={c.id}>{formatCustomerName(c.name)}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Rep">
          <Select value={get("repId", quote.repId ?? "_none") as string} onValueChange={(v) => set("repId", v === "_none" ? null : v)}>
            <SelectTrigger className="h-8 bg-background border-border text-xs" data-testid="edit-rep"><SelectValue /></SelectTrigger>
            <SelectContent container={overlayPortal}>
              <SelectItem value="_none">— Unassigned —</SelectItem>
              {reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Origin city">
          <Input className="h-8 bg-background border-border text-xs" value={get("originCity", quote.originCity)} onChange={(e) => set("originCity", e.target.value)} data-testid="edit-origin-city" />
        </FormCol>
        <FormCol label="Origin ST">
          <Input className="h-8 bg-background border-border text-xs" value={get("originState", quote.originState)} onChange={(e) => set("originState", e.target.value.toUpperCase())} maxLength={2} data-testid="edit-origin-state" />
        </FormCol>
        <FormCol label="Dest city">
          <Input className="h-8 bg-background border-border text-xs" value={get("destCity", quote.destCity)} onChange={(e) => set("destCity", e.target.value)} data-testid="edit-dest-city" />
        </FormCol>
        <FormCol label="Dest ST">
          <Input className="h-8 bg-background border-border text-xs" value={get("destState", quote.destState)} onChange={(e) => set("destState", e.target.value.toUpperCase())} maxLength={2} data-testid="edit-dest-state" />
        </FormCol>
        <FormCol label="Equipment">
          <Select value={get("equipment", quote.equipment)} onValueChange={(v) => set("equipment", v)}>
            <SelectTrigger className="h-8 bg-background border-border text-xs" data-testid="edit-equipment"><SelectValue /></SelectTrigger>
            <SelectContent container={overlayPortal}>{EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Source">
          <Select value={get("source", quote.source)} onValueChange={(v) => set("source", v)}>
            <SelectTrigger className="h-8 bg-background border-border text-xs" data-testid="edit-source"><SelectValue /></SelectTrigger>
            <SelectContent container={overlayPortal}>{SOURCES.map(s => <SelectItem key={s} value={s}>{s.toUpperCase()}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Quoted $">
          <Input type="number" step="0.01" className="h-8 bg-background border-border text-xs" value={String(get("quotedAmount", quote.quotedAmount ?? ""))} onChange={(e) => set("quotedAmount", e.target.value)} data-testid="edit-quoted-amount" />
        </FormCol>
        {/* Task #816 — "Carrier paid $" and "Carrier" form fields removed
            from the customer-only Edit form. Underlying values are still
            persisted by the API (LWQ continues to read them); the rep
            just can't enter or change them from this surface. */}
        <FormCol label="Valid through">
          <Input type="date" className="h-8 bg-background border-border text-xs" value={validThroughInput} onChange={(e) => set("validThrough", e.target.value ? new Date(e.target.value).toISOString() : null)} data-testid="edit-valid-through" />
        </FormCol>
        <FormCol label="Outcome">
          <Select value={status as string} onValueChange={(v) => set("outcomeStatus", v)}>
            <SelectTrigger className="h-8 bg-background border-border text-xs" data-testid="edit-outcome"><SelectValue /></SelectTrigger>
            <SelectContent container={overlayPortal}>{Object.keys(STATUS_LABELS).map(s => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
          </Select>
        </FormCol>
        <FormCol label="Reason">
          <Select value={(get("outcomeReasonId", quote.outcomeReasonId ?? "_none") as string) || "_none"} onValueChange={(v) => set("outcomeReasonId", v === "_none" ? null : v)}>
            <SelectTrigger className="h-8 bg-background border-border text-xs" data-testid="edit-reason"><SelectValue /></SelectTrigger>
            <SelectContent container={overlayPortal}>
              <SelectItem value="_none">— None —</SelectItem>
              {eligibleReasons.map(r => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormCol>
      </div>
      <div>
        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Notes</Label>
        <textarea className="w-full mt-0.5 rounded bg-background border border-border p-2 text-xs text-foreground min-h-[60px]"
          value={String(get("notes", quote.notes ?? ""))} onChange={(e) => set("notes", e.target.value)} data-testid="edit-notes" />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="button-edit-cancel">Cancel</Button>
        <Button size="sm" onClick={onSave} disabled={isSaving || Object.keys(draft).length === 0}
          className="bg-amber-500 hover:bg-amber-600 text-zinc-950" data-testid="button-edit-save">
          {isSaving ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function FormCol({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function NewQuoteDialog({ open, onOpenChange, customers, reps, onSubmit, isSubmitting }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  customers: Customer[]; reps: Rep[];
  onSubmit: (payload: Record<string, unknown>) => void; isSubmitting: boolean;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [form, setForm] = useState({
    customerId: "", repId: "_none",
    originCity: "", originState: "",
    destCity: "", destState: "",
    equipment: "Dry Van",
    quotedAmount: "",
    validThrough: "",
    source: "manual",
    sourceReference: "",
    notes: "",
  });
  useEffect(() => {
    if (open) setForm({
      customerId: "", repId: "_none",
      originCity: "", originState: "",
      destCity: "", destState: "",
      equipment: "Dry Van", quotedAmount: "",
      validThrough: "", source: "manual",
      sourceReference: "", notes: "",
    });
  }, [open]);
  const upd = (k: string, v: string): void => setForm(f => ({ ...f, [k]: v }));
  const valid = form.customerId && form.originCity && form.originState && form.destCity && form.destState && form.equipment;
  const submit = (): void => {
    const payload: Record<string, unknown> = {
      customerId: form.customerId,
      repId: form.repId === "_none" ? null : form.repId,
      originCity: form.originCity.trim(),
      originState: form.originState.trim().toUpperCase(),
      destCity: form.destCity.trim(),
      destState: form.destState.trim().toUpperCase(),
      equipment: form.equipment,
      source: form.source,
    };
    if (form.quotedAmount) payload.quotedAmount = form.quotedAmount;
    if (form.validThrough) payload.validThrough = new Date(form.validThrough).toISOString();
    if (form.sourceReference.trim()) payload.sourceReference = form.sourceReference.trim();
    if (form.notes.trim()) payload.notes = form.notes.trim();
    onSubmit(payload);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent container={overlayPortal} className="bg-card border-border text-foreground max-w-[640px]" data-testid="new-quote-dialog">
        <DialogHeader><DialogTitle>Log a new quote request</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <FormCol label="Customer *">
            <Select value={form.customerId} onValueChange={(v) => upd("customerId", v)}>
              <SelectTrigger className="h-9 bg-background border-border" data-testid="new-customer"><SelectValue placeholder="Select customer" /></SelectTrigger>
              <SelectContent container={overlayPortal}>{customers.map(c => <SelectItem key={c.id} value={c.id}>{formatCustomerName(c.name)}</SelectItem>)}</SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Rep">
            <Select value={form.repId} onValueChange={(v) => upd("repId", v)}>
              <SelectTrigger className="h-9 bg-background border-border" data-testid="new-rep"><SelectValue /></SelectTrigger>
              <SelectContent container={overlayPortal}>
                <SelectItem value="_none">— Unassigned —</SelectItem>
                {reps.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Origin city *">
            <Input className="h-9 bg-background border-border" value={form.originCity} onChange={(e) => upd("originCity", e.target.value)} data-testid="new-origin-city" />
          </FormCol>
          <FormCol label="Origin state *">
            <Input className="h-9 bg-background border-border" value={form.originState} onChange={(e) => upd("originState", e.target.value.toUpperCase())} maxLength={2} data-testid="new-origin-state" />
          </FormCol>
          <FormCol label="Destination city *">
            <Input className="h-9 bg-background border-border" value={form.destCity} onChange={(e) => upd("destCity", e.target.value)} data-testid="new-dest-city" />
          </FormCol>
          <FormCol label="Destination state *">
            <Input className="h-9 bg-background border-border" value={form.destState} onChange={(e) => upd("destState", e.target.value.toUpperCase())} maxLength={2} data-testid="new-dest-state" />
          </FormCol>
          <FormCol label="Equipment">
            <Select value={form.equipment} onValueChange={(v) => upd("equipment", v)}>
              <SelectTrigger className="h-9 bg-background border-border" data-testid="new-equipment"><SelectValue /></SelectTrigger>
              <SelectContent container={overlayPortal}>{EQUIPMENTS.map(e => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Quoted amount $">
            <Input type="number" step="0.01" className="h-9 bg-background border-border" value={form.quotedAmount} onChange={(e) => upd("quotedAmount", e.target.value)} data-testid="new-quoted-amount" />
          </FormCol>
          <FormCol label="Valid through">
            <Input type="date" className="h-9 bg-background border-border" value={form.validThrough} onChange={(e) => upd("validThrough", e.target.value)} data-testid="new-valid-through" />
          </FormCol>
          <FormCol label="Source">
            <Select value={form.source} onValueChange={(v) => upd("source", v)}>
              <SelectTrigger className="h-9 bg-background border-border" data-testid="new-source"><SelectValue /></SelectTrigger>
              <SelectContent container={overlayPortal}>{SOURCES.map(s => <SelectItem key={s} value={s}>{s.toUpperCase()}</SelectItem>)}</SelectContent>
            </Select>
          </FormCol>
          <FormCol label="Source reference">
            <Input className="h-9 bg-background border-border" placeholder="e.g. EMAIL-1234" value={form.sourceReference} onChange={(e) => upd("sourceReference", e.target.value)} data-testid="new-source-ref" />
          </FormCol>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Notes</Label>
          <textarea className="w-full mt-0.5 rounded bg-background border border-border p-2 text-xs text-foreground min-h-[60px]"
            value={form.notes} onChange={(e) => upd("notes", e.target.value)} data-testid="new-notes" />
        </div>
        {form.customerId && form.originCity && form.originState && form.destCity && form.destState && form.equipment ? (
          <PricingIntelligencePanel
            input={{
              customerId: form.customerId,
              originCity: form.originCity.trim(),
              originState: form.originState.trim().toUpperCase(),
              destCity: form.destCity.trim(),
              destState: form.destState.trim().toUpperCase(),
              equipment: form.equipment,
            }}
            onUsePrice={(p) => upd("quotedAmount", String(Math.round(p)))}
          />
        ) : (
          <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground" data-testid="pricing-intel-prompt">
            Pick a customer and lane to see pricing intelligence and a suggested price.
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-new-cancel">Cancel</Button>
          <Button onClick={submit} disabled={!valid || isSubmitting}
            className="bg-amber-500 hover:bg-amber-600 text-zinc-950" data-testid="button-new-save">
            {isSubmitting ? "Saving..." : "Log quote"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// Task #477 — Confirmation dialog shown when a rep marks a quote "won". The
// `Create LWQ lane` checkbox defaults to on; unchecking sends
// skipLwqHandoff=true to the PATCH endpoint so the server skips the
// auto-handoff. The dialog is fully keyboard-driven and dismissible.
function WinOutcomeDialog({ state, onCancel, onConfirm, isSaving }: {
  state: { id: string; status: string; patch: Record<string, unknown> } | null;
  onCancel: () => void;
  onConfirm: (skipLwqHandoff: boolean) => void;
  isSaving: boolean;
}): JSX.Element {
  const overlayPortal = useCqOverlayPortal();
  const [createLane, setCreateLane] = useState(true);
  useEffect(() => { if (state) setCreateLane(true); }, [state]);
  const isLowMargin = state?.status === "won_low_margin";
  return (
    <Dialog open={!!state} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent container={overlayPortal} className="bg-card border-border text-foreground sm:max-w-[440px]" data-testid="win-outcome-dialog">
        <DialogHeader>
          <DialogTitle>Mark quote as {isLowMargin ? "won (low margin)" : "won"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm text-foreground/90">
          <p>Confirm this quote was awarded. We can hand it off to the Lane Work Queue so a rep can start sourcing carriers.</p>
          <label className="flex items-start gap-2 rounded border border-border bg-background/60 p-3 cursor-pointer">
            <Checkbox
              id="win-create-lwq"
              checked={createLane}
              onCheckedChange={(v) => setCreateLane(v !== false)}
              data-testid="checkbox-create-lwq-lane"
            />
            <span className="flex-1">
              <span className="block text-foreground font-medium">Create LWQ lane</span>
              <span className="block text-xs text-muted-foreground mt-0.5">Adds a Lane Work Queue lane for this origin → destination so procurement can begin outreach.</span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} data-testid="button-win-cancel">Cancel</Button>
          <Button
            onClick={() => onConfirm(!createLane)}
            disabled={isSaving}
            className="bg-amber-500 hover:bg-amber-600 text-zinc-950"
            data-testid="button-win-confirm"
          >
            {isSaving ? "Saving..." : "Confirm win"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
