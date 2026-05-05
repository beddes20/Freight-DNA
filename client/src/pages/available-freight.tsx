// Available Freight Cockpit (Task #601) — triage cockpit page.
//
// Cross-cutting filter / selection / outreach contracts shared with
// Lane Work Queue and Available Loads live in docs/workflow-os-spec.md.
// Read it before changing the filter bar, selection grammar, bulk action
// bar, or guardrail copy.

import { useEffect, useMemo, useRef, useState, useCallback, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { CrossTabBreadcrumb } from "@/components/freight/cross-tab-breadcrumb";
import { ContextNotePopover, useRevealContextNoteRow } from "@/components/context-notes";
import { EmbeddedPlayCard } from "@/components/dna-copilot/embedded-play-card";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Command, CommandEmpty, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
  Truck, AlertCircle, RefreshCw, Search, Inbox, Upload,
  CheckCircle2, Clock, Bookmark, MoreHorizontal, ChevronDown,
  Send, AlarmClock, X, UserCheck, ClipboardCheck, Star,
  ChevronsUpDown, Check, ShieldAlert, SlidersHorizontal,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useAuth } from "@/hooks/use-auth";
import type { FreightOpportunity } from "@shared/schema";
import { applyCockpitFilters, type CockpitFilterDiagnostics } from "@/lib/cockpitFilters";
import { resolveScope, summarizeScope, type ScopeInput, type ViewMergeMode } from "@/lib/cockpitScope";
import { resolveUserIdentity, isRowOwnedByUser } from "@shared/cockpitOwnership";
import { todayIsoInOrgTz, ORG_LOCAL_TIMEZONE } from "@shared/orgLocalDate";
import {
  BUCKETS,
  BUCKET_ORDER,
  bucketOrderForMode,
  countBuckets,
  kpisFromFiltered,
  type BucketKey,
  type BucketEvalContext,
} from "@shared/cockpitBuckets";
import {
  listCockpitTeams,
  parseOwnerScopeTokens,
  serializeOwnerScopeTokens,
  resolveOwnerScope,
} from "@shared/cockpitTeams";
import { List as VirtualList, type RowComponentProps } from "react-window";
import { laneStoryHref } from "@/lib/laneSignature";
import { CarrierReasonsPopover } from "@/components/CarrierReasonsPopover";
import { AutoPilotPreviewDrawer } from "@/components/freight/auto-pilot-preview-drawer";
import { LwqContextChip, type LwqContextChipData } from "@/components/freight/lane-cross-link-chip";
// Task #871 — shared lane-cockpit + freshness pill modules.
import {
  FreshnessPill,
  freshnessDotTone,
  type FreshnessSignal,
  type FreshnessProducerSignal as FreshnessProducer,
} from "@/components/freight/freshness-pill";
// Task #967 — shared live-sync health pill.
import { LiveSyncPill } from "@/components/live-sync/LiveSyncPill";
import { AfImportHealthPill } from "@/components/freight/af-import-health-pill";
import { HiddenCountsDisclosure, type HiddenCountsSummary } from "@/components/freight/hidden-counts";
import { AfOpsSignalsBar } from "@/components/freight/af-ops-signals-bar";
import {
  AVAILABLE_FREIGHT_MODE_META,
  AVAILABLE_FREIGHT_MODES,
  AF_MODE_STORAGE_KEY,
  applyModeToUrl,
  resolveInitialMode,
  type AvailableFreightMode,
} from "@/lib/availableFreightMode";
import { computeCockpitUrgency } from "@shared/cockpitUrgency";
import {
  resolveNextBestAction,
  resolveBlocking,
  pickWhyBucket,
  bucketToneClass,
  type RowActionInput,
} from "@shared/cockpitRowActions";
import { LaneStabilityBadge } from "@/components/freight/lane-stability-badge";
import { LaneCockpitSheet } from "@/components/lane-cockpit/lane-cockpit-sheet";
import { useSharedLaneKeyboard, useLaneCheatSheetRows } from "@/hooks/useSharedLaneKeyboard";


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
  /** Cross-tab UX (option C) — true when carrier asserts this lane in
   *  carrier_claimed_lanes; surfaced as a small "claimed" pill. */
  claimed?: boolean;
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
  /** Task #875 — server-resolved owner attribution envelope. Includes
   *  every owner-shape id (owner / delegated / created / approved) and
   *  their lowercased emails so the client `isMine` predicate matches
   *  the same set of rows the server KPIs counted. May be absent on
   *  legacy/cached payloads — callers must tolerate `null`. */
  ownership?: { ids: string[]; emails: string[] } | null;
  sla: { level: "green" | "yellow" | "red" | null; ageMinutes: number | null };
  laneScore: number | null;
  /** Task #635 — joined from server in the same payload (no per-row N+1). */
  lwqContext?: LwqContextChipData | null;
  laneSignature?: string;
  /** Phase B1 — server-derived freshness label so reps can tell stale-by-date
   *  rows apart from the genuinely actionable ones at a glance. */
  pickupFreshness?: "no_pickup" | "upcoming" | "past_recent" | "past_stale";
  /** Phase B1 — server-computed (org-local) days since pickup. Negative for
   *  upcoming, zero for today, positive for past. The UI must use this value
   *  rather than re-deriving from `new Date()` so the badge label can never
   *  drift off-by-one from the server's freshness/filter decision at the
   *  CT/UTC midnight rollover. */
  pickupDaysAgo?: number | null;
  /**
   * Task #971 — latest UNRESOLVED conversion failure for this row's
   * source quote. Surfaces the red "Conversion failed — Retry" chip
   * directly on the row so the rep doesn't have to detour through the
   * admin Won-Quote audit page. Null when the row's source quote
   * captured cleanly (or has no source quote at all).
   */
  latestConversionFailure?: {
    id: string;
    reason: string;
    detail: string | null;
    attemptedAt: string;
    retryCount: number;
  } | null;
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

// Task #871 — FreshnessSignal/FreshnessPill now imported at the top of
// the file from "@/components/freight/freshness-pill" so LWQ + the Lane
// Cockpit overlay reuse the IDENTICAL pill from the same source.

interface CockpitResponse {
  items: CockpitItem[];
  kpis: {
    total: number;
    generatedToday: number;
    readyToSend: number;
    sentAwaitingCarrier: number;
    atRiskPickup24h: number;
    coveredToday: number;
    // Task #900 — past-pickup rows the 'actionable' rule has hidden;
    // powers the "Stale: N" chip + reveal-stale recovery affordance.
    hiddenStale?: number;
    avgFreshnessMinutes: number | null;
  };
  lastImport: { at: string; ageMinutes: number } | null;
  nextImport?: { at: string; inMinutes: number } | null;
  freshness?: FreshnessSignal;
  // Phase A3 — explained empty state. Counts of rows in the same
  // org+company scope that were dropped by each filter dimension so the UI
  // can tell the rep "0 matching · N hidden by status · M past pickup …"
  // instead of a blank panel. Server-side buckets (byStatus, bySnooze,
  // byPastPickup) come from a single org-scoped SQL aggregate; byLane and
  // byCarrier are JS-derived deltas from the deep-link filters.
  hiddenCounts?: {
    totalInScope: number;
    byStatus: number;
    bySnooze: number;
    byPastPickup: number;
    /** Phase B1 — strictly-stale past pickups (>graceDays). Stable across
     *  scopes so the empty state can always show "M stale" without
     *  flickering when the user flips Recent / Upcoming / All. */
    byPastStale?: number;
    /** Phase B1 — past-pickup rows that are visible under the current
     *  scope (because they're inside the grace window AND status is
     *  still open). Powers the explainer "N past-pickup loads stay
     *  visible because they're still actionable." */
    visiblePastPickupRecent?: number;
    byLane: number;
    byCarrier: number;
    /** Task #957 — number of rows the server-side owner filter dropped. */
    byOwner?: number;
    /**
     * Task #972 — number of rows the impersonation base scope dropped.
     * Always 0 outside viewing-as mode. Independent of `byOwner` so the
     * empty-state hint can distinguish "your client owner filter hid M"
     * from "view-as scope hid N".
     */
    byBaseScope?: number;
    /** Task #971 — slice of byOwner attributable to am_book rows whose
     *  customer didn't resolve to a CRM-owned company. Always present
     *  (server defaults to 0 when am_book isn't active). */
    byUnresolvedCustomer?: number;
  };
  /**
   * Task #972 — server-confirmed impersonation envelope. Always present
   * for shape stability; `isImpersonating: false` outside viewing-as.
   */
  impersonation?: {
    isImpersonating: boolean;
    impersonatedUserId: string | null;
  };
  /** Task #972 — only present when `?debug=cockpit` is set on a non-prod host. */
  debug?: {
    isImpersonating: boolean;
    impersonatedUserId: string | null;
    adminId: string | null;
    currentUserId: string | null;
    baseScope: { userIds: string[]; includeUnassigned: boolean; isAll: boolean } | null;
    requestedOwnerFilter: string;
    effectiveOwnerFilter: string;
    itemsBeforeBaseScope: number;
    hiddenByBaseScope: number;
    perOwnerCounts: Record<string, number>;
    visibleItems: number;
  };
  /** Task #971 — companion to hiddenCounts. Combines the importer's
   *  run-level audit with a per-row list of canonical rows that
   *  absorbed a prior stableKey via soft-merge. Null when no import has
   *  run yet AND no rows in the current view carry a soft-merge marker. */
  dedupeCounts?: {
    lastImportAt: string | null;
    collapsedByOrderKey: number;
    unmatchedCustomers: number;
    expired: number;
    inserted: number;
    mergedRows: Array<{
      id: string;
      label: string;
      canonicalOpportunityId: string;
      mergedFromStableKey: string;
    }>;
  } | null;
  /** Phase B1 / Task #900 — server-confirmed pickup scope. */
  pickupScope?: "upcoming" | "recent" | "all" | "actionable";
  /** Task #900 — server-confirmed owner filter ('all'|'me'|'unassigned'|<userId>). */
  ownerFilter?: string;
  /** Phase B1 — grace window applied (days). Defaults to 14. */
  pickupGraceDays?: number;
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
  // Task #900 — sticky owner filter + pickup scope. Either may be `null`
  // to mean "use defaults"; the server treats undefined as "no change".
  ownerFilter?: string | null;
  pickupScope?: "upcoming" | "recent" | "all" | "actionable" | null;
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

/**
 * Task #1022 — Verbose pickup label for the self-explanatory row.
 * Returns an absolute calendar phrase ("Today", "Tomorrow", "Mon Apr 27") with
 * a 24h time, and a relative phrase ("in 14h", "3h ago"). Both pieces are
 * separated so the row can render them with distinct emphasis.
 */
function fmtPickupVerbose(
  s: string | null | undefined,
  now: Date = new Date(),
): { absolute: string; relative: string | null } {
  if (!s) return { absolute: "No pickup set", relative: null };
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return { absolute: "No pickup set", relative: null };
  const startOfDay = (x: Date) => {
    const c = new Date(x);
    c.setHours(0, 0, 0, 0);
    return c;
  };
  const dayDelta = Math.round(
    (startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000,
  );
  const dayLabel = dayDelta === 0
    ? "Today"
    : dayDelta === 1
      ? "Tomorrow"
      : dayDelta === -1
        ? "Yesterday"
        : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const timeLabel = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const absolute = `${dayLabel} ${timeLabel}`;
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(diffMin);
  let relPhrase: string;
  if (abs < 60) relPhrase = `${abs}m`;
  else if (abs < 48 * 60) relPhrase = `${Math.round(abs / 60)}h`;
  else relPhrase = `${Math.round(abs / (60 * 24))}d`;
  const relative = diffMin >= 0 ? `in ${relPhrase}` : `${relPhrase} ago`;
  return { absolute, relative };
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

// Phase A4 — header freshness pill.
//
// Renders a color-coded dot + relative-time label in the page header that
// always shows whether the Available Freight surface is current. Click opens
// a popover with the per-producer breakdown (Won Load Autopilot / Importer /
// Manual) so reps can spot a stalled feed at a glance instead of seeing a
// silently-empty cockpit and assuming nothing is happening.
// Task #871 — FreshnessPill / freshnessDotTone / freshnessLabel /
// freshnessHeaderPillTone now come from "@/components/freight/freshness-pill"
// so LWQ + the Lane Cockpit overlay render the IDENTICAL pill.

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


/**
 * Task #957 — Multi-select owner combobox.
 *
 * Tokens accepted:
 *   • "me"            — current user.
 *   • "my-team"       — current user + direct reports (resolved by the
 *                       cockpit page via the loaded users + cockpitTeamMap).
 *   • "unassigned"    — rows with no owner.
 *   • "team:<id>"     — every user in the named team roster entry.
 *   • <userId>        — specific dispatcher.
 *
 * Empty selection means "all" (everyone). The trigger renders a count and
 * the popover renders three sections: shortcuts, teams, and individual
 * users.
 */
function OwnerCombobox({
  tokens,
  users,
  teams,
  ownerLabel,
  onChange,
  dataTestId,
}: {
  tokens: string[];
  users: UserOption[];
  teams: ReadonlyArray<{ id: string; name: string; userIds: string[] }>;
  ownerLabel: (u: UserOption) => string;
  onChange: (next: string[]) => void;
  dataTestId: string;
}) {
  const [open, setOpen] = useState(false);
  const tokenSet = useMemo(() => new Set(tokens.map((t) => t.toLowerCase())), [tokens]);
  const isSelected = (token: string) => tokenSet.has(token.toLowerCase());
  const toggle = (token: string) => {
    const lower = token.toLowerCase();
    const without = tokens.filter((t) => t.toLowerCase() !== lower);
    if (without.length !== tokens.length) {
      onChange(without);
    } else {
      onChange([...tokens, token]);
    }
  };
  const label = useMemo(() => {
    if (tokens.length === 0) return "Owner: all";
    if (tokens.length === 1) {
      const t = tokens[0];
      const lower = t.toLowerCase();
      if (lower === "me") return "Owner: me";
      if (lower === "my-team" || lower === "myteam") return "Owner: my team";
      if (lower === "unassigned") return "Owner: unassigned";
      if (lower === "am_book") return "Owner: my AM book";
      if (lower.startsWith("team:")) {
        const team = teams.find((t2) => t2.id === t.slice("team:".length));
        return team ? `Team: ${team.name}` : `Team: ${t.slice("team:".length)}`;
      }
      const u = users.find((u) => u.id === t);
      return `Owner: ${u ? ownerLabel(u) : t.slice(0, 8)}`;
    }
    return `Owner: ${tokens.length} selected`;
  }, [tokens, users, teams, ownerLabel]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={dataTestId}
        >
          <span className="truncate text-left">{label}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Filter dispatchers…" data-testid={`${dataTestId}-input`} />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {/* Shortcuts */}
            {(["me", "my-team", "am_book", "unassigned"] as const).map((tok) => (
              <CommandItem
                key={tok}
                value={tok}
                onSelect={() => toggle(tok)}
                data-testid={`${dataTestId}-option-${tok}`}
              >
                <Check className={cn("mr-2 h-4 w-4", isSelected(tok) ? "opacity-100" : "opacity-0")} />
                <span className="text-sm">
                  {tok === "me"
                    ? "Me"
                    : tok === "my-team"
                      ? "My team"
                      : tok === "am_book"
                        ? "My AM book"
                        : "Unassigned"}
                </span>
              </CommandItem>
            ))}
            {teams.length > 0 && (
              <>
                <div className="border-t my-1" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Teams</div>
                {teams.map((t) => (
                  <CommandItem
                    key={`team:${t.id}`}
                    value={`team:${t.id} ${t.name}`}
                    onSelect={() => toggle(`team:${t.id}`)}
                    data-testid={`${dataTestId}-option-team-${t.id}`}
                  >
                    <Check className={cn("mr-2 h-4 w-4", isSelected(`team:${t.id}`) ? "opacity-100" : "opacity-0")} />
                    <span className="text-sm">{t.name}</span>
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      {t.userIds.length}
                    </Badge>
                  </CommandItem>
                ))}
              </>
            )}
            {users.length > 0 && (
              <>
                <div className="border-t my-1" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Users</div>
                {users.map((u) => (
                  <CommandItem
                    key={u.id}
                    value={`${u.id} ${ownerLabel(u)}`}
                    onSelect={() => toggle(u.id)}
                    data-testid={`${dataTestId}-option-${u.id}`}
                  >
                    <Check className={cn("mr-2 h-4 w-4", isSelected(u.id) ? "opacity-100" : "opacity-0")} />
                    <span className="text-sm truncate">{ownerLabel(u)}</span>
                  </CommandItem>
                ))}
              </>
            )}
            {tokens.length > 0 && (
              <>
                <div className="border-t my-1" />
                <CommandItem
                  value="__clear__"
                  onSelect={() => onChange([])}
                  data-testid={`${dataTestId}-clear`}
                >
                  <X className="mr-2 h-4 w-4" />
                  <span className="text-sm">Clear selection</span>
                </CommandItem>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Task #957 — Queue bucket chip strip. Each chip's count comes from
 * `bucketCounts` (computed on the same pre-bucket pipeline that drives
 * the visible row set), so the rep's mental model "this chip will give me
 * N rows" always holds.
 */
function BucketChipStrip({
  selected,
  counts,
  onSelect,
  mode,
}: {
  selected: BucketKey;
  counts: Record<BucketKey, number>;
  onSelect: (bucket: BucketKey) => void;
  // Task #1023 — bucket strip is mode-aware. The full registry is
  // unchanged; per-mode order narrows the strip to the chips most
  // relevant to that workflow (Action triage / Coverage funnel / Ops
  // health). Counts are computed from the same filtered collection so
  // a chip's number means the same rows in every mode.
  mode: AvailableFreightMode;
}) {
  // If `selected` is a bucket that isn't in the active mode's strip
  // (e.g. user deep-linked `bucket=stale&mode=action`), fall back to
  // appending it so the chip is always visible while selected — the
  // rep's selection wins over the visual default.
  const orderForMode = bucketOrderForMode(mode);
  const order = orderForMode.includes(selected)
    ? orderForMode
    : [...orderForMode, selected];
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      role="tablist"
      aria-label="Queue buckets"
      data-testid="strip-bucket-chips"
      data-mode={mode}
    >
      {order.map((key) => {
        const def = BUCKETS[key];
        const count = counts[key] ?? 0;
        const isActive = selected === key;
        const dim = !isActive && count === 0 && key !== "all";
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={def.description}
            title={def.description}
            onClick={() => onSelect(key)}
            disabled={key !== "all" && count === 0 && !isActive}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:bg-muted",
              dim && "opacity-60",
            )}
            data-testid={`chip-bucket-${key}`}
            data-bucket-key={key}
            data-bucket-active={isActive ? "true" : "false"}
            data-bucket-count={count}
          >
            <span>{def.label}</span>
            <Badge
              variant={isActive ? "secondary" : "outline"}
              className="h-4 px-1.5 text-[10px] font-mono"
              data-testid={`chip-bucket-${key}-count`}
            >
              {count.toLocaleString()}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}

export default function AvailableFreightPage() {
  const { user } = useAuth();
  // Task #972 — derive impersonation state from useAuth (which already
  // exposes the server's `isImpersonating` flag). Hoisted to the top so
  // every owner-filter helper below can clamp on it without forming a
  // use-before-declare cycle with the typed `currentUser` query later
  // in the file.
  const isImpersonating = !!user?.isImpersonating;
  // Task #950 — when a notification deep-link lands here with
  // `?contextNote=<id>`, scroll-and-ring the row that owns the note. If the
  // anchor row isn't currently rendered (filtered out, paginated away) we
  // fall back to a toast pointing the user to the inbox.
  const { toast: cnToast } = useToast();
  useRevealContextNoteRow({
    surface: "available_freight",
    getRowEl: (anchorId) =>
      document.querySelector<HTMLElement>(`[data-context-anchor-id="${anchorId}"]`),
    fallbackToast: () =>
      cnToast({
        title: "Linked freight is not in the current view",
        description: "Open the note from your Notifications inbox to see the source row.",
      }),
  });
  const isManagerScope =
    !!user &&
    ["admin", "director", "sales_director", "national_account_manager"].includes(user.role ?? "");
  const [search, setSearch] = useState("");
  // Task #957 — debounced search (~150ms) so each keystroke doesn't re-run
  // the filter pipeline + virtualizer over 2k rows. Mirrors the standard
  // useDeferredValue pattern but with an explicit window so the perf tests
  // can rely on the timing.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 150);
    return () => window.clearTimeout(id);
  }, [search]);
  const [companyFilter, setCompanyFilter] = useState<string>("all");
  // Task #957 — queue bucket chip selection (drives row + KPI + ROI from
  // the same filtered collection). "all" means no bucket narrowing.
  const [bucket, setBucket] = useState<BucketKey>("all");
  // Task #1020 — the per-view dismissed-banner localStorage flag is gone
  // along with the amber "view is layering" banner. Replace/merge is now
  // explicit (see `viewMergeMode` below) and surfaced in the ScopeSummary.
  // Task #635 — `?lane=<sig>` deep-link from LWQ filters the cockpit to a
  // single lane signature so the rep lands directly on those opportunities.
  const [laneFilter, setLaneFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("lane");
    return v && v.length > 0 ? v : null;
  });
  // Cross-tab UX (option B) — `?carrierId=<id>` deep-link from Carrier Hub
  // narrows the cockpit to opps the carrier "could cover".
  const [carrierIdFilter, setCarrierIdFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const v = new URLSearchParams(window.location.search).get("carrierId");
    return v && v.length > 0 ? v : null;
  });
  // Task #900 — sticky owner filter. Mirrors lane/carrier deep-link pattern:
  // hydrate from `?owner=`, sync via popstate, and write back to the URL on
  // change so the rep can share / bookmark a filtered cockpit URL. Anything
  // unrecognised silently degrades to "all" (matches the server's behavior).
  //
  // Task #972 — when an admin is impersonating a rep, the cockpit must
  // default to "me" (which resolves to the impersonated rep). The actual
  // override happens in a dedicated effect below once `currentUser` has
  // arrived; here we keep the URL-driven default unchanged so deep-links
  // still hydrate correctly when no impersonation is active.
  const [ownerFilter, setOwnerFilterState] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    const v = new URLSearchParams(window.location.search).get("owner");
    return v && v.length > 0 ? v : "all";
  });
  // Re-sync deep-link filters whenever the URL changes (so navigating in-place
  // from a chip or back/forward updates the filtered cockpit view).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const lane = params.get("lane");
      const cid = params.get("carrierId");
      const owner = params.get("owner");
      setLaneFilter(lane && lane.length > 0 ? lane : null);
      setCarrierIdFilter(cid && cid.length > 0 ? cid : null);
      // Task #972 — back/forward into a wider owner value while
      // impersonating must still clamp. The dedicated impersonation effect
      // above will re-run anyway, but doing it inline keeps the URL bar
      // and the combobox label visually consistent for one frame.
      const next = owner && owner.length > 0 ? owner : "all";
      setOwnerFilterState(isImpersonating && next !== "me" ? "me" : next);
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [isImpersonating]);
  // Wrapper so every owner-filter change writes back to the URL (replaceState
  // so we don't pollute back-button history with every click).
  // Task #957 — accepts either the legacy string ("all" | "me" | <userId>)
  // or an array of multi-select tokens that get serialised as a comma-list.
  const setOwnerFilter = (next: string | string[]) => {
    let serialised = Array.isArray(next)
      ? (serializeOwnerScopeTokens(next) || "all")
      : next;
    // Task #972 — when impersonating, no caller (combobox, saved view,
    // chip handler) may set the owner filter wider than "me". This is
    // belt-and-suspenders: the server already enforces the base scope,
    // but clamping client-side keeps the URL + combobox label honest.
    if (isImpersonating && serialised !== "me") {
      serialised = "me";
    }
    setOwnerFilterState(serialised);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (serialised === "all" || serialised.length === 0) url.searchParams.delete("owner");
    else url.searchParams.set("owner", serialised);
    window.history.replaceState({}, "", url.toString());
  };
  // Task #957 — selected tokens (parsed from the string state). Always
  // contains at least one entry; "all" is implicit when the list is empty.
  const ownerScopeTokens = useMemo<string[]>(() => {
    return ownerFilter === "all" ? [] : parseOwnerScopeTokens(ownerFilter);
  }, [ownerFilter]);
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // Task #1020 — explicit replace-vs-merge for saved views. Default
  // "replace" (the historical activation effect mirrors a view's scalar
  // fields — search/customer/status/owner/pickupScope — into local state
  // and drops its filter extras). Switching to "merge" layers the view's
  // extras (pickupWithinHours, pickupAfterHours, confidenceFlag,
  // sentNoReplyMinAgeMin, statuses) on top of the page state and surfaces
  // them as visible clauses in the scope summary.
  const [viewMergeMode, setViewMergeMode] = useState<ViewMergeMode>("replace");
  const [grouping, setGrouping] = useState<CockpitPrefs["grouping"]>("none");
  const [sort, setSort] = useState<CockpitPrefs["sort"]>("pickup_soonest");
  // Phase B1 — pickupScope answers the operator question "is this lane
  // hidden because it's truly no longer actionable, or just because the
  // current pickup-date logic is too blunt?". 'recent' (default) keeps
  // past-pickup loads visible while their status is still open, hiding
  // only the strictly-stale (>14d) tail. 'upcoming' restores the legacy
  // strict view; 'all' never hides on pickup.
  // Task #900 — default to 'actionable' so the morning queue shows
  // upcoming + today + ≤24h overdue still-open rows. Older lingering past-
  // pickup rows are surfaced via the kpis.hiddenStale "Stale: N" chip and
  // the reveal-stale recovery affordance.
  const [pickupScope, setPickupScope] = useState<
    "upcoming" | "recent" | "all" | "actionable"
  >("actionable");
  const [layout, setLayout] = useState<CockpitPrefs["layout"]>("table");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeHours, setSnoozeHours] = useState<string>("4");
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  // Task #1021 — local-only "Advanced" disclosure state for the demoted
  // KPI tiles (Generated today / Sent / Stale) and the power-user filter
  // selects (Sort / Grouping / Layout). Closed by default so a new rep
  // sees a single primary action surface on first paint.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [autoPilotDrawerOpen, setAutoPilotDrawerOpen] = useState(false);
  // Task #1023 — Available Freight modes (action / coverage / ops). The
  // mode is shared across the page header but each mode renders its own
  // content subtree so the primary execution surface (Action) stays
  // uncluttered. Scope (owner / pickup / saved view / bucket) is shared
  // across modes and never silently mutated by a mode switch — see
  // setMode below.
  const [mode, setModeState] = useState<AvailableFreightMode>(() => {
    if (typeof window === "undefined") return "action";
    const url = new URLSearchParams(window.location.search).get("mode");
    let storage: string | null = null;
    try { storage = localStorage.getItem(AF_MODE_STORAGE_KEY); } catch { /* SSR / privacy mode */ }
    return resolveInitialMode({ url, storage });
  });
  const setMode = useCallback((next: AvailableFreightMode) => {
    setModeState(next);
    try { localStorage.setItem(AF_MODE_STORAGE_KEY, next); } catch { /* ignore */ }
    if (typeof window === "undefined") return;
    const nextHref = applyModeToUrl(window.location.href, next);
    if (nextHref !== window.location.href) {
      window.history.replaceState({}, "", nextHref);
    }
  }, []);
  // Re-sync mode whenever the user navigates back/forward through a
  // deep-link that flipped `?mode=`. Mirrors the existing lane/owner
  // popstate sync so the URL bar and the segmented switcher never
  // disagree.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const url = new URLSearchParams(window.location.search).get("mode");
      let storage: string | null = null;
      try { storage = localStorage.getItem(AF_MODE_STORAGE_KEY); } catch { /* ignore */ }
      setModeState(resolveInitialMode({ url, storage }));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  // Task #1023 — Canonicalize URL + storage whenever the resolved mode
  // changes (initial mount, popstate, programmatic switch). This
  // guarantees the strict "persisted AND reflected in URL" contract:
  //   - storage-seeded → URL gets `?mode=` written so the link is
  //     deep-linkable for sharing
  //   - URL-seeded → storage gets updated so the next visit keeps it
  //   - default mode → `?mode=` is dropped from the URL for clean links
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(AF_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
    const nextHref = applyModeToUrl(window.location.href, mode);
    if (nextHref !== window.location.href) {
      window.history.replaceState({}, "", nextHref);
    }
  }, [mode]);
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
  // Task #871 — Lane Cockpit overlay state. Opens via the shared keyboard
  // (`L` key), the row overflow menu, and the "Open cockpit" chip.
  const [cockpitSignature, setCockpitSignature] = useState<string | null>(null);
  const [cockpitLaneLabel, setCockpitLaneLabel] = useState<string | undefined>(undefined);
  const [cockpitOpen, setCockpitOpen] = useState(false);
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
      // Task #900 — hydrate sticky owner filter + pickup scope. The URL
      // wins if the user landed via a deep-link (`?owner=` already set on
      // mount); otherwise fall back to the persisted pref.
      if (p.pickupScope === "upcoming" || p.pickupScope === "recent" || p.pickupScope === "all" || p.pickupScope === "actionable") {
        setPickupScope(p.pickupScope);
      }
      if (typeof window !== "undefined") {
        const urlOwner = new URLSearchParams(window.location.search).get("owner");
        // Task #972 — when impersonating, the persisted ownerFilter pref
        // belongs to the admin (or to the rep from a previous session) and
        // must NOT widen the cockpit. The dedicated impersonation effect
        // below clamps to "me" regardless; we just skip rehydrating from
        // prefs so the clamp wins on the very first render.
        if (!isImpersonating && !urlOwner && typeof p.ownerFilter === "string" && p.ownerFilter.length > 0) {
          setOwnerFilterState(p.ownerFilter);
        }
      }
    }
  }, [prefsResp, isImpersonating]);

  // Task #972 — viewing-as default + clamp. When impersonation flips on,
  // the cockpit owner combobox MUST default to "me" (which the server
  // resolves to the impersonated rep). Any URL/pref/saved-view value that
  // resolves wider — "all", a different user id, or `unassigned` — is
  // coerced back to "me" and the URL is rewritten so a copied link
  // continues to honor scope after dismissal of view-as. Runs whenever
  // impersonation transitions on so a mid-session "view as" click doesn't
  // leak rows from the admin's previous filter.
  useEffect(() => {
    if (!isImpersonating) return;
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("owner");
    // The only owner token that's safely "me-only" is the literal "me".
    // Any other multi-token / id-based filter would resolve wider than
    // the impersonated rep on the server, so we collapse to "me".
    if (current !== "me") {
      url.searchParams.set("owner", "me");
      window.history.replaceState({}, "", url.toString());
    }
    setOwnerFilterState("me");
  }, [isImpersonating]);

  useEffect(() => {
    if (!activeViewId) return;
    const v = savedViews.find(v => v.id === activeViewId);
    if (!v) return;
    // Task #1020 — only the "replace" mode mirrors a saved view's scalar
    // fields into page-local state. In "merge" mode the page state is left
    // alone and the view's extras layer on top via mergedViewFilters; the
    // ScopeSummary surfaces every clause + provenance.
    if (viewMergeMode !== "replace") return;
    // Task #900 — saved views (including the built-in "My freight today"
    // and "Team needs approval") may carry ownerFilter / pickupScope; load
    // both alongside the legacy fields. Unknown values are ignored so a
    // stale view never wedges the cockpit into an invalid filter combo.
    const f = v.filters as {
      search?: string;
      companyId?: string;
      status?: string;
      ownerFilter?: string;
      pickupScope?: string;
    };
    if (typeof f.search === "string") setSearch(f.search);
    if (typeof f.companyId === "string") setCompanyFilter(f.companyId);
    if (typeof f.status === "string") setStatusFilter(f.status);
    if (typeof f.ownerFilter === "string" && f.ownerFilter.length > 0) {
      // Task #972 — saved views may carry an admin-authored owner filter
      // (e.g. "Team needs approval"). When impersonating, clamp to "me"
      // so loading a saved view never widens past the impersonated rep.
      setOwnerFilter(isImpersonating ? "me" : f.ownerFilter);
    }
    if (
      f.pickupScope === "upcoming" ||
      f.pickupScope === "recent" ||
      f.pickupScope === "all" ||
      f.pickupScope === "actionable"
    ) {
      setPickupScope(f.pickupScope);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId, savedViews, viewMergeMode]);

  // Task #875 — also pull `username` (which is the user's email in this
  // app — see server/auth.ts where Clerk emails are written to
  // users.username). The shared `isRowOwnedByUser` predicate matches by
  // id OR email, so an opp whose ownership was last stamped with a username
  // (e.g. legacy/imported rows) still maps back to the current user.
  const { data: currentUser } = useQuery<{
    id: string;
    username?: string | null;
    email?: string | null;
    // Task #972 — flag mirrored from the server impersonation context.
    // When true, the cockpit base scope is locked to this rep's book and
    // the owner combobox defaults to "me". (We also expose this via
    // `isImpersonating` higher up, derived from useAuth, since downstream
    // owner-filter helpers need it earlier in the render.)
    isImpersonating?: boolean;
  } | null>({
    queryKey: ["/api/auth/me"],
  });

  const upsertPrefs = useMutation({
    mutationFn: async (patch: Partial<CockpitPrefs>) => {
      return apiRequest("PATCH", "/api/freight-opportunities/cockpit-prefs", patch);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit-prefs"] }),
  });

  // Persist grouping/sort/active view changes to prefs (debounced via simple effect dep).
  // Task #900 — also persist ownerFilter + pickupScope. `=== "all"` for owner
  // and the canonical default for pickupScope are stored as `null` so a
  // future default change can pick them up without a stuck pref.
  useEffect(() => {
    if (!hydratedRef.current) return;
    upsertPrefs.mutate({
      activeViewId,
      grouping,
      sort,
      layout,
      ownerFilter: ownerFilter === "all" ? null : ownerFilter,
      pickupScope: pickupScope === "actionable" ? null : pickupScope,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId, grouping, sort, layout, ownerFilter, pickupScope]);

  const statusParam = statusFilter === "active"
    ? "pending_approval,new,ready_to_send,sent,awaiting_carrier_reply,awaiting_customer_confirm,partially_covered"
    : statusFilter === "all"
      ? ""
      : statusFilter;

  // Task #972 — propagate `?debug=cockpit` into the feed query key + URL
  // so the server returns its scope-diagnostics payload alongside the
  // normal response. Computed off `window.location` (not state) to avoid
  // a re-render dependency cycle.
  const debugCockpitParam = typeof window !== "undefined"
    && new URL(window.location.href).searchParams.get("debug") === "cockpit";
  const feedKey = ["/api/freight-opportunities/cockpit", { status: statusParam, sort, grouping, companyId: companyFilter, lane: laneFilter, carrierId: carrierIdFilter, pickupScope, ownerFilter, debug: debugCockpitParam }];
  const { data: serverFeed, isLoading, isError, refetch, isFetching } = useQuery<CockpitResponse>({
    queryKey: feedKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusParam) params.set("status", statusParam);
      params.set("sort", sort);
      params.set("grouping", grouping);
      if (companyFilter !== "all") params.set("companyId", companyFilter);
      if (laneFilter) params.set("lane", laneFilter);
      if (carrierIdFilter) params.set("carrierId", carrierIdFilter);
      params.set("pickupScope", pickupScope);
      // Task #900 — only send `?owner=` when the rep narrowed past "all";
      // keeps the URL clean and lets the server fast-path the unfiltered
      // case without re-running the ownership predicate per row.
      if (ownerFilter !== "all") params.set("ownerFilter", ownerFilter);
      // Task #972 — opt the server into its scope-diagnostics payload.
      if (debugCockpitParam) params.set("debug", "cockpit");
      params.set("limit", "200");
      const res = await fetch(`/api/freight-opportunities/cockpit?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    // Refetch on focus so a tab-switch back from Excel/email surfaces fresh imports.
    refetchOnWindowFocus: true,
  });

  // Cross-tab UX (option B) — fetch carrier name for the "filtered to loads X
  // could cover" banner. Cheap; reuses the carrier-hub detail endpoint and
  // only runs when the deep-link is active.
  const { data: carrierFilterMeta } = useQuery<{ carrier: { id: string; name: string } } | null>({
    queryKey: ["/api/carrier-hub", carrierIdFilter],
    queryFn: async () => {
      if (!carrierIdFilter) return null;
      const r = await fetch(`/api/carrier-hub/${carrierIdFilter}`, { credentials: "include" });
      if (!r.ok) return null;
      return r.json();
    },
    enabled: !!carrierIdFilter,
    staleTime: 60_000,
  });

  function clearCarrierFilter() {
    setCarrierIdFilter(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("carrierId");
      window.history.replaceState({}, "", url.toString());
    }
  }

  // Phase A3 — shared so the empty-state hint and the deep-link banner
  // both clear the lane filter the same way.
  function clearLaneFilter() {
    setLaneFilter(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("lane");
      window.history.replaceState({}, "", url.toString());
    }
  }

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

  // Task #971 — urgency drift recompute. Tick every 60s (paused while
  // the tab is hidden), recompute urgency via the shared helper, and
  // surface diffs as overrides. When `?debug=cockpit` is on we log a
  // warning if the server-stamped urgency disagrees with what we just
  // computed at the same `now` (this means the importer/cockpit math
  // has drifted out of sync, not just clock advance).
  const [urgencyTickMs, setUrgencyTickMs] = useState<number>(() => Date.now());
  const feedReceivedAtRef = useRef<number>(Date.now());
  useEffect(() => {
    feedReceivedAtRef.current = Date.now();
  }, [feed]);
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setUrgencyTickMs(Date.now());
    };
    const id = setInterval(tick, 60_000);
    const onVis = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setUrgencyTickMs(Date.now());
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
    }
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis);
      }
    };
  }, []);
  const urgencyOverrides = useMemo(() => {
    const out = new Map<string, { score: number; level: CockpitItem["urgency"]["level"]; reasons: string[] }>();
    if (!feed) return out;
    const now = new Date(urgencyTickMs);
    const debugEnabled = (() => {
      if (typeof window === "undefined") return false;
      try {
        return new URL(window.location.href).searchParams.get("debug") === "cockpit";
      } catch {
        return false;
      }
    })();
    const feedAgeMs = Math.max(0, urgencyTickMs - feedReceivedAtRef.current);
    for (const it of feed.items) {
      const recomputed = computeCockpitUrgency({
        pickupAt: it.opportunity.pickupWindowStart ?? null,
        generatedAt: it.opportunity.generatedAt ?? null,
        includedCarriers: it.coverage.included ?? 0,
        sentCarriers: it.coverage.sent ?? 0,
        respondedCarriers: it.coverage.responded ?? 0,
        status: it.opportunity.status,
        customerTier: it.customer?.accountTier ?? null,
        laneScore: it.laneScore ?? null,
        now,
      });
      if (recomputed.level !== it.urgency.level || recomputed.score !== it.urgency.score) {
        out.set(it.opportunity.id, recomputed);
        // Debug invariant: server vs client disagreed when the feed was
        // freshly delivered (<5s ago). Means the math drifted, not just
        // that the clock advanced through a band threshold.
        if (debugEnabled && feedAgeMs < 5_000) {
          // eslint-disable-next-line no-console
          console.warn("[cockpit][urgency-drift] server vs client disagree at same now", {
            opportunityId: it.opportunity.id,
            serverLevel: it.urgency.level,
            serverScore: it.urgency.score,
            clientLevel: recomputed.level,
            clientScore: recomputed.score,
            now: now.toISOString(),
          });
        }
      }
    }
    return out;
  }, [feed, urgencyTickMs]);

  // Task #971 — per-row conversion-failure retry. POSTs to the AF
  // endpoint that mirrors the admin retry path (createFreight-
  // OpportunityFromWonQuote) and resolves the failure row server-side
  // when it succeeds. On success we invalidate the cockpit feed so the
  // red chip vanishes without a manual refresh.
  const conversionRetryMutation = useMutation<
    { ok: boolean; opportunityId?: string; failureId: string },
    Error,
    { opportunityId: string; failureId: string }
  >({
    mutationFn: async ({ opportunityId }) => {
      const res = await apiRequest(
        "POST",
        `/api/freight-opportunities/${opportunityId}/conversion-failure/retry`,
      );
      return res.json();
    },
    onSuccess: (_data, vars) => {
      toast({
        title: "Retry queued",
        description: "Re-attempting conversion from the source quote.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/cockpit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/freight-opportunities/import-health"] });
      void vars;
    },
    onError: (err) => {
      toast({
        title: "Retry failed",
        description: err?.message ?? "Could not retry the failed conversion.",
        variant: "destructive",
      });
    },
  });

  const items = feed?.items ?? [];
  // Task #972 — base-scope leak detector. With impersonation active, every
  // row in the feed must list the impersonated rep on its ownership
  // envelope. Anything else — including unassigned / empty-ownership rows
  // — means the server-side base scope wasn't applied (or the
  // /api/auth/me + /api/freight-opportunities/cockpit responses disagree
  // about who is being viewed). We surface this loudly via console.error
  // so a dev / QA notices immediately; we never silently drop rows on the
  // client (the server is the source of truth for scope).
  useEffect(() => {
    if (!isImpersonating) return;
    if (!feed?.items) return;
    const expected = feed.impersonation?.impersonatedUserId ?? currentUser?.id ?? null;
    if (!expected) return;
    const leaks = feed.items.filter((it) => {
      const ids = it.ownership?.ids ?? (it.owner?.id ? [it.owner.id] : []);
      // Empty / unassigned ownership is ALSO a leak under impersonation —
      // the impersonated rep can't own a row that has no owner attribution.
      if (ids.length === 0) return true;
      return !ids.includes(expected);
    });
    if (leaks.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        "[cockpit] base-scope leak",
        {
          expectedUserId: expected,
          leakCount: leaks.length,
          leaks: leaks.map((it) => ({
            id: it.opportunity.id,
            ownership: it.ownership,
            owner: it.owner,
          })),
        },
      );
    }
  }, [feed, isImpersonating, currentUser?.id]);
  // Task #972 — surface impersonation state on the console even outside
  // `?debug=cockpit` so a quick "open devtools" sanity check tells a rep
  // exactly what scope they're viewing under.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!feed?.impersonation) return;
    // Task #972 — only log the impersonation banner when ?debug=cockpit
    // is on (signaled by the server attaching `feed.debug`). Outside
    // debug mode this fires on every feed refetch, which is too noisy
    // for normal use.
    if (feed.impersonation.isImpersonating && feed.debug) {
      // eslint-disable-next-line no-console
      console.info(
        `[cockpit] viewing as user ${feed.impersonation.impersonatedUserId} — base scope is active, owner filter is locked to "me"`,
      );
    }
  }, [
    feed?.impersonation?.isImpersonating,
    feed?.impersonation?.impersonatedUserId,
    feed?.debug,
  ]);
  // Task #972 — when the server returned its scope-diagnostics payload
  // (only happens with `?debug=cockpit`), dump it once per response so an
  // admin can confirm exactly what scope the server applied + how many
  // rows the base scope dropped.
  useEffect(() => {
    if (!feed?.debug) return;
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `[cockpit][debug] server scope diagnostics — visible ${feed.debug.visibleItems}, base-scope hid ${feed.debug.hiddenByBaseScope}`,
    );
    // eslint-disable-next-line no-console
    console.log("impersonation:", {
      isImpersonating: feed.debug.isImpersonating,
      impersonatedUserId: feed.debug.impersonatedUserId,
      adminId: feed.debug.adminId,
      currentUserId: feed.debug.currentUserId,
    });
    // eslint-disable-next-line no-console
    console.log("baseScope:", feed.debug.baseScope);
    // eslint-disable-next-line no-console
    console.log("ownerFilter:", {
      requested: feed.debug.requestedOwnerFilter,
      effective: feed.debug.effectiveOwnerFilter,
    });
    // eslint-disable-next-line no-console
    console.log("counts:", {
      itemsBeforeBaseScope: feed.debug.itemsBeforeBaseScope,
      hiddenByBaseScope: feed.debug.hiddenByBaseScope,
      visibleItems: feed.debug.visibleItems,
      perOwnerCounts: feed.debug.perOwnerCounts,
    });
    // eslint-disable-next-line no-console
    console.groupEnd();
  }, [feed?.debug]);
  // Task #957 follow-up — KPI tiles now derive from the client `filtered`
  // collection (see the kpis useMemo below), not from `feed.kpis`. The
  // server payload is still kept for two purposes:
  //   1) `hiddenStale` — count of past-pickup rows the actionable rule
  //      has hidden from the FEED (a server-only signal we merge on top).
  //   2) Queue-wide reference total surfaced as a small label next to
  //      "Total visible", so reps can still see how big the underlying
  //      queue is.
  const serverKpis = feed?.kpis;

  // Task #649 — toast fires off the raw server payload (not the buffered
  // displayedFeed) so reps still hear about new carrier replies the instant
  // the refetch lands, even if the visible list is paused mid-interaction.
  const replyTotalRef = useRef<number | null>(null);
  // Task #875 — resolve identity once per render so the "mine" predicate
  // here and the one inside `applyCockpitFilters` agree on every owner-
  // shape attribution (id, delegated id, creator, approver, email/username).
  const currentIdentity = useMemo(
    () => resolveUserIdentity(currentUser ?? null),
    [currentUser?.id, currentUser?.username, currentUser?.email],
  );
  useEffect(() => {
    if (!serverFeed) return;
    const sItems = serverFeed.items;
    const myItems = currentIdentity
      ? sItems.filter(it => isRowOwnedByUser(it.ownership ?? null, currentIdentity, it.owner?.id ?? null))
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
  }, [serverFeed, currentIdentity, toast]);

  const activeView = activeViewId ? savedViews.find(v => v.id === activeViewId) : null;
  const viewFilters = (activeView?.filters ?? {}) as {
    // Task #957 — `ownerScope` may also be a string[] of multi-select tokens.
    ownerScope?: "mine" | "team" | string[];
    pickupWithinHours?: number;
    pickupAfterHours?: number;
    confidenceFlag?: "low" | "medium" | "high";
    sentNoReplyMinAgeMin?: number;
    statuses?: string[];
  };

  // Task #875 — full reset for the saved-view chip. Just toggling
  // `activeViewId` off leaves the state mutated by the view-activation
  // effect (search / companyFilter / statusFilter) sticky, so reps who
  // hit "Switch to default view" from the empty-state chip would still
  // see the same constrained queue. Also revert pickupScope to its
  // default so a "My freight today" view that nudged scope can't lock
  // the queue down after dismissal.
  // Task #957 follow-up — reset to the strict operational default, which is
  // pickupScope = "actionable" (yesterday and older are excluded). The old
  // "recent" reset re-introduced past pickups, contradicting the default
  // Available Freight gate.
  const clearActiveView = useCallback(() => {
    setActiveViewId(null);
    setSearch("");
    setCompanyFilter("all");
    setStatusFilter("active");
    setPickupScope("actionable");
    // Task #972 — when an admin is viewing as a rep, "reset" must NOT
    // widen the cockpit back to "all". The default reset state for an
    // impersonating admin is "me" (the impersonated rep). Outside of
    // viewing-as mode the owner filter is left alone (matches prior
    // behavior — `clearActiveView` historically only resets pickupScope
    // and the saved-view-driven fields).
    if (isImpersonating) {
      setOwnerFilter("me");
    }
  }, [isImpersonating]);

  // Task #1020 — per-clause view removal. Clearing the saved-view clause
  // from the Scope Summary (or the conflict "Drop view" action) must
  // ONLY deactivate the view; unrelated page filters such as `search`,
  // `companyFilter`, `statusFilter`, and `pickupScope` must be preserved.
  // Full reset semantics live exclusively on the
  // `button-reset-operational-default` actions.
  const deactivateViewOnly = useCallback(() => {
    setActiveViewId(null);
    setViewMergeMode("replace");
  }, []);

  // Task #875 — `?debug=cockpit` opens a non-production diagnostic pane
  // that prints the per-stage drop counts, the resolved current-user
  // identity, the org-local "today" anchor, and (further below) the side-
  // by-side counts of "KPI strip 'mine' total" vs "table 'mine' total".
  const cockpitDebugEnabled = useMemo(() => {
    if (typeof window === "undefined") return false;
    try {
      return new URL(window.location.href).searchParams.get("debug") === "cockpit";
    } catch {
      return false;
    }
  }, []);

  // Task #957 — synthesize a minimal org-chart for `my-team` expansion +
  // the team_needs_approval bucket. We use the loaded `users` list and the
  // `managerId` field stamped on each user record. When a deployment hasn't
  // populated managerId, the cockpitTeamMap roster is the source of truth.
  const orgChartForBuckets = useMemo(() => {
    return users.map((u) => ({ id: u.id, managerId: (u as any).managerId ?? null }));
  }, [users]);

  // Task #1020 — single ResolvedScope object that drives BOTH the row
  // pipeline (`filtered`) AND the bucket-count pipeline (`bucketCounts`).
  // We pass empty display labels here because this version is consumed
  // only for its `effectiveExtras` + `conflicts` (filter-pipeline data).
  // The render-time call further down recomputes with full labels for
  // the visible Scope Summary chips.
  const resolvedPipelineScope = useMemo(() => resolveScope({
    search: debouncedSearch,
    companyId: companyFilter,
    ownerTokens: ownerScopeTokens,
    ownerLabels: {},
    statusFilter,
    bucket,
    pickupScope,
    laneFilter,
    carrierIdFilter,
    view: activeView ? {
      id: activeView.id,
      name: activeView.name,
      mergeMode: viewMergeMode,
      extras: viewFilters,
    } : null,
  }), [
    debouncedSearch,
    companyFilter,
    ownerScopeTokens,
    statusFilter,
    bucket,
    pickupScope,
    laneFilter,
    carrierIdFilter,
    activeView,
    viewMergeMode,
    viewFilters,
  ]);

  const filtered = useMemo(() => {
    const diagnostics: CockpitFilterDiagnostics | undefined = cockpitDebugEnabled
      ? { enabled: true, stages: [] }
      : undefined;
    // Task #957 — perf instrumentation. Gated under `?debug=cockpit` so
    // production renders pay zero cost.
    const perfStart = cockpitDebugEnabled && typeof performance !== "undefined"
      ? performance.now()
      : 0;
    // Task #1020 — single source of truth: resolveScope produces the
    // *effective* saved-view extras (after conflict resolution) that
    // both this row pipeline AND the bucketCounts pipeline below
    // consume. The page state, the visible Scope Summary, the row
    // count, the KPI tiles, the bucket chip counts, and the ROI
    // snapshot therefore all derive from the same merged extras and
    // can never disagree about which view rules are actually in force.
    const mergedViewFilters = {
      ...resolvedPipelineScope.effectiveExtras,
      ownerScope: ownerScopeTokens.length > 0
        ? ownerScopeTokens
        : (activeViewId && viewMergeMode === "merge" ? viewFilters.ownerScope : undefined),
      bucket: bucket === "all" ? undefined : bucket,
      orgChart: orgChartForBuckets,
    };
    const result = applyCockpitFilters(
      items,
      debouncedSearch,
      mergedViewFilters,
      currentIdentity,
      Date.now(),
      diagnostics,
    );
    if (cockpitDebugEnabled && typeof performance !== "undefined") {
      const dur = performance.now() - perfStart;
      // eslint-disable-next-line no-console
      console.log(`[cockpit][perf] applyCockpitFilters over ${items.length} rows: ${dur.toFixed(2)}ms`);
      try {
        performance.mark(`cockpit-filter-end-${items.length}`);
        performance.measure(
          `cockpit:filter:${items.length}`,
          { start: perfStart, duration: dur } as PerformanceMeasureOptions,
        );
      } catch {
        /* performance.measure is best-effort; silent failure is fine. */
      }
    }
    if (cockpitDebugEnabled && diagnostics) {
      const todayIso = todayIsoInOrgTz();
      const mineCountServer = currentIdentity
        ? items.filter((it) =>
            isRowOwnedByUser(it.ownership ?? null, currentIdentity, it.owner?.id ?? null),
          ).length
        : 0;
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `[cockpit] filter pipeline — ${items.length} → ${result.length}`,
      );
      // eslint-disable-next-line no-console
      console.log("identity", currentIdentity);
      // eslint-disable-next-line no-console
      console.log("timezone", ORG_LOCAL_TIMEZONE, "today", todayIso);
      // eslint-disable-next-line no-console
      console.log("activeViewFilters", viewFilters);
      // eslint-disable-next-line no-console
      console.log("activeViewId", activeViewId);
      // eslint-disable-next-line no-console
      console.table(diagnostics.stages.map(s => ({
        stage: s.stage,
        kept: s.kept,
        dropped: s.droppedIds.length,
      })));
      for (const s of diagnostics.stages) {
        if (s.droppedIds.length === 0) continue;
        // eslint-disable-next-line no-console
        console.log(`  dropped @ ${s.stage}:`, s.droppedIds);
      }
      // eslint-disable-next-line no-console
      console.log("KPI 'mine' (server-stamped ownership over raw feed):", mineCountServer);
      // eslint-disable-next-line no-console
      console.log("Table 'mine' (after all client filters):", result.length);
      // eslint-disable-next-line no-console
      console.log("KPI strip payload:", kpis);
      // eslint-disable-next-line no-console
      console.groupEnd();
    }
    return result;
  }, [items, debouncedSearch, viewFilters, currentIdentity, cockpitDebugEnabled, activeViewId, serverKpis, ownerScopeTokens, bucket, orgChartForBuckets, resolvedPipelineScope, viewMergeMode]);

  /** Task #971 — when the 60s drift recompute escalates a row's urgency
   *  client-side (e.g. pickup window crossed the ≤12h threshold while
   *  the rep was on-screen), re-rank the displayed list so escalated
   *  rows float to the top instead of stranding behind a now-stale
   *  server sort. Only flat (non-grouped) layouts use this; grouped/
   *  swimlane layouts keep their server order so the group structure
   *  stays stable. */
  const displayedFiltered = useMemo(() => {
    // Task #971 (rework #3) — the urgency drift recompute always feeds
    // `urgencyOverrides`, which row renderers consume to update the
    // urgency badge in place every 60s regardless of sort mode. The
    // re-sort below, however, only makes sense when the rep has the
    // urgency sort selected — otherwise it would silently reorder a
    // pickup-soonest / freshness / customer / lane list out from under
    // them. Gate strictly on `sort === "urgency"`.
    if (sort !== "urgency" || urgencyOverrides.size === 0) return filtered;
    return filtered
      .map((it, originalIndex) => ({
        it,
        originalIndex,
        score: urgencyOverrides.get(it.opportunity.id)?.score ?? it.urgency.score,
      }))
      .sort((a, b) => (b.score - a.score) || (a.originalIndex - b.originalIndex))
      .map((x) => x.it);
  }, [filtered, urgencyOverrides, sort]);

  // Task #957 — bucket chip counts derived from the SAME filtered-without-
  // bucket collection so the chip count is exactly how many rows the rep
  // would see if they selected that chip. We compute counts off the
  // pre-bucket pipeline (re-running applyCockpitFilters with bucket=all)
  // to guarantee the "All" chip count == filtered.length when no bucket
  // is selected, AND every other chip count is what the rep would see
  // after clicking it.
  // Task #957 — bucket evaluation context (todayIso + team set) is shared
  // between bucket chip counts and the new client-derived KPIs so they can
  // never disagree.
  const bucketEvalCtx = useMemo<BucketEvalContext>(() => {
    const todayIso = todayIsoInOrgTz();
    return {
      todayIso,
      currentUserId: currentIdentity?.id ?? null,
      myTeamUserIds: currentIdentity?.id
        ? new Set(
            [currentIdentity.id].concat(
              orgChartForBuckets
                .filter((u) => u.managerId === currentIdentity.id)
                .map((u) => u.id),
            ),
          )
        : null,
    };
  }, [currentIdentity, orgChartForBuckets]);

  const bucketCounts = useMemo(() => {
    // Task #1020 — pre-bucket pipeline reads the SAME effectiveExtras
    // produced by resolveScope above. This means a view extra that the
    // conflict resolver dropped for the row pipeline is *also* dropped
    // here, so the bucket chip counts can never disagree with the
    // row count or the KPI tiles about which view rules are in force.
    const preBucket = applyCockpitFilters(
      items,
      debouncedSearch,
      {
        ...resolvedPipelineScope.effectiveExtras,
        ownerScope: ownerScopeTokens.length > 0
          ? ownerScopeTokens
          : (activeViewId && viewMergeMode === "merge" ? viewFilters.ownerScope : undefined),
        bucket: undefined,
        orgChart: orgChartForBuckets,
      },
      currentIdentity,
      Date.now(),
    );
    return countBuckets(preBucket, bucketEvalCtx);
  }, [items, debouncedSearch, viewFilters, currentIdentity, ownerScopeTokens, orgChartForBuckets, bucketEvalCtx, activeViewId, viewMergeMode, resolvedPipelineScope]);

  // Task #957 follow-up — KPI tiles derive from the SAME `filtered`
  // collection that drives visible rows. `hiddenStale` is a server-only
  // signal (it counts feed-level past-pickup hidden rows) so we merge it
  // on top. See `kpisFromFiltered` in shared/cockpitBuckets.ts for the
  // contract; every predicate is shared with `bucketsForRow` so chip
  // counts and KPI tiles can never diverge.
  const kpis = useMemo(() => {
    const derived = kpisFromFiltered(filtered, bucketEvalCtx);
    return {
      ...derived,
      hiddenStale: serverKpis?.hiddenStale ?? 0,
    };
  }, [filtered, bucketEvalCtx, serverKpis?.hiddenStale]);

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
    // Task #971 — flat ("none") layout uses displayedFiltered so the
    // 60s urgency-drift re-rank surfaces escalated rows. Grouped
    // layouts keep the original filtered order to preserve group
    // membership stability.
    if (grouping === "none") return [{ key: "all", label: "All", items: displayedFiltered }];
    const m = new Map<string, CockpitItem[]>();
    filtered.forEach(it => {
      const k = it.groupKey;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(it);
    });
    return Array.from(m.entries()).map(([k, v]) => ({ key: k, label: k, items: v }));
  }, [filtered, displayedFiltered, grouping]);

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
      // Task #1022 — Enter fires the focused row's primary "next best
      // action" instead of always navigating to detail, so the keyboard
      // path matches the visible primary button. Shift+Enter falls back
      // to the original "open detail" behavior for reps who want it.
      const it = filtered[focusIndex];
      if (!it) return;
      e.preventDefault();
      if (e.shiftKey) {
        navigate(`/available-freight/${it.opportunity.id}`);
        return;
      }
      const input: RowActionInput = {
        opportunity: {
          status: it.opportunity.status ?? null,
          pickupWindowStart: it.opportunity.pickupWindowStart ?? null,
          coveredAt: (it.opportunity as { coveredAt?: string | null }).coveredAt ?? null,
          generatedAt: it.opportunity.generatedAt ?? null,
        },
        coverage: it.coverage,
        freshnessMinutes: it.freshnessMinutes,
        rankedCarrierCount: it.chips.length,
        ownership: it.ownership ?? null,
        owner: it.owner ?? null,
        pickupFreshness: it.pickupFreshness ?? null,
        pickupDaysAgo: it.pickupDaysAgo ?? null,
      };
      const action = resolveNextBestAction(input);
      if (action.disabled) return;
      switch (action.id) {
        case "approve":
          bulkMutate.mutate({ action: "approve", opportunityIds: [it.opportunity.id] });
          return;
        case "send_top":
        case "escalate":
          bulkMutate.mutate({ action: "send_top", opportunityIds: [it.opportunity.id], ...(action.payload ?? {}) });
          return;
        case "mark_covered":
          markCoveredSingle(it);
          return;
        case "pick_carriers":
        case "open_detail":
        case "confirm_covered":
        default:
          navigate(`/available-freight/${it.opportunity.id}`);
          return;
      }
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

  // Task #871 — bind shared keys (L for cockpit, w/c/n for cross-surface
  // jumps). The shared hook only fires for handlers we register, so AF's
  // existing j/k/Enter/?/x/a/s/r path above still owns those keys.
  // Task #888 — `openCockpitForItem` is the row-keyed entry point used by
  // both the keyboard shortcut (focused row) and the per-row "Open in
  // Cockpit" overflow-menu item, so they always pin the overlay to the
  // same lane signature contract.
  const openCockpitForItem = useCallback((it: CockpitItem) => {
    const o = it.opportunity;
    const sig = [
      (o.origin ?? "").trim().toLowerCase(),
      (o.originState ?? "").trim().toLowerCase(),
      (o.destination ?? "").trim().toLowerCase(),
      (o.destinationState ?? "").trim().toLowerCase(),
      (o.equipmentType ?? "").trim().toLowerCase(),
    ].join("|");
    setCockpitSignature(sig);
    setCockpitLaneLabel(
      `${o.origin}${o.originState ? `, ${o.originState}` : ""} → ${o.destination}${o.destinationState ? `, ${o.destinationState}` : ""}`,
    );
    setCockpitOpen(true);
  }, []);
  const openCockpitForFocused = useCallback(() => {
    const it = filtered[focusIndex];
    if (!it) return;
    openCockpitForItem(it);
  }, [filtered, focusIndex, openCockpitForItem]);

  // Task #1022 — Single-row "mark covered" entry point. Seeds the bulk
  // cover dialog's selection with just this row so the existing dialog
  // (with its top-carrier prefill, bench-promotion + rate-band toggles)
  // can be reused without forking a per-row form. The dialog's prefill
  // useEffect keys off `bulkCoverOpen`, so opening here picks up the
  // single-row top carrier automatically.
  const markCoveredSingle = useCallback((it: CockpitItem) => {
    setSelected(new Set([it.opportunity.id]));
    setBulkCoverCarrier("");
    setBulkCoverPaidRate("");
    setBulkCoverCustomerRate("");
    setBulkCoverNotes("");
    setBulkCoverOpen(true);
  }, []);

  useSharedLaneKeyboard({
    enabled: !showShortcutsHelp && !cockpitOpen,
    handlers: {
      openCockpit: openCockpitForFocused,
      swapSurface: () => {
        const it = filtered[focusIndex];
        if (!it) return navigate("/lanes/work-queue?from=available-freight");
        const ctxId = it.lwqContext?.laneId;
        navigate(
          ctxId
            ? `/lanes/work-queue?laneId=${encodeURIComponent(ctxId)}&from=available-freight`
            : `/lanes/work-queue?from=available-freight`,
        );
      },
      openContacts: () => {
        const it = filtered[focusIndex];
        if (it) navigate(`/available-freight/${it.opportunity.id}#contacts`);
      },
      openNote: () => {
        const it = filtered[focusIndex];
        if (it) navigate(`/available-freight/${it.opportunity.id}#notes`);
      },
    },
  });

  // Cheat-sheet rows sourced from the same registry that fires the keys.
  const sharedCheatRows = useLaneCheatSheetRows({ surface: "af" });

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
      <CrossTabBreadcrumb current="available-freight" />
      {/* Header + upload */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="heading-available-freight">
              <Truck className="h-6 w-6" /> Available Freight Cockpit
            </h1>
            <FreshnessPill signal={feed?.freshness} />
            {/* Task #967 — shared live-sync health pill. */}
            <LiveSyncPill testId="pill-live-sync-af" />
            {/* Task #1021 — AF import health pill demoted to the tertiary
                right-aligned cluster on the freshness row below so it
                stops competing with the page title. */}
          </div>
          <p className="text-sm text-muted-foreground">
            Triage open freight in priority order. Shortcuts: j/k move • x select • Enter run primary action • Shift+Enter open detail • A approve • S send top 3 • R reassign • Esc clear.
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
          {/* Task #1023 — Auto-pilot preview was a header button competing
              with primary triage actions. It now lives inside Ops mode
              alongside the import-health surfaces. Action mode shows a
              small status pill (below the mode switcher) that links to
              Ops mode so reps can still reach it in one click.
              Task #1024 — the prominent "Leak Console" header button is
              gone too. The Leak count now appears as a small signal pill
              in the AfOpsSignalsBar below the mode switcher. */}
        </div>
      </div>
      <AutoPilotPreviewDrawer
        open={autoPilotDrawerOpen}
        onOpenChange={setAutoPilotDrawerOpen}
      />

      {/* Task #1023 — Segmented mode switcher. Three named modes:
          Action (default triage cockpit), Coverage (in-flight outreach
          funnel), Ops & health (import health / auto-pilot / hidden
          loads). Mode is persisted per-user (localStorage) and
          reflected in the URL (`?mode=`) so a rep can deep-link to a
          specific mode. Switching modes never changes the underlying
          scope — the Scope Summary below remains the source of truth. */}
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="bar-af-modes"
        role="tablist"
        aria-label="Available Freight mode"
      >
        <div
          className="inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5"
          data-testid="segmented-af-mode"
        >
          {AVAILABLE_FREIGHT_MODES.map((m) => {
            const meta = AVAILABLE_FREIGHT_MODE_META[m];
            const active = mode === m;
            return (
              <Button
                key={m}
                size="sm"
                variant={active ? "default" : "ghost"}
                className="h-7 px-3 text-xs"
                onClick={() => setMode(m)}
                role="tab"
                aria-selected={active}
                data-testid={meta.testId}
                data-mode={m}
                data-mode-active={active}
                title={meta.description}
              >
                {meta.label}
              </Button>
            );
          })}
        </div>
        <span
          className="text-xs text-muted-foreground"
          data-testid="text-af-mode-description"
        >
          {AVAILABLE_FREIGHT_MODE_META[mode].description}
        </span>
        {mode !== "ops" && (
          // Task #1024 — Action / Coverage modes show ONLY signals + links
          // to ops surfaces. The AfOpsSignalsBar bundles Health, Hidden N,
          // Auto-pilot status, and the manager-only Leak count as small
          // same-weight pills that each link to their dedicated ops home.
          <div className="ml-auto">
            <AfOpsSignalsBar
              hiddenCount={Math.max(
                0,
                (feed?.hiddenCounts?.totalInScope ?? items.length) - filtered.length,
              )}
              opsModeHref={(() => {
                const params = new URLSearchParams();
                params.set("mode", "ops");
                if (carrierIdFilter) params.set("carrierId", carrierIdFilter);
                if (laneFilter) params.set("lane", laneFilter);
                return `/available-freight?${params.toString()}`;
              })()}
              isManagerScope={isManagerScope}
            />
          </div>
        )}
      </div>

      {/* Cross-tab UX (option B) — banner shown when arriving from Carrier Hub
          via `?carrierId=<id>`. Explains the filter and offers a one-click
          dismiss back to the unfiltered cockpit. */}
      {carrierIdFilter && (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm"
          data-testid="banner-carrier-filter"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Truck className="h-4 w-4 shrink-0 text-blue-400" />
            <span className="truncate">
              Filtered to loads{" "}
              <span className="font-semibold" data-testid="text-carrier-filter-name">
                {carrierFilterMeta?.carrier?.name ?? "this carrier"}
              </span>{" "}
              could cover (claimed lanes + history)
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={clearCarrierFilter}
            data-testid="button-clear-carrier-filter"
          >
            <X className="h-3.5 w-3.5 mr-1" /> Clear
          </Button>
        </div>
      )}

      {/* Task #1020 — the amber "saved view is layering over your current
          selection" banner is gone. Saved views are now explicit replace-
          vs-merge (see toggle next to the saved-view tab strip) and every
          active clause is rendered as a removable chip in the ScopeSummary
          above the row list, so silent layering is impossible. */}

      {/* Task #1021 — Compact KPI strip. Trimmed from 7 tiles + stale
          chip to the 4 action-oriented metrics reps actually triage from
          (Ready to send, At-risk ≤24h, Covered today, Total visible).
          The demoted tiles (Generated today, Sent / awaiting carrier,
          Stale) live behind the "Advanced" disclosure below so the page
          opens with one obvious set of numbers to act on. */}
      {/* Task #1023 — KPI strip adapts to the active mode. Action keeps
          the triage tiles (Ready / At-risk / Covered today / Total);
          Coverage emphasizes the response funnel (Sent / awaiting,
          Responded, Covered today, Total); Ops emphasizes import
          freshness (Last import age, Generated today, Stale hidden,
          Total in scope). The same `kpis`/`feed` objects feed every
          mode so switching never silently changes the numbers. */}
      {mode === "action" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="strip-kpi-primary" data-mode="action">
          <KpiTile label="Ready to send" value={kpis?.readyToSend ?? 0} tone="ready" testId="kpi-ready" />
          <KpiTile label="At-risk pickup ≤24h" value={kpis?.atRiskPickup24h ?? 0} tone="critical" testId="kpi-at-risk-24h" />
          <KpiTile label="Covered today" value={kpis?.coveredToday ?? 0} tone="ok" testId="kpi-covered-today" />
          <KpiTile
            label="Total visible"
            value={kpis?.total ?? 0}
            testId="kpi-total"
            subtitle={
              typeof serverKpis?.total === "number" && serverKpis.total !== (kpis?.total ?? 0)
                ? `Queue total: ${serverKpis.total}`
                : undefined
            }
          />
        </div>
      )}
      {mode === "coverage" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="strip-kpi-coverage" data-mode="coverage">
          <KpiTile label="Sent / awaiting carrier" value={kpis?.sentAwaitingCarrier ?? 0} tone="info" testId="kpi-coverage-sent-awaiting" />
          <KpiTile label="With at least one reply" value={roi.replyRows} tone="info" testId="kpi-coverage-replied" />
          <KpiTile label="Covered today" value={kpis?.coveredToday ?? 0} tone="ok" testId="kpi-coverage-covered-today" />
          <KpiTile
            label="Total visible"
            value={kpis?.total ?? 0}
            testId="kpi-coverage-total"
            subtitle={`${roi.coverageRate}% covered · ${roi.replyRate}% reply rate`}
          />
        </div>
      )}
      {mode === "ops" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="strip-kpi-ops" data-mode="ops">
          <KpiTile
            label="Last import"
            value={feed?.lastImport ? fmtAge(feed.lastImport.ageMinutes) : "—"}
            testId="kpi-ops-last-import"
            subtitle={feed?.nextImport ? `next in ${fmtAge(feed.nextImport.inMinutes)}` : undefined}
          />
          <KpiTile label="Generated today" value={kpis?.generatedToday ?? 0} testId="kpi-ops-generated-today" />
          <KpiTile
            label="Stale (hidden)"
            value={kpis?.hiddenStale ?? 0}
            tone={(kpis?.hiddenStale ?? 0) > 0 ? "critical" : undefined}
            testId="kpi-ops-stale"
          />
          <KpiTile label="Total in scope" value={feed?.hiddenCounts?.totalInScope ?? items.length} testId="kpi-ops-total-in-scope" />
        </div>
      )}

      {/* Task #1021 — Advanced disclosure + tertiary right-aligned health
          cluster. Hides the demoted KPI tiles (Generated today, Sent /
          awaiting, Stale) so a new rep isn't confronted with 8 numbers
          on first paint. The right-side cluster demotes the AF import
          health pill out of the page title. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="flex-1 min-w-0"
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              data-testid="button-toggle-advanced"
              aria-expanded={advancedOpen}
            >
              <SlidersHorizontal className="h-3 w-3 mr-1" />
              Advanced
              <ChevronDown
                className={`h-3 w-3 ml-1 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2" data-testid="panel-advanced-kpis">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2" data-testid="strip-kpi-advanced">
              <KpiTile
                label="Generated today"
                value={kpis?.generatedToday ?? 0}
                testId="kpi-generated-today"
              />
              <KpiTile
                label="Sent / awaiting carrier"
                value={kpis?.sentAwaitingCarrier ?? 0}
                tone="info"
                testId="kpi-sent-awaiting"
              />
              {/* Task #900 — Stale tile + reveal-stale recovery affordance.
                  Click → switches scope to 'all'. Always rendered (greyed
                  when zero) so position is stable for screen readers. */}
              <button
                type="button"
                onClick={() => {
                  if ((kpis?.hiddenStale ?? 0) > 0) setPickupScope("all");
                }}
                className={`text-left rounded-md border px-3 py-2 transition-colors ${
                  (kpis?.hiddenStale ?? 0) > 0
                    ? "border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/15 cursor-pointer"
                    : "border-border bg-background opacity-60 cursor-default"
                }`}
                data-testid="button-reveal-stale"
                aria-label={
                  (kpis?.hiddenStale ?? 0) > 0
                    ? `Reveal ${kpis?.hiddenStale} stale past-pickup rows`
                    : "No stale past-pickup rows"
                }
                title={
                  (kpis?.hiddenStale ?? 0) > 0
                    ? "Past-pickup rows the 'actionable' rule has hidden. Click to switch scope to 'All' and review them."
                    : "No past-pickup rows are currently hidden by the actionable rule."
                }
                disabled={(kpis?.hiddenStale ?? 0) === 0}
              >
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Stale</div>
                <div className="text-lg font-semibold" data-testid="chip-stale-count">
                  {kpis?.hiddenStale ?? 0}
                </div>
              </button>
            </div>
          </CollapsibleContent>
        </Collapsible>
        {/* Task #1023 — In Action / Coverage modes the import-health
            pill is replaced by the small "Ops & health" link in the
            mode bar above. The full pill, hidden-loads detail, dedupe
            audit, and auto-pilot preview live inside Ops mode below. */}
        {mode === "ops" && (
          <div
            className="flex items-center gap-2 ml-auto"
            data-testid="cluster-tertiary-health"
          >
            <AfImportHealthPill testId="pill-af-import-health" />
          </div>
        )}
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
            {/* Task #1020 — explicit replace-vs-merge toggle for the
                active saved view. "Replace" (default) mirrors the view's
                scalar fields into page state and drops its extras;
                "Merge" layers the view's extras on top of page state and
                surfaces them as visible clauses in the ScopeSummary. */}
            {activeView && (
              <div
                className="ml-2 inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5"
                data-testid="toggle-view-mode"
                aria-label="Saved view mode"
              >
                <Button
                  size="sm"
                  variant={viewMergeMode === "replace" ? "default" : "ghost"}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setViewMergeMode("replace")}
                  data-testid="button-view-mode-replace"
                  aria-pressed={viewMergeMode === "replace"}
                >
                  Replace
                </Button>
                <Button
                  size="sm"
                  variant={viewMergeMode === "merge" ? "default" : "ghost"}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setViewMergeMode("merge")}
                  data-testid="button-view-mode-merge"
                  aria-pressed={viewMergeMode === "merge"}
                >
                  Merge
                </Button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {/* Phase A4 — anchor the dot to the multi-producer overall signal so
                this pulse and the header pill never disagree. The text below
                still reflects the legacy "last import" (Excel batch) for back-
                compat with the existing nextImport label. */}
            <span
              className={`inline-block h-2 w-2 rounded-full ${freshnessDotTone(feed?.freshness?.overall.healthState ?? "red")}`}
              data-testid="indicator-freshness-pulse"
              data-freshness-state={feed?.freshness?.overall.healthState ?? "red"}
            />
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
            {/* Task #971 — Hidden-vs-deduped split. Renders the existing
                "Hidden by filters" rollup AND a separate top-level group
                for the importer's run-level dedupe audit so reps can see
                both signals at a glance. AF passes both groups; LWQ /
                Quotes / Conversations continue to use the single-group
                rendering of the same component.
                Task #1024 — only mounted in Ops mode now. Action /
                Coverage modes get a tiny link-out "Hidden N" pill in the
                AfOpsSignalsBar above the saved-view tab strip; the full
                disclosure stays in Ops where the dedicated Hidden loads
                & dedupe panel lives. */}
            {mode === "ops" && feed && (() => {
              const h = feed.hiddenCounts;
              const totalInScope = h?.totalInScope ?? items.length;
              const visible = filtered.length;
              const buckets: HiddenCountsSummary["buckets"] = h
                ? [
                    { id: "status", label: "Hidden by status filter", count: h.byStatus },
                    { id: "snooze", label: "Snoozed", count: h.bySnooze },
                    { id: "past-pickup", label: "Past pickup (recent)", count: Math.max(0, (h.byPastPickup ?? 0) - (h.byPastStale ?? 0)) },
                    { id: "stale-pickup", label: `Stale pickup (>${feed.pickupGraceDays ?? 14}d)`, count: h.byPastStale ?? 0 },
                    { id: "lane", label: "Hidden by lane filter", count: h.byLane },
                    { id: "carrier", label: "Hidden by carrier filter", count: h.byCarrier },
                    { id: "unresolved-customer", label: "AM book — unresolved customer", count: h.byUnresolvedCustomer ?? 0 },
                  ]
                : [];
              const dedupe = feed.dedupeCounts;
              const dedupeGroup = dedupe
                ? {
                    label: "Hidden by dedupe — last import",
                    subtitle: dedupe.lastImportAt
                      ? `${fmtAge(Math.round((Date.now() - new Date(dedupe.lastImportAt).getTime()) / 60_000))} ago · ${dedupe.inserted} new`
                      : undefined,
                    buckets: [
                      { id: "collapsed-order-key", label: "Collapsed by order key", count: dedupe.collapsedByOrderKey },
                      { id: "unmatched-customers", label: "Unmatched customers", count: dedupe.unmatchedCustomers },
                      { id: "expired", label: "Expired (already past pickup)", count: dedupe.expired },
                    ],
                    mergedRows: dedupe.mergedRows,
                  }
                : null;
              const summary: HiddenCountsSummary = { totalInScope, visible, buckets, dedupeGroup };
              return (
                <span className="ml-1">
                  <HiddenCountsDisclosure summary={summary} surface="af" />
                </span>
              );
            })()}
          </div>
        </CardContent>
      </Card>

      {/* Task #926 — embedded Copilot recommendations scoped to the active filters. */}
      {laneFilter && (
        <EmbeddedPlayCard scope={{ laneKey: laneFilter }} dataTestIdPrefix="af-embedded-plays-lane" />
      )}
      {companyFilter !== "all" && (
        <EmbeddedPlayCard scope={{ customerId: companyFilter }} dataTestIdPrefix="af-embedded-plays-customer" />
      )}

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
            onClick={clearLaneFilter}
            data-testid="button-clear-lane-filter"
          >
            <X className="h-3 w-3 mr-1" /> Clear lane filter
          </Button>
        </div>
      )}

      {/* Filters & view controls — Task #957 sticky so the filter bar stays
          visible while the rep scrolls a long queue. */}
      <Card className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80" data-testid="card-filter-bar-sticky">
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
            {/* Task #957 — Owner combobox (multi-select). Tokens accepted:
                "me", "my-team", "unassigned", "team:<id>", and arbitrary
                userIds. Empty selection == "all" (server-side fast path). */}
            <OwnerCombobox
              tokens={ownerScopeTokens}
              users={users}
              teams={listCockpitTeams()}
              ownerLabel={ownerLabel}
              onChange={(next) => setOwnerFilter(next)}
              dataTestId="combobox-filter-owner"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="select-filter-status"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active queue</SelectItem>
                <SelectItem value="pending_approval">Pending approval</SelectItem>
                <SelectItem value="ready_to_send">Ready</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="awaiting_carrier_reply">Awaiting carrier</SelectItem>
                <SelectItem value="partially_covered">Partial</SelectItem>
                <SelectItem value="covered">Covered</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            {/* Task #1021 — Sort / Grouping / Layout selects moved into
                the Advanced disclosure below so the primary filter row
                only shows the controls reps tune day-to-day (search,
                customer, owner, status, pickup scope). The selects keep
                their original test-ids and behavior. */}
            {/* Phase B1 / Task #900 — pickup scope. 'actionable' (default)
                shows upcoming + today + past-pickup ≤24h-overdue still-open
                rows. 'recent' restores the legacy 14-day grace view;
                'upcoming' is strict; 'all' never hides on pickup date. */}
            <Select
              value={pickupScope}
              onValueChange={(v) => setPickupScope(v as "upcoming" | "recent" | "all" | "actionable")}
            >
              <SelectTrigger data-testid="select-pickup-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="actionable">Pickup: actionable (default)</SelectItem>
                <SelectItem value="recent">Pickup: recent + upcoming</SelectItem>
                <SelectItem value="upcoming">Pickup: upcoming only</SelectItem>
                <SelectItem value="all">Pickup: all dates</SelectItem>
              </SelectContent>
            </Select>
            <Badge
              variant="outline"
              className="h-7 px-2 text-[11px] font-normal"
              data-testid="pill-pickup-scope"
              title={
                pickupScope === "actionable"
                  ? "Showing upcoming + today + past-pickup loads ≤24h overdue while still in an actionable status."
                  : pickupScope === "recent"
                    ? `Showing upcoming loads plus past-pickup loads still open in their status (within ${feed?.pickupGraceDays ?? 14} days).`
                    : pickupScope === "upcoming"
                      ? "Strict view — only loads with a future pickup date are shown."
                      : "Showing every pickup date, including stale ones."
              }
            >
              {pickupScope === "actionable"
                ? "Actionable (≤24h overdue)"
                : pickupScope === "recent"
                  ? `Recent + upcoming (${feed?.pickupGraceDays ?? 14}d grace)`
                  : pickupScope === "upcoming"
                    ? "Upcoming only"
                    : "All pickup dates"}
            </Badge>
          </div>
          {/* Task #1021 — Advanced selects. Sort / Grouping / Layout
              live behind the same `advancedOpen` toggle as the demoted
              KPI tiles up top so opening either reveals every power-user
              control at once. Closed by default so the sticky filter
              bar stays compact for a new rep. */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleContent
              className="pt-2"
              data-testid="panel-advanced-filters"
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
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
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {/* Task #957 — Queue bucket chip strip. Drives the same filtered
          collection that powers KPIs / rows / ROI from a single source. */}
      <BucketChipStrip
        selected={bucket}
        counts={bucketCounts}
        onSelect={setBucket}
        mode={mode}
      />

      {/* Task #1020 — Scope Summary. The single visible source of truth
          for what the queue is filtered to. Every clause is removable;
          saved-view extras render with provenance; conflicts render an
          inline resolver. KPIs / bucket counts / ROI / visible rows all
          derive from the same post-filter collection (see `filtered`),
          so this summary is always faithful to what the rep sees. */}
      {(() => {
        const customer = companyFilter !== "all"
          ? customersForFilter.find((x) => x.id === companyFilter)
          : null;
        const ownerLabels: Record<string, string> = {};
        for (const tok of ownerScopeTokens) {
          const lower = tok.toLowerCase();
          if (lower === "me") ownerLabels[tok] = "me";
          else if (lower === "my-team" || lower === "myteam") ownerLabels[tok] = "my team";
          else if (lower === "unassigned") ownerLabels[tok] = "unassigned";
          else if (lower === "am_book") ownerLabels[tok] = "my AM book";
          else if (lower.startsWith("team:")) {
            const team = listCockpitTeams().find((t) => t.id === tok.slice("team:".length));
            ownerLabels[tok] = team ? team.name : tok.slice("team:".length);
          } else {
            const u = users.find((x) => x.id === tok);
            if (u) ownerLabels[tok] = ownerLabel(u);
          }
        }
        const carrierName = carrierIdFilter ? (carrierFilterMeta?.carrier?.name ?? null) : null;
        const scopeInput: ScopeInput = {
          search: debouncedSearch,
          companyId: companyFilter,
          ownerTokens: ownerScopeTokens,
          ownerLabels,
          statusFilter,
          bucket,
          pickupScope,
          laneFilter,
          carrierIdFilter,
          carrierName,
          customerName: customer?.name ?? null,
          view: activeView ? {
            id: activeView.id,
            name: activeView.name,
            mergeMode: viewMergeMode,
            extras: viewFilters,
          } : null,
        };
        const resolved = resolveScope(scopeInput);
        const sentence = summarizeScope(resolved);
        const onClearClause = (key: string) => {
          if (key === "search") setSearch("");
          else if (key === "customer") setCompanyFilter("all");
          else if (key.startsWith("owner:")) {
            const tok = key.slice("owner:".length);
            setOwnerFilter(ownerScopeTokens.filter((x) => x !== tok));
          } else if (key === "status") setStatusFilter("active");
          else if (key === "bucket") setBucket("all");
          else if (key === "lane") clearLaneFilter();
          else if (key === "carrier") clearCarrierFilter();
          else if (key === "pickupScope") setPickupScope("actionable");
          else if (key.startsWith("view:")) {
            deactivateViewOnly();
          }
        };
        return (
          <div
            className="rounded-md border bg-muted/20 px-3 py-2 space-y-2"
            data-testid="card-scope-summary"
          >
            <div
              className="text-xs text-foreground"
              data-testid="text-scope-summary"
            >
              {sentence}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {resolved.clauses.map((c) => (
                <Badge
                  key={c.key}
                  variant={c.source === "view" ? "outline" : "secondary"}
                  className="gap-1 pr-1"
                  data-testid={`scope-clause-${c.key.replace(/[^a-z0-9]/gi, "_")}`}
                  data-clause-source={c.source}
                  data-clause-dimension={c.dimension}
                  title={c.source === "view" && c.viewName ? `From saved view: ${c.viewName}` : undefined}
                >
                  <span className="text-xs">{c.label}</span>
                  {c.clearable && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-4 w-4 p-0 hover:bg-transparent"
                      onClick={() => onClearClause(c.key)}
                      data-testid={`scope-clause-${c.key.replace(/[^a-z0-9]/gi, "_")}-clear`}
                      aria-label={`Clear ${c.label}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </Badge>
              ))}
              {!resolved.isDefault && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => {
                    setSearch("");
                    setCompanyFilter("all");
                    setOwnerFilter("all");
                    setStatusFilter("active");
                    setBucket("all");
                    setPickupScope("actionable");
                    if (laneFilter) clearLaneFilter();
                    if (carrierIdFilter) clearCarrierFilter();
                    clearActiveView();
                    setViewMergeMode("replace");
                  }}
                  data-testid="button-reset-operational-default"
                >
                  Reset to operational default
                </Button>
              )}
            </div>
            {resolved.conflicts.length > 0 && (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs"
                data-testid="scope-conflicts"
              >
                {resolved.conflicts.map((conflict) => (
                  <div
                    key={conflict.key}
                    className="flex flex-wrap items-center gap-2"
                    data-testid={`scope-conflict-${conflict.key}`}
                  >
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <span className="flex-1 min-w-0">{conflict.message}</span>
                    <span
                      className="text-[10px] uppercase tracking-wide text-muted-foreground"
                      data-testid={`scope-conflict-${conflict.key}-resolution`}
                    >
                      Resolved: {conflict.resolution === "page-wins" ? "view rule dropped" : "page filter dropped"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => setBucket("all")}
                      data-testid={`scope-conflict-${conflict.key}-clear-bucket`}
                    >
                      Clear bucket
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={deactivateViewOnly}
                      data-testid={`scope-conflict-${conflict.key}-clear-view`}
                    >
                      Drop view
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

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

      {/* Task #1023 — Main grid (row list + ROI side-rail) is the
          shared body for Action and Coverage modes. Ops mode renders
          its own surface below in place of the grid; the bucket strip,
          scope summary, and bulk-action bar above remain shared so
          switching modes never silently changes the underlying scope. */}
      {mode !== "ops" && (
      <>
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
              (() => {
                // Phase A3 — explained empty state. Show every non-zero
                // hidden bucket so the rep knows whether the queue is
                // genuinely empty or just filtered down to nothing, and
                // give them a one-click escape hatch for the filters they
                // can clear from this page.
                const h = feed?.hiddenCounts ?? null;
                const hiddenByClient = Math.max(0, items.length - filtered.length);
                const hasSearch = search.trim().length > 0;
                const ownerScopeActive = viewFilters.ownerScope === "mine"
                  || viewFilters.ownerScope === "team";
                const hiddenBuckets: Array<{
                  key: string;
                  count: number;
                  label: string;
                  detail?: string;
                  action?: { label: string; onClick: () => void; testId: string };
                  informational?: boolean;
                }> = [];
                if (h) {
                  if (
                    h.byStatus > 0
                    && statusFilter !== "all"
                    && statusFilter !== "active"
                  ) {
                    hiddenBuckets.push({
                      key: "status",
                      count: h.byStatus,
                      label: "outside the current status filter",
                      action: {
                        label: "Show active queue",
                        onClick: () => setStatusFilter("active"),
                        testId: "button-clear-status-filter",
                      },
                    });
                  }
                  // Phase B1 — split the old byPastPickup chip:
                  //  • byPastStale → "stale (>graceDays)" with one-click
                  //    "switch to scope=all" so the rep can still review.
                  //  • byPastPickup (post-B1 = strict-only count when scope
                  //    is 'upcoming') → keeps the legacy informational chip.
                  const stale = h.byPastStale ?? 0;
                  const grace = feed?.pickupGraceDays ?? 14;
                  if (stale > 0) {
                    hiddenBuckets.push({
                      key: "stale-pickup",
                      count: stale,
                      label: `stale pickup (>${grace}d)`,
                      detail: "Past their pickup date by more than the freshness window. Status is still open — consider closing if no longer actionable.",
                      action: pickupScope === "all"
                        ? undefined
                        : {
                            label: "Show all pickup dates",
                            onClick: () => setPickupScope("all"),
                            testId: "chip-stale-pickup",
                          },
                    });
                  }
                  if (
                    pickupScope === "upcoming"
                    && h.byPastPickup > 0
                    && h.byPastPickup !== stale
                  ) {
                    hiddenBuckets.push({
                      key: "past-pickup",
                      count: h.byPastPickup - stale,
                      label: "past their pickup date but still open",
                      detail: "Switch to Recent + upcoming to bring these back into the queue.",
                      action: {
                        label: "Switch to Recent + upcoming",
                        onClick: () => setPickupScope("recent"),
                        testId: "chip-past-pickup-recent",
                      },
                    });
                  }
                  if (h.bySnooze > 0) {
                    hiddenBuckets.push({
                      key: "snooze",
                      count: h.bySnooze,
                      label: "snoozed until later",
                      detail: "Reachable from the all-opportunities list when the snooze ends.",
                      informational: true,
                    });
                  }
                  if (h.byLane > 0) {
                    hiddenBuckets.push({
                      key: "lane",
                      count: h.byLane,
                      label: "outside the lane you deep-linked from",
                      action: {
                        label: "Clear lane filter",
                        onClick: clearLaneFilter,
                        testId: "button-empty-clear-lane",
                      },
                    });
                  }
                  if (h.byCarrier > 0) {
                    hiddenBuckets.push({
                      key: "carrier",
                      count: h.byCarrier,
                      label: "the linked carrier could not cover",
                      action: {
                        label: "Clear carrier filter",
                        onClick: clearCarrierFilter,
                        testId: "button-empty-clear-carrier",
                      },
                    });
                  }
                }
                if (hiddenByClient > 0) {
                  const reasons: string[] = [];
                  if (hasSearch) reasons.push("your search");
                  if (ownerScopeActive) {
                    reasons.push(viewFilters.ownerScope === "mine" ? "the “Mine only” view" : "the “Team only” view");
                  }
                  const reasonText = reasons.length > 0
                    ? reasons.join(" and ")
                    : "the saved view filters";
                  hiddenBuckets.push({
                    key: "local",
                    count: hiddenByClient,
                    label: `hidden by ${reasonText}`,
                    action: hasSearch
                      ? {
                          label: "Clear search",
                          onClick: () => setSearch(""),
                          testId: "button-empty-clear-search",
                        }
                      : ownerScopeActive
                        ? {
                            label: "Switch to default view",
                            onClick: clearActiveView,
                            testId: "button-empty-clear-view",
                          }
                        : undefined,
                  });
                }
                const totalInScope = h?.totalInScope ?? null;
                const fmtCount = (n: number) => `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;
                return (
                  <div
                    className="flex flex-col items-center justify-center gap-4 py-12 text-center"
                    data-testid="state-empty"
                  >
                    <Inbox className="h-10 w-10 text-muted-foreground" />
                    <div className="space-y-1 max-w-md">
                      <p className="text-sm font-medium" data-testid="text-empty-headline">
                        No freight matches your current filters.
                      </p>
                      {totalInScope !== null && (
                        <p className="text-xs text-muted-foreground" data-testid="text-empty-subtitle">
                          {totalInScope === 0
                            ? "There is no freight in your scope right now. New rows will appear here as the autopilot generates them."
                            : `You have ${fmtCount(totalInScope)} in this scope, but everything is filtered out by the criteria below.`}
                        </p>
                      )}
                    </div>
                    {/* Task #957 — Reset to operational default escape
                        hatch on the diagnostic empty state. Clears every
                        page-local filter that could be hiding rows so the
                        rep can return to the default cockpit in one click. */}
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => {
                        setSearch("");
                        setCompanyFilter("all");
                        setOwnerFilter("all");
                        setStatusFilter("active");
                        setBucket("all");
                        setPickupScope("actionable");
                        if (laneFilter) clearLaneFilter();
                        if (carrierIdFilter) clearCarrierFilter();
                        clearActiveView();
                      }}
                      data-testid="button-empty-reset-operational-default"
                    >
                      Reset to operational default
                    </Button>
                    {hiddenBuckets.length > 0 && (
                      <div
                        className="w-full max-w-xl rounded-md border bg-muted/20 px-3 py-2 text-left text-xs"
                        data-testid="panel-hidden-counts"
                      >
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Hidden by your filters
                        </div>
                        <ul className="space-y-1.5">
                          {hiddenBuckets.map(b => (
                            <li
                              key={b.key}
                              className="flex flex-wrap items-center gap-x-2 gap-y-1"
                              data-testid={`row-hidden-${b.key}`}
                            >
                              <Badge
                                variant="secondary"
                                className="font-mono"
                                data-testid={`badge-hidden-${b.key}-count`}
                              >
                                {b.count.toLocaleString()}
                              </Badge>
                              <span className="text-foreground">{b.label}</span>
                              {b.detail && (
                                <span className="text-muted-foreground">— {b.detail}</span>
                              )}
                              {b.action && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="ml-auto h-6 px-2 text-[11px]"
                                  onClick={b.action.onClick}
                                  data-testid={b.action.testId}
                                >
                                  <X className="mr-1 h-3 w-3" />
                                  {b.action.label}
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {hiddenBuckets.length === 0 && (
                      <p className="text-xs text-muted-foreground" data-testid="text-empty-fallback">
                        Upload a workbook or wait for the next scheduled import.
                      </p>
                    )}
                    {/* Phase B1 — explainer for the new pickup-scope rule. */}
                    <p
                      className="text-[11px] text-muted-foreground max-w-md"
                      data-testid="text-empty-pickup-scope-help"
                    >
                      Past-pickup loads with an open status now stay visible by default.
                      Switch to Upcoming only if you want the strict view.
                    </p>
                  </div>
                );
              })()
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
                                onOpenCockpit={() => openCockpitForItem(it)}
                                onMarkCovered={() => markCoveredSingle(it)}
                                onOpenDetail={() => navigate(`/available-freight/${it.opportunity.id}`)}
                                evalCtx={bucketEvalCtx}
                                urgencyOverride={urgencyOverrides.get(it.opportunity.id) ?? null}
                                onRetryConversion={(failureId) => conversionRetryMutation.mutate({ opportunityId: it.opportunity.id, failureId })}
                                retryingConversion={conversionRetryMutation.isPending && conversionRetryMutation.variables?.opportunityId === it.opportunity.id}
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
                ) : grouping === "none" && displayedFiltered.length > 150 ? (
                  // Task #957 — Row virtualization (only when ungrouped and
                  // > 150 rows). Mirrors the today.tsx pattern but renders a
                  // CockpitRowView per virtual row. Task #971 — uses the
                  // urgency-re-ranked displayedFiltered so escalated rows
                  // float up between server refetches.
                  <div data-testid="layout-table-virtual" data-virtual-row-count={displayedFiltered.length}>
                    <VirtualList
                      rowCount={displayedFiltered.length}
                      rowHeight={104}
                      overscanCount={6}
                      style={{ height: "min(70vh, 720px)" }}
                      rowProps={{}}
                      rowComponent={({ index, style }: RowComponentProps) => {
                        const it = displayedFiltered[index];
                        if (!it) return null;
                        return (
                          <div style={style} key={it.opportunity.id}>
                            <CockpitRowView
                              item={it}
                              isSelected={selected.has(it.opportunity.id)}
                              onToggleSelected={() => toggleSelected(it.opportunity.id)}
                              isFocused={focusIndex === index}
                              onFocus={() => setFocusIndex(index)}
                              onAction={(action, extra) => bulkMutate.mutate({ action, opportunityIds: [it.opportunity.id], ...(extra ?? {}) })}
                              onReassign={() => { setReassignToUserId(""); setReassignTargetIds([it.opportunity.id]); }}
                              onOpenDraft={() => setDraftPreviewId(it.opportunity.id)}
                              onLogOutcome={() => setOutcomeTargetId(it.opportunity.id)}
                              onToggleAutoPilot={() => toggleAutoPilot(it)}
                              onOpenCockpit={() => openCockpitForItem(it)}
                              onMarkCovered={() => markCoveredSingle(it)}
                              onOpenDetail={() => navigate(`/available-freight/${it.opportunity.id}`)}
                              evalCtx={bucketEvalCtx}
                              urgencyOverride={urgencyOverrides.get(it.opportunity.id) ?? null}
                              onRetryConversion={(failureId) => conversionRetryMutation.mutate({ opportunityId: it.opportunity.id, failureId })}
                              retryingConversion={conversionRetryMutation.isPending && conversionRetryMutation.variables?.opportunityId === it.opportunity.id}
                              index={index}
                              lastSeenAt={lastSeenAt}
                            />
                          </div>
                        );
                      }}
                    />
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
                            onOpenCockpit={() => openCockpitForItem(it)}
                            onMarkCovered={() => markCoveredSingle(it)}
                            onOpenDetail={() => navigate(`/available-freight/${it.opportunity.id}`)}
                            evalCtx={bucketEvalCtx}
                            urgencyOverride={urgencyOverrides.get(it.opportunity.id) ?? null}
                            onRetryConversion={(failureId) => conversionRetryMutation.mutate({ opportunityId: it.opportunity.id, failureId })}
                            retryingConversion={conversionRetryMutation.isPending && conversionRetryMutation.variables?.opportunityId === it.opportunity.id}
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
      </>
      )}

      {/* Task #1023 — Ops & health surface. Rendered in place of the
          row list when the rep is in Ops mode. Bundles the demoted
          import-health pill, the auto-pilot preview trigger, the full
          hidden-loads disclosure, and links to admin import tooling.
          Task E will move these surfaces wholesale to a dedicated
          admin route; until then a tab keeps everything one click
          away. */}
      {mode === "ops" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="panel-mode-ops">
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlert className="h-4 w-4" /> Import &amp; auto-pilot
              </div>
              <p className="text-xs text-muted-foreground">
                Confirm the latest Excel import landed cleanly and preview
                the next outreach batch before reps see it in Action mode.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <AfImportHealthPill testId="pill-af-import-health-ops" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAutoPilotDrawerOpen(true)}
                  data-testid="button-auto-pilot-preview-ops"
                >
                  <Truck className="h-4 w-4 mr-2" /> Auto-pilot preview
                </Button>
                <Link href="/admin/available-freight/imports">
                  <Button variant="ghost" size="sm" data-testid="link-admin-imports">
                    Excel import history →
                  </Button>
                </Link>
                {isManagerScope && (
                  <Link href="/leak-console">
                    <Button variant="ghost" size="sm" data-testid="link-leak-console-ops">
                      Leak console →
                    </Button>
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                Hidden loads &amp; dedupe
              </div>
              <p className="text-xs text-muted-foreground">
                Rows the current scope is hiding (status, snooze, past
                pickup, lane / carrier deep-link, owner). Use this view
                to debug "where did my freight go?" before changing scope.
              </p>
              {(() => {
                const h = feed?.hiddenCounts;
                if (!h) return <div className="text-xs text-muted-foreground" data-testid="text-ops-hidden-empty">No hidden-load telemetry available yet.</div>;
                const totalInScope = h.totalInScope ?? items.length;
                const visible = items.length;
                const buckets = [
                  { id: "status", label: "By status", count: h.byStatus ?? 0 },
                  { id: "snooze", label: "Snoozed", count: h.bySnooze ?? 0 },
                  { id: "past-pickup", label: "Past pickup", count: h.byPastPickup ?? 0 },
                  { id: "lane", label: "By lane filter", count: h.byLane ?? 0 },
                  { id: "carrier", label: "By carrier filter", count: h.byCarrier ?? 0 },
                  { id: "owner", label: "By owner filter", count: h.byOwner ?? 0 },
                ];
                const summary: HiddenCountsSummary = { totalInScope, visible, buckets };
                return <HiddenCountsDisclosure summary={summary} surface="af" />;
              })()}
            </CardContent>
          </Card>
        </div>
      )}

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
          {/* Task #871 — shared rows from the keyboard registry so AF + LWQ
              cheat sheets cannot drift. Surface-specific keys (a/s/r/x) are
              listed below the shared block. */}
          <div className="space-y-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Shared lane shortcuts
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                {sharedCheatRows.map(r => (
                  <Fragment key={r.key}>
                    <kbd
                      className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs"
                      data-testid={`cheat-key-af-${r.key}`}
                    >
                      {r.key}
                    </kbd>
                    <span data-testid={`cheat-label-af-${r.key}`}>{r.label}</span>
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="border-t border-border pt-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                Available Freight only
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">Enter</kbd><span>Run focused row's primary action</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">Shift+Enter</kbd><span>Open focused row's detail page</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">x</kbd><span>Toggle selection on focused row</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">A</kbd><span>Approve selected</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">S</kbd><span>Send top 3 carriers for selected</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">R</kbd><span>Reassign selected (or focused) row</span>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">Esc</kbd><span>Clear selection / close dialogs</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowShortcutsHelp(false)} data-testid="button-close-shortcuts">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #871 — Lane Cockpit overlay. Triggered by `L`, the row
          overflow menu, and the cross-link chip. Single backend round-trip
          to /api/lanes/cockpit. */}
      <LaneCockpitSheet
        signature={cockpitSignature}
        openedFrom="af"
        open={cockpitOpen}
        onOpenChange={setCockpitOpen}
        laneLabel={cockpitLaneLabel}
      />

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


function KpiTile({ label, value, tone, testId, subtitle }: { label: string; value: number | string; tone?: "critical" | "warn" | "ready" | "info" | "ok"; testId: string; subtitle?: string }) {
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
        {subtitle && (
          <div className="text-[10px] text-muted-foreground mt-0.5" data-testid={`text-${testId}-subtitle`}>
            {subtitle}
          </div>
        )}
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

/**
 * Task #654 — "From won quote" badge for AF cockpit rows. Renders only when
 * `sourceRef.type === "won_quote"`; the tooltip shows the buy/sell pricing
 * priors the won quote landed with so the rep doesn't have to open the
 * detail page just to see the rate context.
 */
function fmtCurrency(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function WonQuoteBadge({ sourceRef, oppId }: { sourceRef: unknown; oppId: string }) {
  if (!sourceRef || typeof sourceRef !== "object") return null;
  const ref = sourceRef as { type?: string; quoteId?: string; buy?: unknown; sell?: unknown };
  if (ref.type !== "won_quote") return null;
  const buy = fmtCurrency(ref.buy);
  const sell = fmtCurrency(ref.sell);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
            data-testid={`badge-from-won-quote-${oppId}`}
          >
            From won quote
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" data-testid={`tooltip-won-quote-${oppId}`}>
          <div className="text-xs space-y-0.5">
            <div className="font-medium">From won customer quote</div>
            <div>Sell: {sell ?? "—"}</div>
            <div>Buy: {buy ?? "—"}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
  // Task #888 — opens the LaneCockpitSheet pinned to this row's lane
  // signature. Mirrors the `L` keyboard shortcut so trackpad users have
  // the same affordance from the row's overflow menu.
  onOpenCockpit?: () => void;
  /** Task #1022 — opens the cover dialog seeded with this single row.
   *  Used by the "Mark covered" / "Pick carriers" primary actions so the
   *  rep stays on the queue. */
  onMarkCovered?: () => void;
  /** Task #1022 — opens the row's detail page (used by the
   *  pick_carriers action since the carrier shortlist editor lives
   *  there). */
  onOpenDetail?: () => void;
  /** Task #1022 — bucket evaluation context (todayIso + team set).
   *  Used to pick the row's "why surfaced" badge from the same predicate
   *  the chip strip uses, so row + chip cannot disagree. */
  evalCtx?: import("@shared/cockpitBuckets").BucketEvalContext;
  /** Task #971 — recomputed urgency override from the parent's 60s
   *  drift recompute. When present, the badge prefers this over the
   *  server-stamped value so a row whose pickup window crossed a
   *  threshold while the rep was on-screen escalates without a
   *  refetch. */
  urgencyOverride?: { score: number; level: CockpitItem["urgency"]["level"]; reasons: string[] } | null;
  /** Task #971 — invoked when the rep clicks the red "Retry"
   *  button on a conversion-failure chip. */
  onRetryConversion?: (failureId: string) => void;
  /** True while a retry round-trip is in flight for this row. */
  retryingConversion?: boolean;
  index: number;
  lastSeenAt: string | null;
  compact?: boolean;
}) {
  const { item, isSelected, isFocused, onToggleSelected, onFocus, onAction, onReassign, onOpenDraft, onLogOutcome, onToggleAutoPilot, onOpenCockpit, onMarkCovered, onOpenDetail, evalCtx, lastSeenAt, urgencyOverride, onRetryConversion, retryingConversion } = props;
  // Task #653 — local navigate so the "Make this recurring" item can deep-link
  // into LWQ. Defined here (rather than passed as a prop) to keep the row's
  // public surface unchanged.
  const [, rowNavigate] = useLocation();
  const opp = item.opportunity;
  const coveragePct = item.coverage.included > 0
    ? Math.round((item.coverage.responded / Math.max(1, item.coverage.included)) * 100)
    : 0;
  // NEW pill — opp generated after the user's last visit. We only show it when
  // we *have* a baseline so the very first session doesn't paint everything new.
  const isNewSinceLastView = !!lastSeenAt && opp.generatedAt
    ? new Date(opp.generatedAt).getTime() > new Date(lastSeenAt).getTime()
    : false;

  // Task #1022 — Self-explanatory row metadata. The action resolver, the
  // "why surfaced" badge, and the blocking-state caption all derive from
  // the same RowActionInput so the row never disagrees with itself (e.g.
  // a "Send to top 3" button while the caption says "Awaiting reply").
  const actionInput: RowActionInput = {
    opportunity: {
      status: opp.status ?? null,
      pickupWindowStart: opp.pickupWindowStart ?? null,
      coveredAt: (opp as { coveredAt?: string | null }).coveredAt ?? null,
      generatedAt: opp.generatedAt ?? null,
    },
    coverage: item.coverage,
    freshnessMinutes: item.freshnessMinutes,
    rankedCarrierCount: item.chips.length,
    ownership: item.ownership ?? null,
    owner: item.owner ?? null,
    pickupFreshness: item.pickupFreshness ?? null,
    pickupDaysAgo: item.pickupDaysAgo ?? null,
  };
  const blocking = resolveBlocking(actionInput);
  const nextAction = resolveNextBestAction(actionInput);
  // Task #1022 — `pickWhyBucket` always returns a BucketDefinition (falls
  // back to `BUCKETS.all` when no priority bucket matches) so the badge
  // is guaranteed to render. Only suppressed when no evalCtx was wired
  // through (defensive — all real callsites pass it).
  const whyBucket = evalCtx ? pickWhyBucket(actionInput, evalCtx) : null;
  const pickup = fmtPickupVerbose(opp.pickupWindowStart);

  // Task #1022 — Carrier chips capped to 3 with "+N more" popover so the
  // primary line stays scannable. The popover renders the full ordered list
  // with the same CarrierReasonsPopover semantics so reps don't lose access
  // to the ranker's reasoning when they expand the overflow.
  const MAX_VISIBLE_CHIPS = 3;
  const visibleChips = item.chips.slice(0, MAX_VISIBLE_CHIPS);
  const overflowChips = item.chips.slice(MAX_VISIBLE_CHIPS);

  const firePrimaryAction = () => {
    if (nextAction.disabled) return;
    switch (nextAction.id) {
      case "approve":
        onAction("approve");
        return;
      case "send_top":
      case "escalate":
        onAction("send_top", nextAction.payload);
        return;
      case "mark_covered":
        if (onMarkCovered) onMarkCovered();
        else onAction("mark_covered");
        return;
      case "pick_carriers":
        if (onOpenDetail) onOpenDetail();
        else rowNavigate(`/available-freight/${opp.id}`);
        return;
      case "open_detail":
      case "confirm_covered":
      default:
        if (onOpenDetail) onOpenDetail();
        else rowNavigate(`/available-freight/${opp.id}`);
        return;
    }
  };

  // Task #1022 — Render helper for a single carrier chip (used both in the
  // visible cluster and the overflow popover so behavior stays identical).
  const renderCarrierChip = (chip: CockpitChip) => {
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
        {chip.claimed && (
          <Badge
            variant="outline"
            className="bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40 text-[10px] py-0 px-1.5"
            data-testid={`chip-claimed-${opp.id}-${chip.carrierId}`}
            title="Carrier claimed this lane in Carrier Hub"
          >
            Claimed
          </Badge>
        )}
      </span>
    );
  };

  return (
    <div
      id={`freight-opportunity-${opp.id}`}
      onClick={onFocus}
      className={`flex flex-col gap-2 border-b px-3 py-3 hover:bg-accent/30 cursor-pointer ${isFocused ? "bg-accent/40" : ""}`}
      data-testid={`row-opportunity-${opp.id}`}
      data-context-anchor-id={opp.id}
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
        {/* Task #971 — prefer the parent's 60s drift recompute when it
            differs from the server-stamped value so the badge cannot
            stay "high" once a 24h pickup window has tipped into ≤12h
            while the rep is staring at the row. */}
        {(() => {
          const u = urgencyOverride ?? item.urgency;
          const drifted = !!urgencyOverride
            && (urgencyOverride.level !== item.urgency.level
              || urgencyOverride.score !== item.urgency.score);
          return (
            <Badge
              variant="outline"
              className={urgencyTone(u.level)}
              data-testid={`badge-urgency-${opp.id}`}
              data-urgency-drifted={drifted ? "true" : "false"}
              title={drifted ? `Recomputed (was ${item.urgency.level} · ${item.urgency.score})` : undefined}
            >
              {u.level} · {u.score}
            </Badge>
          );
        })()}
        {/* Task #1022 — "Why surfaced" badge. Same tone palette as the
            cockpit bucket chip strip so the row reads consistently with
            the chip the rep clicked to land here. */}
        {whyBucket && (
          <Badge
            variant="outline"
            className={bucketToneClass(whyBucket.tone)}
            title={whyBucket.description}
            data-testid={`badge-why-${opp.id}`}
            data-why-bucket={whyBucket.key}
          >
            {whyBucket.label}
          </Badge>
        )}
        {/* Task #971 — Conversion-failure chip. Click opens an in-cockpit
            detail panel (reason, full detail, last-attempted, retry
            count) with the Retry action inside the panel. The chip
            disappears when the server marks the failure resolved
            (cockpit refetch invalidated by the mutation). */}
        {item.latestConversionFailure && (() => {
          const f = item.latestConversionFailure;
          const attemptedAgo = (() => {
            const t = Date.parse(f.attemptedAt);
            if (!Number.isFinite(t)) return null;
            return fmtAge(Math.max(0, Math.round((Date.now() - t) / 60_000)));
          })();
          return (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300 hover:bg-red-500/20"
                  data-testid={`chip-conversion-failure-${opp.id}`}
                >
                  <AlertCircle className="h-3 w-3" />
                  <span>Conversion failed</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-80 p-3 text-xs"
                onClick={(e) => e.stopPropagation()}
                data-testid={`panel-conversion-failure-${opp.id}`}
              >
                <div className="mb-2 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                  <span className="font-semibold">Capture failed</span>
                </div>
                <dl className="space-y-1.5">
                  <div className="flex items-baseline gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Reason</dt>
                    <dd
                      className="flex-1 break-words font-medium"
                      data-testid={`text-conversion-failure-reason-${opp.id}`}
                    >
                      {f.reason}
                    </dd>
                  </div>
                  {f.detail && (
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-muted-foreground">Detail</dt>
                      <dd
                        className="flex-1 break-words text-foreground/80"
                        data-testid={`text-conversion-failure-detail-${opp.id}`}
                      >
                        {f.detail}
                      </dd>
                    </div>
                  )}
                  <div className="flex items-baseline gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Attempted</dt>
                    <dd
                      className="flex-1 tabular-nums"
                      data-testid={`text-conversion-failure-attempted-${opp.id}`}
                    >
                      {attemptedAgo ? `${attemptedAgo} ago` : f.attemptedAt}
                    </dd>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">Retries</dt>
                    <dd
                      className="flex-1 tabular-nums"
                      data-testid={`text-conversion-failure-retry-count-${opp.id}`}
                    >
                      {f.retryCount}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex justify-end gap-2 border-t pt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={retryingConversion}
                    onClick={() => {
                      if (onRetryConversion) onRetryConversion(f.id);
                    }}
                    data-testid={`button-retry-conversion-${opp.id}`}
                  >
                    {retryingConversion ? "Retrying…" : "Retry capture"}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          );
        })()}
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
        {/* Task #950 — full thread popover (composer + threaded view) is the
            row-level entry point per ADR docs/context-notes.md. The badge
            inside the popover doubles as the unread-mention counter. */}
        <ContextNotePopover
          anchor={{ type: "available_freight", id: opp.id }}
          title="Lane notes"
        />
        {opp.equipmentType && <span className="text-xs text-muted-foreground">{opp.equipmentType}</span>}
        {/* Task #871 — Stable/Volatile/Hot stability badge propagated from
            LWQ via the lwqContext payload. Falls back to the "Spot" pill
            when no recurring counterpart exists, so the column never
            renders empty on AF rows. */}
        <LaneStabilityBadge
          stability={item.lwqContext?.stability ?? null}
          testId={`badge-stability-${opp.id}`}
        />
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
        {/* Task #654 — "From won quote" badge with buy/sell tooltip. Surfaces
            the pricing priors that came in on the source quote so the rep
            can see them at a glance without opening the detail page. */}
        <WonQuoteBadge sourceRef={opp.sourceRef} oppId={opp.id} />
        <span
          className="text-xs flex items-center gap-1"
          data-testid={`text-pickup-${opp.id}`}
        >
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span className="font-medium">{pickup.absolute}</span>
          {pickup.relative && (
            <span className="text-muted-foreground">· {pickup.relative}</span>
          )}
        </span>
        {/* Phase B1 — pickup freshness label. Surfaces when a row is past
            its pickup date but still visible because its status is open;
            distinguishes "recent" (within graceDays, amber) from "stale"
            (>graceDays, red). Uses the server-computed `pickupDaysAgo`
            (org-local) so the label cannot drift off-by-one from the
            server's filter at the CT/UTC midnight rollover. */}
        {(item.pickupFreshness === "past_recent" || item.pickupFreshness === "past_stale")
          && typeof item.pickupDaysAgo === "number"
          && item.pickupDaysAgo > 0
          && (() => {
            const daysAgo = item.pickupDaysAgo as number;
            const stale = item.pickupFreshness === "past_stale";
            return (
              <Badge
                variant="outline"
                className={
                  stale
                    ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
                    : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
                }
                title={`Pickup was ${daysAgo}d ago — still open in ${opp.status.replace(/_/g, " ")}.${
                  stale ? " Past the freshness window; consider closing if no longer actionable." : ""
                }`}
                data-testid={`pill-pickup-was-stale-${opp.id}`}
              >
                Pickup was {daysAgo}d ago
              </Badge>
            );
          })()}
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
          {/* Task #1022 — Single primary "next best action" button. The
              action id, label, and disabled state are derived from the
              same RowActionInput as the blocking caption so they cannot
              disagree. Enter on the focused row fires this same handler
              (see onKey in the page-level keyboard router). */}
          <Button
            type="button"
            size="sm"
            variant={nextAction.disabled || nextAction.emphasis === "secondary" ? "outline" : "default"}
            disabled={nextAction.disabled}
            onClick={(e) => { e.stopPropagation(); firePrimaryAction(); }}
            title={nextAction.label}
            data-testid={`button-row-primary-${opp.id}`}
            data-row-action={nextAction.id}
          >
            {nextAction.label}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => e.stopPropagation()} data-testid={`button-row-menu-${opp.id}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Quick actions</DropdownMenuLabel>
              {/* Task #888 — trackpad-friendly mirror of the `L` keyboard
                  shortcut. Opens LaneCockpitSheet pinned to this row's
                  lane signature (same contract as the keyboard handler). */}
              {onOpenCockpit && (
                <DropdownMenuItem onClick={() => onOpenCockpit()} data-testid={`menu-open-cockpit-${opp.id}`}>
                  Open in Cockpit
                </DropdownMenuItem>
              )}
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
              {/* Task #653 — graduate this spot opp into a managed LWQ lane.
                  Always available, regardless of bucket/status. Deep-links to
                  the LWQ Build Lane dialog with customer + lane + equipment
                  prefilled (loads/week, owner, notes intentionally blank). */}
              <DropdownMenuItem
                onClick={() => {
                  const params = new URLSearchParams();
                  params.set("createLane", "1");
                  if (item.customer?.name) params.set("customer", item.customer.name);
                  if (opp.origin) params.set("originCity", opp.origin);
                  if (opp.originState) params.set("originState", opp.originState);
                  if (opp.destination) params.set("destCity", opp.destination);
                  if (opp.destinationState) params.set("destState", opp.destinationState);
                  if (opp.equipmentType) params.set("equipment", opp.equipmentType);
                  rowNavigate(`/lanes/work-queue?${params.toString()}`);
                }}
                data-testid={`menu-make-recurring-${opp.id}`}
              >
                Make this recurring
              </DropdownMenuItem>
              {/* Task #873 — Open Lane Story for this AF row. Mirrors the
                  signature contract used server-side (laneSig). */}
              <DropdownMenuItem
                onClick={() => rowNavigate(
                  laneStoryHref(opp.origin, opp.originState, opp.destination, opp.destinationState, opp.equipmentType),
                )}
                data-testid={`menu-open-lane-story-${opp.id}`}
              >
                Open Lane Story
              </DropdownMenuItem>
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
        {/* Task #1022 — Blocking caption: terse, neutral phrasing of why
            the primary action is what it is (e.g. "Awaiting reply",
            "No carriers picked yet"). Drives the rep to the right next
            move without forcing them to scan chips first. */}
        <span
          className="text-xs text-muted-foreground"
          data-testid={`text-blocking-${opp.id}`}
          data-blocking-state={blocking.state}
        >
          {blocking.label}
        </span>
        {item.chips.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">No carriers shortlisted yet</span>
        ) : (
          <>
            {visibleChips.map(renderCarrierChip)}
            {overflowChips.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                    data-testid={`button-chips-overflow-${opp.id}`}
                  >
                    +{overflowChips.length} more
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[28rem] p-3"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`panel-chips-overflow-${opp.id}`}
                >
                  <div className="mb-2 text-xs font-semibold text-muted-foreground">
                    All {item.chips.length} carriers
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.chips.map(renderCarrierChip)}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </>
        )}
        {/* Task #1022 — LWQ shortcut moved out of the primary line so it
            stays subordinate to the lane title and primary action. */}
        {item.lwqContext && (
          <LwqContextChip
            data={item.lwqContext}
            testId={`chip-lwq-context-${opp.id}`}
          />
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

/**
 * Phase A3 — explained empty state for the Available Freight cockpit.
 *
 * Replaces the generic "No opportunities match these filters" copy
 * with a three-tier hint:
 *
 *   1. Truly empty scope (no rows at all in the user's org/company
 *      scope) — keep the original "Upload a workbook…" call to action
 *      so a brand-new tenant isn't told to "clear filters" they never
 *      set.
 *
 *   2. Rows exist but every one is hidden — show "0 matching · N
 *      hidden" with a per-dimension breakdown (status / lane /
 *      carrier / past pickup / snoozed / search) and a single
 *      "Show all" button that resets every active filter at once.
 *      A bucket only renders if it both has a nonzero count AND its
 *      driving filter is active, so we never accuse a filter the rep
 *      didn't actually set.
 *
 *   3. Rows exist and no obvious filter is set (rare — usually means
 *      the saved-view shape filtered them all client-side) — fall
 *      back to the original copy plus a Show-all button.
 */
